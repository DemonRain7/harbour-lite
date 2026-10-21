import type { ExecutionEvidence, ExecutionEvidenceEntry, Message, SessionRunRecord } from "../types";
import { normalizeExecutionReasonCode } from "../types";
import type { CheckpointToolCall, RunCheckpoint } from "./sessionStore";
import { estimateTextTokens } from "./tokenEstimate";

export const MAX_EXECUTION_EVIDENCE_TURNS = 3;
export const MAX_EXECUTION_EVIDENCE_ENTRIES = 16;
export const MAX_EXECUTION_EVIDENCE_CARD_TOKENS = 350;
const numericFields = ["completed", "total", "costAnlas", "visibleSpentAnlas", "maxTotalAnlas", "uncertainReservedAnlas"] as const;
const returnStatuses = new Set([
  "completed", "needs_input", "blocked", "aborted", "unknown", "continue", "paused", "success", "succeeded",
  "ok", "error", "failed", "cancelled", "canceled", "pending", "running", "ready", "not_started", "submitted",
  "partial", "validation_error", "accepted", "rejected", "refused", "not_found", "skipped", "queued", "timeout",
]);
const stopStatuses = new Set(["needs_input", "blocked", "aborted", "unknown", "paused", "error", "failed", "cancelled", "canceled", "refused", "rejected", "timeout"]);
const keyTools = new Set(["spawn_subagent", "run_workflow", "opencli_browser", "opencli_adapter", "apply_patch"]);

type BaselineCall = Pick<CheckpointToolCall, "status" | "startedAt" | "completedAt" | "replayCount">;
export type ExecutionEvidenceBaseline = ReadonlyMap<string, BaselineCall>;
export type ExecutionEvidenceBaselineSnapshot = Array<BaselineCall & { id: string }>;

/** Capture before a resumed attempt mutates the shared checkpoint; old entries are not new execution. */
export function executionEvidenceBaseline(checkpoint?: RunCheckpoint): ExecutionEvidenceBaseline {
  return new Map(checkpoint?.tools.map((call) => [call.id, {
    status: call.status, startedAt: call.startedAt, completedAt: call.completedAt, replayCount: call.replayCount,
  }]) ?? []);
}

export function snapshotExecutionEvidenceBaseline(baseline: ExecutionEvidenceBaseline): ExecutionEvidenceBaselineSnapshot {
  return [...baseline.entries()].map(([id, call]) => ({ id, ...call }));
}

export function normalizeExecutionEvidenceBaseline(raw: unknown): ExecutionEvidenceBaselineSnapshot | undefined {
  // A partial baseline would make omitted old calls look newly executed after reload.
  // Refuse oversized/untrusted snapshots instead of truncating them into false evidence.
  if (!Array.isArray(raw) || raw.length > 1_000) return undefined;
  const snapshot: ExecutionEvidenceBaselineSnapshot = [];
  const ids = new Set<string>();
  for (const value of raw) {
    const call = object(value);
    if (!call || typeof call.id !== "string" || !call.id || call.id.length > 512 || ids.has(call.id)) return undefined;
    if (call.status !== "running" && call.status !== "completed" && call.status !== "failed" && call.status !== "interrupted") return undefined;
    if (typeof call.startedAt !== "string" || !call.startedAt || call.startedAt.length > 64) return undefined;
    if (call.completedAt !== undefined && (typeof call.completedAt !== "string" || !call.completedAt || call.completedAt.length > 64)) return undefined;
    if (call.replayCount !== undefined
      && (typeof call.replayCount !== "number" || !Number.isFinite(call.replayCount) || call.replayCount < 0)) return undefined;
    ids.add(call.id);
    snapshot.push({
      id: call.id,
      status: call.status,
      startedAt: call.startedAt,
      ...(typeof call.completedAt === "string" ? { completedAt: call.completedAt } : {}),
      ...(typeof call.replayCount === "number" ? { replayCount: Math.floor(call.replayCount) } : {}),
    });
  }
  return snapshot;
}

export function executionEvidenceBaselineFromSnapshot(raw: unknown): ExecutionEvidenceBaseline | undefined {
  const snapshot = normalizeExecutionEvidenceBaseline(raw);
  return snapshot ? new Map(snapshot.map(({ id, ...call }) => [id, call])) : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,95}$/.test(value)
    && !/^sk-/i.test(value) ? value : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1_000_000, Math.max(0, Math.floor(value))) : 0;
}

