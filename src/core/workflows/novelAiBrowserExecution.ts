import type { NovelAiSubmissionLimit, ToolContext } from "../../types";
import { frozenNovelAiAttachment } from "../novelAiReferences";
import { novelAiPromptBudgetOverflowReport } from "../novelAiPromptBudget";
import { novelAiPromptBudgetFailureKey } from "../novelAiPromptBudgetEvidence";
import { novelAiAuthenticationFailureKey, type NovelAiAuthenticationIssue } from "../novelAiAuthentication";
import { beginNovelAiExecutionStage, finishNovelAiExecutionStage,
  type NovelAiExecutionStageHandle, type NovelAiExecutionStageSnapshot } from "../novelAiExecutionStage";
import {
  novelAiExecutionEvidenceKey,
  type NovelAiExecutionEvidence,
} from "../tools/openCliBrowser";
import {
  normalizeBrowserControllerResult,
  type BrowserControllerResult,
} from "../tools/spawnSubagent";

export type NovelAiBrowserRunner = (
  input: string, ctx: ToolContext, submission?: NovelAiSubmissionLimit,
) => Promise<BrowserControllerResult>;

function onceKeyFromTask(input: string): string | undefined {
  return input.match(/"onceKey":"([A-Za-z0-9:_-]{1,100})"/)?.[1]
    ?? input.match(/^onceKey\s*:\s*([A-Za-z0-9:_-]{1,100})\s*$/mi)?.[1];
}

function browserResultFromExecutionStage(stage: NovelAiExecutionStageSnapshot): BrowserControllerResult {
  const notSubmitted = stage.state === "not_submitted";
  const chargeState = notSubmitted ? "not_charged" as const : "unknown" as const;
  const reason = notSubmitted
    ? "受控工具证据确认本轮停在 Generate 激活之前，未提交生成、未产生本轮生成费用；表单准备或最终回执未完成，尚无原图。"
    : `本轮可能已激活 Generate，或提交前工具证据覆盖不完整；提交与扣费状态尚未确认，不得自动重放。${stage.unverifiedReason ? `证据缺口：${stage.unverifiedReason}。` : ""}`;
  const marker = { status: "blocked", chargeState, ...(notSubmitted ? { costAnlas: 0 } : {}),
    artifacts: [], reason, executionStage: stage };
  return { agent: "browser_controller", status: "blocked", chargeState, terminal: true, controllerInvoked: true,
    artifactVerified: false, executionStage: stage, ...(notSubmitted ? { costAnlas: 0 } : {}), reason,
    instruction: notSubmitted ? "仅证明本轮未启动 Generate，不代表准备成功，本轮没有新生成图可回收。不要另开网页猜 data:/blob: 图片选择器；已完成画面从原 Job 已验签的 artifacts 交付。沿用原 Job，未经明确继续不要自动重试。"
      : "缺少可确认的原图回执；保留未知费用预留，不得依据 Browser 自述清除。",
    result: `BROWSER_RESULT ${JSON.stringify(marker)}` };
}

/** collect_novelai_result 的验签证据高于 Browser Agent 的最终自然语言。 */
export function browserResultFromNovelAiEvidence(
  evidence: NovelAiExecutionEvidence,
): BrowserControllerResult {
  const artifacts = (evidence.artifacts ?? [])
    .map((artifact) => typeof artifact.path === "string" ? artifact.path.trim() : "")
    .filter(Boolean);
  const before = typeof evidence.balanceBefore === "number" ? evidence.balanceBefore : undefined;
  const after = typeof evidence.balanceAfter === "number" ? evidence.balanceAfter : undefined;
  const costAnlas = Number.isFinite(evidence.visibleCostAnlas) ? evidence.visibleCostAnlas : undefined;
  const chargeState = before !== undefined && after !== undefined && after < before
    ? "charged" as const
    : "unknown" as const;
  const completed = evidence.completed === true && artifacts.length > 0;
  const status = completed ? "completed" as const : "blocked" as const;
  const reason = completed
    ? `collect_novelai_result 已验签 ${artifacts.length} 个目标分辨率原图；这仅验证文件与尺寸，未进行人物结构或画面质量审查。`
    : evidence.reason ?? "Generate 已提交，但 collect_novelai_result 未取得验签原图。";
  const marker = {
    status,
    chargeState,
    balanceBefore: before ?? null,
    balanceAfter: after ?? null,
    costAnlas: costAnlas ?? null,
    artifacts,
    reason,
    ...(completed ? { visualReview: "not_performed" } : {}),
  };
  return {
    agent: "browser_controller",
    status,
    chargeState,
    terminal: true,
    controllerInvoked: true,
    artifactVerified: completed,
    ...(before !== undefined ? { balanceBefore: before } : {}),
    ...(after !== undefined ? { balanceAfter: after } : {}),
    ...(costAnlas !== undefined ? { costAnlas } : {}),
    ...(artifacts.length ? { artifacts } : {}),
    reason,
    instruction: completed
      ? "权威工具证据：原图文件与尺寸已验签；不代表画面质量合格，不得据此声称人物结构正确。Browser 最终文本若声称未返回，必须忽略。"
      : "权威工具证据：提交结果仍不确定，不得自动重试。",
    result: `BROWSER_RESULT ${JSON.stringify(marker)}`,
  };
}

