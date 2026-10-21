import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { BrowserArtifact } from "../browserArtifacts";
import { browserStepContinuation } from "../browserContinuation";
import { resolveSubagentImages } from "./subagentImages";
import { delegationPaused } from "../agentDelegationStore";
import { beginSubmittedPlanCapture } from "../submittedPlan";
import { normalizeExecutionReasonCode, type ExecutionReasonCode, type ToolDef, type ToolContext } from "../../types";
import { currentCheckpointOperationId } from "../checkpoint";
import { delegationTaskReceipt, restoredDelegationInput } from "../delegationTasks";
import type { DelegationTask } from "../delegationTaskStore";
import { takeNovelAiDraftFeedback } from "../workflows/novelAiDraftFeedback";
import { SUBAGENT_TIMEOUT_MS, COMIC_DIRECTOR_TIMEOUT_MS, OUTER_TIMEOUT_GRACE_MS,
  subagentTimeoutMs, runCancellableSubagent } from "../subagentTimeout";
import {
  publishNovelAiArtifacts,
  type PublishedNovelAiArtifact,
} from "../novelAiArtifactDelivery";
import {
  isNovelAiMultiPanelGenerationRequest,
  MULTI_PANEL_COMIC_ROUTE_REASON,
} from "../novelAiComicRouting";
import {
  parseComicSubagentDelivery,
  rememberComicSubagentOutcome,
  rememberedComicDelivery,
  rememberedComicOutcome,
} from "./comic";
import {
  workflowExecutionEvidenceKey,
  settleWorkflowExecutionEvidence,
  type WorkflowExecutionEvidence,
} from "./runWorkflow";

const WORKFLOW_SETTLEMENT_GRACE_MS = OUTER_TIMEOUT_GRACE_MS - 5_000;
const AUTHORITATIVE_BROWSER_RESULT_KEY = "spawn_subagent:authoritative:browser_controller";
const COMIC_WORKFLOW_NAME = "comic-generation";
const COMIC_BUDGET_STOP_KEY = "spawn_subagent:comic:budget-required";
const COMIC_EXECUTION_ACTION = /\b(?:resume|abort|revise)_comic\b/iu;
const EXPLICIT_COMIC_BUDGET = /(?:(?:\b(?:budget|maxTotalAnlas)\b|预算(?:[^\r\n\d]{0,12}(?:上限|限额))?|\bAnlas\b[^\r\n\d]{0,16}(?:上限|限额|\bbudget\b|\blimit\b|\bcap\b|\bmaximum\b))[\s"'`]*(?:(?:[:=：]|<=?|≤|\bis\b|为|是|设为|给到|不超过|最多)[\s"'`]*)?\d+(?:\.\d+)?|(?:上限|限额|\b(?:limit|cap|maximum)\b)[\s"'`]*(?:(?:[:=：]|<=?|≤|\bis\b|为|是|设为|给到|不超过|最多)[\s"'`]*)?\d+(?:\.\d+)?\s*Anlas\b|^\s*\d+(?:\.\d+)?\s*Anlas\s*[。.!！]?\s*$)/iu;
const EXPLICIT_COMIC_JOB = /\bcomic-(?=[0-9a-f-]{12,64}\b)[0-9a-f]+(?:-[0-9a-f]+)*\b/iu;
const SAME_COMIC_TASK_FOLLOWUP = /(?:继续|续接|恢复|重试|再试|再次(?:派发|尝试|调用)?|仍(?:然|旧)?|还是|刚才|之前|上一(?:轮|次)|同一?(?:任务|漫画)|(?:查询|查看|确认|说明)[^\r\n]{0,12}(?:状态|结果)|为什么[^\r\n]{0,12}(?:失败|没|未)|\b(?:continue|resume|retry|status|same\s+(?:task|comic)|previous\s+(?:run|attempt)|what\s+(?:is\s+)?missing)\b)/iu;
const DIFFERENT_COMIC_TASK = /(?:另(?:一|个|部|套)|新的?(?:任务|漫画|故事)|新建|第二(?:个|部|套)|换(?:一|个|部|套)|换成|改成|改画|改做|转为|转成|\b(?:another|different|new)\s+(?:task|comic|manga|story)\b|\binstead\b|\b(?:switch|change)\s+to\b)/iu;

/** Share the existing route decision with the outer timeout; never change dispatch policy. */
function routesBrowserToComic(agentName: string, input: string, ctx: ToolContext): boolean {
  return ctx.agent.name.startsWith("main-") && agentName === "browser_controller"
    && isNovelAiMultiPanelGenerationRequest(input);
}

export type BrowserControllerStatus = "completed" | "needs_input" | "blocked" | "unknown";
export type BrowserChargeState = "charged" | "not_charged" | "unknown";

export interface BrowserControllerResult {
  /** Set by trusted local tools only, never parsed from model-authored JSON. */
  promptBudgetOverflow?: import("../novelAiPromptBudget").NovelAiPromptBudgetOverflowReport;
  /** Run-local tool coverage, not a model claim or a reusable resume capability. */
  executionStage?: import("../novelAiExecutionStage").NovelAiExecutionStageSnapshot;
  agent: "browser_controller";
  status: BrowserControllerStatus;
  chargeState: BrowserChargeState;
  terminal: true;
  controllerInvoked: true;
  artifactVerified: boolean;
  balanceBefore?: number;
  balanceAfter?: number;
  costAnlas?: number;
  artifacts?: string[];
  deliveryArtifacts?: Array<PublishedNovelAiArtifact | BrowserArtifact>;
  deliveryError?: string;
  /** Model-authored report, separate from the authoritative status/side-effect fields. */
  report?: string;
  executionLimits?: { segments: number; maxSegments: number; incomplete?: string };
  reason?: string;
  instruction: string;
  result: string;
}

export type ComicGeneratorStatus = "continue" | "completed" | "blocked" | "needs_input" | "aborted" | "unknown";
export type SubagentRetrySafety = "safe" | "uncertain" | "not_applicable";

export interface ComicGeneratorResult {
  agent: "comic_generator";
  status: ComicGeneratorStatus;
  terminal: boolean;
  retrySafety: SubagentRetrySafety;
  jobId?: string;
  completed?: number;
  total?: number;
  revision?: number;
  panel?: number;
  reason?: string;
  reasonCode?: ExecutionReasonCode;
  /** true only when this tool invocation actually started/reused the real director run. */
  delegateInvoked?: boolean;
  title?: string;
  visibleSpentAnlas?: number;
  maxTotalAnlas?: number;
  uncertainReservedAnlas?: number;
  partialDeliveryMarkdown?: string;
  partialDeliveryUrls?: string[];
  reviewMarkdown?: string;
  resumeAction?: Record<string, unknown>;
  /** Set only at the executor evidence boundary, never inferred from director prose. */
  authoritative?: boolean;
  deliveryMarkdown?: string;
  deliveryUrls?: string[];
  /** File verification alone is never a visual-quality review. */
  visualReview?: "not_performed";
  /** Main 只需执行这个通用动作，不需要常驻 COMIC_* 协议。 */
  nextAction?: {
    tool: "spawn_subagent" | "ask_user";
    args?: { agent: "comic_generator"; input: string };
    reason?: string;
  };
  instruction: string;
  result: string;
}

interface ComicBudgetStopCache {
  taskFingerprint: string;
  receipt: ComicGeneratorResult;
}

