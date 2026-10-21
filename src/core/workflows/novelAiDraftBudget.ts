import { createHash } from "node:crypto";
import type { ToolContext } from "../../types";
import { composeNovelAiPromptBundle, type NovelAiComposeInput, type NovelAiBrowserPromptForm, type NovelAiReferenceAssembly } from "../novelAiPromptComposer";
import { previewNovelAiReferenceCompilation } from "./novelAiGenerationUnit";
import type { DelegationTask } from "../delegationTaskStore";
import { hasWorkflowExecution } from "./workflowAliases";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export type NovelAiDraftBudgetReviewStatus = "needs_requirements_review" | "planning_unavailable" | "needs_revision" | "ready_for_page_check";
interface NovelAiDraftAssemblyDiagnostic {
  status: "full" | "compact" | "packed" | "required_over_budget";
  blockVersion: "full" | "compact";
  compactOmittedCount: number;
  optionalSelection: "not_needed" | "evaluated" | "blocked_by_required";
  originalPreserved: boolean;
  templateUsage?: { required: number; optional: number; pendingRequired: number };
  optionalCandidates: { authored: number; templates: number; compilerDefaults: number; total: number };
  includedCount: number;
  omittedCount: number;
  before: { positive: number; negative: number };
  core: { positive: number; negative: number };
  after: { positive: number; negative: number };
}
interface NovelAiDraftBudgetIssue {
  path: string | null;
  status: NovelAiDraftBudgetReviewStatus;
  automaticPromptRevisionAppropriate: boolean;
  planningDisposition?: "fit" | "revise_authored" | "page_check_required" | "constraints_conflict";
  estimatedTokens?: { positive: number; negative: number };
  compilerRequired?: { positive: number; negative: number };
  compiledLaneLimits?: { positive: number; negative: number };
  fixedWordingHeadroom?: { positive: number; negative: number };
  compiledRemaining?: { positive: number; negative: number };
  compiledOverBy?: { positive: number; negative: number };
  assemblyDiagnostic?: NovelAiDraftAssemblyDiagnostic;
}
export interface NovelAiDraftBudgetReview {
  source: "local-t5-planning-estimate";
  advisoryOnly: true;
  coverage: "reported_items_only";
  completeDraftCoverage: false;
  status: NovelAiDraftBudgetReviewStatus;
  draftValidated: false;
  pageVerified: false;
  generationAuthorized: false;
  automaticPromptRevisionAppropriate: boolean;
  compiledPlanningTargets: { positive: 480; negative: 416 };
  budgetMeaning: string;
  issues: NovelAiDraftBudgetIssue[];
  instruction: string;
}

const reviewPriority: Record<NovelAiDraftBudgetReviewStatus, number> = {
  ready_for_page_check: 0, needs_revision: 1, planning_unavailable: 2, needs_requirements_review: 3,
};
const reviewReasons: Record<NovelAiDraftBudgetReviewStatus, string> = {
  needs_requirements_review: "固定约束的本地估计已超限；反复缩写作者字段不适合解决此问题。保留原稿和明确要求，先交回确认需求，不擅自删约束或切换模型。",
  planning_unavailable: "规划报告缺失、不可用或结构无法确认；不能据此判断可提交，也不应盲目缩写 Prompt。先恢复可核验的诊断。",
  needs_revision: "当前作者继续处理本格，不先交回 Main：inspect_prompt 读取完整装配稿，revise_prompt 综合精简正負向各 Base＋全部角色至不超过 512。固定词和 required 标签不锁死原措辞，可以合并、去重和重述；保留画面意图，不机械截尾，不切模型或丢参考图。",
  ready_for_page_check: "当前规划不要求继续压缩；下一预算检查是网页精确计数。这不是完整稿件校验通过，也不是 Generate 或扣费授权。",
};

const nonnegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function planningLane(value: unknown, target: number, reserve: number): value is {
  estimatedTokens: number; reserveTokens: number; recommendedBudget: number; remainingTokens: number; overBy: number;
} {
  return object(value) && ["estimatedTokens", "reserveTokens", "recommendedBudget", "remainingTokens", "overBy"]
    .every(key => nonnegativeInteger(value[key])) && value.recommendedBudget === target && value.reserveTokens === reserve &&
    value.remainingTokens === Math.max(0, target - Number(value.estimatedTokens)) && value.overBy === Math.max(0, Number(value.estimatedTokens) - target);
}

/** Optional, bounded evidence only. Missing/legacy/malformed assembly metadata
 * must never change a valid budget decision or manufacture an empty selection.
 * Fragment ids and arbitrary source strings are intentionally not projected. */
