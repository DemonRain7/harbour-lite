import { compileImageSet, rememberNovelAiImageSetResult } from "./novelAiImageSet";
import { compileJob } from "./comicGeneration";
import { preflightComicGenerationStart, preflightComicDraftPanel } from "./comicGenerationInput";
import type { ToolContext, ToolDef } from "../../types";
import { comicOwnerFromContext, rememberComicSubagentOutcome } from "../tools/comic";
import { comicWorkflowCanonical, createSpawnSubagentTool, normalizeComicGeneratorResult } from "../tools/spawnSubagent";
import { COMIC_DIRECTOR_TIMEOUT_MS, OUTER_TIMEOUT_GRACE_MS } from "../subagentTimeout";
import { WorkflowInputValidationError, type WorkflowExecutor } from "./registry";
import { requestPolicy } from "./novelAiBudget";
import { currentNovelAiRequirementsDecision } from "./novelAiDraftBudget";
import type { DelegationTask } from "../delegationTaskStore";
import { taskPersistence } from "../delegationTasks";
import { hasWorkflowExecution } from "./workflowAliases";
import { assertSfwAuthoringPlan, novelAiContentRating } from "./novelAiSfwAuthoring";

export interface NovelAiGenerationConfig {
  /** Existing frozen-plan executor. Never rebuild an already saved comic on resume. */
  comic: WorkflowExecutor;
  images?: WorkflowExecutor;
  /** Reuse the governed director boundary, including native resume, media grants and receipts. */
  director?: ToolDef;
}

import { acquireNovelAiCharacterReference, type NovelAiCharacterResearchRequest } from "../novelAiCharacterResearch";
import { defaultNovelAiCharacterLibraryDir } from "../novelAiCharacterLibrary";

const EXECUTION_ACTIONS = new Set(["status", "resume", "pause", "abort", "revise_panel", "revise_group", "inspect_prompt", "revise_prompt"]);
const REQUEST_FIELDS = new Set(["kind", "request", "resumeRef", "intent", "maxTotalAnlas", "reviewBeforeGenerate", "contentRating"]);
const JOB_ID = /^(?:comic-[a-f0-9-]{12,64}|nai-set-[a-f0-9]{32})$/;
const TASK_ID = /^dgt-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function recoveryConflict(reason: string, jobId: string, kind: string) {
  return { status: "input_invalid", terminal: true, executionStarted: false, retrySafety: "safe",
    jobId, error: { code: "recovery_arguments_conflict", message: reason }, reason,
    nextActions: [
      { name: "novelai-generation", action: "status", input: { kind, jobId } },
      { name: "novelai-generation", action: "resume", input: { kind, jobId } },
    ], instruction: "status/resume 只继续原计划；真正的新要求须先核对，漫画用 revise_panel，不能静默丢弃补充要求。" };
}

/** The same authoritative receipt/individual-delivery projection as the old director boundary. */
function rememberReceipt(result: unknown, ctx: ToolContext, fromCheckpointReplay = false): void {
  if (!result || typeof result !== "object" || Array.isArray(result)) return;
  const record = result as Record<string, unknown>;
  if (record.generated === false || record.kind === "image" || record.agent === "novelai_artist" ||
    (record.jobId && String(record.jobId).startsWith("nai-set-"))) return;
  const canonical = record.agent === "comic_generator" ? undefined
    : comicWorkflowCanonical({ phase: "completed", workflow: "comic-generation", action: "resume", result: record });
  const outcome = canonical ? {
    ...normalizeComicGeneratorResult(canonical, { structuredExecutionBoundary: true }),
    authoritative: true, delegateInvoked: false,
  } : record;
  rememberComicSubagentOutcome(outcome, ctx.runState, { fromCheckpointReplay });
}

