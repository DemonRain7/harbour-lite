import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { classifyOpenCliUploadFunction } from "./openCliExtensionCompat";

export interface OpenCliExtensionRuntimeOptions {
  extensionDir: string;
  profileDir: string;
  debugPort: number;
  /** Only the caller holding the cold-start gate may allow an extension reload. */
  allowReload: boolean;
  timeoutMs?: number;
}
export interface OpenCliExtensionRuntimeResult {
  status: "verified" | "restart-required" | "skipped";
  extensionId?: string;
  sha256?: string;
}

const workerPath = "dist/background.js";
const hash = (source: string) => createHash("sha256").update(source, "utf8").digest("hex");
const failure = (message: string) => new Error(`OpenCLI extension runtime: ${message}`);
const diagnosticField = (value: unknown, limit = 200): string | null => value === null ? null :
  typeof value === "string" ? value.slice(0, limit) : value === undefined ? "<missing>" : `<${typeof value}>`;
const samePath = (left: string, right: string) => process.platform === "win32"
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);

function sameBundleOutsideUpload(left: string, right: string): boolean {
  const start = "async function setFileInputFiles(tabId, files, selector) {";
  const end = "function matchesDownloadPattern(item, pattern) {";
  return left.slice(0, left.indexOf(start)) === right.slice(0, right.indexOf(start)) &&
    left.slice(left.indexOf(end, left.indexOf(start))) === right.slice(right.indexOf(end, right.indexOf(start)));
}

async function confinedFile(root: string, relative: string, maxBytes: number): Promise<string> {
  const file = await realpath(path.join(root, relative));
  const inside = path.relative(root, file);
  if (!inside || inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw failure("file escapes its configured root");
  }
  const info = await stat(file);
  if (!info.isFile() || info.size > maxBytes) throw failure("unexpected file type or size");
  const bytes = await readFile(file);
  const source = bytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(bytes)) throw failure("source is not valid UTF-8");
  return source;
}

async function readAuditedDisk(extensionDir: string): Promise<{ root: string; source: string } | undefined> {
  try {
    const root = await realpath(extensionDir);
    const manifest = JSON.parse(await confinedFile(root, "manifest.json", 128_000));
    if (manifest?.name !== "OpenCLI" || manifest.version !== "1.0.23" ||
        manifest.background?.service_worker !== workerPath) return;
    const source = await confinedFile(root, workerPath, 4_000_000);
    if (classifyOpenCliUploadFunction(source) !== "picker-v2") return;
    return { root, source };
  } catch {
    // Unknown, custom, missing, or unreadable builds are not candidates for reload.
    return;
  }
}

async function profileExtensionId(profileDir: string, extensionRoot: string): Promise<string | undefined> {
  const root = await realpath(profileDir);
  const ids = new Set<string>();
  // Chrome versions store unpacked-extension path bindings in either file.
  for (const filename of ["Secure Preferences", "Preferences"]) {
    let prefs: any;
    try { prefs = JSON.parse(await confinedFile(root, path.join("Default", filename), 32_000_000)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw failure("cannot safely read extension path bindings from profile metadata");
    }
    for (const [id, entry] of Object.entries(prefs?.extensions?.settings ?? {})) {
      const installed = entry as { path?: unknown };
      if (typeof installed.path !== "string" || !path.isAbsolute(installed.path)) continue;
      if (samePath(installed.path, extensionRoot)) {
        if (!/^[a-p]{32}$/.test(id)) throw failure("invalid extension ID in profile metadata");
        ids.add(id);
      }
    }
  }
  if (ids.size > 1) throw failure("ambiguous extension path binding in profile metadata");
  return [...ids][0];
}

function pause(signal: AbortSignal, delayMs = 40): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const done = () => { signal.removeEventListener("abort", aborted); resolve(); };
    const timer = setTimeout(done, delayMs);
    const aborted = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); reject(signal.reason); };
    signal.addEventListener("abort", aborted, { once: true });
  });
}

interface Target { id: string; type: string; url: string; webSocketDebuggerUrl?: string }
async function findTarget(port: number, expectedUrl: string, signal: AbortSignal): Promise<Target | undefined> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal, redirect: "error" });
  if (!response.ok) throw failure(`CDP target list returned HTTP ${response.status}`);
  const targets = await response.json() as Target[];
  if (!Array.isArray(targets)) throw failure("invalid CDP target list");
  const matches = targets.filter(target => target?.type === "service_worker" && target.url === expectedUrl);
  if (matches.length > 1) throw failure("ambiguous extension worker target");
  const target = matches[0];
  if (!target) return;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(target.id) || typeof target.webSocketDebuggerUrl !== "string") {
    throw failure("invalid extension worker debugger target");
  }
  const socket = new URL(target.webSocketDebuggerUrl);
  if (socket.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(socket.hostname) ||
      socket.port !== String(port) || socket.username || socket.password || socket.search || socket.hash ||
      socket.pathname !== `/devtools/page/${target.id}`) {
    throw failure("worker debugger URL is not the configured localhost target");
  }
  return target;
}

