import type { ToolContext } from "../../types";
import { taskPersistence } from "../delegationTasks";
import { WorkflowInputValidationError } from "./registry";
import { inspectWorkflowInput, persistWorkflowInput, prepareWorkflowInput, prepareStructuredWorkflowInput, resolveWorkflowInput, workflowInputChunk } from "./workflowInputBuffer";
import { COMIC_DRAFT_ACTIONS, comicDraftSummary, editComicAuthoringDraft, isComicAuthoringDraft, submitComicAuthoringDraft } from "./comicAuthoringDraft";
import { hasWorkflowExecution, workflowPersistenceNames } from "./workflowAliases";
import { inspectNovelAiDraftBudgets, summarizeNovelAiDraftBudgets, novelAiDraftBudgetSaveFeedback, novelAiPromptRevisionDecision } from "./novelAiDraftBudget";
import { currentDraftPrompt, NOVELAI_PROMPT_DRAFT_ACTIONS } from "./novelAiDraftPrompt";
import type { NovelAiReferenceBudgetPlan } from "../novelAiReferenceBudget";
import type { NovelAiDraftBudgetReview } from "./novelAiDraftBudget";
import { rememberNovelAiDraftFeedback } from "./novelAiDraftFeedback";
import { assertSfwAuthoringPlan } from "./novelAiSfwAuthoring";

