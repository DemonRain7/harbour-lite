import { createHash } from "node:crypto";
import path from "node:path";
import type { NovelAiSubmissionLimit, ToolContext } from "../../types";
import { composeNovelAiPromptBundle, type NovelAiComposeInput, type NovelAiPromptBundle, type NovelAiBrowserPromptForm, type NovelAiReferenceAssembly } from "../novelAiPromptComposer";
import { assertNovelAiCharacterTagPreserved } from "../novelAiCharacterTag";
import type { NovelAiReferenceBudgetPlan } from "../novelAiReferenceBudget";
import type { BrowserControllerResult } from "../tools/spawnSubagent";
import { runNovelAiBrowserTask, type NovelAiBrowserRunner } from "./novelAiBrowserExecution";
import type { NovelAiAccountReservations } from "./novelAiAccountReservations";
import { WorkflowInputValidationError } from "./registry";
import { frozenNovelAiAttachment, frozenNovelAiRequiredReferences } from "../novelAiReferences";
import { selectNovelAiGenerationModel, supportsNovelAiPreciseReferences } from "../novelAiModelCapabilities";
import { sfwSampling, type NovelAiSamplingContext } from "./novelAiSfwSampling";

export function novelAiGenerationDimensions(request: Record<string, unknown>): { width: number; height: number } {
  const form = request.browserForm as Record<string, unknown>;
  if (Number.isInteger(form.width) && Number.isInteger(form.height)) return { width: Number(form.width), height: Number(form.height) };
  if (form.orientation === "landscape") return { width: 1216, height: 832 };
  if (form.orientation === "square") return { width: 1024, height: 1024 };
  return { width: 832, height: 1216 };
}

/** A size-only edit preserves every prompt, character/reference and content field. */
export function resizeFrozenNovelAiGeneration(request: Record<string, unknown>, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkflowInputValidationError("resolution 需要 width/height，可选 category");
  const size = value as Record<string, unknown>;
  const category = size.category ?? "Custom";
  if (Object.keys(size).some(key => !["category", "width", "height"].includes(key)) ||
    !["Normal", "Large", "Wallpaper", "Small", "Custom"].includes(String(category)) ||
    ![size.width, size.height].every(n => Number.isInteger(n) && Number(n) >= 64 && Number(n) <= 4096 && Number(n) % 64 === 0)) {
    throw new WorkflowInputValidationError("resolution width/height 须同时提供，范围 64–4096 且是 64 的倍数，category 为 Normal/Large/Wallpaper/Small/Custom");
  }
  if (!request.browserForm || typeof request.browserForm !== "object") throw new WorkflowInputValidationError("旧画面缺少冻结表单，不能猜测重建");
  const form = { ...request.browserForm, width: Number(size.width), height: Number(size.height),
    orientation: size.width === size.height ? "square" : Number(size.width) > Number(size.height) ? "landscape" : "portrait" };
  const updated = { ...request, resolution: category, browserForm: form };
  return { ...updated, bundleId: createHash("sha256").update(JSON.stringify(updated)).digest("hex").slice(0, 20) };
}

/** One compiler/form contract for single images, image sets and comic panels. */
export async function compileNovelAiGeneration(input: NovelAiComposeInput, count = 1, ctx?: NovelAiSamplingContext, referenceSelectionKey?: string): Promise<Record<string, unknown>> {
  return compileGenerationInput(input, count, ctx, referenceSelectionKey, false);
}

/** Saving/inspecting can retain over-budget text without authorizing execution. */
export async function inspectNovelAiGeneration(input: NovelAiComposeInput, count = 1, ctx?: NovelAiSamplingContext): Promise<Record<string, unknown>> {
  return compileGenerationInput(input, count, ctx, undefined, true);
}

async function compileGenerationInput(input: NovelAiComposeInput, count: number, ctx: NovelAiSamplingContext | undefined,
  referenceSelectionKey: string | undefined, previewOnly: boolean): Promise<Record<string, unknown>> {
  let requiredForm: NovelAiBrowserPromptForm | undefined;
  let assembly: NovelAiReferenceAssembly | undefined;
  const bundle = await composeNovelAiPromptBundle({ ...input, numberOfImages: count }, { referenceSelectionKey,
    ...(input.reference !== "none" ? { onRequiredForm(form: NovelAiBrowserPromptForm) { requiredForm = form; },
      onReferenceAssembly(value: NovelAiReferenceAssembly) { assembly = value; } } : {}) });
  const compiled = await compileBundle(input, bundle, ctx, previewOnly, requiredForm, assembly);
  const sampling = sfwSampling(input, ctx);
  if (!sampling) return compiled;
  if (compiled.model !== "NAI Diffusion V5 Full") throw new WorkflowInputValidationError("SFW sampling 试用仅支持 V5 Full 无参考图路径。", "sfw_sampling_model");
  return { ...compiled, bundleId: createHash("sha256").update(JSON.stringify({original:compiled.bundleId,sampling})).digest("hex").slice(0,20),
    browserForm: { ...compiled.browserForm as object, ...sampling, sfwSampling:sampling } };
}

