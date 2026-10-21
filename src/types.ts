/**
 * 公共类型 —— 整个中台的「词汇表」。
 * 这里定义的 Message 是中台内部的统一消息格式；各 backend 负责把它
 * 翻译成自己 provider 的格式（如 OpenAI ChatCompletion）。中台核心
 * 不直接依赖任何 provider 的 SDK 类型。
 */
import type { Logger } from "pino";

export type Role = "system" | "user" | "assistant" | "tool";

/** 多模态附件类型。 */
export type AttachmentKind = "image" | "video" | "audio" | "file";

/**
 * 一个多模态附件（图片/视频/语音/文件）。
 * 渠道（web/discord/qq）收到后进入 Harbour 受控上传目录，再以持久引用随消息流转。
 * 图片由入站校验器验签/限像素并以原生 image block 送入视觉模型；语音会由 STT
 * 中间件先变成可审计文字，再与附件引用一同进入会话、History 与模型。
 */
export interface Attachment {
  kind: AttachmentKind;
  /** 可访问的相对 URL（如 /uploads/xxx.png），前端展示用。 */
  url: string;
  /** 服务器内受控落盘路径（可为绝对路径），只供后端读取。 */
  path?: string;
  /** MIME 类型（image/png、audio/webm、application/pdf…）。 */
  mime: string;
  /** 原始文件名。 */
  name: string;
  /** 字节大小。 */
  size?: number;
  /** 经过 Harbour 解码验证的图片元数据；只有 kind=image 时存在。 */
  image?: {
    width: number;
    height: number;
    sha256: string;
    /** 原图超过视觉端点限制时，已生成保真 WebP 代理。 */
    normalized?: boolean;
  };
  /** 已知的音频时长；Web 录音由浏览器计时，平台附件缺失时由服务端尽力探测。 */
  durationMs?: number;
  /** 渠道官方已经提供的可信转写；普通 Web/API 客户端不能自行注入此字段。 */
  transcription?: {
    text: string;
    source: "platform" | "gateway";
    provider: string;
    durationMs?: number;
  };
}

/**
 * 由渠道入口判定的可信发言者身份。模型只能消费这个结果，绝不能根据昵称、消息正文
 * 或「我是 用户」之类的自述自行升级身份。
 */
export interface ActorIdentity {
  /** owner=已验证主人或显式授权的自动执行；other=非主人；system=未授主人权限的自动/内部运行。 */
  role: "owner" | "other" | "system";
  /** 身份所在平台（discord / qq / web / cron / internal …）。 */
  platform: string;
  /** 平台内稳定 ID；Discord 为用户 ID，QQ 为 openid，Web 主人为固定的 web-owner。 */
  id: string;
  /** 只用于称呼与 UI，不参与身份或权限判断。 */
  displayName?: string;
}

/** 一次运行的可信来源；actor 缺失时，交互渠道必须按 non-owner fail-closed。 */
export interface RunSource {
  channel?: string;
  key?: string;
  /** 运行时锁定的 Harbour 会话 ID；子任务沿用来源 ID，不跟随前端的活跃会话切换。 */
  sessionId?: string;
  /** 顶层渠道/API 分配的展示运行 ID；只用于实时 trace 关联，不参与权限判断。 */
  runId?: string;
  /** 兼容 ask_user 的渠道作者校验；权限判断一律只看 actor。 */
  authorId?: string;
  actor?: ActorIdentity;
}

