import type { ToolContext } from "../../types";
import type { NovelAiComposeInput } from "../novelAiPromptComposer";
import type { NovelAiReferenceBudgetPlan } from "../novelAiReferenceBudget";
import { ComicGenerationInputError, comicDraftBookSchema, comicDraftPanelSchema,
  comicStoryboardPanelSchema, preflightComicStoryboardPanel,
  preflightComicDraftBook, preflightComicDraftPanel } from "./comicGenerationInput";
import { inspectNovelAiGeneration } from "./novelAiGenerationUnit";
import { WorkflowInputValidationError } from "./registry";
import { stageWorkflowInputField } from "./workflowInputField";

type Panel = Record<string, unknown>;
export interface ComicAuthoringDraft extends Record<string, unknown> {
  _comicDraft: 1;
  _comicStoryboard?: 1;
  _comicArt?: Record<string, { taskRef: string; sourceHash: string }>;
  kind: "comic";
  job: Record<string, unknown> & { panels: Array<Panel | null> };
  _stagedPanel?: { panelNumber: number; content: Panel };
}
export const COMIC_DRAFT_ACTIONS = ["begin_storyboard", "save_scene", "begin_draft", "save_book", "save_panel", "stage_panel", "discard_panel"];

/** A virtual, on-demand resource derived from the actual execution validators. */
export const COMIC_DRAFT_CONTRACT = {
  version: 3,
  begin_storyboard: { input: { panelCount: "2..24", content: { $ref: "#/$defs/book" },
    draftRevision: "省略或 0", reviewBeforeGenerate: "可选 boolean", intent: "可选 prompt|generate" },
    note: "新任务入口。导演只保存故事、镜头与连续性，不写 generation；submit_draft 后由现有单图画师逐格写画面。" },
  save_scene: { input: { draftRevision: "当前版本", content: comicStoryboardPanelSchema, panelNumber: "可选，定向修订" },
    note: "characters 必填；不传 generation / novelAiRequest。修改分镜会使尚未生成的画稿失效，原快照仍保留。" },
  note: "仅 comic_generator 当前任务。新稿 begin_storyboard/save_scene；旧完整稿 begin_draft/save_panel。错误不推进格号、不覆盖旧格。",
  $defs: { book: comicDraftBookSchema },
  begin_draft: { input: { panelCount: "2..24", content: { $ref: "#/$defs/book" },
    draftRevision: "省略或 0", reviewBeforeGenerate: "可选 boolean", intent: "可选 prompt|generate" } },
  save_book: { input: { draftRevision: "当前版本", content: { $ref: "#/$defs/book" } },
    note: "修改全书设定，保留所有分镜；与已保存角色/场景冲突时拒绝整个修改。" },
  save_panel: { input: { draftRevision: "当前版本", content: comicDraftPanelSchema,
    panelNumber: "通常省略；仅定向修改已保存格时传回执中的格号" },
    note: "不填 number、novelAiRequest 或路径。characters 可省略，由 generation.characters 的名字回填；numberOfImages 固定 1。有暂存格时可省略 content，校验并提交暂存内容；显式 content 则完整替换该格。" },
  stage_panel: { input: { draftRevision: "当前版本", panelNumber: "可选；省略自动定位当前暂存格或下一空格",
    field: "内容字段路径数组，如 [\"visualDescription\"] / [\"generation\",\"characters\",0,\"action\"]",
    value: "该字段的值，沿用 save_panel.content schema" },
    note: "仅整格超过 8KiB 时按字段暂存。代码建容器，数组不跳号；字段类型即时校验，未写字段保留。暂存已落盘但不是完整分镜，save_panel input:{draftRevision} 完整校验后才推进格号。" },
  discard_panel: { input: { draftRevision: "当前版本" }, note: "仅丢弃当前暂存修改，已保存分镜和 Job 不变。" },
  inspect_draft: { input: { panelNumber: "可选，读取单格", section: "可选 book|staged；与 panelNumber 二选一" },
    note: "input:{} 返回已保存格、暂存格、版本和下一动作；section:staged 读暂存，过大可用 path:/_stagedPanel/content/字段 只读。不回灌整本。" },
  submit_draft: { input: { draftRevision: "当前版本" }, note: "全部格校验通过后提交；预算、审核、生成、恢复仍走原执行器。" },
};

