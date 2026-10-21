import os from "node:os";
import { harbourDataHome } from "../storagePaths";
import { invalidateResourceReads } from "../resourceReadCache";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { coworkFailureFields } from "../cowork/protocol";
import { workflowFailureFields } from "../workflows/registry";
import { z } from "zod";
import type {
  Backend,
  CompletionRequest,
  CompletionResult,
  Message,
  ToolDef,
  ToolAuditEvent,
} from "../../types";
import { TOOL_TIMEOUT_MS } from "../agentLoop";
import { executeWithToolDeadline, resolveToolTimeoutMs } from "../toolTimeout";
import { markMutatingToolStarted } from "../toolActivity";
import { executeCheckpointedTool } from "../checkpoint";
import { emitToolAudit } from "../trace";
import { recordSuccessfulToolFileChanges } from "../fileChanges";
import { deepSeekCacheSessionId } from "./deepseekCache";
import { defaultClaudeSdkHome, pruneClaudeSdkTelemetry } from "./claudeSdkHome";
import { claudeSdkContextOptions } from "./claudeSdkContext";
import { claudeSdkEffortEnv } from "./claudeSdkEffort";
import { classifySdkToolFailure, decodeSdkToolResult, sdkToolInputCorrection } from "./sdkToolResult";
import type {
  createSdkMcpServer,
  McpServerConfig,
  query,
  SDKUserMessage,
  tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import { ImageInputError } from "../imageIntake";
import { toolImages, type ToolImage } from "../toolImages";
import { convergenceUsageTokens, totalUsageTokens } from "../governance";
import { withNativeSession, type NativeSessionLease } from "../nativeSession";
import { estimateRequestTokens } from "../tokenEstimate";
import { ContextWindowExceededError } from "../contextOverflow";
import { NativeInputDeliveryError } from "../runInputs";
import { ClaudeSdkInput, userMessage } from "./claudeSdkInput";
interface NativeSdkAttempt {
  lease: NativeSessionLease;
  attemptId: string;
  resumed: boolean;
  toolsStarted: boolean;
  missingSession?: boolean;
  env: Record<string, string | undefined>;
}

type ClaudeAgentSdkModule = {
  createSdkMcpServer: typeof createSdkMcpServer;
  query: typeof query;
  tool: typeof sdkTool;
};

const importEsm = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<ClaudeAgentSdkModule>;

let sdkPromise: Promise<ClaudeAgentSdkModule> | undefined;
let sdkHomePrepared = false;

function loadSdk(): Promise<ClaudeAgentSdkModule> {
  sdkPromise ??= importEsm("@anthropic-ai/claude-agent-sdk");
  return sdkPromise;
}

export class ClaudeAgentSdkBackend implements Backend {
  readonly name = "claude-agent";
  readonly supportsNativeSessions = true;
  readonly supportsToolImages = true;

  constructor(
    private opts: {
      apiKey: string;
      authToken: string;
      baseURL: string;
      defaultModel: string;
      fallbackModel: string;
      /** 视觉输入只允许读取这个受控目录里的已验签文件。 */
      uploadDir: string;
      logger: Logger;
      /** 开启后请求带 thinking（Kimi 会员端点据此走 K2.7），思考过程以 loop:thinking 流出。 */
      thinking?: boolean;
      /** 离线测试可注入 SDK；生产默认仍按原路径懒加载官方模块。 */
      loadSdk?: () => Promise<ClaudeAgentSdkModule>;
    }
  ) {
    if (!opts.apiKey && !opts.authToken && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      opts.logger.warn("Claude Agent SDK 未配置 ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN，实际调用时会失败");
    }
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const native = req.toolContext?.execution?.nativeSession;
    if (!native) return this.completeOnce(req);
    const env = this.buildEnv(req.thinkingBudget);
    const fingerprint = nativeSdkFingerprint(req, this.resolveModel(req.model), env, this.opts);
    return withNativeSession(native, fingerprint, async (lease) => {
      native.active = true;
      let resumed = lease.resumed;
      let rebuilt = false;
      for (;;) {
        const messages = resumed
          ? native.incrementalMessages ?? latestUserMessages(req.messages, native.incrementalInput)
          : await native.prepareSeed?.({ modelRef: req.modelRef, contextPolicy: req.contextPolicy }) ?? req.messages;
        // 系统规则始终来自本轮可信装配；原生历史只替代非 system 的旧对话。
        const effectiveReq = { ...req, messages: [
          ...req.messages.filter((message) => message.role === "system"),
          ...messages.filter((message) => message.role !== "system"),
        ] };
        if (!resumed && req.contextPolicy?.contextLimit) {
          const projectedTokens = estimateRequestTokens(effectiveReq.messages, req.tools);
          if (projectedTokens > req.contextPolicy.contextLimit) throw new ContextWindowExceededError(
            `原生会话种子估算 ${projectedTokens} tok 超过 ${req.modelRef} 的输入上限 ${req.contextPolicy.contextLimit} tok；未向该端点发送请求。`
          );
        }
        const attempt: NativeSdkAttempt = { lease, attemptId: native.attemptId, resumed, toolsStarted: false, env };
        (req.toolContext?.logger ?? this.opts.logger).info({
          mode: rebuilt ? "rebuilt" : resumed ? "resumed" : "created", reason: lease.reason, backend: "claude-agent",
        }, "loop:native-session");
        try {
          const result = await this.completeOnce(effectiveReq, attempt);
          await lease.update({ phase: result.incomplete ? "interrupted" : "finished", lastAttemptId: native.attemptId });
          return result;
        } catch (error) {
          // 只允许确认“原生历史不存在”且尚无任何工具活动时冷启动一次。
          // 传输错误、供应商拒绝、thinking 不兼容均不得伪装成会话丢失并重跑。
          if (!(error instanceof NativeInputDeliveryError) && resumed && !rebuilt && !attempt.toolsStarted && !req.signal?.aborted
            && (attempt.missingSession || nativeSessionNotFound(error))) {
            await lease.reset("native_session_not_found");
            (req.toolContext?.logger ?? this.opts.logger).warn({ agent: req.toolContext?.agent.name }, "sdk:native-session-missing-rebuild");
            resumed = false;
            rebuilt = true;
            continue;
          }
          await lease.update({ phase: "interrupted", lastAttemptId: native.attemptId });
          throw error;
        }
      }
    }, {
      signal: req.signal,
      onWait: state => (req.toolContext?.logger ?? this.opts.logger).info({ state }, "loop:native-session-wait"),
    });
  }

  private async completeOnce(req: CompletionRequest, native?: NativeSdkAttempt): Promise<CompletionResult> {
    const sdk = await (this.opts.loadSdk ?? loadSdk)();
    // 每次 complete 独立作用域：fallback/重试即使复用 provider ID，也不能吞掉新请求。
    const audit = new SdkToolAudit(req.onToolAudit);
    const fileChangeScope = randomUUID();
    const model = this.resolveModel(req.model);
    const sdkContext = claudeSdkContextOptions(model, req.contextPolicy);
    const cacheSessionId = deepSeekCacheSessionId(this.opts.baseURL);
    const readOnlyMode = req.toolContext?.agent?.governance?.permissions?.readOnly === true;
    // agentLoop 已过滤一次；后端再按 ToolDef.readOnly 重算，防未来出现绕过外层 loop 的直调路径。
    const harbourTools = (req.tools ?? []).filter((t) => !readOnlyMode || t.readOnly === true);
    const harbourToolNames = harbourTools.map((t) => `mcp__harbour_tools__${t.name}`);
    const budget = new SdkRunBudget(
      req.tokenBudget,
      req.toolContext?.logger ?? this.opts.logger,
      req.toolContext?.agent?.name,
      req.contextPolicy
    );
    const mcpTools = this.buildTools(sdk, req, harbourTools, budget, () => { if (native) native.toolsStarted = true; });

    // 外部 MCP servers（如 chrome-devtools-mcp）：agent/mcp/index.md 只挂名字，
    // 真配置由装载器从根 mcp/<name>/MCP.md 解析到 Agent.mcpServers。
    // 让 Harbour 真正把外部 MCP server 当工具源消费——工具走独立命名空间 mcp__<name>__<tool>，
    // 与 harbour_tools 互不冲突。底层由 claude CLI 负责按 stdio 拉起（Windows 上的 npx 亦然）。
    const externalServers = req.toolContext?.agent?.mcpServers ?? [];
    // governance 护栏：permissions.mcp 非空即白名单——只挂名字在册的外部 MCP server（未接线过就是假护栏）。
    const mcpAllow = req.toolContext?.agent?.governance?.permissions?.mcp;
    const externalMcp: Record<string, McpServerConfig> = {};
    const externalToolNames: string[] = [];
    for (const s of readOnlyMode ? [] : externalServers) {
      // Managed HTTP MCP is invoked through Harbour read_mcp/call_mcp on every
      // backend. Never expose it a second time via SDK-native MCP.
      if (s.transport === "http" || !s.command) continue;
      if (mcpAllow && mcpAllow.length && !mcpAllow.includes(s.name)) continue; // 不在 permissions.mcp 白名单 → 跳过
      // 展开 args/env 里的环境变量占位（%VAR% / ${VAR}）→ 绝对路径，让 mcp/index.md 保持可移植。
      externalMcp[s.name] = {
        type: "stdio",
        command: s.command,
        args: (s.args ?? []).map(expandEnvVars),
        env: Object.fromEntries(Object.entries(s.env ?? {}).map(([k, v]) => [k, expandEnvVars(v)])),
      };
      // allow 非空 → 精确白名单该 server 内的工具；否则允许该 server 全部工具。
      if (s.allow?.length) {
        for (const t of s.allow) externalToolNames.push(`mcp__${s.name}__${t}`);
      } else {
        externalToolNames.push(`mcp__${s.name}`);
      }
    }

    const mcpServers: Record<string, McpServerConfig> = { ...externalMcp };
    if (mcpTools.length) {
      mcpServers.harbour_tools = sdk.createSdkMcpServer({
        name: "harbour_tools",
        version: "0.1.0",
        tools: mcpTools,
        alwaysLoad: true,
      });
    }
    const toolNames = [...harbourToolNames, ...externalToolNames];

    // 只读 agent 的第一道边界是 Harbour 工具白名单与 ToolDef.readOnly；这里再用 SDK
    // PreToolUse hook 做纵深防御。以后即使误把内置工具或未知 MCP 暴露进来，也会在执行前被拒。
    // hook 不是 Skill 触发器，也不代替权限白名单——只负责拦截已经产生的 tool_use。
    const checkpoint = req.toolContext?.execution?.checkpoint;
    // Hook 补上 SDK 直接管理的外部 MCP：Harbour 自有工具在 buildTools wrapper 里能真正回放，
    // 外部 MCP Hook 只能记录开始/结果，恢复时会明确标成不可回放并安全重跑。
    // Input correction must not depend on audit/checkpoint being enabled. Register
    // the official failure hook for tool-enabled runs, but inject no standing prose.
    const inputCorrections = new Set<string>();
    const collectFileChanges = !!req.toolContext?.execution?.fileChanges;
    const sdkHooks = native || readOnlyMode || checkpoint || req.onToolAudit || toolNames.length > 0 || collectFileChanges
      ? {
          PreToolUse: [{
            hooks: [async (input: {
              hook_event_name?: string;
              tool_name?: string;
              tool_input?: unknown;
              tool_use_id?: string;
            }, toolUseID?: string) => {
              if (input.hook_event_name !== "PreToolUse") return {};
              if (native) native.toolsStarted = true;
              const toolName = String(input.tool_name ?? "unknown");
              const useId = String(input.tool_use_id ?? toolUseID ?? "");
              const args = input.tool_input && typeof input.tool_input === "object"
                ? input.tool_input as Record<string, unknown>
                : {};
              // Hook 在真正执行前等待持久写入；read_file/read_trace 可见此前的工具请求。
              await audit.start(toolName, useId);
              if (native && checkpoint && !toolName.startsWith("mcp__harbour_tools__")) {
                try {
                  checkpoint.assertExternalSafe?.(req.toolContext?.agent?.name ?? "unknown", toolName, args);
                } catch (error) {
                  const reason = error instanceof Error ? error.message : String(error);
                  await audit.finish(useId, toolName, { status: "rejected", executed: false, result: { error: reason } });
                  return { hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "deny" as const,
                    permissionDecisionReason: reason,
                  } };
                }
              }
              if (checkpoint && useId) {
                checkpoint.startExternal(req.toolContext?.agent?.name ?? "unknown", toolName, args, useId);
              }
              if (!readOnlyMode || toolNames.includes(toolName)) return {};
              await audit.finish(useId, toolName, {
                status: "rejected", executed: false,
                result: { error: `Harbour 只读治理拒绝工具：${toolName}` },
              });
              this.opts.logger.warn({ agent: req.toolContext?.agent?.name, tool: toolName }, "sdk:readonly-hook-deny");
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason: `Harbour 只读治理拒绝工具：${toolName}`,
                },
              };
            }],
          }],
          ...(checkpoint || req.onToolAudit || toolNames.length > 0 || collectFileChanges ? {
            PostToolUse: [{
              hooks: [async (input: {
                hook_event_name?: string;
                tool_name?: string;
                tool_use_id?: string;
                tool_input?: unknown;
                tool_response?: unknown;
              }, toolUseID?: string) => {
                if (input.hook_event_name === "PostToolUse") {
                  const useId = String(input.tool_use_id ?? toolUseID ?? "");
                  checkpoint?.completeExternal(useId, input.tool_response);
                  await audit.finish(useId, input.tool_name, { result: input.tool_response });
                  if (req.toolContext && useId) {
                    recordSuccessfulToolFileChanges(String(input.tool_name ?? ""), input.tool_input,
                      input.tool_response, req.toolContext, `sdk:${fileChangeScope}:${useId}`);
                  }
                }
                return {};
              }],
            }],
            PostToolUseFailure: [{
              hooks: [async (input: {
                hook_event_name?: string;
                tool_name?: string;
                tool_use_id?: string;
                error?: string;
                is_interrupt?: boolean;
              }, toolUseID?: string) => {
                if (input.hook_event_name === "PostToolUseFailure") {
                  const useId = String(input.tool_use_id ?? toolUseID ?? "");
                  checkpoint?.failExternal(
                    useId,
                    String(input.error ?? "外部 MCP 执行失败"),
                    input.is_interrupt === true
                  );
                  await audit.finish(useId, input.tool_name, {
                    status: input.is_interrupt === true ? "interrupted" : "failed",
                    result: { error: String(input.error ?? "外部 MCP 执行失败") },
                  });
                  const correction = sdkToolInputCorrection(
                    input.error, String(input.tool_name ?? ""), input.is_interrupt === true,
                  );
                  if (correction && useId && !inputCorrections.has(useId)) {
                    inputCorrections.add(useId);
                    return { hookSpecificOutput: correction };
                  }
                }
                return {};
              }],
            }],
          } : {}),
        }
      : undefined;

    const sdkPrompt = await buildSdkPrompt(req.messages, this.opts.uploadDir);
    if (typeof sdkPrompt !== "string") {
      const images = req.messages.reduce(
        (count, message) => count + toolImages(message).length + (message.attachments?.filter((attachment) => attachment.kind === "image").length ?? 0),
        0
      );
      (req.toolContext?.logger ?? this.opts.logger).info({ agent: req.toolContext?.agent?.name, images }, "vision:input");
    }
    let nativeId = native?.lease.record.nativeId;
    if (native) {
      nativeId ??= randomUUID();
      await native.lease.update({ nativeId, phase: "prepared", lastAttemptId: native.attemptId });
    }
    const eventLogger = req.toolContext?.logger ?? this.opts.logger;
    const inputLease = req.toolContext?.execution?.runInputs;
    // Only the root run owns an inbox. Delegated agents never receive this stream.
    const nativeInput = inputLease ? new ClaudeSdkInput(sdkPrompt, async input => {
      if (input.attachments?.length) {
        if (!req.supportsVision || input.attachments.some(attachment => attachment.kind !== "image")
          || (req.toolContext?.attachments?.length ?? 0) + input.attachments.length > SDK_MAX_IMAGES) return undefined;
      }
      const prompt = await buildSdkPrompt([{ role: "user", content: input.text, attachments: input.attachments }], this.opts.uploadDir);
      if (typeof prompt === "string") return userMessage(input.text);
      for await (const message of prompt) return message;
      return undefined;
    }, (input, uuid) => {
      req.messages.push({ role: "user", content: input.text, attachments: input.attachments });
      if (input.attachments?.length && req.toolContext) {
        req.toolContext.attachments = [...(req.toolContext.attachments ?? []), ...input.attachments];
      }
      eventLogger.info({ agent: req.toolContext?.agent.name, inputId: input.id, uuid }, "loop:sdk-input-accepted");
    }) : undefined;
    const abortController = new AbortController();
    const onAbort = () => { nativeInput?.close(); abortController.abort(); };
    if (req.signal?.aborted) onAbort();
    else req.signal?.addEventListener("abort", onAbort, { once: true });
    let result: ReturnType<typeof query> | undefined;
    let releaseInput: (() => void) | undefined;
    try {
      result = sdk.query({
        prompt: nativeInput?.stream() ?? sdkPrompt,
        options: {
          model: sdkContext.model,
          ...(this.opts.fallbackModel ? { fallbackModel: this.opts.fallbackModel } : {}),
          systemPrompt: toSystemPrompt(req.messages),
          cwd: process.cwd(),
          env: { ...(native?.env ?? this.buildEnv(req.thinkingBudget)), ...sdkContext.env },
          // SDK server（createSdkMcpServer）与外部 stdio 配置都属 McpServerConfig 联合，直接传。
          mcpServers: Object.keys(mcpServers).length ? mcpServers : undefined,
          tools: toolNames,
          allowedTools: toolNames,
          ...(sdkHooks ? { hooks: sdkHooks } : {}),
          // Harbour 使用 SDK 的原生枚举，不再把多个 UI 模式压成 dontAsk。
          // bypassPermissions 按 SDK 契约必须同时显式打开危险跳权确认；Harbour 自己的
          // governance 白名单 / readOnly 过滤 / registry 复检仍然在 SDK 外层生效，不会被绕过。
          permissionMode: req.permissionMode ?? "dontAsk",
          ...(req.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
          persistSession: !!native,
          // 无原生绑定时保留 DeepSeek 固定 cache namespace + persistSession:false 的旧路径。
          // 原生绑定必须使用各自 UUID，不得将跨会话共享的 cache UUID 当作可续跑历史。
          ...(native
            ? native.resumed ? { resume: nativeId } : { sessionId: nativeId }
            : cacheSessionId ? { sessionId: cacheSessionId } : {}),
          settingSources: [],
          maxTurns: req.maxTurns,
          ...(nativeInput ? { extraArgs: { "replay-user-messages": null } } : {}),
          abortController,
          stderr: (data) => {
            if (native && nativeSessionNotFound(data)) native.missingSession = true;
            this.opts.logger.debug({ data }, "claude-agent-sdk:stderr");
          },
        },
      });
      if (nativeInput) releaseInput = inputLease!.bindNative(input => nativeInput.send(input), { nativeOnly: true });

      let final = "";
      // Only a tool-free assistant turn can backfill an empty SDK success result.
      // Progress before tool use is not a completed answer and must not survive it.
      let finalCandidate = "";
      let receivedTerminalResult = false;
      let incomplete: CompletionResult["incomplete"];
      const agentName = req.toolContext?.agent?.name;
      // toolContext.logger 是本轮带 runId/sessionId 的 child logger；用它发 loop 事件，
      // 前端才能在同一 Agent 并发跑 Web/QQ/DC 时精确区分每一轮。
      // SDK 内部自跑 agentic loop（Read/Bash/Edit… 都在子进程里），Harbour 的外层 loop 看不到。
      // 这里把 SDK 流里的 tool_use / tool_result 转成同款 loop:tool-calls / loop:tool-result 事件，
      // 让前端 trace 实时显示「用了什么工具」（就是 CC 那种 USED XXX tool 的感觉）。
      let sdkStep = 0;
      const useNames = new Map<string, string>();
      let apiRetrying = false;
      const incrementallyReported = emptyCompletionUsage();
      const providerMessages = new SdkMessageUsage();
      // SDK result.usage is per native turn, not cumulative across a persistent query.
      let nativeTurnReported = emptyCompletionUsage();
      let usageReported = false;

      for await (const message of result) {
        // SDK 可回送旧消息用于 UI 重放；它们不是本轮新输出、用量或工具活动。
        if ((message as unknown as Record<string, unknown>).isReplay === true) {
          if (message.type === "user" && nativeInput?.acknowledge(message.uuid)) finalCandidate = "";
          continue;
        }
        if (native && message.type === "system" && message.subtype === "init") {
          await native.lease.update({ nativeId: message.session_id, phase: "accepted", lastAttemptId: native.attemptId });
        }
        if (message.type === "system" && message.subtype === "status" && message.status === "compacting") {
          eventLogger.info({ agent: agentName, stage: "started" }, "loop:sdk-compact");
        }
        if (message.type === "system" && message.subtype === "compact_boundary") {
          providerMessages.clearContextObservation();
          invalidateResourceReads(req.toolContext, "sdk-compact-boundary");
          eventLogger.info({ agent: agentName, stage: "completed", before: message.compact_metadata.pre_tokens,
            after: message.compact_metadata.post_tokens, trigger: message.compact_metadata.trigger }, "loop:sdk-compact");
          if (native && Number.isFinite(message.compact_metadata.post_tokens)) {
            await native.lease.update({ contextTokens: message.compact_metadata.post_tokens });
            if (req.toolContext?.execution?.nativeSession) req.toolContext.execution.nativeSession.observedContext = {
              tokens: message.compact_metadata.post_tokens!, modelRef: req.modelRef,
            };
          }
        }
        // Claude Agent SDK 自带 retry/backoff，但过去 Harbour 把这类 system message 静默丢了，
        // 用户只会看到 Trace 停住。把官方 api_retry 事件原样提炼成可持久化的重连状态。
        if (message.type === "system" && message.subtype === "api_retry") {
          apiRetrying = true;
          eventLogger.warn({
            agent: agentName,
            attempt: message.attempt,
            maxRetries: message.max_retries,
            retryDelayMs: message.retry_delay_ms,
            errorStatus: message.error_status,
            error: message.error,
          }, "loop:reconnecting");
        }
        if (message.type === "assistant") {
          if (apiRetrying) {
            apiRetrying = false;
            eventLogger.info({ agent: agentName }, "loop:reconnected");
          }
          // 思考过程（K2.7 等带 thinking 的模型才有）：以 loop:thinking 流到前端 trace。
          const think = thinkingFromAssistant(message.message.content);
          if (think) eventLogger.info({ agent: agentName, preview: previewText(think) }, "loop:thinking");
          const uses = toolUsesFromAssistant(message.message.content);
          const hasToolUse = uses.length > 0 || message.message.stop_reason === "tool_use";
          if (native && hasToolUse) native.toolsStarted = true;
          if (hasToolUse) finalCandidate = "";
          if (uses.length) {
            sdkStep++;
            for (const u of uses) {
              useNames.set(u.id, u.name);
              await audit.start(u.rawName, u.id, sdkStep);
            }
            eventLogger.info({ agent: agentName, step: sdkStep, calls: uses.map((u) => u.name) }, "loop:tool-calls");
          }
          // One provider response can be emitted as several thinking/text/tool frames with
          // distinct SDK uuids but the SAME message.id and cumulative usage. Count bucket
          // deltas, including later output updates, rather than charging each frame again.
          const observed = providerMessages.observe(message.message.id, message.message.usage);
          const turnUsage = observed.delta;
          if (completionUsageTotal(turnUsage) > 0) {
            if (native && observed.context) {
              const tokens = completionUsageTotal(observed.context);
              await native.lease.update({ contextTokens: tokens });
              if (req.toolContext?.execution?.nativeSession) req.toolContext.execution.nativeSession.observedContext = {
                tokens, modelRef: req.modelRef,
              };
            }
            addCompletionUsage(incrementallyReported, turnUsage);
            addCompletionUsage(nativeTurnReported, turnUsage);
            budget.observe(turnUsage);
            req.onUsage?.(turnUsage);
            usageReported = usageReported || !!req.onUsage;
          }
          if (!hasToolUse) {
            const text = textFromAssistant(message.message.content.filter((block: unknown) =>
              !!block && typeof block === "object" && "type" in block && block.type === "text"
            ));
            if (text.trim()) finalCandidate = text;
          }
        }
        if (message.type === "user") {
          // SDK 把工具结果作为 user 消息回灌；按 tool_use_id 找回工具名后流出。
          const toolResults = toolResultsFromUser(message.message.content);
          if (toolResults.length) finalCandidate = "";
          for (const r of toolResults) {
            await audit.finish(r.id, undefined, { result: r.preview, isError: r.isError });
            eventLogger.info(
              { agent: agentName, tool: useNames.get(r.id) ?? "tool", resultPreview: previewText(r.preview) },
              "loop:tool-result"
            );
          }
        }
        if (message.type === "result") {
          // A superseded result is not the end of the active query. Keep accepting while its
          // already-submitted input is pending; otherwise seal synchronously before any await.
          if (!nativeInput?.awaitingReceipt) { nativeInput?.stopAccepting(); releaseInput?.(); }
          receivedTerminalResult = true;
          // Reconcile before examining success/error: an error result can still contain
          // billable output not present in the per-message placeholder usage. A missing or
          // zeroed terminal total must not erase usage already observed before failure.
          const totalUsage = completionUsageFromSdk(message.usage);
          const residual = subtractCompletionUsage(totalUsage, nativeTurnReported);
          if (completionUsageTotal(residual) > 0) {
            addCompletionUsage(incrementallyReported, residual);
            budget.observe(residual);
            req.onUsage?.(residual);
            usageReported = usageReported || !!req.onUsage;
          }
          // 撞 turn 上限【不是错误】，是「做了一半」。抛出去的话 router 会当端点故障，
          // 换个后端把整个任务【从头重跑一遍】—— 在主端点额度已耗尽、只剩备用额度时
          // 这是纯浪费，而且重跑大概率又撞同一个上限，最后给前端一个 500。
          // 改成带着已产出的内容正常返回，让上层/用户看到进展并决定下一步。
          if (message.subtype === "error_max_turns") {
            eventLogger.warn({ agent: agentName, maxTurns: req.maxTurns }, "loop:max-turns");
            incomplete = "max_steps";
            final = `${finalCandidate}\n\n（已达单次运行的步数上限 ${req.maxTurns ?? "?"}，任务未跑完就先收尾了。需要的话让我接着做，或把任务拆小一点。）`.trim();
          } else if (message.subtype !== "success") {
            throw new Error(message.errors.join("\n") || "Claude Agent SDK 执行失败");
          } else if (message.is_error) {
            // Some provider API errors arrive as subtype:success + is_error:true.
            // Never turn an unsupported-window/beta response into a normal answer.
            throw new Error(message.result || "Claude Agent SDK API 请求失败");
          } else {
            final = message.result.trim() ? message.result : finalCandidate;
            if (!final.trim()) incomplete = "empty_reply";
          }
          if (cacheSessionId) {
            const miss = Math.max(0, totalUsage.promptTokens ?? 0);
            const hit = Math.max(0, totalUsage.cachedTokens ?? 0);
            this.opts.logger.info(
              {
                agent: agentName,
                model,
                cacheHitTokens: hit,
                cacheMissTokens: miss,
                cacheHitRatio: hit + miss > 0 ? hit / (hit + miss) : 0,
              },
              "deepseek:cache"
            );
          }
          nativeTurnReported = emptyCompletionUsage();
          if (req.tokenBudget?.hardTokens !== undefined
            && totalUsageTokens(incrementallyReported) >= req.tokenBudget.hardTokens) incomplete = "budget";
          if (nativeInput?.awaitingReceipt && (!incomplete || incomplete === "empty_reply") && !req.signal?.aborted) {
            // Input sent during final text can be queued by the SDK for its next native turn.
            // Keep the SAME query alive and deliver only the answer after that input is consumed.
            receivedTerminalResult = false;
            incomplete = undefined;
            final = ""; finalCandidate = "";
            continue;
          }
          break;
        }
      }

      if (!receivedTerminalResult) {
        throw new Error("Claude Agent SDK stream ended without a terminal result (no-result)");
      }
      // This is the same usage accumulated into SdkRunBudget above, without consuming
      // its notices or asking its stateful tool guard to authorize a synthetic call.
      const hardTokens = req.tokenBudget?.hardTokens;
      if (hardTokens !== undefined && totalUsageTokens(incrementallyReported) >= hardTokens) {
        incomplete = "budget";
      }

      return {
        message: { role: "assistant", content: final },
        usage: incrementallyReported,
        usageReported,
        ...(incomplete ? { incomplete } : {}),
      };
    } catch (error) {
      if (nativeInput?.submitted && !req.signal?.aborted) throw new NativeInputDeliveryError(error);
      throw error;
    } finally {
      releaseInput?.(); nativeInput?.close();
      req.signal?.removeEventListener("abort", onAbort);
      // close() releases the persistent stdin reader, MCP servers and SDK subprocess even on cancellation.
      try { result?.close?.(); }
      finally { if (inputLease && nativeInput) await inputLease.settleNative(); }
    }
  }

  private buildTools(
    sdk: ClaudeAgentSdkModule,
    req: CompletionRequest,
    tools: ToolDef[] = req.tools ?? [],
    budget = new SdkRunBudget(undefined, this.opts.logger),
    onToolStarted?: () => void,
  ) {
    const ctx = req.toolContext;
    if (!ctx) return [];
    // 超时 + 容错必须在这里做：本后端把工具交给 SDK 子进程调度，complete() 返回的
    // assistant 消息从不带 toolCalls，外层 agentLoop 永远在 step 1 就 return——
    // 它那个 executeToolSafely 的保险丝根本够不着这条路。不套的话，一个卡住的工具
    // （例如浏览器等页面）会把整个 claude 子进程挂死，没有任何兜底。
    const defaultTimeoutMs = req.toolTimeoutMs ?? TOOL_TIMEOUT_MS;
    return tools.map((tool) => {
      // 天生就慢的工具（bash 跑 npm install…）用自己的时限，否则默认 30s 会误杀。
      return sdk.tool(
        tool.name,
        tool.description,
        toZodShape(tool),
        async (args) => {
          onToolStarted?.();
          // 与 agentLoop 同款语义：超时/异常都不外抛，转成结构化错误文本回灌给模型，
          // 让它自己决定重试还是换路子——抛出去只会让这一轮整个失败。
          let text: string;
          let images: readonly ToolImage[] = [];
          const parsedArgs = args as Record<string, unknown>;
          const gate = budget.beforeTool(tool.name, parsedArgs);
          if (!gate.allowed) {
            return { content: [{ type: "text" as const, text: JSON.stringify(gate.payload) }] };
          }
          try {
            const timeoutMs = resolveToolTimeoutMs(tool, parsedArgs, ctx, defaultTimeoutMs);
            // 非只读工具一旦开始，当前 backend 后续若断流就不能切 fallback 从头重跑。
            // 在真正执行前记账：即使工具结果不确定，也按“可能已经发生副作用”处理。
            if (tool.readOnly !== true) markMutatingToolStarted(ctx, tool.name);
            const result = await executeCheckpointedTool(tool, parsedArgs, ctx, async () => {
              const output = await executeWithToolDeadline(ctx, timeoutMs,
                `工具 ${tool.name} 执行超过 ${timeoutMs}ms`, (callContext) => tool.execute(parsedArgs,
                  { ...callContext, imageOutputSupported: req.supportsVision === true }), req.signal);
              recordSuccessfulToolFileChanges(tool.name, parsedArgs, output, ctx);
              return output;
            });
            text = stringifyToolResult(result);
            images = toolImages(result);
            const notice = budget.consumeNotice();
            if (notice) text += `\n\n[HARBOUR_BUDGET]\n${JSON.stringify(notice)}`;
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            this.opts.logger.warn(
              { agent: ctx.agent?.name, tool: tool.name, err: message },
              "sdk:tool-error（已转成错误结果回灌）"
            );
            text = JSON.stringify({ error: message, ...coworkFailureFields(e), ...workflowFailureFields(e) });
          }
          return { content: [{ type: "text" as const, text },
            ...images.map(image => ({ type: "image" as const, mimeType: image.mimeType, data: image.data }))] };
        },
        // 与 Harbour fail-closed 语义保持一致：只有显式 true 才告诉 SDK 这是只读工具。
        { annotations: { readOnlyHint: tool.readOnly === true, openWorldHint: false } }
      );
    });
  }

  private resolveModel(model: string): string {
    return model === "default" ? this.opts.defaultModel : model;
  }

  private buildEnv(thinkingBudget?: number): Record<string, string | undefined> {
    // 关键：剔除会干扰认证的继承变量。本进程可能被一个 Claude Code 会话拉起，会带着父会话的
    // 身份（CLAUDECODE / CLAUDE_CODE_*）、机器级 anthropic 配置、以及残留 api key——这些都会让 SDK
    // 内部的 claude 子进程用「别的认证」而不是我们注入的 Kimi token，从而 401。全部清掉。
    const env: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "ANTHROPIC_API_KEY" || k === "ANTHROPIC_AUTH_TOKEN" || k === "ANTHROPIC_BASE_URL") continue;
      // 多模型槽的 key 都在同一个 Harbour 主进程环境里。启动某个 provider 的 SDK 子进程时，
      // 只应注入该槽自己的凭据（下方会改名为 ANTHROPIC_*）；其它 DeepSeek/OpenRouter/未来槽
      // 的 KEY/TOKEN/SECRET 一律剔除，避免跨 provider 泄露或被子进程随手打印。
      if (/(?:^|_)(?:KEY|TOKEN|SECRET)$/.test(k)) continue;
      if (k === "CLAUDECODE" || k === "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE" || k.startsWith("CLAUDE_CODE") || k.startsWith("CLAUDE_AGENT_SDK")) continue;
      env[k] = v;
    }
    // 指向一个全新的空 config 目录，绕开本机 ~/.claude 里存的 OAuth 凭据（否则会被优先采用、把 token 顶掉）。
    const sdkHome = defaultClaudeSdkHome();
    try {
      fs.mkdirSync(sdkHome, { recursive: true });
    } catch {
      /* ignore */
    }
    if (!sdkHomePrepared) {
      sdkHomePrepared = true;
      const pruned = pruneClaudeSdkTelemetry(sdkHome);
      if (pruned.removedFiles > 0) {
        this.opts.logger.info(
          { removedFiles: pruned.removedFiles, removedBytes: pruned.removedBytes },
          "sdk:pruned-failed-telemetry"
        );
      }
    }
    env.CLAUDE_CONFIG_DIR = sdkHome;
    env.CLAUDE_AGENT_SDK_CLIENT_APP = "Harbour";
    // Claude Code 2.1.191 recognizes both flags. Harbour does not need product
    // telemetry or error uploads from its isolated SDK subprocesses.
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    env.DISABLE_TELEMETRY = "1";
    if (this.opts.apiKey) env.ANTHROPIC_API_KEY = this.opts.apiKey;
    if (this.opts.authToken) env.ANTHROPIC_AUTH_TOKEN = this.opts.authToken;
    if (this.opts.baseURL) env.ANTHROPIC_BASE_URL = this.opts.baseURL;
    // 思考预算：per-request 的 effort 档位优先（>0 开思考并设预算；=0 尽量不思考=不设该变量）；
    // 未指定则回退到 opts.thinking（.env 的 CLAUDE_AGENT_THINKING）默认。
    // 注：Kimi 会员端点默认自带思考，omit 该变量≈仍思考；档位「off」在 SDK 路径为「尽量少思考」
    //     的近似（真正 thinking:{type:"disabled"} 需 SDK 支持，暂未接线）。
    if (thinkingBudget !== undefined) {
      if (thinkingBudget > 0) env.MAX_THINKING_TOKENS = String(thinkingBudget);
    } else if (this.opts.thinking) {
      env.MAX_THINKING_TOKENS = "2048";
    }
    Object.assign(env, claudeSdkEffortEnv(this.opts.baseURL, thinkingBudget));
    // Windows 上 claude.exe 执行工具（Bash/Read…）需要 bash 或 PowerShell；
    // 若环境没配 CLAUDE_CODE_GIT_BASH_PATH，从 PATH 或常见路径里找 bash.exe。
    if (os.platform() === "win32" && !env.CLAUDE_CODE_GIT_BASH_PATH) {
      const bash = findBashOnWindows();
      if (bash) env.CLAUDE_CODE_GIT_BASH_PATH = bash;
    }
    return env;
  }
}

