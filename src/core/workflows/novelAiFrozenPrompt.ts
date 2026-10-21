import { createHash } from "node:crypto";
import type { ToolContext } from "../../types";
import { taskPersistence } from "../delegationTasks";
import { supportsNovelAiPreciseReferences } from "../novelAiModelCapabilities";
import type { NovelAiBrowserPromptForm } from "../novelAiPromptComposer";
import type { NovelAiPromptBudgetOverflowReport } from "../novelAiPromptBudget";
import { novelAiPromptContentKey } from "../novelAiPromptBudgetEvidence";
import { planPromptRevision, promptText, validatePromptRevision } from "../novelAiPromptRefinement";
import { frozenNovelAiRequiredReferences } from "../novelAiReferences";
import { hasWorkflowExecution, workflowPersistenceNames } from "./workflowAliases";
import { WorkflowInputValidationError } from "./registry";

export interface FrozenPromptTarget {
  kind: "image" | "comic";
  jobId: string;
  revision: number;
  unit: number;
  request?: Record<string, unknown>;
  recoverable: boolean;
  pageCounts?: NovelAiPromptBudgetOverflowReport;
}

/** Only the original bound author may edit an existing Job. No new delegation,
 * extra model, fallback model or generated-image replay is introduced here. */
export async function assertFrozenPromptAuthor(ctx: ToolContext, kind: FrozenPromptTarget["kind"], jobId: string): Promise<void> {
  const durable = taskPersistence(ctx);
  if (!durable || ctx.agent.name !== (kind === "image" ? "novelai_artist" : "comic_generator") ||
    ctx.execution?.novelAiIntent && ctx.execution.novelAiIntent !== "generate") {
    throw new WorkflowInputValidationError("冻结稿精简只交给原任务的内部作者，不创建新任务或扩大执行权限。", "prompt_recovery_author_required");
  }
  const task = await durable.store.get(durable.scope, durable.taskRef!);
  if (task.agent !== ctx.agent.name || !task.workflowResults.some(entry =>
    workflowPersistenceNames("novelai-generation", ctx).includes(entry.workflow) &&
    hasWorkflowExecution(entry.result) && entry.result.jobId === jobId)) {
    throw new WorkflowInputValidationError("这个 Job 不属于当前作者任务。", "author_job_mismatch");
  }
}

export function frozenPromptUnit(input: Record<string, unknown>, max: number): number {
  if (!Number.isSafeInteger(input.unit) || Number(input.unit) < 1 || Number(input.unit) > max) {
    throw new WorkflowInputValidationError("unit 使用 Job 中的一基生成单元编号；不猜测画面或重写整本。", "prompt_target_invalid");
  }
  return Number(input.unit);
}

export function frozenPromptRecoveryAction(target: FrozenPromptTarget): Record<string, unknown> | undefined {
  if (!target.recoverable || typeof target.request?.model !== "string" || !supportsNovelAiPreciseReferences(target.request.model)) return;
  const form = target.request.browserForm as NovelAiBrowserPromptForm | undefined;
  if (!form || !Array.isArray(form.characters) || !Array.isArray(form.characterNames) ||
    form.characters.length !== form.characterNames.length || form.characterPrompts?.length !== form.characters.length ||
    form.characterUndesiredPrompts?.length !== form.characters.length) return;
  try { if (!frozenNovelAiRequiredReferences(target.request).length || !novelAiPromptContentKey(target.request)) return; }
  catch { return; }
  return { name: "novelai-generation", action: "inspect_prompt", input: { unit: target.unit, expectedRevision: target.revision } };
}

/** Legacy callers keep their recovery API. Only a bound internal author gets
 * the text-only next action; Main resumes that author instead. */
export function promptRecoverySummary(receipt: Record<string, unknown>, ctx?: ToolContext): Record<string, unknown> {
  if (receipt.promptRecovery && ctx && taskPersistence(ctx)?.taskRef &&
    ["novelai_artist", "comic_generator"].includes(ctx.agent.name)) {
    const { promptRecovery, ...rest } = receipt;
    return { ...rest, requiredAction: "inspect_prompt", nextAction: promptRecovery, terminal: false };
  }
  return receipt;
}

/** Revisions are of the exact frozen form, never a reconstruction from an old
 * draft or today's templates. Only these four text fields can change. */
