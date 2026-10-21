import { createHash } from "node:crypto";
import type { RunExecutionContext } from "../types";

type StageContext = Pick<RunExecutionContext, "novelAiSubmission">;
const stageSlot = Symbol("harbour.novelai.execution-stage");
const handleBrand = Symbol("harbour.novelai.execution-stage-handle");

/** Opaque run-local capability. JSON/checkpoint copies cannot authenticate it. */
export interface NovelAiExecutionStageHandle { readonly [handleBrand]: true }
interface Stage extends NovelAiExecutionStageHandle {
  onceKey: string;
  fingerprint: string;
  actions: number;
  activationAttempted: boolean;
  unverified: boolean;
  unverifiedReason?: string;
  closed: boolean;
}
type StageCarrier = StageContext & { [stageSlot]?: Stage };
const authenticStages = new WeakSet<object>();

export interface NovelAiExecutionStageSnapshot {
  version: 1;
  onceKey: string;
  formFingerprint: string;
  state: "not_submitted" | "activation_attempted" | "unverified";
  observedActions: number;
  /** Bounded diagnostic only; never an authorization or a page/prompt excerpt. */
  unverifiedReason?: string;
}

// This is coverage of Harbour's fixed execution paths, not a claim about an
// arbitrary site's business semantics. Generic mutation/eval paths fail closed.
const preSubmissionActions = new Set([
  "adapter:match", "adapter:search", "adapter:info", "open", "goto", "back", "tabs", "close", "handoff",
  "state", "snapshot", "extract", "get", "find", "inspect_novelai", "wait", "screenshot",
  "prepare_novelai_form", "upload_character_reference", "upload_attachment",
  // These run preflight first; the paid boundary must separately mark activation.
  "generate_novelai", "execute_novelai",
]);

/** A frozen Workflow must not fall back to arbitrary JS/clicks, even BEFORE its
 * first prepare. Those paths cannot prove absence of a paid submission. Reject
 * before dispatch/recording instead of executing them then poisoning recovery.
 * Ordinary Browser tasks without a frozen form retain their existing tools. */
export function assertNovelAiExecutionActionAllowed(execution: StageContext | undefined, action: string): void {
  if (!execution?.novelAiSubmission?.form || preSubmissionActions.has(action) || action === "collect_novelai_result") return;
  throw new Error("NovelAI 固定 Workflow 禁止通用页面操作；本次拦截未执行页面命令。请直接 prepare_novelai_form 自动选择冻结模型并填表，按冻结清单上传参考图，再 execute_novelai；不要用 eval/click/press 猜测或绕过。准备失败时只观察、handoff 并交回 Workflow，超限由原作者修稿。");
}

function fingerprint(execution?: StageContext): string | undefined {
  const limit = execution?.novelAiSubmission;
  if (!limit?.form || !limit.onceKey) return;
  return createHash("sha256").update(JSON.stringify([
    limit.onceKey, limit.form, limit.requiredReferences, limit.expectedModel,
    limit.maxCostAnlas, limit.numberOfImages, limit.otherReservedAnlas,
  ])).digest("hex");
}

function authenticated(execution?: StageContext): Stage | undefined {
  const stage = (execution as StageCarrier | undefined)?.[stageSlot];
  return stage && authenticStages.has(stage) ? stage : undefined;
}

/** Start only at the trusted Browser-run boundary, after reference-grant mapping.
 * Symbol properties survive execution-context spreads but are never serialized.
 * A restart therefore has no proof and must retain uncertainty. */
export function beginNovelAiExecutionStage(execution: StageContext): NovelAiExecutionStageHandle | undefined {
  const formFingerprint = fingerprint(execution);
  if (!formFingerprint) return;
  const previous = authenticated(execution);
  if (previous && !previous.closed) { previous.unverified = true; previous.unverifiedReason ??= "overlapping_run"; }
  const stage: Stage = {
    [handleBrand]: true, onceKey: execution.novelAiSubmission!.onceKey, fingerprint: formFingerprint,
    actions: 0, activationAttempted: false, unverified: !!previous && !previous.closed, closed: false,
    ...(previous && !previous.closed ? { unverifiedReason: "overlapping_run" } : {}),
  };
  authenticStages.add(stage);
  (execution as StageCarrier)[stageSlot] = stage;
  return stage;
}

/** Call for EVERY Browser/Adapter action, before dispatch. Unknown paths taint
 * the entire run; a subsequent observation never makes it safe again. */
export function recordNovelAiExecutionAction(execution: StageContext | undefined, action: string): void {
  const stage = authenticated(execution);
  if (!stage) return;
  if (stage.closed) throw new Error("NovelAI Browser 执行范围已结束；不得继续页面操作或提交 Generate。");
  stage.actions++;
  const changed = fingerprint(execution) !== stage.fingerprint;
  if (changed || !preSubmissionActions.has(action)) {
    stage.unverified = true;
    stage.unverifiedReason ??= changed ? "frozen_submission_changed"
      : `uncovered_action:${/^[a-z_:]{1,40}$/.test(action) ? action : "unknown"}`;
  }
}

/** Must happen BEFORE the paid browser command is invoked, even if it later
 * throws or times out. Neither a failed call nor unchanged balance can undo it. */
export function markNovelAiPaidActivation(execution: StageContext | undefined): void {
  const stage = authenticated(execution);
  if (!stage) return;
  if (stage.closed) throw new Error("NovelAI Browser 执行范围已结束；不得迟到提交 Generate。");
  if (fingerprint(execution) !== stage.fingerprint) { stage.unverified = true; stage.unverifiedReason ??= "frozen_submission_changed"; }
  stage.activationAttempted = true;
}

/** End the live capability before returning a receipt. The snapshot is audit
 * data only, never accepted as proof on resume. Late timed-out work cannot pay. */
export function finishNovelAiExecutionStage(execution: StageContext, handle: NovelAiExecutionStageHandle | undefined): NovelAiExecutionStageSnapshot | undefined {
  if (!handle || !authenticStages.has(handle)) return;
  const stage = handle as Stage;
  if (stage.closed) return;
  if (authenticated(execution) !== stage || fingerprint(execution) !== stage.fingerprint) {
    stage.unverified = true; stage.unverifiedReason ??= "execution_context_changed";
  }
  stage.closed = true;
  return {
    version: 1, onceKey: stage.onceKey, formFingerprint: stage.fingerprint,
    state: stage.activationAttempted ? "activation_attempted" : stage.unverified || !stage.actions ? "unverified" : "not_submitted",
    observedActions: stage.actions,
    ...(stage.unverifiedReason ? { unverifiedReason: stage.unverifiedReason } : {}),
  };
}