function toSystemPrompt(messages: Message[]): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
}

/** 兼容性指纹只落哈希；凭据、MCP 环境及系统正文不能写进原生会话索引。 */
function nativeSdkFingerprint(
  req: CompletionRequest,
  model: string,
  env: Record<string, string | undefined>,
  connection: { baseURL: string; apiKey: string; authToken: string; fallbackModel: string },
): string {
  return createHash("sha256").update(canonicalNativeValue({
    backend: "claude-agent", version: 1, cwd: process.cwd(),
    endpoint: connection.baseURL, apiKey: connection.apiKey, authToken: connection.authToken,
    configHome: env.CLAUDE_CONFIG_DIR ?? defaultClaudeSdkHome(),
    model, fallbackModel: connection.fallbackModel,
    thinkingTokens: env.MAX_THINKING_TOKENS, contextPolicy: req.contextPolicy,
    system: toSystemPrompt(req.messages), mode: req.permissionMode ?? "dontAsk",
    permissions: req.toolContext?.agent.governance?.permissions,
    tools: req.tools?.map((tool) => ({ name: tool.name, description: tool.description,
      parameters: tool.parameters, readOnly: tool.readOnly })),
    mcp: req.toolContext?.agent.mcpServers?.map((server) => ({ ...server,
      args: server.args?.map(expandEnvVars),
      env: Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [key, expandEnvVars(value)])),
    })),
  })).digest("hex");
}

function canonicalNativeValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalNativeValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalNativeValue(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function latestUserMessages(messages: Message[], incrementalInput?: string): Message[] {
  const latest = [...messages].reverse().find((message) => message.role === "user");
  return latest ? [{ ...latest, ...(incrementalInput !== undefined ? { content: incrementalInput } : {}) }]
    : [{ role: "user", content: incrementalInput ?? "继续。" }];
}

function nativeSessionNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:^|\n)\s*(?:Error:\s*)?No conversation found[^\n]*with session(?:\s+ID)?\b/i.test(message);
}

function toPrompt(messages: Message[]): string {
  const body = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      switch (m.role) {
        case "user":
          return `[用户]\n${m.content}${attachmentManifest(m)}`;
        case "assistant":
          return `[助手]\n${m.content}`;
        case "tool":
          return `[工具结果:${m.name ?? ""}]\n${m.content}`;
        case "system":
          return "";
      }
    })
    .filter(Boolean)
    .join("\n\n");
  return body || "继续。";
}

/**
 * 纯文本请求仍保留附件清单。图片请求走 buildSdkPrompt 的原生 image block；这里绝不再
 * 暗示一个可能不存在的 local_path，避免模型用 Bash 在整个仓库里盲找附件。
 */
function attachmentManifest(m: Message): string {
  if (!m.attachments?.length) return "";
  const lines = m.attachments.map(
    (a) => `  - ${a.kind} | ${a.name} | ${a.mime}`
  );
  return `\n[附件]\n${lines.join("\n")}\n图片会由 Harbour 直接作为视觉内容提供；不要使用 Bash 搜索、猜测或重新下载附件。`;
}

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
type SdkPromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: ImageMediaType; data: string } };

