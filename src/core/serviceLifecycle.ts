import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export class ServiceControlError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export interface RestartPreparation {
  commit(): void;
  cancel(): void;
}

export interface ServiceControl {
  snapshot(): { instanceId: string; pid: number; startedAt: number; phase: string; restartSupported: boolean; restartReason?: string };
  restart(instanceId: string, busy: () => boolean): Promise<{ accepted: true; instanceId: string }>;
}

export function serviceRestartUnsupportedReason(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.HARBOUR_DESKTOP_MANAGED === "1") return undefined;
  if (env.INVOCATION_ID || env.pm_id !== undefined || env.SUPERVISOR_PROCESS_NAME) {
    return "后端由系统服务管理器托管，请通过原 systemd / PM2 / Supervisor 重启；不会另起一份独立进程。";
  }
  return undefined;
}

/** No prompt/agent involvement. Require a replacement process or Desktop owner handshake before stopping. */
export function createServiceControl(options: {
  shutdown: () => Promise<void>;
  prepare?: () => Promise<RestartPreparation>;
  onError?: (error: unknown) => void;
}): ServiceControl {
  const instanceId = randomUUID(), startedAt = Date.now();
  const restartReason = serviceRestartUnsupportedReason();
  let phase = "ready";
  let pending: Promise<{ accepted: true; instanceId: string }> | undefined;
  return {
    snapshot: () => ({ instanceId, pid: process.pid, startedAt, phase, restartSupported: !restartReason, ...(restartReason ? { restartReason } : {}) }),
    restart(expected, busy) {
      if (expected !== instanceId) return Promise.reject(new ServiceControlError("服务实例已变化，请重新读取状态后再重启。"));
      if (restartReason) return Promise.reject(new ServiceControlError(restartReason, 503));
      if (pending) return pending;
      if (busy()) return Promise.reject(new ServiceControlError("还有任务正在执行或排队；请先停止任务或等其完成，再重启后端。"));
      phase = "preparing";
      pending = Promise.resolve().then(async () => {
        let preparation: RestartPreparation | undefined;
        try {
          preparation = await (options.prepare ?? prepareServiceRestart)();
          if (busy()) throw new ServiceControlError("准备重启期间有新任务进入；本次重启已取消，请等任务完成。" );
          phase = "restarting";
          // Give the caller its 202 receipt before closing HTTP and WebSocket connections.
          setTimeout(() => {
            try { preparation!.commit(); }
            catch (error) { preparation!.cancel(); phase = "ready"; pending = undefined; options.onError?.(error); return; }
            void options.shutdown().catch(error => options.onError?.(error));
          }, 250).unref();
          return { accepted: true as const, instanceId };
        } catch (error) {
          preparation?.cancel(); phase = "ready"; pending = undefined;
          throw error;
        }
      });
      return pending;
    },
  };
}

function ipcMessage(target: NodeJS.Process | ChildProcess, message: unknown): void {
  if (target.connected) target.send?.(message as any, undefined, undefined, () => {});
}

/** Desktop-owned processes stay owned by Desktop; standalone Node restarts itself. */
export async function prepareServiceRestart(): Promise<RestartPreparation> {
  const unsupported = serviceRestartUnsupportedReason();
  if (unsupported) throw new ServiceControlError(unsupported, 503);
  const nonce = randomUUID();
  const managed = process.env.HARBOUR_DESKTOP_MANAGED === "1";
  let child: ChildProcess | undefined;
  if (managed && !process.connected) throw new ServiceControlError("桌面进程连接已失效，请从原客户端重新启动后端。", 503);
  if (!managed) {
    const entry = process.argv[1];
    if (!entry) throw new ServiceControlError("无法确认当前后端启动入口。", 503);
    const directory = path.resolve(process.cwd(), "assets", "reports");
    await fs.mkdir(directory, { recursive: true });
    const log = await fs.open(path.join(directory, `service-restart-${Date.now()}.log`), "a");
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, HARBOUR_RESTART_PARENT_PID: String(process.pid), HARBOUR_RESTART_NONCE: nonce };
      delete env.NODE_CHANNEL_FD; delete env.NODE_CHANNEL_SERIALIZATION_MODE; delete env.TSX_IPC_PATH;
      child = spawn(process.execPath, [...process.execArgv, path.resolve(entry), ...process.argv.slice(2)], {
        cwd: process.cwd(), env, windowsHide: true, detached: true,
        stdio: ["ignore", log.fd, log.fd, "ipc"],
      });
    } finally { await log.close(); }
  }
  const peer = child ?? process;
  const send = (type: string) => ipcMessage(peer, { type, nonce });
  await new Promise<void>((resolve, reject) => {
    const done = (error?: Error) => {
      clearTimeout(timer); peer.removeListener("message", onMessage);
      child?.removeListener("error", onError); child?.removeListener("exit", onExit);
      if (error) { send("harbour:restart-cancel"); child?.kill(); reject(error); } else resolve();
    };
    const onMessage = (message: any) => {
      if (message?.type === "harbour:restart-ready" && message.nonce === nonce) done();
    };
    const onError = (error: Error) => done(error);
    const onExit = (code: number | null) => done(new Error(`新后端预检失败（exit=${code}），原服务继续运行。`));
    const timer = setTimeout(() => done(new Error("新后端未确认就绪，已取消重启；原服务继续运行。")), 15_000);
    peer.on("message", onMessage); child?.once("error", onError); child?.once("exit", onExit);
    if (managed) send("harbour:restart-prepare");
  });
  return {
    commit() {
      if (!peer.connected) throw new Error("重启接收进程已断开，原服务不会退出。");
      send("harbour:restart-commit"); child?.unref();
    },
    cancel() { send("harbour:restart-cancel"); child?.kill(); },
  };
}

/** Runs before runtime/stores/channels: never have two processes touching the same live state. */
export async function waitForServicePredecessor(): Promise<void> {
  const parentId = Number(process.env.HARBOUR_RESTART_PARENT_PID);
  const nonce = process.env.HARBOUR_RESTART_NONCE;
  delete process.env.HARBOUR_RESTART_PARENT_PID; delete process.env.HARBOUR_RESTART_NONCE;
  if (!nonce) return;
  if (!Number.isSafeInteger(parentId) || parentId <= 0 || !process.connected) throw new Error("无效的后端重启交接。");
  await new Promise<void>((resolve, reject) => {
    let committed = false;
    const done = (error?: Error) => {
      clearInterval(poll); clearTimeout(timer); process.removeListener("message", onMessage);
      if (process.connected) process.disconnect?.();
      error ? reject(error) : resolve();
    };
    const onMessage = (message: any) => {
      if (message?.nonce !== nonce) return;
      if (message.type === "harbour:restart-commit") committed = true;
      if (message.type === "harbour:restart-cancel") done(new Error("重启已取消。"));
    };
    const poll = setInterval(() => {
      if (!committed) return;
      try { process.kill(parentId, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") done(); }
    }, 100);
    const timer = setTimeout(() => done(new Error("原后端尚未退出；不启动重复服务。")), 30_000);
    process.on("message", onMessage);
    ipcMessage(process, { type: "harbour:restart-ready", nonce });
  });
}
