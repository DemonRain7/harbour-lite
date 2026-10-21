import type { Agent, AgentPermissionMode, Attachment, Message, RunAgent, RunEphemeralSubagent, RunExecutionContext, RunSource, ToolCall, ToolContext } from "../types";
import type { Router } from "./router";
import type { ContextManager } from "./contextManager";
import { invalidateResourceReads } from "./resourceReadCache";
import type { ToolRegistry } from "./tools/registry";
import {
  checkModel,
  convergenceUsageTokens,
  governanceTemperature,
  governanceTokenBudget,
  totalUsageTokens,
} from "./governance";
import { buildChatMessages } from "./promptAssembly";
import { filterAllowedTools } from "./permissions";
import { coworkFailureFields } from "./cowork/protocol";
import { workflowFailureFields } from "./workflows/registry";
import { emitToolAudit, startTrace, TRACE_VERSION } from "./trace";
import { preserveBrowserControllerEvidence } from "./tools/spawnSubagent";
import { preserveComicDelivery } from "./tools/comic";
import { preserveNovelAiImageSetDelivery } from "./workflows/novelAiImageSet";
import { goalUpdateIntent, invalidateGoalDelivery } from "./tools/updateGoal";
import { appendCanonicalDelivery, markIncompleteDelivery, recordDeliveryToolActivity } from "./runDelivery";
import type { Logger } from "pino";
import { createFileChangeCollector } from "./fileChanges";
import { estimateToolTokens, REQUEST_ENVELOPE_RESERVE_TOKENS } from "./tokenEstimate";
import { contextWindowForModel } from "./modelInfo";
import { createRunTimeContext, describeRunTime } from "./timeZone";
import { recordSubmittedPlanRunOutcome } from "./submittedPlan";
import { createExecutionProgressStore } from "./executionProgress";
import { toolImages, withToolImages, type ToolImage } from "./toolImages";

/**
 * Agent Loop —— 标准 tool-use 循环，整个中台最核心的一件通用件。
 * 写一次，所有 agent 复用。
 *
 * 一轮的节奏：
 *   1) contextManager.build() 裁出本轮真正要发的 messages（不是裸全量历史）。
 *   2) router.complete() 拿到 assistant 回复（可能带 tool_calls），append 进历史。
 *   3) 没有 tool_calls → 这就是最终答案，return。循环靠「没有 tool_calls」自然
 *      结束，不靠步数。
 *   4) 有 tool_calls → 逐个真去执行，每个结果作为 role:"tool" append 回历史，
 *      回到第 1 步。
 *
 * maxSteps 只是保险丝，防失控；正常结束永远靠「没有 tool_calls」。
 * 工具执行全程容错：单个工具抛错/超时/返回畸形，绝不让 loop 崩——把错误信息
 * 当成 tool 结果回灌，让模型自己处理。
 */