/** Read-only author preview uses the very same reference resolution as execution. */
export async function previewNovelAiReferenceBudget(input: NovelAiComposeInput, bundle: NovelAiPromptBundle,
  ctx?: Pick<ToolContext, "attachments">, requiredForm?: NovelAiBrowserPromptForm,
  assembly?: NovelAiReferenceAssembly): Promise<NovelAiReferenceBudgetPlan | undefined> {
  return (await previewNovelAiReferenceCompilation(input, bundle, ctx, requiredForm, assembly))?.referencePromptBudget as NovelAiReferenceBudgetPlan | undefined;
}

/** Same selected form/report as execution, without submission authorization. */
export async function previewNovelAiReferenceCompilation(input: NovelAiComposeInput, bundle: NovelAiPromptBundle,
  ctx?: Pick<ToolContext, "attachments">, requiredForm?: NovelAiBrowserPromptForm, assembly?: NovelAiReferenceAssembly): Promise<Record<string, unknown> | undefined> {
  if (input.reference === "none") return undefined;
  if ((input.reference === undefined || input.reference === "auto") &&
    !frozenNovelAiRequiredReferences({ reference: "auto", characterRoutes: bundle.characterRoutes }).length) return undefined;
  return compileBundle(input, bundle, ctx, true, requiredForm, assembly);
}

