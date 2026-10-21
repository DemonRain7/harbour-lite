import { invalidateResourceReads } from "./resourceReadCache";
import type {
  Agent,
  Backend,
  CompletionRequest,
  CompletionResult,
  Message,
  ToolDef,
} from "../types";
import type { Logger } from "pino";
import { mutatingToolActivity } from "./toolActivity";
import { modelIdFromRef, modelSupportsVision } from "./modelCapabilities";
import { NativeInputDeliveryError } from "./runInputs";
import { estimateRequestTokens } from "./tokenEstimate";
import { ContextWindowExceededError } from "./contextOverflow";
import { NativeSessionReentryError } from "./nativeSession";
import { toolImages } from "./toolImages";

/**
 * Router —— 多模型分流。
 *
 * 三件事：
 *  1) 给一个 agent 挑模型（pick）：agent.model 优先；否则按 taskType 查策略表；
 *     策略表可被 agent.routerOverrides 覆盖。
 *  2) 带 fallback 链发起补全（complete）：主模型失败就顺链路重试，首个 fallback
 *     尽量跨 provider，这样某家限流/挂了还能跑。
 *  3) 按 modelRef 前缀把请求分发到对应 backend，对上层屏蔽后端差异。
 *
 * modelRef 形如  <backend前缀>/<provider模型id>
 *   claude-agent/default                    → backend=claude-agent, model=env.CLAUDE_AGENT_MODEL
 *   openrouter/anthropic/claude-sonnet-4.6  → backend=openrouter, model=anthropic/claude-sonnet-4.6
 *   claude-cli/claude-opus-4-8              → backend=claude-cli, model=claude-opus-4-8
 *   mock/whatever                           → backend=mock
 */

export interface ModelChain {
  primary: string;
  /** 按顺序的备选，首个尽量跨 provider。 */
  fallbacks: string[];
}

/**
 * 默认策略表：taskType -> 模型链。
 * 省 token 第一优先：探活/分类走最便宜的，粗活别用贵模型。
 * ⚠️ 这里就是你要调策略的地方。
 */
// claude-agent/default 恒指向 data/models.json 的第 0 个启用槽；具体连接与模型不在
// 源码注释里复制。Agent 若显式钉了 model-slot-* 稳定引用，换槽位顺序也不会改变
// 它自己的首选模型；跨端点容灾统一由 Router.globalFallbacks 按后续启用槽的顺序追加。
export const DEFAULT_STRATEGY: Record<string, ModelChain> = {
  // main：入口 persona（main-elaina / main-aemeath）。未做会话/热覆盖且 frontmatter
  // 未显式钉模型时走这里，使默认连接能通过 data/models.json 动态调整。
  main: { primary: "claude-agent/default", fallbacks: [] },
  heartbeat: { primary: "claude-agent/default", fallbacks: [] },
  classify: { primary: "claude-agent/default", fallbacks: [] },
  research: { primary: "claude-agent/default", fallbacks: [] },
  writing: { primary: "claude-agent/default", fallbacks: [] },
  critical: { primary: "claude-agent/default", fallbacks: [] },
};

/** 兜底链：taskType 不在表里时用最便宜的。 */
const FALLBACK_CHAIN: ModelChain = DEFAULT_STRATEGY.classify!;

export class Router {
  private mockMode: boolean;
  /** 全局 fallback 链：追加到每条 chain 末尾（如开放平台备用后端），实现跨端点容灾。 */
  private globalFallbacks: string[];

  constructor(
    private backends: Record<string, Backend>,
    private logger: Logger,
    private opts: {
      mockMode?: boolean;
      strategy?: Record<string, ModelChain>;
      globalFallbacks?: string[];
      /** 位置别名 → 稳定槽位前缀。用于切主 API 后仍把用量记到正确模型。 */
      canonicalBackendPrefixes?: Record<string, string>;
      /** backend 前缀 → 该连接的默认模型。把 /default 归一成精确模型，防换默认后历史串账。 */
      canonicalDefaultModels?: Record<string, string>;
      /** 所有已启用且确认支持图片的精确 modelRef，供视觉请求构造跨 provider fallback。 */
      visionModelRefs?: string[];
      /** Live capacity per endpoint; validate fallback and inform backend-internal loops. */
      contextPolicyForModel?: (modelRef: string, budget: Agent["contextBudget"]) => NonNullable<CompletionRequest["contextPolicy"]>;
    } = {}
  ) {
    this.mockMode = !!opts.mockMode;
    this.globalFallbacks = opts.globalFallbacks ?? [];
  }