/** The director need not load the old full drawing schema for new story work. */
export const COMIC_STORYBOARD_CONTRACT = Object.fromEntries(Object.entries(COMIC_DRAFT_CONTRACT)
  .filter(([key]) => !["begin_draft", "save_panel", "stage_panel"].includes(key)));
COMIC_STORYBOARD_CONTRACT.stage_panel = {
  input: { draftRevision: "当前版本", panelNumber: "可选", field: "故事字段路径数组", value: "字段值" },
  note: "沿用 save_scene.content schema，最后 save_scene 完整校验；不接受 generation。",
};

export function isComicAuthoringDraft(value: Record<string, unknown> | undefined): value is ComicAuthoringDraft {
  return value?._comicDraft === 1;
}

function panelsOf(draft: ComicAuthoringDraft): Array<Panel | null> {
  if (draft.kind !== "comic" || !draft.job || !Array.isArray(draft.job.panels)
    || draft.job.panels.length < 2 || draft.job.panels.length > 24
    || draft.job.panels.some((panel, index) => panel !== null && (!panel || typeof panel !== "object" || Array.isArray(panel) || panel.number !== index + 1))) {
    throw new WorkflowInputValidationError("漫画当前稿件骨架无效；未执行，不猜测修复。", "draft_corrupt");
  }
  return draft.job.panels;
}

export function comicDraftSummary(draft: ComicAuthoringDraft, revision: number) {
  const panels = panelsOf(draft);
  const missing = panels.flatMap((panel, index) => panel === null ? [index + 1] : []);
  const staged = draft._stagedPanel;
  return { format: draft._comicStoryboard ? "comic-storyboard-v1" : "comic-panels-v1", executed: false, draftRevision: revision,
    panelCount: panels.length, savedPanels: panels.flatMap((panel, index) => panel === null ? [] : [index + 1]),
    missingPanels: missing, nextPanel: missing[0] ?? null, readyToSubmit: missing.length === 0 && !staged,
    ...(draft._comicStoryboard ? { artPreparedPanels: panels.flatMap((panel, index) => panel?.generation ? [index + 1] : []),
      artNote: "分镜保存不代表画稿或成图完成；提交后逐格交画师，已保存画稿可恢复。" } : {}),
    ...(staged ? { stagedPanel: { panelNumber: staged.panelNumber, fields: Object.keys(staged.content) } } : {}),
    nextAction: { name: "novelai-generation", action: staged || missing.length ? draft._comicStoryboard ? "save_scene" : "save_panel" : "submit_draft", input: { draftRevision: revision } } };
}

export class ComicDraftValidationError extends WorkflowInputValidationError {
  constructor(readonly issues: string[], readonly draftRevision: number, readonly panelNumber?: number) {
    super(`漫画写稿校验失败${panelNumber ? `（第 ${panelNumber} 格）` : ""}；本次未保存，其他格不变，未调用 Browser。\n${issues.slice(0, 30).map(issue => `- ${issue}`).join("\n")}`,
      "comic_draft_invalid", [{ name: "novelai-generation", action: "inspect_draft", input: {} }]);
  }
  override toResult(): Record<string, unknown> {
    return { ...super.toResult(), saved: false, draftRevision: this.draftRevision,
      ...(this.panelNumber ? { panelNumber: this.panelNumber } : {}),
      issues: this.issues.slice(0, 30), totalIssues: this.issues.length };
  }
}

function checkKeys(input: Record<string, unknown>, keys: string[]) {
  const unknown = Object.keys(input).filter(key => !keys.includes(key));
  if (unknown.length) throw new WorkflowInputValidationError(`未声明字段：${unknown.join("、")}；只填 ${keys.join(" / ")}，任务绑定与路径由程序管理。`, "draft_fields_invalid");
}

function asContent(panel: Panel): Panel {
  const { number: _number, ...content } = panel;
  return content;
}

export function comicSceneContent(panel: Panel): Panel {
  const { number: _number, generation: _generation, novelAiRequest: _request, ...content } = panel;
  return content;
}

function invalidateArt(draft: ComicAuthoringDraft): ComicAuthoringDraft {
  const { _comicArt, ...rest } = draft;
  return { ...rest, job: { ...rest.job, panels: rest.job.panels.map(panel => panel
    ? { ...comicSceneContent(panel), number: panel.number } : null) } };
}