async function compileBundle(input: NovelAiComposeInput, bundle: NovelAiPromptBundle,
  ctx: Pick<ToolContext, "attachments"> | undefined, previewOnly: boolean, requiredForm?: NovelAiBrowserPromptForm,
  assembly?: NovelAiReferenceAssembly): Promise<Record<string, unknown>> {
  const reference = input.reference ?? "auto";
  if (reference !== "auto" && reference !== "none" && (!reference || typeof reference !== "object" ||
    !Number.isInteger(reference.attachmentIndex) || reference.attachmentIndex < 0)) throw new Error("reference 必须为 auto/none 或本轮图片 attachmentIndex");
  let referenceAttachmentHash: string | undefined;
  if (typeof reference === "object") {
    const selected = ctx?.attachments?.filter(item => item.kind === "image")[reference.attachmentIndex];
    if (!selected) throw new Error("本轮指定参考图不存在");
    referenceAttachmentHash = selected.image?.sha256;
    if (!referenceAttachmentHash || !/^[a-f0-9]{64}$/.test(referenceAttachmentHash)) throw new Error("本轮参考图缺少已验签的内容哈希，不能冻结仅有索引的附件");
  }
  const resolution = input.resolution;
  if (resolution && !["Normal", "Large", "Wallpaper", "Small", "Custom"].includes(resolution.category)) throw new Error("resolution.category 无效");
  const size = resolution && (resolution.width !== undefined || resolution.height !== undefined);
  if (size && ![resolution.width, resolution.height].every(value => Number.isInteger(value) && value! >= 64 && value! <= 4096 && value! % 64 === 0)) throw new Error("resolution width/height 须同时提供，范围 64–4096 且是 64 的倍数");
  if (resolution && resolution.category !== "Normal" && !size) throw new Error("非 Normal 尺寸须明确目标 width/height，不能回收后猜测原图尺寸");
  const dimensions = size ? { width: resolution!.width!, height: resolution!.height! }
    : novelAiGenerationDimensions({ browserForm: bundle.browserForm });
  const form = { ...bundle.browserForm, ...dimensions };
  const characterRoutes = reference === "auto" ? bundle.characterRoutes
    : bundle.characterRoutes.map(({ reference: _reference, ...route }) => ({ ...route, referencePolicy: "none" as const }));
  const request = { reference, ...(referenceAttachmentHash ? { referenceAttachmentHash } : {}), mode: "Anime", resolution: resolution?.category ?? "Normal",
    browserForm: form, characterRoutes, acceptance: bundle.acceptance };
  // Resolve overrides and validate actual available references before selecting
  // the model. Declared policies or unselected attachments are not reference use.
  const requiredReferences = frozenNovelAiRequiredReferences(request);
  const model = selectNovelAiGenerationModel(requiredReferences);
  // The composer identifies the composition; this execution identity also binds
  // its model, dimensions and exact reference bytes. Old saved IDs are untouched.
  const bundleId = createHash("sha256").update(JSON.stringify({ original: bundle.bundleId,
    reference, resolution, model, requiredReferences })).digest("hex").slice(0, 20);
  const compiled = { bundleId, ...request, model };
  // Deliberately return the original V5 object before loading any planning code.
  // No prompt rewriting, smaller limits, extra metadata or hash change on V5.
  if (!requiredReferences.length || !supportsNovelAiPreciseReferences(model)) return compiled;
  const { NovelAiReferenceBudgetExceededError } = await import("../novelAiReferenceBudget");
  const { assembleNovelAiReferencePrompt, completeNovelAiReferencePrompt } = await import("../novelAiReferenceAssembly");
  const { promptRevisionSourceHash, validatePromptRevision, planPromptRevision, promptText, REFERENCE_PROMPT_INSTRUCTION } = await import("../novelAiPromptRefinement");
  const selected = await assembleNovelAiReferencePrompt(bundle.browserForm, requiredForm, assembly);
  const compactSource = completeNovelAiReferencePrompt(bundle.browserForm, assembly);
  const sourceHash = promptRevisionSourceHash(input, bundle.browserForm, compactSource, model);
  let selectedPrompt = selected.form;
  let referencePromptBudget: NovelAiReferenceBudgetPlan = { ...selected.budget, wholePromptRevision: "available" };
  if (input.referencePromptRevision !== undefined) {
    try { selectedPrompt = validatePromptRevision(input.referencePromptRevision, compactSource, sourceHash); }
    catch (error) { throw new WorkflowInputValidationError(String((error as Error).message), "novelai_reference_revision_stale_or_invalid"); }
    referencePromptBudget = await planPromptRevision(selectedPrompt);
  }
  const sourceForAuthor = previewOnly ? { referencePromptRefinement: { sourceHash, instruction: REFERENCE_PROMPT_INSTRUCTION,
    characterNames: [...compactSource.characterNames], original: promptText(compactSource),
    ...(input.referencePromptRevision ? { current: promptText(selectedPrompt) } : {}),
    // Full source retained separately for auditing; the input intent is supplied
    // by the bound draft inspector, not injected into final browser requests.
    // These belong to the selected candidate, not the complete source above.
    // inspect_prompt counts its source independently before returning it.
    selectedLocalCounts: { positive: referencePromptBudget.positive.estimatedTokens, negative: referencePromptBudget.negative.estimatedTokens },
    pageVerificationRequired: true } } : {};
  if (!previewOnly && referencePromptBudget.planningDisposition === "constraints_conflict") {
    const fixed = selected.assembly?.status === "required_over_budget"
      ? selected.assembly.mandatory : referencePromptBudget.compilerRequired!;
    throw new WorkflowInputValidationError(`参考图 V4.5 固定措辞子集估计正向 ${fixed.positive}、负向 ${fixed.negative}；这不是语义最小长度。尚未启动 Browser/Generate。请当前作者 inspect_prompt 后 revise_prompt，整体重述装配后的正负向文本至各不超过 512；required 标签不禁止精简其措辞，不要只缩写作者字段或原样重交。`, "novelai_reference_constraints_conflict",
      [], undefined, { referencePromptBudget, referencePromptAssembly: selected.assembly });
  }
  if (!previewOnly && !referencePromptBudget.fitsPlanningBudget && referencePromptBudget.planningDisposition !== "page_check_required") {
    const error = new NovelAiReferenceBudgetExceededError(referencePromptBudget);
    throw new WorkflowInputValidationError(error.message, error.code, [], undefined, { referencePromptBudget: error.report,
      referencePromptAssembly: selected.assembly });
  }
  const selectedForm = { ...selectedPrompt, ...dimensions };
  // An author may shorten reference prompts, but a newly declared identity must
  // survive in its own card. This is syntax validation, not visual acceptance.
  for (const [index, route] of bundle.characterRoutes.entries()) {
    if (route.identityTag) assertNovelAiCharacterTagPreserved(route.identityTag,
      selectedForm.characterPrompts[index]!, `characterPrompts[${index}]`);
  }
  // Compact changes the submitted form even when every remaining optional block
  // fits. Bind the ID to those exact bytes, as we already do for budget packing.
  const selectedId = input.referencePromptRevision || selected.assembly?.status === "packed" || selected.assembly?.blockVersion === "compact"
    ? createHash("sha256").update(JSON.stringify({ original: bundleId, policy: input.referencePromptRevision ? "reference-author-revision-v1" : selected.assembly!.policy, form: selectedForm })).digest("hex").slice(0, 20)
    : bundleId;
  return { ...compiled, bundleId: selectedId, browserForm: selectedForm, referencePromptBudget,
    // Pre-revision assembly remains an audit source, not a claim about the final text.
    ...(selected.assembly && !input.referencePromptRevision ? { referencePromptAssembly: selected.assembly } : {}),
    ...(input.referencePromptRevision ? { referencePromptRevision: { sourceHash, applied: true, originalPreserved: true } } : {}),
    ...sourceForAuthor };
}