class WorkerConnection {
  readonly scripts = new Map<string, string>();
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private broken?: Error;
  private debuggerEnabled = false;
  private readonly socket: WebSocket;
  private readonly abort: () => void;
  private readonly opened: Promise<void>;

  constructor(url: string, private readonly signal: AbortSignal, private readonly onCommand: (method: string) => void) {
    this.socket = new WebSocket(url, { maxPayload: 5_000_000 });
    this.abort = () => { this.break(signal.reason); this.socket.terminate(); };
    this.opened = new Promise<void>((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
      this.socket.once("close", () => reject(failure("worker disconnected before connection opened")));
    });
    this.socket.on("error", () => this.break(failure("worker debugger transport error")));
    this.socket.on("close", () => this.break(failure("worker debugger disconnected")));
    this.socket.on("message", data => {
      try {
        const message = JSON.parse(data.toString());
        if (message.method === "Inspector.detached") {
          this.break(failure("worker debugger disconnected (Inspector.detached)"));
          this.socket.terminate();
          return;
        }
        if (message.method === "Debugger.scriptParsed" && typeof message.params?.scriptId === "string") {
          this.scripts.set(message.params.scriptId, message.params.url);
        }
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          if (message.error) pending.reject(failure(`CDP command failed: ${message.error.message ?? "unknown error"}`));
          else pending.resolve(message.result);
        }
      } catch { this.break(failure("invalid worker debugger response")); }
    });
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.abort();
  }

  private break(error: Error) {
    this.broken ??= error;
    for (const pending of this.pending.values()) pending.reject(this.broken);
    this.pending.clear();
  }

  async command(method: string, params?: Record<string, unknown>): Promise<any> {
    this.onCommand(method);
    await this.opened;
    if (this.broken) throw this.broken;
    if (this.signal.aborted) throw this.signal.reason;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (error) { this.pending.delete(id); reject(failure("worker command could not be sent")); }
      });
    });
  }

  async inspect(extensionId: string, expectedUrl: string): Promise<string> {
    // A new CDP worker target can precede extension API initialization. Only a
    // typed ready:false from this fixed read-only expression permits waiting;
    // exceptions, malformed responses and real identity mismatches fail closed.
    let identity: any;
    do {
      identity = await this.command("Runtime.evaluate", {
        expression: "(() => { const runtime = globalThis.chrome?.runtime; if (typeof runtime?.getManifest !== 'function') return { ready: false }; const m = runtime.getManifest(); return { ready: true, id: runtime.id, name: m.name, version: m.version, worker: m.background?.service_worker }; })()",
        returnByValue: true,
      });
      if (identity?.exceptionDetails || identity?.result?.value?.ready !== false) break;
      await pause(this.signal);
    } while (true);
    const value = identity?.result?.value;
    if (identity?.exceptionDetails || value?.ready !== true || value?.id !== extensionId || value?.name !== "OpenCLI" ||
        value?.version !== "1.0.23" || value?.worker !== workerPath) {
      throw failure("worker runtime identity mismatch " + JSON.stringify({
        expectedId: extensionId,
        observed: { ready: typeof value?.ready === "boolean" ? value.ready : diagnosticField(value?.ready),
          id: diagnosticField(value?.id), name: diagnosticField(value?.name),
          version: diagnosticField(value?.version), worker: diagnosticField(value?.worker) },
        resultType: diagnosticField(identity?.result?.type),
        resultSubtype: diagnosticField(identity?.result?.subtype),
        exception: diagnosticField(identity?.exceptionDetails?.exception?.description ?? identity?.exceptionDetails?.text, 600),
      }));
    }
    this.debuggerEnabled = true;
    await this.command("Debugger.enable");
    let scriptIds: string[];
    do {
      if (this.broken) throw this.broken;
      scriptIds = [...this.scripts].filter(([, url]) => url === expectedUrl).map(([id]) => id);
      if (!scriptIds.length) await pause(this.signal);
    } while (!scriptIds.length);
    if (scriptIds.length !== 1) throw failure("ambiguous loaded extension script");
    const response = await this.command("Debugger.getScriptSource", { scriptId: scriptIds[0] });
    if (typeof response?.scriptSource !== "string") throw failure("loaded worker source is unavailable");
    return response.scriptSource;
  }

  async disableDebugger(): Promise<void> {
    if (!this.debuggerEnabled) return;
    this.debuggerEnabled = false;
    await this.command("Debugger.disable");
  }

  async reload(): Promise<void> {
    await this.disableDebugger();
    // No page reload, navigation, cache deletion, or replay. Exactly one call.
    // Release this debugger connection before the extension tears itself down.
    const result = await this.command("Runtime.evaluate", {
      expression: "(() => { setTimeout(() => chrome.runtime.reload(), 50); return { reloadScheduled: true }; })()",
      returnByValue: true,
    });
    if (result?.exceptionDetails || result?.result?.value?.reloadScheduled !== true) throw failure("extension reload scheduling was not confirmed");
  }

  async dispose(): Promise<void> {
    try { if (!this.broken && !this.signal.aborted) await this.disableDebugger(); }
    finally {
      this.signal.removeEventListener("abort", this.abort);
      this.break(failure("worker debugger connection disposed"));
      this.socket.terminate();
    }
  }
}