/** No publishing here: the caller commits one immutable snapshot with CAS only
 * after validation succeeds. Existing jobs and generation receipts are untouched. */
export async function editComicAuthoringDraft(action: string, input: Record<string, unknown>, current: Record<string, unknown> | undefined,
  revision: number, ctx: ToolContext, onReferencePromptBudget?: (report: NovelAiReferenceBudgetPlan) => void): Promise<ComicAuthoringDraft> {
  let target: number | undefined;
  try {
    if (action === "begin_draft" || action === "begin_storyboard") {
      checkKeys(input, ["draftRevision", "panelCount", "content", "reviewBeforeGenerate", "intent"]);
      if (current) throw new WorkflowInputValidationError("当前任务已有稿件；先 inspect_draft，按格式用 save_scene / save_panel 或 save_book，不重新初始化。", "draft_exists");
      if (!Number.isInteger(input.panelCount) || Number(input.panelCount) < 2 || Number(input.panelCount) > 24) {
        throw new WorkflowInputValidationError("input.panelCount 必须是 2–24 的整数，按用户要求确定格数。");
      }
      if (input.reviewBeforeGenerate !== undefined && typeof input.reviewBeforeGenerate !== "boolean") throw new WorkflowInputValidationError("reviewBeforeGenerate 必须是 boolean");
      if (input.intent !== undefined && !["prompt", "generate"].includes(String(input.intent))) throw new WorkflowInputValidationError("intent 必须是 prompt 或 generate");
      const book = preflightComicDraftBook(input.content);
      return { _comicDraft: 1, kind: "comic", job: { ...book, panels: Array.from({ length: Number(input.panelCount) }, () => null) },
        ...(action === "begin_storyboard" ? { _comicStoryboard: 1 as const } : {}),
        ...(input.reviewBeforeGenerate !== undefined ? { reviewBeforeGenerate: input.reviewBeforeGenerate } : {}),
        ...(input.intent !== undefined ? { intent: input.intent } : {}) };
    }
    if (!isComicAuthoringDraft(current)) throw new WorkflowInputValidationError("尚无分镜骨架，新任务用 begin_storyboard；已有旧稿继续 save_draft / submit_draft，不重建。", "draft_format_required");
    const panels = panelsOf(current);
    if (action === "discard_panel") {
      checkKeys(input, ["draftRevision"]);
      if (!current._stagedPanel) throw new WorkflowInputValidationError("当前没有暂存格，无需丢弃。", "draft_stage_missing");
      const { _stagedPanel, ...rest } = current;
      return rest;
    }
    if (action === "save_book") {
      checkKeys(input, ["draftRevision", "content"]);
      const book = preflightComicDraftBook(input.content);
      // Bible edits cannot silently invalidate work already acknowledged on disk.
      for (const [index, panel] of panels.entries()) if (panel) {
        target = index + 1;
        if (current._comicStoryboard) preflightComicStoryboardPanel(comicSceneContent(panel), target, book);
        else preflightComicDraftPanel(asContent(panel), target, book);
      }
      const changed = { ...current, job: { ...book, panels } };
      return current._comicStoryboard ? invalidateArt(changed) : changed;
    }
    if (!["save_scene", "save_panel", "stage_panel"].includes(action)) throw new WorkflowInputValidationError("未知漫画写稿动作");
    if ((action === "save_scene" && !current._comicStoryboard) || (action === "save_panel" && current._comicStoryboard)) {
      throw new WorkflowInputValidationError(current._comicStoryboard ? "当前是分镜稿，使用 save_scene；画面字段由画师完成。" : "当前是旧完整稿，继续 save_panel，不迁移重写。", "draft_format_mismatch");
    }
    checkKeys(input, action === "stage_panel" ? ["draftRevision", "field", "value", "panelNumber"] : ["draftRevision", "content", "panelNumber"]);
    const next = panels.findIndex(panel => panel === null);
    target = input.panelNumber === undefined ? current._stagedPanel?.panelNumber ?? next + 1 : Number(input.panelNumber);
    if (input.panelNumber !== undefined && (!Number.isInteger(input.panelNumber) || target < 1 || target > panels.length)) {
      throw new WorkflowInputValidationError(`panelNumber 必须是 1–${panels.length} 的整数，不是 jobId 或数组路径。`);
    }
    if (!target) throw new WorkflowInputValidationError("全部格已保存；submit_draft 提交，或明确 panelNumber 只修改指定格。", "draft_full");
    if (current._stagedPanel && current._stagedPanel.panelNumber !== target) {
      throw new WorkflowInputValidationError(`第 ${current._stagedPanel.panelNumber} 格仍有暂存；先 ${current._comicStoryboard ? "save_scene" : "save_panel"} 或 discard_panel，不同时暂存多格。`, "draft_stage_conflict");
    }
    if (input.panelNumber !== undefined && panels[target - 1] === null && target !== next + 1) {
      throw new WorkflowInputValidationError(`下一空格是第 ${next + 1} 格；省略 panelNumber 由程序定位，不跳号。`, "draft_slot_order");
    }
    if (action === "stage_panel") {
      const source = current._stagedPanel?.content ?? (panels[target - 1]
        ? current._comicStoryboard ? comicSceneContent(panels[target - 1]!) : asContent(panels[target - 1]!) : {});
      const content = stageWorkflowInputField(source, input.field, input.value, current._comicStoryboard ? comicStoryboardPanelSchema : comicDraftPanelSchema);
      return { ...current, _stagedPanel: { panelNumber: target, content } };
    }
    if (current._comicStoryboard) {
      const panel = preflightComicStoryboardPanel(Object.hasOwn(input, "content") ? input.content : current._stagedPanel?.content, target, current.job);
      const updated = [...panels]; updated[target - 1] = panel;
      const { _stagedPanel, ...rest } = current;
      return invalidateArt({ ...rest, job: { ...current.job, panels: updated } });
    }
    const panel = preflightComicDraftPanel(Object.hasOwn(input, "content") ? input.content : current._stagedPanel?.content, target, current.job);
    // The same read-only compiler catches material/reference/resolution errors now,
    // but its output is not frozen or stored as a second source of creative truth.
    // Keep a structurally valid over-budget panel editable. submit_draft owns
    // the budget gate and returns it to this same author's whole-prompt pass.
    const compiled = await inspectNovelAiGeneration(panel.generation as unknown as NovelAiComposeInput, 1, ctx);
    if (compiled.referencePromptBudget) onReferencePromptBudget?.(compiled.referencePromptBudget as NovelAiReferenceBudgetPlan);
    const updated = [...panels]; updated[target - 1] = panel;
    const { _stagedPanel, ...rest } = current;
    return { ...rest, job: { ...current.job, panels: updated } };
  } catch (error) {
    ctx.signal?.throwIfAborted();
    if (error instanceof WorkflowInputValidationError && error.code.startsWith("novelai_reference_") && target) {
      throw new WorkflowInputValidationError(`第 ${target} 格 generation（draftRevision=${revision}，本次未保存）：${error.message}`,
        error.code, [{ name: "novelai-generation", action: "inspect_draft", input: {} }], error.jobId, error.details);
    }
    // Guard/conflict errors retain their own machine codes; creative field errors
    // carry the precise target and leave the authoritative head unchanged.
    if (error instanceof WorkflowInputValidationError && !(error instanceof ComicGenerationInputError)) throw error;
    const issues = error instanceof ComicGenerationInputError ? error.issues
      : [`input.content.generation: ${error instanceof Error ? error.message : String(error)}`];
    const bookConflictPath = action === "save_book" && target ? `draft.panels[${target - 1}]` : undefined;
    throw new ComicDraftValidationError(bookConflictPath
      ? issues.map(issue => issue.replace(/^input\.content/, bookConflictPath)) : issues, revision, target);
  }
}

export function submitComicAuthoringDraft(draft: ComicAuthoringDraft, revision: number): Record<string, unknown> {
  const summary = comicDraftSummary(draft, revision);
  if (draft._stagedPanel) throw new WorkflowInputValidationError(`仍有暂存分镜未提交；先 ${draft._comicStoryboard ? "save_scene" : "save_panel"} 完整校验或 discard_panel 丢弃暂存，不能忽略修改直接执行。`, "draft_staged", [summary.nextAction]);
  if (summary.missingPanels.length) throw new WorkflowInputValidationError(
    `还缺第 ${summary.missingPanels.join("、")} 格；只补缺少的格，已保存格不重写。`, "draft_incomplete", [summary.nextAction]);
  const { _comicDraft: _internal, _comicStoryboard: _story, _comicArt: _art, ...plan } = draft;
  return plan;
}