const SDK_MAX_IMAGES = 10;
const SDK_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SDK_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Claude Agent SDK 的字符串 prompt 只能表达文字。只要上下文里有可用图片，就切到
 * AsyncIterable<SDKUserMessage>，把同一份扁平会话按原顺序组装成 text/image blocks。
 * 最近图片优先；被压缩前仍在近端窗口里的历史图片可继续被指代，但最多 10 张/20MB。
 */
export async function buildSdkPrompt(
  messages: Message[],
  uploadDir: string
): Promise<string | AsyncIterable<SDKUserMessage>> {
  if (!messages.some((message) => toolImages(message).length || message.attachments?.some((attachment) => attachment.kind === "image"))) {
    return toPrompt(messages);
  }
  const loaded = await loadPromptImages(messages, uploadDir);
  const currentUserIndex = findLastUserIndex(messages);
  const currentHasImage = messages[currentUserIndex]?.attachments?.some((attachment) => attachment.kind === "image") === true;
  if (!loaded.size && currentHasImage) throw new ImageInputError("图片附件没有可用的视觉内容，已阻止模型猜图");

  const blocks: SdkPromptBlock[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]!;
    if (message.role === "system") continue;
    const prefix = message.role === "user"
      ? "[用户]"
      : message.role === "assistant"
        ? "[助手]"
        : `[工具结果:${message.name ?? ""}]`;
    blocks.push({ type: "text", text: `${blocks.length ? "\n\n" : ""}${prefix}\n${message.content}` });
    for (const image of toolImages(message)) {
      blocks.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } });
    }
    for (let attachmentIndex = 0; attachmentIndex < (message.attachments?.length ?? 0); attachmentIndex += 1) {
      const attachment = message.attachments![attachmentIndex]!;
      if (attachment.kind !== "image") {
        blocks.push({ type: "text", text: `\n[${attachment.kind} 附件：${safeLabel(attachment.name)} | ${safeLabel(attachment.mime)}]` });
        continue;
      }
      const image = loaded.get(`${messageIndex}:${attachmentIndex}`);
      if (!image) {
        blocks.push({ type: "text", text: `\n[历史图片附件当前不可用：${safeLabel(attachment.name)}；不要猜测其内容]` });
        continue;
      }
      blocks.push({ type: "text", text: `\n[图片附件：${safeLabel(attachment.name)} | ${image.mediaType}]` });
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: image.mediaType, data: image.data.toString("base64") },
      });
    }
  }
  blocks.push({ type: "text", text: "\n图片像素已经直接提供给你。请根据实际画面回答；看不清就明确说明，不得按尺寸、文件名或上下文猜图。" });

  async function* stream(): AsyncIterable<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: blocks },
      parent_tool_use_id: null,
    } as SDKUserMessage;
  }
  return stream();
}

