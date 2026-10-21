import type { TurnFileChange } from "../types";
import type { RunCheckpoint } from "./sessionStore";
import { decodeSdkToolResult } from "./backends/sdkToolResult";

export type GoalVerificationRequirement = "delivery" | "recorded" | "file_change" | "user_acceptance";
export interface GoalEvidenceReference {
  kind: "tool" | "file" | "subjective" | "user";
  ref: string;
  runId?: string;
  summary?: string;
}
export interface GoalVerification {
  status: "recorded" | "user_accepted" | "model_reported" | "needs_evidence";
  requirement: GoalVerificationRequirement;
  checkedAt: string;
  coverage: "recorded-boundaries-only";
  evidence: GoalEvidenceReference[];
}

/** Supplied only by trusted execution code, never by update_goal arguments. A
 * successful arbitrary shell command is not automatically a test. */
export interface GoalTestEvidence {
  ref: string;
  exitCode: number;
  /** Trusted verifier confirms this result is newer than the latest related write. */
  afterChange: boolean;
  /** File receipts covered by the trusted verifier, not model-provided claims. */
  afterFileChangeIds: readonly string[];
}
export interface GoalVerificationContext {
  goalId: string;
  requirement: GoalVerificationRequirement;
  runId?: string;
  checkpoint?: () => Pick<RunCheckpoint, "tools"> | undefined;
  fileChanges?: () => readonly TurnFileChange[];
  /** When configured, file_change additionally requires these trusted checks. */
  testEvidence?: () => readonly GoalTestEvidence[];
  /** Explicit user acceptance supplied by the authenticated entry point. */
  userAccepted?: boolean;
}
const KEY = "harbour:goal-verification-context";
const MAX_REFS = 8;
const requirements = new Set<GoalVerificationRequirement>(["delivery", "recorded", "file_change", "user_acceptance"]);
const nonSuccess = new Set(["failed", "error", "refused", "rejected", "blocked", "unknown", "pending", "running",
  "partial", "needs_input", "needs_evidence", "cancelled", "canceled", "interrupted", "timeout", "input_prepared", "not_started", "submitted", "queued"]);

export function seedGoalVerification(state: Map<string, unknown>, context: GoalVerificationContext): void {
  if (!context.goalId || !requirements.has(context.requirement)) throw new Error("Invalid trusted GOAL verification context");
  state.set(KEY, { ...context });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function short(value: unknown, limit = 160): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= limit ? value.trim() : undefined;
}
function explicitFailure(value: unknown): boolean {
  const row = record(value);
  if (!row) return false;
  const error = row.error;
  if (typeof error === "string" ? !!error.trim() : error !== undefined && error !== null && error !== false && error !== 0) return true;
  if (row.isError === true || row.is_error === true || row.accepted === false || row.executed === false ||
    row.refused === true || row.timedOut === true || row.ok === false || row.success === false) return true;
  if (typeof row.status === "string" && nonSuccess.has(row.status)) return true;
  for (const field of ["exitCode", "exit_code"]) {
    if (row[field] !== undefined && row[field] !== 0) return true;
  }
  return false;
}
/** Check wrapper flags before unwrapping; a failed envelope cannot be made successful
 * by an inner text payload. Do not walk unrelated business fields or old error notes. */
function failedEnvelope(value: unknown, depth = 0): boolean {
  if (depth >= 12) return true;
  if (explicitFailure(value)) return true;
  const row = record(value);
  if (Array.isArray(row?.content) && row.content.length) return failedEnvelope(row.content, depth + 1);
  if (Array.isArray(value) && value.length && value.every(block => {
    const item = record(block);
    return item && ["text", "image", "audio", "resource", "resource_link"].includes(String(item.type));
  })) {
    const text = value.filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text).join("\n");
    return text ? failedEnvelope(text, depth + 1) : false;
  }
  if (typeof value === "string" && value.length <= 64_000) {
    try { return failedEnvelope(JSON.parse(value) as unknown, depth + 1); } catch { /* ordinary text */ }
  }
  return false;
}
function success(result: unknown): boolean {
  const decoded = decodeSdkToolResult(result);
  // A plain successful result proves only an observed boundary, never test success.
  return !decoded.isError && !explicitFailure(decoded.value) && !failedEnvelope(result);
}
function requestedRefs(raw: unknown): { refs: GoalEvidenceReference[]; invalid: boolean } {
  if (raw === undefined) return { refs: [], invalid: false };
  if (!Array.isArray(raw) || raw.length > MAX_REFS) return { refs: [], invalid: true };
  const refs: GoalEvidenceReference[] = [];
  for (const value of raw) {
    const row = record(value);
    const kind = row?.kind;
    const ref = short(row?.ref);
    const summary = short(row?.summary, 800);
    if ((kind !== "tool" && kind !== "file" && kind !== "subjective") ||
      (kind === "subjective" ? !summary : !ref)) return { refs: [], invalid: true };
    refs.push({ kind, ref: ref ?? "delivery", ...(summary ? { summary } : {}) });
  }
  return { refs, invalid: false };
}

