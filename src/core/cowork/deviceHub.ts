import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
import { CoworkDeviceError, normalizeExecutionEnvironment, type CoworkCommand, type CoworkDeviceInfo, type CoworkResult, type CoworkServerMessage } from "./protocol";

export type { CoworkCommand, CoworkDeviceInfo, DeviceInfo } from "./protocol";
export { CoworkDeviceError } from "./protocol";

export interface CoworkDeviceHubOptions {
  stateDir?: string;
  reconnectTimeoutMs?: number;
  cancelTimeoutMs?: number;
  maxMessageBytes?: number;
}

export interface CoworkExecuteOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

interface SavedDevice extends CoworkDeviceInfo { labelOverride?: string }
interface Connection { socket: WebSocket; deviceId: string; generation: number }
interface OperationBinding {
  version: 1;
  operationId: string;
  deviceId: string;
  fingerprint: string;
  createdAt: number;
  cancelRequested?: boolean;
}
interface PendingOperation {
  command: CoworkCommand;
  binding: OperationBinding;
  generation: number;
  promise: Promise<unknown>;
  resolve: (result: unknown) => void;
  reject: (error: CoworkDeviceError) => void;
  progress: Set<(message: string) => void>;
  abortListeners: Array<() => void>;
  deadlineTimer?: NodeJS.Timeout;
  recoveryTimer?: NodeJS.Timeout;
  cancelTimer?: NodeJS.Timeout;
  cancelReason?: "abort" | "deadline";
}

