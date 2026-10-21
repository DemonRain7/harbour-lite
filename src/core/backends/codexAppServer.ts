import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { invalidateResourceReads } from "../resourceReadCache";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import { harbourTempDir } from "../storagePaths";
import path from "node:path";
import readline from "node:readline";
import type { Logger } from "pino";
import { coworkFailureFields } from "../cowork/protocol";
import { workflowFailureFields } from "../workflows/registry";
import type {
  Backend,
  CompletionRequest,
  CompletionResult,
  Message,
  ReasoningEffort,
  ToolDef,
} from "../../types";
import { normalizeReasoningEffort } from "../../types";
import { TOOL_TIMEOUT_MS } from "../agentLoop";
import { executeWithToolDeadline, resolveToolTimeoutMs } from "../toolTimeout";
import { executeCheckpointedTool, withNativeToolCall } from "../checkpoint";
import { withNativeSession, type NativeSessionLease } from "../nativeSession";
import { estimateMessagesTokens, estimateRequestTokens } from "../tokenEstimate";
import { ContextWindowExceededError } from "../contextOverflow";
import { markMutatingToolStarted } from "../toolActivity";
import { convergenceUsageTokens } from "../governance";
import { emitToolAudit } from "../trace";
import { recordCodexFileChanges, recordSuccessfulToolFileChanges } from "../fileChanges";
import { CODEX_CONVERSATION_FORMAT, codexConversation } from "./codexConversation";
import { toolImages } from "../toolImages";
import { bundledCodex, type CodexLaunch } from "../codexRuntime";

type JsonObject = Record<string, unknown>;

interface RpcMessage extends JsonObject {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface CodexModelRow {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  isDefault: boolean;
  hidden: boolean;
  inputModalities?: string[];
  defaultReasoningEffort?: ReasoningEffort;
  supportedReasoningEfforts?: Array<{ effort: ReasoningEffort; description?: string }>;
}

export interface CodexHarnessProbe {
  ready: boolean;
  authType?: string;
  planType?: string;
  models: CodexModelRow[];
  defaultModel?: string;
  error?: string;
}

export interface CodexAppServerOptions {
  logger: Logger;
  /** Harbour 受控上传根；只有根内已验证的图片路径可以成为 localImage input。 */
  uploadDir: string;
  /** 测试/自定义安装可覆盖启动命令。args 必须已经定位到 app-server 子命令。 */
  launch?: { command: string; args: string[] };
  /** Resolve once per child process; updates only affect subsequent runs. */
  resolveLaunch?: () => CodexLaunch;
  startupTimeoutMs?: number;
  requireChatgptOAuth?: boolean;
}

interface UsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

interface CodexReconnectEvent {
  attempt?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  errorStatus?: number;
  error?: string;
}

const ZERO_USAGE: UsageBreakdown = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

/**
 * OpenAI Codex App Server backend.
 *
 * 它与 Claude Agent SDK 完全并列：Router 仅在 modelRef 前缀为
 * `codex-app-server/` 时走这里。Harbour 仍拥有 persona、Session、压缩、身份、
 * Governance、checkpoint 与 ToolDef；仅可信 nativeSession 绑定使用持久 thread，
 * 未提供绑定的一次性调用仍保持 ephemeral。
 */
export class CodexAppServerBackend implements Backend {
  readonly name = "codex-app-server";
  readonly supportsNativeSessions = true;
  readonly supportsToolImages = true;

  constructor(private readonly opts: CodexAppServerOptions) {}

  async probe(): Promise<CodexHarnessProbe> {
    const client = this.createClient(this.opts.logger, true);
    try {
      await this.initialize(client);
      const account = await this.readAccount(client);
      if (!account.ready) return { ...account, models: [] };

      const models: CodexModelRow[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const result = asObject(await client.request("model/list", {
          cursor,
          limit: 100,
          includeHidden: false,
        })) as { data?: unknown[]; nextCursor?: unknown };
        for (const value of result.data ?? []) {
          const row = asObject(value);
          const model = String(row.model ?? row.id ?? "").trim();
          if (!model) continue;
          const defaultReasoningEffort = normalizeReasoningEffort(row.defaultReasoningEffort);
          const supportedReasoningEfforts = Array.isArray(row.supportedReasoningEfforts)
            ? row.supportedReasoningEfforts.flatMap((value) => {
                const option = asObject(value);
                const effort = normalizeReasoningEffort(option.reasoningEffort ?? option.effort);
                if (!effort || effort === "off") return [];
                const description = String(option.description ?? "").trim();
                return [{ effort, ...(description ? { description } : {}) }];
              })
            : [];
          models.push({
            id: String(row.id ?? model),
            model,
            displayName: String(row.displayName ?? model),
            ...(String(row.description ?? "").trim() ? { description: String(row.description) } : {}),
            isDefault: row.isDefault === true,
            hidden: row.hidden === true,
            inputModalities: Array.isArray(row.inputModalities) ? row.inputModalities.map(String) : [],
            ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
            ...(supportedReasoningEfforts.length ? { supportedReasoningEfforts } : {}),
          });
        }
        cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
        if (!cursor) break;
      }
      const visible = dedupeModels(models.filter((model) => !model.hidden));
      return {
        ...account,
        models: visible,
        defaultModel: visible.find((model) => model.isDefault)?.model ?? visible[0]?.model,
      };
    } catch (error) {
      return { ready: false, models: [], error: cleanError(error) };
    } finally {
      await client.stop();
    }
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const native = req.toolContext?.execution?.nativeSession;
    if (!native) return this.completeRequest(req);
    const log = req.toolContext?.logger ?? this.opts.logger;
    const client = this.createClient(log);
    try {
      await this.initialize(client);
      const account = await this.readAccount(client);
      if (!account.ready) throw new Error(account.error || "Codex OAuth 未就绪");
      const identity = await codexOAuthIdentity(client.accountIdentity);
      const workspace = codexWorkspacePolicy(req, "<stable-native-scratch>");
      const fingerprint = createHash("sha256").update(JSON.stringify({
        backend: this.name, host: os.hostname(), configHome: path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex")),
        account: identity, launch: client.launch, model: req.model,
        system: req.messages.filter((message) => message.role === "system").map((message) => message.content),
        tools: this.allowedTools(req).map(({ name, description, parameters, readOnly }) => ({ name, description, parameters, readOnly })),
        permissionMode: req.permissionMode, permissions: req.toolContext?.agent.governance?.permissions,
        workspace, harbourCwd: path.resolve(process.cwd()), cowork: req.toolContext?.execution?.cowork,
        config: lockedDownAppServerArgs(), format: CODEX_CONVERSATION_FORMAT,
      })).digest("hex");
      native.active = true;
      return await withNativeSession(native, fingerprint, (lease) => this.completeRequest(req, { client, lease }), {
        signal: req.signal,
        onWait: state => (req.toolContext?.logger ?? this.opts.logger).info({ state }, "loop:native-session-wait"),
      });
    } finally { await client.stop(); }
  }

