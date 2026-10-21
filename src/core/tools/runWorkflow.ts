import type { ToolContext, ToolDef } from "../../types";
import { assertSfwAuthoringPlan } from "../workflows/novelAiSfwAuthoring";
import { currentCheckpointOperationId } from "../checkpoint";
import type { WorkflowRegistry } from "../workflows/registry";
import { WorkflowInputValidationError } from "../workflows/registry";
import { prepareWorkflowInput, resolveWorkflowInput, restoreDurableWorkflowInputs, persistWorkflowInput,
  persistDirectWorkflowInput, inspectWorkflowInput } from "../workflows/workflowInputBuffer";
import { taskPersistence } from "../delegationTasks";
import { COMIC_DIRECTOR_TIMEOUT_MS, OUTER_TIMEOUT_GRACE_MS } from "../subagentTimeout";
import { hasWorkflowExecution, workflowContextFor, workflowPersistenceNames } from "../workflows/workflowAliases";
import { currentWorkflowDraft } from "../workflows/currentWorkflowDraft";
import { COMIC_DRAFT_ACTIONS, isComicAuthoringDraft } from "../workflows/comicAuthoringDraft";
import { NOVELAI_PROMPT_DRAFT_ACTIONS } from "../workflows/novelAiDraftPrompt";

export interface WorkflowExecutionEvidence {
  phase: "started" | "completed" | "failed";
  workflow: string;
  action: string;
  result?: Record<string, unknown>;
  /** Last executor-owned durable job snapshot; a later no-job error cannot erase it. */
  jobSnapshot?: Record<string, unknown>;
  /** In-memory cancellation settlement, never a new executor invocation. */
  settled?: Promise<void>;
  error?: string;
}

const activeWorkflowTasks = new Set<string>();
async function withWorkflowTaskLock<T>(key: string | undefined, run: () => Promise<T>): Promise<T> {
  if (!key) return run();
  if (activeWorkflowTasks.has(key)) throw new WorkflowInputValidationError("该任务的 Workflow 仍在执行；可用 status 查询或 pause/abort 停止，不得并发提交。", "workflow_busy");
  activeWorkflowTasks.add(key);
  try { return await run(); } finally { activeWorkflowTasks.delete(key); }
}

function deferWorkflowInputs(execute: ToolDef["execute"]): ToolDef["execute"] {
  return async (args, ctx) => {
    // Children keep inputBoundary and yield after persisting the current unit.
    // Never await a native ACK: the SDK may itself be waiting for this tool.
    const release = ctx.execution?.runInputs?.holdNativeDelivery();
    try { return await execute(args, ctx); } finally { release?.(); }
  };
}

export function workflowExecutionEvidenceKey(delegationId: string, workflow: string): string {
  return `workflow:${delegationId}:${workflow}`;
}

/** Executors publish only already-persisted facts, before starting another side effect. */
export async function publishWorkflowJobSnapshot(ctx: ToolContext, workflow: string, snapshot: Record<string, unknown>): Promise<void> {
  if (typeof snapshot.jobId !== "string" || snapshot.executionStarted === false) return;
  if (["comic-generation", "novelai-image-set"].includes(workflow)
    && !ctx.agent.workflows?.some(entry => entry.name === workflow)
    && ctx.agent.workflows?.some(entry => entry.name === "novelai-generation")) workflow = "novelai-generation";
  const operationId = currentCheckpointOperationId();
  if (operationId) ctx.execution?.checkpoint?.recordRecovery?.(operationId, workflow, snapshot);
  const durable = taskPersistence(ctx);
  if (durable) await durable.store.recordWorkflowResult(durable.scope, durable.taskRef!, workflow, "snapshot", JSON.parse(JSON.stringify(snapshot)));
  // Display only persisted facts; never publish prompts, inputs or billing credentials.
  ctx.logger.info({ workflow, jobId: snapshot.jobId,
    status: typeof snapshot.status === "string" ? snapshot.status : undefined,
    completed: typeof snapshot.completed === "number" ? snapshot.completed : undefined,
    total: typeof snapshot.total === "number" ? snapshot.total : undefined,
  }, "workflow:progress");
  if (!ctx.execution?.subagentDelegationId) return;
  const key = workflowExecutionEvidenceKey(ctx.execution.subagentDelegationId, workflow);
  const evidence = ctx.execution.toolEvidence?.get(key) as WorkflowExecutionEvidence | undefined;
  if (evidence) evidence.jobSnapshot = snapshot;
}

