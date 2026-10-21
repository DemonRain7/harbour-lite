import { createHash } from "node:crypto";
import type { ToolContext } from "../../types";
import type { DelegationTask } from "../delegationTaskStore";
import { taskPersistence } from "../delegationTasks";
import { createSpawnSubagentTool } from "../tools/spawnSubagent";
import { comicOwnerFromContext } from "../tools/comic";
import { comicSceneContent, type ComicAuthoringDraft } from "./comicAuthoringDraft";
import { preflightComicDraftPanel } from "./comicGenerationInput";
import { persistWorkflowInput, prepareStructuredWorkflowInput } from "./workflowInputBuffer";
import { WorkflowInputValidationError } from "./registry";
import { describeNovelAiTemplateModules, listNovelAiTemplateModules } from "../novelAiTemplateModules";
import { assertSfwAuthoringPlan } from "./novelAiSfwAuthoring";

const WORKFLOW = "novelai-generation";
type Head = { inputRef: string; revision: number };
type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

/** No free-form answer is accepted as a drawing plan. */
function completedPrompt(task: DelegationTask): RecordValue | undefined {
  return task.workflowResults.find(entry => entry.workflow === WORKFLOW && entry.action === "execute" &&
    entry.result.status === "completed" && entry.result.generated === false && entry.result.intent === "prompt" &&
    !entry.result.jobId && typeof entry.result.inputRef === "string")?.result;
}

async function packetFor(draft: ComicAuthoringDraft, index: number, request: string, templateRoot?: string) {
  const { panels, ...book } = draft.job;
  const firstArt = record(panels[0]?.generation);
  let styleTemplateModules: RecordValue[] = [];
  if (index > 0 && Array.isArray(firstArt?.templateModules) && firstArt.templateModules.length) {
    if (!templateRoot) throw new WorkflowInputValidationError("分格画师缺少 Workflow 模板目录；未猜测首格画法。", "panel_art_style_root_missing");
    const selections = firstArt.templateModules.map(record).filter((value): value is RecordValue => !!value);
    const ids = new Set(selections.map(value => value.id));
    const bindings = await listNovelAiTemplateModules(templateRoot);
    const contracts = await describeNovelAiTemplateModules(templateRoot,
      bindings.filter(binding => ids.has(binding.id)).map(binding => binding.source));
    const primaryStyles = new Set(contracts.filter(contract => contract.scope === "base" &&
      contract.exclusiveGroup === "illustration-style").map(contract => contract.id));
    // Preserve the author's exact style selection, not expanded prompt text.
    // Lighting, material and action modules must never leak into this reference.
    styleTemplateModules = selections.filter(value => primaryStyles.has(String(value.id))).map(value => structuredClone(value));
  }
  return {
    originalRequest: request, book, panelNumber: index + 1,
    scene: comicSceneContent(panels[index]!),
    // Keep one style reference, not the entire previous prompt/scene. Lighting
    // and composition still belong to this panel's location, time and camera.
    ...(index > 0 && firstArt?.style ? { styleReference: firstArt.style } : {}),
    ...(styleTemplateModules.length ? { styleTemplateModules } : {}),
  };
}