export interface RunAgentLoopOptions {
  agent: Agent;
  input: string;
  router: Router;
  registry: ToolRegistry;
  contextManager: ContextManager;
  logger: Logger;
  /** 派子 agent 的能力，注入到工具执行上下文。 */
  runAgent?: RunAgent;
  /** 派无状态临时通用 Subagent；工具能力只能从调用方已有集合中向下授权。 */
  runEphemeralSubagent?: RunEphemeralSubagent;
  /** 覆盖 agent.taskType（如 heartbeat 强制走便宜模型）。 */
  taskType?: string;
  /** 多模态附件：并入首条 user 消息。 */
  attachments?: Attachment[];
  /**
   * 会话历史（仅 user/assistant 原文）：有状态运行时由 SessionStore 注入，
   * 接在 system 之后、本条输入之前，让 loop 看到上下文。
   */
  history?: Message[];
  /** 滚动摘要（早前对话压缩后的要点）：折进 system，永不被裁。 */
  summary?: string;
  /** 会话级 GOAL 指令；与摘要分开，压缩不会改变它。 */
  goal?: string;
  /** 调用方可观察的一次 loop 瞬时状态；GOAL 在成功收尾后据此提交状态。 */
  runState?: Map<string, unknown>;
  /**
   * 本条消息的来源（渠道 + 会话键）：注入 system 让 agent 知道消息从哪来
   * （Discord 频道/私信 / Web 前端 / 定时任务），以便按语境调整措辞或行为。
   * 由 runtime.runAgent 从 sessionRef 派生；子 agent / 无来源运行时缺省。
   */
  source?: RunSource;
  /** 覆盖 router 选出的 modelRef（chat 里换模型时用）；缺省走 router.pick。 */
  modelOverride?: string;
  /** Optional already-resolved input limit for direct callers using contextBudget:auto. */
  contextLimit?: number;
  /** Original configured policy for a backend's internal loop and fallback recalculation. */
  contextBudget?: Agent["contextBudget"];
  /** 思考 token 预算（effort 档位）：透传给 backend；undefined=不覆盖，走 .env 默认。 */
  thinkingBudget?: number;
  /** 已解析的 Agent 默认/本次覆盖权限模式；透传给 claude-agent 后端。 */
  permissionMode?: AgentPermissionMode;
  /** 单个工具执行超时（毫秒），默认 30s。 */
  toolTimeoutMs?: number;
  /** 「停下来问人」的能力；仅交互渠道注入（见 ToolContext.askUser）。 */
  askUser?: ToolContext["askUser"];
  /** 取消信号：用户点停止 → abort；已观察到的工具事实仍写入审计 Trace。 */
  signal?: AbortSignal;
  /** 顶层会话 checkpoint；父/子 agent 共用，完成的工具步骤可在恢复轮回放。 */
  execution?: RunExecutionContext;
  /** 独立宿主/离线测试可隔离审计目录；默认仍为 assets/sessions。 */
  traceDirectory?: string;
  onUsage?: (usage: { modelRef: string; promptTokens?: number; completionTokens?: number; cachedTokens?: number; cacheCreationTokens?: number }) => void;
}

/**
 * 单个工具执行的默认超时。不再是 30s 时间墙（很多子 agent / 浏览器活远不止 30s）——
 * 改成很宽松的 20 分钟兜底：平时无感，只防某个工具真卡死、把 worker 一直占着。
 * 真正想主动中断用「停止」按钮（AbortSignal），不靠这道保险丝。
 */
export const TOOL_TIMEOUT_MS = 20 * 60 * 1000;

/** Shared with runtime preflight so source/GOAL/Cowork wrappers are counted as sent. */
export async function buildAgentLoopMessages(
  agent: Agent,
  opts: Parameters<typeof buildChatMessages>[1],
  execution?: RunExecutionContext,
): Promise<Message[]> {
  const messages = buildChatMessages(agent, opts);
  const timeContext = execution ? (execution.timeContext ??= createRunTimeContext()) : createRunTimeContext();
  const currentTimeMessage = messages.at(-1)!;
  currentTimeMessage.content = `${describeRunTime(timeContext)}\n\n${currentTimeMessage.content}`;
  // No host paths for public/tool-less agents. Regular runs and Cowork share the
  // same short facts; no shell probe or additional model call in the prompt path.
  if (execution?.cowork || agent.tools.some(tool => ["bash", "read_file", "list_files", "opencli_browser", "opencli_adapter"].includes(tool))) {
    const target = execution?.cowork ?? { deviceId: "server" };
    const { coworkDeviceHub } = await import("./cowork/deviceHub");
    const { serverDeviceInfo } = await import("./cowork/targets");
    const device = target.deviceId === "server" ? serverDeviceInfo() : coworkDeviceHub.get(target.deviceId);
    const current = messages.at(-1)!;
    // Keep the location wrapper in the same current-user anchor as the real task.
    const shell = device?.environment?.shell;
    const facts = { deviceId: target.deviceId, label: device?.label, platform: device?.platform, arch: device?.arch,
      cwd: target.cwd || device?.cwd, shell: shell ? { name: shell.name, executable: shell.executable, version: shell.version, available: shell.available } : "未上报，不要按服务端环境猜测" };
    const scope = execution?.cowork
      ? "本轮文件/命令/Browser 工具在该设备执行；Skill、Memory、Workflow 仍由中央管理。不要把远端绝对路径当成中央路径；需要交付文件时调用 export_file 取服务器 URL。设备离线或失败不能换设备重做。"
      : "Harbour 文件/命令/Browser 工具默认在服务端执行，不是聊天客户端；此 Shell 对应 Harbour bash 工具，不代表 SDK 原生 Bash。";
    current.content = `[${execution?.cowork ? "Cowork 执行位置" : "工具执行环境"}] ${JSON.stringify(facts)}\n${scope}\n\n${current.content}`;
  }
  return messages;
}