  private get strategy(): Record<string, ModelChain> {
    return this.opts.strategy ?? DEFAULT_STRATEGY;
  }

  /** mock 模式：开启后所有补全转到 mock 后端（供前端/离线热切换）。 */
  get isMock(): boolean {
    return this.mockMode;
  }
  supportsNativeResume(modelRef: string): boolean {
    const prefix = this.canonicalize(modelRef).split("/")[0]!;
    return !this.mockMode && this.backends[prefix]?.supportsNativeSessions === true;
  }
  setMockMode(enabled: boolean): void {
    this.mockMode = enabled;
    this.logger.info({ mockMode: enabled }, "router:mock-mode-changed");
  }

  /** 暴露当前策略表（前端只读展示用）。 */
  getStrategy(): Record<string, ModelChain> {
    return this.strategy;
  }

  /** 把 claude-agent/default 等位置别名改写成稳定槽位 ref；未知 ref 原样返回。 */
  canonicalize(modelRef: string): string {
    const slash = modelRef.indexOf("/");
    if (slash < 0) return modelRef;
    const prefix = modelRef.slice(0, slash);
    const canonical = this.opts.canonicalBackendPrefixes?.[prefix] ?? prefix;
    const requested = modelRef.slice(slash + 1);
    const model = requested === "default"
      ? (this.opts.canonicalDefaultModels?.[prefix] ?? this.opts.canonicalDefaultModels?.[canonical] ?? requested)
      : requested;
    return `${canonical}/${model}`;
  }

  /** 给一个 agent 挑「主」modelRef。 */
  pick(agent: Agent, taskTypeOverride?: string): string {
    const taskType = taskTypeOverride ?? agent.taskType;

    let ref: string | undefined;
    // 0) 显式 per-task 覆盖（如 heartbeat 探活）：以策略表为准，【压过】agent 钉死的 model，
    //    确保探活走便宜路径，不被某个钉了贵模型的 agent 拖累。
    if (taskTypeOverride) {
      ref = agent.routerOverrides?.[taskType] ?? this.strategy[taskType]?.primary;
    }
    // 1) 常规：agent 钉死的 model 最优先；2) 否则按 agent.taskType 查表。
    if (!ref) {
      ref = agent.model ?? agent.routerOverrides?.[taskType] ?? this.strategy[taskType]?.primary ?? FALLBACK_CHAIN.primary;
    }

    // 保护：声明了 tools 却被路由到 claude-cli/*（拿不到结构化 tool_calls）。
    if (ref.startsWith("claude-cli/") && agent.tools.length > 0) {
      this.logger.warn(
        { agent: agent.name, modelRef: ref, tools: agent.tools },
        "agent 声明了 tools 却被路由到 claude-cli/*：CLI 模式拿不到结构化 tool_calls，工具不会被调用"
      );
    }
    return ref;
  }

