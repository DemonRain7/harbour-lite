import { createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import type { GenerateOptions, LlmAdapter, ContentBlock, TokenUsage } from "@deepseek-ai/dsh-llm";
import type { TurnEndReason } from "@deepseek-ai/dsh-session";
import type { Backend, CompletionRequest, CompletionResult, Message } from "../../types";
import { filterAllowedTools, checkTool } from "../permissions";
import { executeCheckpointedTool } from "../checkpoint";
import { executeWithToolDeadline, resolveToolTimeoutMs } from "../toolTimeout";
import { markMutatingToolStarted } from "../toolActivity";
import { recordSuccessfulToolFileChanges } from "../fileChanges";
import { emitToolAudit } from "../trace";
import { convergenceUsageTokens, totalUsageTokens } from "../governance";
import { estimateRequestTokens } from "../tokenEstimate";
import { ContextWindowExceededError } from "../contextOverflow";
import { ImageInputError } from "../imageIntake";
import { toolImages } from "../toolImages";
import { workflowFailureFields } from "../workflows/registry";
import { coworkFailureFields } from "../cowork/protocol";
import { createDshImages } from "./dshImages";
import { modelSupportsVision } from "../modelCapabilities";
import { TOOL_TIMEOUT_MS } from "../agentLoop";
import { dshOutputTokens } from "../dshLimits";
import { mountDshSpill } from "./dshSpill";

const ARGUMENT_ERROR_CODE = "DSH_TOOL_ARGUMENT_JSON_INVALID";
/** Content-free diagnostics for a rejected tool batch; never stores or echoes raw argument text. */
type ArgumentJsonDiagnostics = { calls: number; bytes: number; failing: number; summary: string; category: string };
/** Closed vocabulary of JSON.parse failure classes (mirrored by the trace whitelist). */
function argumentJsonCategory(message: string): string {
  return /Unexpected end of JSON input/.test(message) ? "unexpected-end"
    : /Unterminated string/.test(message) ? "unterminated-string"
    : /Bad control character/.test(message) ? "control-character"
    : /Bad Unicode escape/.test(message) ? "bad-unicode-escape"
    : /Unexpected number/.test(message) ? "unexpected-number"
    : /Unexpected non-whitespace character after JSON/.test(message) ? "trailing-content"
    : /Unexpected token/.test(message) ? "unexpected-token" : "other";
}
function argumentJsonDiagnostics(calls: Array<{ arguments: string }>): ArgumentJsonDiagnostics {
  let bytes = 0; let failing = 0; let summary = ""; let category = "other";
  for (const call of calls) {
    const raw = typeof call.arguments === "string" ? call.arguments : "";
    bytes += Buffer.byteLength(raw, "utf8");
    try {
      JSON.parse(raw);
    } catch (error) {
      failing++;
      if (summary) continue;
      const message = error instanceof Error ? error.message : String(error);
      // V8 may append a quoted copy of the input; keep the diagnosis, drop any sampled text.
      const marker = message.indexOf(", \"");
      const kept = marker >= 0 && message.includes("is not valid JSON", marker) ? message.slice(0, marker) : message;
      summary = kept.replace(/"[^"]*"/g, "\"…\"").replace(/\s+/g, " ").trim().slice(0, 160);
      category = argumentJsonCategory(message);
    }
  }
  return { calls: calls.length, bytes, failing, summary, category };
}
function argumentRejectionMessage(d: ArgumentJsonDiagnostics): string {
  const detail = [d.summary, `共 ${d.calls} 个调用、${d.bytes} 字节${d.failing > 0 && d.failing < d.calls ? `（其中 ${d.failing} 个解析失败）` : ""}`]
    .filter(Boolean).join("；");
  return `本批工具参数不是完整有效的 JSON（${detail}），整批工具均未执行。只纠正本批参数：长内容拆成小段、改用多次更小的调用；字符串里的换行、引号与反斜杠必须正确转义。保留此前已完成的步骤和稿件，不从头重跑。`;
}