function isMissingComicBudgetReason(status: ComicGeneratorStatus, reason?: string): boolean {
  if (status !== "needs_input" || !reason) return false;
  return reason.split(/[\r\n。！？!?；;,，]+/u).some((rawClause) => {
    const clause = rawClause.replace(/[*_`#>]/g, " ").replace(/\s+/g, " ").trim();
    if (!clause) return false;
    // A sentence saying the budget is already known must never become a request merely
    // because some unrelated field in the same receipt still needs input.
    if (/(?:已(?:经)?(?:确认|提供|给出|批准|授权|填写|设定)|无需|不用|不需|不是[^。；,，]{0,12}预算|(?:预算|上限|限额)[^。；,，]{0,12}(?:已足够|足够)|\balready\s+(?:provided|confirmed|approved|set)\b|\b(?:no|not)\s+need\b|\b(?:sufficient|enough)\b)/iu.test(clause)) return false;
    const asksOrMissing = /(?:请(?:提供|给出|明确|填写|补充|指定|确认)|需(?:要)?(?:提供|给出|明确|填写|补充|指定|确认|确定)?|缺少|尚未提供|未提供|please\s+(?:provide|specify|enter|confirm)|\b(?:need|needs|require|required|missing)\b)/iu.test(clause);
    const budgetCap = /(?:总[^。；,，]{0,16}(?:预算|上限|限额)|(?:预算|Anlas)[^。；,，]{0,16}(?:上限|限额|最高|最大|数字|数值|金额|多少)|(?:上限|限额|数字|数值|金额|多少)[^。；,，]{0,16}(?:预算|Anlas)|\btotal(?:\s+Anlas)?\s+budget\b|\b(?:Anlas\s+)?(?:budget\s+)?(?:limit|cap|maximum|amount|number|numeric)\b|\b(?:amount|number|numeric)\s+(?:Anlas\s+)?budget\b|\bmaxTotalAnlas\b)/iu.test(clause);
    return asksOrMissing && budgetCap;
  });
}

interface BrowserResultMarker {
  status?: unknown;
  chargeState?: unknown;
  balanceBefore?: unknown;
  balanceAfter?: unknown;
  costAnlas?: unknown;
  artifacts?: unknown;
  reason?: unknown;
}

const browserStatuses = new Set<BrowserControllerStatus>(["completed", "needs_input", "blocked", "unknown"]);
const browserChargeStates = new Set<BrowserChargeState>(["charged", "not_charged", "unknown"]);

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

/**
 * comic_generator 的裸 COMIC_* 首行只属于导演内部协议。这里把它收敛成所有 Main
 * 都能消费的统一状态；Main 无需知道 marker 名、续跑字符串或各终态的重放规则。
 */
export function normalizeComicGeneratorResult(
  result: string,
  options: { structuredExecutionBoundary?: boolean } = {},
): ComicGeneratorResult {
  const marker = result.match(/^COMIC_(CONTINUE|COMPLETE|BLOCKED|NEEDS_INPUT|ABORTED)\s+(\{[^\r\n]*\})\s*$/m);
  let meta: Record<string, unknown> = {};
  let kind: string | undefined;
  let plainTextReason: string | undefined;
  if (marker?.[2]) {
    try {
      const parsed = JSON.parse(marker[2]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
        kind = marker[1];
      }
    } catch {
      // 非法回执不能靠猜测继续付费任务；落到 unknown + uncertain。
    }
  }
  if (!kind) {
    // 导演可能以“标记 + 自然语言”集中问人。只容错停住态，且标记必须位于
    // 回执开头；正文里提到协议、损坏 JSON 或完成/续跑声明都不能授权执行。
    let receipt = result.trim().replace(/^>[ \t]?/gm, "").trim();
    const fenced = receipt.match(/^(`{3,}|~{3,})[^\r\n]*\r?\n([\s\S]*?)\r?\n\1$/);
    if (fenced?.[2]) receipt = fenced[2].trim();
    const stop = receipt.match(/^(?:#{1,6}[ \t]+)?(?:\*\*|__|`)?COMIC_(BLOCKED|NEEDS_INPUT)(?:\*\*|__|`)?(?=$|[\s:：])[ \t]*(?:[:：][ \t]*)?([\s\S]*)$/);
    const reason = stop?.[2]?.trim();
    if (stop && reason && !/^[{\[]/.test(reason)) {
      kind = stop[1];
      plainTextReason = reason;
    }
  }
  const status: ComicGeneratorStatus = kind === "CONTINUE"
    ? "continue"
    : kind === "COMPLETE"
      ? "completed"
      : kind === "BLOCKED"
        ? "blocked"
        : kind === "NEEDS_INPUT"
          ? "needs_input"
          : kind === "ABORTED"
            ? "aborted"
            : "unknown";
  const jobId = typeof meta.jobId === "string" && meta.jobId.trim() ? meta.jobId.trim() : undefined;
  const completed = finiteNumber(meta.completed);
  const total = finiteNumber(meta.total);
  const revision = finiteNumber(meta.revision);
  const panel = finiteNumber(meta.panel);
  const reason = typeof meta.reason === "string" && meta.reason.trim() ? meta.reason.trim() : plainTextReason;
  const explicitReasonCode = status === "needs_input" && options.structuredExecutionBoundary
    ? normalizeExecutionReasonCode(meta.reasonCode)
    : undefined;
  // Free-text inference is intentionally limited to an already parsed NEEDS_INPUT receipt.
  // It is clause-local and requires both a missing/request signal and total-cap semantics.
  const reasonCode: ExecutionReasonCode | undefined = explicitReasonCode ??
    (isMissingComicBudgetReason(status, reason) ? "budget_required" : undefined);
  const facts = {
    ...(options.structuredExecutionBoundary && typeof meta.reviewMarkdown === "string" ? { reviewMarkdown: meta.reviewMarkdown } : {}),
    ...(options.structuredExecutionBoundary && meta.resumeAction && typeof meta.resumeAction === "object" ? { resumeAction: meta.resumeAction as Record<string, unknown> } : {}),
    ...(finiteNumber(meta.visibleSpentAnlas) !== undefined ? { visibleSpentAnlas: finiteNumber(meta.visibleSpentAnlas) } : {}),
    ...(finiteNumber(meta.maxTotalAnlas) !== undefined ? { maxTotalAnlas: finiteNumber(meta.maxTotalAnlas) } : {}),
    ...(finiteNumber(meta.uncertainReservedAnlas) !== undefined ? { uncertainReservedAnlas: finiteNumber(meta.uncertainReservedAnlas) } : {}),
    ...(typeof meta.partialDeliveryMarkdown === "string" ? { partialDeliveryMarkdown: meta.partialDeliveryMarkdown } : {}),
    ...(Array.isArray(meta.partialDeliveryUrls) ? { partialDeliveryUrls: meta.partialDeliveryUrls.filter((value): value is string => typeof value === "string") } : {}),
  };
  const retrySafety: SubagentRetrySafety = plainTextReason !== undefined
    ? "uncertain"
    : status === "continue"
      ? "safe"
      : status === "blocked"
        ? meta.retrySafety === "safe" ? "safe" : "uncertain"
        : status === "unknown"
          ? "uncertain"
          : "not_applicable";

  if (status === "continue" && jobId && completed !== undefined && total !== undefined) {
    const input = `RESUME_COMIC ${jobId} completed=${completed}/${total}${revision !== undefined ? ` revision=${revision}` : ""}`;
    return {
      agent: "comic_generator",
      status,
      terminal: false,
      retrySafety,
      ...facts,
      jobId,
      completed,
      total,
      ...(revision !== undefined ? { revision } : {}),
      ...(panel !== undefined ? { panel } : {}),
      nextAction: { tool: "spawn_subagent", args: { agent: "comic_generator", input } },
      instruction: "漫画批次已安全保存。立即原样执行 nextAction；不要自行重写续跑参数，也不要询问用户。",
      result,
    };
  }

  if (status === "blocked" || status === "needs_input") {
    const prompt = reason ?? (status === "blocked"
      ? `漫画任务${panel !== undefined ? `在第 ${panel} 格` : ""}被阻塞。`
      : "漫画任务缺少继续所需输入。");
    return {
      agent: "comic_generator",
      status,
      terminal: true,
      retrySafety,
      ...facts,
      ...(jobId ? { jobId } : {}),
      ...(completed !== undefined ? { completed } : {}),
      ...(total !== undefined ? { total } : {}),
      ...(revision !== undefined ? { revision } : {}),
      ...(panel !== undefined ? { panel } : {}),
      ...(reason ? { reason } : {}),
      ...(reasonCode ? { reasonCode } : {}),
      nextAction: { tool: "ask_user", reason: prompt },
      instruction: plainTextReason !== undefined
        ? "按 nextAction 集中询问所缺输入或说明阻塞，并保留导演原话；纯文本回执不证明可安全重试，不得自动重放、擅改任务或绕过内容限制。"
        : retrySafety === "uncertain"
          ? "存在可能扣费或提交过的未知副作用；不得自动重放。向用户集中说明证据并询问唯一决定。"
          : "当前批次已安全停住；按 nextAction 集中询问继续所需决定，不要擅自改变任务。",
      result,
    };
  }

  if (status === "completed" || status === "aborted") {
    const delivery = status === "completed" ? parseComicSubagentDelivery(result) : undefined;
    return {
      agent: "comic_generator",
      status,
      ...(status === "completed" ? { visualReview: "not_performed" as const } : {}),
      terminal: true,
      retrySafety,
      ...facts,
      ...(jobId ? { jobId } : {}),
      ...(completed !== undefined ? { completed } : {}),
      ...(total !== undefined ? { total } : {}),
      ...(revision !== undefined ? { revision } : {}),
      ...(reason ? { reason } : {}),
      ...(delivery ? {
        title: delivery.title,
        visibleSpentAnlas: delivery.visibleSpentAnlas,
        deliveryMarkdown: delivery.markdown,
        deliveryUrls: delivery.urls,
      } : {}),
      instruction: status === "completed"
        ? "漫画已完成；deliveryMarkdown 与 deliveryUrls 就是权威逐幕交付。visualReview=not_performed：文件验签/落盘不等于视觉验收，不能据此声称人物、姿态或画面质量已核验通过。现在直接最终回复，禁止再次派发、查询 status 或尝试取回产物。"
        : "漫画已终止；不得再次派发，向用户确认终止结果即可。",
      result,
    };
  }

  return {
    agent: "comic_generator",
    status: "unknown",
    terminal: true,
    retrySafety: "uncertain",
    instruction: "漫画导演没有返回合法结构化状态。不得猜测进度或自动重放付费动作；如实报告原始回执。",
    result,
  };
}

function hasExplicitComicBudget(input: string): boolean {
  return EXPLICIT_COMIC_BUDGET.test(input);
}

function hasExplicitComicJob(input: string): boolean {
  return EXPLICIT_COMIC_JOB.test(input);
}

function comicTaskFingerprint(input: string): string {
  const normalized = input.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 20);
}

function isSameComicTaskFollowup(input: string): boolean {
  return SAME_COMIC_TASK_FOLLOWUP.test(input) && !DIFFERENT_COMIC_TASK.test(input);
}

function comicBudgetStopReceipt(result: unknown): ComicGeneratorResult | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as Partial<ComicGeneratorResult>;
  if (record.agent !== "comic_generator" || record.status !== "needs_input" || record.terminal !== true ||
      typeof record.result !== "string" || record.delegateInvoked === false) return undefined;
  const parsed = normalizeComicGeneratorResult(record.result, {
    structuredExecutionBoundary: record.authoritative === true,
  });
  const reasonCode = normalizeExecutionReasonCode(record.reasonCode) ?? parsed.reasonCode;
  if (reasonCode !== "budget_required") return undefined;
  return {
    ...parsed,
    ...record,
    agent: "comic_generator",
    status: "needs_input",
    terminal: true,
    reasonCode,
    result: record.result,
  } as ComicGeneratorResult;
}

/** Keep only a real no-budget stop from this Main run. This never invokes or resumes anything. */
function refreshComicBudgetStop(result: unknown, input: string, ctx: { agent: { name: string }; runState?: Map<string, unknown> }): void {
  if (!ctx.agent.name.startsWith("main-") || !ctx.runState) return;
  const record = result && typeof result === "object" ? result as Partial<ComicGeneratorResult> : undefined;
  // A cached tool result is an observation, not another real delegation, so it must not
  // erase or manufacture the state restored by the first invocation.
  if (record?.delegateInvoked === false) return;
  ctx.runState.delete(COMIC_BUDGET_STOP_KEY);
  const previous = rememberedComicOutcome(ctx.runState);
  if (previous?.authoritative && previous.jobId && !record?.jobId) return;
  if (hasExplicitComicBudget(input) || hasExplicitComicJob(input)) return;
  const receipt = comicBudgetStopReceipt(result);
  if (receipt) {
    ctx.runState.set(COMIC_BUDGET_STOP_KEY, {
      taskFingerprint: comicTaskFingerprint(input),
      receipt,
    } satisfies ComicBudgetStopCache);
  }
}

function rememberedComicBudgetStop(input: string, runState?: Map<string, unknown>): ComicGeneratorResult | undefined {
  const raw = runState?.get(COMIC_BUDGET_STOP_KEY);
  if (!raw || typeof raw !== "object") return undefined;
  const cache = raw as Partial<ComicBudgetStopCache>;
  if (typeof cache.taskFingerprint !== "string") return undefined;
  if (cache.taskFingerprint !== comicTaskFingerprint(input) && !isSameComicTaskFollowup(input)) return undefined;
  return comicBudgetStopReceipt(cache.receipt);
}

export function comicWorkflowCanonical(evidence: WorkflowExecutionEvidence, executionError?: string): string | undefined {
  const snapshot = evidence.result?.jobId && evidence.result.executionStarted !== false ? evidence.result : evidence.jobSnapshot;
  const result = snapshot ?? (evidence.phase === "completed" || evidence.result?.executionStarted === false ? evidence.result : undefined);
  if (!result) return undefined;
  const rejected = evidence.result?.executionStarted === false;
  const unsettled = !rejected && ((evidence.phase !== "completed" && result.terminal !== true) ||
    !["completed", "continue", "blocked", "needs_input", "aborted", "paused"].includes(String(result.status)));
  const status = unsettled || (rejected && !snapshot) ? "blocked" : result.status === "paused" ? "blocked" : String(result.status ?? "");
  const marker = status === "completed"
    ? "COMIC_COMPLETE"
    : status === "continue"
      ? "COMIC_CONTINUE"
      : status === "blocked"
        ? "COMIC_BLOCKED"
        : status === "needs_input"
          ? "COMIC_NEEDS_INPUT"
          : status === "aborted"
            ? "COMIC_ABORTED"
            : undefined;
  if (!marker) return undefined;
  const meta = Object.fromEntries([
    "jobId",
    "title",
    "completed",
    "total",
    "revision",
    "panel",
    "reason",
    "reasonCode",
    "retrySafety",
    "visibleSpentAnlas",
    "maxTotalAnlas",
    "uncertainReservedAnlas",
    "partialDeliveryMarkdown",
    "partialDeliveryUrls",
    "reviewMarkdown",
  ].flatMap((key) => result[key] === undefined ? [] : [[key, result[key]]]));
  if (result.nextAction) meta.resumeAction = result.nextAction;
  if (rejected && evidence.result) meta.lastError = evidence.result;
  if (unsettled) {
    meta.reason = `执行已中断，Workflow 取消结算尚未确认；以下仅为最后持久化进度，提交/扣费状态未知。${executionError ?? evidence.error ?? ""}`;
    meta.retrySafety = "uncertain";
  } else if (result.status === "paused" && !meta.reason) meta.reason = "运行已暂停；不会自动继续或重放。";
  const delivery = status === "completed" && typeof result.deliveryMarkdown === "string"
    ? `\n\n${result.deliveryMarkdown.trim()}`
    : "";
  return `${marker} ${JSON.stringify(meta)}${delivery}`;
}

/** Tolerate presentation, never repair JSON/paths or guess between conflicting receipts. */
function parseBrowserResultMarker(result: string): { marker?: BrowserResultMarker; report?: string; error?: string } {
  const text = result.replace(/^[ \t]*>[ \t]?/gm, "");
  const starts = [...text.matchAll(/^[ \t]*(?:#{1,6}[ \t]+)?(?:`{1,3}|\*\*|__)?BROWSER_RESULT(?:`{1,3}|\*\*|__)?(?=$|[\s:：{])[ \t]*(?:[:：][ \t]*)?/gm)];
  if (!starts.length) return {};
  const invalid = (detail: string) => ({ error: `Browser Controller 回执格式无效：${detail}；提交与扣费状态尚未确认，不得自动重放。` });
  if (starts.length !== 1) return invalid("含多个 BROWSER_RESULT，不能猜测哪份有效");
  const start = starts[0]!;
  const json = text.slice(start.index! + start[0].length).trimStart();
  if (!json.startsWith("{")) return invalid("BROWSER_RESULT 后必须是 JSON 对象");
  let depth = 0, quoted = false, escaped = false, end = -1;
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) return invalid("JSON 对象未闭合");
  // Additional prose may follow on another line; the receipt line itself must
  // end here (apart from its Markdown wrapper), not contain another object.
  if (!/^[ \t]*(?:`{1,3}|\*\*|__)?[ \t]*(?:\r?\n|$)/.test(json.slice(end))) return invalid("JSON 后含无法识别的内容");
  try {
    const parsed = JSON.parse(json.slice(0, end)) as BrowserResultMarker;
    if (!browserStatuses.has(parsed.status as BrowserControllerStatus) ||
        (parsed.chargeState !== undefined && !browserChargeStates.has(parsed.chargeState as BrowserChargeState)) ||
        (parsed.artifacts !== undefined && (!Array.isArray(parsed.artifacts) || parsed.artifacts.some(item => typeof item !== "string")))) {
      return invalid("status、chargeState 或 artifacts 字段不符合契约");
    }
    const report = json.slice(end).replace(/^[ \t]*(?:`{1,3}|\*\*|__)?[ \t]*\r?\n?/, "")
      .replace(/^\s*`{3}\s*(?:\r?\n|$)/, "").trim();
    return { marker: parsed, ...(report ? { report } : {}) };
  } catch {
    return invalid("JSON 解析失败（保留原回执，未尝试改写）");
  }
}

/** Structured receipts survive Markdown; legacy prose remains a conservative fallback. */
export function normalizeBrowserControllerResult(result: string): BrowserControllerResult {
  const parsed = parseBrowserResultMarker(result);
  const marker: BrowserResultMarker = parsed.marker ?? {};

  const explicitStatus = typeof marker.status === "string" && browserStatuses.has(marker.status as BrowserControllerStatus)
    ? marker.status as BrowserControllerStatus
    : undefined;
  const proseStatus = /(?:^|[\s`*:_-])(needs_input)(?:$|[\s`*:_-])/im.test(result)
    ? "needs_input"
    : /(?:^|[\s`*:_-])(blocked)(?:$|[\s`*:_-])/im.test(result)
      ? "blocked"
      : /(?:^|[\s`*:_-])(completed)(?:$|[\s`*:_-])/im.test(result)
        ? "completed"
        : "unknown";
  const status = parsed.error ? "unknown" : explicitStatus ?? proseStatus;

  const explicitCharge = typeof marker.chargeState === "string" && browserChargeStates.has(marker.chargeState as BrowserChargeState)
    ? marker.chargeState as BrowserChargeState
    : undefined;
  const balanceBefore = finiteNumber(marker.balanceBefore);
  const balanceAfter = finiteNumber(marker.balanceAfter);
  const costAnlas = finiteNumber(marker.costAnlas);
  const noChargeEvidence = /(?:anlas\s+(?:never|was not|wasn't)\s+(?:deducted|charged)|(?:没有|未)\s*(?:扣|消耗).*anlas|balance\s+(?:stayed|remained|unchanged)|余额[^\r\n]{0,40}(?:未变|不变|原样))/i.test(result);
  const uncertainWriteAttempt = /(?:clicked|activated|submitted|点(?:击|了)|已提交)[^\r\n]{0,80}generate|onceKey\s*=?\s*`?novelai-generate/i.test(result);
  const chargedEvidence = /(?:charged|deducted|cost|消耗|扣除)\s*\*{0,2}\s*(\d[\d,]*)\s*anlas/i.exec(result);
  let chargeState: BrowserChargeState = parsed.error ? "unknown" : explicitCharge ?? (chargedEvidence
    ? "charged"
    : noChargeEvidence && !uncertainWriteAttempt
      ? "not_charged"
      : "unknown");

  // 页面余额是扣费事实，Controller 的自然语言不是。生成已提交/产出但即时余额仍相同，
  // 可能是 NovelAI 余额延迟或免费额度，不能宣称 charged；余额明确下降则反向校正。
  if (balanceBefore !== undefined && balanceAfter !== undefined) {
    if (balanceAfter < balanceBefore) chargeState = "charged";
    else if (balanceAfter === balanceBefore && (
      explicitCharge === "charged" || ((costAnlas ?? 0) > 0 && (status === "completed" || uncertainWriteAttempt))
    )) {
      chargeState = "unknown";
    } else if (balanceAfter > balanceBefore) chargeState = "unknown";
  }

  const artifacts = parsed.error ? [] : Array.isArray(marker.artifacts)
    ? marker.artifacts.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [...result.matchAll(/(?:[A-Za-z]:\\|\/)[^\r\n`"']+?\.(?:png|jpe?g|webp|gif|mp4|webm|mp3|wav)/gi)].map((match) => match[0]);

  // Status stays canonical. Keep the actual task report separately: discarding it
  // loses measurements/research/playtest findings that cannot fit a one-line reason.
  const canonicalResult = parsed.marker
    ? `BROWSER_RESULT ${JSON.stringify({
      ...(marker as Record<string, unknown>),
      status,
      chargeState,
    })}`
    : result;

  return {
    agent: "browser_controller",
    status,
    chargeState,
    terminal: true,
    controllerInvoked: true,
    artifactVerified: status === "completed" && artifacts.length > 0,
    ...(balanceBefore !== undefined ? { balanceBefore } : {}),
    ...(balanceAfter !== undefined ? { balanceAfter } : {}),
    ...(costAnlas !== undefined ? { costAnlas } : {}),
    ...(artifacts.length ? { artifacts } : {}),
    ...(parsed.report ? { report: parsed.report } : {}),
    ...(parsed.error ? { reason: parsed.error }
      : typeof marker.reason === "string" && marker.reason.trim() ? { reason: marker.reason.trim() } : {}),
    instruction: status === "completed" && artifacts.length
      ? "权威结果：网页任务已完成且 artifacts 已验签。chargeState=unknown 只表示即时账务未确认，不表示生成失败；不得再说没有 BROWSER_RESULT、没有成品或需要去 History 确认。"
      : `权威结果：Controller 状态为 ${status}；Main 必须按此状态转述，不得自行升降级。`,
    result: canonicalResult,
  };
}

function completedResultContradiction(answer: string): boolean {
  return /(?:没有|未)(?:收到|返回|获得|拿到)[^。\n]{0,50}(?:BROWSER_RESULT|回执|结果|成品|artifact|路径)/i.test(answer) ||
    /(?:不能假装|无法确认)[^。\n]{0,30}(?:图片|成品|生成|完成)/i.test(answer) ||
    /(?:需要|要)[^。\n]{0,30}(?:NovelAI\s*)?(?:History|历史记录)[^。\n]{0,20}(?:确认|核对)/i.test(answer) ||
    /卡在[^。\n]{0,20}(?:结果回收|回执|成品路径)/i.test(answer);
}

function completedDeliverySummary(result: BrowserControllerResult, corrected: boolean): string {
  const lines = [
    corrected
      ? "网页任务已经完成，Harbour 已收到并验签成品；Main 先前的相反判断已被自动纠正。"
      : "Harbour 已收到并验签网页任务成品。",
  ];
  for (const [index, artifact] of (result.deliveryArtifacts ?? []).entries()) {
    lines.push(`![生成结果${(result.deliveryArtifacts?.length ?? 0) > 1 ? ` ${index + 1}` : ""}](${artifact.url})`);
  }
  if (!result.deliveryArtifacts?.length && result.artifacts?.length) {
    lines.push(`已验签成品：${result.artifacts.join("、")}`);
  }
  if (result.costAnlas !== undefined) lines.push(`页面显示成本：${result.costAnlas} Anlas。`);
  if (result.chargeState === "unknown") {
    lines.push("即时余额尚未刷新，因此扣费状态待确认；这不影响成品已完成的事实，也不会自动重试 Generate。");
  }
  if (result.deliveryError) lines.push(`成品导入聊天附件目录失败：${result.deliveryError}`);
  return lines.join("\n\n");
}

/**
 * Main 偶尔会在 token 收敛后漏掉 Controller 状态，甚至拿到 artifacts 就把 blocked
 * 改写成 completed。非 completed 状态必须被明确转述；仅出现余额/路径不算已转述。
 */
export function preserveBrowserControllerEvidence(answer: string, ctx: { agent: { name: string }; runState?: Map<string, unknown> }): string {
  if (!ctx.agent.name.startsWith("main-")) return answer;
  const record = ctx.runState?.get(AUTHORITATIVE_BROWSER_RESULT_KEY);
  if (!record || typeof record !== "object") return answer;
  const result = record as BrowserControllerResult;
  // Screenshots are evidence, not proof the whole task succeeded. Deliver them
  // even on blocked/unknown runs and even when the model forgets the links.
  const screenshots = (result.deliveryArtifacts ?? []).filter((item): item is BrowserArtifact => "kind" in item && item.kind === "image");
  const missing = screenshots.filter(item => !new RegExp(`!\\[[^\\]]*\\]\\(${item.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`).test(answer));
  if (missing.length) answer = [answer.trim(), "本轮已保存的网页截图（不代表全部检查已完成）：",
    ...missing.map((item, index) => `![网页截图 ${index + 1}](${item.url})`)].filter(Boolean).join("\n\n");
  if (result.controllerInvoked !== true || result.status === "unknown" || !result.result.trim()) return answer;

  if (result.status === "completed" && result.artifacts?.length) {
    const contradiction = completedResultContradiction(answer);
    const delivered = (result.deliveryArtifacts ?? []).some((artifact) => answer.includes(artifact.url));
    if (contradiction) {
      // 只替换有矛盾的段落，另一项问题的检查清单不能随媒体状态一起丢掉。
      const independent = answer.split(/\n\s*\n/).filter((paragraph) => !completedResultContradiction(paragraph)).join("\n\n").trim();
      return [independent, completedDeliverySummary(result, true)].filter(Boolean).join("\n\n");
    }
    if (!delivered) return `${answer.trim()}\n\n${completedDeliverySummary(result, false)}`.trim();
    return answer;
  }

  const needles = [
    ...(result.artifacts ?? []),
    result.reason,
    result.balanceBefore !== undefined ? String(result.balanceBefore) : undefined,
    result.balanceAfter !== undefined ? String(result.balanceAfter) : undefined,
  ].filter((value): value is string => typeof value === "string" && value.trim().length >= 3);
  const relayedStructuredState = answer.includes(result.status) && answer.includes(result.chargeState);
  const relayedEvidence = /BROWSER_RESULT\s+\{/i.test(answer) || relayedStructuredState || (
    result.status === "completed" && needles.some((needle) => answer.includes(needle))
  );
  if (relayedEvidence) return answer;

  const heading = result.status === "completed"
    ? "网页执行器回执（Harbour 防丢证据）"
    : "网页执行器权威状态（Harbour 校正 Main 转述）";
  return `${answer.trim()}\n\n${heading}：\n${result.result.trim()}`.trim();
}

/**
 * 把「派子 agent」做成一个普通工具。
 * 这样任何 agent 都能在 loop 里把粗活/专项活外包给另一个专精 agent，
 * 子 agent 各用各的模型与 context 预算——省主 agent 的 context，也让分流真正发生。
 *
 * 依赖 ToolContext.runAgent（由 index/demo 注入）。runAgent 内部会跑目标 agent
 * 的一整个 agentLoop 并返回它的最终答案。
 */
export function createSpawnSubagentTool(imageOptions = {
  uploadDir: path.resolve("assets/uploads"),
  maxSourceBytes: 25 * 1024 * 1024,
}, isDelegationEnabled: (name: string) => boolean = () => true): ToolDef {
return {
  name: "spawn_subagent",
  description:
    "把边界清楚的子任务交给 Subagent。指定 agent 时调用已配置的专精 Agent；省略 agent 或填 worker 时创建一次性通用执行者，并通过 tools 只授予调用方已有能力的子集。",
  // 内层先 abort 整棵子运行；外层 registry 只在它仍不响应时再兜底 reject。
  timeoutMs: SUBAGENT_TIMEOUT_MS + OUTER_TIMEOUT_GRACE_MS,
  timeoutMsFor: (args, ctx) => subagentTimeoutMs(routesBrowserToComic(String(args.agent ?? "").trim(), String(args.input ?? ""), ctx)
    ? "comic_generator" : args.agent) + OUTER_TIMEOUT_GRACE_MS,
  onReplay(result, args, ctx) {
    rememberComicSubagentOutcome(result, ctx.runState, { fromCheckpointReplay: true });
    if (result && typeof result === "object" && (result as { agent?: unknown }).agent === "comic_generator") {
      refreshComicBudgetStop(result, String(args.input ?? ""), ctx);
    }
  },
  parameters: {
    type: "object",
    properties: {
      agent: { type: "string", description: "目标 agent 名（agents/ 下的某个）" },
      input: { type: "string", description: "交给子 agent 的任务描述" },
      resumeRef: { type: "string", description: "同一子任务继续/补预算时，原样传上次返回的 taskRef；恢复原交接和已保存草稿，不重新造稿。新任务省略。" },
      images: {
        type: "array",
        maxItems: 10,
        items: { anyOf: [{ type: "integer", minimum: 0 }, { type: "string", minLength: 1 }] },
        description: "仅固定 Agent：显式传图，按顺序列本轮附件索引（从 0 起）或受控 /uploads/... URL；空数组表示不传图。不接受任意本地路径或外部 URL。",
      },
      tools: {
        type: "array",
        items: { type: "string" },
        description: "仅临时 worker 使用；显式列出它需要的工具，且必须是当前 Agent 已拥有工具的子集",
      },
    },
    required: ["input"],
  },
  async execute(args, ctx) {
    if (!ctx.runAgent) {
      throw new Error("runAgent 未注入到 ToolContext，无法派子 agent");
    }
    let agentName = String(args.agent ?? "").trim();
    let input = String(args.input ?? "");
    const requestedTools = Array.isArray(args.tools)
      ? [...new Set(args.tools.map((tool) => String(tool).trim()).filter(Boolean))]
      : [];

    // 不指定专精 Agent 时，创建无状态临时 worker。它没有自己的固定角色，也不能凭空扩权；
    // runtime 会再次校验 requestedTools 是调用方工具集的真子集，并移除递归派活/问人能力。
    if (!agentName || agentName === "worker" || agentName === "auto") {
      if (args.resumeRef !== undefined) throw new Error("resumeRef 只支持已配置的固定 Agent");
      if (args.images !== undefined) throw new Error("images 当前只支持已配置的固定 Agent，不适用于临时 worker");
      if (!ctx.runEphemeralSubagent) {
        throw new Error("临时 Subagent 入口未注入到 ToolContext");
      }
      const key = `worker:${ctx.agent.name}\0${requestedTools.sort().join(",")}\0${input}`;
      const running = inFlight.get(key);
      if (running && running.signal === ctx.signal) {
        ctx.logger.warn({ from: ctx.agent.name, tools: requestedTools }, "spawn_subagent:worker:dedup");
        return running.promise;
      }
      ctx.logger.info({ from: ctx.agent.name, tools: requestedTools }, "spawn_subagent:worker");
      const promise = runCancellableSubagent(ctx.signal, (childSignal) =>
        ctx.runEphemeralSubagent!(ctx.agent, input, requestedTools, childSignal, ctx.execution)
      )
        .then((result) => ({ agent: "worker", result }))
        .finally(() => { if (inFlight.get(key)?.promise === promise) inFlight.delete(key); });
      inFlight.set(key, { promise, signal: ctx.signal });
      return promise;
    }

    // Read the live switch, not the caller's potentially stale native-session catalog.
    if (!isDelegationEnabled(agentName)) return delegationPaused(agentName);

    if (requestedTools.length) {
      throw new Error("tools 只适用于临时 worker；已配置专精 Agent 的能力由其 agents/<name>/ 清单决定");
    }

    // 模型即使错误地把“六格漫画”编译成 NovelAI 单画布任务，也不能真的提交该表单。
    // 在副作用前把它改派给漫画导演；导演再通过私有 Workflow 逐格生成。
    if (routesBrowserToComic(agentName, input, ctx)) {
      if (ctx.agent.workflows?.some(workflow => workflow.name === "novelai-generation") &&
          !ctx.agent.subagents?.some(agent => agent.name === "comic_generator")) {
        return { agent: agentName, status: "redirect", terminal: false, controllerInvoked: false, retrySafety: "safe",
          reason: MULTI_PANEL_COMIC_ROUTE_REASON,
          nextAction: { tool: "run_workflow", arguments: { name: "novelai-generation", action: "start", input: { kind: "comic", request: input } } },
        };
      }
      const originalInput = input;
      agentName = "comic_generator";
      input = [
        "[Harbour deterministic comic route]",
        MULTI_PANEL_COMIC_ROUTE_REASON,
        "下面是 Main 错误编译出的单画布任务。忽略其中要求单张网格、comic page 或批量同构图的字段；提取故事、角色和分镜意图，重新冻结为独立 Panels 后调用 comic-generation Workflow。",
        "",
        originalInput,
      ].join("\n");
      ctx.logger.warn({ from: ctx.agent.name, requested: "browser_controller", routedTo: agentName }, "spawn_subagent:comic:auto-route");
    }

    // 固定 Agent 的挂载与 Tool/Skill 一样是能力边界，而不是给模型看的建议。
    // Main 必须显式拥有 subagents/index.md；索引缺失或目标未挂载都 fail closed。
    // 非 Main 只有在自己声明了索引时才收窄，保留旧专精 Agent 的兼容行为。
    if (!isDelegationEnabled(agentName)) return delegationPaused(agentName);
    const mountedSubagents = ctx.agent.subagents?.filter(candidate => isDelegationEnabled(candidate.name));
    const requiresMount = ctx.agent.name.startsWith("main-") || mountedSubagents !== undefined;
    if (requiresMount && !mountedSubagents?.some((candidate) => candidate.name === agentName)) {
      return {
        agent: agentName,
        refused: true,
        status: "refused",
        controllerInvoked: false,
        reason: `「${agentName}」未挂载到 ${ctx.agent.name} 的 subagents/index.md，已拒绝派发。`,
        allowedSubagents: (mountedSubagents ?? []).map((candidate) => candidate.name),
      };
    }

    // Validate explicit media before reserving any one-shot Browser/Workflow dispatch.
    const selectedImages = args.images !== undefined
      ? await resolveSubagentImages(args.images, ctx, imageOptions)
      : undefined;

    // Main 的网页协议是“一次性交付完整目标”。Controller 已经失败后再派第二个，只会
    // 从头重放几十步网页操作（写操作甚至可能重复提交），也是 QQ 长时间无回复的根因。
    // 只限制 Main → browser_controller；comic_generator 等导演型 Agent 仍可按分镜多次出图。
    if (agentName === "browser_controller" && ctx.agent.name.startsWith("main-")) {
      const onceKey = `spawn_subagent:once:${agentName}`;
      if (ctx.runState?.has(onceKey)) {
        return {
          agent: "browser_controller",
          refused: true,
          status: "refused",
          terminal: true,
          controllerInvoked: false,
          reason: "本轮已经交接过完整网页目标，不能从头重复派发。符合条件的 DSH 长任务由原 Controller 内部分段继续；若已返回阻塞，以原回执的具体原因交接，不把新一轮当作可安全重放的授权。",
          instruction: "这只是防重放护栏，没有启动第二个 Controller。此前第一次 spawn_subagent 的结构化结果仍是本轮唯一权威结果；不得描述成‘第二次 Controller 没有返回’。",
        };
      }
      ctx.runState?.set(onceKey, true);
    }

    // ① 禁自派：orchestrator 曾把 main-elaina 写进 plan 的「派谁」，主 agent 照办就是
    //    自己派自己 → 无限递归，每层还占一个 10 分钟窗口。list_agents 已经不列 main-*，
    //    这里再兜一道（模型也可能凭记忆写名字）。
    if (agentName === ctx.agent.name) {
      return {
        refused: true,
        reason: `不能派给你自己（${agentName}）。这一步本就该你【亲自做】，直接做就行，别绕一圈。`,
      };
    }

    // Orchestrator 既要看 worker 的能力目录（list_agents），也要知道本次调用方 Main
    // 自己能执行哪些 Tool/Skill/MCP，才能正确规划 agent=self。自动附加快照，避免 Main
    // 每次手抄能力清单，也不必把 main-* 放进可派花名册而重新引入自派递归。
    let delegatedInput = agentName === "orchestrator"
      ? `${input}\n\n[Harbour 调用上下文｜系统生成]\n${JSON.stringify({
          caller: ctx.agent.name,
          selfCapabilities: {
            tools: ctx.agent.tools ?? [],
            skills: (ctx.agent.skills ?? []).map((s) => ({ name: s.name, description: s.description })),
            workflows: (ctx.agent.workflows ?? []).map((workflow) => ({
              name: workflow.name,
              description: workflow.description,
              version: workflow.version,
            })),
            subagents: (ctx.agent.subagents ?? []).map((agent) => ({ name: agent.name, description: agent.description })),
            mcp: (ctx.agent.mcpServers ?? []).map((s) => ({
              name: s.name,
              description: s.description ?? "",
              tools: s.allow ?? [],
            })),
          },
        })}`
      : input;
    // Browser tab/onceKey isolation remains per invocation, not a resumable model task.
    const taskCapability = ctx.execution?.delegationTasks;
    const tasks = agentName !== "browser_controller" &&
      (!taskCapability?.eligibleAgents || taskCapability.eligibleAgents.includes(agentName)) ? taskCapability : undefined;
    let savedTask: DelegationTask | undefined;
    const operationKey = currentCheckpointOperationId();
    if (tasks && operationKey && args.resumeRef === undefined) {
      savedTask = await tasks.store.findByOperation(tasks.scope, operationKey);
      if (savedTask && savedTask.agent !== agentName) throw new Error("断点子任务与目标 Agent 不一致");
    }
    if (args.resumeRef !== undefined) {
      if (!tasks || typeof args.resumeRef !== "string") throw new Error("resumeRef 缺少可信会话任务范围");
      savedTask = await tasks.store.get(tasks.scope, args.resumeRef);
      if (savedTask.agent !== agentName) throw new Error("resumeRef 不属于目标 Agent");
    } else if (tasks && !savedTask && /(?:继续|续跑|恢复|沿用|上次|此前|\bresume\b|\bcontinue\b)/iu.test(input)) {
      const candidates = await tasks.store.list(tasks.scope, { agents: [agentName], status: "open" });
      if (candidates.length) return {
        agent: agentName, status: "needs_input", terminal: true, delegateInvoked: false,
        reason: "这是续接请求，但未指定已保存的子任务引用。请用 resumeRef 明确恢复同一任务，不凭摘要重建。",
        candidates: candidates.map(({ ref, agent }) => ({ resumeRef: ref, agent })),
        instruction: "从本会话任务索引选择相符引用后重新调用；只有存在多个无法区分的任务时才询问用户。",
      };
    }

    // 完成回执已经进入本轮 runState 后，同一 job 的“再查一次/再取一次”只能读缓存。
    // 这不是跨轮缓存，也不会拦截同一轮里另一个新漫画；它只消除模型对已完成副作用的重复派发。
    if (agentName === "comic_generator") {
      const budgetContinuation = hasExplicitComicBudget(input) || hasExplicitComicJob(input);
      const hadScopedBudgetStop = ctx.runState?.has(COMIC_BUDGET_STOP_KEY) === true;
      const budgetStop = rememberedComicBudgetStop(input, ctx.runState);
      const switchedBudgetTask = hadScopedBudgetStop && !budgetStop && !budgetContinuation;
      if (budgetStop && !budgetContinuation) {
        return {
          ...budgetStop,
          delegateInvoked: false,
          instruction: "本轮已由漫画导演明确要求补充数字总预算；已返回原回执，未再次启动导演或 Workflow。请按 nextAction 集中询问预算上限。",
        };
      }
      // Once the caller supplies a budget/job or clearly switches task scope, the old
      // no-budget receipt is no longer a valid fallback even if the new delegation fails.
      ctx.runState?.delete(COMIC_BUDGET_STOP_KEY);
      const previous = rememberedComicOutcome(ctx.runState);
      const explicitSafeCheckpointResume = previous?.restoredFromCheckpoint && previous.retrySafety === "safe" && previous.jobId &&
        delegatedInput.includes(previous.jobId) && /(?:\bRESUME_COMIC\b|\bresume\b|继续|恢复)/iu.test(input);
      const promptRecovery = ctx.execution?.novelAiPromptRecovery;
      const verifiedPromptResume = promptRecovery && savedTask && args.resumeRef === savedTask.ref &&
        promptRecovery.taskRef === savedTask.ref && promptRecovery.jobId === previous?.jobId && previous.retrySafety === "safe";
      if (previous?.authoritative && previous.terminal && previous.status !== "completed" &&
          (previous.jobId || previous.retrySafety === "uncertain") && !explicitSafeCheckpointResume && !verifiedPromptResume &&
          !(previous.reasonCode === "budget_required" && (budgetContinuation || switchedBudgetTask))) {
        return {
          ...previous,
          delegateInvoked: false,
          instruction: "本轮已有权威停住状态，已返回原 job 的进度、成本和产物；未启动新导演。不得无 jobId 重派、自动恢复或重放；向用户报告此回执。",
        };
      }
      const completed = rememberedComicDelivery(ctx.runState);
      if (completed?.jobId && delegatedInput.includes(completed.jobId)) {
        const result = {
          ...normalizeComicGeneratorResult(completed.canonical),
          delegateInvoked: false,
          instruction: "该 job 已在本轮完成，已从权威交付缓存返回；直接最终回复，禁止再次派发或查询。",
        };
        rememberComicSubagentOutcome(result, ctx.runState);
        return result;
      }
    }

    if (tasks && !savedTask) {
      savedTask = await tasks.store.create(tasks.scope, { agent: agentName, input: delegatedInput,
        operationKey: currentCheckpointOperationId(), executionIntent: ctx.execution?.novelAiIntent, novelAiPolicy: ctx.execution?.novelAiPolicy,
        ...(["novelai_artist", "comic_generator"].includes(agentName) && ctx.execution?.novelAiContentRating
          ? { novelAiContentRating: ctx.execution.novelAiContentRating } : {}) });
    }
    if (savedTask && (args.resumeRef !== undefined || savedTask.revision > 1)) delegatedInput = restoredDelegationInput(savedTask, delegatedInput);

    // 网页上传只能使用“本轮用户明确提交”的图片附件。comic_generator 需要把当前轮
    // 参考图继续下授给 browser_controller，因此只给这两个固定 Agent 图片 grant；
    // 不灌 Main 历史附件，也不把本地路径能力扩散给其它 subagent。
    const acceptsCurrentImages = ["browser_controller", "comic_generator", "novelai_artist"].includes(agentName);
    let delegatedAttachments = acceptsCurrentImages
      ? ctx.attachments?.filter((attachment) => attachment.kind === "image").map((attachment) => ({ ...attachment }))
      : undefined;
    if (selectedImages) {
      delegatedAttachments = selectedImages.attachments;
      if (selectedImages.sources.length) {
        // Source labels describe actual attached pixels, never grant file/browser tools.
        delegatedInput += `\n\n[Harbour 已传入图片映射]\n${JSON.stringify(selectedImages.sources.map(({ sha256: _sha, ...source }) => source))}`;
      }
    }

    // 同文不同图不能合并。使用验签后的内容标识，同时保留来源/顺序语义。
    const imageKey = (delegatedAttachments ?? []).map((image) => ({
      hash: image.image?.sha256, url: image.url, name: image.name,
    }));
    const authoringRating = ["novelai_artist", "comic_generator"].includes(agentName)
      ? savedTask ? savedTask.novelAiContentRating : ctx.execution?.novelAiContentRating : undefined;
    const key = `${agentName}\0${delegatedInput}\0${JSON.stringify(imageKey)}${authoringRating ? `\0contentRating:${authoringRating}` : ""}`;
    const running = inFlight.get(key);
    // 只在【同一个 signal】下复用（同一轮 run 内的重试）。不同 signal（另一轮 / 另一个 tab）
    // 复用会串信号：本方停止取消不了它、别人停止又 abort 掉本方等的结果。跨 run 各跑各的。
    if (running && running.signal === ctx.signal) {
      ctx.logger.warn({ from: ctx.agent.name, to: agentName }, "spawn_subagent:dedup");
      return running.promise.then((result) => agentName === "comic_generator"
        ? { ...result, delegateInvoked: false }
        : result);
    }

    const durableTaskKey = savedTask && tasks ? `${tasks.scope}\0${savedTask.ref}` : undefined;
    if (durableTaskKey && activeDurableTasks.has(durableTaskKey)) throw new Error("该子任务仍在执行，不能并发恢复或重放；请等待当前回执。");
    if (durableTaskKey) activeDurableTasks.add(durableTaskKey);

    ctx.logger.info({ from: ctx.agent.name, to: agentName }, "spawn_subagent");
    // 用户显式选择 Codex Harness 时，视觉生成链必须整棵沿用：Main → 漫画导演 →
    // Browser Controller。否则导演会退回默认文本模型，Controller 也拿不到 App Server
    // dynamic-tool 回传的真实图片像素，只能看路径/尺寸便误判质量。其它 Subagent 仍保留自身模型。
    const inheritsCodexHarness = ["browser_controller", "comic_generator", "novelai_artist"].includes(agentName);
    const inheritedModel = inheritsCodexHarness && ctx.modelRef?.startsWith("codex-app-server/")
      ? ctx.modelRef
      : undefined;
    const comicMustExecuteWorkflow = agentName === "comic_generator" && (
      COMIC_EXECUTION_ACTION.test(input) ||
      hasExplicitComicBudget(input) ||
      (hasExplicitComicJob(input) && /(?:\bRESUME_COMIC\b|\bresume\b|继续|恢复)/iu.test(input))
    );
    // Cowork's persistent Browser host needs one scope per real delegation, not per agent
    // name. Binding it to the enclosing checkpoint step preserves that scope on resume,
    // while different sibling Browser calls can never share tabs/onceKeys/materialized images.
    const remoteCowork = ctx.execution?.cowork && ctx.execution.cowork.deviceId !== "server";
    const delegationId = remoteCowork && inheritsCodexHarness
      ? `cowork-delegation-${createHash("sha256").update(currentCheckpointOperationId() ?? randomUUID()).digest("hex").slice(0, 40)}`
      : ["comic_generator", "novelai_artist"].includes(agentName) ? randomUUID() : undefined;
    const sharedToolEvidence = ctx.execution?.toolEvidence ?? new Map<string, unknown>();
    if (ctx.execution) ctx.execution.toolEvidence = sharedToolEvidence;
    const childExecutionBase = delegationId
      ? { ...ctx.execution, toolEvidence: sharedToolEvidence, subagentDelegationId: delegationId }
      : ctx.execution;
    const browserArtifacts: BrowserArtifact[] = [];
    const scopedExecution = agentName === "browser_controller"
      ? { ...childExecutionBase, browserArtifacts, browserContinuation: browserStepContinuation(ctx) } : childExecutionBase;
    const planCapture = beginSubmittedPlanCapture(savedTask && tasks
      ? { ...scopedExecution, delegationTasks: { ...tasks, taskRef: savedTask.ref } }
      : scopedExecution ? { ...scopedExecution, delegationTasks: undefined } : undefined, agentName);
    const childExecution = planCapture.execution;
    const submittedPlanReceipt = (result: string, failure?: { status: "failed" | "interrupted"; error: string }) => {
      const submitted = planCapture.finish();
      if (!submitted) return undefined;
      return {
        agent: agentName,
        result,
        status: failure?.status ?? submitted.outcome,
        terminal: true,
        planStatus: "submitted",
        submittedPlan: submitted.plan,
        ...(failure ? { error: failure.error } : {}),
        instruction: "submittedPlan 是该子任务已确认提交的计划，不能说没有计划；它不证明任何步骤已执行。子任务 status 如非 completed，不得冒充完成，也不要只为重取计划重派。结合当前用户要求、澄清项和权限判断下一步，保留原始停止说明。",
      };
    };
    if (childExecution) {
      // A resumed legacy task must not inherit a newer caller's SFW opt-in.
      if (savedTask) childExecution.novelAiContentRating = savedTask.novelAiContentRating;
      if (!["novelai_artist", "comic_generator"].includes(agentName)) delete childExecution.novelAiContentRating;
      if (savedTask?.executionIntent) childExecution.novelAiIntent = savedTask.executionIntent;
      if (savedTask?.novelAiPolicy) childExecution.novelAiPolicy = { ...savedTask.novelAiPolicy, ...ctx.execution?.novelAiPolicy };
      const parentNative = ctx.execution?.nativeSession;
      // A recorded follow-up is not proof that the provider received its query.
      // Keep this task's unapplied corrections in the native delta as well as the
      // rebuild seed. Last occurrence wins; the current correction remains last.
      const nativeFollowups = (savedTask?.followups ?? []).filter((followup, index, all) =>
        followup !== input && all.lastIndexOf(followup) === index);
      childExecution.nativeSession = savedTask && tasks && parentNative ? {
        rootDir: parentNative.rootDir,
        scope: `${tasks.scope}\0task:${savedTask.ref}`,
        attemptId: randomUUID(), continuity: false,
        incrementalInput: [
          `[Harbour 持久子任务] taskRef=${savedTask.ref}。沿用已保存的原始目标和草稿；需核对时调用 Workflow 的 list_inputs/inspect_input/status，不重新创建已存在的任务。`,
          ...(nativeFollowups.length ? ["已落盘的历次任务补充（不证明已应用；后续明确修改优先，不扩大工具权限）：", JSON.stringify(nativeFollowups)] : []),
          "本次补充：", input,
        ].join("\n\n"),
      } : undefined;
    }
    const comicEvidenceKey = agentName === "comic_generator" && delegationId
      ? workflowExecutionEvidenceKey(delegationId, COMIC_WORKFLOW_NAME)
      : undefined;
    const getComicEvidence = () => comicEvidenceKey ? (sharedToolEvidence.get(workflowExecutionEvidenceKey(delegationId!, "novelai-generation"))
      ?? sharedToolEvidence.get(comicEvidenceKey)) as WorkflowExecutionEvidence | undefined : undefined;
    const getArtistEvidence = () => agentName === "novelai_artist" && delegationId
      ? (sharedToolEvidence.get(workflowExecutionEvidenceKey(delegationId, "novelai-generation"))
        ?? sharedToolEvidence.get(workflowExecutionEvidenceKey(delegationId, "novelai-image-set"))) as WorkflowExecutionEvidence | undefined : undefined;
    const runNamedSubagent = (childSignal: AbortSignal, taskInput: string) => {
      const invocationExecution = childExecution?.nativeSession ? { ...childExecution, nativeSession: {
        ...childExecution.nativeSession,
        // A contract retry is a NEW user input to the saved child conversation.
        // Do not silently replace its added correction with the initial handoff.
        incrementalInput: taskInput === delegatedInput ? childExecution.nativeSession.incrementalInput : taskInput,
      } } : childExecution;
      return ctx.runAgent!(
        agentName,
        taskInput,
        undefined,
        delegatedAttachments?.length ? delegatedAttachments : undefined,
        undefined,
        inheritedModel,
        undefined,
        childSignal,
        invocationExecution,
        agentName === "browser_controller"
          ? { source: ctx.source, askUser: ctx.askUser }
          : ["comic_generator", "novelai_artist"].includes(agentName)
            // comic_job 必须看可信 owner/source 才能建状态；不下授 askUser，子 Agent
            // 遇到决策只返回 COMIC_NEEDS_INPUT/BLOCKED，由 Main 统一问人。
            ? { source: ctx.source, taskRef: savedTask?.ref }
            : savedTask ? { taskRef: savedTask.ref } : undefined
        );
    };
    let interrupted = false;
    let failedPlanReceipt: ReturnType<typeof submittedPlanReceipt>;
    const promise = runCancellableSubagent(ctx.signal, async (childSignal) => {
      childSignal.throwIfAborted();
      // Only an authorized, actually launched director extends this queue's wait.
      // Replayed receipts and rejected/deduplicated dispatches never grant more time.
      if (["comic_generator", "novelai_artist"].includes(agentName)) {
        ctx.execution?.deadline?.ensureRemaining(COMIC_DIRECTOR_TIMEOUT_MS + OUTER_TIMEOUT_GRACE_MS);
      }
      if (savedTask && tasks && args.resumeRef !== undefined) {
        childSignal.throwIfAborted();
        await tasks.store.recordFollowup(tasks.scope, savedTask.ref, input);
      }
      let result = await runNamedSubagent(childSignal, delegatedInput);
      if (comicMustExecuteWorkflow && comicEvidenceKey && !getComicEvidence()) {
        const stopped = normalizeComicGeneratorResult(result);
        if (stopped.status === "blocked" && stopped.reason) return result;
        ctx.logger.warn({ from: ctx.agent.name, to: agentName }, "spawn_subagent:comic:missing-workflow→retry");
        result = await runNamedSubagent(childSignal, [
          delegatedInput,
          "",
          "[Harbour contract retry]",
          "上一轮没有产生 run_workflow 工具证据，因此回执不被接受。预算已给出：本轮禁止直接输出 COMIC_* 或自行估价；先冻结完整分镜，然后必须实际调用已挂载的 run_workflow 执行计划，最终只转述工具的结构化结果。",
        ].join("\n"));
      }
      return result;
    }, subagentTimeoutMs(agentName))
      .catch(async (error) => {
        if (agentName === "novelai_artist") {
          const evidence = getArtistEvidence();
          await settleWorkflowExecutionEvidence(evidence, WORKFLOW_SETTLEMENT_GRACE_MS);
          if (evidence?.phase === "completed") return JSON.stringify(evidence.result);
          return "IMAGE_INTERRUPTED";
        }
        if (agentName !== "comic_generator" || !comicEvidenceKey) {
          // Only a confirmed submit_plan can turn a child exception into a useful
          // failed receipt. Browser/Workflow execution contracts remain unchanged.
          if (agentName === "browser_controller") {
            if (ctx.signal?.aborted || !browserArtifacts.length) throw error;
            ctx.logger.warn({ err: String(error).slice(0, 500) }, "browser:interrupted-with-artifacts");
            return `BROWSER_RESULT ${JSON.stringify({ status: "unknown", chargeState: "unknown", artifacts: [],
              reason: "浏览器执行中断；已有截图已保存，但任务完成情况及外部副作用尚未确认，禁止从头重放。" })}`;
          }
          const message = error instanceof Error ? error.message : String(error);
          const aborted = ctx.signal?.aborted === true;
          failedPlanReceipt = submittedPlanReceipt(message, { status: aborted ? "interrupted" : "failed", error: message });
          if (!failedPlanReceipt) throw error;
          if (aborted) {
            // A user stop must remain a rejection: never wake Main to execute this
            // proposal. The completed submit_plan checkpoint still contains it.
            // Durable delegations also keep this receipt without claiming success.
            if (savedTask && tasks) {
              try {
                await tasks.store.update(tasks.scope, savedTask.ref, { result: JSON.stringify(failedPlanReceipt), status: "open" });
              } catch (persistError) {
                ctx.logger.warn({ agent: agentName, error: String(persistError) }, "spawn_subagent:interrupted-plan-persist-failed");
              }
            }
            if (error && typeof error === "object") {
              try { Object.defineProperty(error, "submittedPlanReceipt", { value: failedPlanReceipt, configurable: true }); }
              catch { /* A frozen provider error must not replace the original abort. */ }
            }
            throw error;
          }
          return message;
        }
        interrupted = true;
        const evidence = getComicEvidence();
        // Model cancellation races its dynamic tool's cleanup. Wait only for that
        // existing operation, within the outer timeout grace; never start another.
        await settleWorkflowExecutionEvidence(evidence, WORKFLOW_SETTLEMENT_GRACE_MS);
        const message = error instanceof Error ? error.message : String(error);
        const canonical = evidence ? comicWorkflowCanonical(evidence, message) : undefined;
        ctx.logger.warn({ workflow: COMIC_WORKFLOW_NAME, phase: evidence?.phase, jobId: evidence?.jobSnapshot?.jobId }, "spawn_subagent:workflow-interruption-preserved");
        return canonical ?? `COMIC_BLOCKED ${JSON.stringify({
          reason: `导演运行中断：${message}。没有可核实的 Workflow 结算；不得宣称未扣费或从头重派。`,
          retrySafety: "uncertain",
        })}`;
      })
      .then(async (result) => {
        if (failedPlanReceipt) return failedPlanReceipt;
        if (agentName === "comic_generator") {
          const workflowEvidence = comicEvidenceKey
            ? getComicEvidence()
            : undefined;
          if (comicMustExecuteWorkflow && !workflowEvidence) {
            const stopped = normalizeComicGeneratorResult(result);
            if (stopped.status === "blocked" && stopped.reason) return { ...stopped, ...(interrupted ? { authoritative: true } : {}) };
            return {
              agent: "comic_generator",
              status: "blocked",
              terminal: true,
              retrySafety: "safe",
              reason: "comic_generator 连续两次未调用必需的 comic-generation Workflow；没有启动 Browser 或付费操作。",
              instruction: "不得采用导演自行撰写的 COMIC_* 或声称 Workflow 已执行；向用户报告内部执行契约未满足。",
              result,
            } satisfies ComicGeneratorResult;
          }
          if (workflowEvidence?.phase === "completed" && workflowEvidence.result?.generated === false) {
            return { agent: agentName, result, ...workflowEvidence.result };
          }
          const authoritative = workflowEvidence ? comicWorkflowCanonical(workflowEvidence) : undefined;
          if (workflowEvidence?.phase === "failed" && !authoritative) {
            return {
              agent: "comic_generator",
              status: "blocked",
              terminal: true,
              retrySafety: "uncertain",
              ...(interrupted ? { authoritative: true } : {}),
              reason: `comic-generation Workflow 调用失败：${workflowEvidence.error ?? "未知错误"}`,
              instruction: "以 Workflow 工具证据为准；不得把失败改写成完成，也不得自动重放可能有副作用的执行。",
              result,
            } satisfies ComicGeneratorResult;
          }
          if (authoritative) result = authoritative;
          const normalized = normalizeComicGeneratorResult(result, { structuredExecutionBoundary: authoritative !== undefined });
          const safeNoWorkflowBudgetStop = !workflowEvidence && normalized.status === "needs_input" &&
            normalized.reasonCode === "budget_required";
          return {
            ...normalized,
            ...(safeNoWorkflowBudgetStop ? {
              retrySafety: "safe" as const,
              instruction: "漫画导演明确要求补充数字总预算，且本次委派没有 comic-generation Workflow 工具证据；未进入其 Browser 付费步骤。按 nextAction 集中询问预算，不要再次启动导演。",
            } : {}),
            ...(authoritative || interrupted ? { authoritative: true } : {}),
          };
        }
        if (agentName === "novelai_artist") {
          const evidence = getArtistEvidence();
          if (evidence?.result?.executionStarted === false) return { agent: agentName, result,
            ...(evidence.jobSnapshot ?? evidence.result), lastError: evidence.result };
          if (evidence?.phase === "completed" && evidence.result) return { agent: agentName, result, ...evidence.result };
          if (evidence) return { agent: agentName, result, ...evidence.jobSnapshot,
            status: "blocked", terminal: true, retrySafety: "uncertain",
            reason: evidence.error ?? "插画 Workflow 尚未完成结算；已保留任务，不得重新生成。" };
          const match = /^IMAGE_NEEDS_INPUT\s+(\{[\s\S]*\})\s*$/.exec(result.trim());
          if (match) {
            try {
              const question = JSON.parse(match[1]!);
              if (typeof question.reason === "string" && question.reason.trim()) return {
                agent: agentName, result, status: "needs_input", terminal: true, retrySafety: "safe", reason: question.reason,
              };
            } catch { /* malformed text is not execution evidence */ }
          }
          return { agent: agentName, result, status: "blocked", terminal: true,
            retrySafety: result === "IMAGE_INTERRUPTED" ? "uncertain" : "safe",
            reason: "插画创作节点没有返回可验证的 Workflow 执行结果；没有以文本冒充成品。" };
        }
        if (agentName !== "browser_controller") {
          return submittedPlanReceipt(result) ?? { agent: agentName, result };
        }
        let normalized = normalizeBrowserControllerResult(result);
        const limits = childExecution?.browserContinuation?.used ? childExecution.browserContinuation.snapshot() : undefined;
        if (limits) normalized = { ...normalized, executionLimits: limits };
        if (limits?.incomplete) {
          const reason = `Controller 运行未完成（${limits.incomplete}）；已保留同次运行的报告与截图，不得从头重放。`;
          normalized = { ...normalized, status: "blocked", artifactVerified: false, reason,
            instruction: `${reason} 只交付已确认的部分结果，不能宣称通关或全部验收完成。`,
            result: `BROWSER_RESULT ${JSON.stringify({ status: "blocked", chargeState: normalized.chargeState,
              artifacts: normalized.artifacts ?? [], reason })}` };
        }
        if (browserArtifacts.length) normalized = { ...normalized, deliveryArtifacts: [...browserArtifacts],
          instruction: `${normalized.instruction} deliveryArtifacts 是本轮实际保存的截图，最终回答须用 Markdown 图片引用 URL；即使任务未完成也交付已有证据，不因此升级任务状态。` };
        // Main 的普通 NovelAI 插画在工具边界确定性导入。不能再把“记得调用导入脚本”
        // 当成模型责任：一旦模型在长轮次里漏读回执，成品就会只留在临时下载目录。
        if (ctx.agent.name.startsWith("main-") && normalized.status === "completed" && normalized.artifacts?.length) {
          const delivery = await publishNovelAiArtifacts(input, normalized.artifacts);
          if (delivery.attempted) {
            if (delivery.failureKind === "resolution_mismatch") {
              const reason = delivery.error ?? "NovelAI 只回收到了页面预览图，未获得目标像素原图。";
              normalized = {
                ...normalized,
                status: "blocked",
                artifactVerified: false,
                artifacts: undefined,
                deliveryArtifacts: undefined,
                deliveryError: reason,
                reason,
                instruction: "权威结果：Generate 已经提交，但仅回收到页面预览图；不得宣称完成、不得交付该预览，也不得自动重试扣费。请如实报告结果回收被阻塞。",
                result: `BROWSER_RESULT ${JSON.stringify({
                  status: "blocked",
                  chargeState: normalized.chargeState,
                  balanceBefore: normalized.balanceBefore ?? null,
                  balanceAfter: normalized.balanceAfter ?? null,
                  costAnlas: normalized.costAnlas ?? null,
                  artifacts: [],
                  expectedResolution: delivery.expectedResolution ?? null,
                  observedDimensions: delivery.observedDimensions ?? [],
                  reason,
                })}`,
              };
            } else {
              normalized = {
                ...normalized,
                ...(delivery.artifacts.length ? { deliveryArtifacts: delivery.artifacts } : {}),
                ...(delivery.error ? { deliveryError: delivery.error } : {}),
                instruction: delivery.artifacts.length
                  ? "权威结果：生成与验签均已完成，deliveryArtifacts 已确定性导入；最终回答必须直接引用其中 URL。chargeState=unknown 只表示账务刷新延迟，不得说没有结果，也不要再次运行导入脚本。"
                  : `${normalized.instruction} 自动导入未成功，必须如实报告 deliveryError，但不得把已完成的生成改写成未返回。`,
              };
            }
          }
        }
        ctx.runState?.set(AUTHORITATIVE_BROWSER_RESULT_KEY, normalized);
        return normalized;
      })
      .then(async (result) => {
        // 包括缺失/失败 Workflow 的早返回；只有真实返回结果才能进入最终转述兜底。
        const actual = agentName === "comic_generator"
          ? { ...result, delegateInvoked: true }
          : result;
        if (agentName === "comic_generator") refreshComicBudgetStop(actual, input, ctx);
        if (agentName === "comic_generator") rememberComicSubagentOutcome(actual, ctx.runState);
        if (savedTask && tasks) {
          const latest = await tasks.store.get(tasks.scope, savedTask.ref);
          const complete = latest.workflowResults.length > 0 && latest.workflowResults.every((entry) => entry.result.status === "completed");
          const saved = await tasks.store.update(tasks.scope, savedTask.ref, {
            result: JSON.stringify(actual), status: complete ? "completed" : "open",
          });
          const draftFeedback = agentName === "novelai_artist"
            ? takeNovelAiDraftFeedback(childExecution, { scope: tasks.scope, task: saved, workflow: "novelai-generation" },
              actual, getArtistEvidence()) : {};
          return { ...actual, ...delegationTaskReceipt(saved), ...draftFeedback };
        }
        return actual;
      })
      .finally(() => {
        planCapture.finish();
        if (durableTaskKey) activeDurableTasks.delete(durableTaskKey);
        if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
      });
    inFlight.set(key, { promise, signal: ctx.signal });
    return promise;
  },
};
}

export const spawnSubagentTool = createSpawnSubagentTool();

/**
 * 进行中的子 agent 调用：key = agent + input + image identities。
 * 唯一目的是让「超时后重试」复用那份还在跑的 run，而不是每次重试都叠一个孤儿。
 * 真正的取消要给 RunAgent 加 AbortSignal —— 那是更大的改动，先用去重把出血点堵上。
 */
const inFlight = new Map<string, { promise: Promise<{ agent: string; result: string }>; signal?: AbortSignal }>();
const activeDurableTasks = new Set<string>();