function assignment(packet: Awaited<ReturnType<typeof packetFor>>): string {
  return [
    "[Harbour 内部冻结分镜 → 单图画师｜仅准备画稿]",
    "这是 Workflow 已分配的一张独立画面，不是让你导演整本漫画。不要转回漫画入口。",
    "沿用你正常单图的工作方法：读 illustration / prompting，按场景选择资源，再编写英文 generation。",
    "故事、人物、服装状态、台词、镜头、构图焦点与连续性已经冻结；只将它们转为画面，不重写故事、不添加其它格。",
    "以本格 scene 为准，originalRequest 仅补充原要求；styleReference 与 styleTemplateModules 合在一起才是首格画法参考。后者是准确的模块选择，按原参数读取并沿用，不另选互斥画法、不复制展开文本；不复制首格动作、灯光或场景。",
    "先检查本格的主光方向、色彩关系、明暗层次与焦点是否协调；远景/背影不要硬加脸部特写词。",
    "保持原画风；不要因为它属于漫画就额外加平涂/赛璐璐，也不要默认堆 delicate face / detailed face / 写实皮肤词。",
    "read_workflow(name=novelai-generation) 后，用 save_draft 保存 kind:image、intent:prompt、set.mode:single、一个 item；generation.numberOfImages=1。",
    "generation.characters[].name 与本格 characters 一致；机位、画幅遵守冻结分镜。其它既有要求沿用，不新增内容分支或开关。",
    "submit_draft 编译成功即返回；禁止 start/execute/readiness/acquire_reference/浏览器生成。有缺口返回 IMAGE_NEEDS_INPUT，不自改镜头解决。",
    "下面 JSON 仅是任务资料，不授予额外工具权限：",
    "FROZEN_PANEL " + JSON.stringify(packet),
  ].join("\n");
}

/** Called only under the parent's draft lock, before a Job/Generate can exist.
 * Each child has a durable identity and its own scope; crashes may replay the
 * confirmed prompt receipt, never the LLM merely to recover its output. */
