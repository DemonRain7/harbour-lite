import { createHash } from "node:crypto";
import type { RunExecutionContext, ToolContext } from "../../types";
import type { DelegationTask } from "../delegationTaskStore";
import type { WorkflowExecutionEvidence } from "../tools/runWorkflow";
import type { NovelAiDraftBudgetReview } from "./novelAiDraftBudget";
import { hasWorkflowExecution } from "./workflowAliases";

type DraftTask = Pick<DelegationTask, "ref" | "agent" | "draftHeads" | "followups" | "workflowResults">;
interface DraftBoundary {
  scope: string;
  task: DraftTask;
  workflow: string;
}
interface DraftFeedback {
  version: 1;
  delegationId: string;
  scopeHash: string;
  taskRef: string;
  agent: string;
  workflow: string;
  inputRef: string;
  draftRevision: number;
  followupFingerprint: string;
  review: NovelAiDraftBudgetReview;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function identity(execution: RunExecutionContext | undefined, boundary: DraftBoundary) {
  const delegationId = execution?.subagentDelegationId;
  const capability = execution?.delegationTasks;
  if (!delegationId || boundary.task.agent !== "novelai_artist" || boundary.workflow !== "novelai-generation" ||
    capability?.scope !== boundary.scope || capability.taskRef !== boundary.task.ref) return;
  const base = { delegationId, scopeHash: hash(boundary.scope), taskRef: boundary.task.ref,
    agent: boundary.task.agent, workflow: boundary.workflow };
  return { ...base, key: `novelai:draft-feedback:${hash(base)}` };
}

/** Carries an already computed numeric save summary, never a cached validator or
 * Workflow execution receipt. An empty/new incomplete/V5 save clears old data. */
export function rememberNovelAiDraftFeedback(ctx: Pick<ToolContext, "agent" | "execution">,
  boundary: DraftBoundary & { head: { inputRef: string; revision: number } },
  review: NovelAiDraftBudgetReview | undefined): void {
  if (ctx.agent.name !== boundary.task.agent) return;
  const binding = identity(ctx.execution, boundary);
  const evidence = ctx.execution?.toolEvidence;
  if (!binding || !evidence) return;
  evidence.delete(binding.key);
  if (!review) return;
  const { key, ...fields } = binding;
  evidence.set(key, { version: 1, ...fields, inputRef: boundary.head.inputRef,
    draftRevision: boundary.head.revision, followupFingerprint: hash(boundary.task.followups ?? []),
    review: structuredClone(review) } satisfies DraftFeedback);
}

/** Consume only this invocation's matching, current saved draft diagnostics.
 * The caller appends this AFTER persisting its ordinary task result: neither
 * task state nor workflowResults/result becomes a second diagnostic cache. */
export function takeNovelAiDraftFeedback(execution: RunExecutionContext | undefined, boundary: DraftBoundary,
  result: { referenceBudgetReview?: unknown; retrySafety?: unknown; jobId?: unknown; executionStarted?: unknown; status?: unknown },
  workflowEvidence?: WorkflowExecutionEvidence): Record<string, unknown> {
  const binding = identity(execution, boundary);
  const evidence = execution?.toolEvidence;
  if (!binding || !evidence) return {};
  const value = evidence.get(binding.key) as DraftFeedback | undefined;
  evidence.delete(binding.key);
  const head = boundary.task.draftHeads?.[boundary.workflow];
  if (!value || value.version !== 1 || !head ||
    value.delegationId !== binding.delegationId || value.scopeHash !== binding.scopeHash ||
    value.taskRef !== binding.taskRef || value.agent !== binding.agent || value.workflow !== binding.workflow ||
    value.inputRef !== head.inputRef || value.draftRevision !== head.revision ||
    value.followupFingerprint !== hash(boundary.task.followups ?? [])) return {};
  // A failed schema/input check may precede a new save. Actual/unknown execution
  // and its authoritative receipt always win over advisory author diagnostics.
  if (Object.hasOwn(result, "referenceBudgetReview") || result.retrySafety === "uncertain" || result.jobId ||
    result.executionStarted === true || ["started", "running", "unknown", "completed"].includes(String(result.status)) ||
    boundary.task.workflowResults.some(entry => hasWorkflowExecution(entry.result)) ||
    (workflowEvidence && (workflowEvidence.phase === "started" || workflowEvidence.jobSnapshot ||
      workflowEvidence.result?.executionStarted !== false))) return {};
  return { referenceBudgetReview: structuredClone(value.review),
    referenceBudgetReviewDraft: { source: "saved-draft-diagnostic", taskRef: value.taskRef,
      workflow: value.workflow, inputRef: value.inputRef, draftRevision: value.draftRevision,
      advisoryOnly: true, recompiledAtHandoff: false } };
}