/** Only typed scalar receipt fields are eligible. Never parse a prose result or copy args/result previews. */
function receiptFields(result: unknown): Partial<ExecutionEvidenceEntry> {
  const value = object(result);
  if (!value) return {};
  const fields: Partial<ExecutionEvidenceEntry> = {};
  if (typeof value.status === "string" && returnStatuses.has(value.status)) fields.returnStatus = value.status;
  const reasonCode = normalizeExecutionReasonCode(value.reasonCode);
  if (reasonCode) fields.reasonCode = reasonCode;
  const jobId = identifier(value.jobId);
  if (jobId) fields.jobId = jobId;
  if (value.chargeState === "charged" || value.chargeState === "not_charged" || value.chargeState === "unknown") fields.chargeState = value.chargeState;
  if (value.retrySafety === "safe" || value.retrySafety === "unsafe" || value.retrySafety === "uncertain") fields.retrySafety = value.retrySafety;
  for (const key of numericFields) {
    const number = value[key];
    if (typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER) fields[key] = number;
  }
  return fields;
}

function priority(entry: ExecutionEvidenceEntry): number {
  if (entry.historicalReceipt) return -10;
  return (entry.tool === "spawn_subagent" || entry.tool === "run_workflow" ? 8 : 0)
    + (entry.tool === "opencli_browser" || entry.tool === "opencli_adapter" ? 6 : 0)
    + (entry.jobId ? 16 : 0)
    + (entry.returnStatus === "unknown" || entry.chargeState === "unknown" || entry.retrySafety === "uncertain" ? 24 : 0)
    + (entry.boundary !== "returned" || stopStatuses.has(entry.returnStatus ?? "") || entry.chargeState === "unknown" || entry.retrySafety === "uncertain" ? 4 : 0)
    + (entry.observation === "replayed" ? 1 : 0);
}

function executionObject(entry: ExecutionEvidenceEntry, includeJob = true): string {
  return JSON.stringify([entry.agent, entry.tool, entry.targetAgent, entry.workflow, includeJob ? entry.jobId : undefined]);
}

export function projectExecutionEvidence(
  checkpoint: RunCheckpoint,
  baseline: ExecutionEvidenceBaseline = new Map(),
  traceContext?: unknown,
): ExecutionEvidence {
  const evidence: ExecutionEvidence = {
    version: 1, source: "server-checkpoint", coverage: "recorded-boundaries-only",
    executed: 0, replayed: 0, settled: 0, returned: 0, failed: 0, unfinished: 0, omitted: 0, entries: [],
  };
  const traceId = identifier(object(traceContext)?.traceId);
  if (traceId) evidence.traceId = traceId;
  const groups = new Map<string, ExecutionEvidenceEntry>();
  const add = (call: CheckpointToolCall, observation: ExecutionEvidenceEntry["observation"], amount: number) => {
    if (!amount) return;
    const boundary = call.status === "completed" ? "returned" : call.status === "failed" ? "failed" : "unfinished";
    evidence[observation === "executed" ? "executed" : observation === "replayed" ? "replayed" : "settled"] += amount;
    evidence[boundary] += amount;
    const receiptSummary = receiptFields(call.result);
    const retainReceipt = keyTools.has(call.tool) || boundary !== "returned" || stopStatuses.has(receiptSummary.returnStatus ?? "")
      || receiptSummary.reasonCode !== undefined || receiptSummary.chargeState === "unknown" || receiptSummary.retrySafety === "uncertain";
    const entry: ExecutionEvidenceEntry = {
      agent: identifier(call.agent) ?? "unrecognized-agent", tool: identifier(call.tool) ?? "unrecognized-tool",
      observation, boundary, count: amount,
      ...(retainReceipt ? receiptSummary : receiptSummary.returnStatus ? { returnStatus: receiptSummary.returnStatus } : {}),
    };
    const requestedTarget = call.tool === "spawn_subagent" ? identifier(call.args.agent) : undefined;
    const receipt = object(call.result);
    const target = call.tool === "spawn_subagent" ? identifier(receipt?.agent) ?? requestedTarget : undefined;
    const workflow = call.tool === "run_workflow" ? identifier(call.args.name) : undefined;
    if (target) entry.targetAgent = target;
    if (requestedTarget && requestedTarget !== target) entry.requestedTargetAgent = requestedTarget;
    if (call.tool === "spawn_subagent" && observation === "replayed") entry.delegateInvoked = false;
    else if (call.tool === "spawn_subagent" && typeof receipt?.delegateInvoked === "boolean") entry.delegateInvoked = receipt.delegateInvoked;
    else if (call.tool === "spawn_subagent" && typeof receipt?.controllerInvoked === "boolean") entry.delegateInvoked = receipt.controllerInvoked;
    else if (call.tool === "spawn_subagent" && receipt?.refused === true) entry.delegateInvoked = false;
    if (workflow) entry.workflow = workflow;
    if (call.remote?.status === "unknown") entry.returnStatus = "unknown";
    const key = JSON.stringify({ ...entry, count: 0 });
    const previous = groups.get(key);
    if (previous) {
      previous.count += amount;
      // A repeated group was observed again now; truncation must use its latest occurrence.
      groups.delete(key);
      groups.set(key, previous);
    } else groups.set(key, entry);
  };
  for (const call of checkpoint.tools) {
    const previous = baseline.get(call.id);
    const replays = Math.max(0, count(call.replayCount) - count(previous?.replayCount));
    // A restored completed step untouched by this attempt is historical, not a new tool call.
    const executed = !previous || previous.startedAt !== call.startedAt;
    const settled = !executed && previous && (previous.completedAt !== call.completedAt || previous.status !== call.status);
    if (executed) add(call, "executed", 1);
    if (settled) add(call, "settled", 1);
    if (replays) add(call, "replayed", replays);
  }
  const ordered = [...groups.values()];
  const latest = new Map<string, ExecutionEvidenceEntry>();
  const latestJob = new Map<string, number>();
  ordered.forEach((entry, index) => {
    latest.set(executionObject(entry), entry);
    if (entry.jobId) latestJob.set(executionObject(entry, false), index);
  });
  ordered.forEach((entry, index) => {
    // Never let old blocked progress crowd out a later authoritative return for the same job.
    // A different job, or an uncertain no-job result, is not superseded by somebody else's success.
    const safePreflight = !entry.jobId && entry.returnStatus === "needs_input"
      && entry.retrySafety === "safe" && entry.chargeState !== "unknown" && entry.chargeState !== "charged"
      && (latestJob.get(executionObject(entry, false)) ?? -1) > index;
    if ((entry.jobId && latest.get(executionObject(entry)) !== entry) || safePreflight) entry.historicalReceipt = true;
  });
  // Preserve latest job returns, dispatch/workflow and uncertainty ahead of historical/ordinary reads.
  const ranked = ordered.reverse().sort((a, b) => priority(b) - priority(a));
  let generalGroups = 0;
  for (const entry of ranked) {
    // Ordinary successful tools need aggregate counts, not an unbounded catalogue of result details.
    const general = !keyTools.has(entry.tool) && entry.boundary === "returned" && !stopStatuses.has(entry.returnStatus ?? "")
      && entry.chargeState !== "unknown" && entry.retrySafety !== "uncertain";
    if (evidence.entries.length < MAX_EXECUTION_EVIDENCE_ENTRIES && (!general || generalGroups < 3)) {
      evidence.entries.push(entry);
      if (general) generalGroups++;
    } else evidence.omitted += entry.count;
  }
  return normalizeExecutionEvidence(evidence)!;
}