/** Shared bounded upload reader; native transports must still validate/decode its bytes. */
export async function loadPromptImages(
  messages: Message[],
  uploadDir: string
): Promise<Map<string, { data: Buffer; mediaType: ImageMediaType }>> {
  const root = await fs.promises.realpath(path.resolve(uploadDir)).catch(() => path.resolve(uploadDir));
  const currentUserIndex = findLastUserIndex(messages);
  const loaded = new Map<string, { data: Buffer; mediaType: ImageMediaType }>();
  let totalBytes = 0;
  let count = 0;
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const attachments = messages[messageIndex]?.attachments ?? [];
    for (let attachmentIndex = attachments.length - 1; attachmentIndex >= 0; attachmentIndex -= 1) {
      const attachment = attachments[attachmentIndex]!;
      if (attachment.kind !== "image") continue;
      const current = messageIndex === currentUserIndex;
      if (count >= SDK_MAX_IMAGES) {
        if (current) throw new ImageInputError(`单次视觉输入最多 ${SDK_MAX_IMAGES} 张图片`);
        continue;
      }
      try {
        const candidate = attachment.path
          ? path.resolve(attachment.path)
          : attachment.url.startsWith("/uploads/")
            ? path.resolve(root, decodeURIComponent(attachment.url.slice("/uploads/".length)))
            : "";
        if (!candidate) throw new Error("没有本地路径");
        const resolved = await fs.promises.realpath(candidate);
        if (!isWithin(resolved, root)) throw new Error("路径不在 Harbour 上传目录");
        const stat = await fs.promises.stat(resolved);
        if (!stat.isFile() || stat.size <= 0 || stat.size > SDK_MAX_IMAGE_BYTES) throw new Error("文件大小超限");
        if (totalBytes + stat.size > SDK_MAX_TOTAL_IMAGE_BYTES) {
          if (current) throw new ImageInputError("本轮图片总大小超过 20MB 视觉输入上限");
          continue;
        }
        const data = await fs.promises.readFile(resolved);
        const mediaType = imageMediaType(data);
        if (!mediaType) throw new Error("图片签名无效");
        loaded.set(`${messageIndex}:${attachmentIndex}`, { data, mediaType });
        totalBytes += data.byteLength;
        count += 1;
      } catch (error) {
        if (current) {
          if (error instanceof ImageInputError) throw error;
          throw new ImageInputError(`无法读取图片「${safeLabel(attachment.name)}」：${(error as Error).message}`);
        }
      }
    }
  }
  return loaded;
}

function findLastUserIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index]?.role === "user") return index;
  return -1;
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function imageMediaType(data: Buffer): ImageMediaType | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 6 && ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function safeLabel(value: string): string {
  return String(value || "attachment").replace(/[\r\n\t[\]]+/g, " ").slice(0, 160);
}

function thinkingFromAssistant(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && "type" in block && (block as { type?: string }).type === "thinking"
        ? String((block as { thinking?: string }).thinking ?? "")
        : ""
    )
    .filter(Boolean)
    .join("\n");
}

/** 从 assistant content 抽 tool_use 块；审计保留命名空间，UI 仍使用短名。 */
function toolUsesFromAssistant(content: unknown): Array<{ id: string; name: string; rawName: string }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; name: string; rawName: string }> = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "tool_use") {
      const b = block as { id?: string; name?: string };
      // 去掉 mcp 前缀，显示更干净的工具名。
      const rawName = String(b.name ?? "tool");
      const name = rawName.replace(/^mcp__.+?__/, "");
      out.push({ id: String(b.id ?? ""), name, rawName });
    }
  }
  return out;
}

/** 从 user content 抽 tool_result 块 → [{id, preview}]（SDK 回灌的工具结果）。 */
function toolResultsFromUser(content: unknown): Array<{ id: string; preview: string; isError: boolean }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; preview: string; isError: boolean }> = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "tool_result") {
      const b = block as { tool_use_id?: string; content?: unknown; is_error?: boolean };
      let preview = "";
      if (typeof b.content === "string") preview = b.content;
      else if (Array.isArray(b.content)) {
        preview = b.content
          .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text?: string }).text ?? "") : ""))
          .filter(Boolean)
          .join(" ");
      }
      out.push({ id: String(b.tool_use_id ?? ""), preview, isError: b.is_error === true });
    }
  }
  return out;
}