function summarizeAssembly(value: unknown, estimated: { positive: number; negative: number },
  disposition: NonNullable<NovelAiDraftBudgetIssue["planningDisposition"]>): NovelAiDraftAssemblyDiagnostic | undefined {
  const count = (item: unknown): item is number => nonnegativeInteger(item) && item <= 4096;
  const pair = (item: unknown): item is { positive: number; negative: number } => object(item) &&
    nonnegativeInteger(item.positive) && item.positive <= 1_000_000 &&
    nonnegativeInteger(item.negative) && item.negative <= 1_000_000;
  const ids = (item: unknown): item is string[] => Array.isArray(item) && item.length <= 4096 &&
    Array.from(item).every(id => typeof id === "string" && id.length > 0 && id.length <= 1024);
  if (!object(value) || value.policy !== "reference-512-v1" || value.pageVerificationRequired !== true ||
    !pair(value.before) || !pair(value.mandatory) || !pair(value.after) ||
    !ids(value.included) || !ids(value.omitted) || !object(value.selection)) return;
  // The fixed-block version is program metadata, never an author field.
  if (value.blockVersion !== "full" && value.blockVersion !== "compact") return;
  if (!ids(value.compactOmitted)) return;
  const selection = value.selection;
  const candidates = selection.optionalCandidates;
  if (typeof selection.originalPreserved !== "boolean" || !object(candidates) ||
    !count(candidates.authored) || !count(candidates.templates) || !count(candidates.compilerDefaults) || !count(candidates.total) ||
    candidates.authored + candidates.templates + candidates.compilerDefaults !== candidates.total ||
    value.after.positive !== estimated.positive || value.after.negative !== estimated.negative) return;
  const usage = selection.templateUsage;
  if (usage !== undefined && (!object(usage) || !count(usage.required) || !count(usage.optional) ||
    !count(usage.pendingRequired) || usage.pendingRequired > usage.required || usage.optional !== candidates.templates)) return;
  const status = value.status;
  const optionalSelection = selection.optionalSelection;
  const ready = disposition === "fit" || disposition === "page_check_required";
  if (status === "full") {
    if (value.blockVersion !== "full" || !ready || optionalSelection !== "not_needed" || !selection.originalPreserved ||
      value.omitted.length !== 0 || value.included.length !== candidates.total) return;
  } else if (status === "compact") {
    // The Compact version deliberately differs from the Full form, so before/after
    // differ by design; nothing was dropped on top of the recorded mapping.
    if (value.blockVersion !== "compact" || !ready || optionalSelection !== "evaluated" || selection.originalPreserved ||
      value.omitted.length !== 0 || value.included.length !== candidates.total) return;
  } else if (status === "packed") {
    if (!ready || optionalSelection !== "evaluated" || selection.originalPreserved ||
      value.included.length + value.omitted.length !== candidates.total) return;
  } else if (status === "required_over_budget") {
    if (ready || optionalSelection !== "blocked_by_required" || !selection.originalPreserved ||
      value.included.length !== 0 || value.omitted.length !== 0) return;
  } else return;
  if (status !== "packed" && status !== "compact" &&
    (value.before.positive !== value.after.positive || value.before.negative !== value.after.negative)) return;
  const copyPair = (item: { positive: number; negative: number }) => ({ positive: item.positive, negative: item.negative });
  return { status, blockVersion: value.blockVersion, compactOmittedCount: value.compactOmitted.length,
    optionalSelection, originalPreserved: selection.originalPreserved,
    ...(object(usage) ? { templateUsage: { required: Number(usage.required), optional: Number(usage.optional),
      pendingRequired: Number(usage.pendingRequired) } } : {}),
    optionalCandidates: { authored: candidates.authored, templates: candidates.templates,
      compilerDefaults: candidates.compilerDefaults, total: candidates.total },
    includedCount: value.included.length, omittedCount: value.omitted.length,
    before: copyPair(value.before), core: copyPair(value.mandatory), after: copyPair(value.after) };
}

/** A numeric-only advisory projection, not a validator, retry policy, or gate.
 * Saving is still saving; no report can promote a partial draft to executable. */