export interface NovelAiRenderedReceipt {
  rawArtifacts: string[];
  visibleCostAnlas: number;
  uncertainReservedAnlas: number;
  chargeState: BrowserControllerResult["chargeState"];
}

export interface NovelAiUnitFailure<T extends { url: string } = { url: string }> {
  status: "blocked";
  stage: string;
  reason: string;
  retrySafety: "safe" | "uncertain";
  receipt?: NovelAiRenderedReceipt;
  /** Receipt has already been committed; callers must not book the cost twice. */
  rendered: boolean;
  partialArtifacts?: T[];
  promptBudgetOverflow?: import("../novelAiPromptBudget").NovelAiPromptBudgetOverflowReport;
}

export interface NovelAiGenerationUnit<T extends { url: string }> {
  task: string;
  request?: Record<string, unknown>;
  submission: NovelAiSubmissionLimit;
  expectedCostAnlas: number;
  rendered?: NovelAiRenderedReceipt;
  runBrowser?: NovelAiBrowserRunner;
  accountReservations?: NovelAiAccountReservations;
  beforeBrowser?(): Promise<void>;
  saveRendered(receipt: NovelAiRenderedReceipt): Promise<void>;
  importArtifacts(paths: string[]): Promise<{ artifacts: T[]; error?: string }>;
}

