import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { ToolAuditEvent } from "../types";
import { formatZonedIso, getHarbourTimeZone } from "./timeZone";

/**
 * Session / Trace 持久化 —— 每次 agent run 落一份 JSONL 到 assets/sessions/<id>.jsonl。
 * 记 start / model / turn / tool-call / tool-result / final 等事件 + token 用量。
 * 这是「自进化 / dream」分析近期会话的输入。
 *
 * 串行 append；工具边界和退出时 flush，失败不改变工具结果。目录属于私有审计资料。
 */

const SESSIONS_DIR = path.resolve(process.cwd(), "assets", "sessions");
export const TRACE_VERSION = 2;
export const TRACE_COVERAGE = {
  version: TRACE_VERSION,
  toolEvents: "outer-loop-and-backend",
  backendInternalSources: ["codex-dynamic", "codex-native", "claude-sdk", "dsh"],
  toolListMeaning: "available-tools-not-actual-calls",
  resultSummaryMeaning: "tool-reported-fields-not-independent-side-effect-confirmation; reason/error text is length+hash only",
  excluded: [
    "model-thinking", "raw-tool-arguments", "full-tool-results", "unstructured-tool-bodies",
    "unstructured-reason-error-text", "tool-result-paths", "signed-tool-urls", "credential-bearing-tool-fields",
  ],
  boundary: "Only observed tool lifecycle events are evidence; requests and completed tool returns do not by themselves prove an external side effect or charge.",
} as const;

const stableHash = (value: string): string => createHash("sha256").update(value).digest("hex");
const credentialLikeIdentifier = /(?:\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{12,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bsk-[A-Za-z0-9_-]{8,}\b|\bxox[baprs]-[A-Za-z0-9-]{8,}\b|\bAIza[0-9A-Za-z_-]{20,}\b)/i;
const sensitiveLabelIdentifier = /(?:^|[._:-])(?:authorization|bearer|cookie|set-cookie|api[-_]?key|access[-_]?(?:key|token)|auth[-_]?token|client[-_]?secret|secret|password|passwd|credential|signature)(?:$|[._:-])/i;

interface AuditTextMetadata {
  format: "text";
  characters: number;
  sha256?: string;
}

function auditTextMetadata(value: string): AuditTextMetadata {
  return { format: "text", characters: value.length, sha256: stableHash(value) };
}

function normalizedTextMetadata(value: unknown): AuditTextMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.format !== "text" || typeof row.characters !== "number" || !Number.isFinite(row.characters) || row.characters < 0) return undefined;
  const sha256 = typeof row.sha256 === "string" && /^[a-f0-9]{64}$/.test(row.sha256) ? row.sha256 : undefined;
  return {
    format: "text",
    characters: Math.floor(row.characters),
    ...(sha256 ? { sha256 } : {}),
  };
}

function auditMachineValue(value: string, max = 160): string | undefined {
  if (!value || value.length > max || value !== value.trim()) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) || credentialLikeIdentifier.test(value) || sensitiveLabelIdentifier.test(value)) return undefined;
  return value;
}

function auditMachineOrHash(value: string, max = 160): string {
  return auditMachineValue(value, max) ?? `sha256:${stableHash(value).slice(0, 24)}`;
}
const LEGACY_TRACE_WARNING = "旧 JSONL 可能只记录外层 loop，缺少 Codex/SDK 内部工具事件；没有工具行不证明没有调用、回执或扣费。";
const samePath = (a: string, b: string): boolean => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Only Harbour's real, direct run-log files receive runtime-owned coverage metadata.
 * Arbitrary JSONL (including a symlink out of the controlled root) stays plain file data.
 */
export async function runTraceReadMetadata(abs: string, content: string): Promise<Record<string, unknown> | undefined> {
  if (!samePath(path.dirname(path.resolve(abs)), SESSIONS_DIR) || !/^s-\d{4}-\d{2}-\d{2}-[a-f0-9]{8}\.jsonl$/i.test(path.basename(abs))) return;
  try {
    const [root, file] = await Promise.all([fs.realpath(SESSIONS_DIR), fs.realpath(abs)]);
    if (!samePath(path.dirname(file), root)) return;
    let start: Record<string, unknown> | undefined;
    try { start = JSON.parse(content.split("\n", 1)[0] ?? ""); } catch { /* unknown coverage */ }
    const current = start?.type === "start" && start.traceVersion === TRACE_VERSION;
    return {
      kind: "harbour-run-trace",
      traceId: path.basename(abs, ".jsonl"),
      traceVersion: current ? TRACE_VERSION : 0,
      toolEvents: current ? TRACE_COVERAGE.toolEvents : "unknown-legacy-coverage",
      boundary: TRACE_COVERAGE.boundary,
      ...(!current ? { warning: LEGACY_TRACE_WARNING } : {}),
    };
  } catch { return; }
}