/** Verify a path-bound worker before a caller releases its cold-start gate.
 * Disk changes alone do not invalidate an unpacked worker cached in a profile.
 * A reused browser may be inspected, but must never be reloaded by this helper.
 * restart-required is explicitly NOT verified: the caller must restart its
 * newly launched owned browser once, then call again with allowReload:false.
 */
export async function ensureOpenCliExtensionRuntime(options: OpenCliExtensionRuntimeOptions): Promise<OpenCliExtensionRuntimeResult> {
  const disk = await readAuditedDisk(options.extensionDir);
  if (!disk) return { status: "skipped" };
  if (!Number.isInteger(options.debugPort) || options.debugPort < 1 || options.debugPort > 65535 || options.debugPort === 9222) {
    throw failure("invalid managed Chrome debug port");
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw failure("invalid verification timeout");
  const controller = new AbortController();
  let phase = "path-binding";
  const timer = setTimeout(() => controller.abort(failure(`verification timed out at ${phase}; runtime remains unverified`)), timeoutMs);
  const signal = controller.signal;
  const expectedHash = hash(disk.source);
  try {
    let extensionId: string | undefined;
    while (!(extensionId = await profileExtensionId(options.profileDir, disk.root))) await pause(signal);
    const expectedUrl = `chrome-extension://${extensionId}/${workerPath}`;
    phase = "worker-target";
    let target: Target | undefined;
    while (!(target = await findTarget(options.debugPort, expectedUrl, signal))) await pause(signal);
    let operation = "inspect";
    const connection = new WorkerConnection(target.webSocketDebuggerUrl!, signal, method => { phase = `${operation}/${method}`; });
    try {
      const source = await connection.inspect(extensionId, expectedUrl);
      if (hash(source) === expectedHash) {
        const current = await readAuditedDisk(options.extensionDir);
        if (!current || !samePath(current.root, disk.root) || hash(current.source) !== expectedHash) {
          throw failure("disk bundle changed during verification");
        }
        if (signal.aborted) throw signal.reason;
        return { status: "verified", extensionId, sha256: expectedHash };
      }
      const recognized = classifyOpenCliUploadFunction(source);
      if ((recognized !== "original" && recognized !== "gesture-v1") || !sameBundleOutsideUpload(source, disk.source)) {
        throw failure("loaded source mismatch is not an audited legacy worker; refusing reload");
      }
      if (options.allowReload !== true) throw failure("loaded source differs from disk in a reused browser; cold-start verification required");
      operation = "reload";
      // A disconnect is not a verified upgrade and must never cause a replay.
      try { await connection.reload(); }
      catch (error) {
        if (signal.aborted || !/worker debugger disconnected/.test(String(error))) throw error;
      }
    } finally { await connection.dispose(); }
    // A retiring worker can remain listed while chrome.runtime is invalid.
    // Never inspect it again. Only observe target departure for a short bounded
    // handoff; the next Chrome startup must perform the actual source check.
    phase = "post-reload/worker-exit";
    const handoffDeadline = Date.now() + 600;
    while (Date.now() < handoffDeadline) {
      const observed = await findTarget(options.debugPort, expectedUrl, signal);
      if (!observed || observed.id !== target.id) break;
      await pause(signal, 180);
    }
    if (signal.aborted) throw signal.reason;
    return { status: "restart-required", extensionId };
  } finally {
    clearTimeout(timer);
    controller.abort(failure("verification finished"));
  }
}