/** Single Generate -> persist receipt -> import. Domain loops only select a unit and store its result. */
export async function runNovelAiGenerationUnit<T extends { url: string }>(
  unit: NovelAiGenerationUnit<T>, ctx: ToolContext,
): Promise<NovelAiUnitFailure<T> | { status: "completed"; artifacts: T[]; receipt: NovelAiRenderedReceipt }> {
  let receipt = unit.rendered;
  const count = unit.submission.numberOfImages;
  if (!receipt) {
    if (ctx.signal?.aborted) return { status: "blocked", stage: "cancelled-before-browser",
      reason: "Browser 启动前运行已取消，未提交 Generate。", retrySafety: "safe", rendered: false };
    if (unit.expectedCostAnlas * count > unit.submission.maxCostAnlas) return {
      status: "blocked", stage: "budget-preflight", reason: "总预算不足，已在付费操作前停住。", retrySafety: "safe", rendered: false,
    };
    let submission: NovelAiSubmissionLimit;
    try {
      if (unit.request) frozenNovelAiAttachment(unit.request, ctx.attachments);
      submission = unit.request ? { ...unit.submission,
        ...(typeof unit.request.model === "string" && unit.request.model.trim() ? { expectedModel: unit.request.model } : {}),
        requiredReferences: frozenNovelAiRequiredReferences(unit.request),
        form: { ...(unit.request.browserForm as Record<string, unknown>), ...novelAiGenerationDimensions(unit.request) } } : unit.submission;
    } catch (error) {
      return { status: "blocked", stage: "reference-preflight", reason: String(error), retrySafety: "safe", rendered: false,
        receipt: { rawArtifacts: [], visibleCostAnlas: 0, uncertainReservedAnlas: 0, chargeState: "not_charged" } };
    }
    // A missing legacy model is checked from the actual page by the Browser gate.
    // Never silently switch a frozen model, drop its references, or reserve funds
    // for a model/reference combination that cannot be submitted on NovelAI.
    if (submission.requiredReferences?.length && submission.expectedModel && !supportsNovelAiPreciseReferences(submission.expectedModel)) {
      return { status: "blocked", stage: "unsupported-model-reference",
        reason: `冻结模型 ${submission.expectedModel} 不支持当前角色精确参考图契约；NovelAI 目前仅在 V4.5 提供 Precise Reference。未启动 Browser、未上传、未提交 Generate。请先明确修订为支持的模型并重新核对报价，不能重试上传或静默修改原 Job。`,
        retrySafety: "safe", rendered: false,
        receipt: { rawArtifacts: [], visibleCostAnlas: 0, uncertainReservedAnlas: 0, chargeState: "not_charged" } };
    }
    if (unit.accountReservations) {
      try {
        const otherReservedAnlas = await unit.accountReservations.reserve(submission.onceKey, submission.maxCostAnlas);
        submission = { ...submission, otherReservedAnlas };
      } catch (error) {
        return { status: "blocked", stage: "account-reservation", reason: String(error), retrySafety: "uncertain", rendered: false };
      }
    }
    try { await unit.beforeBrowser?.(); }
    catch (error) {
      await unit.accountReservations?.settle(submission.onceKey, "not_charged");
      throw error;
    }
    let browser: BrowserControllerResult;
    try {
      browser = await (unit.runBrowser ?? runNovelAiBrowserTask)(unit.task, ctx, submission);
    } catch (error) {
      return { status: "blocked", stage: "browser-transport",
        reason: `Browser 链路中断，提交状态未知，未自动重试。${error instanceof Error ? error.message : String(error)}`,
        retrySafety: "uncertain", rendered: false,
        receipt: { rawArtifacts: [], visibleCostAnlas: 0, uncertainReservedAnlas: unit.submission.maxCostAnlas, chargeState: "unknown" } };
    }
    const knownCost = typeof browser.costAnlas === "number" && Number.isFinite(browser.costAnlas) && browser.costAnlas >= 0;
    receipt = { rawArtifacts: browser.artifacts ?? [], chargeState: browser.chargeState,
      visibleCostAnlas: browser.chargeState === "not_charged" ? 0 : knownCost ? browser.costAnlas! : 0,
      uncertainReservedAnlas: browser.chargeState === "not_charged" || knownCost ? 0 : unit.submission.maxCostAnlas };
    const distinct = new Set(receipt.rawArtifacts.map(file => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file)));
    if (browser.status !== "completed" || !browser.artifactVerified || receipt.rawArtifacts.length !== count || distinct.size !== count) {
      // Do not release a potentially paid reservation before the domain has stored
      // its cost/uncertainty. The caller settles after its blocked receipt is saved.
      return { status: "blocked", stage: browser.promptBudgetOverflow && browser.chargeState === "not_charged"
          ? "prompt-budget" : browser.status === "needs_input" ? "browser-needs-input"
            : browser.executionStage?.state === "not_submitted" && browser.chargeState === "not_charged"
              ? "browser-preparation" : "browser-result",
        reason: distinct.size !== receipt.rawArtifacts.length ? "Browser 把同一个文件重复计为多张成品。"
          : browser.status === "completed" && browser.artifactVerified ? `应回收 ${count} 张目标原图，实际 ${receipt.rawArtifacts.length} 张。`
            : browser.reason ?? (browser.status === "unknown"
              ? "Browser Controller 未返回可识别的执行状态；提交、扣费与原图状态尚未确认。"
              : `Browser Controller 返回 ${browser.status}，但未说明具体原因；尚无可验签原图。`),
        retrySafety: browser.chargeState === "not_charged" ? "safe" : "uncertain", receipt, rendered: false,
        ...(browser.promptBudgetOverflow && browser.chargeState === "not_charged"
          ? { promptBudgetOverflow: browser.promptBudgetOverflow } : {}) };
    }
    // A failed durable write must leave the claim uncertain, never pretend import is safe to retry by regenerating.
    await unit.saveRendered(receipt);
    await unit.accountReservations?.settle(submission.onceKey, browser.chargeState, knownCost ? browser.costAnlas : undefined);
  }
  if (unit.rendered) await unit.accountReservations?.settle(unit.submission.onceKey, receipt.chargeState,
    receipt.uncertainReservedAnlas ? undefined : receipt.visibleCostAnlas);
  try {
    const imported = await unit.importArtifacts(receipt.rawArtifacts);
    const unique = new Set(imported.artifacts.map(artifact => artifact.url));
    if (imported.error || imported.artifacts.length !== count || unique.size !== count) return {
      status: "blocked", stage: "artifact-delivery", retrySafety: "safe", rendered: true, receipt,
      ...(imported.artifacts.length ? { partialArtifacts: imported.artifacts } : {}),
      reason: imported.error ?? (unique.size !== imported.artifacts.length ? "含内容相同的重复图片，不能冒充多张独立成品。"
        : `生成已完成，但应导入 ${count} 张，实际导入 ${imported.artifacts.length} 张。`),
    };
    return { status: "completed", artifacts: imported.artifacts, receipt };
  } catch (error) {
    return { status: "blocked", stage: "artifact-delivery", retrySafety: "safe", rendered: true, receipt,
      reason: error instanceof Error ? error.message : String(error) };
  }
}