/** Hook 与 stream 共享真实 SDK ID；不使用同名配对、参数缓存或全局 logger 旁路。 */
class SdkToolAudit {
  private readonly scope = randomUUID();
  private sequence = 0;
  private readonly calls = new Map<string, {
    tool: string;
    callId: string;
    step?: number;
    started?: Promise<void>;
    terminal?: Promise<void>;
  }>();

  constructor(private readonly sink: CompletionRequest["onToolAudit"]) {}

  async start(tool: string, useId: string, step?: number): Promise<void> {
    if (!this.sink) return;
    const call = this.call(useId, tool);
    call.tool = tool;
    if (step !== undefined) call.step = step;
    // 保存正在写入的 promise，避免并发 Hook 在 stream 的写入结束前放行工具。
    call.started ??= emitToolAudit(this.sink, {
      type: "tool-call", source: "claude-sdk", tool: call.tool,
      callId: call.callId, step: call.step, status: "requested",
    });
    await call.started;
  }

  async finish(useId: string, tool: string | undefined, options: {
    status?: ToolAuditEvent["status"];
    result?: unknown;
    isError?: boolean;
    executed?: false;
  }): Promise<void> {
    if (!this.sink) return;
    const call = this.call(useId, tool);
    await call.started;
    if (call.terminal) return call.terminal;
    const decoded = decodeSdkToolResult(options.result);
    const result = decoded.value;
    const row = result && typeof result === "object" && !Array.isArray(result)
      ? result as Record<string, unknown> : undefined;
    const envelopeError = decoded.isError;
    const failure = classifySdkToolFailure(result, call.tool,
      options.isError === true || envelopeError || options.status === "failed");
    // buildTools 保持既有错误文本回灌；不能因 SDK 外壳 is_error=false 就把它写成成功。
    const harbourWrapper = call.tool.startsWith("mcp__harbour_tools__");
    const returnedError = harbourWrapper && typeof row?.error === "string" && row.error.trim().length > 0;
    const budgetRejected = harbourWrapper && row?.error === "HARBOUR_TOKEN_BUDGET_HARD_STOP";
    const status = options.status ?? (budgetRejected ? "rejected"
      : options.isError || envelopeError || row?.isError === true || returnedError || failure ? "failed" : "completed");
    // Keep only machine diagnostics plus the existing redacted result summary.
    // The raw SDK decode error can contain a preview of private tool arguments.
    const auditResult = failure
      ? { ...(row ?? { error: typeof result === "string" ? result : "SDK tool input rejected" }),
          failureStage: failure.failureStage, errorCode: failure.errorCode,
          ...(failure.reasonCode ? { reasonCode: failure.reasonCode } : {}) }
      : result;
    call.terminal = emitToolAudit(this.sink, {
      type: status === "completed" ? "tool-result" : "tool-error",
      source: "claude-sdk", tool: call.tool, callId: call.callId, step: call.step, status,
      ...(options.executed === false || budgetRejected || failure?.executed === false ? { executed: false as const } : {}),
    }, auditResult);
    await call.terminal;
  }

  private call(useId: string, tool?: string) {
    // 缺少 ID 时只记录独立观察，不猜测多个同名/并发调用的对应关系。
    const key = useId || `unidentified-${++this.sequence}`;
    let call = this.calls.get(key);
    if (!call) {
      call = { tool: tool ?? "unknown", callId: `${this.scope}:${key}` };
      this.calls.set(key, call);
    } else if (tool) call.tool = tool;
    return call;
  }
}

function previewText(s: string, n = 200): string {
  const flat = (s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

function textFromAssistant(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && "text" in block ? String(block.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/** JSON-Schema 片段 → zod。递归处理约束，避免 SDK 看到比 Harbour 实际更宽的工具参数。 */
export interface JsonSchemaNode {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
}

export function nodeToZod(prop: JsonSchemaNode): z.ZodType {
  // type 可以是数组（如 submit_plan 的 steps 允许 ["string","object"]）；
  // zod 这里不做联合，退成 unknown 让工具自己宽容解析（各工具都有容错解析）。
  const t = Array.isArray(prop.type) ? (prop.type.length === 1 ? prop.type[0] : undefined) : prop.type;
  switch (t) {
    case "number": {
      let field = z.number();
      if (Number.isFinite(prop.minimum)) field = field.min(prop.minimum!);
      if (Number.isFinite(prop.maximum)) field = field.max(prop.maximum!);
      return field;
    }
    case "integer": {
      let field = z.number().int();
      if (Number.isFinite(prop.minimum)) field = field.min(prop.minimum!);
      if (Number.isFinite(prop.maximum)) field = field.max(prop.maximum!);
      return field;
    }
    case "boolean": return z.boolean();
    case "array": {
      // 【必须递归】否则 z.array(z.unknown()) 会把每一项的结构整个抹掉：
      // submit_plan 的 steps 里 agent / detail / parallel 就再也不会出现在模型看到的
      // schema 里，只剩描述文字，模型多半只回一串字符串，可视 todo 里就没有「派谁」。
      let field = z.array(prop.items ? nodeToZod(prop.items) : z.unknown());
      if (Number.isInteger(prop.minItems) && prop.minItems! >= 0) field = field.min(prop.minItems!);
      if (Number.isInteger(prop.maxItems) && prop.maxItems! >= 0) field = field.max(prop.maxItems!);
      return field;
    }
    case "object": {
      if (!prop.properties) return z.record(z.string(), z.unknown());
      const req = new Set(prop.required ?? []);
      const inner: Record<string, z.ZodType> = {};
      for (const [k, v] of Object.entries(prop.properties)) {
        const f = describe(nodeToZod(v), v.description);
        inner[k] = req.has(k) ? f : f.optional();
      }
      return z.object(inner);
    }
    case "string": {
      const values = (prop.enum ?? []).filter((value): value is string => typeof value === "string");
      // 之前 enum 被静默丢掉，opencli_browser.action 在 SDK/MCP 侧遂退化成任意字符串，
      // 模型会臆造 key/networkidle 等 Harbour 根本不支持的值。枚举必须原样进入 MCP schema。
      if (values.length === 1) return z.literal(values[0]!);
      if (values.length > 1 && values.length === prop.enum?.length) {
        return z.enum(values as [string, ...string[]]);
      }
      let field = z.string();
      if (Number.isInteger(prop.minLength) && prop.minLength! >= 0) field = field.min(prop.minLength!);
      if (Number.isInteger(prop.maxLength) && prop.maxLength! >= 0) field = field.max(prop.maxLength!);
      return field;
    }
    default: return z.unknown();
  }
}

function describe(field: z.ZodType, d?: string): z.ZodType {
  return d ? field.describe(d) : field;
}

function toZodShape(tool: ToolDef): Record<string, z.ZodType> {
  const schema = tool.parameters as { properties?: Record<string, JsonSchemaNode>; required?: string[] };
  const required = new Set(schema.required ?? []);
  const shape: Record<string, z.ZodType> = {};
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const field = describe(nodeToZod(prop), prop.description);
    shape[name] = required.has(name) ? field : field.optional();
  }
  return shape;
}

function findBashOnWindows(): string | undefined {
  const pathEnv = process.env.PATH || process.env.Path || "";
  const dirs = pathEnv.split(";").filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, "bash.exe");
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* continue */
    }
  }
  const fallbacks = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
  ];
  for (const p of fallbacks) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* continue */
    }
  }
  return undefined;
}

type CompletionUsageSnapshot = {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
};

function usageNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function completionUsageFromSdk(value: unknown): CompletionUsageSnapshot {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    promptTokens: usageNumber(row.input_tokens),
    completionTokens: usageNumber(row.output_tokens),
    cachedTokens: usageNumber(row.cache_read_input_tokens),
    cacheCreationTokens: usageNumber(row.cache_creation_input_tokens),
  };
}

function emptyCompletionUsage(): Required<CompletionUsageSnapshot> {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheCreationTokens: 0 };
}

function addCompletionUsage(target: Required<CompletionUsageSnapshot>, delta: CompletionUsageSnapshot): void {
  target.promptTokens += usageNumber(delta.promptTokens);
  target.completionTokens += usageNumber(delta.completionTokens);
  target.cachedTokens += usageNumber(delta.cachedTokens);
  target.cacheCreationTokens += usageNumber(delta.cacheCreationTokens);
}

function subtractCompletionUsage(
  total: CompletionUsageSnapshot,
  reported: Required<CompletionUsageSnapshot>
): Required<CompletionUsageSnapshot> {
  return {
    promptTokens: Math.max(0, usageNumber(total.promptTokens) - reported.promptTokens),
    completionTokens: Math.max(0, usageNumber(total.completionTokens) - reported.completionTokens),
    cachedTokens: Math.max(0, usageNumber(total.cachedTokens) - reported.cachedTokens),
    cacheCreationTokens: Math.max(0, usageNumber(total.cacheCreationTokens) - reported.cacheCreationTokens),
  };
}

function completionUsageTotal(usage: CompletionUsageSnapshot): number {
  return usageNumber(usage.promptTokens) + usageNumber(usage.completionTokens) +
    usageNumber(usage.cachedTokens) + usageNumber(usage.cacheCreationTokens);
}

/** Query-local high-water marks; SDK envelope uuid identifies a frame, not an API call. */
class SdkMessageUsage {
  private readonly messages = new Map<string, Required<CompletionUsageSnapshot>>();
  private latestId?: string;

  clearContextObservation(): void { this.latestId = undefined; }

  observe(id: unknown, usage: unknown): {
    delta: CompletionUsageSnapshot; context?: CompletionUsageSnapshot;
  } {
    const snapshot = completionUsageFromSdk(usage);
    // Older compatibility providers/fixtures may omit the provider id. Do not guess from
    // text or usage equality: two genuine calls can have identical token counts.
    if (typeof id !== "string" || !id.trim()) {
      this.latestId = undefined;
      return { delta: snapshot, context: snapshot };
    }
    const previous = this.messages.get(id);
    if (!previous) this.latestId = id;
    const accumulated = previous ?? emptyCompletionUsage();
    const delta = subtractCompletionUsage(snapshot, accumulated);
    addCompletionUsage(accumulated, delta);
    this.messages.set(id, accumulated);
    return { delta, ...(this.latestId === id ? { context: accumulated } : {}) };
  }
}

const BUDGET_FINALIZER_ACTIONS = new Set([
  "wait",
  "get",
  "inspect_novelai",
  "download",
  "save_data_image",
  "handoff",
  "close",
]);

/**
 * Claude Agent SDK 把几十次工具调用包在一次 complete() 内，外层 agentLoop 看不到中间
 * 边界。这个小守卫因此跟随 SDK 流逐回合计数，并在 Harbour MCP 工具执行前做治理。
 */
export class SdkRunBudget {
  private totalTokens = 0;
  private convergenceTokens = 0;
  private softLogged = false;
  private hardLogged = false;
  private pendingNotice: Record<string, unknown> | null = null;
  private hardFinalizers = 0;

  constructor(
    private readonly policy: CompletionRequest["tokenBudget"],
    private readonly logger: Logger,
    private readonly agent?: string,
    private readonly contextPolicy?: CompletionRequest["contextPolicy"]
  ) {}

  observe(usage: CompletionUsageSnapshot): void {
    this.totalTokens += totalUsageTokens(usage);
    this.convergenceTokens += convergenceUsageTokens(usage);
    const soft = this.policy?.mode === "converge" ? this.policy.softTokens : undefined;
    if (soft !== undefined && this.convergenceTokens >= soft && !this.softLogged) {
      this.softLogged = true;
      this.pendingNotice = {
        level: "soft",
        usedTokens: this.convergenceTokens,
        totalTokens: this.totalTokens,
        softTokens: soft,
        ...(this.contextPolicy ? { contextPolicy: {
          contextWindow: this.contextPolicy.contextWindow,
          contextLimit: this.contextPolicy.contextLimit,
          compactAtTokens: this.contextPolicy.compactAtTokens,
        } } : {}),
        instruction: "这是本轮累计用量的软预算提醒，不是错误，不是上下文窗口已满，也不是新的用户请求；usedTokens/totalTokens 不代表当前上下文占用。上下文容量以运行时 contextPolicy 为准，未知时不可编造；原生压缩由 SDK 处理。保持最后一条用户问题不变并直接回答；不得仅回复‘任务已完成/不再操作’，不要仅因本提醒返回 blocked 或让用户下一轮继续。停止无关探索与重复观察；若完成目标只剩已知步骤（包括派发子 Agent、保存和交付），现在直接执行。只有存在真实外部阻塞时才返回 needs_input/blocked。",
      };
      this.logger.warn({ agent: this.agent, usedTokens: this.convergenceTokens, totalTokens: this.totalTokens, softTokens: soft }, "loop:budget-converge");
    }
    const hard = this.policy?.hardTokens;
    if (hard !== undefined && this.totalTokens >= hard && !this.hardLogged) {
      this.hardLogged = true;
      this.pendingNotice = {
        level: "hard",
        usedTokens: this.totalTokens,
        hardTokens: hard,
        instruction: "高位保险丝已触发。不得开始新探索或新副作用；只可完成已启动结果的等待、下载、保存或 handoff，然后立即返回 blocked/completed。",
      };
      this.logger.error({ agent: this.agent, usedTokens: this.totalTokens, hardTokens: hard }, "loop:budget-hard-stop");
    }
  }

  beforeTool(tool: string, args: Record<string, unknown>): {
    allowed: boolean;
    payload?: Record<string, unknown>;
  } {
    const hard = this.policy?.hardTokens;
    if (hard === undefined || this.totalTokens < hard) return { allowed: true };
    const action = String(args.action ?? "");
    const finalizer = tool === "opencli_browser" && BUDGET_FINALIZER_ACTIONS.has(action);
    if (finalizer && this.hardFinalizers < 8) {
      this.hardFinalizers += 1;
      return { allowed: true };
    }
    return {
      allowed: false,
      payload: {
        error: "HARBOUR_TOKEN_BUDGET_HARD_STOP",
        usedTokens: this.totalTokens,
        hardTokens: hard,
        checkpointPreserved: true,
        instruction: "不要再次调用被拒绝的工具。直接返回 blocked，并说明已完成步骤；会话 checkpoint 已保留，后续可从未完成工具边界继续。",
      },
    };
  }

  consumeNotice(): Record<string, unknown> | null {
    const notice = this.pendingNotice;
    this.pendingNotice = null;
    return notice;
  }
}

function stringifyToolResult(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * 展开命令参数里的环境变量占位：%VAR%（Windows）与 ${VAR}。
 * Chrome profile 与 browserHarness 共用同一套跨平台默认目录；其它未定义变量仍原样保留，
 * 避免静默把未知占位符吞成空字符串。
 */
function expandEnvVars(s: string): string {
  const resolve = (name: string, original: string): string => {
    const configured = process.env[name]?.trim();
    if (configured) return configured;
    if (name === "HARBOUR_CHROME_PROFILE_DIR") {
      const base = harbourDataHome();
      return path.join(base, "chrome-profile");
    }
    return original;
  };
  return s
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, n) => resolve(n, m))
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, n) => resolve(n, m));
}