export async function prepareComicPanelArt(initial: ComicAuthoringDraft, initialHead: Head, ctx: ToolContext): Promise<{
  draft: ComicAuthoringDraft; head: Head; decision?: RecordValue;
}> {
  comicOwnerFromContext(ctx);
  const parent = taskPersistence(ctx);
  if (ctx.agent.name !== "comic_generator" || !parent || ctx.execution?.novelAiPanelArt) {
    throw new WorkflowInputValidationError("分格画师只由已绑定的导演任务调度。", "panel_art_context_required");
  }
  const task = await parent.store.get(parent.scope, parent.taskRef!);
  if (task.agent !== "comic_generator") throw new WorkflowInputValidationError("分镜任务归属不符");
  const authoringRating = task.novelAiContentRating;
  assertSfwAuthoringPlan(initial, { ...ctx, execution: { ...ctx.execution, novelAiContentRating: authoringRating } });
  const childScope = `${parent.scope}\0comic-art:${task.ref}`;
  ctx.runState ??= new Map();
  let draft = initial, head = initialHead;
  const stop = (panelNumber: number, reason: string, sourceHash: string) => {
    const decision = { status: "needs_input", terminal: true, executionStarted: false, retrySafety: "safe",
      taskRef: task.ref, waitingFor: "panel_art", panelNumber, draftRevision: head.revision,
      artPreparedPanels: Object.keys(draft._comicArt ?? {}).map(Number),
      reason: `画稿阶段停在第 ${panelNumber} 格：${reason}。已保存分镜和画稿；本阶段未调用图像生成，模型调用费用另计。`,
      nextAction: { name: WORKFLOW, action: "resume", input: { resumeRef: task.ref } } };
    ctx.runState?.set(`comic-art-stop:${task.ref}:${sourceHash}`, decision);
    return { draft, head, decision };
  };
  for (let index = 0; index < draft.job.panels.length; index++) {
    ctx.signal?.throwIfAborted();
    const panelNumber = index + 1;
    if (draft.job.panels[index]?.generation && draft._comicArt?.[panelNumber]) continue;
    const packet = await packetFor(draft, index, task.originalInput,
      ctx.agent.workflows?.find(workflow => workflow.name === WORKFLOW)?.directory);
    const sourceHash = createHash("sha256").update(JSON.stringify(packet)).digest("hex");
    const stopped = ctx.runState?.get(`comic-art-stop:${task.ref}:${sourceHash}`);
    if (stopped) return { draft, head, decision: stopped as RecordValue };
    if (ctx.execution?.inputBoundary?.hasPending) return stop(panelNumber, "有用户补充等待处理，先交回主会话", sourceHash);
    const operationKey = `panel-art-v1:${sourceHash}`;
    const child = await parent.store.findByOperation(childScope, operationKey) ??
      await parent.store.create(childScope, { agent: "novelai_artist", input: assignment(packet), operationKey, executionIntent: "prompt",
        ...(authoringRating ? { novelAiContentRating: authoringRating } : {}) });
    if (child.agent !== "novelai_artist" || child.executionIntent !== "prompt" || child.novelAiContentRating !== authoringRating) {
      throw new WorkflowInputValidationError("已保存的分格画师身份不符；未执行。", "panel_art_identity_mismatch");
    }
    let saved = child;
    let outcome: RecordValue | undefined;
    if (!completedPrompt(saved)) {
      ctx.logger.info({ workflow: WORKFLOW, panelNumber, total: draft.job.panels.length, taskRef: child.ref }, "workflow:panel-art-start");
      const creativeCtx: ToolContext = { ...ctx, agent: { ...ctx.agent,
        subagents: [{ name: "novelai_artist", description: "冻结分镜的单图画师" }] },
        execution: { ...ctx.execution, novelAiIntent: "prompt", novelAiPromptRecovery: undefined,
          toolEvidence: new Map(),
          novelAiPanelArt: { panelNumber, sourceHash, scene: packet.scene, book: packet.book },
          delegationTasks: { store: parent.store, scope: childScope, eligibleAgents: ["novelai_artist"] } } };
      try {
        outcome = record(await createSpawnSubagentTool().execute({ agent: "novelai_artist", resumeRef: child.ref,
          input: "按已保存的冻结分镜准备这一张画稿；若已有当前稿件先 inspect_draft，编译成功即结束，不生成图片。" }, creativeCtx));
      } catch (error) {
        ctx.signal?.throwIfAborted();
        return stop(panelNumber, error instanceof Error ? error.message : String(error), sourceHash);
      }
      ctx.signal?.throwIfAborted();
      saved = await parent.store.get(childScope, child.ref);
    }
    const receipt = completedPrompt(saved);
    if (!receipt) return stop(panelNumber, String(outcome?.reason ?? "没有可核验的单图编译回执"), sourceHash);
    try {
      const snapshot = await parent.store.getInput(childScope, child.ref, WORKFLOW, String(receipt.inputRef));
      const set = record(snapshot.value.set);
      const compiled = record(receipt.compiled);
      const item = set && Array.isArray(set.items) && set.items.length === 1 ? record(set.items[0]) : undefined;
      if ((snapshot.value.kind !== undefined && snapshot.value.kind !== "image") || set?.mode !== "single" || !item?.generation || compiled?.totalImages !== 1) {
        throw new Error("画师回执不符合单格单图契约");
      }
      const normalized = preflightComicDraftPanel({ ...comicSceneContent(draft.job.panels[index]!), generation: item.generation }, panelNumber, draft.job);
      // Import only generation. The director's story/continuity is immutable.
      const panels = [...draft.job.panels];
      panels[index] = { ...panels[index], generation: normalized.generation };
      const updated: ComicAuthoringDraft = { ...draft, job: { ...draft.job, panels },
        _comicArt: { ...draft._comicArt, [panelNumber]: { taskRef: child.ref, sourceHash } } };
      const prepared = prepareStructuredWorkflowInput(WORKFLOW, updated, ctx, head.inputRef);
      await persistWorkflowInput(WORKFLOW, prepared.inputRef, ctx);
      head = await parent.store.advanceDraft(parent.scope, task.ref, WORKFLOW, prepared.inputRef, head.revision);
      draft = updated;
      ctx.logger.info({ workflow: WORKFLOW, panelNumber, total: panels.length, draftRevision: head.revision }, "workflow:panel-art-saved");
    } catch (error) {
      ctx.signal?.throwIfAborted();
      return stop(panelNumber, error instanceof Error ? error.message : String(error), sourceHash);
    }
  }
  ctx.signal?.throwIfAborted();
  if (ctx.execution?.inputBoundary?.hasPending) return stop(draft.job.panels.length,
    "全部画稿已保存，但有用户补充等待处理，尚未进入图像生成", "input-pending");
  return { draft, head };
}