  /**
   * 组装某次补全的完整尝试链：
   *   [策略表 primary + 其 fallbacks] → [agent 专属 fallbacks] → [全局 fallbacks]
   * 去重、保序；并剔除「backend 未注册」的 ref（避免无意义的失败跳。若全被剔光则保留
   * 原 modelRef，让其在 resolve 时报清楚的错）。
   */
  private buildChain(modelRef: string, agentFallbacks: string[] = []): string[] {
    // Harness 是显式选择的旁路；失败或未启用时都不得改用其它型号/付费端点。
    if (/^(?:codex-app-server|dsh-harness)\//.test(this.canonicalize(modelRef))) return [modelRef];
    const entry = Object.values(this.strategy).find((c) => c.primary === modelRef);
    const base = entry ? [entry.primary, ...entry.fallbacks] : [modelRef];
    const merged = [...base, ...agentFallbacks, ...this.globalFallbacks];

    const seen = new Set<string>();
    const chain: string[] = [];
    for (const ref of merged) {
      if (!ref || seen.has(ref)) continue;
      seen.add(ref);
      // 即使旧配置手工把实验后端塞进容灾链，也不能隐式启用 DSH。
      if (this.canonicalize(ref).startsWith("dsh-harness/")) continue;
      if (!this.isResolvable(ref)) {
        this.logger.warn({ modelRef: ref }, "fallback ref 的 backend 未注册，已跳过");
        continue;
      }
      chain.push(ref);
    }
    return chain.length > 0 ? chain : [modelRef];
  }

  /** ref 的 backend 前缀是否已注册。 */
  private isResolvable(modelRef: string): boolean {
    const slash = modelRef.indexOf("/");
    if (slash < 0) return false;
    return !!this.backends[modelRef.slice(0, slash)];
  }

  /**
   * 统一补全入口。对上层屏蔽后端差异与 fallback。
   * mockMode 下无视一切，全部转到 mock 后端（离线 demo）。
   */
  async complete(args: {
    modelRef: string;
    messages: Message[];
    tools?: ToolDef[];
    toolContext?: CompletionRequest["toolContext"];
    onToolAudit?: CompletionRequest["onToolAudit"];
    maxTurns?: number;
    tokenBudget?: CompletionRequest["tokenBudget"];
    onUsage?: (usage: {
      modelRef: string;
      promptTokens?: number;
      completionTokens?: number;
      cachedTokens?: number;
      cacheCreationTokens?: number;
    }) => void;
    temperature?: number;
    /** agent 专属 fallback 链（来自 agent.fallbacks），追加在策略 fallback 之后。 */
    fallbacks?: string[];
    /** 发起方 agent 名（用于把 fallback 事件归到对应 run 的 trace）。 */
    agentName?: string;
    /** 思考 token 预算（effort 档位）：透传给 backend；undefined=不覆盖。 */
    thinkingBudget?: number;
    /** 权限模式（chat 选择）：plan=只规划不执行；透传给 claude-agent 后端。 */
    permissionMode?: CompletionRequest["permissionMode"];
    /** 单个工具执行超时（毫秒）：透传给【自己执行工具】的后端（claude-agent）。 */
    toolTimeoutMs?: number;
    /** 取消信号：透传给后端原生 loop（SDK abortController）。不透就等于「停止」按钮无效。 */
    signal?: AbortSignal;
    /** Original auto/manual policy, not the already-clamped numeric input limit. */
    contextBudget?: Agent["contextBudget"];
  }): Promise<CompletionResult> {
    if (this.mockMode) {
      const mock = this.backends["mock"];
      if (!mock) throw new Error("mockMode 开启但未注册 mock 后端");
      return mock.complete({
        modelRef: args.modelRef,
        model: args.modelRef,
        messages: args.messages,
        tools: args.tools,
        toolContext: args.toolContext,
        onToolAudit: args.onToolAudit,
        maxTurns: args.maxTurns,
        tokenBudget: args.tokenBudget,
        onUsage: args.onUsage
          ? (usage) => args.onUsage?.({ ...usage, modelRef: args.modelRef })
          : undefined,
        temperature: args.temperature,
      });
    }

    const hasToolImages = args.messages.some(message => toolImages(message).length > 0);
    const requiresVision = hasToolImages || args.messages.some((message) =>
      message.attachments?.some((attachment) => attachment.kind === "image")
    );
    const fullChain = this.buildChain(args.modelRef, args.fallbacks);
    // 视觉请求的 fallback 也必须是视觉模型。宁可明确失败，也不能在端点故障时悄悄
    // 降到 Kimi Code/其它文本模型，让它仅凭文件名或前文猜图。
    const configuredVision = new Set((this.opts.visionModelRefs ?? []).map((ref) => this.canonicalize(ref)));
    const visionCandidates = /^(?:codex-app-server|dsh-harness)\//.test(args.modelRef)
      ? fullChain
      : [...new Set([...fullChain, ...(this.opts.visionModelRefs ?? [])])]
          .filter((ref) => !/^(?:codex-app-server|dsh-harness)\//.test(this.canonicalize(ref)));
    const chain = requiresVision
      ? visionCandidates.filter((ref) => {
          const canonical = this.canonicalize(ref);
          return configuredVision.has(canonical) || modelSupportsVision(modelIdFromRef(canonical));
        })
      : fullChain;
    if (!chain.length) {
      const error = new Error("视觉请求没有可用的多模态模型或视觉 fallback");
      (error as Error & { code?: string }).code = "IMAGE_INPUT_ERROR";
      throw error;
    }
    let lastErr: unknown;
    for (let i = 0; i < chain.length; i++) {
      const ref = chain[i]!;
      // 用户已停止：别把「取消」当成「端点故障」去遍历 fallback 链——那会白烧备用额度，
      // 每槽还可能短暂拉起子进程。直接短路抛出。
      if (args.signal?.aborted) throw new Error("run aborted");
      try {
        const { backend, model, canonicalRef } = this.resolve(ref);
        if (hasToolImages && backend.supportsToolImages !== true) throw new Error("当前后端不能传递工具图片，不能只按文字回执猜图");
        const contextPolicy = this.opts.contextPolicyForModel?.(canonicalRef, args.contextBudget ?? "auto");
        const native = args.toolContext?.execution?.nativeSession;
        const legacyFallback = native && backend.supportsNativeSessions !== true;
        const messages = legacyFallback ? await native.prepareSeed?.({ modelRef: canonicalRef, contextPolicy }) ?? args.messages : args.messages;
        const toolContext = legacyFallback && args.toolContext ? { ...args.toolContext,
          execution: { ...args.toolContext.execution, nativeSession: undefined } } : args.toolContext;
        const contextLimit = contextPolicy?.contextLimit;
        if (typeof contextLimit === "number" && Number.isFinite(contextLimit) && contextLimit > 0) {
          const projectedTokens = estimateRequestTokens(messages, args.tools);
          if (projectedTokens > contextLimit) {
            throw new ContextWindowExceededError(
              `上下文估算 ${projectedTokens} tok 超过 ${canonicalRef} 的输入上限 ${contextLimit} tok；未向该端点发送请求。`
            );
          }
        }
        const req: CompletionRequest = {
          modelRef: ref,
          model,
          supportsVision: configuredVision.has(canonicalRef) || modelSupportsVision(model),
          contextPolicy,
          messages,
          tools: args.tools,
          toolContext,
          onToolAudit: args.onToolAudit,
          maxTurns: args.maxTurns,
          tokenBudget: args.tokenBudget,
          onUsage: args.onUsage
            ? (usage) => args.onUsage?.({ ...usage, modelRef: canonicalRef })
            : undefined,
          temperature: args.temperature,
          thinkingBudget: args.thinkingBudget,
          permissionMode: args.permissionMode,
          toolTimeoutMs: args.toolTimeoutMs,
          signal: args.signal,
        };
        const result = await backend.complete(req);
        // 盖章实际服务的 ref：fallback 切换后 metrics 才能把用量记到真正应答的模型头上。
        return { ...result, servedBy: canonicalRef };
      } catch (e) {
        // 抛错是因为用户停止的，别继续 fallback，直接上抛。
        if (args.signal?.aborted) throw e;
        // A local ownership bug cannot be repaired by sending the same request
        // to another provider (or by bypassing native history with a fallback).
        if (e instanceof NativeSessionReentryError) throw e;
        if (e instanceof NativeInputDeliveryError) throw e;
        // fallback 会从同一组 messages 重新启动完整 agentic loop，不会从工具边界恢复。
        // 本轮进过非只读工具后必须 fail closed，避免重复网页提交、消息发送或文件写入。
        const activity = mutatingToolActivity(args.toolContext);
        if (activity) {
          (args.toolContext?.logger ?? this.logger).warn(
            {
              agent: args.agentName,
              from: ref,
              tool: activity.tool,
              toolStartedAt: activity.startedAt,
              err: (e as Error).message,
            },
            "loop:fallback-suppressed"
          );
          throw e;
        }
        lastErr = e;
        const isLast = i === chain.length - 1;
        const next = isLast ? null : chain[i + 1]!;
        if (next) invalidateResourceReads(args.toolContext, "backend-fallback");
        // 结构化 fallback 事件：msg 固定 "loop:fallback"（前端按它匹配，画进对应 run 的 live trace），
        // 带 agent + from/to ref，让你看到「主端点失败 → 切到哪个后端/模型」。
        (args.toolContext?.logger ?? this.logger).warn(
          { agent: args.agentName, from: ref, to: next, isLast, err: (e as Error).message },
          "loop:fallback"
        );
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** modelRef 前缀 → backend；其余 → 具体 model id。 */
  private resolve(modelRef: string): { backend: Backend; model: string; canonicalRef: string } {
    const slash = modelRef.indexOf("/");
    if (slash < 0) throw new Error(`非法 modelRef（缺少 backend 前缀）: ${modelRef}`);
    const prefix = modelRef.slice(0, slash);
    const model = modelRef.slice(slash + 1);
    const backend = this.backends[prefix];
    if (!backend) throw new Error(`未知 backend 前缀「${prefix}」: ${modelRef}`);
    return { backend, model, canonicalRef: this.canonicalize(modelRef) };
  }
}