export function summarizeNovelAiDraftBudgets(reports: unknown): NovelAiDraftBudgetReview | undefined {
  if (Array.isArray(reports) && reports.length === 0) return;
  const rows = Array.isArray(reports) && reports.length <= 24 ? Array.from(reports) : [undefined];
  const issues = rows.map((row): NovelAiDraftBudgetIssue => {
    const report = object(row) ? row : undefined;
    const reportPath = typeof report?.path === "string" && /^\/(?:set\/items\/(?:[0-9]|1[01])|job\/panels\/(?:[0-9]|1[0-9]|2[0-3]))\/generation$/.test(report.path) ? report.path : null;
    const unavailable = (): NovelAiDraftBudgetIssue => ({ path: reportPath, status: "planning_unavailable",
      automaticPromptRevisionAppropriate: false });
    if (!report || !reportPath || report.status !== undefined || report.source !== "local-t5-planning-estimate" ||
      report.limit !== 512 || report.requiresPageVerification !== true || typeof report.fitsPlanningBudget !== "boolean" ||
      !planningLane(report.positive, 480, 32) || !planningLane(report.negative, 416, 96) ||
      !object(report.compilerRequired) || !nonnegativeInteger(report.compilerRequired.positive) || !nonnegativeInteger(report.compilerRequired.negative)) return unavailable();
    const disposition = report.planningDisposition;
    if (disposition !== "fit" && disposition !== "revise_authored" && disposition !== "page_check_required" && disposition !== "constraints_conflict") return unavailable();
    const fixedConflict = report.compilerRequired.positive > 512 || report.compilerRequired.negative > 512;
    const fits = report.positive.overBy === 0 && report.negative.overBy === 0;
    // Mirror the existing planner's lane limits, including its fixed-overhead
    // page-check exception. These are diagnostics, never replacement gates.
    const rewritten = report.wholePromptRevision === "applied";
    const compiledLaneLimits = { positive: rewritten || report.compilerRequired.positive > 480 ? 512 : 480,
      negative: rewritten || report.compilerRequired.negative > 416 ? 512 : 416 };
    const expectedDisposition = fixedConflict ? "constraints_conflict" : fits ? "fit"
      : report.positive.estimatedTokens <= compiledLaneLimits.positive && report.negative.estimatedTokens <= compiledLaneLimits.negative
        ? "page_check_required" : "revise_authored";
    if (report.fitsPlanningBudget !== fits || disposition !== expectedDisposition) return unavailable();
    const status: NovelAiDraftBudgetReviewStatus = disposition === "constraints_conflict" ? report.wholePromptRevision === "available" ? "needs_revision" : "needs_requirements_review"
      : disposition === "revise_authored" ? "needs_revision" : "ready_for_page_check";
    const assemblyDiagnostic = summarizeAssembly(report.referencePromptAssembly,
      { positive: report.positive.estimatedTokens, negative: report.negative.estimatedTokens }, disposition);
    return { path: reportPath, status, automaticPromptRevisionAppropriate: status === "needs_revision", planningDisposition: disposition,
      estimatedTokens: { positive: report.positive.estimatedTokens, negative: report.negative.estimatedTokens },
      compilerRequired: { positive: report.compilerRequired.positive, negative: report.compilerRequired.negative }, compiledLaneLimits,
      fixedWordingHeadroom: { positive: Math.max(0, compiledLaneLimits.positive - report.compilerRequired.positive),
        negative: Math.max(0, compiledLaneLimits.negative - report.compilerRequired.negative) },
      compiledRemaining: { positive: Math.max(0, compiledLaneLimits.positive - report.positive.estimatedTokens),
        negative: Math.max(0, compiledLaneLimits.negative - report.negative.estimatedTokens) },
      compiledOverBy: { positive: Math.max(0, report.positive.estimatedTokens - compiledLaneLimits.positive),
        negative: Math.max(0, report.negative.estimatedTokens - compiledLaneLimits.negative) },
      ...(assemblyDiagnostic ? { assemblyDiagnostic } : {}) };
  });
  const status = issues.reduce<NovelAiDraftBudgetReviewStatus>((current, issue) =>
    reviewPriority[issue.status] > reviewPriority[current] ? issue.status : current, "ready_for_page_check");
  return { source: "local-t5-planning-estimate", advisoryOnly: true, coverage: "reported_items_only", completeDraftCoverage: false, status,
    draftValidated: false, pageVerified: false, generationAuthorized: false,
    automaticPromptRevisionAppropriate: status === "needs_revision", compiledPlanningTargets: { positive: 480, negative: 416 },
    budgetMeaning: "仅实际 reference/V4.5 使用 compact 和整稿精简，V5 不变。480/416 是含固定词的编译后总量目标，不是作者可自由使用的余额；整稿重述后两向本地上限均为 512，仍需网页精确计数。compilerRequired 是当前固定措辞子集，不是语义最小表达；required/optional 是第一遍装配保留策略，不保证短模板，也不禁止作者整体換短表达。templateUsage 不含编译器固定块，pendingRequired 是 required 子集。before/core/after 是原稿/必要核/返回稿估计；blocked_by_required 表示尚未筛选可选项且保留原稿，不表示没有可选项或不可精简。诊断缺失表示未知；fixedWordingHeadroom、compiledRemaining/compiledOverBy 是计数余量，各片段增量不可独立相加，不保证语义无损。",
    issues, instruction: `saved 仅表示保存成功；摘要只覆盖已返回诊断的画面，未完整填写或无法编译的画面可能未列入，不代表整稿校验通过。${reviewReasons[status]} 仅提示，不更改校验、权限或执行行为。` };
}