/** Disk compatibility: discard unknown fields and reject malformed/unversioned metadata. */
export function normalizeExecutionEvidence(raw: unknown): ExecutionEvidence | undefined {
  const value = object(raw);
  if (!value || value.version !== 1 || value.source !== "server-checkpoint" || value.coverage !== "recorded-boundaries-only" || !Array.isArray(value.entries)) return undefined;
  const entries: ExecutionEvidenceEntry[] = [];
  for (const rawEntry of value.entries.slice(0, MAX_EXECUTION_EVIDENCE_ENTRIES)) {
    const entry = object(rawEntry);
    if (!entry || !identifier(entry.agent) || !identifier(entry.tool) || !count(entry.count)) continue;
    if (entry.observation !== "executed" && entry.observation !== "replayed" && entry.observation !== "settled") continue;
    if (entry.boundary !== "returned" && entry.boundary !== "failed" && entry.boundary !== "unfinished") continue;
    entries.push({
      agent: entry.agent as string, tool: entry.tool as string, observation: entry.observation, boundary: entry.boundary,
      count: count(entry.count), ...receiptFields({ ...entry, status: entry.returnStatus }),
      ...(entry.historicalReceipt === true ? { historicalReceipt: true as const } : {}),
      ...(identifier(entry.targetAgent) ? { targetAgent: entry.targetAgent as string } : {}),
      ...(identifier(entry.requestedTargetAgent) ? { requestedTargetAgent: entry.requestedTargetAgent as string } : {}),
      ...(typeof entry.delegateInvoked === "boolean" ? { delegateInvoked: entry.delegateInvoked } : {}),
      ...(identifier(entry.workflow) ? { workflow: entry.workflow as string } : {}),
    });
  }
  return {
    version: 1, source: "server-checkpoint", coverage: "recorded-boundaries-only",
    ...(identifier(value.traceId) ? { traceId: value.traceId as string } : {}),
    executed: count(value.executed), replayed: count(value.replayed), settled: count(value.settled), returned: count(value.returned),
    failed: count(value.failed), unfinished: count(value.unfinished),
    omitted: Math.max(count(value.omitted), count(value.executed) + count(value.replayed) + count(value.settled) - entries.reduce((sum, entry) => sum + entry.count, 0)),
    entries,
  };
}

function recordKey(record: SessionRunRecord): string {
  return `${record.checkpointId}:${record.attemptId}`;
}

