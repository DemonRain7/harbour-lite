import type { ToolContext } from "../../types";
import { novelAiPromptBudgetOverflowReport } from "../novelAiPromptBudget";
import { OpenCliCommandTimeoutError } from "./openCliProcess";

export type PreparationStage = "model" | "references" | "characters" | "settings" | "prompt-fill" | "token-audit" | "final-verification";
interface Progress {
  tab: string;
  started: number;
  stage: PreparationStage;
  field?: string;
  commands: number;
  commandMs: number;
  stages: Partial<Record<PreparationStage, { commands: number; elapsedMs: number }>>;
}
const progress = new WeakMap<ToolContext, Progress>();
const interruptedKey = "novelai:interrupted-preparation-tabs";

/** Shared by the command observer and outer host-scope cleanup failures. */
export function markNovelAiPreparationInterrupted(ctx: ToolContext, tab = "default"): void {
  ctx.runState ??= new Map();
  let tabs = ctx.runState.get(interruptedKey) as Set<string> | undefined;
  if (!tabs) ctx.runState.set(interruptedKey, tabs = new Set());
  tabs.add(tab || "default");
}

/** A mutating preparation batch ran but its receipt cannot confirm completion.
 * Deliberately typed so ordinary validation failures do not lock the page. */
export class NovelAiPreparationBatchReceiptError extends Error {
  constructor() {
    super("NovelAI 表单批量准备回执不完整；不得通过旧路径重放，未确认准备成功。");
    this.name = "NovelAiPreparationBatchReceiptError";
  }
}

/** Partial DOM state after cancellation is not a new submission opportunity. */
export function assertNovelAiPreparationUsable(ctx: ToolContext, action: string, tab = "default"): void {
  tab ||= "default";
  if (!["prepare_novelai_form", "prepare_character_prompts", "upload_character_reference", "upload_attachment", "generate_novelai", "execute_novelai",
    "open", "goto", "back", "click", "activate", "download", "focus", "fill", "fill_richtext", "type", "check", "uncheck", "select", "press"].includes(action)) return;
  const tabs = ctx.runState?.get(interruptedKey) as Set<string> | undefined;
  // Omitted tab aliases the current page; it cannot evade an explicit-tab stop.
  if (tabs?.has(tab) || tabs?.has("default") || (tab === "default" && !!tabs?.size)) {
    throw new Error("本轮该页面的表单准备已超时、取消或回执异常，可能只完成了一部分；停止重复准备、上传或 Generate，并交回 Workflow。未提交时没有新生成图可查找；由 Main 明确继续原 Job 后在新 Browser 运行中重新核验。");
  }
}

/** Instrumentation only: no prompt, selector, URL, token or credential contents. */
export function preparationStage(ctx: ToolContext, stage: PreparationStage, field?: string): void {
  const current = progress.get(ctx);
  if (!current) return;
  current.stage = stage;
  current.field = field && /^(positive|negative)\/(base|character:[1-6])$/.test(field) ? field : undefined;
}

export async function preparationCommand<T>(ctx: ToolContext, operation: () => Promise<T>): Promise<T> {
  ctx.signal?.throwIfAborted();
  const current = progress.get(ctx);
  if (!current) return operation();
  // A same-page sibling may have failed after this invocation passed the entry
  // guard. Recheck at dispatch; another explicit tab keeps its own progress.
  assertNovelAiPreparationUsable(ctx, "prepare_novelai_form", current.tab);
  const stage = current.stage;
  const started = Date.now();
  current.commands++;
  try { return await operation(); }
  finally {
    const elapsedMs = Date.now() - started;
    current.commandMs += elapsedMs;
    const summary = current.stages[stage] ??= { commands: 0, elapsedMs: 0 };
    summary.commands++;
    summary.elapsedMs += elapsedMs;
  }
}

export async function observeNovelAiPreparation<T>(ctx: ToolContext, operation: (ctx: ToolContext) => Promise<T>, tab = "default"): Promise<T> {
  tab ||= "default";
  // Calls may run concurrently against the same parent context. Preserve shared
  // tool state, but never share this per-invocation instrumentation or signal.
  ctx.runState ??= new Map();
  const local = { ...ctx };
  const current: Progress = { tab, started: Date.now(), stage: "model", commands: 0, commandMs: 0, stages: {} };
  progress.set(local, current);
  const interrupted = () => markNovelAiPreparationInterrupted(ctx, tab);
  local.signal?.addEventListener("abort", interrupted, { once: true });
  let completed = false;
  let commandTimedOut = false;
  let batchReceiptInvalid = false;
  try {
    local.signal?.throwIfAborted();
    const result = await operation(local);
    completed = true;
    return result;
  } catch (error) {
    commandTimedOut = error instanceof OpenCliCommandTimeoutError;
    batchReceiptInvalid = error instanceof NovelAiPreparationBatchReceiptError;
    if (commandTimedOut || batchReceiptInvalid) interrupted();
    // Keep the exact-page typed evidence intact for the existing budget gate.
    if (novelAiPromptBudgetOverflowReport(error) || (!local.signal?.aborted && !commandTimedOut)) throw error;
    const detail = `stage=${current.stage}${current.field ? `, field=${current.field}` : ""}, commands=${current.commands}, elapsedMs=${Date.now() - current.started}`;
    throw new Error(`NovelAI 表单准备失败（${detail}）；未确认准备完成，不应上传或查找生成结果。${local.signal?.aborted ? "本次操作已取消。" : "浏览器子命令超时，本轮不得重试。"}`, { cause: error });
  } finally {
    local.signal?.removeEventListener("abort", interrupted);
    const snapshot = { completed, stage: current.stage, ...(current.field ? { field: current.field } : {}),
      elapsedMs: Date.now() - current.started, commands: current.commands, commandMs: current.commandMs,
      stages: current.stages, cancelled: local.signal?.aborted === true, commandTimedOut, batchReceiptInvalid };
    progress.delete(local);
    // Observability must never replace the operation's result/error.
    try { ctx.logger?.info(snapshot, "novelai:preparation-diagnostics"); } catch { /* best-effort diagnostics */ }
  }
}