/** 只保留短且脱敏的白名单状态字段；正文/输出只计长度，嵌套回执只展开一层。 */
export function summarizeToolAuditResult(value: unknown, depth = 0): Record<string, unknown> {
  if (typeof value === "string") {
    if (value.length <= 64_000) {
      try { return summarizeToolAuditResult(JSON.parse(value), depth); } catch { /* ordinary tool text */ }
    }
    return { format: "text", characters: value.length };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Array.isArray(value) ? { format: "array", count: value.length } : { format: value === null ? "null" : typeof value };
  }
  const textMetadata = normalizedTextMetadata(value);
  if (textMetadata) return { ...textMetadata };
  const row = value as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ["status", "agent", "jobId", "workflow", "action", "retrySafety", "chargeState", "reasonCode", "format"]) {
    const item = row[key];
    if (typeof item !== "string") continue;
    const safe = auditMachineValue(item, key === "jobId" ? 160 : 100);
    if (safe) summary[key] = safe;
  }
  // SDK/DSH diagnostics use a closed vocabulary; never persist arbitrary error prose.
  if (typeof row.failureStage === "string" && ["argument_decode", "input_schema", "tool_execution"].includes(row.failureStage)) summary.failureStage = row.failureStage;
  if (typeof row.errorCode === "string" && ["SDK_TOOL_ARGUMENT_JSON_INVALID", "DSH_TOOL_ARGUMENT_JSON_INVALID", "SDK_TOOL_INPUT_SCHEMA_INVALID", "HARBOUR_TOOL_RETURNED_ERROR"].includes(row.errorCode)) summary.errorCode = row.errorCode;
  if (typeof row.argumentError === "string" && ["unexpected-end", "unterminated-string", "control-character", "bad-unicode-escape",
    "unexpected-number", "trailing-content", "unexpected-token", "other"].includes(row.argumentError)) summary.argumentError = row.argumentError;
  for (const key of [
    "completed", "total", "revision", "visibleSpentAnlas", "maxTotalAnlas", "costAnlas", "exitCode",
    "argumentBytes", "contentCharacters", "filesCount", "artifactsCount", "deliveryUrlsCount", "partialDeliveryUrlsCount",
    "fieldCount", "count", "characters",
  ]) {
    const item = row[key];
    if (typeof item === "number" && Number.isFinite(item)) summary[key] = item;
  }
  for (const key of ["terminal", "timedOut", "refused", "isError", "outputTruncated"]) {
    if (typeof row[key] === "boolean") summary[key] = row[key];
  }
  for (const key of ["reason", "error"]) {
    const metadata = typeof row[key] === "string" ? auditTextMetadata(row[key]) : normalizedTextMetadata(row[key]);
    if (metadata) summary[key] = metadata;
  }
  for (const key of ["stdout", "stderr"]) {
    const metadata = typeof row[key] === "string"
      ? { format: "text" as const, characters: row[key].length }
      : normalizedTextMetadata(row[key]);
    if (metadata) summary[key] = { format: "text", characters: metadata.characters };
  }
  for (const key of ["files", "artifacts", "deliveryUrls", "partialDeliveryUrls"]) {
    if (Array.isArray(row[key])) summary[`${key}Count`] = row[key].length;
  }
  if (typeof row.content === "string") summary.contentCharacters = row.content.length;
  if (depth === 0 && row.result !== undefined) summary.result = summarizeToolAuditResult(row.result, 1);
  return Object.keys(summary).length ? summary : { format: "object", fieldCount: Object.keys(row).length };
}

/** 只传结构化工具审计；写日志失败不能变成重试/重新执行工具的理由。 */
export async function emitToolAudit(
  sink: ((event: ToolAuditEvent) => void | Promise<void>) | undefined,
  event: ToolAuditEvent,
  result?: unknown,
): Promise<void> {
  if (!sink) return;
  try {
    await sink({ ...event, ...(result !== undefined ? { summary: summarizeToolAuditResult(result) } : {}) });
  } catch { /* best-effort audit must never change the execution outcome */ }
}