/** An editable, pre-execution author step, NOT a Main handoff or a saved Job. */
export function novelAiPromptRevisionDecision(reports: unknown, draftRevision: number): Record<string, unknown> | undefined {
  const review = summarizeNovelAiDraftBudgets(reports);
  if (!review || review.status === "ready_for_page_check") return;
  const issue = review.issues.find(item => item.status !== "ready_for_page_check");
  return { status: review.status === "planning_unavailable" ? "planning_unavailable" : "needs_revision",
    terminal: false, executionStarted: false, retrySafety: "safe", draftRevision,
    reasonCode: "reference_prompt_revision_required", referenceBudgetReview: review,
    reason: "当前作者 inspect_prompt 阅读目标整稿，再 revise_prompt 精简；不启动新 Agent、不重开 Job，字段错误按回执修正。",
    nextAction: { name: "novelai-generation", action: "inspect_prompt", input: { path: issue?.path, draftRevision } } };
}

const SAVE_REPORT_DIGESTS = "novelai:save-reference-report-digests";
/** Formats freshly recomputed save diagnostics only. The run-local digest
 * suppresses identical verbose receipts; it never caches compilation or gates. */
export function novelAiDraftBudgetSaveFeedback(reports: unknown, taskKey: string,
  runState?: Map<string, unknown>): Record<string, unknown> {
  const stored = runState?.get(SAVE_REPORT_DIGESTS);
  const referenceBudgetReview = summarizeNovelAiDraftBudgets(reports);
  if (!referenceBudgetReview) {
    if (stored instanceof Map) stored.delete(taskKey);
    return {};
  }
  const digest = createHash("sha256").update(JSON.stringify(reports) ?? "undefined").digest("hex");
  const digests: Map<string, string> = stored instanceof Map ? stored : new Map();
  const unchanged = digests.get(taskKey) === digest;
  if (runState) {
    digests.delete(taskKey);
    digests.set(taskKey, digest);
    while (digests.size > 32) digests.delete(digests.keys().next().value!);
    runState.set(SAVE_REPORT_DIGESTS, digests);
  }
  return { referenceBudgetReview, ...(unchanged ? {
    referencePromptBudgetDetails: { status: "unchanged_omitted", freshlyRecomputed: true,
      instruction: "本次已重新计算，仅省略与上次保存相同的详情，不是缓存校验或提交授权。需要完整当前诊断时，调用 run_workflow action:inspect_draft input:{}；根稿件检查始终重新计算并返回完整报告。" },
  } : { referencePromptBudgets: reports }) };
}

/** Exact saved input plus accepted task amendments, never a token-count identity.
 * The digest contains no prompt text and does not authorize any generation. */
export function novelAiRequirementsReviewIdentity(inputRef: string, followups: readonly string[] = []): {
  fingerprint: string; followupBoundary: string;
} {
  const followupBoundary = createHash("sha256").update(JSON.stringify(followups)).digest("hex");
  return { followupBoundary,
    fingerprint: createHash("sha256").update(JSON.stringify(["novelai-requirements-review-v1", inputRef, followupBoundary])).digest("hex") };
}

/** Read-only, exact-boundary lookup shared by author retries and Main status.
 * An older decision never hides a newer draft, amendment or execution receipt. */
export function currentNovelAiRequirementsDecision(task: Pick<DelegationTask, "ref" | "draftHeads" | "followups" | "workflowResults">,
  workflow: string): Record<string, unknown> | undefined {
  const head = task.draftHeads?.[workflow];
  if (!head || task.workflowResults.some(entry => hasWorkflowExecution(entry.result))) return;
  const prior = task.workflowResults.find(entry => entry.workflow === workflow)?.result;
  const identity = novelAiRequirementsReviewIdentity(head.inputRef, task.followups);
  if (prior?.status !== "needs_input" || prior.reasonCode !== "requirements_review_required" || prior.executionStarted !== false ||
    prior.retrySafety !== "safe" || prior.terminal !== true || prior.jobId || !object(prior.requirementsReview) ||
    prior.requirementsReview.fingerprint !== identity.fingerprint) return;
  return { ...structuredClone(prior), taskRef: task.ref, inputRef: head.inputRef, draftRevision: head.revision };
}