/** One public entry: one internal creative branch, then the shared generation unit. */
export function createNovelAiGenerationWorkflowExecutor(config: NovelAiGenerationConfig): WorkflowExecutor {
  const director = config.director ?? createSpawnSubagentTool();
  return {
    id: "novelai-generation",
    onReplay(result, ctx) {
      comicOwnerFromContext(ctx);
      rememberReceipt(result, ctx, true);
      rememberNovelAiImageSetResult(result, ctx);
    },
    async execute({ action, input }, ctx: ToolContext) {
      comicOwnerFromContext(ctx);
      input = { ...input };
      const requestedRating = novelAiContentRating(input.contentRating);
      if (input.jobId && requestedRating !== undefined) {
        throw new WorkflowInputValidationError("已有 Job 的恢复不能重设 contentRating；使用原任务继续。", "content_rating_immutable");
      }
      if (ctx.execution?.novelAiPanelArt) {
        const set = input.set as Record<string, unknown> | undefined;
        if (ctx.agent.name !== "novelai_artist" || ctx.execution.novelAiIntent !== "prompt" || action !== "execute" ||
          (input.kind !== undefined && input.kind !== "image") || set?.mode !== "single" || !Array.isArray(set.items) || set.items.length !== 1 ||
          (set.count !== undefined && set.count !== 1)) {
          throw new WorkflowInputValidationError("分格画师只能编译一张 single 画稿，不执行图像生成或其它 Workflow 动作。", "panel_art_prompt_only");
        }
        const item = set.items[0] as Record<string, unknown>;
        const frozen = ctx.execution.novelAiPanelArt;
        const generation = item?.generation as Record<string, unknown> | undefined;
        const bible = frozen.book.bible as Record<string, unknown>;
        if (generation?.orientation !== undefined && generation.orientation !== bible.aspectRatio) {
          throw new WorkflowInputValidationError("分格画师不能改变冻结分镜的画幅；orientation 必须与 bible.aspectRatio 一致。", "panel_art_canvas_mismatch");
        }
        const checked = preflightComicDraftPanel({ ...frozen.scene, generation: item?.generation }, frozen.panelNumber, frozen.book);
        input.kind = "image";
        input.set = { ...set, items: [{ ...item, generation: checked.generation }] };
      }
      // JSON tools frequently send null for optional handles. Null means absent, not an existing Job.
      for (const key of ["jobId", "resumeRef", "taskRef"] as const) if (input[key] === null) delete input[key];
      if (input.taskRef !== undefined) {
        if (input.resumeRef !== undefined && input.resumeRef !== input.taskRef) throw new WorkflowInputValidationError("taskRef 与 resumeRef 冲突");
        input.resumeRef = input.taskRef; delete input.taskRef;
      }
      if (typeof input.jobId === "string" && (input.jobId.startsWith("wfi-") || input.jobId.startsWith("dgt-"))) {
        throw new WorkflowInputValidationError(input.jobId.startsWith("wfi-")
          ? "jobId 收到了稿件 inputRef，不是生成任务；作者用 submit_draft，旧稿用顶层 inputRef + execute。"
          : "jobId 收到了作者 taskRef；请使用 input:{taskRef:原值}，代码会定位已保存 Job。", "wrong_handle_kind");
      }
      if (input.jobId !== undefined && (typeof input.jobId !== "string" || !JOB_ID.test(input.jobId))) throw new WorkflowInputValidationError("jobId 类型/格式无效；没有 Job 时省略或传 null，不传空串。", "invalid_job_id");
      if (input.resumeRef !== undefined && (typeof input.resumeRef !== "string" || !TASK_ID.test(input.resumeRef))) throw new WorkflowInputValidationError("resumeRef 类型/格式无效；请使用返回的 taskRef。");
      let resumedTask: DelegationTask | undefined;
      const bound = taskPersistence(ctx);
      if (bound && ["comic_generator", "novelai_artist"].includes(ctx.agent.name) &&
        EXECUTION_ACTIONS.has(action) && action !== "status" && input.resumeRef !== undefined && input.resumeRef !== bound.taskRef) {
        throw new WorkflowInputValidationError("作者只能操作当前绑定任务；其它 taskRef 可用 status 参考，需要续跑时交回 Main。", "author_task_mismatch",
          [{ name: "novelai-generation", action: "inspect_draft", input: {} }]);
      }
      if (!input.jobId && !input.resumeRef && EXECUTION_ACTIONS.has(action) && bound && ["comic_generator", "novelai_artist"].includes(ctx.agent.name)) {
        input.resumeRef = bound.taskRef;
      }
      if (input.resumeRef && EXECUTION_ACTIONS.has(action)) {
        const capability = ctx.execution?.delegationTasks;
        if (!capability) throw new WorkflowInputValidationError("resumeRef 缺少可信会话任务范围");
        resumedTask = await capability.store.get(capability.scope, String(input.resumeRef));
        if (requestedRating !== undefined && requestedRating !== resumedTask.novelAiContentRating) {
          throw new WorkflowInputValidationError("已有创作任务的 contentRating 不可更改；旧任务不会自动启用 SFW 新规则。", "content_rating_immutable");
        }
        delete input.contentRating;
        if (!["comic_generator", "novelai_artist"].includes(resumedTask.agent)) throw new WorkflowInputValidationError("此 taskRef 不属于 NovelAI 创作任务");
        const savedKind = resumedTask.agent === "comic_generator" ? "comic" : "image";
        if (input.kind !== undefined && input.kind !== savedKind) throw new WorkflowInputValidationError("kind 与保存的 taskRef 不一致");
        input.kind = savedKind;
        const jobIds = [...new Set(resumedTask.workflowResults.filter(entry => ["novelai-generation", "comic-generation", "novelai-image-set"].includes(entry.workflow) && hasWorkflowExecution(entry.result))
          .map(entry => entry.result.jobId).filter((id): id is string => typeof id === "string" && JOB_ID.test(id)))];
        if (jobIds.length > 1) throw new WorkflowInputValidationError("此任务包含多个 Job，请用 status 指定 jobId；不能随机恢复");
        const savedId = jobIds[0];
        if (savedId) {
          if (input.jobId && input.jobId !== savedId) return recoveryConflict("jobId 与 taskRef 保存的任务不一致。", savedId, savedKind);
          if (input.request !== undefined && !(typeof input.request === "string" && /^(?:继续|继续吧|确认|确认继续|按原方案继续|resume|continue)[。！!\s]*$/i.test(input.request.trim()))) {
            return recoveryConflict("已有 Job 不能同时提交新创作要求；本次未执行，也未丢弃你的补充要求。", savedId, savedKind);
          }
          input.jobId = savedId; delete input.resumeRef; delete input.request;
        } else if (action === "status") {
          const decision = currentNovelAiRequirementsDecision(resumedTask, "novelai-generation");
          if (decision) return { status: "needs_input", terminal: true, executionStarted: false, retrySafety: "safe",
            taskRef: resumedTask.ref, waitingFor: "creation", reasonCode: "legacy_prompt_revision_available",
            reason: "旧稿因固定措辞超限停在创作阶段，尚无 Job。现在可续接原作者，使用 inspect_prompt/revise_prompt 整体精简到 512/512；不必先让用户删除要求，不自动重开任务或生成。",
            nextAction: { name: "novelai-generation", action: "resume", input: { kind: savedKind, resumeRef: resumedTask.ref } } };
          return { status: "needs_input", terminal: true, taskRef: resumedTask.ref, waitingFor: "creation",
            reason: "尚无生成 Job；已保存创作任务，继续时续接原作者及稿件。",
            draftRefs: resumedTask.drafts.map(draft => ({ inputRef: draft.inputRef, workflow: draft.workflow })),
            nextAction: { name: "novelai-generation", action: "resume", input: { kind: savedKind, resumeRef: resumedTask.ref } } };
        } else if (bound?.taskRef === resumedTask.ref && ["comic_generator", "novelai_artist"].includes(ctx.agent.name)) {
          throw new WorkflowInputValidationError("当前作者还没有生成 Job，不能递归恢复自己；先 inspect_draft 核对稿件，再 submit_draft。需要用户补充时返回 Main。", "draft_not_submitted",
            [{ name: "novelai-generation", action: "inspect_draft", input: {} }]);
        } else if (action === "resume" && input.request === undefined) {
          input.request = "继续原任务。";
        }
      }
      if (action === "start" && input.kind === undefined) throw new WorkflowInputValidationError("start 必须指定 kind:image|comic；不能将省略字段默认为漫画");
      const kind = input.kind ?? (ctx.agent.name === "novelai_artist" ||
        (typeof input.jobId === "string" && input.jobId.startsWith("nai-set-")) ? "image" : "comic");
      if (kind !== "comic" && kind !== "image") throw new WorkflowInputValidationError("kind 必须为 image 或 comic");
      if (input.jobId && (String(input.jobId).startsWith("nai-set-") ? "image" : "comic") !== kind) throw new WorkflowInputValidationError("kind 与 jobId 不一致");
      const executor = kind === "comic" ? config.comic : config.images;
      if (!executor) throw new WorkflowInputValidationError("普通图片执行器尚未注入");
      const creator = kind === "comic" ? "comic_generator" : "novelai_artist";
      const isCreator = ctx.agent.name === creator;
      if (["inspect_prompt", "revise_prompt"].includes(action)) {
        if (!isCreator || !bound || !input.jobId) throw new WorkflowInputValidationError("冻结稿精简只用于原任务的内部作者。", "prompt_recovery_author_required");
        const { kind: _kind, ...existing } = input;
        // The domain store checks current revision and no-submit evidence under
        // its lock. Do not store a full prompt read as an execution receipt.
        return executor.execute({ action, input: existing }, ctx);
      }
      if (action === "acquire_reference") {
        if (!isCreator) throw new WorkflowInputValidationError("参考图调研属于内部创作节点");
        const { kind: _kind, ...request } = input;
        const fields = new Set(["displayName", "work", "characterTag", "workTag", "novelAiTag", "id", "aliases", "positiveAnchors", "negativeAnchors", "refresh"]);
        if (Object.keys(request).some(key => !fields.has(key))) throw new WorkflowInputValidationError("参考图调研包含未知字段；不接受 URL、目录或任意路径");
        return acquireNovelAiCharacterReference({ ...request, libraryDir: defaultNovelAiCharacterLibraryDir() } as NovelAiCharacterResearchRequest);
      }
      if (action === "execute") {
        if (!isCreator) throw new WorkflowInputValidationError("execute 是 Workflow 内部创作节点的计划提交；Main 只使用 start 交原始要求");
        assertSfwAuthoringPlan(input, ctx);
        const { kind: _kind, intent: requestedIntent, expectedCostAnlas: _legacyEstimate, ...plan } = input;
        // The server's task identity, not a model-authored key, binds this plan.
        // The key remains stable across sessions/retries; revisions use explicit domain actions.
        const planField = kind === "comic" ? "job" : "set";
        if (bound && plan[planField] && typeof plan[planField] === "object" && !Array.isArray(plan[planField])) {
          plan[planField] = { ...(plan[planField] as Record<string, unknown>), workflowKey: `task:${bound.taskRef}` };
        }
        const intent = ctx.execution?.novelAiIntent ?? requestedIntent ?? "generate";
        if (!["prompt", "generate", "readiness"].includes(String(intent))) throw new WorkflowInputValidationError("未知 intent");
        if (intent === "readiness") return { status: "needs_input", terminal: true, retrySafety: "safe", reason: "本次仅检查准备状态，未执行生图；可提交正式 generate 请求。" };
        if (intent === "prompt") {
          const compiled = kind === "image" ? await compileImageSet(plan.set, ctx, { promptOnly: true })
            : await compileJob(preflightComicGenerationStart({ ...plan, job: { ...(plan.job as Record<string, unknown>), budget: (plan.job as Record<string, unknown>)?.budget ?? { maxTotalAnlas: 0 } } }).job, ctx, "prompt-only");
          return { status: "completed", terminal: true, intent: "prompt", generated: false, costAnlas: 0, compiled };
        }
        const result = await executor.execute({ action: "start", input: plan }, ctx);
        if (kind === "comic") rememberReceipt(result, ctx);
        rememberNovelAiImageSetResult(result, ctx);
        return result;
      }
      if (["novelai_artist", "comic_generator"].includes(ctx.agent.name) && action === "start") {
        throw new WorkflowInputValidationError("创作节点不能递归启动自己；已有计划使用 execute");
      }

      // A saved job is authoritative. Only verified pre-submit prompt overflow
      // may resume its original author; never create a replacement task.
      if (EXECUTION_ACTIONS.has(action) && input.jobId !== undefined) {
        if (ctx.execution?.novelAiIntent && ctx.execution.novelAiIntent !== "generate" && action !== "status") {
          throw new WorkflowInputValidationError("本次只准备 Prompt/状态，不执行已有 Job 的生成或修改。");
        }
        if (input.request !== undefined || input.resumeRef !== undefined) {
          return recoveryConflict("jobId 恢复不能同时提交新创作要求或 resumeRef；单格改动使用 revise_panel。", String(input.jobId), kind);
        }
        const { kind: _kind, ...existing } = input;
        if (!isCreator && action === "resume" && resumedTask) {
          const status = await executor.execute({ action: "status", input: { jobId: input.jobId } }, ctx) as Record<string, unknown>;
          if (status.promptRecovery) {
            if (input.expectedRevision !== undefined && input.expectedRevision !== status.revision) {
              throw new WorkflowInputValidationError("Job 已更新，请先 status；未调用作者或 Browser。", "revision_conflict");
            }
            if (Object.keys(existing).some(key => !["jobId", "expectedRevision", "approve"].includes(key)) || existing.approve === false) {
              return recoveryConflict("本次网页超限恢复只精简原稿，不修改预算或执行策略；请分开提交这些变更。", String(input.jobId), kind);
            }
            // Resume the same persisted author, not a fresh planning pass. The
            // original Task/Job/budget stay bound even across process restarts.
            const result = await director.execute({ agent: creator, resumeRef: resumedTask.ref,
              input: "继续原任务：原 Job 网页计数超限但未提交、未扣费。按回执 inspect_prompt / revise_prompt 精简该张，必要时提前精简尚未执行的单元，再 resume 原 Job；不要重新 start 或重做已完成图。\n" + JSON.stringify(status.promptRecovery),
            }, { ...ctx, agent: { ...ctx.agent, subagents: [...(ctx.agent.subagents ?? []).filter(agent => agent.name !== creator),
              { name: creator, description: "Workflow 内部创作节点" }] },
              execution: { ...ctx.execution, novelAiPolicy: resumedTask.novelAiPolicy,
                novelAiPromptRecovery: { taskRef: resumedTask.ref, jobId: String(input.jobId) } } });
            if (kind === "comic") rememberReceipt(result, ctx);
            rememberNovelAiImageSetResult(result, ctx);
            return result;
          }
        }
        if (action === "resume" || (action === "revise_panel" && input.execute !== false && input.resolution === undefined)) {
          ctx.execution?.deadline?.ensureRemaining(COMIC_DIRECTOR_TIMEOUT_MS + OUTER_TIMEOUT_GRACE_MS);
        }
        // Restoring a task handle also restores its immutable opt-in. A Main
        // may revise its saved draft without turning an old/unmarked Job into SFW.
        const savedCtx = resumedTask?.novelAiContentRating === "sfw"
          ? { ...ctx, execution: { ...ctx.execution, novelAiContentRating: "sfw" as const } } : ctx;
        assertSfwAuthoringPlan(existing, savedCtx);
        let result = await executor.execute({ action, input: existing }, savedCtx);
        if (!isCreator && resumedTask && result && typeof result === "object" && "promptRecovery" in result) {
          const { promptRecovery: _internal, ...receipt } = result as Record<string, unknown>;
          result = { ...receipt, requiredAction: "resume_author",
            nextAction: { name: "novelai-generation", action: "resume", input: { resumeRef: resumedTask.ref } } };
        }
        if (resumedTask && ctx.execution?.delegationTasks && result && typeof result === "object") {
          const { store, scope } = ctx.execution.delegationTasks;
          await store.recordWorkflowResult(scope, resumedTask.ref, "novelai-generation", action, JSON.parse(JSON.stringify(result)));
        }
        if (kind === "comic") rememberReceipt(result, ctx);
        rememberNovelAiImageSetResult(result, ctx);
        return result;
      }

      if (action !== "start" && action !== "resume") {
        throw new WorkflowInputValidationError(`novelai-generation: ${action} 需要已有 jobId。`);
      }
      if (Object.keys(input).some(key => !REQUEST_FIELDS.has(key))) {
        throw new WorkflowInputValidationError("创作入口仅接收 kind/request/intent/resumeRef/maxTotalAnlas/reviewBeforeGenerate/contentRating；不要由 Main 写 Prompt 或分镜。");
      }
      if (typeof input.request !== "string" || !input.request.trim() || Buffer.byteLength(input.request, "utf8") > 128 * 1024) {
        throw new WorkflowInputValidationError("novelai-generation: request 必须是非空且不超过 128 KiB 的原任务描述。");
      }
      if (action === "resume" && (typeof input.resumeRef !== "string" || !input.resumeRef)) {
        throw new WorkflowInputValidationError("创作尚无 jobId 时，resume 必须携带上次返回的 taskRef 作为 resumeRef。");
      }
      if (action === "start" && input.resumeRef !== undefined) {
        throw new WorkflowInputValidationError("已有 taskRef 请用 resume；不要再次 start。");
      }
      ctx.signal?.throwIfAborted();
      if (input.intent === "readiness") {
        if (!ctx.runAgent) throw new WorkflowInputValidationError("Browser 未注入");
        const result = await ctx.runAgent("browser_controller", input.request, undefined, undefined, undefined,
          ctx.modelRef?.startsWith("codex-app-server/") ? ctx.modelRef : undefined, undefined, ctx.signal,
          { ...ctx.execution, nativeSession: undefined, delegationTasks: undefined, novelAiIntent: "readiness" }, { source: ctx.source });
        return { status: "completed", terminal: true, intent: "readiness", generated: false, costAnlas: 0, result };
      }
      // No prompt-writing shim, classifier model or second creation pass. Pass the
      // original text and original ToolContext through the existing governed seam.
      if (input.intent !== undefined && !["prompt", "generate", "readiness"].includes(String(input.intent))) throw new WorkflowInputValidationError("未知 intent");
      // This capability grants only its two fixed internal nodes, not an arbitrary Agent.
      const policy = { ...resumedTask?.novelAiPolicy, ...requestPolicy(input) };
      if (resumedTask && ctx.execution?.delegationTasks) {
        const { store, scope } = ctx.execution.delegationTasks;
        await store.updateNovelAiPolicy(scope, resumedTask.ref, policy);
      }
      const creativeCtx: ToolContext = { ...ctx, agent: { ...ctx.agent,
        subagents: [...(ctx.agent.subagents ?? []).filter(agent => agent.name !== creator), { name: creator, description: "Workflow 内部创作节点" }],
      }, execution: { ...ctx.execution, novelAiPolicy: policy,
        novelAiContentRating: resumedTask ? resumedTask.novelAiContentRating : requestedRating,
        ...(input.intent ? { novelAiIntent: input.intent as "prompt" | "generate" | "readiness" } : {}) } };
      const task = input.intent ? input.request + "\n\n[Workflow intent] " + input.intent : input.request;
      const result = await director.execute({
        agent: creator, input: task,
        ...(input.resumeRef !== undefined ? { resumeRef: input.resumeRef } : {}),
      }, creativeCtx);
      if (kind === "comic") rememberReceipt(result, ctx);
      rememberNovelAiImageSetResult(result, ctx);
      return result;
    },
  };
}