  private async completeRequest(req: CompletionRequest, persistent?: { client: CodexRpcClient; lease: NativeSessionLease }): Promise<CompletionResult> {
    const log = req.toolContext?.logger ?? this.opts.logger;
    const agentName = req.toolContext?.agent?.name ?? "unknown";
    let scratch = persistent?.lease.directory ?? await fs.mkdtemp(path.join(harbourTempDir(), "harbour-codex-"));
    const client = persistent?.client ?? this.createClient(log.child({ agent: agentName }));
    const lease = persistent?.lease;
    const native = req.toolContext?.execution?.nativeSession;
    let threadId = "";
    let turnId = "";
    let userAborted = false;
    let hardStopped = false;
    let maxStepsStopped = false;
    let softExceeded = false;
    let softSteerSent = false;
    let dynamicCalls = 0;
    const auditScope = randomUUID();
    let auditSequence = 0;
    let latestUsage = { ...ZERO_USAGE };
    let reportedUsage = { ...ZERO_USAGE };
    let reasoningBuffer = "";
    let lastReasoningLogAt = 0;
    let apiRetrying = false;
    // Harbour 固定使用下面注册的 OAuth HTTPS-only provider。部分网络会阻断
    // chatgpt.com 的 WebSocket；不能把 5 次 WS 超时当成每个 ephemeral run 的启动税。
    let activeTransport: "websocket" | "https" = "https";
    let transportFallbackReported = false;
    const reportedRetries = new Set<string>();
    const nativeFileSteps = new Map<string, { step: number; useId: string }>();
    const pendingNativeFileChanges = new Set<string>();
    let terminalTurnStatus = "";
    let turnSubmissionStarted = false;
    let userTurnStarted = false;
    let controlTurn = false;
    let controlResolve: ((turn: JsonObject) => void) | undefined;
    let controlReject: ((error: Error) => void) | undefined;
    let contextTokens = lease?.record.contextTokens;
    let usageBaseline = usageBreakdown(lease?.record.usageTotals);
    let latestThreadUsage = { ...usageBaseline };
    let completionResolve!: (value: JsonObject) => void;
    let completionReject!: (error: Error) => void;
    const completion = new Promise<JsonObject>((resolve, reject) => {
      completionResolve = resolve;
      completionReject = reject;
    });
    // App Server 若在 initialize/thread-start 阶段崩溃，主流程会由对应 RPC request 抛错；
    // 同时给 turn deferred 挂观察者，避免尚未走到 `await completion` 时形成 unhandled rejection。
    void completion.catch(() => undefined);
    client.onExit = (error) => { completionReject(error); controlReject?.(error); };

    const allowedTools = this.allowedTools(req);
    const toolsByName = new Map(allowedTools.map((tool) => [tool.name, tool]));
    const dynamicTools = allowedTools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    }));

    const interrupt = (reason: "hard" | "max-steps" | "user") => {
      if (reason === "hard") hardStopped = true;
      if (reason === "max-steps") maxStepsStopped = true;
      if (reason === "user") userAborted = true;
      if (threadId && turnId) {
        void client.request("turn/interrupt", { threadId, turnId }, 8_000).catch(() => undefined);
      }
    };

    const reportReconnect = (event: CodexReconnectEvent) => {
      const signature = event.attempt !== undefined || event.maxRetries !== undefined
        ? `${event.attempt ?? "?"}/${event.maxRetries ?? "?"}`
        : `unknown:${event.error ?? ""}`;
      if (reportedRetries.has(signature)) return;
      reportedRetries.add(signature);
      apiRetrying = true;
      log.warn({
        agent: agentName,
        attempt: event.attempt,
        maxRetries: event.maxRetries,
        retryDelayMs: event.retryDelayMs,
        errorStatus: event.errorStatus,
        error: event.error,
        transport: activeTransport,
      }, "loop:reconnecting");
    };

    const reportTransportFallback = (detail?: string) => {
      if (transportFallbackReported) return;
      transportFallbackReported = true;
      apiRetrying = true;
      activeTransport = "https";
      log.warn({
        agent: agentName,
        fromTransport: "websocket",
        toTransport: "https",
        error: detail,
      }, "loop:transport-fallback");
    };

    const markReconnected = () => {
      if (!apiRetrying) return;
      apiRetrying = false;
      log.info({ agent: agentName, transport: activeTransport }, "loop:reconnected");
    };

    // Codex 目前会先把第 1 次 WebSocket sampling retry 写到 app-server stderr，
    // 后续 retry 同时还会出现结构化 `error` notification。两路统一去重后上 Trace，
    // 否则用户会在 1 分钟内只看到一个静止的计时器。
    client.onStderrLine = (line) => {
      const retry = reconnectFromStderr(line);
      if (retry) reportReconnect(retry);
      if (isTransportFallbackText(line)) reportTransportFallback(preview(line, 240));
    };

    const beginNativeFileChange = (item: JsonObject): { itemId: string; step: number; useId: string } => {
      const explicitId = String(item.id ?? "").trim();
      if (explicitId) {
        const existing = nativeFileSteps.get(explicitId);
        if (existing) return { itemId: explicitId, ...existing };
      }
      dynamicCalls += 1;
      const itemId = explicitId || `file-change-${dynamicCalls}-${++auditSequence}`;
      const useId = `codex-native:${auditScope}:${itemId}`;
      const step = dynamicCalls;
      nativeFileSteps.set(itemId, { step, useId });
      pendingNativeFileChanges.add(useId);
      // 原生 apply_patch 由 App Server 在工作区里执行，不经过 Harbour dynamic tool
      // wrapper；在 item/started 时先持久化边界，context overflow 才不会把已经写过的
      // 整轮误判成“无工具活动”后从头重跑。只存路径/摘要哈希，不存 patch 正文。
      req.toolContext?.execution?.checkpoint?.startExternal(
        agentName,
        "apply_patch",
        nativeFileChangeMetadata(item),
        useId,
        "codex-native"
      );
      void emitToolAudit(req.onToolAudit, {
        type: "tool-call", source: "codex-native", tool: "apply_patch",
        callId: `${auditScope}:${itemId}`, step, status: "requested",
      });
      log.info({ agent: agentName, step, calls: ["apply_patch"], changes: fileChangePaths(item) }, "loop:tool-calls");
      if (req.toolContext) markMutatingToolStarted(req.toolContext, "apply_patch");
      if (req.maxTurns !== undefined && dynamicCalls > req.maxTurns) interrupt("max-steps");
      return { itemId, step, useId };
    };

    client.onNotification = (method, rawParams) => {
      const params = asObject(rawParams);
      if (method === "error") {
        const retry = reconnectFromNotification(params);
        if (retry) reportReconnect(retry);
        return;
      }
      if (method === "item/started") {
        const item = asObject(params.item);
        if (item.type === "fileChange") {
          beginNativeFileChange(item);
        }
        return;
      }
      if (method === "item/completed") {
        const item = asObject(params.item);
        if (item.type === "contextCompaction") {
          if (params.threadId === threadId) invalidateResourceReads(req.toolContext, "codex-context-compaction");
          return;
        }
        if (item.type === "fileChange") {
          const { itemId, step, useId } = beginNativeFileChange(item);
          const status = String(item.status ?? "completed");
          const detail = fileChangePaths(item);
          pendingNativeFileChanges.delete(useId);
          if (status === "completed") {
            req.toolContext?.execution?.checkpoint?.completeExternal(useId, nativeFileChangeResult(item, status));
            recordCodexFileChanges(item, req.toolContext, `codex:${auditScope}:${itemId}`);
          } else {
            req.toolContext?.execution?.checkpoint?.failExternal(
              useId,
              itemErrorText(item) || `${status}: ${detail}`,
              isInterruptedNativeStatus(status) || req.signal?.aborted === true
            );
          }
          void emitToolAudit(req.onToolAudit, {
            type: status === "completed" ? "tool-result" : "tool-error",
            source: "codex-native", tool: "apply_patch", callId: `${auditScope}:${itemId}`, step,
            status: status === "completed" ? "completed" : status === "declined" ? "rejected" : "failed",
          }, { status, files: Array.isArray(item.changes) ? item.changes : [] });
          if (status === "completed") {
            log.info({ agent: agentName, step, tool: "apply_patch", resultPreview: detail }, "loop:tool-result");
          } else {
            log.warn({ agent: agentName, step, tool: "apply_patch", err: `${status}: ${detail}` }, "loop:tool-error（已转成错误结果回灌）");
          }
          return;
        }
        const detail = itemErrorText(item);
        if (isTransportFallbackText(detail)) {
          reportTransportFallback(detail);
          return;
        }
        if (item.type === "agentMessage") markReconnected();
      }
      if (method === "item/agentMessage/delta" || method === "item/reasoning/textDelta") {
        markReconnected();
      }
      if (method === "item/reasoning/summaryTextDelta") {
        markReconnected();
        reasoningBuffer += String(params.delta ?? "");
        const now = Date.now();
        if (now - lastReasoningLogAt >= 600 && reasoningBuffer.trim()) {
          log.info({ agent: agentName, preview: preview(reasoningBuffer, 420) }, "loop:thinking");
          reasoningBuffer = "";
          lastReasoningLogAt = now;
        }
        return;
      }
      if (method === "thread/tokenUsage/updated") {
        if (persistent && params.threadId && params.threadId !== threadId) return;
        if (!persistent || turnSubmissionStarted || controlTurn) turnId ||= String(params.turnId ?? "");
        const tokenUsage = asObject(params.tokenUsage);
        latestThreadUsage = usageBreakdown(tokenUsage.total);
        // A resume notification may include usage that arrived after the previous
        // client disconnected. Only the durably accounted baseline is subtracted.
        const total = persistent ? subtractUsage(latestThreadUsage, usageBaseline) : latestThreadUsage;
        const last = usageBreakdown(tokenUsage.last);
        if (last.totalTokens > 0) {
          contextTokens = last.totalTokens;
          if (native) native.observedContext = { tokens: contextTokens, modelRef: req.modelRef };
        }
        const delta = subtractUsage(total, reportedUsage);
        latestUsage = total;
        if (delta.totalTokens > 0) {
          reportedUsage = total;
          req.onUsage?.(toHarbourUsage(delta));
        }

        const budget = req.tokenBudget;
        const softUsedTokens = convergenceUsageTokens(toHarbourUsage(total));
        if (budget?.mode === "converge" && budget.softTokens !== undefined &&
            softUsedTokens >= budget.softTokens && !softExceeded) {
          softExceeded = true;
          log.warn({ agent: agentName, usedTokens: softUsedTokens, totalTokens: total.totalTokens, softTokens: budget.softTokens }, "loop:budget-converge");
        }
        // 普通问答即使带着很长的缓存历史也不插入 steer；只有确实已经进入工具探索后，
        // 才用它收敛当前原子任务。控制消息同时重申原始问题，避免覆盖用户追问。
        if (softExceeded && dynamicCalls > 0 && threadId && turnId && !softSteerSent) {
          softSteerSent = true;
          const latestUser = latestUserRequest(req.messages);
          void client.request("turn/steer", {
            threadId,
            expectedTurnId: turnId,
            input: [{
              type: "text",
              text: [
                "[Harbour 运行时软预算提醒：这不是新的用户请求，也不是错误或上下文窗口已满。]",
                `最后一条用户请求仍是：${latestUser}`,
                "保持该请求不变并直接回答；不得只回复‘任务已完成/不再操作’，不要仅因本提醒返回 blocked 或让用户另开会话。停止重复观察和扩展探索；若完成目标只剩已知步骤（包括委派、提交计划、保存和交付），现在直接执行。只有真实外部阻塞才报告 needs_input/blocked。",
              ].join("\n"),
            }],
          }, 8_000).catch((error) => {
            log.debug({ err: cleanError(error) }, "codex:budget-steer-unavailable");
          });
        }
        if (budget?.hardTokens !== undefined && total.totalTokens >= budget.hardTokens && !hardStopped) {
          log.warn({ agent: agentName, usedTokens: total.totalTokens, hardTokens: budget.hardTokens }, "loop:governance-budget");
          interrupt("hard");
        }
        return;
      }
      if (method === "turn/completed") {
        const turn = asObject(params.turn);
        if (controlTurn) { controlResolve?.(turn); return; }
        if (persistent && !turnSubmissionStarted) return;
        terminalTurnStatus = String(turn.status ?? "");
        if (terminalTurnStatus === "completed") markReconnected();
        if (!turnId || String(turn.id ?? "") === turnId) completionResolve(turn);
      }
    };

    client.onServerRequest = async (method, rawParams) => {
      if (method !== "item/tool/call") {
        throw Object.assign(new Error(`Harbour 不接受 Codex 原生请求：${method}`), { rpcCode: -32601 });
      }
      const params = asObject(rawParams);
      const name = String(params.tool ?? "");
      const tool = toolsByName.get(name);
      const args = isRecord(params.arguments) ? params.arguments : {};
      // This request, not the advertised dynamicTools list or later wire receipt,
      // is the actual invocation boundary. Scope provider IDs to this completion.
      const callId = `${auditScope}:${String(params.callId ?? `dynamic-${++auditSequence}`)}`;
      await emitToolAudit(req.onToolAudit, {
        type: "tool-call", source: "codex-dynamic", tool: name, callId, status: "requested",
      });
      const rejected = async (error: string) => {
        await emitToolAudit(req.onToolAudit, {
          type: "tool-error", source: "codex-dynamic", tool: name, callId,
          status: "rejected", executed: false,
        }, { error });
        return dynamicToolResponse(false, { error });
      };
      if (!tool || !req.toolContext) {
        return rejected(`工具未获 Harbour 授权：${name}`);
      }
      if (persistent && !turnSubmissionStarted) return rejected("正在核对持久线程状态；未授权恢复旧运行的工具调用");
      dynamicCalls += 1;
      if (req.maxTurns !== undefined && dynamicCalls > req.maxTurns) {
        interrupt("max-steps");
        return rejected(`已达 Harbour maxSteps=${req.maxTurns}，停止继续调用工具`);
      }
      if (hardStopped) {
        return rejected("已达 Harbour token 硬预算，工具未执行");
      }
      if (req.signal?.aborted) {
        interrupt("user");
        return rejected("用户已停止本次运行，工具未执行");
      }

      log.info({ agent: agentName, step: dynamicCalls, calls: [name] }, "loop:tool-calls");
      if (tool.readOnly !== true) markMutatingToolStarted(req.toolContext, tool.name);
      try {
        const timeoutMs = resolveToolTimeoutMs(tool, args, req.toolContext!, req.toolTimeoutMs ?? TOOL_TIMEOUT_MS);
        const execute = () => executeCheckpointedTool(tool, args, req.toolContext!, async () => {
          const output = await executeWithToolDeadline(req.toolContext!, timeoutMs,
            `工具 ${tool.name} 执行超过 ${timeoutMs}ms`, (callContext) => tool.execute(args,
              { ...callContext, imageOutputSupported: req.supportsVision === true }), req.signal);
          recordSuccessfulToolFileChanges(tool.name, args, output, req.toolContext!);
          return output;
        });
        const result = persistent
          ? await withNativeToolCall(`${threadId}/${String(params.callId ?? callId)}`, execute)
          : await execute();
        const text = stringifyToolResult(result);
        log.info({ agent: agentName, step: dynamicCalls, tool: name, resultPreview: preview(text) }, "loop:tool-result");
        await emitToolAudit(req.onToolAudit, {
          type: "tool-result", source: "codex-dynamic", tool: name, callId, step: dynamicCalls, status: "completed",
        }, result);
        return dynamicToolResponse(
          true,
          softExceeded
            ? `${text}\n\n[Harbour 运行时提醒：保持最后一条用户请求不变，用现有结果直接回答；追问必须回答问题，不得只报告任务已完成。]`
            : text,
          { tool, args, result }
        );
      } catch (error) {
        const message = cleanError(error);
        log.warn({ agent: agentName, step: dynamicCalls, tool: name, err: message }, "loop:tool-error（已转成错误结果回灌）");
        await emitToolAudit(req.onToolAudit, {
          type: "tool-error", source: "codex-dynamic", tool: name, callId, step: dynamicCalls,
          status: req.signal?.aborted ? "interrupted" : "failed",
        }, { error: message, ...coworkFailureFields(error), ...workflowFailureFields(error) });
        return dynamicToolResponse(false, { error: message, ...coworkFailureFields(error), ...workflowFailureFields(error) });
      }
    };

    const abortListener = () => {
      interrupt("user");
      // resolve 成 interrupted，避免 Abort 恰好发生在 turn/start 尚未返回时产生一条
      // 尚无人 await 的 rejected Promise；下面统一按 userAborted 抛出。
      completionResolve({ id: turnId || "aborted", status: "interrupted", items: [] });
    };
    req.signal?.addEventListener("abort", abortListener, { once: true });
    let releaseUserSteer: (() => void) | undefined;

    try {
      if (!persistent) {
        await this.initialize(client);
        const account = await this.readAccount(client);
        if (!account.ready) throw new Error(account.error || "Codex OAuth 未就绪");
      }
      if (req.signal?.aborted) throw new Error("run aborted（用户停止了本次运行）");

      const system = req.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
      const planOnly = req.permissionMode === "plan";
      let workspace = codexWorkspacePolicy(req, scratch);
      const harnessInstructions = [
        "你正作为 Harbour 的可选 Codex Harness 后端运行。Harbour 是会话、身份、权限、工具与 checkpoint 的唯一事实源。",
        workspace.fileChanges
          ? "只能调用本轮 dynamicTools 中列出的 Harbour 工具；唯一例外是可用 Codex 原生 apply_patch 修改当前 Harbour 项目。读取与命令仍走 Harbour 工具；不要尝试原生 shell、网页搜索、MCP、插件、skills 或 subagent。"
          : "只能调用本轮 dynamicTools 中列出的 Harbour 工具；不要尝试 Codex 原生 shell、网页搜索、MCP、插件、skills、subagent 或本机文件工具。",
        "已列出的 Harbour 工具（包括其管理的只读 MCP）可以按权限调用；上述禁用范围仅指 Codex 原生能力。",
        "工具确认与 ask_user 必须走 Harbour 工具，不得使用 Codex 原生审批或提问接口。",
        planOnly ? "当前 Mode=plan：只规划；仅可使用显式只读工具，不得产生外部副作用。" : "严格遵守 Harbour 注入的 persona 与治理规则。",
      ].join("\n");
      const developerInstructions = [system, harnessInstructions].filter(Boolean).join("\n\n");
      const threadConfiguration = {
        model: req.model,
        cwd: workspace.cwd,
        approvalPolicy: "never",
        sandbox: workspace.threadSandbox,
        // Harbour 已经提供 persona、会话与治理；覆盖 Codex 面向代码仓库的厚默认指令，
        // 避免每轮额外灌入与本场景无关的 CLI/工作区规范。dynamic tool schema 仍由
        // App Server 正常注入。
        baseInstructions: "You are the model runtime inside Harbour. Follow the developer instructions and the supplied conversation. Use only the dynamic tools explicitly provided for this turn. Always answer the last user message directly; prior completion status is context, never a substitute for answering a follow-up question.",
        developerInstructions,
        dynamicTools,
        serviceName: "harbour",
      };
      let resumedHistory = false;
      let baselineTurnId: string | undefined;
      let recoveredTurn: JsonObject | undefined;
      if (lease?.record.nativeId) {
        threadId = lease.record.nativeId;
        try {
          const read = asObject(await client.request("thread/read", { threadId, includeTurns: true }));
          let stored = asObject(read.thread);
          const turns = Array.isArray(stored.turns) ? stored.turns.map(asObject) : [];
          let last = turns.at(-1);
          if (asObject(stored.status).type === "systemError") throw new Error("Codex 持久线程处于 systemError，必须先核对，不能重放输入");
          // Installed 0.153.4 persists dynamicTools but ThreadResumeParams does not
          // accept them. Exact schema/policy fingerprint equality is therefore required.
          const { dynamicTools: _persistedTools, serviceName: _service, ...resumeConfiguration } = threadConfiguration;
          await client.request("thread/resume", { threadId, ...resumeConfiguration });
          if (last?.status === "inProgress" || asObject(stored.status).type === "active") {
            if (!last?.id) throw new Error("Codex 持久线程仍有未知活跃运行；拒绝提交新输入");
            controlTurn = true;
            try {
              await client.request("turn/interrupt", { threadId, turnId: String(last.id) }, 8_000);
              stored = asObject(asObject(await client.request("thread/read", { threadId, includeTurns: true })).thread);
              last = (Array.isArray(stored.turns) ? stored.turns.map(asObject) : []).at(-1);
              if (!last || last.status === "inProgress" || asObject(stored.status).type === "active") {
                throw new Error("Codex 原运行中断尚未确认；拒绝重放已接受的输入");
              }
            } finally { controlTurn = false; }
          }
          resumedHistory = turns.length > 0;
          baselineTurnId = typeof last?.id === "string" ? last.id : undefined;
          const sameAttempt = lease.record.lastAttemptId === native?.attemptId;
          const recoveringAccepted = native?.resumingCheckpoint && lease.record.phase === "accepted";
          if (lease.record.phase === "accepted" && !lease.record.nativeTurnId && last?.id &&
              last.id === lease.record.nativeBaselineTurnId) {
            throw new Error("Codex 未确认接受本次输入：持久线程仍停在发送前的旧轮次；不能把旧答案冒充本次结果，需核对后重新提交原请求");
          }
          if (last?.status === "completed" && (sameAttempt || (recoveringAccepted && native?.recoveryOnly === true))) recoveredTurn = last;
          if (lease.record.phase === "accepted" && lease.record.nativeTurnId && last?.id !== lease.record.nativeTurnId) {
            throw new Error("Codex 已接受运行与持久线程最后一轮不匹配；必须先核对，不能盲目重放");
          }
        } catch (error) {
          if (!isMissingCodexThread(error) || dynamicCalls > 0) throw error;
          await lease.reset("codex-thread-missing");
          scratch = lease.directory;
          workspace = codexWorkspacePolicy(req, scratch);
          threadConfiguration.cwd = workspace.cwd;
          threadId = "";
          resumedHistory = false;
          contextTokens = undefined;
          usageBaseline = { ...ZERO_USAGE };
          latestThreadUsage = { ...ZERO_USAGE };
          log.warn({ agent: agentName }, "loop:native-session-reset");
        }
      }
      if (!threadId) {
        const thread = asObject(await client.request("thread/start", { ...threadConfiguration, ephemeral: !persistent }));
        threadId = String(asObject(thread.thread).id ?? "");
        if (threadId && lease) await lease.update({ nativeId: threadId, phase: "prepared" });
      }
      if (!threadId) throw new Error("Codex App Server 未返回 thread id");
      if (req.signal?.aborted) throw new Error("run aborted（用户停止了本次运行）");
      if (lease) log.info({ agent: agentName, backend: this.name,
        mode: resumedHistory ? "resumed" : lease.reason === "new_scope" ? "created" : "rebuilt", reason: lease.reason }, "loop:native-session");
      if (native && contextTokens !== undefined) native.observedContext = { tokens: contextTokens, modelRef: req.modelRef };

      if (recoveredTurn) {
        await lease!.update({ phase: "finished", lastAttemptId: native!.attemptId });
        const final = finalTextFromTurn(recoveredTurn);
        return { message: { role: "assistant", content: final || "（Codex 已完成的运行没有可显示文本。）" },
          usage: toHarbourUsage(latestUsage), usageReported: !!req.onUsage && reportedUsage.totalTokens > 0,
          ...(final ? {} : { incomplete: "empty_reply" as const }) };
      }
      const messages = persistent
        ? resumedHistory ? native?.incrementalMessages ?? lastUserMessages(req.messages)
          : await native?.prepareSeed?.({ modelRef: req.modelRef, contextPolicy: req.contextPolicy }) ?? req.messages
        : req.messages;
      if (persistent && !resumedHistory && req.contextPolicy &&
          estimateRequestTokens(messages, allowedTools) > req.contextPolicy.contextLimit) {
        throw new ContextWindowExceededError("Codex 原生线程重建后的完整上下文超过当前模型输入容量；未启动模型轮次或工具，请收拢输入后继续。");
      }
      if (persistent && resumedHistory && contextTokens && req.contextPolicy &&
          contextTokens + estimateMessagesTokens(messages) >= req.contextPolicy.compactAtTokens) {
        controlTurn = true;
        try {
          const before = contextTokens;
          log.info({ agent: agentName, stage: "started", before }, "loop:native-compact");
          const compacted = new Promise<JsonObject>((resolve, reject) => { controlResolve = resolve; controlReject = reject; });
          void compacted.catch(() => undefined);
          await client.request("thread/compact/start", { threadId });
          const result = await withToolGuards(compacted, 60_000, req.signal, "Codex thread compaction");
          if (result.status !== "completed") throw new Error("Codex 原生上下文压缩未完成；未提交用户输入");
          // Manual compaction is an independent native turn. Refresh the sending
          // watermark from persisted history, otherwise a lost/rejected turn/start
          // could mistake that completed compaction for the accepted user request.
          const compactedThread = asObject(asObject(await client.request("thread/read", { threadId, includeTurns: true })).thread);
          const compactedLast = (Array.isArray(compactedThread.turns) ? compactedThread.turns.map(asObject) : []).at(-1);
          if (typeof result.id !== "string" || compactedLast?.id !== result.id || compactedLast.status !== "completed" ||
              ["active", "systemError"].includes(String(asObject(compactedThread.status).type))) {
            throw new Error("Codex 原生上下文压缩后的持久轮次尚未确认；未提交用户输入");
          }
          baselineTurnId = result.id;
          invalidateResourceReads(req.toolContext, "codex-manual-compaction");
          log.info({ agent: agentName, stage: "completed", before, after: contextTokens }, "loop:native-compact");
        } finally { controlTurn = false; controlResolve = undefined; controlReject = undefined; turnId = ""; }
      }
      const input = await this.buildTurnInput(messages);
      const turnParams: JsonObject = {
        threadId,
        input,
        model: req.model,
        approvalPolicy: "never",
        sandboxPolicy: workspace.turnSandbox,
        cwd: workspace.cwd,
      };
      // 不能省略：App Server 会继承服务端 ~/.codex/config.toml 的全局 effort。
      // 例如本机默认 `max`，但 gpt-5.4-mini 只接受到 xhigh，HTTP 接管成功后仍会 400。
      // medium 是 Harbour 当前展示的全部 Codex 模型的公共档位；显式覆盖后再按本轮
      // thinkingBudget 升降，避免 Harbour 的模型选择被个人 CLI 配置暗中改变。
      turnParams.effort = codexEffort(req.thinkingBudget) ?? "medium";
      // Describe the exact outbound boundary without copying private bodies,
      // attachment paths, source IDs, or credentials into another diagnostic.
      const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
      log.info({
        agent: agentName,
        threadId,
        format: CODEX_CONVERSATION_FORMAT,
        model: req.model,
        modelRef: req.modelRef,
        effort: turnParams.effort,
        messageRoles: messages.map((message) => message.role),
        messageCount: messages.length,
        systemSha256: sha256(system),
        developerInstructionsSha256: sha256(developerInstructions),
        conversationSha256: sha256(String(input[0]?.text ?? "")),
        conversationBytes: Buffer.byteLength(String(input[0]?.text ?? ""), "utf8"),
        inputItemTypes: input.map((item) => item.type),
        toolNames: allowedTools.map((tool) => tool.name),
        toolSchemaSha256: sha256(JSON.stringify(dynamicTools)),
        permissionMode: req.permissionMode ?? null,
        threadSandbox: workspace.threadSandbox,
      }, "loop:codex-request-prepared");
      // Mark acceptance-unknown before writing to the pipe. A lost RPC response
      // must be reconciled from thread/read, not retried with the original input.
      if (lease) await lease.update({ phase: "accepted", lastAttemptId: native!.attemptId,
        nativeTurnId: undefined, nativeBaselineTurnId: baselineTurnId });
      turnSubmissionStarted = true;
      const started = asObject(await client.request("turn/start", turnParams));
      turnId = String(asObject(started.turn).id ?? turnId);
      if (!turnId) throw new Error("Codex App Server 未返回 turn id");
      userTurnStarted = true;
      if (lease) await lease.update({ nativeTurnId: turnId, phase: "accepted", lastAttemptId: native!.attemptId });
      log.info({ agent: agentName, threadId, turnId }, "loop:codex-turn-started");
      releaseUserSteer = req.toolContext?.execution?.runInputs?.bindNative(async input => {
        if (terminalTurnStatus || req.signal?.aborted) return "unavailable";
        if ((req.toolContext?.attachments?.length ?? 0) + (input.attachments?.length ?? 0) > 10) return "unavailable";
        // Preparation errors are known-unsent. Never omit an image then claim successful delivery.
        for (const attachment of input.attachments ?? []) {
          if (attachment.kind !== "image" || !attachment.path || !await this.safeImagePath(attachment.path)) return "unavailable";
        }
        const items = await this.buildTurnInput([{ role: "user", content: input.text, attachments: input.attachments }]);
        if (terminalTurnStatus || req.signal?.aborted) return "unavailable";
        try {
          const receipt = asObject(await client.request("turn/steer", { threadId, expectedTurnId: turnId, input: items }, 8_000));
          if (receipt.turnId === turnId) req.messages.push({ role: "user", content: input.text, attachments: input.attachments });
          if (receipt.turnId === turnId && input.attachments?.length && req.toolContext) {
            req.toolContext.attachments = [...(req.toolContext.attachments ?? []), ...input.attachments];
          }
          return receipt.turnId === turnId ? "accepted" : "unknown";
        } catch (error) {
          // An explicit closed/mismatched-turn rejection is safe to queue; transport timeout is not.
          return /no active turn|turn.*not.*active|expected.*turn.*mismatch/i.test(cleanError(error)) ? "unavailable" : "unknown";
        }
      }, { nativeOnly: true });

      const turn = await completion;
      if (reasoningBuffer.trim()) log.info({ agent: agentName, preview: preview(reasoningBuffer, 420) }, "loop:thinking");
      const status = String(turn.status ?? "");
      const final = finalTextFromTurn(turn);
      if (lease) await lease.update({ phase: status === "completed" ? "finished" : "interrupted",
        lastAttemptId: native!.attemptId, nativeTurnId: turnId, contextTokens,
        usageTotals: latestThreadUsage });
      if (userAborted || req.signal?.aborted) throw new Error("run aborted（用户停止了本次运行）");
      if (status === "failed") {
        throw new Error(String(asObject(turn.error).message ?? "Codex App Server turn 失败"));
      }
      const suffix = hardStopped
        ? `（Codex Harness 已达单次 token 硬预算 ${req.tokenBudget?.hardTokens ?? "?"}，已安全中止并保留 checkpoint。）`
        : maxStepsStopped
          ? `（Codex Harness 已达单次工具步数上限 ${req.maxTurns ?? "?"}，已安全中止并保留 checkpoint。）`
          : status === "interrupted"
            ? "（Codex Harness 本轮被中止。）"
            : "";
      const content = [final, suffix].filter(Boolean).join("\n\n") || "（Codex Harness 未返回可显示文本。）";
      return {
        message: { role: "assistant", content },
        usage: toHarbourUsage(latestUsage),
        usageReported: !!req.onUsage && reportedUsage.totalTokens > 0,
        ...(hardStopped ? { incomplete: "budget" as const }
          : maxStepsStopped ? { incomplete: "max_steps" as const }
            : status === "interrupted" ? { incomplete: "interrupted" as const }
              : !final.trim() ? { incomplete: "empty_reply" as const } : {}),
      };
    } finally {
      releaseUserSteer?.();
      // 极端断流可能只有 item/started 而没有 item/completed。保留成明确的未完成原生
      // 修改事实；SessionStore 随后会把整个 checkpoint 持久化为 interrupted。
      const interruptedNative = userAborted || hardStopped || maxStepsStopped || req.signal?.aborted === true ||
        terminalTurnStatus === "interrupted" || terminalTurnStatus === "cancelled" || terminalTurnStatus === "canceled";
      for (const useId of pendingNativeFileChanges) {
        req.toolContext?.execution?.checkpoint?.failExternal(
          useId,
          interruptedNative
            ? "Codex 原生 apply_patch 在收到完成回执前中断；文件状态需要核对"
            : "Codex 原生 apply_patch 未返回完成回执；文件状态需要核对",
          interruptedNative
        );
      }
      pendingNativeFileChanges.clear();
      req.signal?.removeEventListener("abort", abortListener);
      await client.stop();
      if (lease && turnSubmissionStarted && terminalTurnStatus !== "completed") {
        // No confirmed terminal event means accepted/unknown, even after a local abort.
        await lease.update({ phase: terminalTurnStatus === "interrupted" ? "interrupted" : "accepted",
          ...(userTurnStarted ? { nativeTurnId: turnId } : {}), contextTokens, usageTotals: latestThreadUsage });
      } else if (lease && !turnSubmissionStarted) await lease.update({ contextTokens, usageTotals: latestThreadUsage });
      if (!persistent) await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private allowedTools(req: CompletionRequest): ToolDef[] {
    const readOnly = req.toolContext?.agent?.governance?.permissions?.readOnly === true || req.permissionMode === "plan";
    return (req.tools ?? []).filter((tool) => !readOnly || tool.readOnly === true);
  }

  private async buildTurnInput(messages: Message[]): Promise<JsonObject[]> {
    const dialogue = messages.filter((message) => message.role !== "system");
    const input: JsonObject[] = [{
      type: "text",
      text: codexConversation(messages),
    }];
    const seen = new Set<string>();
    for (const message of dialogue) {
      for (const image of toolImages(message)) {
        input.push({ type: "image", url: `data:${image.mimeType};base64,${image.data}` });
      }
      for (const attachment of message.attachments ?? []) {
        if (attachment.kind !== "image" || !attachment.path || seen.has(attachment.path)) continue;
        const safePath = await this.safeImagePath(attachment.path);
        if (!safePath) continue;
        seen.add(attachment.path);
        input.push({ type: "localImage", path: safePath });
      }
    }
    return input;
  }

  private async safeImagePath(candidate: string): Promise<string | null> {
    try {
      const root = await fs.realpath(path.resolve(this.opts.uploadDir));
      const file = await fs.realpath(path.resolve(candidate));
      const rel = path.relative(root, file);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
      const stat = await fs.stat(file);
      return stat.isFile() ? file : null;
    } catch {
      return null;
    }
  }

  private createClient(logger = this.opts.logger, catalogOnly = false): CodexRpcClient {
    const launch = this.opts.launch ?? this.opts.resolveLaunch?.() ?? bundledCodex().launch;
    return new CodexRpcClient({
      launch,
      command: launch.command,
      args: [...launch.args, ...lockedDownAppServerArgs(catalogOnly)],
      logger,
      startupTimeoutMs: this.opts.startupTimeoutMs ?? 15_000,
    });
  }

  private async initialize(client: CodexRpcClient): Promise<void> {
    await client.start();
    await client.request("initialize", {
      clientInfo: { name: "harbour", title: "Harbour", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized", {});
  }

  private async readAccount(client: CodexRpcClient): Promise<Omit<CodexHarnessProbe, "models" | "defaultModel">> {
    const result = asObject(await client.request("account/read", { refreshToken: false }));
    const account = asObject(result.account);
    const authType = String(account.type ?? "");
    client.accountIdentity = typeof account.email === "string" && account.email.trim()
      ? `${authType}:${account.email.trim().toLowerCase()}` : undefined;
    if (!authType) {
      return { ready: false, error: "Codex 尚未登录。请在服务端机器运行 `codex login`，完成 ChatGPT OAuth 后重启 Harbour。" };
    }
    if ((this.opts.requireChatgptOAuth ?? true) && authType !== "chatgpt") {
      return { ready: false, authType, error: `Codex 当前认证类型是 ${authType}，Harbour 此后端要求 ChatGPT OAuth。` };
    }
    return {
      ready: true,
      authType,
      ...(typeof account.planType === "string" ? { planType: account.planType } : {}),
    };
  }
}

class CodexRpcClient {
  accountIdentity?: string;
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (method: string, params: unknown) => Promise<unknown>;
  onExit?: (error: Error) => void;
  onStderrLine?: (line: string) => void;
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number | string, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();
  private stderr = "";
  private stderrLineBuffer = "";
  private stopping = false;
  private transportClosed = false;
  private toolReplies = new Map<string, DynamicToolDeliveryEvidence>();
  private toolCompletions = new Map<string, DynamicToolDeliveryEvidence>();

  constructor(private readonly opts: {
    launch: CodexLaunch;
    command: string;
    args: string[];
    logger: Logger;
    startupTimeoutMs: number;
  }) {}

  get launch(): CodexLaunch { return this.opts.launch; }

  async start(): Promise<void> {
    if (this.child) return;
    this.child = spawn(this.opts.command, this.opts.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: sanitizedCodexEnv(process.env),
    });
    // A pipe can become unwritable after the synchronous writable check. Without an
    // error listener EPIPE/ERR_STREAM_DESTROYED would crash the entire Harbour process.
    this.child.stdin.on("error", (error) => {
      this.transportClosed = true;
      if (this.stopping) return;
      const wrapped = new Error(`Codex App Server stdin 写入失败：${error.message}`);
      this.failAll(wrapped);
      this.onExit?.(wrapped);
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-12_000);
      const buffered = this.stderrLineBuffer + chunk;
      const lines = buffered.split(/\r?\n/);
      this.stderrLineBuffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) this.onStderrLine?.(line);
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.once("error", (error) => {
      this.transportClosed = true;
      const wrapped = new Error(`无法启动 Codex App Server：${error.message}`);
      this.failAll(wrapped);
      this.onExit?.(wrapped);
    });
    this.child.once("exit", (code, signal) => {
      this.transportClosed = true;
      if (this.stopping) return;
      const detail = this.stderr.trim();
      const error = new Error(`Codex App Server 提前退出（code=${code}, signal=${signal ?? "none"}）${detail ? `：${detail}` : ""}`);
      this.failAll(error);
      this.onExit?.(error);
    });
  }

  request(method: string, params: unknown = {}, timeoutMs = this.opts.startupTimeoutMs): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server 请求超时：${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.send({ method, params });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.child = undefined;
    this.failAll(new Error("Codex App Server 已关闭"));
    if (child.exitCode == null) child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode != null) return resolve();
      const timer = setTimeout(() => {
        if (child.exitCode == null) child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  private handleLine(line: string): void {
    if (this.stopping || !line.trim()) return;
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.opts.logger.debug({ line: line.slice(0, 500) }, "codex:non-json-stdout");
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message || `Codex RPC error ${message.error.code ?? ""}`),
        { rpcCode: message.error.code }));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      void this.handleServerRequest(message.id, message.method, message.params).catch(() => {
        // Defensive last boundary: an async server request must never become an
        // unhandled rejection, especially while a completed/aborted turn is closing.
        this.opts.logger.warn({ requestId: message.id, method: message.method }, "codex:rpc-reply-handler-failed");
      });
      return;
    }
    if (message.method === "item/completed") this.observeToolCompletion(message.params);
    if (message.method) this.onNotification?.(message.method, message.params);
  }

  private async handleServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    if (this.stopping || this.transportClosed) return;
    let reply: RpcMessage;
    try {
      if (!this.onServerRequest) throw Object.assign(new Error(`未处理的 Codex server request：${method}`), { rpcCode: -32601 });
      const result = await this.onServerRequest(method, params);
      reply = { id, result };
    } catch (error) {
      const row = error as Error & { rpcCode?: number };
      reply = { id, error: { code: row.rpcCode ?? -32000, message: cleanError(error) } };
    }
    // A failed reply is a transport failure, not a second tool failure to reply to.
    // Await the pipe write callback so "sent" means accepted by the local stream;
    // only item/completed from App Server can establish its returned-content receipt.
    try {
      await new Promise<void>((resolve, reject) => this.send(reply, (error) => error ? reject(error) : resolve()));
      if (method === "item/tool/call") {
        const row = asObject(params);
        const evidence = dynamicToolDeliveryEvidence(row, row.callId, reply.result);
        this.opts.logger.info({ requestId: id, ...evidence, rpcError: !!reply.error }, "loop:tool-delivery-sent");
        const key = toolDeliveryKey(evidence);
        this.toolReplies.set(key, evidence);
        this.compareToolDelivery(key);
      }
    } catch (error) {
      this.opts.logger.warn({
        requestId: id,
        method,
        reason: this.stopping || this.transportClosed || !this.child ? "closed" : "write-failed",
        // Do not log the reply, arguments, tool text, paths, or error payload.
      }, "codex:rpc-reply-not-sent");
      if (!this.stopping && !this.transportClosed) {
        this.transportClosed = true;
        const wrapped = new Error(`Codex App Server 回复写入失败：${cleanError(error)}`);
        this.failAll(wrapped);
        this.onExit?.(wrapped);
      }
    }
  }

  private observeToolCompletion(rawParams: unknown): void {
    const params = asObject(rawParams);
    const item = asObject(params.item);
    if (item.type !== "dynamicToolCall") return;
    const evidence = dynamicToolDeliveryEvidence({ ...params, tool: item.tool }, item.id, item);
    this.opts.logger.info({ ...evidence, status: typeof item.status === "string" ? item.status : null }, "loop:tool-delivery-completed");
    const key = toolDeliveryKey(evidence);
    this.toolCompletions.set(key, evidence);
    this.compareToolDelivery(key);
  }

  private compareToolDelivery(key: string): void {
    const sent = this.toolReplies.get(key);
    const received = this.toolCompletions.get(key);
    if (!sent || !received) return;
    // Missing optional completion content is unknown, not proof that the model got
    // empty text. Matching App Server receipts still do not prove model attention.
    const textMatches = sent.contentAvailable && received.contentAvailable
      ? sent.textBytes === received.textBytes && sent.textSha256 === received.textSha256
      : null;
    const successMatches = sent.success !== null && received.success !== null
      ? sent.success === received.success : null;
    this.opts.logger.info({
      threadId: sent.threadId, turnId: sent.turnId, callId: sent.callId, tool: sent.tool,
      sentTextBytes: sent.textBytes, completedTextBytes: received.textBytes,
      textMatches, successMatches,
    }, "loop:tool-delivery-compared");
    this.toolReplies.delete(key);
    this.toolCompletions.delete(key);
  }

  private send(message: RpcMessage, written?: (error?: Error | null) => void): void {
    if (this.stopping || this.transportClosed || !this.child?.stdin.writable || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      throw new Error("Codex App Server stdin 不可写");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`, written);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

interface DynamicToolDeliveryEvidence {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  contentAvailable: boolean;
  contentItemCount: number;
  textItemCount: number;
  imageItemCount: number;
  textChars: number;
  textBytes: number;
  textSha256: string;
  success: boolean | null;
}

/** Privacy-preserving protocol evidence; never include tool arguments/content/images. */
function dynamicToolDeliveryEvidence(params: JsonObject, callId: unknown, value: unknown): DynamicToolDeliveryEvidence {
  const row = asObject(value);
  const contentAvailable = Array.isArray(row.contentItems);
  const items = contentAvailable ? (row.contentItems as unknown[]).map(asObject) : [];
  const texts = items.filter((item) => item.type === "inputText" && typeof item.text === "string");
  const text = texts.map((item) => String(item.text)).join("\n");
  return {
    threadId: String(params.threadId ?? ""), turnId: String(params.turnId ?? ""),
    callId: String(callId ?? ""), tool: String(params.tool ?? ""),
    contentAvailable, contentItemCount: items.length, textItemCount: texts.length,
    imageItemCount: items.filter((item) => item.type === "inputImage").length,
    textChars: text.length, textBytes: Buffer.byteLength(text, "utf8"),
    textSha256: createHash("sha256").update(text, "utf8").digest("hex"),
    success: typeof row.success === "boolean" ? row.success : null,
  };
}

function toolDeliveryKey(evidence: DynamicToolDeliveryEvidence): string {
  return JSON.stringify([evidence.threadId, evidence.turnId, evidence.callId]);
}

/** Bind to an OAuth identity, never a rotating access token or raw credential. */
async function codexOAuthIdentity(accountIdentity: string | undefined): Promise<string> {
  const configHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  let accountId = "";
  try {
    const authPath = path.join(configHome, "auth.json");
    const stat = await fs.lstat(authPath);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 1024 * 1024) {
      const auth = asObject(JSON.parse(await fs.readFile(authPath, "utf8")));
      const tokens = asObject(auth.tokens);
      accountId = String(tokens.account_id ?? auth.account_id ?? "");
      if (!accountId && typeof tokens.id_token === "string") {
        const payload = tokens.id_token.split(".")[1];
        if (payload) {
          const claims = asObject(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
          const metadata = asObject(claims["https://api.openai.com/auth"]);
          accountId = String(metadata.chatgpt_account_id ?? claims.sub ?? "");
        }
      }
    }
  } catch { /* Keyring-only installations can bind to account/read's authenticated email. */ }
  // Missing identity cannot authorize reuse of another login's transcript.
  return createHash("sha256").update(JSON.stringify([accountIdentity, accountId || (!accountIdentity ? randomUUID() : "")])).digest("hex");
}

function isMissingCodexThread(error: unknown): boolean {
  const code = (error as { rpcCode?: unknown })?.rpcCode;
  return (code === -32600 || code === -32602 || code === -32000) &&
    /(?:thread[^\n]*(?:not found|does not exist)|(?:no|cannot find|could not find|failed to find)[^\n]*(?:thread|rollout)|rollout[^\n]*not found)/iu.test(cleanError(error));
}

function lastUserMessages(messages: Message[]): Message[] {
  const latest = [...messages].reverse().find((message) => message.role === "user");
  if (!latest) throw new Error("Codex 持久线程续接缺少本轮用户输入，拒绝重发历史");
  return [latest];
}

function lockedDownAppServerArgs(catalogOnly = false): string[] {
  return [
    // /models 只读探测走内建 OpenAI provider，才能取得动态 OAuth 模型元数据；
    // 自定义 provider 的内置目录可能落后。实际生成仍保持下面的 HTTPS-only 通路。
    // 模型目录里的 prefer_websockets 会覆盖 feature flag；因此单纯 --disable 仍可能
    // 先重试 5 次 WS。独立 provider 继续复用 codex login 的 ChatGPT OAuth，只把
    // wire transport 确定为 HTTPS。名称使用 Harbour 私有 ID，避免覆盖 Codex 内建 provider。
    "-c", catalogOnly ? 'model_provider="openai"' : 'model_provider="harbour_openai_https"',
    "-c", 'model_providers.harbour_openai_https.name="OpenAI HTTPS only"',
    "-c", 'model_providers.harbour_openai_https.base_url="https://chatgpt.com/backend-api/codex"',
    "-c", 'model_providers.harbour_openai_https.wire_api="responses"',
    "-c", "model_providers.harbour_openai_https.requires_openai_auth=true",
    "-c", "model_providers.harbour_openai_https.supports_websockets=false",
    "--disable", "responses_websockets",
    "--disable", "responses_websockets_v2",
    "--disable", "shell_tool",
    "--disable", "view_image",
    "--disable", "browser_use",
    "--disable", "computer_use",
    "--disable", "multi_agent",
    "--disable", "skill_search",
    "--disable", "plugins",
    "--disable", "apps",
    "--disable", "image_generation",
    "--disable", "workspace_dependencies",
    "-c", "tools.web_search=false",
    "-c", "project_doc_max_bytes=0",
    "-c", "mcp_servers={}",
  ];
}

function sanitizedCodexEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    // OAuth 只从 Codex 自己的 keyring/auth.json 读取；Harbour/供应商密钥绝不下放。
    if (/(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASS|COOKIE|AUTH|CREDENTIAL)(?:_|$)/i.test(key)) continue;
    if (/^(?:ANTHROPIC|OPENAI|DEEPSEEK|MOONSHOT|KIMI)_/i.test(key)) continue;
    env[key] = value;
  }
  env.NO_COLOR = "1";
  return env;
}

function codexEffort(thinkingBudget: number | undefined): Exclude<ReasoningEffort, "off"> | undefined {
  if (thinkingBudget === undefined) return undefined;
  if (thinkingBudget <= 0) return "none";
  if (thinkingBudget <= 512) return "minimal";
  if (thinkingBudget <= 2_048) return "low";
  if (thinkingBudget <= 8_192) return "medium";
  if (thinkingBudget <= 16_384) return "high";
  if (thinkingBudget >= 131_072) return "ultra";
  if (thinkingBudget >= 65_536) return "max";
  return "xhigh";
}

/**
 * Codex 的 approvalPolicy 与 sandbox 是两件事：dontAsk/never 只负责不弹审批，
 * 并不会自动把只读工作区变成可写。原生 apply_patch 仅向“可信主人正在交互、且 Agent
 * 没有声明更窄权限”的运行开放；plan、公开用户、cron/subagent 与受限 Agent 继续待在
 * 临时只读目录，避免绕过 Harbour 的 ToolDef / 路径治理。
 */
function codexWorkspacePolicy(req: CompletionRequest, scratch: string): {
  cwd: string;
  // 当前随 Harbour 安装的 App Server 在 thread/start 仍使用旧 SandboxMode 枚举；
  // turn/start.sandboxPolicy 则使用新版驼峰 tagged union。
  threadSandbox: "read-only" | "workspace-write";
  turnSandbox: JsonObject;
  fileChanges: boolean;
} {
  const source = req.toolContext?.source;
  const channel = source?.channel ?? "";
  const interactiveOwner = source?.actor?.role === "owner" &&
    (channel === "web" || channel === "qq" || channel.startsWith("discord"));
  const permissions = req.toolContext?.agent?.governance?.permissions;
  const explicitlyRestricted = permissions?.readOnly === true ||
    permissions?.readPaths !== undefined ||
    permissions?.writePaths !== undefined ||
    permissions?.tools !== undefined ||
    permissions?.mcp !== undefined;
  // Cowork 所选目录不在服务端；只能经已路由的 Harbour write_file/bash 修改目标机。
  const fileChanges = !req.toolContext?.execution?.cowork && req.permissionMode !== "plan" && interactiveOwner && !explicitlyRestricted;
  if (!fileChanges) {
    return {
      cwd: scratch,
      threadSandbox: "read-only",
      turnSandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
      fileChanges: false,
    };
  }

  const workspaceRoot = path.resolve(process.cwd());
  return {
    cwd: workspaceRoot,
    threadSandbox: "workspace-write",
    turnSandbox: {
      type: "workspaceWrite",
      writableRoots: [workspaceRoot],
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: false,
    },
    fileChanges: true,
  };
}

function fileChangePaths(item: JsonObject): string {
  const changes = Array.isArray(item.changes) ? item.changes.map(asObject) : [];
  const paths = changes.map((change) => String(change.path ?? "").trim()).filter(Boolean);
  return paths.length ? paths.slice(0, 12).join(", ") : String(item.status ?? "file change");
}

/** Checkpoint 只需要识别这次原生修改，不应把补丁正文复制进会话状态。 */
function nativeFileChangeMetadata(item: JsonObject): Record<string, unknown> {
  const changes = Array.isArray(item.changes) ? item.changes.map(asObject) : [];
  const files = [...new Set(changes.map((change) => String(change.path ?? "").trim()).filter(Boolean))].slice(0, 64);
  let digest = "";
  try {
    digest = createHash("sha256").update(JSON.stringify(item.changes ?? [])).digest("hex");
  } catch {
    // An opaque App Server payload must not prevent recording the execution boundary.
  }
  return {
    files,
    changeCount: changes.length,
    ...(digest ? { changeDigest: digest } : {}),
  };
}

function nativeFileChangeResult(item: JsonObject, status: string): Record<string, unknown> {
  return { status, ...nativeFileChangeMetadata(item) };
}

function isInterruptedNativeStatus(status: string): boolean {
  return status === "interrupted" || status === "cancelled" || status === "canceled";
}

function usageBreakdown(value: unknown): UsageBreakdown {
  const row = asObject(value);
  return {
    inputTokens: nonNegativeInt(row.inputTokens),
    cachedInputTokens: nonNegativeInt(row.cachedInputTokens),
    cacheWriteInputTokens: nonNegativeInt(row.cacheWriteInputTokens),
    outputTokens: nonNegativeInt(row.outputTokens),
    reasoningOutputTokens: nonNegativeInt(row.reasoningOutputTokens),
    totalTokens: nonNegativeInt(row.totalTokens),
  };
}

function subtractUsage(current: UsageBreakdown, prior: UsageBreakdown): UsageBreakdown {
  return {
    inputTokens: Math.max(0, current.inputTokens - prior.inputTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - prior.cachedInputTokens),
    cacheWriteInputTokens: Math.max(0, current.cacheWriteInputTokens - prior.cacheWriteInputTokens),
    outputTokens: Math.max(0, current.outputTokens - prior.outputTokens),
    reasoningOutputTokens: Math.max(0, current.reasoningOutputTokens - prior.reasoningOutputTokens),
    totalTokens: Math.max(0, current.totalTokens - prior.totalTokens),
  };
}

function toHarbourUsage(usage: UsageBreakdown): NonNullable<CompletionResult["usage"]> {
  return {
    promptTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens),
    completionTokens: usage.outputTokens,
    cachedTokens: usage.cachedInputTokens,
    cacheCreationTokens: usage.cacheWriteInputTokens,
  };
}

function finalTextFromTurn(turn: JsonObject): string {
  const items = Array.isArray(turn.items) ? turn.items.map(asObject) : [];
  const explicitFinal = items.filter((item) =>
    item.type === "agentMessage" && item.phase === "final_answer" && String(item.text ?? "").trim()
  ).at(-1);
  if (explicitFinal) return String(explicitFinal.text).trim();

  // Older App Servers omit phase. Keep their latest text only while nothing later
  // supersedes it: explicit commentary is progress, and tool activity needs a new
  // answer. Unknown non-reasoning items fail closed rather than promote stale text.
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.type === "reasoning") continue;
    if (item.type !== "agentMessage" || item.phase != null) return "";
    const text = String(item.text ?? "").trim();
    if (text) return text;
  }
  return "";
}

type DynamicToolContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string };

async function dynamicToolResponse(
  success: boolean,
  value: unknown,
  media?: { tool: ToolDef; args: Record<string, unknown>; result: unknown }
): Promise<JsonObject> {
  const contentItems: DynamicToolContentItem[] = [{ type: "inputText", text: stringifyToolResult(value) }];
  const images = media ? await codexToolImages(media.tool, media.args, media.result) : [];
  contentItems.push(...images);
  return { success, contentItems };
}

/**
 * Codex App Server 的 dynamic-tool 协议原生支持 inputImage。view_image 使用权限检查后
 * 的内存像素快照；保留 Browser 导出的验签产物兼容路径。其它普通 JSON 回执里的路径
 * 或模型自填的 payload 不构成图片授权。
 */
async function codexToolImages(
  tool: ToolDef,
  args: Record<string, unknown>,
  result: unknown
): Promise<Array<Extract<DynamicToolContentItem, { type: "inputImage" }>>> {
  const verified = toolImages(result);
  if (verified.length) return verified.map(image => ({ type: "inputImage", imageUrl: `data:${image.mimeType};base64,${image.data}` }));
  if (tool.name !== "opencli_browser") return [];
  const action = String(args.action ?? "");
  if (action !== "save_data_image" && action !== "collect_novelai_result") return [];
  const row = asObject(result);
  const artifacts = action === "collect_novelai_result"
    ? (Array.isArray(row.artifacts) ? row.artifacts.map(asObject).slice(0, 4) : [])
    : [row];
  const images: Array<Extract<DynamicToolContentItem, { type: "inputImage" }>> = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const artifact of artifacts) {
    // collect_novelai_result may return an already-exported, byte-identical candidate as
    // duplicate=true. It is still a verified Harbour-controlled image and must remain
    // visible to Codex for candidate comparison; only the filesystem write is skipped.
    if ((artifact.saved !== true && artifact.duplicate !== true) ||
        typeof artifact.path !== "string" || !artifact.path.trim()) continue;
    const resolved = path.resolve(artifact.path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    try {
      const bytes = await fs.readFile(resolved);
      if (!bytes.length || bytes.length > 5 * 1024 * 1024 || totalBytes + bytes.length > 12 * 1024 * 1024) continue;
      const mime = imageMime(bytes);
      if (!mime) continue;
      totalBytes += bytes.length;
      images.push({ type: "inputImage", imageUrl: `data:${mime};base64,${bytes.toString("base64")}` });
    } catch {
      // 单个候选损坏不能吞掉其它已验签候选；文本工具结果仍保留完整证据。
    }
  }
  return images;
}

function imageMime(bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}

function stringifyToolResult(value: unknown): string {
  const text = typeof value === "string" ? value : safeJson(value);
  const max = 240_000;
  return text.length <= max ? text : `${text.slice(0, max)}\n…[Harbour 已截断过大的工具结果]`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function withToolGuards<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined, tool: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("run aborted"));
    const timer = setTimeout(() => reject(new Error(`工具 ${tool} 执行超过 ${timeoutMs}ms`)), timeoutMs);
    const abort = () => reject(new Error("run aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(value); },
      (error) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(error); }
    );
  });
}

function dedupeModels(models: CodexModelRow[]): CodexModelRow[] {
  const seen = new Set<string>();
  return models.filter((model) => !seen.has(model.model) && !!seen.add(model.model));
}

function asObject(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function reconnectFromNotification(params: JsonObject): CodexReconnectEvent | null {
  const errorRow = asObject(params.error);
  const message = String(errorRow.message ?? (typeof params.error === "string" ? params.error : params.message ?? "")).trim();
  const detail = String(errorRow.additionalDetails ?? params.additionalDetails ?? "").trim();
  const errorInfo = asObject(errorRow.codexErrorInfo ?? params.codexErrorInfo);
  const disconnected = asObject(errorInfo.responseStreamDisconnected);
  const willRetry = params.willRetry === true
    || /reconnect|retry/i.test(message)
    || Object.keys(disconnected).length > 0;
  if (!willRetry) return null;
  const progress = retryProgress(message);
  const status = Number(disconnected.httpStatusCode ?? errorRow.httpStatusCode ?? params.httpStatusCode);
  return {
    ...progress,
    ...(Number.isFinite(status) && status > 0 ? { errorStatus: Math.floor(status) } : {}),
    error: detail || message || "Codex response stream disconnected",
  };
}

function reconnectFromStderr(line: string): CodexReconnectEvent | null {
  if (!/retrying sampling request/i.test(line)) return null;
  const progress = retryProgress(line);
  const delayText = line.match(/retrying sampling request\s*\([^)]*?\bin\s+([^)]+)\)/i)?.[1];
  const quotedError = line.match(/sampling_error=(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
  const error = quotedError?.[1] ?? quotedError?.[2] ?? quotedError?.[3]
    ?? (/timed?\s*out/i.test(line) ? "request timed out" : "Codex response stream disconnected");
  return {
    ...progress,
    ...(delayText ? { retryDelayMs: durationMs(delayText) } : {}),
    error,
  };
}

function retryProgress(value: string): Pick<CodexReconnectEvent, "attempt" | "maxRetries"> {
  const match = value.match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return {};
  return { attempt: Number(match[1]), maxRetries: Number(match[2]) };
}

function durationMs(value: string): number | undefined {
  const match = value.trim().match(/([\d.]+)\s*(ms|s)\b/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  return Math.round(amount * (match[2]!.toLowerCase() === "s" ? 1_000 : 1));
}

function itemErrorText(item: JsonObject): string {
  const nested = asObject(item.error);
  return String(item.message ?? item.text ?? nested.message ?? nested.additionalDetails ?? "").trim();
}

function isTransportFallbackText(value: string): boolean {
  return /fall(?:ing)?\s+back[^\n]*(?:https?|http)/i.test(value)
    || /websockets?[^\n]*(?:https?|http)[^\n]*fallback/i.test(value);
}

function cleanError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function latestUserRequest(messages: Message[]): string {
  let content = "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    content = messages[index]?.content.trim() || "";
    break;
  }
  return preview(content || "（仅附件输入）", 800);
}

function preview(value: string, max = 180): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