/** Only the selected current-turn media grant reaches Browser; no historical path lookup. */
function selectedReference(input: string, ctx: ToolContext) {
  const match = /^(NOVELAI_IMAGE_SET|COMIC_PANEL) (.+)$/m.exec(input);
  const images = ctx.attachments?.filter(item => item.kind === "image") ?? [];
  if (!match) return { input, attachments: images };
  const payload = JSON.parse(match[2]!);
  const request = payload.novelAiRequest;
  const reference = request?.reference;
  if (reference === "none") return { input, attachments: undefined };
  if (reference && typeof reference === "object") {
    const index = reference.attachmentIndex;
    if (!Number.isInteger(index) || !images[index]) throw new Error("指定的本轮参考图不存在，不能猜测历史附件");
    frozenNovelAiAttachment(request, ctx.attachments);
    // The child receives a reduced grant. Its index is 0, not the original
    // caller index; keep the saved request/bundle unchanged outside this handoff.
    request.reference = { attachmentIndex: 0 };
    return { input: input.replace(match[0], `${match[1]} ${JSON.stringify(payload)}`), attachments: [images[index]!] };
  }
  return { input, attachments: images };
}

/** Only the LLM view is reduced. Frozen requests/receipts in the Job and the
 * trusted form passed to tools remain byte-for-byte unchanged. Legacy callers
 * without a trusted form keep the complete task. */
export function novelAiBrowserTaskView(input: string, submission?: NovelAiSubmissionLimit): string {
  if (!submission?.form) return input;
  const match = /^(NOVELAI_IMAGE_SET|COMIC_PANEL) (.+)$/m.exec(input);
  if (!match) return input;
  const payload = JSON.parse(match[2]!);
  const request = payload.novelAiRequest;
  if (!request?.browserForm || payload.onceKey !== submission.onceKey) return input;
  const { browserForm: _form, ...executionRequest } = request;
  const { visualBible: _bible, storyboard: _storyboard, ...executionPayload } = payload;
  const form = submission.form;
  const compact = { ...executionPayload, novelAiRequest: executionRequest,
    frozenForm: { source: "trusted_execution_context", width: form.width, height: form.height,
      numberOfImages: submission.numberOfImages, characterNames: form.characterNames ?? [] } };
  // The old image-set task repeats these exact labels outside its JSON block.
  // Keep every other instruction (including authorization and references).
  const repeated = new Set([`onceKey: ${submission.onceKey}`, `resolution: ${request.resolution} ${form.width}x${form.height}`,
    ...(Array.isArray(form.characterNames) ? form.characterNames.map((name, index) => `Character ${index + 1} — ${String(name).replace(/[\r\n]/g, " ")}`) : [])]);
  return input.replace(match[0], `${match[1]} ${JSON.stringify(compact)}`).split(/\r?\n/)
    .filter(line => !repeated.has(line)).join("\n");
}

/**
 * Workflow 共用的 Browser 执行边界：沿用当前 Codex Harness（若显式选择），并用
 * onceKey 找回 OpenCLI 工具证据。每次调用仍是独立的 browser_controller run/tab。
 */
