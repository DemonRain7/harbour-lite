import type { AgentPermissionMode, Permissions } from "../../types";

export interface ExecutionEnvironmentInfo {
  osRelease: string;
  nodeVersion: string;
  shell: { name: string; executable: string; available: boolean; version?: string };
}

/** Optional for older workers; never derive a remote shell from the backend's OS. */
export function normalizeExecutionEnvironment(raw: unknown): ExecutionEnvironmentInfo | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as ExecutionEnvironmentInfo;
  const text = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
  if (!text(row.osRelease, 120) || !text(row.nodeVersion, 80) || !row.shell || typeof row.shell !== "object" || Array.isArray(row.shell)
    || !text(row.shell.name, 80) || !text(row.shell.executable, 4096) || typeof row.shell.available !== "boolean"
    || (row.shell.version !== undefined && (!text(row.shell.version, 80) || !/^\d+\.\d+(?:\.\d+){0,2}$/.test(row.shell.version)))) return undefined;
  return { osRelease: row.osRelease, nodeVersion: row.nodeVersion,
    shell: { name: row.shell.name, executable: row.shell.executable, available: row.shell.available,
      ...(row.shell.version ? { version: row.shell.version } : {}) } };
}

/** The same authenticated WebSocket may carry dashboard and Cowork messages. */
export interface CoworkDeviceInfo {
  id: string;
  label: string;
  platform: string;
  arch: string;
  hostname: string;
  tools: string[];
  cwd: string;
  online: boolean;
  lastSeenAt: number;
  environment?: ExecutionEnvironmentInfo;
}

export type DeviceInfo = CoworkDeviceInfo;

export interface CoworkCommand {
  operationId: string;
  runId: string;
  sessionId?: string;
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  mode: AgentPermissionMode;
  cwd?: string;
  permissions?: Permissions;
  context?: Record<string, unknown>;
  /** Absolute Unix time in milliseconds; never a relative client timeout. */
  deadline: number;
}

export type CoworkOperationStatus = "completed" | "failed" | "cancelled" | "running" | "unknown" | "not_found";

export interface CoworkHello {
  __harbour: "cowork:hello";
  deviceId: string;
  label: string;
  platform: string;
  arch: string;
  hostname: string;
  tools: string[];
  cwd: string;
  environment?: ExecutionEnvironmentInfo;
}

export interface CoworkResult {
  __harbour: "cowork:result";
  operationId: string;
  status: CoworkOperationStatus;
  result?: unknown;
  error?: string | { code?: string; message?: string; [key: string]: unknown };
}

export interface CoworkProgress {
  __harbour: "cowork:progress";
  operationId: string;
  message: string;
}

export type CoworkClientMessage = CoworkHello | CoworkResult | CoworkProgress;
export type CoworkServerMessage =
  | { __harbour: "cowork:execute"; command: CoworkCommand }
  | { __harbour: "cowork:query" | "cowork:cancel"; operationId: string }
  | { __harbour: "cowork:cleanup"; runId: string };

export class CoworkDeviceError extends Error {
  readonly code: string;
  readonly status: CoworkOperationStatus;
  readonly operationId?: string;
  readonly deviceId?: string;
  /** Partial, verified tool evidence may survive an unsuccessful/unknown operation. */
  readonly result?: unknown;

  constructor(code: string, status: CoworkOperationStatus, message: string, details: { operationId?: string; deviceId?: string; result?: unknown } = {}) {
    super(message);
    this.name = "CoworkDeviceError";
    this.code = code;
    this.status = status;
    this.operationId = details.operationId;
    this.deviceId = details.deviceId;
    this.result = details.result;
  }
}

/** 三条模型工具路径使用同一个错误回执，避免把 unknown 降成可自动重试的普通错误。 */
export function coworkFailureFields(error: unknown): Record<string, unknown> {
  const value = error as { code?: string; status?: string; operationId?: string } | undefined;
  return value?.code?.startsWith("COWORK_") ? { code: value.code, status: value.status,
    operationId: value.operationId, retrySafety: value.status === "unknown" ? "query_original_only" : "do_not_replay" } : {};
}