// Keep the ESM kernel lazy: ordinary SDK/Codex startup never loads DSH plugins.
const importEsm = new Function("name", "return import(name)") as <T>(name: string) => Promise<T>;
export async function loadDshKernel() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major! < 22 || (major === 22 && minor! < 12)) throw new Error("DSH 需要 Node.js 22.12+；Claude SDK 后端不受此限制影响");
  const [cordis, llm, sessions, projection, prompt, tools, agents, loop, deepseek, attachments] = await Promise.all([
    importEsm<typeof import("@deepseek-ai/cordis")>("@deepseek-ai/cordis"),
    importEsm<typeof import("@deepseek-ai/dsh-llm")>("@deepseek-ai/dsh-llm"),
    importEsm<typeof import("@deepseek-ai/dsh-session")>("@deepseek-ai/dsh-session"),
    importEsm<typeof import("@deepseek-ai/dsh-session-projection")>("@deepseek-ai/dsh-session-projection"),
    importEsm<typeof import("@deepseek-ai/dsh-system-prompt")>("@deepseek-ai/dsh-system-prompt"),
    importEsm<typeof import("@deepseek-ai/dsh-tools")>("@deepseek-ai/dsh-tools"),
    importEsm<typeof import("@deepseek-ai/dsh-agent")>("@deepseek-ai/dsh-agent"),
    importEsm<typeof import("@deepseek-ai/dsh-agent-loop")>("@deepseek-ai/dsh-agent-loop"),
    importEsm<typeof import("@deepseek-ai/dsh-llm-deepseek")>("@deepseek-ai/dsh-llm-deepseek"),
    importEsm<typeof import("@deepseek-ai/dsh-attachment")>("@deepseek-ai/dsh-attachment"),
  ]);
  return { cordis, llm, sessions, projection, prompt, tools, agents, loop, deepseek, attachments };
}

export function dshEffort(budget?: number): "off" | "low" | "high" | "max" {
  if (budget === undefined) return "high";
  if (budget <= 0) return "off";
  if (budget <= 2048) return "low";
  if (budget <= 16384) return "high";
  return "max";
}

/** Experimental, stateless-per-turn official DSH loop. Harbour owns durable history.
 * No profile loader, shell, filesystem, MCP, subagent, telemetry or log-upload plugin.
 * Images use Harbour's bounded upload/permission intake and native DSH blocks.
 */
export class DeepSeekHarnessBackend implements Backend {
  readonly name = "dsh-harness";
  readonly supportsNativeSessions = false;
  readonly supportsToolImages = true;