/** Allow an aborted model to settle its already-running Workflow without replaying it. */
export async function settleWorkflowExecutionEvidence(
  evidence: WorkflowExecutionEvidence | undefined,
  timeoutMs: number,
): Promise<void> {
  if (evidence?.phase !== "started" || !evidence.settled) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([evidence.settled, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** 创建统一 Workflow 调用边界；挂载白名单与 executor ID 均 fail closed。 */
export function createRunWorkflowTool(registry: WorkflowRegistry): ToolDef {
  return {
    name: "run_workflow",
    description:
      "执行当前 Agent 已挂载的固定 Workflow。Workflow 负责确定性 DAG、预算、幂等、断点和结构化结果；" +
      "调用前按需 read_workflow。Main 的生图请求只用 start 交原始要求；内部作者用当前稿件接口保存并 submit_draft，细节读 input-staging。其他 Workflow 或旧稿才用 prepare_input/inputRef；不能执行未挂载名称或任意脚本。",
    timeoutMs: 30 * 60_000,
    timeoutMsFor: (args) => ["comic-generation", "novelai-generation"].includes(String(args.name ?? "").trim())
      ? COMIC_DIRECTOR_TIMEOUT_MS + OUTER_TIMEOUT_GRACE_MS : 30 * 60_000,
    async onReplay(result, args, ctx) {
      if (["prepare_input", "save_draft", "inspect_draft", ...COMIC_DRAFT_ACTIONS, ...NOVELAI_PROMPT_DRAFT_ACTIONS].includes(String(args.action))) return;
      const name = String(args.name ?? "").trim();
      ctx = workflowContextFor(name, ctx);
      const mounted = ctx.agent.workflows?.find(workflow => workflow.name === name);
      if (mounted) await registry.get(mounted.executor)?.onReplay?.(result, ctx);
    },
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "已挂载 Workflow 名称" },
        action: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          pattern: "^[a-z][a-z0-9_-]*$",
          description: "Workflow 动作；新漫画 begin_storyboard/save_scene，旧完整稿 begin_draft/save_panel，画师 save_draft；inspect_draft/submit_draft 查询或提交；参考图超限先 inspect_prompt 阅读整稿，再 revise_prompt 整体精简，由程序计数。详见 input-staging。",
        },
        input: {
          type: "object",
          additionalProperties: true,
          description: "按 action 提供参数；当前作者不填写任务引用，写入沿用回执中的版本字段。分块输入每块最多 8KiB，协议见 read_workflow resource:input-staging。",
        },
        inputRef: { type: "string", description: "仅通用/旧稿兼容：prepare_input 返回的引用，与 input 二选一；内部作者正常用 submit_draft，不填写本字段" },
      },
      required: ["name", "action"],
    },
    execute: deferWorkflowInputs(async (args, ctx) => {
      if (ctx.execution?.novelAiPanelArt && (args.name !== "novelai-generation" ||
        !["save_draft", "inspect_draft", "submit_draft", "inspect_prompt", "revise_prompt", "list_inputs", "inspect_input"].includes(String(args.action)))) {
        throw new WorkflowInputValidationError("分格画师只准备当前单图稿件；不能启动生成、调研、递归派发或操作其它 Job。", "panel_art_prompt_only");
      }
      const legacyUnlisted = ["comic-generation", "novelai-image-set"].includes(String(args.name)) &&
        ctx.agent.name.startsWith("main-") && !ctx.agent.workflows?.some(item => item.name === args.name);
      if (legacyUnlisted && !["status", "resume", "abort", "list_inputs", "inspect_input"].includes(String(args.action))) {
        throw new WorkflowInputValidationError("旧生图入口只保留查询/恢复；新请求使用 novelai-generation start 交原始要求。");
      }
      const name = String(args.name ?? "").trim();
      ctx = workflowContextFor(name, ctx);
      let action = String(args.action ?? "").trim();
      const workflow = ctx.agent.workflows?.find((candidate) => candidate.name === name);
      if (!workflow) throw new Error(`run_workflow: Workflow「${name}」没有挂载给 ${ctx.agent.name}`);
      const executor = registry.get(workflow.executor);
      if (!executor) throw new Error(`run_workflow: executor「${workflow.executor}」未注册`);
      ctx.signal?.throwIfAborted();
      if (ctx.execution?.inputBoundary?.hasPending && ["start", "execute", "submit_draft", "resume", "revise_panel", "revise_group", "revise_prompt"].includes(action)) {
        const result = { status: "waiting_for_input", terminal: true, executionStarted: false, retrySafety: "safe", nextAction: "return_to_main",
          ...(ctx.execution.delegationTasks?.taskRef ? { taskRef: ctx.execution.delegationTasks.taskRef } : {}),
          reason: "主会话有补充等待处理。本次未执行，请返回已保存的 taskRef/Job 和进度，等待运行时送入用户原文。" };
        // A legitimate yield is a tool receipt, not a missing-workflow failure.
        if (ctx.execution.subagentDelegationId) {
          ctx.execution.toolEvidence ??= new Map();
          const key = workflowExecutionEvidenceKey(ctx.execution.subagentDelegationId, name);
          const previous = ctx.execution.toolEvidence.get(key) as WorkflowExecutionEvidence | undefined;
          if (previous?.phase !== "started") ctx.execution.toolEvidence.set(key, {
            phase: "completed", workflow: name, action, result,
            ...(previous?.jobSnapshot ? { jobSnapshot: previous.jobSnapshot } : {}),
          } satisfies WorkflowExecutionEvidence);
        }
        return result;
      }
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(action)) throw new Error("run_workflow: 非法 action");
      const hasInput = Object.hasOwn(args, "input");
      const hasRef = Object.hasOwn(args, "inputRef");
      if (hasInput === hasRef) throw new Error("run_workflow: input 与 inputRef 必须且只能提供一个");
      if (hasInput && (!args.input || typeof args.input !== "object" || Array.isArray(args.input))) {
        throw new Error("run_workflow: input 必须是 JSON 对象，不是字符串或数组");
      }
      await restoreDurableWorkflowInputs(name, ctx);
      const durable = taskPersistence(ctx);
      if (durable && name === "novelai-generation" && ctx.agent.name === "comic_generator" && ["start", "execute"].includes(action)) {
        const head = (await durable.store.get(durable.scope, durable.taskRef!)).draftHeads?.[name];
        const draft = head && resolveWorkflowInput(name, head.inputRef, ctx);
        if (isComicAuthoringDraft(draft) && draft._comicStoryboard) {
          throw new WorkflowInputValidationError("当前是冻结分镜稿，须 submit_draft 由画师准备画面，不能直接 execute 绕过。", "storyboard_submit_required");
        }
      }
      const persistenceNames = workflowPersistenceNames(name, ctx);
      const lockKey = durable ? `${durable.scope}\0${durable.taskRef}\0${persistenceNames[0]}` : undefined;
      if (["save_draft", "inspect_draft", ...COMIC_DRAFT_ACTIONS, ...NOVELAI_PROMPT_DRAFT_ACTIONS].includes(action)) {
        if (!hasInput) throw new WorkflowInputValidationError(`${action} 使用 input，不使用 inputRef`);
        return withWorkflowTaskLock(["inspect_draft", "inspect_prompt"].includes(action) ? undefined : lockKey,
          () => currentWorkflowDraft(name, action, args.input as Record<string, unknown>, ctx,
            () => executor.execute({ action, input: args.input as Record<string, unknown> }, ctx)));
      }
      const savedResults = (entries: import("../delegationTaskStore").DelegationWorkflowResult[]) => entries
        .filter(entry => persistenceNames.includes(entry.workflow))
        .sort((a, b) => Number(Boolean(b.result.jobId)) - Number(Boolean(a.result.jobId)) || b.updatedAt.localeCompare(a.updatedAt));
      if (action === "list_inputs") {
        if (!hasInput || Object.keys(args.input as object).length) throw new Error("list_inputs 使用 input:{}");
        const saved = durable ? await durable.store.get(durable.scope, durable.taskRef!) : undefined;
        return { workflow: name, executed: false,
          drafts: saved?.drafts.filter((draft) => persistenceNames.includes(draft.workflow)) ?? [],
          execution: saved ? savedResults(saved.workflowResults)[0] ?? null : null };
      }
      if (action === "inspect_input") {
        const input = args.input as Record<string, unknown>;
        if (!hasInput || typeof input.inputRef !== "string" || (input.path !== undefined && typeof input.path !== "string")) {
          throw new Error("inspect_input 使用 input:{inputRef,path?}");
        }
        const saved = durable ? await durable.store.get(durable.scope, durable.taskRef!) : undefined;
        const originalName = saved?.drafts.find(draft => draft.inputRef === input.inputRef && persistenceNames.includes(draft.workflow))?.workflow ?? name;
        const originalContext = workflowContextFor(originalName, ctx);
        await restoreDurableWorkflowInputs(originalName, originalContext);
        return { workflow: originalName, executed: false, inputRef: input.inputRef,
          value: inspectWorkflowInput(originalName, input.inputRef, String(input.path ?? ""), originalContext) };
      }
      if (action === "prepare_input") {
        if (!hasInput) throw new Error("run_workflow: prepare_input 使用 input:{baseRef?,path?,value}");
        // Preparation never creates workflow execution evidence, a Job, or a Browser call.
        const prepared = prepareWorkflowInput(name, args.input as Record<string, unknown>, ctx);
        if (["novelai-generation", "comic-generation", "novelai-image-set"].includes(name)) {
          assertSfwAuthoringPlan(resolveWorkflowInput(name, prepared.inputRef, ctx), ctx);
        }
        await persistWorkflowInput(name, prepared.inputRef, ctx);
        return { workflow: name, ...prepared, ...(durable ? { durable: true, taskRef: durable.taskRef } : {}) };
      }
      if (ctx.execution?.novelAiIntent && ctx.execution.novelAiIntent !== "generate" &&
        ["comic-generation", "novelai-image-set"].includes(name) && !["status"].includes(action)) {
        throw new WorkflowInputValidationError("本次只准备 Prompt/状态，不能通过旧执行入口提交生成；请用 novelai-generation execute。");
      }
      // Diagnose a misplaced transport handle before kind/permissions are inferred.
      if (hasInput && Object.hasOwn(args.input as object, "inputRef")) {
        throw new WorkflowInputValidationError("inputRef 是 run_workflow 顶层参数，不能放在 input 内，也不能当作 jobId；内部作者推荐 submit_draft，旧调用使用 {name,action,inputRef}。", "misplaced_input_ref");
      }
      let input = hasRef
        ? resolveWorkflowInput(name, args.inputRef as string, ctx)
        : args.input as Record<string, unknown>;
      if (["novelai-generation", "comic-generation", "novelai-image-set"].includes(name)) assertSfwAuthoringPlan(input, ctx);
      if (durable && ["comic_generator", "novelai_artist"].includes(ctx.agent.name) &&
        ["comic-generation", "novelai-image-set"].includes(name) && action === "start") {
        // Legacy frozen input remains readable; its execution identity uses the
        // same server-owned task key as the unified author submission.
        const field = name === "comic-generation" ? "job" : "set";
        if (input[field] && typeof input[field] === "object" && !Array.isArray(input[field])) {
          input = { ...input, [field]: { ...(input[field] as Record<string, unknown>), workflowKey: `task:${durable.taskRef}` } };
        }
      }
      // The same boundary governs unified and legacy names. An author may inspect
      // old Jobs, but cannot adopt one into a new task by resuming/controlling it.
      if (durable && ["comic_generator", "novelai_artist"].includes(ctx.agent.name) &&
        ["novelai-generation", "comic-generation", "novelai-image-set"].includes(name) &&
        ["resume", "pause", "abort", "cancel", "revise_panel", "revise_group"].includes(action) &&
        typeof input.jobId === "string") {
        const task = await durable.store.get(durable.scope, durable.taskRef!);
        if (!savedResults(task.workflowResults).some(entry => hasWorkflowExecution(entry.result) && entry.result.jobId === input.jobId)) {
          throw new WorkflowInputValidationError(
            "这个 Job 不是当前作者任务创建的；可用 status 参考旧图，不能把旧 Job 绑定为新任务。新稿使用 inspect_draft/submit_draft，旧任务交回 Main 按原引用处理。", "author_job_mismatch",
            [{ name: "novelai-generation", action: "inspect_draft", input: {} }]);
        }
      }
      // Queries/control signals use the executor's short store lock, not the long
      // running author lock. They must not replace in-flight execution evidence.
      if (["status", "pause", "abort", "cancel"].includes(action)) {
        const key = ctx.execution?.subagentDelegationId ? workflowExecutionEvidenceKey(ctx.execution.subagentDelegationId, name) : undefined;
        const previous = key ? ctx.execution?.toolEvidence?.get(key) as WorkflowExecutionEvidence | undefined : undefined;
        let result: unknown;
        try { result = await executor.execute({ action, input }, ctx); }
        catch (error) {
          if ((action !== "status" || !durable) && key && ctx.execution && previous?.phase !== "started") {
            ctx.execution.toolEvidence ??= new Map();
            ctx.execution.toolEvidence.set(key, { phase: "failed", workflow: name, action, error: (error as Error).message,
              ...(previous?.jobSnapshot ? { jobSnapshot: previous.jobSnapshot } : {}),
              ...(error instanceof WorkflowInputValidationError ? { result: error.toResult() } : {}) } satisfies WorkflowExecutionEvidence);
          }
          throw error;
        }
        const normalized: Record<string, unknown> = { workflow: name, version: workflow.version, ...(result as Record<string, unknown>) };
        const saved = durable ? await durable.store.get(durable.scope, durable.taskRef!) : undefined;
        // Looking at a previous Job must not bind it to a new author's task or
        // replace that author's execution receipt. Only refresh an existing binding.
        const ownObservation = action !== "status" || !durable || (typeof normalized.jobId === "string" && (
          previous?.jobSnapshot?.jobId === normalized.jobId || previous?.result?.jobId === normalized.jobId ||
          savedResults(saved?.workflowResults ?? []).some(entry => hasWorkflowExecution(entry.result) && entry.result.jobId === normalized.jobId)));
        if (ownObservation && key && ctx.execution && previous?.phase !== "started") {
          ctx.execution.toolEvidence ??= new Map();
          ctx.execution.toolEvidence.set(key, { phase: "completed", workflow: name, action, result: normalized,
            ...(previous?.jobSnapshot ? { jobSnapshot: previous.jobSnapshot } : {}) } satisfies WorkflowExecutionEvidence);
        }
        if (ownObservation) await publishWorkflowJobSnapshot(ctx, name, normalized);
        return normalized;
      }
      return withWorkflowTaskLock(lockKey, async () => {
      let submittedRef: string | undefined;
      if (action === "submit_draft") {
        const submission = await currentWorkflowDraft(name, action, input, ctx);
        // A local authoring loop is not a terminal Workflow receipt. In
        // particular, do not publish a completed result that makes Main stop.
        if (submission.revisionNeeded) return { workflow: name, version: workflow.version, ...submission.revisionNeeded as object };
        if (submission.decision) {
          const result = { workflow: name, version: workflow.version, ...submission.decision };
          // The submit was handled, but execution never began. Persist and
          // publish the handoff so Main uses it instead of retrying a supposedly
          // missing Workflow. No Job binding, started row, or executor call.
          if (durable) await durable.store.recordWorkflowResult(durable.scope, durable.taskRef!, name, action, result);
          if (ctx.execution?.subagentDelegationId) {
            ctx.execution.toolEvidence ??= new Map();
            ctx.execution.toolEvidence.set(workflowExecutionEvidenceKey(ctx.execution.subagentDelegationId, name), {
              phase: "completed", workflow: name, action, result,
            } satisfies WorkflowExecutionEvidence);
          }
          return result;
        }
        if (!("plan" in submission) || !submission.plan) throw new WorkflowInputValidationError("当前稿件尚未准备好");
        input = submission.plan;
        submittedRef = submission.inputRef;
        action = "execute";
      }
      const savedInputRef = submittedRef ?? (hasRef ? String(args.inputRef)
        : ["status", "resume", "abort", "cancel"].includes(action) ? undefined
        : await persistDirectWorkflowInput(name, input, ctx));
      if (durable) {
        const priors = savedResults((await durable.store.get(durable.scope, durable.taskRef!)).workflowResults);
        const prior = priors[0];
        // A fresh start after any possibly executed call is not a resume. Read the
        // existing job/operation first; preparing inputs never grants a replay.
        if (["start", "execute"].includes(action) && priors.some(entry => hasWorkflowExecution(entry.result))) {
          throw new WorkflowInputValidationError("已保存 Workflow 执行记录；先 list_inputs/status 查询。当前作者可用 resume input:{} 继续原 Job，改稿须显式修订，不能重新 start。", "execution_exists");
        }
        await durable.store.recordWorkflowResult(durable.scope, durable.taskRef!, name, action,
          { ...(prior && hasWorkflowExecution(prior.result) ? prior.result : {}), status: "started", executionStarted: true,
            ...(savedInputRef ? { inputRef: savedInputRef } : {}) });
      }
      const evidenceKey = ctx.execution?.subagentDelegationId
        ? workflowExecutionEvidenceKey(ctx.execution.subagentDelegationId, name)
        : undefined;
      let evidence: WorkflowExecutionEvidence | undefined;
      let settled: (() => void) | undefined;
      if (evidenceKey && ctx.execution) {
        ctx.execution.toolEvidence ??= new Map<string, unknown>();
        const previous = ctx.execution.toolEvidence.get(evidenceKey) as WorkflowExecutionEvidence | undefined;
        evidence = {
          phase: "started", workflow: name, action,
          ...(previous?.jobSnapshot ? { jobSnapshot: previous.jobSnapshot } : {}),
          settled: new Promise<void>((resolve) => { settled = resolve; }),
        };
        ctx.execution.toolEvidence.set(evidenceKey, evidence);
      }
      ctx.logger.info({ workflow: name, executor: executor.id, action }, "workflow:start");
      try {
        const result = await executor.execute({ action, input }, ctx);
        const normalized: Record<string, unknown> = { workflow: name, version: workflow.version, ...(
          result && typeof result === "object" && !Array.isArray(result)
            ? result as Record<string, unknown>
            : { result }
        ) };
        // Bind the prompt-only receipt to the exact compiled snapshot, not a
        // later head the author may have edited before returning.
        if (ctx.execution?.novelAiPanelArt && savedInputRef) normalized.inputRef = savedInputRef;
        if (evidence) {
          evidence.phase = "completed";
          evidence.result = normalized;
        }
        await publishWorkflowJobSnapshot(ctx, name, normalized);
        if (durable) {
          const previous = (await durable.store.get(durable.scope, durable.taskRef!)).workflowResults.find((entry) => entry.workflow === name);
          await durable.store.recordWorkflowResult(durable.scope, durable.taskRef!, name, action,
            JSON.parse(JSON.stringify({ ...(previous?.result.jobId ? { jobId: previous.result.jobId } : {}), ...normalized })));
        }
        ctx.logger.info({ workflow: name, executor: executor.id, action,
          status: typeof normalized.status === "string" ? normalized.status : "returned" }, "workflow:result");
        return normalized;
      } catch (error) {
        ctx.logger.info({ workflow: name, executor: executor.id, action, status: "failed" }, "workflow:error");
        const rejection = error instanceof WorkflowInputValidationError ? error.toResult() : undefined;
        if (evidence) {
          evidence.phase = "failed";
          evidence.error = (error as Error).message;
          if (rejection) evidence.result = rejection;
        }
        if (durable) {
          const prior = (await durable.store.get(durable.scope, durable.taskRef!)).workflowResults.find((entry) => entry.workflow === name);
          await durable.store.recordWorkflowResult(durable.scope, durable.taskRef!, name, action,
            rejection
              ? { ...rejection, ...(savedInputRef ? { inputRef: savedInputRef } : {}) }
              : { ...prior?.result, status: "unknown", executionStarted: true, retrySafety: "uncertain",
                error: (error as Error).message, ...(savedInputRef ? { inputRef: savedInputRef } : {}) });
        }
        throw error;
      } finally {
        settled?.();
      }
      });
    }),
  };
}
