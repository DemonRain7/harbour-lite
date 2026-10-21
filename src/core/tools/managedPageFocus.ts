import WebSocket from "ws";
import { isOwnedChrome, type BrowserHarnessConfig } from "./browserHarness";

interface FocusSocket {
  readyState: number;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  send(data: string, callback?: (error?: Error) => void): void;
  terminate(): void;
}

interface FocusDependencies {
  owns(cfg: BrowserHarnessConfig): boolean;
  listTargets(cfg: BrowserHarnessConfig, signal: AbortSignal): Promise<unknown>;
  connect(url: string, timeoutMs: number): FocusSocket;
  setupTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

/** Preparation finished, but restoring the private target override did not.
 * Callers must invalidate this preparation rather than replay it in-place. */
export class ManagedPageFocusCleanupError extends Error {
  constructor(cause: unknown) {
    super("Managed page focus: restoration failed; preparation must not be replayed", { cause });
    this.name = "ManagedPageFocusCleanupError";
  }
}

const activeTargets = new Set<string>();
const asError = (reason: unknown) => reason instanceof Error ? reason : new Error(String(reason ?? "Managed page focus cancelled"));

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => finish(asError(signal.reason));
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true; signal.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve(value!);
    };
    promise.then(value => finish(undefined, value), error => finish(asError(error)));
    if (signal.aborted) aborted(); else signal.addEventListener("abort", aborted, { once: true });
  });
}

function exactTargetSocket(targets: unknown, targetId: string, port: number): string {
  if (!Array.isArray(targets)) throw new Error("Managed page focus: invalid target list");
  const matches = targets.filter(target => target?.id === targetId);
  if (matches.length !== 1 || matches[0]?.type !== "page") throw new Error("Managed page focus: exact page target unavailable");
  const url = new URL(String(matches[0].webSocketDebuggerUrl ?? ""));
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.port !== String(port) || url.username || url.password || url.search || url.hash ||
      url.pathname !== `/devtools/page/${targetId}`) {
    throw new Error("Managed page focus: unsafe target socket");
  }
  return url.href;
}

/** Private CDP session: the only command this client can issue is focus emulation. */
class FocusSession {
  private next = 0;
  private ended = false;
  private pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
  private opening: Promise<void>;
  private rejectOpen!: (error: Error) => void;
  constructor(private socket: FocusSocket, private failed: (error: Error) => void) {
    this.opening = new Promise((resolve, reject) => {
      this.rejectOpen = reject;
      if (socket.readyState === WebSocket.OPEN) resolve(); else socket.once("open", resolve);
    });
    // Always consume a failure, including a socket that dies before open() is awaited.
    void this.opening.catch(() => undefined);
    socket.on("error", error => this.break(asError(error)));
    socket.on("close", () => this.break(new Error("Managed page focus: target connection closed")));
    socket.on("message", raw => {
      try {
        const message = JSON.parse(String(raw));
        if (message?.method === "Inspector.detached") throw new Error("Managed page focus: target detached");
        const pending = this.pending.get(message?.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error || !message.result || typeof message.result !== "object") {
          pending.reject(new Error("Managed page focus: emulation command rejected"));
        } else pending.resolve();
      } catch { this.break(new Error("Managed page focus: invalid or detached target response")); }
    });
  }
  private break(error: Error) {
    this.rejectOpen(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (!this.ended) this.failed(error);
  }
  open(signal: AbortSignal) { return abortable(this.opening, signal); }
  setFocus(enabled: boolean, signal: AbortSignal): Promise<void> {
    const request = new Promise<void>((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) { reject(new Error("Managed page focus: target socket unavailable")); return; }
      const id = ++this.next;
      this.pending.set(id, { resolve, reject });
      try {
        this.socket.send(JSON.stringify({ id, method: "Emulation.setFocusEmulationEnabled", params: { enabled } }), error => {
          if (error) this.break(error);
        });
      } catch (error) { this.break(asError(error)); }
    });
    return abortable(request, signal);
  }
  dispose() {
    this.ended = true;
    this.break(new Error("Managed page focus: session disposed"));
    this.socket.terminate();
  }
}

/** Dependency seam for offline tests; never exposed as a model tool or command. */
export function createManagedPageFocus(deps: FocusDependencies) {
  return async function withFocus<T>(cfg: BrowserHarnessConfig, targetId: string, parentSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    parentSignal?.throwIfAborted();
    if (!Number.isInteger(cfg.debugPort) || cfg.debugPort < 1 || cfg.debugPort > 65535 || !/^[A-Za-z0-9_-]{1,128}$/.test(targetId)) {
      throw new Error("Managed page focus: invalid exact target");
    }
    const key = `${cfg.debugPort}:${targetId}`;
    if (activeTargets.has(key)) throw new Error("Managed page focus: target already has an active scope");
    activeTargets.add(key);
    const controller = new AbortController();
    const abortParent = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", abortParent, { once: true });
    // Cooperative deadline: a synchronous ownership/CIM check can temporarily
    // block timer delivery, so this is not a hard five-second wall-clock bound.
    const timer = setTimeout(() => controller.abort(new Error("Managed page focus: setup timed out")), deps.setupTimeoutMs ?? 5000);
    let session: FocusSession | undefined, attemptedEnable = false, cleaning = false;
    let result: T | undefined, failure: unknown, didFail = false;
    try {
      if (!deps.owns(cfg)) throw new Error("Managed page focus: browser ownership not verified");
      controller.signal.throwIfAborted();
      const targets = await abortable(deps.listTargets(cfg, controller.signal), controller.signal);
      const url = exactTargetSocket(targets, targetId, cfg.debugPort);
      if (!deps.owns(cfg)) throw new Error("Managed page focus: browser ownership changed");
      controller.signal.throwIfAborted();
      session = new FocusSession(deps.connect(url, deps.setupTimeoutMs ?? 5000), error => {
        if (!cleaning) controller.abort(error);
      });
      await session.open(controller.signal);
      controller.signal.throwIfAborted();
      attemptedEnable = true;
      await session.setFocus(true, controller.signal);
      clearTimeout(timer);
      controller.signal.throwIfAborted();
      result = await abortable(Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }), controller.signal);
    } catch (error) { didFail = true; failure = error; }
    finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortParent);
      cleaning = true;
      try {
        // Cleanup has its own deadline: an aborted operation must still disable
        // emulation. Terminating this private CDP session is the final detach.
        if (attemptedEnable && session) await session.setFocus(false, AbortSignal.timeout(deps.cleanupTimeoutMs ?? 2000));
      } catch (error) { if (!didFail) { didFail = true; failure = new ManagedPageFocusCleanupError(error); } }
      finally { session?.dispose(); activeTargets.delete(key); }
    }
    if (didFail) throw failure;
    return result!;
  };
}

export const withManagedPageFocus = createManagedPageFocus({
  owns: isOwnedChrome,
  async listTargets(cfg, signal) {
    const response = await fetch(`http://127.0.0.1:${cfg.debugPort}/json/list`, { signal, redirect: "error" });
    if (!response.ok) throw new Error("Managed page focus: target lookup failed");
    return response.json();
  },
  connect: (url, timeoutMs) => new WebSocket(url, { handshakeTimeout: timeoutMs, perMessageDeflate: false, maxPayload: 16384 }),
});