export function recentExecutionRecords(messages: Message[], compacted: SessionRunRecord[] = []): SessionRunRecord[] {
  const records = [...compacted, ...messages.flatMap((message) => message.role === "assistant" && message.runRecord ? [message.runRecord] : [])];
  const keys = new Set<string>();
  const selected: SessionRunRecord[] = [];
  for (let i = records.length - 1; i >= 0 && selected.length < MAX_EXECUTION_EVIDENCE_TURNS; i--) {
    const record = records[i]!;
    const evidence = normalizeExecutionEvidence(record.evidence);
    if (!evidence || evidence.executed + evidence.replayed + evidence.settled === 0 || keys.has(recordKey(record))) continue;
    keys.add(recordKey(record));
    selected.unshift({ ...record, evidence });
  }
  return selected;
}

export function renderExecutionRecord(record: SessionRunRecord): string {
  const evidence = normalizeExecutionEvidence(record.evidence);
  if (!evidence) return "";
  const lines = [
    `[Harbour 运行事实 run=${identifier(record.attemptId) ?? "unknown"}${evidence.traceId ? ` trace=${evidence.traceId}` : ""}]`,
    `登记执行边界 ${evidence.executed} 个；旧回执回放 ${evidence.replayed} 次，旧边界结算/更新 ${evidence.settled} 个（均非新增执行）；返回 ${evidence.returned}，失败 ${evidence.failed}，未结束 ${evidence.unfinished}。`,
    "仅覆盖已登记边界：返回≠任务完成；未列出≠未调用；费用未知≠未生成。",
  ];
  let shown = 0;
  for (const entry of evidence.entries) {
    const details = [
      `${entry.agent}→${entry.tool}`,
      entry.targetAgent ? `target=${entry.targetAgent}` : "", entry.workflow ? `workflow=${entry.workflow}` : "",
      entry.requestedTargetAgent ? `requestedTarget=${entry.requestedTargetAgent}` : "",
      entry.delegateInvoked === undefined ? "" : `delegateInvoked=${entry.delegateInvoked}`,
      `${entry.observation === "replayed" ? "回放" : entry.observation === "settled" ? "旧边界更新" : "执行"}×${entry.count}`, `boundary=${entry.boundary}`,
      entry.historicalReceipt ? "historicalReceipt=true" : "",
      entry.returnStatus ? `returnStatus=${entry.returnStatus}` : "", entry.jobId ? `jobId=${entry.jobId}` : "",
      entry.reasonCode ? `reasonCode=${entry.reasonCode}` : "",
      entry.chargeState ? `chargeState=${entry.chargeState}` : "", entry.retrySafety ? `retrySafety=${entry.retrySafety}` : "",
      ...numericFields.map((field) => entry[field] === undefined ? "" : `${field}=${entry[field]}`),
    ].filter(Boolean).join(" ");
    if (estimateTextTokens([...lines, details, "其余边界已省略。", "[/Harbour 运行事实]"].join("\n")) > MAX_EXECUTION_EVIDENCE_CARD_TOKENS) continue;
    lines.push(details);
    shown += entry.count;
  }
  if (shown < evidence.executed + evidence.replayed + evidence.settled) lines.push("其余边界已省略。");
  lines.push("[/Harbour 运行事实]");
  return lines.join("\n");
}

/** Cards survive separately as bounded metadata, not as repeatedly copied summary prose. */
export function stripExecutionEvidenceCards(text: string): string {
  return text.replace(/\[Harbour 运行事实(?: [^\]\r\n]*)?\][\s\S]*?\[\/Harbour 运行事实\]/g, "");
}

/** The sole model-history materializer; leaves persisted assistant prose and display traces untouched. */
export function materializeExecutionHistory(
  messages: Message[], compacted: SessionRunRecord[] = [],
): { history: Message[]; summarySuffix: string } {
  const selected = recentExecutionRecords(messages, compacted);
  const cards = new Map(selected.map((record) => [recordKey(record), renderExecutionRecord(record)]));
  const history = messages.map((message): Message => {
    const card = message.role === "assistant" && message.runRecord ? cards.get(recordKey(message.runRecord)) : undefined;
    if (card) cards.delete(recordKey(message.runRecord!));
    // A model may have echoed a prior card in its final answer. Only independent metadata
    // can recreate an authoritative card; leave stored prose and user quotations untouched.
    const stripped = message.role === "assistant" ? stripExecutionEvidenceCards(message.content) : message.content;
    const content = message.role === "assistant" && !stripped.trim() && message.content ? "[历史答复仅含运行事实卡回显，已略]" : stripped;
    return {
      role: message.role, content: card ? `${content}\n\n${card}` : content,
      ...(message.actor ? { actor: { ...message.actor } } : {}),
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    };
  });
  return { history, summarySuffix: [...cards.values()].join("\n\n") };
}