const MODES = new Set(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]);
const STATUSES = new Set(["completed", "failed", "cancelled", "running", "unknown", "not_found"]);
const MAX_TIMEOUT = 2_147_483_647;
// These names identify execution selectors, never a remote worker. Reserve case variants
// as well so a client's ID cannot impersonate the built-in server in device selection UI.
const RESERVED_DEVICE_IDS = new Set(["server", "current"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validText(value: unknown, max: number, empty = false): value is string {
  return typeof value === "string" && (empty || value.trim().length > 0) && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

function identifier(value: unknown): value is string {
  return validText(value, 200) && /^[a-zA-Z0-9_.:-]+$/u.test(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Deadline is transport policy, not a new logical operation on checkpoint recovery. */
export function coworkCommandFingerprint(deviceId: string, command: CoworkCommand): string {
  const { deadline: _deadline, ...logicalCommand } = command;
  return createHash("sha256").update(canonical(JSON.parse(JSON.stringify({ deviceId, command: logicalCommand })))).digest("hex");
}

function commandSnapshot(command: CoworkCommand): CoworkCommand {
  if (!isRecord(command) || !identifier(command.operationId) || !identifier(command.runId)
    || !validText(command.agent, 200) || !validText(command.tool, 200)
    || !isRecord(command.args) || !MODES.has(command.mode)
    || !Number.isSafeInteger(command.deadline)
    || (command.sessionId !== undefined && !validText(command.sessionId, 200))
    || (command.cwd !== undefined && !validText(command.cwd, 4_096))
    || (command.permissions !== undefined && !isRecord(command.permissions))
    || (command.context !== undefined && !isRecord(command.context))) {
    throw new CoworkDeviceError("COWORK_INVALID_COMMAND", "failed", "Cowork command is invalid.");
  }
  try {
    return JSON.parse(JSON.stringify(command)) as CoworkCommand;
  } catch {
    throw new CoworkDeviceError("COWORK_INVALID_COMMAND", "failed", "Cowork commands must be JSON serializable.");
  }
}

function normalizeHello(value: Record<string, unknown>, now: number): SavedDevice | undefined {
  if (!identifier(value.deviceId) || RESERVED_DEVICE_IDS.has(value.deviceId.toLowerCase()) || !validText(value.label, 120) || !validText(value.platform, 80)
    || !validText(value.arch, 80) || !validText(value.hostname, 240, true) || !validText(value.cwd, 4_096)
    || !Array.isArray(value.tools) || value.tools.length > 256
    || !value.tools.every((tool) => validText(tool, 200))) return undefined;
  return {
    id: value.deviceId, label: value.label.trim(), platform: value.platform, arch: value.arch,
    hostname: value.hostname, cwd: value.cwd, tools: [...new Set(value.tools as string[])], online: true, lastSeenAt: now,
    environment: normalizeExecutionEnvironment(value.environment),
  };
}

/**
 * Broker for owner-authenticated local tool workers; it never chooses a default device.
 * Persist before issuing: after a process restart, a known operation is queried, never replayed.
 * The lightweight journal stores only IDs/hashes, not local file contents or tool arguments.
 */
export class CoworkDeviceHub {
  private readonly stateDir: string;
  private readonly reconnectTimeoutMs: number;
  private readonly cancelTimeoutMs: number;
  private readonly maxMessageBytes: number;
  private readonly devices = new Map<string, SavedDevice>();
  private readonly connections = new Map<string, Connection>();
  private readonly attached = new WeakSet<WebSocket>();
  private readonly pending = new Map<string, PendingOperation>();
  private readonly cleanups = new Map<string, Set<string>>();
  private generation = 0;

  constructor(options: CoworkDeviceHubOptions | string = {}) {
    const config = typeof options === "string" ? { stateDir: options } : options;
    this.stateDir = path.resolve(config.stateDir ?? path.join(process.cwd(), "data", "cowork", "devices"));
    this.reconnectTimeoutMs = Math.max(1, config.reconnectTimeoutMs ?? 15_000);
    this.cancelTimeoutMs = Math.max(1, config.cancelTimeoutMs ?? 2_000);
    this.maxMessageBytes = Math.max(1, config.maxMessageBytes ?? 16 * 1024 * 1024);
    this.loadDevices();
  }

  /** Call only after the HTTP/WS boundary has authenticated the connection as the owner. */
  attach(socket: WebSocket): void {
    if (this.attached.has(socket)) return;
    this.attached.add(socket);
    let connection: Connection | undefined;
    let closed = false;
    socket.on("message", (raw: unknown) => {
      if (closed || socket.readyState !== 1) return;
      let message: Record<string, unknown>;
      try {
        const buffer = Array.isArray(raw) ? Buffer.concat(raw) : typeof raw === "string" ? Buffer.from(raw) : Buffer.from(raw as ArrayBuffer);
        if (buffer.byteLength > this.maxMessageBytes) return;
        const parsed: unknown = JSON.parse(buffer.toString("utf8"));
        if (!isRecord(parsed)) return;
        message = parsed;
      } catch { return; }
      const type = message.__harbour ?? message.type;
      if (type === "cowork:hello") {
        if (typeof message.deviceId === "string" && RESERVED_DEVICE_IDS.has(message.deviceId.toLowerCase())) {
          try { socket.close(1008, "Reserved Cowork device ID"); } catch { /* Refusal does not depend on close delivery. */ }
          return;
        }
        const device = normalizeHello(message, Date.now());
        if (!device || (connection && connection.deviceId !== device.id)) return;
        // A superseded connection cannot reclaim its identity with another hello.
        if (connection && this.connections.get(device.id) !== connection) return;
        const previous = this.devices.get(device.id);
        if (previous?.labelOverride) {
          device.labelOverride = previous.labelOverride;
          device.label = previous.labelOverride;
        }
        try { this.persistDevices(device); } catch { return; }
        this.devices.set(device.id, device);
        if (connection) return;
        const old = this.connections.get(device.id);
        connection = { socket, deviceId: device.id, generation: ++this.generation };
        this.connections.set(device.id, connection);
        if (old) {
          try { old.socket.close(4001, "Cowork connection superseded"); } catch { /* Generation check remains authoritative. */ }
        }
        for (const pending of this.pending.values()) {
          if (pending.binding.deviceId !== device.id) continue;
          this.query(pending, connection);
        }
        const queuedCleanups = this.cleanups.get(device.id);
        this.cleanups.delete(device.id);
        for (const runId of queuedCleanups ?? []) this.cleanup(device.id, runId);
        return;
      }
      if (!connection || this.connections.get(connection.deviceId) !== connection) return;
      if (type !== "cowork:result" && type !== "cowork:progress") return;
      const pending = typeof message.operationId === "string" ? this.pending.get(message.operationId) : undefined;
      if (!pending || pending.binding.deviceId !== connection.deviceId || pending.generation !== connection.generation) return;
      const device = this.devices.get(connection.deviceId);
      if (device) device.lastSeenAt = Date.now();
      if (type === "cowork:progress") {
        if (typeof message.message !== "string" || message.message.length > 16_384) return;
        this.clearRecovery(pending);
        for (const listener of pending.progress) {
          try { listener(message.message); } catch { /* A trace callback must not disrupt the operation. */ }
        }
      } else if (typeof message.status === "string" && STATUSES.has(message.status)) {
        this.result(pending, message as unknown as CoworkResult);
      }
    });
    const disconnect = (): void => {
      closed = true;
      if (connection) this.disconnect(connection);
    };
    socket.on("close", disconnect);
    socket.on("error", disconnect);
  }

  list(): CoworkDeviceInfo[] {
    return [...this.devices.keys()].sort().map((id) => this.get(id)!);
  }

  get(id: string): CoworkDeviceInfo | undefined {
    const saved = this.devices.get(id);
    if (!saved) return undefined;
    const { labelOverride: _override, ...device } = saved;
    return { ...device, tools: [...device.tools], environment: normalizeExecutionEnvironment(device.environment),
      online: this.connections.get(id)?.socket.readyState === 1 };
  }

  resolveTarget(idOrUniqueLabel: string): CoworkDeviceInfo {
    const exact = this.get(idOrUniqueLabel);
    if (exact) return exact;
    const matches = this.list().filter((device) => device.label === idOrUniqueLabel);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new CoworkDeviceError("COWORK_AMBIGUOUS_DEVICE", "failed", "Multiple Cowork devices share this label; select an exact device ID.");
    throw new CoworkDeviceError("COWORK_DEVICE_NOT_FOUND", "not_found", "The selected Cowork device is not registered.", { deviceId: idOrUniqueLabel });
  }

  rename(id: string, label: string): CoworkDeviceInfo {
    const device = this.devices.get(id);
    if (!device) throw new CoworkDeviceError("COWORK_DEVICE_NOT_FOUND", "not_found", "The selected Cowork device is not registered.", { deviceId: id });
    if (!validText(label, 120)) throw new CoworkDeviceError("COWORK_INVALID_LABEL", "failed", "Cowork device labels must contain 1–120 characters.");
    const updated = { ...device, label: label.trim(), labelOverride: label.trim() };
    this.persistDevices(updated);
    this.devices.set(id, updated);
    return this.get(id)!;
  }

  execute(deviceId: string, input: CoworkCommand, options: CoworkExecuteOptions = {}): Promise<unknown> {
    try {
      const command = commandSnapshot(input);
      const details = { operationId: command.operationId, deviceId };
      const fingerprint = coworkCommandFingerprint(deviceId, command);
      const existing = this.pending.get(command.operationId);
      if (existing) {
        this.assertBinding(existing.binding, deviceId, fingerprint);
        this.subscribe(existing, options);
        return existing.promise;
      }
      const saved = this.loadBinding(command.operationId);
      if (saved) this.assertBinding(saved, deviceId, fingerprint);
      if (command.deadline <= Date.now()) throw new CoworkDeviceError("COWORK_DEADLINE_EXCEEDED", saved ? "unknown" : "cancelled", "Cowork deadline has expired; no command was dispatched.", details);
      if (options.signal?.aborted) throw new CoworkDeviceError("COWORK_CANCELLED", saved ? "unknown" : "cancelled", "Cowork request was aborted before dispatch.", details);
      const device = this.get(deviceId);
      const connection = this.connections.get(deviceId);
      if (!device) throw new CoworkDeviceError("COWORK_DEVICE_NOT_FOUND", "not_found", "The selected Cowork device is not registered.", details);
      if (!connection || !device.online) throw new CoworkDeviceError("COWORK_DEVICE_OFFLINE", saved ? "unknown" : "not_found", "The selected Cowork device is offline; no other device was substituted.", details);
      if (!saved && !device.tools.includes(command.tool)) throw new CoworkDeviceError("COWORK_TOOL_UNAVAILABLE", "failed", "The selected Cowork device does not advertise this tool.", details);
      const binding: OperationBinding = saved ?? { version: 1, operationId: command.operationId, deviceId, fingerprint, createdAt: Date.now() };
      // A crash from this point on is recovered only by querying the worker's durable ledger.
      if (!saved) this.persistBinding(binding);
      let resolve!: (result: unknown) => void;
      let reject!: (error: CoworkDeviceError) => void;
      const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
      const pending: PendingOperation = { command, binding, generation: connection.generation, promise, resolve, reject, progress: new Set(), abortListeners: [] };
      this.pending.set(command.operationId, pending);
      this.armDeadline(pending);
      this.subscribe(pending, options);
      if (!saved && pending.cancelReason) {
        this.fail(pending, new CoworkDeviceError("COWORK_DEADLINE_EXCEEDED", "cancelled", "Cowork deadline expired before dispatch; the operation was not executed.", details));
        return promise;
      }
      if (saved) this.query(pending, connection);
      else if (!this.send(connection, { __harbour: "cowork:execute", command })) this.waitForRecovery(pending);
      return promise;
    } catch (error) {
      return Promise.reject(error instanceof CoworkDeviceError ? error : new CoworkDeviceError("COWORK_STATE_ERROR", "unknown", `Cowork durable state is unavailable: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  cleanup(deviceId: string, runId: string): void {
    if (!identifier(runId) || !this.devices.has(deviceId)) return;
    const connection = this.connections.get(deviceId);
    if (connection && this.send(connection, { __harbour: "cowork:cleanup", runId })) return;
    this.queueCleanup(deviceId, runId);
  }

  private queueCleanup(deviceId: string, runId: string): void {
    const queued = this.cleanups.get(deviceId) ?? new Set<string>();
    queued.add(runId);
    this.cleanups.set(deviceId, queued);
  }

  private subscribe(pending: PendingOperation, options: CoworkExecuteOptions): void {
    if (options.onProgress) pending.progress.add(options.onProgress);
    if (!options.signal) return;
    const signal = options.signal;
    const abort = (): void => this.cancel(pending, "abort");
    if (signal.aborted) abort();
    else {
      signal.addEventListener("abort", abort, { once: true });
      pending.abortListeners.push(() => signal.removeEventListener("abort", abort));
    }
  }

  private assertBinding(binding: OperationBinding, deviceId: string, fingerprint: string): void {
    if (binding.deviceId !== deviceId || binding.fingerprint !== fingerprint) throw new CoworkDeviceError("COWORK_OPERATION_CONFLICT", "failed", "This operation ID is already bound to another device or different arguments; it cannot be reused.", { operationId: binding.operationId, deviceId });
  }

  private armDeadline(pending: PendingOperation): void {
    const remaining = pending.command.deadline - Date.now();
    if (remaining <= 0) { this.cancel(pending, "deadline"); return; }
    pending.deadlineTimer = setTimeout(() => this.armDeadline(pending), Math.min(remaining, MAX_TIMEOUT));
  }

  private query(pending: PendingOperation, connection: Connection): void {
    pending.generation = connection.generation;
    this.waitForRecovery(pending);
    if (pending.binding.cancelRequested) {
      if (!pending.cancelReason) this.cancel(pending, "abort");
      else this.send(connection, { __harbour: "cowork:cancel", operationId: pending.command.operationId });
    }
    this.send(connection, { __harbour: "cowork:query", operationId: pending.command.operationId });
  }

  private cancel(pending: PendingOperation, reason: "abort" | "deadline"): void {
    if (this.pending.get(pending.command.operationId) !== pending || pending.cancelReason) return;
    pending.cancelReason = reason;
    pending.binding.cancelRequested = true;
    try { this.persistBinding(pending.binding); } catch { /* Still deliver cancellation; an existing journal entry already prevents replay. */ }
    if (pending.deadlineTimer) clearTimeout(pending.deadlineTimer);
    // Abort is a request, not evidence that the worker or its side effects have stopped.
    pending.cancelTimer = setTimeout(() => this.fail(pending, new CoworkDeviceError(
      reason === "deadline" ? "COWORK_DEADLINE_EXCEEDED" : "COWORK_CANCEL_UNCONFIRMED", "unknown",
      "Cowork cancellation was not confirmed; the operation may still be running. Query this operation ID before taking further action.",
      { operationId: pending.command.operationId, deviceId: pending.binding.deviceId },
    )), this.cancelTimeoutMs);
    const connection = this.connections.get(pending.binding.deviceId);
    if (connection) this.send(connection, { __harbour: "cowork:cancel", operationId: pending.command.operationId });
  }

  private result(pending: PendingOperation, reply: CoworkResult): void {
    this.clearRecovery(pending);
    if (reply.status === "running") return;
    if (reply.status === "completed") {
      this.settle(pending);
      pending.resolve(reply.result);
      return;
    }
    const supplied = isRecord(reply.error) ? reply.error : undefined;
    const errorCode = supplied && validText(supplied.code, 120) ? supplied.code : undefined;
    const errorMessage = typeof reply.error === "string" ? reply.error : supplied && typeof supplied.message === "string" ? supplied.message : undefined;
    const code = reply.status === "cancelled" && pending.cancelReason === "deadline" ? "COWORK_DEADLINE_EXCEEDED"
      : errorCode ?? `COWORK_OPERATION_${reply.status.toUpperCase()}`;
    this.fail(pending, new CoworkDeviceError(code, reply.status,
      errorMessage ?? (reply.status === "not_found" ? "The worker has no durable record of this operation; it was not automatically replayed." : `Cowork operation status: ${reply.status}.`),
      { operationId: pending.command.operationId, deviceId: pending.binding.deviceId, result: reply.result },
    ));
  }

  private send(connection: Connection, message: CoworkServerMessage): boolean {
    if (this.connections.get(connection.deviceId) !== connection || connection.socket.readyState !== 1) return false;
    try {
      connection.socket.send(JSON.stringify(message), (error?: Error) => {
        if (!error) return;
        if (message.__harbour === "cowork:cleanup") this.queueCleanup(connection.deviceId, message.runId);
        this.disconnect(connection);
      });
      return true;
    } catch { this.disconnect(connection); return false; }
  }

  private disconnect(connection: Connection): void {
    if (this.connections.get(connection.deviceId) !== connection) return;
    this.connections.delete(connection.deviceId);
    const device = this.devices.get(connection.deviceId);
    if (device) {
      device.online = false;
      try { this.persistDevices(); } catch { /* list()/get() derive online status from live sockets. */ }
    }
    for (const pending of this.pending.values()) if (pending.binding.deviceId === connection.deviceId) this.waitForRecovery(pending);
  }

  private waitForRecovery(pending: PendingOperation): void {
    if (this.pending.get(pending.command.operationId) !== pending || pending.recoveryTimer) return;
    for (const listener of pending.progress) {
      try { listener("Cowork 连接中断，正在重连并查询原操作状态；不会重新执行。"); } catch { /* observer must not break recovery */ }
    }
    pending.recoveryTimer = setTimeout(() => this.fail(pending, new CoworkDeviceError("COWORK_CONNECTION_LOST", "unknown",
      "The selected Cowork device did not confirm the operation after reconnect. It may still be running; no command was replayed and no other device was used.",
      { operationId: pending.command.operationId, deviceId: pending.binding.deviceId },
    )), this.reconnectTimeoutMs);
  }

  private clearRecovery(pending: PendingOperation): void {
    if (pending.recoveryTimer) clearTimeout(pending.recoveryTimer);
    pending.recoveryTimer = undefined;
  }

  private fail(pending: PendingOperation, error: CoworkDeviceError): void {
    if (this.pending.get(pending.command.operationId) !== pending) return;
    this.settle(pending);
    pending.reject(error);
  }

  private settle(pending: PendingOperation): void {
    this.pending.delete(pending.command.operationId);
    if (pending.deadlineTimer) clearTimeout(pending.deadlineTimer);
    if (pending.cancelTimer) clearTimeout(pending.cancelTimer);
    this.clearRecovery(pending);
    for (const remove of pending.abortListeners) remove();
    pending.progress.clear();
  }

  private loadDevices(): void {
    const filename = path.join(this.stateDir, "devices.json");
    if (!fs.existsSync(filename)) return;
    const parsed: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.devices)) throw new Error("Invalid Cowork device metadata.");
    for (const item of parsed.devices) {
      if (!isRecord(item)) continue;
      const device = normalizeHello({ ...item, deviceId: item.id }, 0);
      if (!device) continue;
      device.online = false;
      device.lastSeenAt = typeof item.lastSeenAt === "number" && Number.isFinite(item.lastSeenAt) ? item.lastSeenAt : 0;
      if (validText(item.labelOverride, 120)) device.label = device.labelOverride = item.labelOverride;
      this.devices.set(device.id, device);
    }
  }

  private persistDevices(replacement?: SavedDevice): void {
    const records = new Map(this.devices);
    if (replacement) records.set(replacement.id, replacement);
    this.atomicWrite(path.join(this.stateDir, "devices.json"), { version: 1, devices: [...records.values()].map((device) => ({ ...device, online: false })) });
  }

  private bindingPath(operationId: string): string {
    return path.join(this.stateDir, "operations", `${createHash("sha256").update(operationId).digest("hex")}.json`);
  }

  private loadBinding(operationId: string): OperationBinding | undefined {
    const filename = this.bindingPath(operationId);
    if (!fs.existsSync(filename)) return undefined;
    const row: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (!isRecord(row) || row.version !== 1 || row.operationId !== operationId || !identifier(row.deviceId)
      || typeof row.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(row.fingerprint)
      || typeof row.createdAt !== "number" || (row.cancelRequested !== undefined && typeof row.cancelRequested !== "boolean")) throw new Error("Invalid Cowork operation journal; replay is disabled.");
    return row as unknown as OperationBinding;
  }

  private persistBinding(binding: OperationBinding): void { this.atomicWrite(this.bindingPath(binding.operationId), binding); }

  private atomicWrite(filename: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
        fs.fsyncSync(descriptor);
      } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, filename);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}

export const coworkDeviceHub = new CoworkDeviceHub();
