import { readFile } from "node:fs/promises";
import path from "node:path";

const DAEMON_PORT = 19_825;
const DAEMON_STATUS_URL = `http://127.0.0.1:${DAEMON_PORT}/status`;
// Only the audited, pinned protocol uses this fast path. Other versions retain CLI compatibility.
const HTTP_STATUS_VERSIONS = new Set(["1.8.7"]);

export interface OpenCliDaemonStatus {
  state: "running" | "stale" | "not-running";
  detail: string;
}

/** Read-only daemon liveness, independent of CLI startup/exit and browser profile selection. */
export async function probeOpenCliDaemonStatus(
  entryPath: string,
  signal?: AbortSignal,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<OpenCliDaemonStatus | undefined> {
  if (signal?.aborted) throw new Error("OpenCLI daemon 启动检查已停止");
  const configuredPort = process.env.OPENCLI_DAEMON_PORT?.trim();
  if (configuredPort && Number(configuredPort) !== DAEMON_PORT) return undefined;
  let version: string;
  try {
    const packagePath = path.resolve(path.dirname(entryPath), "..", "..", "package.json");
    const pkg = JSON.parse(await readFile(packagePath, "utf8")) as { name?: unknown; version?: unknown };
    if (signal?.aborted) throw new Error("OpenCLI daemon 启动检查已停止");
    if (pkg.name !== "@jackwener/opencli" || typeof pkg.version !== "string" || !HTTP_STATUS_VERSIONS.has(pkg.version)) {
      return undefined;
    }
    version = pkg.version;
  } catch {
    if (signal?.aborted) throw new Error("OpenCLI daemon 启动检查已停止");
    // Custom/fake CLI entries must never probe the user's real daemon.
    return undefined;
  }
  if (signal?.aborted) throw new Error("OpenCLI daemon 启动检查已停止");

  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.min(4_000, options.timeoutMs ?? 4_000));
  let abort!: () => void;
  let timer!: NodeJS.Timeout;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(new Error("OpenCLI daemon 启动检查已停止"));
      controller.abort();
    };
    timer = setTimeout(() => {
      reject(new Error(`OpenCLI daemon status 超时（本机 HTTP /status，${timeoutMs}ms）`));
      controller.abort();
    }, timeoutMs);
  });
  signal?.addEventListener("abort", abort, { once: true });
  const probe = async (): Promise<OpenCliDaemonStatus | undefined> => {
    try {
      const response = await (options.fetch ?? fetch)(DAEMON_STATUS_URL, {
        method: "GET",
        headers: { "X-OpenCLI": "1" },
        redirect: "error",
        signal: controller.signal,
      });
      if ([404, 405, 501].includes(response.status)) return undefined;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let raw: unknown;
      try {
        raw = await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        return undefined;
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
      const status = raw as Record<string, unknown>;
      if (status.ok !== true || !Number.isInteger(status.pid) || Number(status.pid) <= 0 ||
          status.port !== DAEMON_PORT || typeof status.daemonVersion !== "string" || !status.daemonVersion) {
        return undefined;
      }
      // profileRequired/extensionConnected belong to the existing explicit-profile readiness checks.
      const state = status.daemonVersion === version ? "running" : "stale";
      return { state, detail: `PID ${status.pid}; daemon v${status.daemonVersion}; CLI v${version}` };
    } catch (error) {
      const failure = error as { code?: unknown; cause?: { code?: unknown } } | undefined;
      if (!controller.signal.aborted && (failure?.code === "ECONNREFUSED" || failure?.cause?.code === "ECONNREFUSED")) {
        return { state: "not-running", detail: `本机 127.0.0.1:${DAEMON_PORT} 拒绝连接` };
      }
      throw new Error(`OpenCLI daemon status 检查失败（本机 HTTP /status）：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  try {
    return await Promise.race([probe(), cancelled]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