export async function frozenPrompt(action: string, input: Record<string, unknown>, target: FrozenPromptTarget): Promise<{
  result: Record<string, unknown>; request?: Record<string, unknown>;
}> {
  const allowed = action === "inspect_prompt" ? ["jobId", "unit", "expectedRevision"]
    : ["jobId", "unit", "expectedRevision", "sourceHash", "prompt"];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new WorkflowInputValidationError(
    `已有 Job 的 ${action} 只接受 ${allowed.filter(key => key !== "jobId").join("/")}；沿用回执，不填 draftRevision 或草稿 path。`, "prompt_recovery_input_invalid");
  if ((action === "revise_prompt" || input.expectedRevision !== undefined) && input.expectedRevision !== target.revision) {
    throw new WorkflowInputValidationError(`Job 已更新，当前 expectedRevision=${target.revision}；重新 inspect_prompt。`, "revision_conflict");
  }
  const inspect = frozenPromptRecoveryAction(target);
  if (!inspect) throw new WorkflowInputValidationError(
    "只允许精简已确认尚未执行或提交前网页超限的 reference/V4.5 冻结稿；任务须空闲，成品、未知提交、其它故障和 V5 不可经此入口修改。先 status 核对当前状态。", "prompt_recovery_not_available");
  const request = target.request!;
  const form = request.browserForm as NovelAiBrowserPromptForm;
  const sourceHash = createHash("sha256").update(JSON.stringify([
    "frozen-reference-prompt-v1", target.jobId, target.revision, target.unit, request,
  ])).digest("hex");
  const nextInput = { unit: target.unit, expectedRevision: target.revision, sourceHash };
  const common = { jobId: target.jobId, ...nextInput, terminal: false, generationAuthorized: false };
  if (action === "inspect_prompt") {
    const plan = await planPromptRevision(form);
    const localCounts = { positive: plan.positive.estimatedTokens, negative: plan.negative.estimatedTokens };
    // Measured excess gives the author a smaller target without another LLM
    // critique, another full-template read, or guessing from error prose.
    const targets = { positive: 480, negative: 416 };
    for (const lane of ["positive", "negative"] as const) {
      const excess = target.pageCounts?.[lane].overBy ?? 0;
      if (excess > 0) targets[lane] = Math.max(1, Math.min(targets[lane], localCounts[lane] - excess - 32));
    }
    return { result: { ...common, status: "needs_revision", prompt: promptText(form), characterNames: form.characterNames,
      localCounts, ...(target.pageCounts ? { pageCounts: { positive: target.pageCounts.positive.used, negative: target.pageCounts.negative.used } } : {}),
      suggestedLocalTargets: targets,
      instruction: "原作者只精简这一张的完整 prompt，保留画面意图与角色归属；所有措辞可重述，优先缩短超限一侧并留余量。仅改四个文本字段，模型/参考图/角色结构/尺寸/张数/账本不变。保存后按回执 resume 原 Job，网页仍会实测。",
      nextAction: { name: "novelai-generation", action: "revise_prompt", input: nextInput } } };
  }
  let revised: NovelAiBrowserPromptForm;
  try { revised = validatePromptRevision({ version: 1, sourceHash: input.sourceHash, prompt: input.prompt }, form, sourceHash); }
  catch (error) { throw new WorkflowInputValidationError((error as Error).message, "prompt_revision_invalid"); }
  if (novelAiPromptContentKey({ ...request, browserForm: revised }) === novelAiPromptContentKey(request)) {
    throw new WorkflowInputValidationError("冻结 Prompt 原文不变，无须重复保存；不能用未改稿解除超限拦截。", "prompt_change_required");
  }
  const budget = await planPromptRevision(revised);
  const localCounts = { positive: budget.positive.estimatedTokens, negative: budget.negative.estimatedTokens };
  if (localCounts.positive > 512 || localCounts.negative > 512) return { result: { ...common,
    status: "needs_revision", saved: false, localCounts,
    nextAction: { name: "novelai-generation", action: "revise_prompt", input: nextInput } } };
  const { referencePromptAssembly: _assembly, referencePromptRefinement: _source, ...original } = request;
  return { request: { ...original, browserForm: revised, referencePromptBudget: budget,
    bundleId: createHash("sha256").update(JSON.stringify(["reference-page-revision-v1", sourceHash, revised])).digest("hex").slice(0, 20),
    referencePromptRevision: { sourceHash, applied: true, originalPreserved: true } },
    result: { ...common, status: "ready_for_page_check", localCounts } };
}