export async function runAgentLoop(opts: RunAgentLoopOptions): Promise<string> {
  const { input, router, registry, contextManager, logger } = opts;
  const resolvedLimit = typeof opts.contextLimit === "number" && Number.isFinite(opts.contextLimit) && opts.contextLimit > 0
    ? Math.floor(opts.contextLimit) : undefined;
  let agent = { ...opts.agent };
  const maxSteps = agent.maxSteps ?? 20;
  const toolTimeoutMs = opts.toolTimeoutMs ?? TOOL_TIMEOUT_MS;
  const signal = opts.signal;
  const execution = opts.execution ?? {};
  execution.fileChanges ??= createFileChangeCollector();
  execution.progress ??= createExecutionProgressStore(agent.name);
  const abortErr = () => new Error("run aborted（用户停止了本次运行）");
  if (signal?.aborted) throw abortErr();

  const boundRunId = logger.bindings().runId;
  const activityRunId = opts.execution?.runId ?? (typeof boundRunId === "string" ? boundRunId : undefined);
  const trace = startTrace(agent.name, input, opts.taskType, {
    activityRunId,
    delegationId: opts.execution?.subagentDelegationId,
    directory: opts.traceDirectory,
  });
  const log = logger.child({ agent: agent.name, traceId: trace.id,
    ...(execution.parentTraceId ? { parentTraceId: execution.parentTraceId } : {}),
    ...(activityRunId ? { activityRunId } : {}) });
  const onToolAudit: NonNullable<import("../types").CompletionRequest["onToolAudit"]> = async (event) => {
    // SDK 内部工具不会经过外层 toolCalls；开始及完成都观察，包含已在并行执行的工具。
    recordDeliveryToolActivity(runState);
    invalidateGoalDelivery(runState, event.tool);
    trace.tool(event);
    // 下一次工具可能立即 read_file 当前 JSONL；记录不能等到 final 才变得可见。
    await trace.flush();
  };
  const cleanups = new Map<string, () => Promise<void> | void>();
  const runState = opts.runState ?? new Map<string, unknown>();
  runState.set("trace:current", { traceId: trace.id, traceVersion: TRACE_VERSION, agent: agent.name, ...(activityRunId ? { activityRunId } : {}) });
  let traceOutcome = "incomplete";
  try {
  const modelRef = opts.modelOverride || router.pick(agent, opts.taskType);
  if (resolvedLimit !== undefined) agent = { ...agent, contextBudget: resolvedLimit };
  else if (agent.contextBudget === "auto") {
    const contextWindow = contextWindowForModel(modelRef.slice(modelRef.indexOf("/") + 1));
    agent = { ...agent, contextBudget: Math.max(1, contextWindow - Math.ceil(contextWindow * 0.05)) };
    log.info({ contextWindow, contextLimit: agent.contextBudget, contextWindowSource: "fallback" }, "loop:context-policy");
  }
  checkModel(agent, modelRef); // governance: 模型白名单（越界报错）
  const temperature = governanceTemperature(agent);
  const tokenBudget = governanceTokenBudget(agent);
  const maxTokens = tokenBudget?.hardTokens;
  let usedTokens = 0;
  let convergenceTokens = 0;
  let softBudgetNotified = false;
  // 工具：先按 agent 声明的白名单解析，再按 governance.permissions.tools 收窄（sandbox）。
  const tools = filterAllowedTools(agent, registry.resolveTools(agent.tools));
  const requestOverheadTokens = estimateToolTokens(tools) + REQUEST_ENVELOPE_RESERVE_TOKENS;
  const ctx: ToolContext = {
    agent, logger: log, runAgent: opts.runAgent, runEphemeralSubagent: opts.runEphemeralSubagent,
    modelRef,
    // Outer-loop image results are routed to a vision-capable transport on the next completion.
    imageOutputSupported: true,
    permissionMode: opts.permissionMode ?? agent.permissionMode,
    attachments: opts.attachments,
    source: opts.source, taskType: opts.taskType,
    runState,
    deferCleanup: (key, cleanup) => {
      cleanups.set(key, cleanup);
      return () => { cleanups.delete(key); };
    },
    // 只在【人在场的交互渠道】注入 askUser。非交互渠道（cron/heartbeat/子 agent）没人能回答，
    // 注入了只会让工具白等 3 分钟然后超时——不如让工具看见 undefined 直接走降级分支。
    askUser: opts.askUser,
    // 取消信号进 ctx：spawn_subagent 会把它透传给子 runAgent，父停子也停。
    signal,
    execution: { ...execution, parentTraceId: trace.id },
  };

    // 初始 messages —— 走【唯一事实源】buildChatMessages（与压缩摘要共用同一装配，保证前缀逐字节一致、
    // 命中同一 prompt cache）。稳定前缀 = 人格 + 护栏；来源/摘要并进对话首条、不污染前缀。
    const history = opts.history ?? [];
    const messages: Message[] = await buildAgentLoopMessages(agent, {
      source: opts.source?.channel ? opts.source : undefined,
      summary: opts.summary,
      goal: opts.goal,
      history,
      input,
      attachments: opts.attachments,
    }, execution);
    if (execution?.nativeSession) {
      execution.nativeSession.incrementalMessages = await buildAgentLoopMessages(agent, {
        source: opts.source, goal: opts.goal,
        input: execution.nativeSession.incrementalInput ?? input,
        attachments: opts.attachments,
      }, execution);
    }

    log.info({ modelRef, tools: agent.tools, maxSteps, historyLen: history.length, hasSummary: !!opts.summary?.trim(), hasGoal: !!opts.goal?.trim() }, "loop:start");
    trace.event("model", { modelRef, availableTools: tools.map((tool) => tool.name), maxSteps });

    let previouslyDropped = new Set<Message>();
    for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) throw abortErr(); // 每步开头查一次：停止后不再往下跑
    // 1) 构造本轮 context（受预算约束，非全量）。
    const built = contextManager.build(agent, execution?.nativeSession?.prepareSeed
      ? execution.nativeSession.incrementalMessages! : messages, requestOverheadTokens);
    if (!execution.nativeSession?.prepareSeed && built.stats.droppedMessages > 0) {
      const kept = new Set(built.messages);
      const dropped = new Set(messages.filter(message => !kept.has(message)));
      if ([...dropped].some(message => !previouslyDropped.has(message))) invalidateResourceReads(ctx, "context-window-trim");
      previouslyDropped = dropped;
    }
    log.info(
      { step, injectedTokens: built.stats.injectedTokens, trimmedTokens: built.stats.trimmedTokens, native: !!execution?.nativeSession?.prepareSeed,
        requestTokens: built.stats.injectedTokens + requestOverheadTokens, requestOverheadTokens },
      "loop:turn"
    );
    trace.event("turn", { step, injectedTokens: built.stats.injectedTokens, trimmedTokens: built.stats.trimmedTokens });

    // 2) 发起补全（router 内部处理后端选择 + fallback）。
    const result = await router.complete({
      modelRef,
      contextBudget: opts.contextBudget ?? opts.agent.contextBudget,
      agentName: agent.name,
      messages: built.messages,
      tools,
      toolContext: ctx,
      onToolAudit,
      maxTurns: maxSteps,
      tokenBudget,
      onUsage: opts.onUsage,
      toolTimeoutMs,
      ...(signal ? { signal } : {}),
      ...(agent.fallbacks?.length ? { fallbacks: agent.fallbacks } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(opts.thinkingBudget !== undefined ? { thinkingBudget: opts.thinkingBudget } : {}),
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
    });
    const assistant = result.message;
    messages.push(assistant);
    // 硬保险丝/账本看完整用量；converge 软线只看本轮新增、缓存写入与输出。
    // 否则一次普通追问会因大段历史命中缓存而收到“尽快收尾”控制消息，反而覆盖问题。
    usedTokens += totalUsageTokens(result.usage);
    convergenceTokens += convergenceUsageTokens(result.usage);
    if (result.usage && !result.usageReported) {
      opts.onUsage?.({
        modelRef: result.servedBy ?? modelRef,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        cachedTokens: result.usage.cachedTokens,
        cacheCreationTokens: result.usage.cacheCreationTokens,
      });
    }

    // 3) 没有 tool_calls → 收尾。
    if (!assistant.toolCalls || assistant.toolCalls.length === 0) {
      // Legacy backends can consume input at this settled boundary. Codex/SDK bind a native-only
      // sender: known-unsent messages queue for the next root run, never simulate steer via query/resume.
      const additions = !result.incomplete && !signal?.aborted && step < maxSteps && (maxTokens === undefined || usedTokens < maxTokens)
        ? await execution.runInputs?.drainAtBoundary() ?? [] : [];
      if (additions.length && step < maxSteps && (maxTokens === undefined || usedTokens < maxTokens)) {
        messages.push(...additions);
        if (execution.nativeSession) {
          execution.nativeSession.incrementalMessages = additions;
          execution.nativeSession.incrementalInput = additions.map(m => m.content).join("\n\n");
          execution.nativeSession.attemptId += `:input:${step}`;
          execution.nativeSession.prepareSeed = async () => messages;
        }
        trace.event("input", { count: additions.length, delivery: "safe-boundary" });
        continue;
      }
      execution.runInputs?.seal();
      const intent = goalUpdateIntent(runState);
      const incomplete = result.incomplete === "empty_reply" && intent ? undefined : result.incomplete;
      if (incomplete) markIncompleteDelivery(runState, incomplete);
      const candidate = !incomplete && intent ? intent.reply : assistant.content;
      const evidenceChecked = preserveBrowserControllerEvidence(candidate, ctx);
      // Main's answer and the deterministic artifact receipts are separate deliverables.
      // Never let a Workflow replace answers to other questions (ordinary chat or GOAL),
      // or let the image-set guard overwrite a comic delivered in the same run.
      const canonical = ctx.agent.name.startsWith("main-")
        ? [preserveComicDelivery("", ctx), preserveNovelAiImageSetDelivery("", ctx)].filter(Boolean).join("\n\n")
        : "";
      let finalAnswer = canonical
        ? appendCanonicalDelivery(evidenceChecked, canonical)
        : preserveNovelAiImageSetDelivery(preserveComicDelivery(evidenceChecked, ctx), ctx);
      if (!finalAnswer.trim()) {
        markIncompleteDelivery(runState, "empty_reply");
        finalAnswer = "本轮未收到可交付的答复，已保留执行记录与断点；不能据此认定任务完成。";
      }
      log.info({ step, answerPreview: preview(finalAnswer) }, "loop:final");
      trace.event("final", { step, usedTokens, convergenceTokens, usage: result.usage ?? null, answer: finalAnswer });
      traceOutcome = incomplete || !candidate.trim() ? "incomplete" : "completed";
      return finalAnswer;
    }

    if (tokenBudget?.mode === "converge" && tokenBudget.softTokens !== undefined &&
        convergenceTokens >= tokenBudget.softTokens && !softBudgetNotified) {
      softBudgetNotified = true;
      log.warn({ step, usedTokens: convergenceTokens, totalTokens: usedTokens, softTokens: tokenBudget.softTokens }, "loop:budget-converge");
      trace.event("budget-converge", { step, usedTokens: convergenceTokens, totalTokens: usedTokens, softTokens: tokenBudget.softTokens });
    }

    // 硬预算仍是高位保险丝。converge 的软线只发提醒，不在该点返回。
    if (maxTokens !== undefined && usedTokens >= maxTokens) {
      markIncompleteDelivery(runState, "budget");
      log.warn({ step, usedTokens, maxTokens }, "loop:governance-budget（超 token 预算，强制收尾）");
      trace.event("budget-stop", { step, usedTokens, maxTokens });
      return `${assistant.content}\n\n（governance：已达单次 token 预算 ${maxTokens}，提前收尾。）`;
    }

    // 4) 有 tool_calls → 逐个执行并回灌。
    log.info({ step, calls: assistant.toolCalls.map((c) => c.name) }, "loop:tool-calls");
    for (const call of assistant.toolCalls) {
      const auditCallId = `${step}:${call.id}`;
      await emitToolAudit(onToolAudit, { type: "tool-call", source: "outer-loop", tool: call.name, callId: auditCallId, step, status: "requested" });
      const { content, failed, images } = await executeToolSafely(registry, call, ctx, log, toolTimeoutMs);
      messages.push(withToolImages({ role: "tool", toolCallId: call.id, name: call.name, content } as Message, images ?? []));
      log.info({ step, tool: call.name, resultPreview: preview(content) }, "loop:tool-result");
      await emitToolAudit(onToolAudit, {
        type: failed ? "tool-error" : "tool-result", source: "outer-loop", tool: call.name, callId: auditCallId, step,
        status: failed ? (signal?.aborted ? "interrupted" : "failed") : "completed",
      }, content);
    }
    }

    log.warn({ maxSteps }, "loop:max-steps-reached（保险丝触发，强制收尾）");
    markIncompleteDelivery(runState, "max_steps");
    trace.event("max-steps", { maxSteps });
    return "（已达最大步数上限 maxSteps，loop 强制结束。请检查任务是否陷入循环。）";
  } catch (error) {
    traceOutcome = signal?.aborted ? "interrupted" : "failed";
    trace.event("error", { status: traceOutcome, error: String(error instanceof Error ? error.message : error).slice(0, 400) });
    throw error;
  } finally {
    recordSubmittedPlanRunOutcome(execution, agent.name, traceOutcome);
    // 资源回收不复用已 abort 的 signal：停止正是最需要关 tab/释放句柄的时候。
    for (const [key, cleanup] of [...cleanups.entries()].reverse()) {
      try {
        await cleanup();
        log.debug({ key }, "loop:cleanup");
      } catch (error) {
        log.warn({ key, err: error instanceof Error ? error.message : String(error) }, "loop:cleanup-failed");
      }
    }
    cleanups.clear();
    trace.event("end", { status: traceOutcome });
    log.info({ status: traceOutcome }, "loop:end");
    await trace.flush();
  }
}

/**
 * 容错执行单个工具：超时 + 异常都不外抛，转成结构化错误字符串回灌给模型。
 * 文本回执转成 string；验签的图片快照走独立内存通道，不写入文本/Trace/checkpoint。
 */
async function executeToolSafely(
  registry: ToolRegistry,
  call: ToolCall,
  ctx: ToolContext,
  log: Logger,
  timeoutMs: number
): Promise<{ content: string; failed: boolean; images?: readonly ToolImage[] }> {
  try {
    // 工具可声明自己的时限（bash 这类天生慢的），否则用调用方默认值。
    const result = await registry.execute(call.name, call.arguments, ctx, { timeoutMs });
    return { content: typeof result === "string" ? result : JSON.stringify(result), failed: false, images: toolImages(result) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.warn({ tool: call.name, err: message }, "loop:tool-error（已转成错误结果回灌）");
    return { content: JSON.stringify({ error: message, ...coworkFailureFields(e), ...workflowFailureFields(e) }), failed: true };
  }
}

function preview(s: string, n = 160): string {
  const flat = (s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}