export async function runNovelAiBrowserTask(
  input: string,
  ctx: ToolContext,
  submission?: NovelAiSubmissionLimit,
): Promise<BrowserControllerResult> {
  if (!ctx.runAgent) throw new Error("NovelAI Workflow: runAgent 未注入，无法调用 browser_controller");
  const execution = {
    ...ctx.execution,
    // A Browser run is one-shot: share execution evidence, never the author's
    // native conversation or durable draft scope (the author is awaiting us).
    nativeSession: undefined,
    delegationTasks: undefined,
    ...(submission ? { novelAiSubmission: submission } : {}),
  };
  execution.toolEvidence ??= new Map();
  let raw = "";
  let failure: unknown;
  let stageHandle: NovelAiExecutionStageHandle | undefined;
  try {
    const selected = selectedReference(input, ctx);
    if (submission?.requiredReferences?.some(ref => ref.kind === "attachment")) {
      // selectedReference narrows the child image grant; preserve the stored original index.
      execution.novelAiSubmission = { ...submission,
        requiredReferences: submission.requiredReferences.map(ref => ref.kind === "attachment" ? { ...ref, index: 0 } : ref) };
    }
    stageHandle = beginNovelAiExecutionStage(execution);
    const taskView = novelAiBrowserTaskView(selected.input, submission);
    if (taskView !== selected.input) ctx.logger.info({ beforeBytes: Buffer.byteLength(selected.input), afterBytes: Buffer.byteLength(taskView) }, "workflow:browser-task-view");
    raw = await ctx.runAgent(
      "browser_controller",
      taskView + (submission?.form ? "\n\n[Workflow 固定执行] 表单已通过可信执行上下文下授。直接 prepare_novelai_form({tab}) 自动选择冻结模型并填写 Prompt、角色、宽高和张数，不需复制字段；禁止另用 eval/click/press 切模型或填表。只上传冻结选中的参考图，每角色一张；必需参考图未确认应用时不可生成。用 execute_novelai({tab}) 由代码复核参考图/尺寸/价格、唯一提交并回收原图。已提交后再次 execute_novelai 仅回收，不再 Generate。超限时停止网页操作并交回 Workflow，由原作者修稿；不要同稿重试或自行申请新 Job。" : ""),
      undefined,
      selected.attachments,
      undefined,
      ctx.modelRef?.startsWith("codex-app-server/") ? ctx.modelRef : undefined,
      undefined,
      ctx.signal,
      execution,
      { source: ctx.source },
    );
  } catch (error) {
    failure = error;
  }
  const stage = finishNovelAiExecutionStage(execution, stageHandle);
  // Billing/artifact evidence belongs to the trusted frozen submission. The
  // model-facing task may be reformatted or mention another operation's key.
  // Keep text parsing only for legacy callers without a frozen submission.
  const onceKey = execution.novelAiSubmission?.onceKey ?? onceKeyFromTask(input);
  const evidence = onceKey && execution.toolEvidence.get(novelAiExecutionEvidenceKey(onceKey));
  // 模型尾声断流不应抹掉 collect 已经写下的权威成品回执。
  if (evidence && typeof evidence === "object") return browserResultFromNovelAiEvidence(evidence as NovelAiExecutionEvidence);
  const authenticationKey = novelAiAuthenticationFailureKey(submission);
  const authentication = authenticationKey && execution.toolEvidence.get(authenticationKey) as NovelAiAuthenticationIssue | undefined;
  if (authentication && (authentication.kind === "login_required" || authentication.kind === "verification_required") &&
    stage?.state === "not_submitted") {
    return { agent: "browser_controller", status: "needs_input", terminal: true, controllerInvoked: true,
      artifactVerified: false, chargeState: "not_charged", costAnlas: 0, executionStage: stage,
      reason: authentication.reason,
      instruction: "NovelAI 登录或验证需人工完成；保留原 Job、已完成图片和预算。登录后先查 Job 状态，再显式 resume；本轮不重试 Generate。",
      result: `BROWSER_RESULT ${JSON.stringify({ status: "needs_input", chargeState: "not_charged", costAnlas: 0,
        reason: authentication.reason })}` };
  }
  if (authentication && (authentication.kind === "login_required" || authentication.kind === "verification_required") && stage) {
    const uncertain = browserResultFromExecutionStage(stage);
    const reason = `${authentication.reason} 本轮提交/费用证据不足，保留原 Job 和费用预留；重新登录后先核对状态，不自动重试。`;
    return { ...uncertain, reason, result: `BROWSER_RESULT ${JSON.stringify({ status: "blocked", chargeState: "unknown",
      reason, executionStage: stage })}` };
  }
  const budgetKey = novelAiPromptBudgetFailureKey(submission);
  const budgetFailure = budgetKey && execution.toolEvidence.get(budgetKey);
  const promptBudgetOverflow = novelAiPromptBudgetOverflowReport(budgetFailure);
  if (promptBudgetOverflow && budgetFailure instanceof Error && (!stage || stage.state === "not_submitted" ||
    (stage.state === "unverified" && stage.observedActions === 0))) {
    return { agent: "browser_controller", status: "blocked", terminal: true, controllerInvoked: true,
      artifactVerified: false, chargeState: "not_charged", costAnlas: 0, promptBudgetOverflow,
      ...(stage ? { executionStage: stage } : {}),
      reason: budgetFailure.message,
      instruction: "网页精确计数已确认超限；先修订 Prompt，再恢复原 Job。不要重新启动相同表单。",
      result: `BROWSER_RESULT ${JSON.stringify({ status: "blocked", chargeState: "not_charged", costAnlas: 0,
        promptBudgetOverflow, reason: budgetFailure.message })}` };
  }
  // Preserve the original transport error when no governed tool ran at all;
  // the unit boundary already records that path as uncertain, never free.
  if (stage?.state === "unverified" && stage.observedActions === 0 && failure !== undefined) throw failure;
  if (stage) return browserResultFromExecutionStage(stage);
  if (failure !== undefined) throw failure;
  return normalizeBrowserControllerResult(raw);
}