/** 模型想调用的一次工具调用（已解析 arguments）。 */
export interface ToolCall {
  /** provider 给的调用 id，tool 结果要用它回指。 */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 受控的执行回执原因码；未知值不能作为自由文本写入跨轮事实卡。 */
export const EXECUTION_REASON_CODES = ["budget_required", "input_validation"] as const;
export type ExecutionReasonCode = (typeof EXECUTION_REASON_CODES)[number];

export function normalizeExecutionReasonCode(value: unknown): ExecutionReasonCode | undefined {
  return typeof value === "string" && (EXECUTION_REASON_CODES as readonly string[]).includes(value)
    ? value as ExecutionReasonCode
    : undefined;
}

/** 服务器从 checkpoint 工具账本投影的有界事实；不包含参数、结果正文或模型推理。 */
export interface ExecutionEvidenceEntry {
  agent: string;
  tool: string;
  targetAgent?: string;
  requestedTargetAgent?: string;
  delegateInvoked?: boolean;
  workflow?: string;
  observation: "executed" | "replayed" | "settled";
  boundary: "returned" | "failed" | "unfinished";
  count: number;
  returnStatus?: string;
  reasonCode?: ExecutionReasonCode;
  /** 同一执行对象已有更新的结构化回执；只能作为历史过程，不代表当前状态。 */
  historicalReceipt?: true;
  jobId?: string;
  chargeState?: "charged" | "not_charged" | "unknown";
  retrySafety?: "safe" | "unsafe" | "uncertain";
  completed?: number;
  total?: number;
  costAnlas?: number;
  visibleSpentAnlas?: number;
  maxTotalAnlas?: number;
  uncertainReservedAnlas?: number;
}

export interface ExecutionEvidence {
  version: 1;
  source: "server-checkpoint";
  /** 这里只覆盖被登记的工具边界，不能用缺失记录证明没有执行。 */
  coverage: "recorded-boundaries-only";
  traceId?: string;
  /** 本次观察到执行的 checkpoint 边界数量；不是副作用次数或计费次数。 */
  executed: number;
  replayed: number;
  /** 旧尝试的工具迟到结算/状态更新，不表示当前尝试再次执行。 */
  settled: number;
  returned: number;
  failed: number;
  unfinished: number;
  omitted: number;
  entries: ExecutionEvidenceEntry[];
}

export interface SessionRunRecord {
  /** answered 仅表示本轮正常产生回答，不表示业务任务完成。 */
  status: "interrupted" | "answered";
  attemptId: string;
  checkpointId: string;
  reason?: string;
  evidence?: ExecutionEvidence;
}

/** 中台内部统一消息格式。 */
export interface Message {
  role: Role;
  content: string;
  /** user 消息的可信作者；持久化后可在多人渠道历史中逐条区分发言者。 */
  actor?: ActorIdentity;
  /** assistant 轮想调工具时带上。 */
  toolCalls?: ToolCall[];
  /** role==="tool" 时回指的 ToolCall id。 */
  toolCallId?: string;
  /** role==="tool" 时所属工具名（便于 mock/日志识别）。 */
  name?: string;
  /** 多模态附件（图片/视频/语音/文件）；user 轮带上。 */
  attachments?: Attachment[];
  /**
   * Harbour 自己写入的运行终态记录。它不是供应商消息协议的一部分；SessionStore 在
   * 注入模型历史时只物化最近少量服务器事实卡，不直接发送这层元数据。中断轮次
   * 也借此与 run/checkpoint 精确关联、补写 Trace，并避免恢复时重复落同一轮。
   */
  runRecord?: SessionRunRecord;
  /** Successful structured file-write receipts from this run; never tool bodies or a diff snapshot. */
  fileChanges?: TurnFileChange[];
  /** Calendar API receipts for cards; not included in model history. */
  calendarCards?: import("./calendar/cards").CalendarCard[];
  /** Exact run association when a normal assistant message has no checkpoint record. */
  fileChangeRunId?: string;
}

export interface TurnFileChange {
  id: string;
  path: string;
  kind: "created" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  location: "local" | "remote";
  /** Required for local receipts: migration must not open the same path on another host. */
  originHost?: string;
  deviceId?: string;
  deviceLabel?: string;
  source: "tool";
}

/** Transient parent/child shared collector. It is not serialized with a checkpoint. */
export interface TurnFileChangeCollector {
  scope: string;
  entries: Map<string, TurnFileChange>;
  seen: Set<string>;
}

/** 一个工具的定义：schema + 真正的执行函数。 */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema（OpenAI function calling 的 parameters）。 */
  parameters: Record<string, unknown>;
  /** 本工具专属的执行超时（毫秒），覆盖调用方的默认值。
   *  给天生就慢的工具用（bash 跑 npm install、浏览器等页面…），默认 30s 会误杀。 */
  timeoutMs?: number;
  /** Trusted per-call policy for composite tools; not exposed in the model's schema. */
  timeoutMsFor?(args: Record<string, unknown>, ctx: ToolContext): number;
  /** 是否只读（无副作用）。只读 agent 采用 fail-closed：仅显式 true 才放行；
   *  未声明不影响普通 agent，但不会被发给 governance.permissions.readOnly agent。 */
  readOnly?: boolean;
  /** 是否进入 durable checkpoint。默认 true。纯运行态意图（真正提交发生在 run 成功后）
   * 可设为 false，避免恢复时回放一个已经失效的瞬时状态。 */
  checkpoint?: boolean;
  /** checkpoint 返回既有结果时，仅重建本轮内存状态；不得执行工具或产生外部副作用。 */
  onReplay?(result: unknown, args: Record<string, unknown>, ctx: ToolContext): void | Promise<void>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

/** Runtime-owned proof of a rejected Workflow invocation, not model-authored error text. */
export interface CheckpointToolRejection {
  outcome: "not_started";
  source: "workflow_input_validation";
  code: string;
  message: string;
  nextActions: unknown[];
  jobId?: string;
  details?: Readonly<Record<string, unknown>>;
}

export type CheckpointToolDecision =
  | { action: "execute"; callId: string }
  | { action: "replay"; callId: string; result: unknown }
  | { action: "replay-rejection"; callId: string; rejection: CheckpointToolRejection };

/**
 * Durable checkpoint 的最小执行契约。实现位于 core/checkpoint.ts；放在公共类型层是为了
 * 让父/子 agent 共用同一个控制器，而不让 ToolContext 反向依赖 SessionStore。
 */
export interface CheckpointController {
  readonly id: string;
  /** Persist the observed boundary before execution / before acknowledging a result. */
  flush?(): Promise<void>;
  /** Native SDK external tools have no proven read-only metadata: reconcile unknown writes before invocation. */
  assertExternalSafe?(agent: string, tool: string, args: Record<string, unknown>): void;
  /** 保存当前 Workflow 边界的已落盘引用，不触发执行或改变回放资格。 */
  recordRecovery?(operationId: string, workflow: string, snapshot: Record<string, unknown>): void;
  /** Read-only recovery of a completed input-preparation receipt; never consumes replay or executes tools. */
  lookupWorkflowInputPreparation?(query: { agent: string; workflow: string; scope: string; inputRef: string }): {
    input: Record<string, unknown>;
    result: { status: "input_prepared"; inputRef: string; byteLength: number; executed: false };
  } | undefined;
  beforeTool(agent: string, tool: string, args: Record<string, unknown>, context?: { scope?: string; coworkDeviceId?: string; mutating?: boolean; replayCompleted?: boolean; native?: boolean; nativeCallId?: string }): CheckpointToolDecision;
  completeTool(callId: string, result: unknown): void;
  failTool(callId: string, error: string, interrupted?: boolean, remote?: { deviceId: string; operationId: string; status: string; code?: string }, rejection?: CheckpointToolRejection): void;
  /**
   * 记录由模型宿主直接执行、但仍能被 Harbour 观察到的工具边界。
   * Claude SDK 省略 source 时保持原来的 external-mcp 语义；Codex 原生文件修改显式
   * 标成 codex-native，避免与可由 Harbour 回放的 dynamic tool 混淆。
   */
  startExternal(
    agent: string,
    tool: string,
    args: Record<string, unknown>,
    toolUseId: string,
    source?: "external-mcp" | "codex-native"
  ): void;
  completeExternal(toolUseId: string, result: unknown): void;
  failExternal(toolUseId: string, error: string, interrupted?: boolean): void;
}

/** 一次 NovelAI 付费提交的确定性边界，不是模型可改写的参数。 */
export type NovelAiRequiredReference = { kind: "character"; handle: string } | { kind: "attachment"; index: number; sha256: string };

export interface NovelAiSubmissionLimit {
  onceKey: string;
  /** Compiler-frozen model; never changed implicitly to satisfy a reference upload. */
  expectedModel?: string;
  maxCostAnlas: number;
  numberOfImages: number;
  /** Central account's other in-flight/unknown reservations; not model supplied. */
  otherReservedAnlas?: number;
  /** Frozen by the compiler; Browser cannot substitute a different size or prompt. */
  form?: Record<string, unknown>;
  /** Frozen reference identities; [] means explicitly no uploads. Not tool input. */
  requiredReferences?: NovelAiRequiredReference[];
}

/** 一条顶层 run 及其所有 spawn_subagent 后代共享的运行态。 */
export interface CoworkTarget {
  deviceId: string;
  cwd?: string;
  originDeviceId?: string;
}

export interface RunExecutionContext {
  /** Shared display-only checklists; not authorization or execution evidence. */
  progress?: import("./core/executionProgress").ExecutionProgressStore;
  /** Parent loop identity for concurrent/repeated agent lanes, never model-supplied. */
  parentTraceId?: string;
  /** Root-only user mailbox. Never give a parent's input transport to a child/native session. */
  runInputs?: import("./core/runInputs").RunInputLease;
  /** Read-only cancellation-free boundary signal, safe to share with long workflows. */
  inputBoundary?: { readonly revision: number; readonly hasPending: boolean };
  /** Workflow-owned creation intent; descendants may not turn prompt-only into a paid run. */
  novelAiIntent?: "prompt" | "generate" | "readiness";
  /** Explicit, immutable creative-task rating. Missing means the legacy authoring path. */
  novelAiContentRating?: import("./core/workflows/novelAiSfwAuthoring").NovelAiContentRating;
  /** Workflow-owned prompt-only assignment; never accepted from model arguments. */
  novelAiPanelArt?: { panelNumber: number; sourceHash: string; scene: Record<string, unknown>; book: Record<string, unknown> };
  /** Owner's explicit ceiling/review choice; inherited by author, never increased by its plan. */
  novelAiPolicy?: import("./core/workflows/novelAiBudget").NovelAiRequestPolicy;
  /** Server-only exception after the original Job proves pre-submit prompt overflow. */
  novelAiPromptRecovery?: { taskRef: string; jobId: string };
  /** Stable for one run/subtree; metadata goes into the newest user message, never system. */
  timeContext?: import("./core/timeZone").RunTimeContext;
  /** In-memory queue wait capability; shared with descendants, never serialized. */
  deadline?: { ensureRemaining(ms: number): boolean };
  /** Trusted per-session/per-durable-task native history binding; never a model argument. */
  nativeSession?: import("./core/nativeSession").NativeSessionContext;
  /** Trusted, session/caller/device scoped durable subtask capability; not a permission grant. */
  delegationTasks?: import("./core/delegationTasks").DelegationTaskContext;
  /** Shared across all descendants of one authenticated GOAL run; never serialized. */
  goalUsage?: { record(usage: { promptTokens?: number; completionTokens?: number; cachedTokens?: number; cacheCreationTokens?: number }): void };
  cowork?: CoworkTarget;
  coworkRunId?: string;
  coworkSessionId?: string;
  coworkPermissionMode?: AgentPermissionMode;
  coworkSource?: RunSource;
  /** 顶层拥有 cleanup，子 agent 不得提前清理兄弟执行器。 */
  deferCoworkCleanup?: (deviceId: string, runId: string) => void;
  checkpoint?: CheckpointController;
  /** 顶层运行的展示关联 ID；派出的子 agent 原样继承。 */
  runId?: string;
  /** 命名 Subagent 单次派发 ID；用于把其内部 Workflow 工具证据精确带回调用边界。 */
  subagentDelegationId?: string;
  /**
   * 顶层 run 与全部命名 Subagent 共享的瞬时工具证据。用于把已经发生的确定性副作用
   * （例如 NovelAI collect 已验签的原图）带回上游 Workflow；不落 session，也不替代 checkpoint。
   */
  toolEvidence?: Map<string, unknown>;
  /** Per-Browser delegation, populated only by verified local artifact publication. */
  browserArtifacts?: import("./core/browserArtifacts").BrowserArtifact[];
  /** Trusted run-local step segments; never shared with a fresh Browser dispatch. */
  browserContinuation?: import("./core/browserContinuation").BrowserStepContinuation;
  /** One top-level attempt and its descendants; never reused for a later run/resume. */
  fileChanges?: TurnFileChangeCollector;
  calendarCards?: import("./calendar/cards").CalendarCardCollector;
  /** Workflow 下授给单次 Browser 的硬边界；来自执行器，不接受模型自行扩大。 */
  novelAiSubmission?: NovelAiSubmissionLimit;
}

/** 运行一个无状态、一次性的通用 Subagent；能力只能从调用方已有工具中向下授权。 */
export type RunEphemeralSubagent = (
  caller: Agent,
  input: string,
  tools: string[],
  signal?: AbortSignal,
  execution?: RunExecutionContext
) => Promise<string>;

/** 工具执行时拿到的上下文（如需派子 agent，用 runAgent）。 */
export interface ToolContext {
  agent: Agent;
  logger: Logger;
  /** Set by the executing transport, never model arguments. Native loops require a vision model. */
  imageOutputSupported?: boolean;
  permissionMode?: AgentPermissionMode;
  /** 当前这条 agentLoop 实际选择的模型。命名 Subagent 只在有明确继承策略时使用，
   * 不能把它当成全局默认覆盖目标 Agent 自己的模型配置。 */
  modelRef?: string;
  /**
   * 本轮用户明确提交的附件。只随当前 run 进入工具上下文，不从历史会话补取。
   * browser_controller 只能从这里选择附件上传，不能接受模型任意拼出的本地路径。
   */
  attachments?: Attachment[];
  /**
   * 仅在一次 agentLoop 内共享的瞬时状态。用于工具实现“本轮只允许一次”等协议；
   * 不跨会话持久化，也不得拿来替代 sessionStore。
   */
  runState?: Map<string, unknown>;
  /**
   * 注册本次 agentLoop 结束时必须执行的资源回收；同 key 后注册会替换前一项。
   * 返回取消函数，供工具在主动释放资源后撤销兜底清理。
   */
  deferCleanup?: (key: string, cleanup: () => Promise<void> | void) => () => void;
  /** 派子 agent 的能力（由 index/demo 注入）。 */
  runAgent?: RunAgent;
  /** 派临时通用 Subagent；实现层保证其工具集是调用方能力的真子集。 */
  runEphemeralSubagent?: RunEphemeralSubagent;
  /** 本次 run 的可信来源（渠道 + 会话键 + actor）。工具权限不能只看 web/discord，
   * 必须检查 actor.role；cron / 无来源则是自动触发或子 agent。 */
  source?: RunSource;
  /** 本次 run 的 taskType（heartbeat = 探活自动触发）。同样用于人在场判断。 */
  taskType?: string;
  /**
   * 停下来问人，拿到答复再继续（web 会弹窗；非交互渠道不可用）。
   * 返回人选的 option.value 或自由文本；超时返回 ASK_TIMEOUT，调用方【必须当拒绝处理】。
   * 只有在 source.channel 是交互渠道时才注入——否则为 undefined，工具应据此降级。
   */
  askUser?: (input: {
    kind?: "confirm" | "question";
    question: string;
    detail?: string;
    options: Array<{ value: string; label: string; hint?: string }>;
    timeoutMs?: number;
  }) => Promise<string>;
  /**
   * 取消信号：用户点「停止」→ HTTP 连接断开 → 这个信号被 abort。
   * 工具（尤其 spawn_subagent）必须把它【往下透传】给 ctx.runAgent，否则父停子还在跑。
   */
  signal?: AbortSignal;
  /** 顶层会话的 durable checkpoint；派子 agent 时必须原样透传。 */
  execution?: RunExecutionContext;
}

/**
 * 一次 run 的「会话记忆」引用。带上它，runAgent 走【有状态】路径：
 * 载入该 session 的历史 + 滚动摘要 → 跑 loop → 把本轮追加回 session → 按需压缩。
 * 不带（如子 agent、一次性运行）则【无状态】：每次只有 system + 本条输入。
 */
/**
 * 一段会话在外部世界里的来源说明。key 负责隔离上下文；origin 只负责让人看懂
 * “这是谁的 Bot、哪个服务器/私聊、哪个频道”，不会参与路由或权限判断。
 */
export interface SessionOrigin {
  platform: string;
  accountKey?: string;
  accountLabel?: string;
  targetId?: string;
  scope?: "web" | "dm" | "guild" | "group" | "unknown";
  containerId?: string;
  containerName?: string;
  locationName?: string;
  authorId?: string;
  authorName?: string;
  /** 展示/审计用；真正权限仍取本轮 SessionRef.actor，不能信任落盘 origin。 */
  actorRole?: ActorIdentity["role"];
}

export interface SessionRef {
  /** 提交时锁定具体会话，不能在排队/STT后重新读取 active 指针。 */
  id?: string;
  /** 当前消息目标；不修改会话默认。 */
  cowork?: CoworkTarget;
  /** 来源绑定，如 "discord:<channelId>" / "web:default" / "cron:<jobId>"。 */
  key: string;
  /** 渠道入口为本轮分配的展示运行 ID；用于把 WS trace 精确挂回这一轮。 */
  runId?: string;
  /** 渠道类型："discord" | "web" | "cron" | "qq" … */
  channel: string;
  /**
   * 发起这轮对话的人（目前只有 Discord 用得上：用户 ID）。保留给 ask_user/审计兼容；
   * 主人判定与工具权限只认 actor，不能只比较这个裸 ID。
   */
  authorId?: string;
  /** 渠道入口已经验证/分类的当前发言者。 */
  actor?: ActorIdentity;
  /** 展示用的渠道来源元数据；每次入站都会刷新，旧 session 没有也能按 key 降级显示。 */
  origin?: SessionOrigin;
  /** Web GOAL 开关提交的新目标；QQ/DC 命令则直接写 SessionStore。 */
  goalObjective?: string;
  goalOptions?: import("./core/goalState").GoalStartOptions;
  /** Internal scheduler ticket, never accepted from HTTP/user tool parameters. */
  goalContinuation?: { goalId: string; revision: number };
  /** 当前入口为本轮选择的推理力度；有 SessionStore 时同时持久化到会话。 */
  reasoningEffort?: ReasoningEffort;
}

/**
 * Harbour 的统一推理力度。
 * `off` 是 Claude Agent SDK 路径沿用的“尽量关闭/最少思考”别名；Codex App Server
 * 使用其原生的 none/minimal/.../max/ultra，最终仍会按模型目录校验支持范围。
 */
export const REASONING_EFFORTS = [
  "off",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return REASONING_EFFORTS.includes(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : undefined;
}

/**
 * Claude Agent SDK 原生权限模式。Harbour 保留同名值并原样透传，避免再出现
 * UI 的 "bypass" 实际却跑成 SDK "dontAsk" 这种语义错位。
 */
export const AGENT_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
] as const;
export type AgentPermissionMode = (typeof AGENT_PERMISSION_MODES)[number];

/** API 边界统一规范化；旧 Web 曾发送 bypass，兼容映射到它当时真正代表的 dontAsk。 */
export function normalizeAgentPermissionMode(value: unknown): AgentPermissionMode | undefined {
  if (value === "bypass") return "dontAsk";
  return AGENT_PERMISSION_MODES.includes(value as AgentPermissionMode)
    ? (value as AgentPermissionMode)
    : undefined;
}

export type RunAgent = (
  agentName: string,
  input: string,
  taskType?: string,
  /** 多模态附件（可选）：随首条 user 消息进入 loop。 */
  attachments?: Attachment[],
  /** 会话记忆引用（可选）：带上则有状态（跨轮记忆 + 压缩）；不带则无状态。 */
  sessionRef?: SessionRef,
  /** 覆盖本次运行的 modelRef（chat 换模型用）；缺省走 router.pick。effort/compact/window 都按它取。 */
  modelOverride?: string,
  /** 本次运行覆盖 Agent 默认权限模式；缺省走 Agent.permissionMode。 */
  permissionMode?: AgentPermissionMode,
  /** 取消信号：贯穿到 loop 与 backend，abort 即停整条运行（含子 agent）。 */
  signal?: AbortSignal,
  /** 顶层 run 的共享执行态。只由 Harbour 内部递归透传，渠道调用方不需要构造。 */
  execution?: RunExecutionContext,
  /** 命名 Subagent 的瞬时调用上下文；不落 session。 */
  delegation?: {
    source?: ToolContext["source"];
    askUser?: ToolContext["askUser"];
    /** Explicit durable-task binding for this dispatch only. Never inherited via execution or exposed to model arguments. */
    taskRef?: string;
  }
) => Promise<string>;

/** router 用来挑模型；可被 agent 配置覆盖。 */
export type TaskType =
  | "heartbeat"
  | "classify"
  | "research"
  | "writing"
  | "critical"
  | (string & {});

/** Sandbox 权限（agent governance.permissions）。只有显式声明的那一类才会被限制。 */
export interface Permissions {
  /** 允许读取的路径根（缺省=不限制；空数组=一律拒绝）。支持 "dir/**" 写法。 */
  readPaths?: string[];
  /** 允许写入的路径根。 */
  writePaths?: string[];
  /** 允许调用的工具名（非空时为白名单）。 */
  tools?: string[];
  /** 允许使用的 MCP server 名（非空时为白名单）。 */
  mcp?: string[];
  /** 只允许显式 ToolDef.readOnly === true 的工具；外部 MCP 因无法证明只读而不挂载。 */
  readOnly?: boolean;
}

/** 每个 agent 的治理策略（来自其 CLAUDE.md frontmatter.governance）。 */
export interface Governance {
  /** 采样温度（openrouter 后端生效；claude-agent SDK 暂不支持，会被忽略）。 */
  temperature?: number;
  /** 可用模型白名单（非空时，router 选出的 modelRef 必须在内，否则报错）。 */
  allowedModels?: string[];
  /** 单次运行的 token 预算上限（loop 内累计估算超限即收尾）。 */
  maxTokensPerRun?: number;
  tokenBudgetMode?: "hard" | "converge";
  hardMaxTokensPerRun?: number;
  /** Sandbox 权限（读写路径 / 工具 / MCP 白名单）。 */
  permissions?: Permissions;
}

/**
 * 一个外部 MCP server 真身（来自项目根 mcp/<name>/MCP.md）。
 * agent 的 mcp/index.md 只保存要挂载的 server 名，不重复命令/参数。
 * stdio 由 claude-agent 拉起并以 mcp__<name>__<tool> 暴露；
 * 只读 HTTP 由 Harbour read_mcp/call_mcp 懒加载，两种模型后端共用官方 schema。
 */
export interface AgentMcpServer {
  /** 注册名，决定工具前缀 mcp__<name>__<tool>（如 chrome_devtools）。 */
  name: string;
  /** 给模型看的能力摘要；具体工具 schema 仍由 MCP server 自己提供。 */
  description?: string;
  /** 启动命令（如 "npx"）。 */
  command?: string;
  /** stdio 由 Claude SDK 托管；http 由 Harbour 的只读 MCP 客户端托管，两种模型后端共用。 */
  transport?: "stdio" | "http";
  url?: string;
  /** 本地维护者审定的只读属性，不信任远端 annotations 自动授予权限。 */
  readOnly?: boolean;
  /** 命令参数（如 ["-y","chrome-devtools-mcp@latest","--isolated"]）。 */
  args?: string[];
  /** 额外环境变量。 */
  env?: Record<string, string>;
  /** 精确工具名白名单；stdio 空/缺省=全部，HTTP 必须非空。 */
  allow?: string[];
}

/** HEARTBEAT.md 解析出的一条定时任务。 */
export interface HeartbeatTask {
  /** cron 表达式（与 every 二选一）。 */
  cron?: string;
  /** cron 的 IANA 执行时区；缺省沿用升级前宿主时区，interval 不受影响。 */
  timeZone?: string;
  /** interval 间隔（如 "30m" / "90s" / "1h"）。 */
  every?: string;
  /** 触发时给 agent 的输入。 */
  input: string;
  /** 任务类型，默认 heartbeat（走最便宜模型、无全量 context）。 */
  taskType?: string;
}

/** Agent Skills 标准技能在当前 agent 中的有效挂载。 */
export interface AgentSkill {
  /** 技能名；必须与技能目录名和 SKILL.md frontmatter.name 一致。 */
  name: string;
  /** 启动时常驻的触发描述；完整正文仍由 read_skill 懒加载。 */
  description: string;
  /** 项目根 skills/<name>/ 的绝对路径。 */
  directory: string;
  /** Skill 真身统一位于项目根目录。 */
  source: "global";
}

/** 当前 Agent 获准读取/执行的固定 Workflow（仅常驻名称与触发描述）。 */
export interface AgentWorkflow {
  /** Workflow 名；必须与 workflows/<name>/ 目录及 WORKFLOW.md frontmatter.name 一致。 */
  name: string;
  /** 给 Agent 做语义路由的薄描述；完整契约由 read_workflow 懒加载。 */
  description: string;
  /** 运行时执行器 ID；由 Harbour 注册表解析，不能由模型随意指定。 */
  executor: string;
  /** 项目根 workflows/<name>/ 的绝对路径。 */
  directory: string;
  /** Workflow 定义版本，便于状态/输入迁移。 */
  version: number;
}

/** 当前 Agent 获准同步派发的固定专精 Agent（只常驻名称与触发描述）。 */
export interface AgentSubagent {
  /** 传给 spawn_subagent 的稳定 Agent 名。 */
  name: string;
  /** 给调用方做语义路由的薄描述；目标 Agent 的完整 prompt 不会提前装入。 */
  description: string;
}

/** Agent = 一份配置（系统提示 + 工具集 + 模型 + context 策略）。 */
export interface Agent {
  name: string;
  description?: string;
  systemPrompt: string;
  /** 非主人对话专用 prompt；不含 MASTER/PREFERENCE/MEMORY/全局记忆或能力清单。 */
  publicSystemPrompt?: string;
  /** 直接指定 modelRef，优先于 taskType 策略表。 */
  model?: string;
  /** 没指定 model 时，router 按这个 taskType 查策略表。 */
  taskType: TaskType;
  /** 这个 agent 允许用的工具名。 */
  tools: string[];
  /** auto 随本轮实际模型窗口解析；正整数是显式输入限额。runtime 不回写解析值。 */
  contextBudget: number | "auto";
  /** loop 最大步数保险丝（默认 20）。 */
  maxSteps?: number;
  /** 本 Agent 的默认权限模式；本次 run 显式覆盖优先。 */
  permissionMode: AgentPermissionMode;
  /** Agent 思考力度默认；未配置时 Main 为 high，其余为 medium。 */
  reasoningEffort?: ReasoningEffort;
  /** 覆盖 router 策略表：taskType -> modelRef。 */
  routerOverrides?: Record<string, string>;
  /**
   * 该 agent 专属的 fallback modelRef 链（按顺序），追加在策略表 fallback 之后、
   * 全局 fallback 之前。填的是 modelRef（如 "claude-agent-fallback/default"），
   * 不是密钥——密钥只走 .env。空/缺省=只用全局 fallback。
   */
  fallbacks?: string[];
  /** 治理策略（per-agent governance）。 */
  governance?: Governance;
  /** 当前 agent 挂载的全局 MCP server；名字来自 agent/mcp/index.md，真身来自根 mcp/。 */
  mcpServers?: AgentMcpServer[];
  /** 是否在装配 system 时并入全局记忆（MASTER + assets/Memory 根索引）。默认 false，当前仅 main=true。 */
  readsGlobalMemory?: boolean;
  /** agent 文件夹绝对路径（文件夹型 agent 才有；供 read_skill / 定位用）。 */
  agentDir?: string;
  /** 当前 agent 挂载的全局 Skill；名字来自 agent/skills/index.md，真身来自根 skills/。 */
  skills?: AgentSkill[];
  /** 当前 agent 挂载的固定 Workflow；名字来自 agent/workflows/index.md，真身来自根 workflows/。 */
  workflows?: AgentWorkflow[];
  /** 当前 agent 可同步派发的固定 Subagent；名字来自 agent/subagents/index.md。 */
  subagents?: AgentSubagent[];
  /** HEARTBEAT.md 解析出的定时任务（scheduler 据此建任务）。 */
  heartbeats?: HeartbeatTask[];
}

/** 队列里的一个任务单元。 */
export interface Task {
  id: string;
  agentName: string;
  input: string;
  /** 强制 taskType（如 heartbeat 探活强制走便宜模型），覆盖 agent.taskType。 */
  taskType?: string;
  /** 入站多模态附件（如 Discord 用户发来的图片/语音/文件），透传给 runAgent。 */
  attachments?: Attachment[];
  /** 会话/来源引用：有 SessionStore 时启用跨轮记忆；关闭 Session 时仍可只携带可信 actor。 */
  sessionRef?: SessionRef;
  /** Trusted scheduler source, separate from chat history (fresh Cron must remain stateless). */
  source?: RunSource;
  /** 处理完把结果回发到来源渠道（text + 可选出站附件）。 */
  reply?: (text: string, attachments?: Attachment[]) => Promise<void>;
  /** Persist background-job execution start before invoking any model or side-effecting tool. */
  onStart?: () => Promise<void>;
  /** Background jobs record execution failure separately from successful output delivery. */
  onError?: (error: unknown) => Promise<void>;
  /** 无论成功、失败或超时都执行；用于停止 typing 等瞬时渠道状态。 */
  onSettled?: () => void;
  meta?: Record<string, unknown>;
}

/* ── backend 抽象 ──────────────────────────────────────────────── */

/** 执行审计，不是模型思考流；不携带原始参数或完整结果。每个 agentLoop 独立持有 sink。 */
export interface ToolAuditEvent {
  type: "tool-call" | "tool-result" | "tool-error";
  source: "outer-loop" | "codex-dynamic" | "codex-native" | "claude-sdk" | "dsh";
  tool: string;
  callId?: string;
  step?: number;
  status?: "requested" | "completed" | "failed" | "rejected" | "interrupted";
  /** 只有边界确认工具未执行时才写 false；收到请求不等于副作用已发生。 */
  executed?: false;
  summary?: Record<string, unknown>;
}

export interface CompletionRequest {
  /** 完整 modelRef（如 openrouter/anthropic/claude-sonnet-4.6），仅供日志。 */
  modelRef: string;
  /** 去掉 backend 前缀后的具体模型 id（交给 provider）。 */
  model: string;
  messages: Message[];
  /** Actual endpoint capability; used to admit native image supplements without switching models mid-run. */
  supportsVision?: boolean;
  /** Runtime-resolved capacity for this actual endpoint, never model-authored metadata. */
  contextPolicy?: { contextWindow: number; contextLimit: number; compactAtTokens: number };
  tools?: ToolDef[];
  /** 后端若自己执行工具（如 Claude Agent SDK 的 MCP tools），用这里拿执行上下文。 */
  toolContext?: ToolContext;
  /** 后端自管工具事件写回当前 run 的持久 trace；不共享给嵌套 Agent，不影响执行结果。 */
  onToolAudit?: (event: ToolAuditEvent) => void | Promise<void>;
  /** 后端原生 agent loop 的最大 turn 数。 */
  maxTurns?: number;
  /**
   * 单次运行 token 治理。soft 只提醒原生 agent loop 收敛；hard 才是防止失控循环的
   * 高位保险丝。缓存命中仍完整进入 Metrics/成本与 hard，但不单独推动 soft 收敛线；
   * soft 衡量本轮新增 prompt、cache write 与 output，避免普通追问被缓存历史误触发收尾。
   */
  tokenBudget?: {
    softTokens?: number;
    hardTokens?: number;
    mode: "hard" | "converge";
  };
  /** 后端每完成一个供应商回合就上报增量 usage，避免失败/停止时漏账。 */
  onUsage?: (usage: {
    promptTokens?: number;
    completionTokens?: number;
    cachedTokens?: number;
    cacheCreationTokens?: number;
  }) => void;
  /** 采样温度（governance 注入；后端支持则用，不支持则忽略）。 */
  temperature?: number;
  /** 思考 token 预算（effort 档位注入）：>0 开思考并设 MAX_THINKING_TOKENS；0=尽量不思考；
   *  undefined=不覆盖。Claude Agent SDK 使用预算；Codex Harness 将离散预算还原成原生 effort。 */
  thinkingBudget?: number;
  /** Agent 权限模式：Claude Agent SDK 原样透传；Codex Harness 用它区分 plan 只读与交互式工作区写入。 */
  permissionMode?: AgentPermissionMode;
  /** 单个工具执行超时（毫秒）。后端【自己执行工具】时必须自行套用——agentLoop 的
   *  executeToolSafely 只管外层 loop 那条路，claude-agent 把工具交给 SDK 子进程调度，
   *  外层保险丝够不着，不在这里传就等于没有超时。 */
  toolTimeoutMs?: number;
  /** 取消信号：透给后端原生 loop（SDK 的 abortController），abort 即杀子进程。 */
  signal?: AbortSignal;
}

export interface CompletionResult {
  /** 模型返回的 assistant 消息（可能带 toolCalls）。 */
  message: Message;
  /** cachedTokens = 命中 prompt 缓存的 input token（省钱关键）；cacheCreationTokens = 写入缓存的 input token。 */
  usage?: { promptTokens?: number; completionTokens?: number; cachedTokens?: number; cacheCreationTokens?: number };
  /** usage 已由后端增量上报，外层不得在收尾时重复累计。 */
  usageReported?: boolean;
  /** 正常传回局部输出以阻止 router 重放，但不是完整交付；保留 checkpoint，不提交 GOAL。 */
  incomplete?: "max_steps" | "output_limit" | "budget" | "empty_reply" | "interrupted";
  /** 实际服务本次补全的 modelRef（router fallback 后可能 ≠ 请求的 ref）；由 Router.complete 盖章，供 metrics 归因。 */
  servedBy?: string;
}

/** 所有后端的统一接口；router 按 modelRef 前缀分发到对应后端。 */
export interface Backend {
  name: string;
  supportsNativeSessions?: boolean;
  /** Can carry in-memory verified tool image snapshots, not just textual receipts. */
  supportsToolImages?: boolean;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}