export interface SessionTrace {
  readonly id: string;
  readonly file: string;
  event(type: string, data?: Record<string, unknown>): void;
  tool(event: ToolAuditEvent): void;
  flush(): Promise<void>;
}

export function startTrace(
  agentName: string,
  input: string,
  taskType?: string,
  options: { activityRunId?: string; delegationId?: string; directory?: string } = {},
): SessionTrace {
  const stamp = new Date().toISOString().slice(0, 10);
  const id = `s-${stamp}-${randomUUID().slice(0, 8)}`;
  const directory = options.directory ?? SESSIONS_DIR;
  const file = path.join(directory, `${id}.jsonl`);
  const identity = {
    traceId: id,
    agent: auditMachineOrHash(agentName, 120),
    ...(options.activityRunId ? {
      activityRunId: auditMachineOrHash(options.activityRunId, 200),
      runId: auditMachineOrHash(options.activityRunId, 200),
    } : {}),
    ...(options.delegationId ? { delegationId: auditMachineOrHash(options.delegationId, 200) } : {}),
  };
  const seenTools = new Set<string>();

  let chain: Promise<unknown> = fs.mkdir(directory, { recursive: true }).catch(() => {});
  const write = (obj: Record<string, unknown>): void => {
    const now = new Date();
    const timeZone = getHarbourTimeZone();
    // t and the filename date remain UTC for machine consumers and existing lexical ordering.
    // Local display is captured at event creation, not delayed until the append completes.
    const line = `${JSON.stringify({ ...obj, ...identity, t: now.toISOString(),
      timeLocal: formatZonedIso(now, timeZone), timeZone })}\n`;
    chain = chain.then(() => fs.appendFile(file, line, "utf8")).catch(() => {});
  };

  write({ type: "start", traceVersion: TRACE_VERSION, coverage: TRACE_COVERAGE, taskType: taskType ?? null, input });
  return {
    id,
    file,
    event: (type, data) => {
      const safe = { ...(data ?? {}) };
      for (const key of ["reason", "error"]) {
        if (typeof safe[key] === "string") safe[key] = auditTextMetadata(safe[key] as string);
        else if (safe[key] !== undefined) delete safe[key];
      }
      for (const key of ["path", "file", "url"]) delete safe[key];
      write({ type, ...safe });
    },
    tool: (event) => {
      // SDK streams/hooks may report the same call twice. A terminal is observed once;
      // an earlier true failure must not be overwritten by a later generic result.
      const key = event.callId ? `${event.source}:${event.callId}:${event.type === "tool-call" ? "call" : "terminal"}` : undefined;
      if (key && seenTools.has(key)) return;
      if (key) seenTools.add(key);
      write({
        type: event.type, source: event.source, tool: auditMachineOrHash(event.tool, 120),
        ...(event.callId ? { callId: `sha256:${stableHash(event.callId).slice(0, 24)}` } : {}),
        ...(event.step !== undefined ? { step: event.step } : {}),
        ...(event.status ? { status: event.status } : {}),
        ...(event.executed === false ? { executed: false } : {}),
        ...(event.summary ? { summary: summarizeToolAuditResult(event.summary) } : {}),
      });
    },
    flush: async () => { await chain; },
  };
}

/** 列出最近的 session（按文件名倒序，文件名内嵌日期）。 */
export async function listSessions(limit = 50): Promise<string[]> {
  try {
    const files = (await fs.readdir(SESSIONS_DIR)).filter((f) => f.endsWith(".jsonl"));
    return files.sort().reverse().slice(0, limit).map((f) => f.replace(/\.jsonl$/, ""));
  } catch {
    return [];
  }
}

/** 读取一个 session 的所有事件。 */
export async function readSession(id: string, directory = SESSIONS_DIR): Promise<Array<Record<string, unknown>>> {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
  try {
    const raw = await fs.readFile(path.join(directory, `${safe}.jsonl`), "utf8");
    const events = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return { type: "parse-error", raw: l };
        }
      });
    const start = events.find((event) => event.type === "start");
    if (start?.traceVersion !== TRACE_VERSION) {
      events.unshift({
        type: "trace-coverage", traceVersion: 0, toolEvents: "unknown-legacy-coverage",
        warning: LEGACY_TRACE_WARNING,
      });
    }
    return events;
  } catch {
    return [];
  }
}

export const SESSIONS_ROOT = SESSIONS_DIR;