/** Legacy receipt constructor retained for old-state compatibility tests.
 * New author submissions use novelAiPromptRevisionDecision, not a Main handoff. */
export function novelAiRequirementsDecision(reports: unknown, input: {
  taskRef: string; inputRef: string; draftRevision: number; followups?: readonly string[];
}): Record<string, unknown> | undefined {
  const review = summarizeNovelAiDraftBudgets(reports);
  if (review?.status !== "needs_requirements_review") return;
  const diagnostic = review.issues.filter(issue => issue.status === "needs_requirements_review").map(issue => {
    const pair = (value: { positive: number; negative: number }) => `${value.positive}/${value.negative}`;
    const assembly = issue.assemblyDiagnostic;
    const stages = assembly ? `原稿 ${pair(assembly.before)}、必要核 ${pair(assembly.core)}、返回稿 ${pair(assembly.after)}`
      : `返回稿 ${pair(issue.estimatedTokens!)}`;
    const selection = assembly?.optionalSelection === "blocked_by_required" ? "；可选项尚未筛选，原稿保留" : "";
    return `第 ${Number(issue.path!.split("/")[3]) + 1} 项本地估计（正/负）：${stages}；固定措辞子集 ${pair(issue.compilerRequired!)}${selection}。`;
  }).join(" ");
  return { status: "needs_input", terminal: true, executionStarted: false, retrySafety: "safe",
    reasonCode: "requirements_review_required", nextAction: "return_to_main",
    taskRef: input.taskRef, inputRef: input.inputRef, draftRevision: input.draftRevision,
    requirementsReview: novelAiRequirementsReviewIdentity(input.inputRef, input.followups),
    referenceBudgetReview: review,
    reason: `已保存稿件的固定措辞子集本地估计超过参考模型容量；本次未进入执行器、未启动 Browser/Generate。${diagnostic} 固定措辞子集不是整稿或语义最小表达，required/optional 是保留策略，不保证短模板或必定合限。这不是网页实测超限。请交回 Main 确认需求，不继续反复缩写或提交相同稿件；原稿可继续保存，调整后的稿件或新补充会重新核对。` };
}

/** Advisory feedback while saving a partial image-set draft; never executes or edits it. */
export async function inspectNovelAiDraftBudgets(plan: unknown, ctx: Pick<ToolContext, "attachments">): Promise<Record<string, unknown>[]> {
  if (!object(plan)) return [];
  const image = object(plan.set) && Array.isArray(plan.set.items);
  const container = image ? plan.set : plan.job;
  const rows = object(container) ? container[image ? "items" : "panels"] : undefined;
  if (!Array.isArray(rows)) return [];
  const reports: Record<string, unknown>[] = [];
  for (const [index, item] of rows.slice(0, image ? 12 : 24).entries()) {
    const reportPath = `/${image ? "set/items" : "job/panels"}/${index}/generation`;
    if (!object(item) || !object(item.generation)) continue;
    const generation = item.generation;
    if (generation.reference === "none" || !Array.isArray(generation.characters) ||
      !["interaction", "setting", "camera", "lighting"].every(key => typeof generation[key] === "string")) continue;
    // Drafts can be intentionally incomplete. Only valid compiled compositions
    // get budget feedback; ordinary field validation still happens at submission.
    let bundle;
    let requiredForm: NovelAiBrowserPromptForm | undefined;
    let assembly: NovelAiReferenceAssembly | undefined;
    try { bundle = await composeNovelAiPromptBundle(generation as unknown as NovelAiComposeInput, {
      onRequiredForm(form) { requiredForm = form; }, onReferenceAssembly(value) { assembly = value; } }); }
    catch { continue; }
    try {
      const preview = await previewNovelAiReferenceCompilation(generation as unknown as NovelAiComposeInput, bundle, ctx, requiredForm, assembly);
      if (preview?.referencePromptBudget) reports.push({ path: reportPath,
        ...(preview.referencePromptBudget as Record<string, unknown>),
        // Keep the same assembly evidence as preview/execution, especially a
        // required-core conflict. A saved draft is not a successful validation.
        ...(preview.referencePromptAssembly
          ? { referencePromptAssembly: preview.referencePromptAssembly } : {}) });
    } catch (error) {
      reports.push({ path: reportPath, status: "planning_unavailable",
        reason: error instanceof Error ? error.message : String(error), requiresPageVerification: true });
    }
  }
  return reports;
}