export interface GoalVerificationCheck {
  accepted: boolean;
  verification: GoalVerification;
  reasonCode?: string;
  availableEvidence?: Array<{ kind: "tool" | "file"; ref: string; tool?: string; path?: string }>;
}

/** Pure metadata verification. No filesystem reads, commands, network or model calls. */
export function verifyGoalCompletion(state: Map<string, unknown>, goalId: string, evidence?: unknown): GoalVerificationCheck {
  const context = state.get(KEY) as GoalVerificationContext | undefined;
  const trusted = context?.goalId === goalId ? context : undefined;
  const requirement = trusted?.requirement ?? "delivery";
  const verification: GoalVerification = { status: "needs_evidence", requirement,
    checkedAt: new Date().toISOString(), coverage: "recorded-boundaries-only", evidence: [] };
  if (context && !trusted) return { accepted: false, verification, reasonCode: "GOAL_EVIDENCE_SCOPE_MISMATCH" };
  const requested = requestedRefs(evidence);
  if (requested.invalid) return { accepted: false, verification, reasonCode: "GOAL_EVIDENCE_INVALID" };
  if (trusted?.userAccepted === true) {
    verification.status = "user_accepted";
    verification.evidence = [{ kind: "user", ref: goalId, ...(trusted.runId ? { runId: trusted.runId } : {}) }];
    return { accepted: true, verification };
  }
  const calls = trusted?.checkpoint?.()?.tools ?? [];
  const completed = calls.slice(-512).filter(call => call.status === "completed" &&
    call.tool !== "update_goal" && call.tool !== "mcp__harbour_tools__update_goal" &&
    !call.error && call.remote?.status !== "unknown" && success(call.result));
  const files = (trusted?.fileChanges?.() ?? []).slice(0, 256);
  const toolsById = new Map(completed.map(call => [call.id, call]));
  const filesById = new Map(files.map(file => [file.id, file]));
  const availableEvidence = [
    ...completed.slice(-4).map(call => ({ kind: "tool" as const, ref: call.id, tool: call.tool })),
    ...files.slice(-4).map(file => ({ kind: "file" as const, ref: file.id, path: file.path })),
  ];
  const reject = (reasonCode: string): GoalVerificationCheck => ({ accepted: false, verification, reasonCode, availableEvidence });
  for (const ref of requested.refs) {
    if (ref.kind === "tool" && !toolsById.has(ref.ref) || ref.kind === "file" && !filesById.has(ref.ref)) {
      return reject("GOAL_EVIDENCE_NOT_RECORDED");
    }
  }
  const selected = requested.refs.filter(ref => ref.kind !== "subjective").map(ref => ({ kind: ref.kind, ref: ref.ref,
    ...(trusted?.runId ? { runId: trusted.runId } : {}) }));
  if (requirement === "user_acceptance") return reject("GOAL_USER_ACCEPTANCE_REQUIRED");
  if (requirement === "delivery") {
    verification.status = selected.length ? "recorded" : "model_reported";
    verification.evidence = selected.length ? selected : requested.refs;
    return { accepted: true, verification };
  }
  if (!selected.length) return reject("GOAL_RECORDED_EVIDENCE_REQUIRED");
  if (calls.some(call => call.status === "running" && call.tool !== "update_goal" && call.tool !== "mcp__harbour_tools__update_goal")) {
    return reject("GOAL_TOOLS_STILL_RUNNING");
  }
  if (requirement === "file_change") {
    const selectedFiles = selected.filter(ref => ref.kind === "file");
    if (!selectedFiles.length) return reject("GOAL_FILE_CHANGE_REQUIRED");
    const tests = (trusted?.testEvidence?.() ?? []).filter(test => test.exitCode === 0 && test.afterChange === true && short(test.ref));
    if (trusted?.testEvidence && !selectedFiles.every(file => tests.some(test => test.afterFileChangeIds.includes(file.ref)))) {
      return reject("GOAL_POST_CHANGE_TEST_REQUIRED");
    }
    for (const test of tests) {
      if (selected.length >= MAX_REFS) break;
      if (selectedFiles.some(file => test.afterFileChangeIds.includes(file.ref))) selected.push({ kind: "tool", ref: test.ref,
        ...(trusted?.runId ? { runId: trusted.runId } : {}) });
    }
  }
  verification.status = "recorded";
  verification.evidence = selected.slice(0, MAX_REFS);
  return { accepted: true, verification };
}
