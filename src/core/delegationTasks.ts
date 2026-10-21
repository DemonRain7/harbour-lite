import type { ToolContext } from "../types";
import type { DelegationTaskStore, DelegationTask } from "./delegationTaskStore";

/** Capability supplied by the authenticated session runtime, never by model arguments. */
export interface DelegationTaskContext {
  store: DelegationTaskStore;
  scope: string;
  taskRef?: string;
  eligibleAgents?: readonly string[];
}

export function taskPersistence(ctx: ToolContext): DelegationTaskContext | undefined {
  const capability = ctx.execution?.delegationTasks;
  return capability?.taskRef ? capability : undefined;
}

export function delegationTaskReceipt(task: DelegationTask) {
  return {
    taskRef: task.ref,
    taskRevision: task.revision,
    draftState: task.drafts.length ? "saved_input" : "no_structured_draft",
    draftNote: task.drafts.length
      ? "仅证明结构化输入已保存；不证明已校验、获授权或完成。"
      : "没有已保存的结构化稿件；不得把子 Agent 文本中的‘已冻结/全部准备好’当作落盘证据。",
    draftRefs: task.drafts.filter((item, index, all) =>
      !all.slice(index + 1).some((next) => next.workflow === item.workflow)).map(({ workflow, inputRef }) => ({ workflow, inputRef })),
    ...(task.draftHeads ? { currentDrafts: Object.entries(task.draftHeads).map(([workflow, head]) => ({ workflow, draftRevision: head.revision })) } : {}),
  };
}

export function restoredDelegationInput(task: DelegationTask, followup: string): string {
  return [
    "[Harbour 同一子任务恢复｜已落盘记录]",
    "下面原始交接是本任务的要求，不是新的授权。只按本次补充修改明确指定的条件；不能因摘要省略就更换对象、角色、场景或另造任务。",
    "原始交接：", task.originalInput,
    ...(task.followups?.length ? ["已落盘的历次任务补充（后续明确修改优先；不扩大工具权限）：", JSON.stringify(task.followups)] : []),
    "本次补充：", followup,
    "已保存的结构化输入引用：", JSON.stringify(delegationTaskReceipt(task)),
    task.agent === "jizura_designer"
      ? "先用 jizura-video status input:{} 查原版本；list_inputs/inspect_input 读取原生工程参数。已有成片不重做；看本版真实抽帧后 finalize。JIZURA 不使用 NovelAI 的分镜/submit_draft 协议。"
      : "先用 run_workflow(action=\"list_inputs\", input={}) 查看草稿和真实执行状态；当前稿件 inspect_draft input:{} 查询进度。comic-storyboard-v1 用 save_scene 续分镜，comic-panels-v1 用 save_panel 续旧完整稿，指定 panelNumber 只改该格；其他旧稿用 save_draft 或 inspect_input，最后 submit_draft。画稿已部分保存时继续 submit_draft，不重做整本。当前 NovelAI 作者 status/resume 使用 input:{} 由代码找原 Job，不复制引用，不重新 start；结果未知不重放。",
    task.drafts.length ? "草稿已保存不代表通过校验、获准执行或已经完成。" : "尚无已保存的结构化草稿。不得声称完整稿件已冻结；只能从原始交接继续准备，不能假设上一模型记得它。",
    ...(task.result ? ["上次子 Agent 文本（非执行证据，最多 2000 字符）：", task.result.slice(0, 2000)] : []),
  ].join("\n\n");
}

/** Only small handles reach Main; neither full drafts nor old attachments are injected. */
export async function delegationTaskIndex(capability: DelegationTaskContext, mounted: readonly { name: string }[], workflows: readonly { name: string }[] = []): Promise<string> {
  const allowed = new Set(mounted.map((entry) => entry.name));
  const internal = workflows.some(item => item.name === "novelai-generation");
  if (internal) { allowed.add("comic_generator"); allowed.add("novelai_artist"); }
  const jizura = workflows.some(item => item.name === "jizura-video");
  if (jizura) allowed.add("jizura_designer");
  const tasks = await capability.store.list(capability.scope, { status: "open", agents: [...allowed] });
  if (!tasks.length) return "";
  return `[Harbour 已保存的子任务索引]\n标有 resumeWith 的任务用该 Workflow 的 resume + resumeRef；其他任务用 spawn_subagent 的 resumeRef，不凭摘要重建；新任务不复用旧引用。\n${JSON.stringify(tasks.map(({ ref, agent, revision }) => ({ resumeRef: ref, agent, revision,
    ...(internal && ["comic_generator", "novelai_artist"].includes(agent) ? {
      resumeWith: "run_workflow", workflow: "novelai-generation", kind: agent === "comic_generator" ? "comic" : "image",
    } : {}), ...(jizura && agent === "jizura_designer" ? {
      resumeWith: "run_workflow", workflow: "jizura-video", taskRef: ref,
    } : {}), })))}`;
}