  constructor(private opts: {
    apiKey: string;
    logger: Logger;
    defaultModel: string;
    maxOutputTokens?: number;
    uploadDir?: string;
    spillRoot?: string;
    spillInlineTokens?: number;
    /** Offline tests use the real DSH loop with a scripted adapter, never a second loop. */
    createAdapter?: (kernel: Awaited<ReturnType<typeof loadDshKernel>>) => LlmAdapter;
  }) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    req.signal?.throwIfAborted();
    const supportsVision = req.supportsVision ?? modelSupportsVision(req.model === "default" ? this.opts.defaultModel : req.model);
    if (!supportsVision && req.messages.some(m => m.attachments?.some(a => a.kind === "image") || toolImages(m).length))
      throw new ImageInputError("当前 DSH 模型不支持图片输入；请切换视觉模型，图片未发送。");
    if (!this.opts.createAdapter && !this.opts.apiKey) throw new Error("DSH 缺少原 DeepSeek 槽位的 API 凭据");
    const k = await loadDshKernel();
    req.signal?.throwIfAborted();
    const ctx = new k.cordis.Context();
    const log = req.toolContext?.logger ?? this.opts.logger;
    const agentName = req.toolContext?.agent.name ?? "unknown";
    const model = req.model === "default" ? this.opts.defaultModel : req.model;
    const scope = randomUUID();
    const source = req.toolContext?.source;
    // Stable, credential-keyed opaque attribution, not a shared native conversation.
    // No plaintext account/session IDs, random per-turn prefix fields or secret hashes.
    const opaque = (value: unknown) => createHmac("sha256", this.opts.apiKey || "offline-dsh-fixture")
      .update(JSON.stringify(value)).digest("hex");
    const userId = opaque(["harbour-dsh-user-v1", path.resolve(process.cwd()), source?.actor?.platform, source?.actor?.role, source?.actor?.id ?? "system"]);
    const sessionId = opaque(["harbour-dsh-session-v1", userId, agentName, source?.sessionId || source?.key || scope]);
    const maxSteps = Math.max(1, Math.min(req.maxTurns ?? 64, 256));
    const continuation = req.toolContext?.execution?.browserContinuation?.claim();
    let stepLimit = maxSteps;
    const maxOutputTokens = dshOutputTokens(this.opts.maxOutputTokens);
    let requestOutputTokens = maxOutputTokens;
    const permissionMode = req.permissionMode ?? req.toolContext?.permissionMode ?? req.toolContext?.agent.permissionMode;
    const readOnly = permissionMode === "plan" || req.toolContext?.agent.governance?.permissions?.readOnly;
    const tools = (req.toolContext && req.toolContext.source?.actor?.role !== "other" ? filterAllowedTools(req.toolContext.agent, req.tools ?? []) : [])
      .filter(t => (!readOnly || t.readOnly === true) && (supportsVision || t.name !== "view_image"));
    const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheCreationTokens: 0 };
    let handle: AgentHandle | undefined;
    let releaseSteer: (() => void) | undefined;
    let reason: TurnEndReason | undefined;
    let lastReply = "";
    let limited: CompletionResult["incomplete"];
    let contextError: Error | undefined;
    let converging = false;
    let toolCount = 0;
    let modelSteps = 0;
    let finalizingSteps = false;
    let stepReminderSent = false;
    let stepNotice: string | undefined;
    let position = "0:0";
    const dispatched = new Set<string>();
    const requestedTools = new Map<string, string>();
    const auditWrites: Promise<void>[] = [];
    const rejectedArgumentCalls = new Map<string, ArgumentJsonDiagnostics>();
    let argumentCorrections = 0;
    const abort = () => handle?.agent.cancel({ kind: "user" });
    const clean = (value: unknown) => {
      let text = value instanceof Error ? value.message : String(value);
      if (this.opts.apiKey) text = text.split(this.opts.apiKey).join("[redacted]");
      return text.replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]").slice(0, 1600);
    };
    const hardReached = () => !!req.tokenBudget?.hardTokens && totalUsageTokens(usage) >= req.tokenBudget.hardTokens;
    const observeUsage = (value: TokenUsage) => {
      const delta = { promptTokens: value.inputTokens, completionTokens: value.outputTokens,
        cachedTokens: value.cacheReadTokens ?? 0, cacheCreationTokens: value.cacheWriteTokens ?? 0 };
      for (const key of Object.keys(usage) as Array<keyof typeof usage>) usage[key] += delta[key];
      req.onUsage?.(delta);
      if (hardReached()) limited = "budget";
      if (!converging && req.tokenBudget?.softTokens && convergenceUsageTokens(usage) >= req.tokenBudget.softTokens) {
        converging = true;
        handle?.agent.inject(k.llm.createUserMessage({ source: { kind: "user" }, content: [{ type: "text",
          text: "[Harbour 运行预算提醒：请停止额外探索，完成必要收尾并据已确认的工具回执回答当前问题。未确认的结果不能写成成功。]" }] }));
      }
    };
    try {
      const images = await createDshImages(ctx, k.attachments, req.messages, this.opts.uploadDir ?? path.resolve("assets/uploads"), req.signal);
      await ctx.plugin(k.llm.default);
      await ctx.plugin(k.sessions.default);
      await ctx.plugin(k.projection.default);
      await ctx.plugin(k.prompt.default, { includeHarnessIdentity: false, includeRuntimeContext: false });
      ctx.systemPrompt.section({ name: "harbour", order: 0, complete: true, interpolate: false,
        text: req.messages.filter(m => m.role === "system").map(m => m.content).join("\n\n") });
      await ctx.plugin(k.tools.default);
      await ctx.plugin(k.agents.default);
      await ctx.plugin(k.loop.default, { agents: [], maxParallelToolCalls: 1 });
      try {
        await mountDshSpill(ctx, { toolContext: req.toolContext, tools, sessionId,
          root: this.opts.spillRoot ?? path.resolve("data/toolResults"), maxInlineTokens: this.opts.spillInlineTokens });
      } catch {
        log.warn({ agent: agentName }, "loop:dsh-spill-unavailable: preserving original tool results");
      }

      const connection = k.deepseek.resolveAdapterOptions({
        baseURL: "https://api.deepseek.com/anthropic", maxTokens: maxOutputTokens,
        defaultContextWindow: req.contextPolicy?.contextWindow ?? 1_000_000,
        streamIdleTimeoutMs: 120_000, maxImagesPerRequest: 32,
        maxInlineRequestImageBytes: 28 * 1024 * 1024,
        models: [{ id: model, inputModalities: supportsVision ? ["text", "image"] : ["text"] }],
      });
      const provider = this.opts.createAdapter?.(k) ?? new k.deepseek.DeepSeekAdapter({
        options: () => connection,
        resolveAuth: async () => ({ headers: { "x-api-key": this.opts.apiKey } }),
        resolveUserId: () => userId as import("@deepseek-ai/dsh-anonymous-user-id").AnonymousUserId,
        resolveAttachments: () => images.attachments,
        // Select the official adapter's inline fallback locally, before any Files I/O.
        resolveFiles: () => new class extends k.deepseek.DeepSeekFileStore {
          override async ensureUploaded(): Promise<never> { throw new Error("Harbour uses inline images only"); }
        }(),
        prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
      });
      // A wrapper around the OFFICIAL adapter, not a replacement ReAct loop.
      // It enforces Harbour limits on every DSH-internal model request.
      const guarded = new class extends k.llm.LlmAdapter {
        override resolveModel(p: string, m: string, signal?: AbortSignal) { return provider.resolveModel(p, m, signal); }
        async *stream(options: GenerateOptions) {
          req.signal?.throwIfAborted();
          if (hardReached()) { limited = "budget"; throw new Error("Harbour token 硬预算已耗尽"); }
          // maxTurns counts model rounds, not every call in a batched round. Steered
          // DSH turns share this counter; resetting a native turn cannot reset the fuse.
          modelSteps++;
          if (stepNotice) {
            options = { ...options, messages: [...options.messages, k.llm.createUserMessage({ source: { kind: "user" },
              content: [{ type: "text", text: stepNotice }] })] };
            stepNotice = undefined;
          }
          const tokens = estimateRequestTokens(options.messages.map(m => ({ role: m.role === "developer" ? "user" : m.role,
            content: JSON.stringify(m.content) })), tools)
            + options.messages.reduce((sum, m) => sum + m.content.filter(block => block.type === "image").length * 1600, 0);
          if (req.contextPolicy && (tokens > req.contextPolicy.contextLimit || tokens >= req.contextPolicy.contextWindow)) {
            contextError = new ContextWindowExceededError("DSH 本轮上下文已达 Harbour 输入上限；未继续请求，请压缩后续接。");
            throw contextError;
          }
          // A larger output allowance must still fit this request's context and
          // remaining hard budget. These are token bounds, not a dollar guarantee.
          const remainingOutput = req.tokenBudget?.hardTokens
            ? req.tokenBudget.hardTokens - totalUsageTokens(usage) - tokens : maxOutputTokens;
          if (remainingOutput < 1) { limited = "budget"; throw new Error("Harbour 剩余硬预算不足以容纳本次输入，未发送模型请求"); }
          requestOutputTokens = Math.max(1, Math.min(finalizingSteps ? Math.min(maxOutputTokens, 8192) : maxOutputTokens,
            req.contextPolicy ? req.contextPolicy.contextWindow - tokens : maxOutputTokens,
            remainingOutput));
          let latest: TokenUsage | undefined;
          const batch: Array<Extract<ContentBlock, { type: "tool-call" }>> = [];
          try {
            for await (const chunk of provider.stream({ ...options,
              ...(finalizingSteps ? { tools: [], toolHistory: undefined } : {}),
              maxTokens: requestOutputTokens, temperature: req.temperature ?? options.temperature })) {
              if (chunk.type === "usage") latest = chunk.usage;
              if (chunk.type === "block-end" && chunk.block.type === "tool-call") batch.push(chunk.block);
              yield chunk;
            }
          } catch (error) {
            // The pinned official adapter validates JSON at message_stop, after
            // all blocks, but before it emits usage/finish. Do NOT repair JSON or
            // run valid sibling calls. Let the official loop return tool errors
            // for this rejected batch and perform at most one correction step.
            const malformed = error instanceof k.llm.LlmError && error.failure.code === "MALFORMED_RESPONSE"
              && error.message === "DeepSeek Messages stream: tool input is invalid JSON";
            const diagnostics = malformed ? argumentJsonDiagnostics(batch) : undefined;
            if (!diagnostics || diagnostics.failing === 0) throw error;
            const canCorrect = argumentCorrections === 0 && !req.signal?.aborted && !options.signal?.aborted
              && (!req.tokenBudget?.hardTokens || !!latest);
            log.warn({ agent: agentName, errorCode: ARGUMENT_ERROR_CODE, maxOutputTokens: requestOutputTokens,
              toolCount: batch.length, argumentBytes: diagnostics.bytes, argumentError: diagnostics.category,
              usageKnown: !!latest, correction: canCorrect }, "loop:dsh-response-invalid");
            if (!canCorrect) throw new Error("DSH 工具参数 JSON 无效；并非已确认的输出截断。已停止本轮纠正，未执行这批工具；保留原稿和断点。失败请求没有完整用量回执时不能认定免费。");
            argumentCorrections++;
            for (const call of batch) rejectedArgumentCalls.set(`${position}:${call.id}`, diagnostics);
            handle?.agent.inject(k.llm.createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: argumentRejectionMessage(diagnostics) }] }));
            // No fabricated usage or repaired arguments. DSH will reject invalid
            // input schemas; the body guard below rejects every valid sibling.
            yield { type: "finish" as const, reason: { kind: "tool-calls" as const } };
          } finally {
            if (latest) observeUsage(latest);
          }
        }
      }();
      ctx.llm.registerAdapter(["deepseek"], guarded);
      ctx.on("agent/pre-step", async (_payload, next) => {
        if (hardReached() || modelSteps > stepLimit) {
          limited = hardReached() ? "budget" : "max_steps";
          return { kind: "reject" };
        }
        if (modelSteps === stepLimit && continuation?.extend(converging, req.signal)) {
          // All tool results are already checkpointed; keep this exact DSH session,
          // Browser runState, onceKeys, usage counters, deadlines and cancellation.
          stepLimit += maxSteps;
          stepReminderSent = false;
          stepNotice = `[Harbour 分段续行：上一段工具边界已结算，页面仍有新观察结果。继续当前页面的未完成目标；保留已测数据与截图，不重新开局、不重放提交、不扩大任务范围。累计预算与原截止时间不重置；这是同一次 Controller，不需要 Main 再派发。]`;
          log.info({ agent: agentName, modelSteps, stepLimit, ...continuation.snapshot() }, "loop:step-continuation");
        } else if (modelSteps === stepLimit) {
          // One bounded, tool-free handoff preserves measurements and partial work.
          // It cannot repeat writes and never converts an exhausted run to success.
          limited = "max_steps";
          finalizingSteps = true;
          stepNotice = "[Harbour 步数收尾：执行轮数已达上限。本次只允许返回文字，不再调用任何工具。请保留已验证的数据、截图/文件引用、已完成项和未完成项；按当前任务的返回协议报告部分进度，不得把未完成任务写成成功，不得要求从头重放已执行动作。]";
        } else if (!stepReminderSent && modelSteps >= Math.max(1, stepLimit - Math.min(8, Math.ceil(maxSteps / 5)))) {
          stepReminderSent = true;
          stepNotice = `[Harbour 步数提醒：本段剩余 ${stepLimit - modelSteps} 轮。优先保留已验证的数据和必要交接，减少重复观察。${continuation ? "有进展且无不确定操作时运行时可在原页面续行，不要提前 handoff 或新建任务；未收到续行通知不能自行假定额度增加。" : "按已确认回执区分完成与未完成。"}]`;
        }
        return next();
      });
      for (const tool of tools) {
        const inputSchema = z.fromJSONSchema(tool.parameters);
        ctx.tools.register({ name: tool.name, description: tool.description, parameters: tool.parameters,
          output: { schema: { type: "object", properties: { text: { type: "string" }, images: { type: "array", items: { type: "object" } } }, required: ["text", "images"] },
            render: (_args, value) => { const result = value as unknown as { text: string; images: ContentBlock[] }; return [{ type: "text", text: result.text }, ...result.images]; } },
          async execute(raw, exec) {
            const invocation = `${position}:${exec.callId}`;
            dispatched.add(invocation);
            const callId = `${scope}:${invocation}`;
            const args = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
            await emitToolAudit(req.onToolAudit, { type: "tool-call", source: "dsh", tool: tool.name, callId, status: "requested" });
            let started = false;
            try {
              exec.signal.throwIfAborted(); req.signal?.throwIfAborted();
              const rejectedArguments = rejectedArgumentCalls.get(invocation);
              if (rejectedArguments) throw new Error(argumentRejectionMessage(rejectedArguments));
              if (hardReached() || limited) throw new Error("Harbour 运行上限已到，工具未执行");
              toolCount++;
              checkTool(req.toolContext!.agent, tool.name, tool.readOnly);
              if (req.toolContext!.source?.actor?.role === "other") throw new Error("公开用户不能调用 Harbour 工具");
              inputSchema.parse(raw);
              if (readOnly && tool.readOnly !== true) throw new Error("plan/只读模式禁止写工具");
              started = true;
              continuation?.start(tool.name, args);
              if (tool.readOnly !== true) markMutatingToolStarted(req.toolContext!, tool.name);
              log.info({ agent: agentName, step: toolCount, calls: [tool.name] }, "loop:tool-calls");
              const timeout = resolveToolTimeoutMs(tool, args, req.toolContext!, req.toolTimeoutMs ?? TOOL_TIMEOUT_MS);
              const result = await executeCheckpointedTool(tool, args, req.toolContext!, async () => {
                const output = await executeWithToolDeadline(req.toolContext!, timeout, `工具 ${tool.name} 超时`,
                  context => tool.execute(args, { ...context, imageOutputSupported: supportsVision }), exec.signal);
                recordSuccessfulToolFileChanges(tool.name, args, output, req.toolContext!);
                return output;
              });
              await emitToolAudit(req.onToolAudit, { type: "tool-result", source: "dsh", tool: tool.name, callId,
                step: toolCount, status: "completed" }, result);
              continuation?.finish(tool.name, args, result);
              const text = typeof result === "string" ? result : JSON.stringify(result) ?? "null";
              log.info({ agent: agentName, step: toolCount, tool: tool.name, resultPreview: text.slice(0, 1800) }, "loop:tool-result");
              if (!supportsVision && toolImages(result).length) throw new ImageInputError("当前 DSH 模型不能读取工具图片");
              return { text, images: await images.blocksFromPixels(toolImages(result)) };
            } catch (error) {
              continuation?.fail();
              const message = clean(error);
              const rejectedArguments = rejectedArgumentCalls.get(invocation);
              await emitToolAudit(req.onToolAudit, { type: "tool-error", source: "dsh", tool: tool.name, callId,
                step: toolCount, status: !started ? "rejected" : exec.signal.aborted ? "interrupted" : "failed",
                ...(!started ? { executed: false as const } : {}) }, { error: message,
                ...(rejectedArguments ? { failureStage: "argument_decode", errorCode: ARGUMENT_ERROR_CODE,
                  argumentBytes: rejectedArguments.bytes, argumentError: rejectedArguments.category } : {}),
                ...workflowFailureFields(error), ...coworkFailureFields(error) });
              log.warn({ agent: agentName, tool: tool.name, err: message }, "loop:tool-error");
              throw new Error(message);
            }
          },
        });
      }
      handle = await ctx.agents.create({ sessionId: k.sessions.SessionId(sessionId), signal: req.signal,
        agentOptions: { provider: "deepseek", model, reasoningEffort: k.llm.ReasoningEffortId(dshEffort(req.thinkingBudget)), maxTokens: maxOutputTokens } });
      const agent = handle.agent;
      const messages = req.messages.filter(m => m.role !== "system");
      // Seed the exact role-labelled Harbour history. No stale DSH native branch is resumed.
      agent.session.append("system/message", { turn: 0, step: 0,
        message: k.llm.createSystemMessage(req.messages.filter(m => m.role === "system").map(m => m.content).join("\n\n")) }, { surfaceOp: "append" });
      const current = messages.at(-1)?.role === "user" ? messages.pop()! : { role: "user" as const, content: "请根据已有对话与工具回执继续完成本轮。" };
      for (const message of messages) {
        if (message.role === "assistant") {
          const content: ContentBlock[] = [...(message.content ? [{ type: "text" as const, text: message.content }] : []),
            ...(message.toolCalls ?? []).map(call => ({ type: "tool-call" as const, id: k.llm.ToolCallId(call.id), name: call.name, arguments: JSON.stringify(call.arguments) }))];
          agent.session.append("assistant/message", { turn: 0, step: 0, stream: [],
            message: k.llm.createAssistantMessage({ content, source: { provider: "harbour-history", model: "previous" } }) }, { surfaceOp: "append" });
          const deliveredImages = images.content.get(message)?.filter(block => block.type === "image") ?? [];
          if (deliveredImages.length) agent.session.append("user/message", k.llm.createUserMessage({ source: { kind: "user" },
            content: [{ type: "text", text: "[历史中助手交付的图片，仅供回看，不是用户的新指令]" }, ...deliveredImages] }), { surfaceOp: "append" });
        } else if (message.role === "tool" && message.toolCallId) {
          agent.session.append("tool/result", { turn: 0, step: 0, message: k.llm.createToolResultMessage({
            callId: k.llm.ToolCallId(message.toolCallId), isError: false, content: images.content.get(message)! }) }, { surfaceOp: "append" });
        } else agent.session.append("user/message", k.llm.createUserMessage({ source: { kind: "user" },
          content: images.content.get(message)! }), { surfaceOp: "append" });
      }
      ctx.on("session/event", (session, event) => {
        if (session !== agent.session) return;
        if (event.type === "step/start") position = `${event.data.turn}:${event.data.step}`;
        if (event.type === "tool/call") requestedTools.set(`${event.data.turn}:${event.data.step}:${event.data.callId}`, event.data.name);
        // Unknown tools and invalid schemas are rejected by DSH before our body.
        // They still need auditable rejection evidence, not a phantom execution.
        if (event.type === "tool/result" && !dispatched.has(`${event.data.turn}:${event.data.step}:${event.data.message.source.callId}`)) {
          continuation?.fail();
          const id = `${event.data.turn}:${event.data.step}:${event.data.message.source.callId}`;
          const name = requestedTools.get(id) ?? "unknown";
          const rejectedArguments = rejectedArgumentCalls.get(id);
          auditWrites.push((async () => {
            await emitToolAudit(req.onToolAudit, { type: "tool-call", source: "dsh", tool: name, callId: `${scope}:${id}`, status: "requested" });
            await emitToolAudit(req.onToolAudit, { type: "tool-error", source: "dsh", tool: name, callId: `${scope}:${id}`,
              status: "rejected", executed: false }, rejectedArguments
              ? { error: argumentRejectionMessage(rejectedArguments), failureStage: "argument_decode",
                errorCode: ARGUMENT_ERROR_CODE, argumentBytes: rejectedArguments.bytes, argumentError: rejectedArguments.category }
              : { error: "DSH 拒绝未授权工具或无效参数，未执行工具正文" });
          })());
        }
        if (event.type === "turn/end") reason = event.data.reason;
        if (event.type === "assistant/message") {
          const blocks = event.data.message.content;
          lastReply = blocks.some(b => b.type === "tool-call") ? "" : blocks.flatMap(b => b.type === "text" ? [b.text] : []).join("\n");
          const thinking = blocks.flatMap(b => b.type === "reasoning" ? [b.text] : []).join("\n");
          if (thinking) log.info({ agent: agentName, preview: thinking.slice(0, 1800) }, "loop:thinking");
        }
      });
      req.signal?.addEventListener("abort", abort, { once: true });
      req.signal?.throwIfAborted();
      agent.followup(k.llm.createUserMessage({ source: { kind: "user" }, content: images.content.get(current) ?? [{ type: "text", text: messageText(current) }] }));
      releaseSteer = req.toolContext?.execution?.runInputs?.bindNative(async input => {
        if (input.attachments?.length || req.signal?.aborted || agent.status !== "running") return "unavailable";
        agent.steer(k.llm.createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: input.text }] }));
        return "accepted";
      });
      await agent.whenIdle();
      releaseSteer?.(); releaseSteer = undefined;
      await req.toolContext?.execution?.runInputs?.settleNative();
      await Promise.all(auditWrites);
      req.signal?.throwIfAborted();
      if (contextError) throw contextError;
      if (reason?.kind === "error" && !limited) throw new Error(`DSH：${clean(reason.error.message)}`);
      if (reason?.kind === "aborted" && !limited) limited = "interrupted";
      if (reason?.kind === "max-tokens") {
        limited ??= "output_limit";
        log.warn({ agent: agentName, maxOutputTokens: requestOutputTokens, finishReason: "max-tokens" }, "loop:dsh-output-limit");
        lastReply = [lastReply, `DSH 本次模型输出达到 ${requestOutputTokens} token 上限，本轮未完成；未执行被截断的这批工具参数。保留已有稿件与断点，后续只续写缺失部分，不从头重派或重放生图。`].filter(Boolean).join("\n\n");
      }
      if (!reason && !limited) throw new Error("DSH 未收到执行终态，不能认定任务完成");
      continuation?.stopped(limited ?? (!lastReply.trim() ? "empty_reply" : undefined));
      return { message: { role: "assistant", content: lastReply }, usage, usageReported: !!req.onUsage,
        ...((limited || !lastReply.trim()) ? { incomplete: limited ?? "empty_reply" } : {}) };
    } finally {
      releaseSteer?.();
      req.signal?.removeEventListener("abort", abort);
      try { await handle?.dispose(); await Promise.all(auditWrites); }
      finally { await ctx.fiber.dispose(); }
    }
  }
}

function messageText(message: Message): string {
  const attachments = message.attachments?.map(a => `[附件：${a.name}；${a.url}]`).join("\n");
  return [message.content, attachments].filter(Boolean).join("\n") || "（空消息）";
}