/** Bound author editing: opaque input/job handles never need to be copied by the LLM. */
export async function currentWorkflowDraft(workflow: string, action: string, input: Record<string, unknown>, ctx: ToolContext,
  editFrozenPrompt?: () => Promise<unknown>): Promise<Record<string, unknown> & { plan?: Record<string, unknown>; inputRef?: string; decision?: Record<string, unknown> }> {
  const durable = taskPersistence(ctx);
  if (workflow !== "novelai-generation" || !["novelai_artist", "comic_generator"].includes(ctx.agent.name) || !durable) {
    throw new WorkflowInputValidationError("当前稿件动作只用于已绑定的 NovelAI 内部作者任务；旧调用仍可使用 prepare_input / execute。", "draft_context_required");
  }
  const task = await durable.store.get(durable.scope, durable.taskRef!);
  if (task.agent !== ctx.agent.name) throw new WorkflowInputValidationError("当前稿件不属于此作者", "draft_owner_mismatch");
  const head = task.draftHeads?.[workflow];
  const plan = head ? resolveWorkflowInput(workflow, head.inputRef, ctx) : undefined;
  const managed = isComicAuthoringDraft(plan);
  const comicAction = COMIC_DRAFT_ACTIONS.includes(action);
  const promptAction = NOVELAI_PROMPT_DRAFT_ACTIONS.includes(action);
  const executionExists = task.workflowResults.some(entry => workflowPersistenceNames(workflow, ctx).includes(entry.workflow)
    && hasWorkflowExecution(entry.result));
  if (promptAction && executionExists && editFrozenPrompt) {
    const jobs = new Set(task.workflowResults.filter(entry => workflowPersistenceNames(workflow, ctx).includes(entry.workflow)
      && hasWorkflowExecution(entry.result)).map(entry => entry.result.jobId).filter(id => typeof id === "string"));
    if (jobs.size !== 1) throw new WorkflowInputValidationError("已有执行记录，但无法唯一定位原 Job；先 status，不改草稿或重启生成。", "execution_exists");
    if (Object.hasOwn(input, "jobId") || Object.hasOwn(input, "taskRef") || Object.hasOwn(input, "resumeRef")) {
      throw new WorkflowInputValidationError("精简入口自动绑定当前作者的原 Job，不填写或替换任务引用。", "author_job_mismatch");
    }
    return await editFrozenPrompt() as Record<string, unknown>;
  }
  if (comicAction && ctx.agent.name !== "comic_generator") throw new WorkflowInputValidationError("分镜写稿动作只提供给当前 comic_generator；普通插画沿用 save_draft。", "draft_author_mismatch");
  const allowed = action === "save_draft" ? ["path", "value", "draftRevision"]
    : action === "inspect_prompt" ? ["path", "draftRevision"]
    : action === "revise_prompt" ? ["path", "draftRevision", "sourceHash", "prompt"]
    : action === "inspect_draft" ? ["path", "panelNumber", "section"] : ["draftRevision"];
  if (!comicAction && Object.keys(input).some(key => !allowed.includes(key))) throw new WorkflowInputValidationError(`${action} 只接受 ${allowed.join("/")}；不需要 inputRef、jobId 或 taskRef。`);
  if (action === "inspect_draft") {
    if ([input.path, input.panelNumber, input.section].filter(value => value !== undefined).length > 1) throw new WorkflowInputValidationError("path、panelNumber、section 只能选一个；input:{} 查看摘要。");
    if (input.path !== undefined && typeof input.path !== "string") throw new WorkflowInputValidationError("path 必须是字符串");
    if (input.section !== undefined && !["book", "staged"].includes(String(input.section))) throw new WorkflowInputValidationError("section 只支持 book/staged");
    if (input.panelNumber !== undefined && (!managed || !Number.isInteger(input.panelNumber)
      || Number(input.panelNumber) < 1 || Number(input.panelNumber) > plan.job.panels.length)) throw new WorkflowInputValidationError("panelNumber 超出当前分镜范围");
    if (!managed && input.section !== undefined) throw new WorkflowInputValidationError("旧稿使用 path 读取字段");
    const summary = managed ? { ...comicDraftSummary(plan, head!.revision), editable: !executionExists,
      ...(executionExists ? { readyToSubmit: false, nextAction: { name: workflow, action: "status", input: {} } } : {}) } : {};
    if (managed && !Object.keys(input).length) return summary;
    const pointer = input.section === "staged" ? "/_stagedPanel" : input.panelNumber !== undefined ? `/job/panels/${Number(input.panelNumber) - 1}` : String(input.path ?? "");
    const value = input.section === "staged" && !plan?._stagedPanel ? null : head ? input.section === "book" ? (({ panels: _panels, ...book }) => book)(plan!.job as Record<string, unknown>)
      : inspectWorkflowInput(workflow, head.inputRef, pointer, ctx) : null;
    // Root inspection is the explicit full-diagnostic read path even if model
    // compaction has forgotten a previous save's details. Never use suppression
    // state here; scoped reads and no-reference/V5 receipts stay unchanged.
    const referencePromptBudgets = !managed && ctx.agent.name === "novelai_artist" && pointer === ""
      ? await inspectNovelAiDraftBudgets(plan, ctx) : [];
    const promptRevision = novelAiPromptRevisionDecision(referencePromptBudgets, head?.revision ?? 0);
    return { executed: false, draftRevision: head?.revision ?? 0, ...summary, value,
      ...(referencePromptBudgets.length ? { referenceBudgetReview: summarizeNovelAiDraftBudgets(referencePromptBudgets), referencePromptBudgets } : {}),
      ...(promptRevision ? { nextAction: promptRevision.nextAction } : {}) };
  }
  // Reading the current prompt may omit a version, just like inspect_draft.
  // Writes still require compare-and-swap; an explicit stale read also fails.
  const revision = input.draftRevision ?? (action === "inspect_prompt" ? head?.revision ?? 0 : 0);
  if (!Number.isSafeInteger(revision) || revision !== (head?.revision ?? 0)) {
    throw new WorkflowInputValidationError(`稿件已更新，当前 draftRevision=${head?.revision ?? 0}；先 inspect_draft 核对后继续。`, "draft_revision_conflict",
      [{ name: workflow, action: "inspect_draft", input: {} }]);
  }
  if (executionExists) {
    throw new WorkflowInputValidationError("当前任务已有执行记录；status 查询原 Job，改未执行画面用 revise_panel/revise_group；另做一批须由 Main 新建任务，不能改稿覆盖原账本。", "execution_exists",
      [{ name: workflow, action: "status", input: {} }]);
  }
  if (promptAction) {
    if (!plan || !head) throw new WorkflowInputValidationError("还没有当前稿件，先保存画面。", "draft_missing");
    if (managed && plan._stagedPanel) throw new WorkflowInputValidationError(`先 ${plan._comicStoryboard ? "save_scene" : "save_panel"} 或 discard_panel 处理暂存格，再精简已保存画面。`, "draft_staged");
    const edit = await currentDraftPrompt(action, { ...workflowInputChunk(input), draftRevision: head.revision }, plan, ctx);
    if (!edit.updated) return { ...edit.result, draftRevision: head.revision };
    const prepared = prepareStructuredWorkflowInput(workflow, edit.updated, ctx, head.inputRef);
    await persistWorkflowInput(workflow, prepared.inputRef, ctx);
    const next = await durable.store.advanceDraft(durable.scope, durable.taskRef!, workflow, prepared.inputRef, Number(revision));
    return { ...edit.result, saved: true, draftRevision: next.revision,
      nextAction: { name: workflow, action: "submit_draft", input: { draftRevision: next.revision } } };
  }
  if (comicAction) {
    let chunk;
    try { chunk = workflowInputChunk(input); }
    catch (error) { throw new WorkflowInputValidationError(`${String(error)}；大分镜使用 stage_panel 按字段暂存，再按格式 save_scene/save_panel 完整校验，不删细节。`, "draft_chunk_invalid",
      [{ name: workflow, action: "inspect_draft", input: {} }]); }
    let referencePromptBudget: NovelAiReferenceBudgetPlan | undefined;
    const updated = await editComicAuthoringDraft(action, chunk, plan, Number(revision), ctx, report => { referencePromptBudget = report; });
    assertSfwAuthoringPlan(updated, ctx);
    const prepared = prepareStructuredWorkflowInput(workflow, updated, ctx, head?.inputRef);
    await persistWorkflowInput(workflow, prepared.inputRef, ctx);
    const next = await durable.store.advanceDraft(durable.scope, durable.taskRef!, workflow, prepared.inputRef, Number(revision));
    const savedPanel = ["save_panel", "save_scene"].includes(action) ? input.panelNumber ?? (managed ? plan._stagedPanel?.panelNumber : undefined)
      ?? (plan!.job as typeof updated.job).panels.findIndex(panel => panel === null) + 1 : undefined;
    ctx.logger.info({ workflow, action, draftRevision: next.revision, savedPanel, byteLength: prepared.byteLength }, "workflow:draft-saved");
    return { ...comicDraftSummary(updated, next.revision), saved: true, ...(action === "stage_panel" ? { staged: true, panelCommitted: false } : {}), byteLength: prepared.byteLength,
      ...(savedPanel !== undefined ? { savedPanel } : {}),
      ...(referencePromptBudget ? { referencePromptBudget,
        promptRevision: novelAiPromptRevisionDecision([{ path: `/job/panels/${Number(savedPanel) - 1}/generation`, ...referencePromptBudget }], next.revision) } : {}) };
  }
  if (action === "save_draft") {
    if (managed) throw new WorkflowInputValidationError(`分镜骨架由程序管理，不接受 JSON Pointer 写入；用 save_book / ${plan._comicStoryboard ? "save_scene" : "save_panel"} 修改内容。`, "draft_managed");
    const prepared = prepareWorkflowInput(workflow, { ...(head ? { baseRef: head.inputRef } : {}),
      path: input.path ?? "", value: input.value }, ctx);
    assertSfwAuthoringPlan(resolveWorkflowInput(workflow, prepared.inputRef, ctx), ctx);
    await persistWorkflowInput(workflow, prepared.inputRef, ctx);
    const next = await durable.store.advanceDraft(durable.scope, durable.taskRef!, workflow, prepared.inputRef, Number(revision));
    const referencePromptBudgets = await inspectNovelAiDraftBudgets(resolveWorkflowInput(workflow, prepared.inputRef, ctx), ctx);
    const feedback = novelAiDraftBudgetSaveFeedback(referencePromptBudgets, `${task.ref}:${workflow}`, ctx.runState);
    const promptRevision = novelAiPromptRevisionDecision(referencePromptBudgets, next.revision);
    rememberNovelAiDraftFeedback(ctx, { scope: durable.scope, task, workflow, head: next },
      feedback.referenceBudgetReview as NovelAiDraftBudgetReview | undefined);
    return { executed: false, saved: true, draftRevision: next.revision, byteLength: prepared.byteLength,
      ...feedback, ...(promptRevision ? { nextAction: promptRevision.nextAction } : {}) };
  }
  if (!head) throw new WorkflowInputValidationError("还没有当前稿件；先 save_draft。", "draft_missing");
  let submittedPlan = plan!;
  assertSfwAuthoringPlan(submittedPlan, ctx);
  let submittedHead = head;
  if (isComicAuthoringDraft(plan) && plan._comicStoryboard) {
    // Validate completeness before invoking any artist. Kept lazy to avoid the
    // spawnSubagent -> runWorkflow module cycle at startup.
    submitComicAuthoringDraft(plan, head.revision);
    const { prepareComicPanelArt } = await import("./comicPanelArt");
    const art = await prepareComicPanelArt(plan, head, ctx);
    if (art.decision) return { decision: art.decision };
    submittedPlan = art.draft; submittedHead = art.head;
  }
  const submitted = isComicAuthoringDraft(submittedPlan) ? submitComicAuthoringDraft(submittedPlan, submittedHead.revision) : submittedPlan;
  // Recompute old no-job rejections too: a stale cached handoff must not lock an
  // editable draft out of the newly available whole-prompt refinement path.
  const reports = await inspectNovelAiDraftBudgets(submitted, ctx);
  const decision = novelAiPromptRevisionDecision(reports, submittedHead.revision);
  if (decision) return { revisionNeeded: decision };
  return { plan: submitted, inputRef: submittedHead.inputRef };
}
