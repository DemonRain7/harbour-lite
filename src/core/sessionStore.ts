import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Logger } from "pino";
import {
  normalizeAgentPermissionMode,
  normalizeReasoningEffort,
  type ActorIdentity,
  type Agent,
  type AgentPermissionMode,
  type Attachment,
  type CheckpointToolRejection,
  type CoworkTarget,
  type Message,
  type ReasoningEffort,
  type RunSource,
  type SessionRef,
  type SessionOrigin,
  type SessionRunRecord,
  type TurnFileChange,
} from "../types";
import { normalizeFileChanges } from "./fileChanges";
import { normalizeSessionImages, sessionImageReferences, type SessionImageReference } from "./sessionImages";
import { normalizeCalendarCards, type CalendarCard } from "../calendar/cards";
import type { Router } from "./router";
import { buildChatMessages } from "./promptAssembly";
import { estimateMessageTokens, estimateRequestTokens, estimateTextTokens } from "./tokenEstimate";
import { contextWindowForModel } from "./modelInfo";
import type { TokenUsageBuckets } from "./governance";
import {
  createSessionGoal, normalizeSessionGoal, validateGoalConfiguration, normalizeGoalNextStep, normalizeGoalWaiting,
  normalizeGoalSource, normalizeGoalVerification, goalBudgetExhausted, goalCompletionVerified, goalText,
  type SessionGoal, type SessionGoalStatus, type GoalStartOptions, type GoalConfiguration, type GoalWaiting,
  type GoalRunBinding, type GoalRunFinish,
} from "./goalState";
import { normalizeCoworkTarget } from "./cowork/targets";
import { normalizeWorkflowValidationDetails } from "./workflows/registry";
import {
  materializeExecutionHistory,
  executionEvidenceBaselineFromSnapshot,
  normalizeExecutionEvidence,
  normalizeExecutionEvidenceBaseline,
  projectExecutionEvidence,
  recentExecutionRecords,
  snapshotExecutionEvidenceBaseline,
  stripExecutionEvidenceCards,
  type ExecutionEvidenceBaseline,
  type ExecutionEvidenceBaselineSnapshot,
} from "./executionEvidence";

export type { SessionRef };
export type { SessionGoal, SessionGoalStatus } from "./goalState";

export type CheckpointStatus = "running" | "interrupted";
export type CheckpointToolStatus = "running" | "completed" | "failed" | "interrupted";

/** 一次可恢复运行里的一个可观察工具边界。模型的纯 thinking 不可序列化，工具结果可以。 */
export interface CheckpointToolCall {
  nativeCallId?: string;
  mutating?: boolean;
  scope?: string;
  remote?: { deviceId: string; operationId: string; status: string; code?: string };
  id: string;
  sequence: number;
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  fingerprint: string;
  kind: "harbour" | "external-mcp" | "codex-native";
  status: CheckpointToolStatus;
  /** 只有 Harbour 自有工具能在恢复时把旧结果直接注回模型；SDK 外部 MCP 只能记录后重跑。 */
  replayable: boolean;
  result?: unknown;
  /** 执行器已持久化的有界进度引用；不代表工具已完成，也不改变 replayable。 */
  recovery?: Record<string, string | number | boolean>;
  error?: string;
  /** Typed pre-execution rejection: exact native retransmits replay the error, new calls may revalidate. */
  rejection?: CheckpointToolRejection;
  externalUseId?: string;
  replayCount?: number;
  startedAt: string;
  completedAt?: string;
  replayedAt?: string;
}

/**
 * 停止/故障后的 durable checkpoint。它不冒充模型内部思维快照，而是精确保存每一个
 * 已完成工具步骤及其结果；恢复时这些步骤逐个回放，从首个未完成工具边界继续。
 */
export interface RunCheckpoint {
  cowork?: CoworkTarget;
  version: 1;
  id: string;
  status: CheckpointStatus;
  agentName: string;
  originalInput: string;
  taskType?: string;
  modelRef?: string;
  permissionMode?: AgentPermissionMode;
  /** 断点恢复必须沿用原运行的 Effort，不能读取恢复时才改变的会话默认。 */
  reasoningEffort?: ReasoningEffort;
  /** 断点恢复沿用中断时钉住的 Skill；避免用户改配置后续跑成另一套工作流。 */
  pinnedSkill?: string;
  attachments?: Attachment[];
  /** 原始任务发起者；中断回放 UI 与恢复审计使用。 */
  actor?: ActorIdentity;
  tools: CheckpointToolCall[];
  resumeCount: number;
  createdAt: string;
  updatedAt: string;
  interruptedAt?: string;
  reason?: string;
  latestResumeInput?: string;
}

/**
 * SessionStore —— 跨轮「会话记忆」。
 *
 * 区别于 assets/sessions 里的 **trace**（每次 run 的 JSONL 流水，只读回放）：
 * 这里的 ChatSession 是【会持续累积的一段对话】，让 Harbour 记得上一条消息说了啥。
 *
 * 绑定关系（key）：一个来源 = 一个 key，可挂多个 session，但同时只有一个「活跃」：
 *   - 一个 Discord 频道/私信        → key = "discord:<channelId>"
 *   - web dashboard 主聊天          → key = "web:default"
 *   - cron 作业（sessionMode=continue）→ key = "cron:<jobId>"
 *   - 以后 QQ 群/好友              → key = "qq:<id>"
 * 用户可在同一 key 下「新开 / 切换」session（DC 命令、web 会话条）。
 *
 * 压缩（compaction）：当一段会话的正文（摘要 + 近期消息）估算 token 超过阈值，
 * 就把较早的消息交给模型摘要成一段「滚动摘要」，丢掉原文、保留最近 N 条原样。
 * 摘要折进 system，近期原样的消息照常进 loop——既省 token 又保连贯。
 *
 * 持久化：每个 session 一份 data/sessions/<id>.json；活跃指针 data/sessions/_active.json。
 * 内存为准（同一对象引用复用），落盘 fire-and-forget，绝不因写盘失败拖垮对话。
 * data/sessions/ 含对话内容（隐私）——已 gitignore。
 */

export interface ChatSession {
  /** Latest observed native context, not cumulative billing usage or a KV-cache guarantee. */
  nativeContext?: { tokens: number; modelRef: string; agentName: string; observedAt: string };
  cowork?: CoworkTarget;
  id: string;
  /** 来源绑定，如 "discord:123" / "web:default"。 */
  key: string;
  /** 渠道类型："discord" | "web" | "cron" | "qq" … */
  channel: string;
  /** 渠道来源的可读元数据；旧数据缺失时 API 会根据 key 做兼容展示。 */
  origin?: SessionOrigin;
  /** 这条会话默认对话的 agent（web 可逐条切，存最近一次）。 */
  agentName: string;
  /** Main Chat 为这条会话选择的精确「连接 + 模型」引用；空表示跟随 agent/router。 */
  modelRef?: string;
  /** Main Chat 为这条会话选择的 Mode 覆盖；空表示跟随 Agent 当前默认 Mode。 */
  permissionMode?: AgentPermissionMode;
  /** Main Chat 为这条会话选择的 Effort 覆盖；空表示跟随逐模型配置/模型默认。 */
  reasoningEffort?: ReasoningEffort;
  /** 当前会话钉住的 Skill；空表示按挂载目录自动语义路由。 */
  pinnedSkill?: string;
  /** 标题：默认取首条用户消息前缀，可重命名。 */
  title: string;
  /** 滚动摘要（早前对话压缩后的要点）；"" 表示尚未压缩。 */
  summary: string;
  /** 近期原样保留的消息（仅 user/assistant，不含 system / 工具中间态）。 */
  messages: Message[];
  /** 被压缩消息的最近少量服务器事实卡；与自由文本摘要分离，避免摘要遗漏执行事实。 */
  compactedRunRecords?: SessionRunRecord[];
  /** Verified owner upload provenance retained across compaction; no pixels, paths or new upload authority. */
  compactedImages?: SessionImageReference[];
  /**
   * 仅供同 checkpoint 的迟到结算刷新中断事实；不进入模型历史或 sessionDetail API。
   * 每次恢复/替换都会先刷新并冻结旧 attempt，因此正常情况下至多一项。
   */
  executionEvidenceBaselines?: Array<{
    attemptId: string;
    checkpointId: string;
    baseline: ExecutionEvidenceBaselineSnapshot;
  }>;
  /** 已压缩次数。 */
  compactions: number;
  createdAt: string;
  updatedAt: string;
  /** 最后一条真实聊天消息的时间；切换/重命名/配置/trace 更新都不得改它。 */
  lastMessageAt?: string;
  /** UI-only reply/read watermarks. Independent of history compaction and timestamps. */
  replyRevision?: number;
  readReplyRevision?: number;
  /**
   * 最近一份 orchestrator 提交的执行计划（前端 todo 徽标据此渲染 + 恢复）。
   * 纯展示用，不进 LLM 上下文。整份存，很小。
   */
  plan?: unknown;
  /**
   * 与 messages【严格平行对齐】的运行轨迹：traces[i] 对应 messages[i]（user 槽恒为 null，
   * 只有 assistant 槽可能有 trace）。前端切会话/刷新后靠它还原每条「运行轨迹」dropdown。
   * 对齐靠两条铁律：appendTurn 时同步 push 两个槽；压缩丢弃旧消息时同前缀丢弃 traces。
   * 纯展示，不进 LLM 上下文。
   */
  traces?: (unknown[] | null)[];
  /**
   * 与 messages 严格平行对齐的时间戳：times[i] 是 messages[i] 的发生时间（ISO）。
   * 老会话没有这个字段，缺失/为 null 时显示层不显示时间（不猜）。对齐规则同 traces。
   */
  times?: (string | null)[];
  /**
   * 与 messages 严格平行对齐的本轮总运行时长（毫秒）。仅 assistant 槽有值。
   * 由 runtime 在整轮成功收尾后写入；不依赖 trace 首尾事件，因此 WS 漏事件也不会算错。
   */
  durations?: (number | null)[];
  /** 当前尚未完成的一轮。成功收尾即删除；停止/故障时保留为 interrupted，供“继续”恢复。 */
  checkpoint?: RunCheckpoint;
  /** 可选持续目标；closed 状态保留到下一次 GOAL 覆盖，供 UI 正确结束旧状态。 */
  goal?: SessionGoal;
}

export function isOpenSessionGoal(goal?: SessionGoal): goal is SessionGoal {
  return goal?.status === "active" || goal?.status === "blocked" || goal?.status === "paused";
}

/** 单条 trace 最多存多少事件（防会话文件膨胀；前端本就 400 上限）。 */
const MAX_TRACE_EVENTS = 400;
/**
 * 最多保留几轮的 trace（更早的槽置 null，仍与 messages 对齐、只是不占体积）。
 * trace 不进 LLM 上下文、不受消息压缩约束，「短消息多轮」时消息 token 迟迟不到压缩线，
 * traces 却会一直堆——单独给它一个上限，与压缩解耦。
 */
const MAX_TRACE_TURNS = 30;

export interface AttachmentCleanupResult {
  retentionDays: number;
  cutoff: string;
  sessionsChanged: number;
  messagesChanged: number;
  attachmentsExpired: number;
  contentLinksExpired: number;
  filesDeleted: number;
  bytesFreed: number;
  filesKeptByReference: number;
  errors: number;
}

function bodyTokens(s: ChatSession): number {
  const { history, summary } = modelHistory(s);
  return estimateTextTokens(summary) + history.reduce((a, message) => a + estimateMessageTokens(message), 0);
}

/** All model consumers, including compaction and its token accounting, share this bounded projection. */
function modelHistory(s: ChatSession): { history: Message[]; summary: string } {
  const { history, summarySuffix } = materializeExecutionHistory(s.messages, s.compactedRunRecords);
  return { history, summary: [s.summary, summarySuffix].filter(Boolean).join("\n\n") };
}

/** 从最新往前累计 token，保留最近一段原文窗口（总量约 ≤ keepTokens）；至少保留 minCount 条兜底。 */
function recentKeepCount(messages: Message[], keepTokens: number, minCount: number): number {
  const floor = Math.min(minCount, messages.length);
  if (keepTokens <= 0) return floor;
  let acc = 0;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateMessageTokens(messages[i]!);
    count++;
    if (acc > keepTokens && count >= minCount) break;
  }
  return Math.min(Math.max(count, floor), messages.length);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 会话列表的唯一排序/显示时间：消息时间优先；空会话稳定使用创建时间。 */
export function sessionActivityAt(s: ChatSession): string {
  if (s.lastMessageAt) return s.lastMessageAt;
  if (s.times?.length) {
    for (let i = s.times.length - 1; i >= 0; i--) if (s.times[i]) return s.times[i]!;
  }
  // 旧数据没有 times：有消息时 updatedAt 是唯一可用迁移线索；空会话绝不能用它，
  // 否则切换/改配置会让“最后消息时间”持续刷新。
  return s.messages.length ? s.updatedAt : s.createdAt;
}

/** Older sessions have no read receipts: start tracking new replies, not invented historical unread. */
export function sessionReplyState(s: Pick<ChatSession, "replyRevision" | "readReplyRevision">) {
  const replyRevision = Number.isSafeInteger(s.replyRevision) && s.replyRevision! >= 0 ? s.replyRevision! : 0;
  const readReplyRevision = Number.isSafeInteger(s.readReplyRevision) && s.readReplyRevision! >= 0
    ? Math.min(s.readReplyRevision!, replyRevision) : 0;
  return { replyRevision, readReplyRevision, unread: replyRevision > readReplyRevision };
}

/** Bind a terminal notification only to this run's persisted latest reply. */
export function sessionReplyNotification(session: ChatSession | undefined, runId: string) {
  return session && sessionLatestReplyRunId(session) === runId ? sessionReplyState(session) : {};
}

/** Correlates read UI metadata after reconnect; never infers execution success. */
export function sessionLatestReplyRunId(session: ChatSession) {
  for (let i = session.messages.length - 1; i >= 0; --i) {
    const message = session.messages[i]!;
    if (message.role === "assistant") return message.runRecord?.attemptId ?? message.fileChangeRunId;
  }
  return undefined;
}

function makeTitle(firstUserText: string): string {
  const flat = (firstUserText ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "新会话";
  return flat.length > 24 ? flat.slice(0, 24) + "…" : flat;
}

function compactDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const ss = String(seconds % 60).padStart(2, "0");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes).padStart(2, "0")}:${ss}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${ss}`;
}

function safeInterruptionReason(value: string): string {
  return String(value || "运行未完成")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[敏感凭据已省略]")
    .replace(/\b(authorization|api[_ -]?key|token|password)\s*[:=]\s*\S+/gi, "$1=[敏感凭据已省略]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220) || "运行未完成";
}

function interruptedRecordContent(
  checkpoint: RunCheckpoint | undefined,
  reason: string,
  durationMs: number,
  trace: unknown[] = []
): string {
  const completed = checkpoint?.tools.filter((call) => call.status === "completed").length ?? 0;
  const pending = checkpoint?.tools.filter((call) => call.status !== "completed").length ?? 0;
  const lastTool = checkpoint
    ? [...checkpoint.tools].reverse().find((call) => call.status !== "completed") ?? checkpoint.tools.at(-1)
    : undefined;
  const retries = trace.filter((event) => {
    const msg = event && typeof event === "object" ? (event as Record<string, unknown>).msg : undefined;
    return msg === "loop:reconnecting";
  }).length;
  const facts = [
    `原因：${safeInterruptionReason(reason)}`,
    `耗时 ${compactDuration(durationMs)}`,
    trace.length ? `已保留 ${trace.length} 条运行轨迹` : "运行轨迹将在收尾时补齐",
    completed ? `${completed} 个工具边界已完成` : "尚无已完成工具边界",
    pending ? `${pending} 个工具边界未完成` : "没有登记中的未完成工具边界",
    lastTool ? `最后停在 ${lastTool.agent} → ${lastTool.tool}` : "尚未进入可记录的工具边界",
    retries ? `期间发生 ${retries} 次模型接口重连` : "",
  ].filter(Boolean);
  return [
    "⏹️ [Harbour 运行记录] 这轮在生成最终回答前中断。",
    facts.join("；") + "。",
    checkpoint
      ? "原任务、Trace 与 checkpoint 均已保存；后续询问“刚才为什么慢/执行到哪”时应结合本记录回答，发送“继续”可从断点恢复。"
      : "原任务与 Trace 已保存；后续询问“刚才为什么慢/执行到哪”时应结合本记录回答。",
  ].join("\n");
}

export class SessionStore {
  private sessions = new Map<string, ChatSession>();
  /** key -> 活跃 sessionId。 */
  private active = new Map<string, string>();
  private writeChain: Promise<unknown> = Promise.resolve();
  private removals = new Map<string, Promise<void>>();

  constructor(
    private logger: Logger,
    private dir: string,
    /** 旧会话缺 agentName 时补的默认 persona（= env.DEFAULT_AGENT）。 */
    private defaultAgent: string = "main-elaina"
  ) {}

  async init(): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const files = (await fs.readdir(this.dir)).filter((f) => f.endsWith(".json") && f !== "_active.json");
      for (const f of files) {
        try {
          const raw = await fs.readFile(path.join(this.dir, f), "utf8");
          const s = JSON.parse(raw) as ChatSession;
          if (s && s.id && s.key) this.sessions.set(s.id, normalize(s, this.defaultAgent));
        } catch {
          /* 跳过坏文件 */
        }
      }
      try {
        const raw = await fs.readFile(path.join(this.dir, "_active.json"), "utf8");
        const map = JSON.parse(raw) as Record<string, string>;
        for (const [k, id] of Object.entries(map)) if (this.sessions.has(id)) this.active.set(k, id);
      } catch {
        /* 无活跃指针：下面按 key 自动回填 */
      }
      // 回填：有 session 但 key 无活跃指针时，取该 key 下最新的一条为活跃。
      for (const s of [...this.sessions.values()].sort((a, b) => sessionActivityAt(b).localeCompare(sessionActivityAt(a)))) {
        if (!this.active.has(s.key)) this.active.set(s.key, s.id);
      }
    } catch (e) {
      this.logger.warn({ err: (e as Error).message, dir: this.dir }, "sessionStore: 初始化读取失败（按空起步）");
    }
    this.logger.info({ count: this.sessions.size, keys: this.active.size }, "会话记忆已加载（跨轮 session + 压缩）");
  }

  /** 取某 key 的活跃 session；没有就创建一条并置为活跃。 */
  resolveActive(key: string, opts: { channel: string; agentName: string; origin?: SessionOrigin }): ChatSession {
    const id = this.active.get(key);
    if (id) {
      const s = this.sessions.get(id);
      if (s) {
        if (opts.origin) this.refreshOrigin(s, opts.origin);
        return s;
      }
    }
    return this.create(key, opts);
  }

  /** 在入口固定 id；之后即使同 key 切会话，也不改变本轮目标。 */
  resolveRef(ref: SessionRef, agentName: string): ChatSession {
    if (!ref.id) return this.resolveActive(ref.key, { channel: ref.channel, agentName, origin: ref.origin });
    const session = this.sessions.get(ref.id);
    if (!session || session.key !== ref.key || session.channel !== ref.channel) throw new Error("会话 ID 与来源不匹配");
    return session;
  }

  create(key: string, opts: { channel: string; agentName: string; title?: string; origin?: SessionOrigin }): ChatSession {
    const now = nowIso();
    const s: ChatSession = {
      id: `cs-${randomUUID().slice(0, 8)}`,
      key,
      channel: opts.channel,
      ...(opts.origin ? { origin: { ...opts.origin } } : {}),
      agentName: opts.agentName,
      title: opts.title?.trim() || "新会话",
      summary: "",
      messages: [],
      compactions: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(s.id, s);
    this.active.set(key, s.id);
    this.persist(s);
    this.persistActive();
    this.logger.info({ sessionId: s.id, key }, "session:new");
    return s;
  }

  get(id: string): ChatSession | undefined {
    return this.sessions.get(id);
  }

  /** Acknowledge only the rendered revision; a late acknowledgement cannot consume a newer reply. */
  markRepliesRead(id: string, observedRevision: number): ChatSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error("会话不存在");
    const current = sessionReplyState(session);
    if (!Number.isSafeInteger(observedRevision) || observedRevision < 0 || observedRevision > current.replyRevision) {
      throw new Error("已读回复序号无效");
    }
    if (observedRevision > current.readReplyRevision) {
      session.readReplyRevision = observedRevision;
      this.persist(session); // Not conversation activity: never change sorting, history or model input.
    }
    return session;
  }

  stats(): { sessions: number; keys: number } {
    return { sessions: this.sessions.size, keys: this.active.size };
  }

  /** 估算某会话当前上下文占用（滚动摘要 + 保留消息），供前端 context 环。 */
  bodyTokenEstimate(s: ChatSession): number {
    return bodyTokens(s);
  }

  activeId(key: string): string | undefined {
    return this.active.get(key);
  }

  /** 某 key 下的所有 session，按最后一条消息时间倒序（空会话按创建时间）。 */
  listForKey(key: string): ChatSession[] {
    return [...this.sessions.values()]
      .filter((s) => s.key === key)
      .sort((a, b) =>
        sessionActivityAt(b).localeCompare(sessionActivityAt(a)) ||
        b.createdAt.localeCompare(a.createdAt) ||
        b.id.localeCompare(a.id)
      );
  }

  /** 跨渠道会话中心：同一 persona 的所有来源统一按真实聊天活动时间倒序。 */
  listForAgent(agentName: string, channel?: string): ChatSession[] {
    return [...this.sessions.values()]
      .filter((s) => s.agentName === agentName && (!channel || s.channel === channel))
      .sort((a, b) =>
        sessionActivityAt(b).localeCompare(sessionActivityAt(a)) ||
        b.createdAt.localeCompare(a.createdAt) ||
        b.id.localeCompare(a.id)
      );
  }

  /** 更新展示元数据但绝不 touch updatedAt / lastMessageAt，避免会话被无故顶到最前。 */
  private refreshOrigin(s: ChatSession, origin: SessionOrigin): void {
    const next = { ...(s.origin ?? {}), ...origin };
    if (JSON.stringify(next) === JSON.stringify(s.origin ?? {})) return;
    s.origin = next;
    this.persist(s);
  }

  /** 把某 key 下的某条 session 设为活跃。 */
  switchActive(key: string, id: string): ChatSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`未知 session: ${id}`);
    if (s.key !== key) throw new Error(`session ${id} 不属于该会话来源`);
    this.active.set(key, id);
    this.persistActive();
    this.logger.info({ sessionId: id, key }, "session:switch");
    return s;
  }

  rename(id: string, title: string): ChatSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`未知 session: ${id}`);
    s.title = title.trim() || s.title;
    // 标题只是展示元数据，不是聊天活动。若在这里刷新 updatedAt，旧会话会在依赖
    // updatedAt 的兼容客户端里被误判为“刚聊过”，也违背 sessionActivityAt 的排序语义。
    this.persist(s);
    return s;
  }

  setModel(id: string, modelRef?: string): ChatSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`未知 session: ${id}`);
    const clean = modelRef?.trim();
    if (clean) s.modelRef = clean;
    else delete s.modelRef;
    s.updatedAt = nowIso();
    this.persist(s);
    return s;
  }

  setCowork(id: string, target?: CoworkTarget): ChatSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`未知 session: ${id}`);
    if (s.checkpoint?.status === "running") throw new Error("运行中不能修改 Cowork 执行设备");
    const normalized = normalizeCoworkTarget(target);
    if (normalized) s.cowork = normalized;
    else delete s.cowork;
    s.updatedAt = nowIso();
    this.persist(s);
    return s;
  }

  setPermissionMode(id: string, permissionMode?: AgentPermissionMode): ChatSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`未知 session: ${id}`);
    if (permissionMode) s.permissionMode = permissionMode;
    else delete s.permissionMode;
    s.updatedAt = nowIso();
    this.persist(s);
    return s;
  }

  setReasoningEffort(id: string, reasoningEffort?: ReasoningEffort): ChatSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`未知 session: ${id}`);
    if (reasoningEffort) s.reasoningEffort = reasoningEffort;
    else delete s.reasoningEffort;
    s.updatedAt = nowIso();
    this.persist(s);
    return s;
  }

  setPinnedSkill(id: string, pinnedSkill?: string): ChatSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`未知 session: ${id}`);
    const clean = pinnedSkill?.trim();
    if (clean) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(clean)) throw new Error(`非法 Skill 名称: ${clean}`);
      s.pinnedSkill = clean;
    } else {
      delete s.pinnedSkill;
    }
    s.updatedAt = nowIso();
    this.persist(s);
    return s;
  }

  /** 新建持续目标。正在进行的目标不能被静默覆盖，必须先完成或退出。 */
  startGoal(s: ChatSession, objective: string, options: GoalStartOptions = {}): SessionGoal {
    if (s.goal?.continuation.runId) throw new Error("上一个 GOAL 的运行尚未结算");
    if (isOpenSessionGoal(s.goal)) throw new Error("当前会话已有进行中的 GOAL；请先完成或退出");
    s.goal = createSessionGoal(objective, options);
    s.updatedAt = s.goal.updatedAt;
    this.persist(s);
    this.logger.info({ sessionId: s.id, goalId: s.goal.id }, "session:goal-start");
    return s.goal;
  }

  /** Trusted user lifecycle controls; model completion must use finishGoalRun instead. */
  setGoalStatus(s: ChatSession, status: SessionGoalStatus, progress?: string): SessionGoal {
    if (!s.goal) throw new Error("当前会话没有 GOAL");
    if (!["active", "blocked", "paused", "completed", "cancelled"].includes(status)) throw new Error("未知 GOAL 状态");
    if (status === "active") {
      const result = this.resumeGoal(s, s.goal.id);
      if (goalText(progress, 2000)) result.progress = goalText(progress, 2000);
      this.persist(s);
      return result;
    }
    const goal = structuredClone(s.goal);
    goal.status = status;
    if (goalText(progress, 2000)) goal.progress = goalText(progress, 2000);
    if (status === "completed") {
      goal.completedAt = nowIso();
      goal.verification = { status: "user_accepted", requirement: goal.verificationRequirement,
        checkedAt: goal.completedAt, coverage: "recorded-boundaries-only", evidence: [{ kind: "user", ref: goal.id }] };
      delete goal.waiting;
      delete goal.pausedAt;
    } else delete goal.completedAt;
    if (status === "cancelled") goal.cancelledAt = nowIso(); else delete goal.cancelledAt;
    if (status === "paused") goal.pausedAt = nowIso();
    if (!goal.continuation.runId) goal.continuation = { state: "idle", revision: goal.revision + 1 };
    return this.commitGoal(s, goal);
  }

  /** Snapshot-only enumeration; consumers must re-fetch and CAS before dispatching a continuation. */
  listAllGoalsSessions(): ChatSession[] {
    return [...this.sessions.values()].filter((session) => !!session.goal).map((session) => structuredClone(session));
  }

  private currentGoal(s: ChatSession, goalId: string, expectedRevision?: number): SessionGoal {
    if (this.sessions.get(s.id) !== s || s.goal?.id !== goalId) throw new Error("GOAL 已变化或会话不匹配");
    if (expectedRevision !== undefined && s.goal.revision !== expectedRevision) throw new Error("GOAL revision 已变化，请刷新后重试");
    return s.goal;
  }

  private commitGoal(s: ChatSession, goal: SessionGoal): SessionGoal {
    goal.revision++;
    goal.updatedAt = nowIso();
    s.goal = goal; s.updatedAt = goal.updatedAt;
    this.persist(s);
    this.logger.info({ sessionId: s.id, goalId: goal.id, status: goal.status, revision: goal.revision }, "session:goal-update");
    return goal;
  }

  configureGoal(s: ChatSession, goalId: string, patch: GoalConfiguration, expectedRevision?: number): SessionGoal {
    const current = this.currentGoal(s, goalId, expectedRevision);
    validateGoalConfiguration(patch);
    if (!isOpenSessionGoal(current)) throw new Error("已结束的 GOAL 不能修改配置");
    if (current.continuation.runId || current.continuation.state === "running") throw new Error("GOAL 当前运行尚未结算；请先暂停并等待结算后修改配置");
    const goal = structuredClone(current);
    if (patch.autoContinue !== undefined) goal.autoContinue = patch.autoContinue;
    if (patch.acceptance !== undefined) goal.acceptance = patch.acceptance.map((item) => goalText(item, 1000)!);
    if (patch.verificationRequirement !== undefined) goal.verificationRequirement = patch.verificationRequirement;
    if (patch.acceptance !== undefined || patch.verificationRequirement !== undefined) delete goal.verification;
    if (patch.budget?.maxRounds !== undefined) goal.budget.maxRounds = patch.budget.maxRounds;
    if (patch.budget?.maxTokens !== undefined) goal.budget.maxTokens = patch.budget.maxTokens;
    if (patch.nextStep !== undefined) goal.nextStep = normalizeGoalNextStep(patch.nextStep);
    if (patch.waiting !== undefined) goal.waiting = normalizeGoalWaiting(patch.waiting);
    if (patch.progress !== undefined) goal.progress = goalText(patch.progress, 2000);
    if (goal.continuation.state === "scheduled") goal.continuation = { state: "idle", revision: goal.revision + 1 };
    return this.commitGoal(s, goal);
  }

  /** Source is accepted only from authenticated runtime code, not a Goal configuration payload. */
  bindGoalSource(s: ChatSession, goalId: string, source: RunSource): SessionGoal {
    const current = this.currentGoal(s, goalId);
    const trusted = normalizeGoalSource(source);
    if (!trusted) throw new Error("GOAL 自动续轮需要已验证主人来源");
    if (current.source && (current.source.actor?.id !== trusted.actor?.id || current.source.actor?.platform !== trusted.actor?.platform
      || current.source.channel !== trusted.channel || current.source.key !== trusted.key)) throw new Error("GOAL 来源不能跨主人或渠道替换");
    if (current.source) return current;
    return this.commitGoal(s, { ...structuredClone(current), source: trusted });
  }

  pauseGoal(s: ChatSession, goalId: string, waiting: GoalWaiting = { kind: "user", reason: "用户暂停" }, expectedRevision?: number): SessionGoal {
    const current = this.currentGoal(s, goalId, expectedRevision);
    if (!isOpenSessionGoal(current)) throw new Error("已结束的 GOAL 不能暂停");
    const clean = normalizeGoalWaiting(waiting); if (!clean) throw new Error("GOAL waiting 无效");
    const goal = structuredClone(current);
    goal.status = "paused"; goal.waiting = clean; goal.pausedAt = nowIso();
    if (!goal.continuation.runId) goal.continuation = { state: "idle", revision: goal.revision + 1 };
    return this.commitGoal(s, goal);
  }

  resumeGoal(s: ChatSession, goalId: string, expectedRevision?: number): SessionGoal {
    const current = this.currentGoal(s, goalId, expectedRevision);
    if (!isOpenSessionGoal(current)) throw new Error("已结束的 GOAL 不能恢复；请新建目标");
    if (current.continuation.runId) throw new Error("GOAL 当前运行尚未结算，不能恢复");
    if (goalBudgetExhausted(current)) throw new Error("GOAL 总预算已耗尽，请先明确增加预算");
    const goal = structuredClone(current);
    goal.status = "active"; delete goal.waiting; delete goal.pausedAt;
    goal.continuation = { state: "idle", revision: goal.revision + 1 };
    return this.commitGoal(s, goal);
  }

  scheduleGoalContinuation(s: ChatSession, goalId: string, expectedRevision?: number): SessionGoal {
    const current = this.currentGoal(s, goalId, expectedRevision);
    if (current.status !== "active" || !current.autoContinue || !current.source || !current.nextStep || current.waiting) throw new Error("GOAL 不满足自动续轮条件");
    if (goalBudgetExhausted(current)) return this.pauseGoal(s, goalId, { kind: "budget", reason: "GOAL 总轮数或 token 预算已耗尽" });
    if (current.continuation.state === "running" || current.continuation.runId) throw new Error("GOAL 已有运行中的轮次");
    if (current.continuation.state === "scheduled") return current;
    const goal = structuredClone(current);
    goal.continuation = { state: "scheduled", revision: goal.revision + 1, scheduledAt: nowIso() };
    return this.commitGoal(s, goal);
  }

  beginGoalRun(s: ChatSession, binding: GoalRunBinding): SessionGoal {
    const current = this.currentGoal(s, binding.goalId);
    if (!/^[\w.:-]{1,160}$/.test(binding.runId) || ["__proto__", "constructor", "prototype"].includes(binding.runId)) throw new Error("GOAL runId 无效");
    if (current.status !== "active") throw new Error("GOAL 当前未激活");
    if (current.continuation.runId === binding.runId) return current;
    if (current.continuation.runId || current.continuation.state === "running") throw new Error("GOAL 已被其他轮次领取");
    if (Object.hasOwn(current.runUsage, binding.runId)) throw new Error("GOAL runId 不能重复使用");
    if (goalBudgetExhausted(current)) {
      this.pauseGoal(s, binding.goalId, { kind: "budget", reason: "GOAL 总轮数或 token 预算已耗尽" });
      throw new Error("GOAL 总预算已耗尽");
    }
    if (binding.automatic && (!current.autoContinue || !current.source || current.waiting || !current.nextStep
      || current.continuation.state !== "scheduled" || current.continuation.revision !== binding.scheduleRevision)) throw new Error("GOAL 自动续轮 ticket 已失效");
    const goal = structuredClone(current);
    goal.usage.roundsStarted++;
    goal.runUsage[binding.runId] = { totalTokens: 0 };
    goal.continuation = { state: "running", revision: goal.revision + 1, runId: binding.runId };
    return this.commitGoal(s, goal);
  }

  recordGoalUsage(s: ChatSession, report: { goalId: string; runId: string; totalTokens: number }): SessionGoal {
    const current = this.currentGoal(s, report.goalId);
    if (!Object.hasOwn(current.runUsage, report.runId)) throw new Error("GOAL 用量不属于已绑定的运行");
    if (!Number.isSafeInteger(report.totalTokens) || report.totalTokens < 0) throw new Error("GOAL token 用量无效");
    const previous = current.runUsage[report.runId]!.totalTokens;
    if (report.totalTokens <= previous) return current;
    const goal = structuredClone(current);
    goal.runUsage[report.runId]!.totalTokens = report.totalTokens;
    goal.usage.totalTokens = Math.min(Number.MAX_SAFE_INTEGER, goal.usage.totalTokens + report.totalTokens - previous);
    if (goal.status === "active" && goal.budget.maxTokens !== null && goal.usage.totalTokens >= goal.budget.maxTokens) {
      goal.status = "paused"; goal.pausedAt = nowIso(); goal.waiting = { kind: "budget", reason: "GOAL 总 token 预算已耗尽" };
      if (!goal.continuation.runId) goal.continuation = { state: "idle", revision: goal.revision + 1 };
    }
    return this.commitGoal(s, goal);
  }

  finishGoalRun(s: ChatSession, report: GoalRunFinish): SessionGoal {
    const current = this.currentGoal(s, report.goalId);
    const prior = Object.hasOwn(current.runUsage, report.runId) ? current.runUsage[report.runId] : undefined;
    if (!prior) throw new Error("GOAL 收尾不属于已绑定的运行");
    if (prior.outcome) return current;
    if (current.continuation.runId !== report.runId) throw new Error("GOAL 收尾 runId 已失效");
    if (!["answered", "interrupted", "error"].includes(report.outcome)) throw new Error("GOAL outcome 无效");
    const goal = structuredClone(current);
    const update = report.update;
    const verification = normalizeGoalVerification(update?.verification);
    if (verification && (verification.requirement !== goal.verificationRequirement
      || verification.evidence.some((item) => item.runId && item.runId !== report.runId))) throw new Error("GOAL 验收证据不属于当前运行或要求");
    if (current.status === "active" && report.outcome === "answered" && update?.status === "completed"
      && (!verification || !goalCompletionVerified(goal, verification))) throw new Error("GOAL 完成声明缺少所要求的验收证据");
    goal.runUsage[report.runId]!.outcome = report.outcome;
    if (report.outcome === "answered") goal.usage.roundsCompleted++;
    goal.continuation = { state: "idle", revision: goal.revision + 1 };
    // Pause/cancel/terminal decisions made while the run was in flight always win over its late reply.
    if (current.status === "active") {
      if (report.outcome !== "answered") {
        goal.status = "paused"; goal.pausedAt = nowIso(); goal.waiting = { kind: report.outcome === "error" ? "error" : "interrupted", reason: "GOAL 本轮未正常结束；请核对 checkpoint 后明确恢复" };
      } else {
        if (update?.progress !== undefined) goal.progress = goalText(update.progress, 2000);
        if (update?.nextStep !== undefined) goal.nextStep = normalizeGoalNextStep(update.nextStep);
        if (update?.waiting !== undefined) goal.waiting = normalizeGoalWaiting(update.waiting);
        if (verification) goal.verification = verification;
        if (update?.status) goal.status = update.status;
        if (goal.status === "completed") { goal.completedAt = nowIso(); delete goal.waiting; }
        else if (goalBudgetExhausted(goal)) { goal.status = "paused"; goal.pausedAt = nowIso(); goal.waiting = { kind: "budget", reason: "GOAL 总轮数或 token 预算已耗尽" }; }
      }
    }
    return this.commitGoal(s, goal);
  }

  /** 开始一条全新可恢复运行；若旧 checkpoint 未恢复而用户发了新任务，则由新任务显式取代。 */
  startCheckpoint(
    s: ChatSession,
    input: {
      agentName: string;
      originalInput: string;
      cowork?: CoworkTarget;
      taskType?: string;
      modelRef?: string;
      permissionMode?: AgentPermissionMode;
      reasoningEffort?: ReasoningEffort;
      pinnedSkill?: string;
      attachments?: Attachment[];
      actor?: ActorIdentity;
    }
  ): RunCheckpoint {
    if (s.checkpoint) this.refreshInterruptedEvidence(s, s.checkpoint, true);
    const now = nowIso();
    const checkpoint: RunCheckpoint = {
      version: 1,
      id: `cp-${randomUUID().slice(0, 8)}`,
      status: "running",
      agentName: input.agentName,
      originalInput: input.originalInput,
      ...(input.cowork ? { cowork: { ...input.cowork } } : {}),
      ...(input.taskType ? { taskType: input.taskType } : {}),
      ...(input.modelRef ? { modelRef: input.modelRef } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.pinnedSkill ? { pinnedSkill: input.pinnedSkill } : {}),
      ...(input.attachments?.length ? { attachments: cloneAttachments(input.attachments) } : {}),
      ...(input.actor ? { actor: cloneActor(input.actor) } : {}),
      tools: [],
      resumeCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    s.checkpoint = checkpoint;
    s.updatedAt = now;
    this.persist(s);
    this.logger.info({ sessionId: s.id, checkpointId: checkpoint.id, agent: input.agentName }, "checkpoint:start");
    return checkpoint;
  }

  /** 把 interrupted checkpoint 切回 running；已完成工具仍保留，交给执行控制器逐个回放。 */
  resumeCheckpoint(s: ChatSession, resumeInput: string): RunCheckpoint {
    const checkpoint = s.checkpoint;
    if (!checkpoint || checkpoint.status !== "interrupted") throw new Error("当前会话没有可恢复的 checkpoint");
    this.refreshInterruptedEvidence(s, checkpoint, true);
    const now = nowIso();
    checkpoint.status = "running";
    checkpoint.resumeCount += 1;
    checkpoint.latestResumeInput = resumeInput;
    checkpoint.updatedAt = now;
    delete checkpoint.interruptedAt;
    delete checkpoint.reason;
    // 上次若在进程被强制杀掉前没来得及收尾，running 也一律视为首个未完成步骤，不能回放。
    for (const call of checkpoint.tools) if (call.status === "running") call.status = "interrupted";
    s.updatedAt = now;
    this.persist(s);
    this.logger.info(
      { sessionId: s.id, checkpointId: checkpoint.id, resumeCount: checkpoint.resumeCount },
      "checkpoint:resume"
    );
    return checkpoint;
  }

  /** 停止或运行错误：保留 checkpoint，并把仍在跑的工具标成未完成。 */
  interruptCheckpoint(s: ChatSession, reason: string): RunCheckpoint | undefined {
    const checkpoint = s.checkpoint;
    if (!checkpoint) return undefined;
    const now = nowIso();
    checkpoint.status = "interrupted";
    checkpoint.interruptedAt = now;
    checkpoint.updatedAt = now;
    checkpoint.reason = reason;
    for (const call of checkpoint.tools) if (call.status === "running") call.status = "interrupted";
    s.updatedAt = now;
    this.persist(s);
    this.logger.info(
      {
        sessionId: s.id,
        checkpointId: checkpoint.id,
        completed: checkpoint.tools.filter((c) => c.status === "completed").length,
        pending: checkpoint.tools.filter((c) => c.status !== "completed").length,
        reason,
      },
      "checkpoint:interrupted"
    );
    return checkpoint;
  }

  /** 一轮成功结束后 checkpoint 已无恢复价值，清掉以免“继续”误续旧任务。 */
  finishCheckpoint(s: ChatSession): void {
    if (!s.checkpoint) return;
    const checkpointId = s.checkpoint.id;
    this.refreshInterruptedEvidence(s, s.checkpoint, true);
    delete s.checkpoint;
    s.updatedAt = nowIso();
    this.persist(s);
    this.logger.info({ sessionId: s.id, checkpointId }, "checkpoint:complete");
  }

  /**
   * 用户明确放弃一条已经停止的任务。运行中的 checkpoint 不能直接删：必须先走正常
   * stop/interrupt，让正在执行的工具有机会收尾并落盘。放弃后同时清掉这轮展示计划，
   * 避免 UI 还挂着一个已经不可能继续的 todo。
   */
  discardCheckpoint(s: ChatSession): boolean {
    const checkpoint = s.checkpoint;
    if (!checkpoint) return false;
    if (checkpoint.status === "running") throw new Error("任务仍在运行，请先停止后再放弃断点");
    this.refreshInterruptedEvidence(s, checkpoint, true);
    delete s.checkpoint;
    delete s.plan;
    s.updatedAt = nowIso();
    this.persist(s);
    this.logger.info({ sessionId: s.id, checkpointId: checkpoint.id }, "checkpoint:discarded");
    return true;
  }

  /** checkpoint 的工具控制器每推进一个边界都调用它，保证停止前的最近一步尽快落盘。 */
  touchCheckpoint(s: ChatSession): void {
    if (!s.checkpoint) return;
    const now = nowIso();
    s.checkpoint.updatedAt = now;
    this.refreshInterruptedEvidence(s, s.checkpoint, false);
    s.updatedAt = now;
    this.persist(s);
  }

  /** 测试/优雅关闭时等待排队中的写盘完成。普通对话仍保持 fire-and-forget。 */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /** Autonomous dispatch barrier: unlike best-effort chat writes, errors reach the caller. */
  async flushSessionDurably(s: ChatSession): Promise<void> {
    if (this.sessions.get(s.id) !== s) throw new Error("会话不属于当前 SessionStore");
    const file = path.join(this.dir, `${s.id}.json`);
    const temporary = path.join(this.dir, `${s.id}.goal-${randomUUID()}.tmp`);
    const data = JSON.stringify(s, null, 2);
    const write = this.writeChain.then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      try {
        const handle = await fs.open(temporary, "wx");
        try { await handle.writeFile(data, "utf8"); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, file);
      } catch (error) {
        await fs.unlink(temporary).catch(() => {});
        throw error;
      }
    });
    this.writeChain = write.catch((error) => this.logger.warn({ sessionId: s.id, err: String(error) }, "sessionStore: GOAL durable write failed"));
    await write;
  }

  /**
   * 清理超过保留期的聊天附件。先在原消息位置写入可读占位符并移除附件引用，再删除
   * 没有被其它消息/checkpoint/回答链接引用的物理文件；同一哈希文件被多会话复用时不会误删。
   * retentionDays=0 表示关闭自动清理。
   */
  async cleanupExpiredAttachments(
    uploadDir: string,
    retentionDays: number,
    now = Date.now()
  ): Promise<AttachmentCleanupResult> {
    const days = Number.isFinite(retentionDays) ? Math.max(0, Math.floor(retentionDays)) : 30;
    const cutoffMs = now - days * 24 * 60 * 60 * 1000;
    const result: AttachmentCleanupResult = {
      retentionDays: days,
      cutoff: new Date(cutoffMs).toISOString(),
      sessionsChanged: 0,
      messagesChanged: 0,
      attachmentsExpired: 0,
      contentLinksExpired: 0,
      filesDeleted: 0,
      bytesFreed: 0,
      filesKeptByReference: 0,
      errors: 0,
    };
    if (days <= 0) return result;

    const root = path.resolve(uploadDir);
    const expiredPaths = new Set<string>();
    for (const session of this.sessions.values()) {
      let sessionChanged = false;
      if (session.compactedImages?.length) {
        const expired = session.compactedImages.filter(row => Date.parse(row.receivedAt) < cutoffMs);
        if (expired.length) {
          for (const row of expired) {
            const stored = attachmentStoragePath(row.attachment, root);
            if (stored) expiredPaths.add(stored);
          }
          session.compactedImages = session.compactedImages.filter(row => Date.parse(row.receivedAt) >= cutoffMs);
          result.attachmentsExpired += expired.length;
          sessionChanged = true;
        }
      }
      for (let index = 0; index < session.messages.length; index += 1) {
        const message = session.messages[index]!;
        const occurredAt = attachmentMessageTime(session, index);
        if (!occurredAt || occurredAt >= cutoffMs) continue;
        let messageChanged = false;
        if (message.attachments?.length) {
          const expired = message.attachments;
          for (const attachment of expired) {
            const stored = attachmentStoragePath(attachment, root);
            if (stored) expiredPaths.add(stored);
          }
          message.content = appendCleanupMarker(message.content, expired, days);
          delete message.attachments;
          result.attachmentsExpired += expired.length;
          messageChanged = true;
        }
        // assistant 回答里的 /uploads 链接没有 Attachment 元数据，也属于聊天附件。到期时
        // 把 markdown/裸链接原位换成占位符，否则它会作为文本引用永久阻止物理清理。
        const links = expireContentUploadLinks(message.content, root, days);
        if (links.count) {
          message.content = links.content;
          for (const stored of links.paths) expiredPaths.add(stored);
          result.contentLinksExpired += links.count;
          messageChanged = true;
        }
        if (messageChanged) {
          result.messagesChanged += 1;
          sessionChanged = true;
        }
      }
      if (sessionChanged) {
        result.sessionsChanged += 1;
        // 清理属于保留策略维护，不是一次新聊天：绝不更新 lastMessageAt/updatedAt 或打乱会话排序。
        this.persist(session);
      }
    }

    // 收集仍存活的显式附件与回答正文里的 /uploads/ 引用；后者避免删除 agent 曾回发的同一文件。
    const referenced = collectReferencedUploadPaths(this.sessions.values(), root);
    const candidates = new Set(expiredPaths);
    const inbound = path.join(root, "inbound");
    for (const file of await listOldFiles(inbound, cutoffMs)) candidates.add(file);
    for (const candidate of candidates) {
      const key = pathKey(candidate);
      if (referenced.has(key)) {
        result.filesKeptByReference += 1;
        continue;
      }
      if (!isInsideUploadRoot(candidate, root)) {
        result.errors += 1;
        continue;
      }
      try {
        const stat = await fs.stat(candidate);
        if (!stat.isFile()) continue;
        await fs.unlink(candidate);
        result.filesDeleted += 1;
        result.bytesFreed += stat.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.errors += 1;
      }
    }
    await this.flush();
    this.logger.info(result, "attachments:cleanup");
    return result;
  }

  async remove(id: string): Promise<void> {
    const pending = this.removals.get(id);
    if (pending) return pending; // Concurrent callers must await the same disk outcome.
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    if (this.active.get(s.key) === id) {
      // 活跃被删：退回该 key 下次新的一条（或清空）。
      const next = this.listForKey(s.key)[0];
      if (next) this.active.set(s.key, next.id);
      else this.active.delete(s.key);
      this.persistActive();
    }
    const removal = this.writeChain.then(async () => {
      try { await fs.unlink(path.join(this.dir, `${id}.json`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    });
    this.writeChain = removal.catch(() => {}); // Keep subsequent persistence usable.
    const commit = removal.catch(error => {
      this.sessions.set(id, s);
      // Do not overwrite another client's newer active selection on failure.
      if (!this.active.has(s.key)) this.active.set(s.key, id);
      this.persistActive();
      throw error;
    }).finally(() => this.removals.delete(id));
    this.removals.set(id, commit);
    return commit;
  }

  /** 把一轮对话（用户输入 + 最终回答）追加进 session 并落盘。 */
  appendTurn(
    s: ChatSession,
    userContent: string,
    assistantContent: string,
    attachmentNote?: string,
    actor?: ActorIdentity,
    attachments?: Attachment[],
    runRecord?: SessionRunRecord,
    fileChanges?: TurnFileChange[],
    fileChangeRunId?: string,
    calendarCards?: CalendarCard[],
  ): void {
    const titleSource = userContent || attachmentTitle(attachments);
    if ((s.title === "新会话" || !s.title) && titleSource) s.title = makeTitle(titleSource);
    const userText = attachmentNote ? `${userContent}${userContent ? "\n" : ""}${attachmentNote}` : userContent;
    s.messages.push({
      role: "user",
      content: userText,
      ...(actor ? { actor: cloneActor(actor) } : {}),
      ...(attachments?.length ? { attachments: cloneAttachments(attachments) } : {}),
    });
    const record = normalizeRunRecord(runRecord);
    const changes = normalizeFileChanges(fileChanges);
    s.messages.push({ role: "assistant", content: assistantContent, ...(record ? { runRecord: record } : {}),
      ...(normalizeCalendarCards(calendarCards).length ? { calendarCards: normalizeCalendarCards(calendarCards) } : {}),
      ...(changes.length ? { fileChanges: changes } : {}),
      ...(fileChangeRunId ? { fileChangeRunId: fileChangeRunId.slice(0, 160) } : {}),
    });
    // traces 与 messages 平行：这两个新槽先占位（null），trace 稍后由前端经 annotateLatest 填。
    if (!s.traces) s.traces = [];
    // 防御：若历史上 traces 落后于 messages，补齐到 messages.length-2 再 push 两个槽。
    while (s.traces.length < s.messages.length - 2) s.traces.push(null);
    s.traces.push(null, null);
    // times 同样与 messages 平行（同一套对齐不变量）：每条消息的时间，供聊天气泡显示。
    // 老会话没有这个数组，补齐时用 null 占位——显示层看到 null 就不显示时间，不猜。
    const at = nowIso();
    if (!s.times) s.times = [];
    while (s.times.length < s.messages.length - 2) s.times.push(null);
    s.times.push(at, at);
    // durations 也保持同一套平行数组不变量；真正时长在整轮（含 post-turn compact）结束后补入。
    if (!s.durations) s.durations = [];
    while (s.durations.length < s.messages.length - 2) s.durations.push(null);
    s.durations.push(null, null);
    s.lastMessageAt = at;
    if (assistantContent.trim() || changes.length || normalizeCalendarCards(calendarCards).length) {
      s.replyRevision = sessionReplyState(s).replyRevision + 1;
    }
    s.updatedAt = at;
    this.persist(s);
  }

  /** 某 checkpoint 是否已经把至少一次中断尝试写进了真正的会话历史。 */
  hasInterruptedAttempt(s: ChatSession, checkpointId: string): boolean {
    return s.messages.some((message) =>
      message.role === "assistant" && message.runRecord?.status === "interrupted"
      && message.runRecord.checkpointId === checkpointId
    );
  }

  /**
   * 中断/故障也必须是一轮可回看的聊天记录，而不是只留一个悬空 checkpoint。
   * attemptId（通常就是顶层 runId）保证同一恢复链多次失败各留一条，同时重入收尾不会重复追加。
   */
  appendInterruptedTurn(
    s: ChatSession,
    userContent: string,
    options: {
      checkpoint: RunCheckpoint;
      attemptId: string;
      reason: string;
      durationMs: number;
      startedAt?: string;
      attachmentNote?: string;
      actor?: ActorIdentity;
      attachments?: Attachment[];
      trace?: unknown[];
      evidence?: SessionRunRecord["evidence"];
      evidenceBaseline?: ExecutionEvidenceBaseline;
      fileChanges?: TurnFileChange[];
      calendarCards?: CalendarCard[];
    }
  ): number {
    // Register first so a duplicate/re-entrant terminal callback can still refresh the
    // existing record rather than permanently freezing its original unfinished view.
    if (options.evidenceBaseline) {
      const baseline = normalizeExecutionEvidenceBaseline(snapshotExecutionEvidenceBaseline(options.evidenceBaseline));
      if (baseline) {
        s.executionEvidenceBaselines = (s.executionEvidenceBaselines ?? []).filter((item) =>
          item.attemptId !== options.attemptId || item.checkpointId !== options.checkpoint.id
        );
        s.executionEvidenceBaselines.push({ attemptId: options.attemptId, checkpointId: options.checkpoint.id, baseline });
      }
    }
    const existing = s.messages.findIndex((message) =>
      message.role === "assistant" && message.runRecord?.attemptId === options.attemptId
    );
    if (existing >= 0) {
      const changes = normalizeFileChanges(options.fileChanges);
      if (changes.length) s.messages[existing]!.fileChanges = changes;
      const cards = normalizeCalendarCards(options.calendarCards);
      if (cards.length) s.messages[existing]!.calendarCards = cards;
      this.annotateInterruptedAttempt(s, options.attemptId, {
        reason: options.reason,
        durationMs: options.durationMs,
        trace: options.trace,
      });
      return existing;
    }

    const titleSource = userContent || attachmentTitle(options.attachments);
    if ((s.title === "新会话" || !s.title) && titleSource) s.title = makeTitle(titleSource);
    const userText = options.attachmentNote
      ? `${userContent}${userContent ? "\n" : ""}${options.attachmentNote}`
      : userContent;
    const endedAt = nowIso();
    const startedAt = options.startedAt && Number.isFinite(Date.parse(options.startedAt))
      ? options.startedAt
      : options.checkpoint.createdAt;
    const trace = Array.isArray(options.trace) ? options.trace.slice(-MAX_TRACE_EVENTS) : [];
    s.messages.push({
      role: "user",
      content: userText,
      ...(options.actor ? { actor: cloneActor(options.actor) } : {}),
      ...(options.attachments?.length ? { attachments: cloneAttachments(options.attachments) } : {}),
    });
    s.messages.push({
      role: "assistant",
      content: interruptedRecordContent(options.checkpoint, options.reason, options.durationMs, trace),
      ...(normalizeCalendarCards(options.calendarCards).length ? { calendarCards: normalizeCalendarCards(options.calendarCards) } : {}),
      ...(normalizeFileChanges(options.fileChanges).length ? { fileChanges: normalizeFileChanges(options.fileChanges) } : {}),
      fileChangeRunId: options.attemptId,
      runRecord: {
        status: "interrupted",
        attemptId: options.attemptId,
        checkpointId: options.checkpoint.id,
        reason: safeInterruptionReason(options.reason),
        evidence: options.evidence ?? projectExecutionEvidence(options.checkpoint),
      },
    });

    if (!s.traces) s.traces = [];
    while (s.traces.length < s.messages.length - 2) s.traces.push(null);
    s.traces.push(null, trace.length ? trace : null);
    if (!s.times) s.times = [];
    while (s.times.length < s.messages.length - 2) s.times.push(null);
    s.times.push(startedAt, endedAt);
    if (!s.durations) s.durations = [];
    while (s.durations.length < s.messages.length - 2) s.durations.push(null);
    s.durations.push(null, Math.max(0, Math.round(options.durationMs)));
    this.trimStoredTraceTurns(s);
    s.lastMessageAt = endedAt;
    s.replyRevision = sessionReplyState(s).replyRevision + 1;
    s.updatedAt = endedAt;
    this.persist(s);
    return s.messages.length - 1;
  }

  /** API/渠道层在拿到完整实时 Trace 后补写到对应中断 attempt，而不是误挂到“最后一轮”。 */
  annotateInterruptedAttempt(
    s: ChatSession,
    attemptId: string,
    patch: { trace?: unknown[]; durationMs?: number; reason?: string }
  ): void {
    if (s.checkpoint) this.refreshInterruptedEvidence(s, s.checkpoint, false);
    const index = s.messages.findIndex((message) =>
      message.role === "assistant" && message.runRecord?.attemptId === attemptId
    );
    if (index < 0) return;
    const message = s.messages[index]!;
    if (message.runRecord?.status !== "interrupted") return;
    const reason = patch.reason ?? message.runRecord.reason ?? "运行未完成";
    const durationMs = Number.isFinite(patch.durationMs)
      ? Math.max(0, Math.round(patch.durationMs!))
      : Math.max(0, Math.round(s.durations?.[index] ?? 0));
    const trace = Array.isArray(patch.trace)
      ? patch.trace.slice(-MAX_TRACE_EVENTS)
      : (Array.isArray(s.traces?.[index]) ? s.traces![index]!.slice(-MAX_TRACE_EVENTS) : []);
    message.runRecord!.reason = safeInterruptionReason(reason);
    message.content = interruptedRecordContent(
      s.checkpoint?.id === message.runRecord!.checkpointId ? s.checkpoint : undefined,
      reason,
      durationMs,
      trace
    );
    if (!s.traces) s.traces = [];
    while (s.traces.length < s.messages.length) s.traces.push(null);
    s.traces[index] = trace.length ? trace : null;
    if (!s.durations) s.durations = [];
    while (s.durations.length < s.messages.length) s.durations.push(null);
    s.durations[index] = durationMs;
    this.trimStoredTraceTurns(s);
    // Trace/耗时补写是展示态收尾，不伪造新的聊天活动时间或打乱会话排序。
    s.updatedAt = nowIso();
    this.persist(s);
  }

  /** Refresh only the interrupted attempts that own this exact checkpoint and baseline. */
  private refreshInterruptedEvidence(s: ChatSession, checkpoint: RunCheckpoint, freeze: boolean): void {
    const snapshots = s.executionEvidenceBaselines ?? [];
    const records = [
      ...s.messages.flatMap((message) => message.runRecord ? [message.runRecord] : []),
      ...(s.compactedRunRecords ?? []),
    ];
    for (const snapshot of snapshots) {
      if (snapshot.checkpointId !== checkpoint.id) continue;
      const baseline = executionEvidenceBaselineFromSnapshot(snapshot.baseline);
      if (!baseline) continue;
      const record = records.find((candidate) =>
        candidate.status === "interrupted"
        && candidate.attemptId === snapshot.attemptId
        && candidate.checkpointId === checkpoint.id
      );
      if (!record) continue;
      const traceId = record.evidence?.traceId;
      record.evidence = projectExecutionEvidence(checkpoint, baseline, traceId ? { traceId } : undefined);
      const messageIndex = s.messages.findIndex((message) => message.runRecord === record);
      if (messageIndex >= 0) {
        const durationMs = Math.max(0, Math.round(s.durations?.[messageIndex] ?? 0));
        const trace = Array.isArray(s.traces?.[messageIndex]) ? s.traces![messageIndex]!.slice(-MAX_TRACE_EVENTS) : [];
        s.messages[messageIndex]!.content = interruptedRecordContent(
          checkpoint,
          record.reason ?? "运行未完成",
          durationMs,
          trace,
        );
      }
    }
    if (freeze && snapshots.some((snapshot) => snapshot.checkpointId === checkpoint.id)) {
      const remaining = snapshots.filter((snapshot) => snapshot.checkpointId !== checkpoint.id);
      if (remaining.length) s.executionEvidenceBaselines = remaining;
      else delete s.executionEvidenceBaselines;
    }
  }

  private trimStoredTraceTurns(s: ChatSession): void {
    if (!s.traces) return;
    let kept = 0;
    for (let i = s.traces.length - 1; i >= 0; i--) {
      if (!s.traces[i]) continue;
      if (kept < MAX_TRACE_TURNS) kept++;
      else s.traces[i] = null;
    }
  }

  /** 历史短期 CDN 引用懒迁移为 Harbour 本地引用；只改附件元数据，不伪造聊天活动时间。 */
  replaceMessageAttachments(s: ChatSession, messageIndex: number, attachments: Attachment[]): void {
    const message = s.messages[messageIndex];
    if (!message || message.role !== "user") throw new Error("只能更新会话中的 user 附件");
    if (attachments.length) message.attachments = cloneAttachments(attachments);
    else delete message.attachments;
    this.persist(s);
  }

  /**
   * 给最近一轮附加展示数据：plan（覆盖）与 trace（写到最后一个 assistant 槽）。
   * 由 api 层在收到 plan:submitted / run 结束时调用；不影响 LLM 上下文。
   */
  annotateLatest(
    s: ChatSession,
    patch: { plan?: unknown; trace?: unknown[] | null; durationMs?: number; expectMsgCount?: number }
  ): void {
    if ("plan" in patch) s.plan = patch.plan ?? undefined;
    // 若调用方给了 expectMsgCount（本轮结束时前端看到的消息数），只有当前消息数仍相等才写 trace。
    // 不等 = 期间已有别的轮次落了新消息（多 tab 同 key 竞态），此时「最后 assistant」已不是本轮 →
    // 宁可不写，也不把 trace 挂到错误的消息上（对抗复查 M3）。
    const staleTurn = typeof patch.expectMsgCount === "number" && patch.expectMsgCount !== s.messages.length;
    let assistantIdx = -1;
    if (!staleTurn && ((patch.trace && patch.trace.length) || Number.isFinite(patch.durationMs))) {
      for (let i = s.messages.length - 1; i >= 0; i--) {
        if (s.messages[i]!.role === "assistant") { assistantIdx = i; break; }
      }
    }
    if (patch.trace && patch.trace.length && !staleTurn) {
      if (!s.traces) s.traces = [];
      while (s.traces.length < s.messages.length) s.traces.push(null);
      if (assistantIdx >= 0) s.traces[assistantIdx] = patch.trace.slice(-MAX_TRACE_EVENTS);
      // 只保留最近 MAX_TRACE_TURNS 个非空 trace，更早的置 null（保持与 messages 对齐、不占体积）。
      this.trimStoredTraceTurns(s);
    }
    if (Number.isFinite(patch.durationMs) && !staleTurn && assistantIdx >= 0) {
      if (!s.durations) s.durations = [];
      while (s.durations.length < s.messages.length) s.durations.push(null);
      s.durations[assistantIdx] = Math.max(0, Math.round(patch.durationMs!));
    }
    s.updatedAt = nowIso();
    this.persist(s);
  }

  /** 不改存储原文，只在模型副本中物化最近少量服务器运行事实。客户端 traces 始终仅供展示。 */
  toHistory(s: ChatSession): { history: Message[]; summary: string } {
    const materialized = modelHistory(s);
    return {
      history: materialized.history.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.actor ? { actor: cloneActor(m.actor) } : {}),
        ...(m.attachments?.length ? { attachments: cloneAttachments(m.attachments) } : {}),
      })),
      summary: materialized.summary,
    };
  }

  /** 应用一次压缩结果：替换摘要、丢掉最旧 dropCount 条。 */
  private applyCompaction(s: ChatSession, summary: string, dropCount: number): void {
    s.compactedImages = sessionImageReferences(s, dropCount);
    s.compactedRunRecords = recentExecutionRecords(s.messages.slice(0, dropCount), s.compactedRunRecords);
    s.summary = summary;
    s.messages = s.messages.slice(dropCount);
    // traces 与 messages 同前缀丢弃，保持严格对齐（否则切会话时 trace 会错位挂到别的消息上）。
    if (s.traces) s.traces = s.traces.slice(dropCount);
    if (s.times) s.times = s.times.slice(dropCount);   // times 同理，否则时间会错位挂到别的消息
    if (s.durations) s.durations = s.durations.slice(dropCount);
    s.compactions += 1;
    s.updatedAt = nowIso();
    this.persist(s);
  }

  /**
   * 若超阈值则压缩。返回是否发生了压缩。
   * 失败兜底：摘要调用失败也不抛——退化成「硬截断」（丢老消息、加一行说明），
   * 保证 session 不会无限膨胀，也绝不拖垮当前这轮回复。
   */
  async maybeCompact(
    s: ChatSession,
    deps: {
      agent: Agent;
      router: Router;
      /** 当前顶层 run 的关联 logger；缺省才退回 store 全局 logger。 */
      logger?: Logger;
      triggerTokens: number;
      keepRecent: number;
      keepRecentTokens?: number;
      /** 预检时把即将送入的 system + 当前输入算进触发判断，但它们不属于可压缩历史。 */
      additionalTokens?: number;
      /** 摘要模型的实际输入容量（已留输出余量）；不可沿用被压缩会话所选大模型的窗口。 */
      summaryContext?: { modelRef: string; contextLimit: number };
      /** Summary usage joins the same trusted run ledger, including streamed/failed attempts. */
      onUsage?: (usage: TokenUsageBuckets & { modelRef: string }) => void;
      /** 停止顶层运行时同步取消摘要；取消不提交部分摘要或降级截断。 */
      signal?: AbortSignal;
      /** 供应商已经报超窗时绕过阈值，主动再收紧一次。 */
      force?: boolean;
      reason?: "preflight" | "post-turn" | "overflow-retry";
    }
  ): Promise<{ compacted: boolean; before: number; after: number }> {
    deps.signal?.throwIfAborted();
    const before = bodyTokens(s);
    const projectedBefore = before + Math.max(0, deps.additionalTokens ?? 0);
    if ((!deps.force && projectedBefore < deps.triggerTokens) || s.messages.length === 0 || s.messages.length <= deps.keepRecent) {
      return { compacted: false, before, after: before };
    }
    // 近满才压：保留最近一段【按 token 计】的原文窗口（至少 keepRecent 条兜底），只把更早的收进摘要，
    // 减少信息损失。keepRecentTokens 缺省/为 0 时退化为老的「留 keepRecent 条」。
    const materialized = modelHistory(s);
    const keepCount = recentKeepCount(materialized.history, deps.keepRecentTokens ?? 0, deps.keepRecent);
    const dropCount = s.messages.length - keepCount;
    if (dropCount <= 0) return { compacted: false, before, after: before };
    // The summarizer consumes only saved conversation prose. Structured execution facts stay
    // deterministic in compactedRunRecords and are attached later by toHistory; the model must
    // never paraphrase a receipt into a less precise status.
    const dropped = s.messages.slice(0, dropCount).map((message): Message => ({
      role: message.role,
      content: message.role === "assistant" ? stripExecutionEvidenceCards(message.content) : message.content,
      ...(message.actor ? { actor: cloneActor(message.actor) } : {}),
      ...(message.attachments?.length ? { attachments: cloneAttachments(message.attachments) } : {}),
    }));
    const plainSummary = stripExecutionEvidenceCards(s.summary);
    try {
      const summarized = await summarize(deps.router, deps.agent, { channel: s.channel, key: s.key }, plainSummary, dropped, deps.summaryContext, deps.signal, deps.onUsage);
      deps.signal?.throwIfAborted();
      this.applyCompaction(s, summarized.text, dropCount);
      const after = bodyTokens(s);
      (deps.logger ?? this.logger).info(
        {
          agent: deps.agent.name,
          key: s.key,
          sessionId: s.id,
          before,
          after,
          projectedBefore,
          projectedAfter: after + Math.max(0, deps.additionalTokens ?? 0),
          dropped: dropCount,
          kept: keepCount,
          compactions: s.compactions,
          reason: deps.reason ?? "post-turn",
          summaryBatches: summarized.batches,
          summaryModelRef: summarized.modelRef,
          summaryContextLimit: summarized.contextLimit,
          summaryPreview: summarized.text.replace(/\s+/g, " ").slice(0, 120),
        },
        "loop:compact"
      );
      return { compacted: true, before, after };
    } catch (e) {
      deps.signal?.throwIfAborted();
      if (e instanceof Error && e.name === "AbortError") throw e;
      const fallback = fallbackCompactionSummary(plainSummary, dropped, dropCount);
      this.applyCompaction(s, fallback, dropCount);
      const after = bodyTokens(s);
      (deps.logger ?? this.logger).warn(
        {
          agent: deps.agent.name,
          key: s.key,
          sessionId: s.id,
          err: (e as Error).message,
          reason: deps.reason ?? "post-turn",
          before,
          after,
        },
        "loop:compact-fallback（摘要失败，已硬截断）"
      );
      return { compacted: true, before, after };
    }
  }

  private persist(s: ChatSession): void {
    const file = path.join(this.dir, `${s.id}.json`);
    const data = JSON.stringify(s, null, 2);
    const atomicGoal = !!s.goal;
    this.writeChain = this.writeChain
      .then(() => fs.mkdir(this.dir, { recursive: true }))
      .then(async () => {
        if (!atomicGoal) { await fs.writeFile(file, data, "utf8"); return; }
        // A checkpoint/usage write after a durable GOAL claim must not truncate
        // that claim in place: a crash would otherwise erase the recovery state.
        // Best-effort writes stay non-fsync; dispatch still requires its barrier.
        const temporary = path.join(this.dir, `${s.id}.goal-${randomUUID()}.tmp`);
        try {
          await fs.writeFile(temporary, data, { encoding: "utf8", flag: "wx" });
          await fs.rename(temporary, file);
        } catch (error) {
          await fs.unlink(temporary).catch(() => undefined);
          throw error; // Never fall back to truncating the live durable file.
        }
      })
      .catch((e) => this.logger.warn({ err: (e as Error).message, file }, "sessionStore: 写盘失败（已忽略）"));
  }

  private persistActive(): void {
    const file = path.join(this.dir, "_active.json");
    const data = JSON.stringify(Object.fromEntries(this.active), null, 2);
    this.writeChain = this.writeChain
      .then(() => fs.mkdir(this.dir, { recursive: true }))
      .then(() => fs.writeFile(file, data, "utf8"))
      .catch(() => {});
  }
}

/** 向后兼容/防御：补齐缺字段。 */
function normalize(s: ChatSession, defaultAgent: string): ChatSession {
  const permissionMode = normalizeAgentPermissionMode(s.permissionMode);
  const reasoningEffort = normalizeReasoningEffort(s.reasoningEffort);
  const checkpoint = normalizeCheckpoint(s.checkpoint);
  const goal = normalizeSessionGoal(s.goal);
  const pinnedSkill = typeof s.pinnedSkill === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.pinnedSkill.trim())
    ? s.pinnedSkill.trim()
    : undefined;
  const messages: Message[] = Array.isArray(s.messages)
    ? s.messages
        .filter((m) => m && (m.role === "user" || m.role === "assistant"))
        .map((m) => {
          const actor = m.role === "user" ? normalizeActor(m.actor) : undefined;
          const runRecord = m.role === "assistant" ? normalizeRunRecord(m.runRecord) : undefined;
          const fileChanges = m.role === "assistant" ? normalizeFileChanges(m.fileChanges) : [];
          const calendarCards = m.role === "assistant" ? normalizeCalendarCards(m.calendarCards) : [];
          return {
            role: m.role,
            content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
            ...(actor ? { actor } : {}),
            ...(runRecord ? { runRecord } : {}),
            ...(fileChanges.length ? { fileChanges } : {}),
            ...(calendarCards.length ? { calendarCards } : {}),
            ...(m.role === "assistant" && typeof m.fileChangeRunId === "string" && m.fileChangeRunId.length <= 160
              ? { fileChangeRunId: m.fileChangeRunId } : {}),
            ...(m.role === "user" && Array.isArray(m.attachments) && m.attachments.length
              ? { attachments: normalizeAttachments(m.attachments) }
              : {}),
          };
        })
    : [];
  const times = Array.isArray(s.times) && s.times.length === messages.length ? s.times : undefined;
  const durations = Array.isArray(s.durations) && s.durations.length === messages.length
    ? s.durations.map((value, index) => messages[index]?.role === "assistant" && typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.round(value)
      : null)
    : undefined;
  const executionEvidenceBaselines = checkpoint && Array.isArray(s.executionEvidenceBaselines)
    ? s.executionEvidenceBaselines.slice(-8).flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const item = value as Partial<NonNullable<ChatSession["executionEvidenceBaselines"]>[number]>;
        if (typeof item.attemptId !== "string" || !item.attemptId || item.attemptId.length > 160) return [];
        if (item.checkpointId !== checkpoint.id) return [];
        const baseline = normalizeExecutionEvidenceBaseline(item.baseline);
        return baseline ? [{ attemptId: item.attemptId, checkpointId: checkpoint.id, baseline }] : [];
      })
    : [];
  let inferredLastMessageAt = typeof s.lastMessageAt === "string" && s.lastMessageAt ? s.lastMessageAt : undefined;
  if (!inferredLastMessageAt && times) {
    for (let i = times.length - 1; i >= 0; i--) {
      if (times[i]) { inferredLastMessageAt = times[i]!; break; }
    }
  }
  // 更老的 session 没有 times，只能以旧 updatedAt 做一次迁移推断；之后所有新消息都会写真值。
  if (!inferredLastMessageAt && messages.length) inferredLastMessageAt = s.updatedAt ?? s.createdAt ?? nowIso();
  return {
    id: s.id,
    key: s.key,
    channel: s.channel ?? "web",
    ...(s.origin && typeof s.origin === "object" ? { origin: { ...s.origin } } : {}),
    agentName: s.agentName ?? defaultAgent,
    title: s.title ?? "新会话",
    summary: s.summary ?? "",
    ...(s.nativeContext && Number.isSafeInteger(s.nativeContext.tokens) && s.nativeContext.tokens >= 0 &&
      typeof s.nativeContext.modelRef === "string" && s.nativeContext.modelRef.length <= 200 &&
      typeof s.nativeContext.agentName === "string" && s.nativeContext.agentName.length <= 160 &&
      typeof s.nativeContext.observedAt === "string" && Number.isFinite(Date.parse(s.nativeContext.observedAt))
      ? { nativeContext: { ...s.nativeContext } } : {}),
    messages,
    ...(Array.isArray(s.compactedImages) ? { compactedImages: normalizeSessionImages(s.compactedImages) } : {}),
    ...(Array.isArray(s.compactedRunRecords) ? {
      compactedRunRecords: recentExecutionRecords([], s.compactedRunRecords.flatMap((raw) => {
        const record = normalizeRunRecord(raw);
        return record ? [record] : [];
      })),
    } : {}),
    ...(executionEvidenceBaselines.length ? { executionEvidenceBaselines } : {}),
    compactions: s.compactions ?? 0,
    createdAt: s.createdAt ?? nowIso(),
    updatedAt: s.updatedAt ?? s.createdAt ?? nowIso(),
    ...(inferredLastMessageAt ? { lastMessageAt: inferredLastMessageAt } : {}),
    replyRevision: sessionReplyState(s).replyRevision,
    readReplyRevision: sessionReplyState(s).readReplyRevision,
    ...(typeof s.modelRef === "string" && s.modelRef.trim() ? { modelRef: s.modelRef.trim() } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(s.cowork ? { cowork: normalizeCoworkTarget(s.cowork) } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(pinnedSkill ? { pinnedSkill } : {}),
    // 展示态字段：plan 直接带上；traces 只在长度与 messages 一致时保留，
    // 不一致（旧文件 / 手改脏了）就丢掉，宁可不显示也不错位。
    ...(s.plan !== undefined ? { plan: s.plan } : {}),
    ...(times ? { times } : {}),
    ...(durations ? { durations } : {}),
    ...(Array.isArray(s.traces) && s.traces.length === messages.length
      ? { traces: s.traces }
      : {}),
    ...(checkpoint ? { checkpoint } : {}),
    ...(goal ? { goal } : {}),
  };
}

function cloneAttachments(attachments: Attachment[]): Attachment[] {
  return attachments.map((attachment) => ({
    ...attachment,
    ...(attachment.image ? { image: { ...attachment.image } } : {}),
    ...(attachment.transcription ? { transcription: { ...attachment.transcription } } : {}),
  }));
}

function normalizeAttachments(value: unknown[]): Attachment[] {
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Partial<Attachment>;
    if (raw.kind !== "image" && raw.kind !== "video" && raw.kind !== "audio" && raw.kind !== "file") return [];
    if (typeof raw.url !== "string" || !raw.url || typeof raw.mime !== "string" || typeof raw.name !== "string") return [];
    const image = raw.kind === "image" && raw.image && typeof raw.image === "object"
      && Number.isFinite(raw.image.width) && Number.isFinite(raw.image.height)
      && typeof raw.image.sha256 === "string"
      ? {
          width: Math.max(1, Math.round(raw.image.width)),
          height: Math.max(1, Math.round(raw.image.height)),
          sha256: raw.image.sha256.slice(0, 128),
          ...(raw.image.normalized ? { normalized: true } : {}),
        }
      : undefined;
    return [{
      kind: raw.kind,
      url: raw.url,
      ...(typeof raw.path === "string" && raw.path ? { path: raw.path } : {}),
      mime: raw.mime,
      name: raw.name,
      ...(typeof raw.size === "number" && Number.isFinite(raw.size) && raw.size >= 0 ? { size: raw.size } : {}),
      ...(typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs) && raw.durationMs > 0 ? { durationMs: raw.durationMs } : {}),
      ...(image ? { image } : {}),
      ...(raw.transcription ? { transcription: { ...raw.transcription } } : {}),
    } satisfies Attachment];
  });
}

function attachmentTitle(attachments?: Attachment[]): string {
  if (!attachments?.length) return "";
  const images = attachments.filter((attachment) => attachment.kind === "image");
  if (images.length) return images.length === 1 ? `图片 · ${images[0]!.name}` : `${images.length} 张图片`;
  const audio = attachments.filter((attachment) => attachment.kind === "audio");
  if (audio.length) return audio.length === 1 ? "语音消息" : `${audio.length} 条语音`;
  const videos = attachments.filter((attachment) => attachment.kind === "video");
  if (videos.length) return videos.length === 1 ? `视频 · ${videos[0]!.name}` : `${videos.length} 个视频`;
  return attachments.length === 1 ? `附件 · ${attachments[0]!.name}` : `${attachments.length} 个附件`;
}

function attachmentMessageTime(session: ChatSession, index: number): number | undefined {
  // 新会话有逐消息 times。老会话没有时用最后活动时间保守处理：宁可晚清，也不把一条
  // 刚在旧会话中产生、但缺迁移时间的附件过早删除。
  const raw = session.times?.[index] || session.lastMessageAt || session.updatedAt || session.createdAt;
  const value = Date.parse(String(raw || ""));
  return Number.isFinite(value) ? value : undefined;
}

function appendCleanupMarker(content: string, attachments: Attachment[], retentionDays: number): string {
  const details = attachments.map((attachment) => {
    const icon = attachment.kind === "image" ? "🖼"
      : attachment.kind === "video" ? "🎬"
        : attachment.kind === "audio" ? "🎵" : "📄";
    const size = formatBytes(attachment.size);
    return `${icon} ${attachment.name}${size ? ` · ${size}` : ""}`;
  }).join("；");
  const marker = `[附件已按 ${retentionDays} 天保留策略清理：${details}]`;
  return [String(content || "").trimEnd(), marker].filter(Boolean).join("\n");
}

function expireContentUploadLinks(
  content: string,
  root: string,
  retentionDays: number
): { content: string; paths: Set<string>; count: number } {
  let next = String(content || "");
  const paths = new Set<string>();
  let count = 0;
  const replaceUrl = (rawUrl: string): string | undefined => {
    const stored = uploadUrlPath(rawUrl, root);
    if (!stored) return undefined;
    const key = pathKey(stored);
    if (!paths.has(key)) {
      paths.add(key);
      count += 1;
    }
    let name = path.basename(stored);
    try { name = decodeURIComponent(name); } catch { /* 保留安全文件名 */ }
    return `[附件已按 ${retentionDays} 天保留策略清理：${name}]`;
  };
  next = next.replace(/!?\[[^\]]*\]\((\/uploads\/[^\s)]+)\)/g, (whole, url: string) => replaceUrl(url) ?? whole);
  next = next.replace(/\/uploads\/[^\s)<>'\"]+/g, (url) => replaceUrl(url) ?? url);
  return { content: next, paths, count };
}

function formatBytes(value: number | undefined): string {
  if (!Number.isFinite(value) || Number(value) < 0) return "";
  const bytes = Number(value);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 100 * 1024 ? 0 : 1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function attachmentStoragePath(attachment: Attachment, root: string): string | undefined {
  let candidate = "";
  if (attachment.url.startsWith("/uploads/")) {
    try {
      candidate = path.resolve(root, decodeURIComponent(attachment.url.slice("/uploads/".length)));
    } catch {
      return undefined;
    }
  } else if (attachment.path) {
    candidate = path.resolve(attachment.path);
  }
  return candidate && isInsideUploadRoot(candidate, root) ? candidate : undefined;
}

function uploadUrlPath(rawUrl: string, root: string): string | undefined {
  const withoutQuery = rawUrl.split(/[?#]/, 1)[0] || "";
  if (!withoutQuery.startsWith("/uploads/")) return undefined;
  try {
    const candidate = path.resolve(root, decodeURIComponent(withoutQuery.slice("/uploads/".length)));
    return isInsideUploadRoot(candidate, root) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function collectReferencedUploadPaths(sessions: Iterable<ChatSession>, root: string): Set<string> {
  const refs = new Set<string>();
  for (const session of sessions) {
    for (const row of session.compactedImages ?? []) {
      const stored = attachmentStoragePath(row.attachment, root);
      if (stored) refs.add(pathKey(stored));
    }
    for (const message of session.messages) {
      for (const attachment of message.attachments ?? []) {
        const stored = attachmentStoragePath(attachment, root);
        if (stored) refs.add(pathKey(stored));
      }
      for (const match of String(message.content || "").matchAll(/\/uploads\/([^\s)\]>'\"]+)/g)) {
        const candidate = uploadUrlPath(`/uploads/${match[1]!}`, root);
        if (candidate) refs.add(pathKey(candidate));
      }
    }
    for (const attachment of session.checkpoint?.attachments ?? []) {
      const stored = attachmentStoragePath(attachment, root);
      if (stored) refs.add(pathKey(stored));
    }
  }
  return refs;
}

async function listOldFiles(root: string, cutoffMs: number): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) {
        const stat = await fs.stat(target).catch(() => null);
        if (stat && stat.mtimeMs < cutoffMs) files.push(target);
      }
    }
  };
  await walk(root);
  return files;
}

function isInsideUploadRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function cloneActor(actor: ActorIdentity): ActorIdentity {
  return { ...actor };
}

/** Unknown/legacy failures never gain non-execution proof merely by reloading. */
function normalizeCheckpointRejection(call: CheckpointToolCall): CheckpointToolRejection | undefined {
  const rejection = call.rejection;
  if (call.kind !== "harbour" || call.tool !== "run_workflow" || call.status !== "failed"
    || call.remote || call.recovery || !rejection || rejection.outcome !== "not_started"
    || rejection.source !== "workflow_input_validation" || typeof rejection.code !== "string"
    || typeof rejection.message !== "string" || !Array.isArray(rejection.nextActions)
    || (rejection.jobId !== undefined && typeof rejection.jobId !== "string")) return;
  if (Buffer.byteLength(JSON.stringify(rejection), "utf8") > 256 * 1024) return;
  const details = normalizeWorkflowValidationDetails(rejection.details);
  return { outcome: "not_started", source: "workflow_input_validation", code: rejection.code,
    message: rejection.message, nextActions: rejection.nextActions,
    ...(rejection.jobId !== undefined ? { jobId: rejection.jobId } : {}),
    // Optional diagnostics never confer non-execution proof; malformed metadata
    // is omitted without changing the independently validated safety boundary.
    ...(details !== undefined ? { details } : {}) };
}

/** 坏/旧 checkpoint 不能影响整个 session 加载；最少字段不成立就安全丢弃。 */
function normalizeCheckpoint(value: unknown): RunCheckpoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const cp = value as Partial<RunCheckpoint>;
  if (cp.version !== 1 || !cp.id || !cp.agentName || typeof cp.originalInput !== "string") return undefined;
  // 从磁盘加载说明进程边界已经跨过：即便落盘时还是 running，也必须降级成可恢复的 interrupted。
  const status: CheckpointStatus = "interrupted";
  const actor = normalizeActor(cp.actor);
  const tools: CheckpointToolCall[] = Array.isArray(cp.tools)
    ? cp.tools.filter((c): c is CheckpointToolCall => !!c && typeof c === "object" && !!c.id && !!c.tool && !!c.agent)
        .map((c, i) => ({
          ...c,
          sequence: Number.isFinite(c.sequence) ? c.sequence : i + 1,
          args: c.args && typeof c.args === "object" ? c.args : {},
          kind: c.kind === "external-mcp" || c.kind === "codex-native" ? c.kind : "harbour",
          status: c.status === "completed" || c.status === "failed" || c.status === "interrupted" ? c.status : "interrupted",
          replayable: c.replayable === true && c.status === "completed",
          rejection: normalizeCheckpointRejection(c),
          startedAt: c.startedAt || cp.createdAt || nowIso(),
        }))
    : [];
  return {
    version: 1,
    id: cp.id,
    status,
    agentName: cp.agentName,
    originalInput: cp.originalInput,
    ...(cp.taskType ? { taskType: cp.taskType } : {}),
    ...(cp.modelRef ? { modelRef: cp.modelRef } : {}),
    ...(cp.cowork ? { cowork: normalizeCoworkTarget(cp.cowork) } : {}),
    ...(normalizeAgentPermissionMode(cp.permissionMode) ? { permissionMode: normalizeAgentPermissionMode(cp.permissionMode)! } : {}),
    ...(normalizeReasoningEffort(cp.reasoningEffort) ? { reasoningEffort: normalizeReasoningEffort(cp.reasoningEffort)! } : {}),
    ...(typeof cp.pinnedSkill === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cp.pinnedSkill.trim())
      ? { pinnedSkill: cp.pinnedSkill.trim() }
      : {}),
    ...(Array.isArray(cp.attachments) ? { attachments: cloneAttachments(cp.attachments) } : {}),
    ...(actor ? { actor } : {}),
    tools,
    resumeCount: Number.isFinite(cp.resumeCount) ? Math.max(0, Number(cp.resumeCount)) : 0,
    createdAt: cp.createdAt || nowIso(),
    updatedAt: cp.updatedAt || cp.createdAt || nowIso(),
    interruptedAt: cp.interruptedAt || cp.updatedAt || nowIso(),
    reason: cp.reason || "进程重启前运行未完成",
    ...(cp.latestResumeInput ? { latestResumeInput: cp.latestResumeInput } : {}),
  };
}

/**
 * 压缩：把【被移出窗口的历史原文】合并进滚动摘要。
 *
 * 复用 buildChatMessages 的稳定 system/来源装配；摘要模型与聊天模型相同时可受益于共同缓存前缀，
 * 但不能假设 classify 总是同一模型/窗口。按摘要模型的实际容量顺序分批，连单条超长消息也分片，
 * 每批合并前一批的有界摘要；不向小模型一次发送大模型的全部历史。末尾追加结构化整理指令。
 */
async function summarize(
  router: Router,
  agent: Agent,
  source: { channel: string; key?: string },
  prevSummary: string,
  dropped: Message[],
  summaryContext?: { modelRef: string; contextLimit: number },
  signal?: AbortSignal,
  onUsage?: (usage: TokenUsageBuckets & { modelRef: string }) => void,
): Promise<{ text: string; batches: number; modelRef: string; contextLimit: number }> {
  signal?.throwIfAborted();
  const modelRef = summaryContext?.modelRef ?? router.pick(agent, "classify");
  const contextLimit = summaryContext?.contextLimit ?? Math.floor(contextWindowForModel(modelRef) * 0.95);
  if (!Number.isFinite(contextLimit) || contextLimit < 1) throw new Error("摘要模型输入容量无效");
  const summaryBudget = Math.max(1, Math.min(4000, Math.floor(contextLimit * 0.2)));
  // 结构参考 Claude Code/Agent SDK compaction 的 preserve 思路，但摘要生成、落盘、触发与重试
  // 仍完全由 Harbour 管。结构化栏目比一段自由散文更适合恢复工程任务，也更容易滚动合并。
  const instruction = [
    "【系统指令·最高优先级，压过人格与角色扮演】只整理前面的会话为可供后续继续工作的持久上下文。",
    "只写确有内容的栏目，使用以下固定顺序：",
    "## 当前目标与验收标准",
    "## 用户信息、偏好与硬约束",
    "## 已确认事实与关键上下文",
    "## 决策及理由",
    "## 当前进度与已完成工作",
    "## 文件、代码、命令与外部标识",
    "## 测试、错误与结果",
    "## 未完成事项与下一步",
    "保留精确的文件路径、函数/类型名、命令、数字 ID、错误文本、测试结论和未解决分歧；明确区分已完成、失败、待办与推测。",
    "合并已有持久上下文与新会话事实，去重；最新明确指示覆盖更早冲突指示。不要补写未发生的事实，也不要保留寒暄、重复过程或无用日志。",
    "安全要求：绝不复写 token、API key、密码、cookie 等凭据原文，只记录“已配置/已更新”并写 [敏感凭据已省略]。",
    "历史可能按顺序分成连续片段；把已有摘要与本批事实合并，不得把分批当成新的用户要求。",
    `控制在 ${Math.min(2500, summaryBudget)} 个中文字符左右。直接从第一个 ## 栏目开始，不加称呼、开场、结尾、emoji、角色口吻或任何关于本次整理操作的元话语。`,
  ].join("\n");
  // 图片已经由当轮 assistant 以文字回答过；压缩只整理文本事实，不重复把历史像素送进
  // classify 模型（省视觉 token，也避免文本摘要 fallback 因 image block 失败）。
  const textHistory = dropped.map((message): Message => ({ role: message.role, content: message.content, ...(message.actor ? { actor: message.actor } : {}) }));
  let rollingSummary = prevSummary;
  let batch: Message[] = [];
  let batches = 0;
  const messagesFor = (history: Message[]) => buildChatMessages(agent, { source, summary: rollingSummary, history, input: instruction });
  const fits = (history: Message[]) => estimateRequestTokens(messagesFor(history), []) <= contextLimit;
  // 旧摘要也可能来自更大窗口；将其完整作为第一批素材，不直接截断既有事实。
  if (estimateTextTokens(rollingSummary) > summaryBudget) {
    textHistory.unshift({ role: "user", content: `此前滚动摘要（继续合并保留其中有效事实）：\n${rollingSummary}` });
    rollingSummary = "";
  }
  if (!fits([])) throw new Error("摘要模型窗口无法容纳固定 system 与整理指令");
  const flush = async () => {
    signal?.throwIfAborted();
    if (!batch.length) return;
    const messages = messagesFor(batch);
    if (estimateRequestTokens(messages, []) > contextLimit) throw new Error("摘要批次超过当前摘要模型输入容量");
    const res = await router.complete({ modelRef, agentName: agent.name, messages, tools: [], signal, onUsage });
    if (res.usage && !res.usageReported) onUsage?.({ ...res.usage, modelRef: res.servedBy ?? modelRef });
    signal?.throwIfAborted();
    const text = (res.message.content ?? "").trim();
    if (!text) throw new Error("摘要结果为空");
    const cleaned = cleanSummary(text);
    if (!cleaned) throw new Error("摘要结果清洗后为空");
    if (estimateTextTokens(cleaned) > summaryBudget) throw new Error("摘要输出超出分批合并的保留预算");
    rollingSummary = cleaned;
    batch = [];
    batches++;
  };
  for (const original of textHistory) {
    signal?.throwIfAborted();
    let content = original.content;
    do {
      const message = { ...original, content };
      if (fits([...batch, message])) {
        batch.push(message);
        break;
      }
      if (batch.length) {
        await flush();
        continue;
      }
      // 单条用户消息也可能比 classify 窗口大；按真实装配估算找最大前缀，顺序消费、不丢尾部。
      let low = 0;
      let high = Math.min(content.length, Math.ceil(contextLimit * 4));
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits([{ ...original, content: content.slice(0, middle) }])) low = middle;
        else high = middle - 1;
      }
      if (low > 0 && low < content.length && /[\uD800-\uDBFF]/.test(content[low - 1]!) && /[\uDC00-\uDFFF]/.test(content[low]!)) low--;
      if (low <= 0) throw new Error("摘要模型窗口没有足够空间容纳历史片段");
      batch.push({ ...original, content: content.slice(0, low) });
      content = content.slice(low);
      await flush();
    } while (content.length);
  }
  await flush();
  return { text: rollingSummary, batches, modelRef, contextLimit };
}

function normalizeActor(value: unknown): ActorIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const actor = value as Partial<ActorIdentity>;
  if (actor.role !== "owner" && actor.role !== "other" && actor.role !== "system") return undefined;
  if (typeof actor.platform !== "string" || !actor.platform || typeof actor.id !== "string" || !actor.id) return undefined;
  return {
    role: actor.role,
    platform: actor.platform,
    id: actor.id,
    ...(typeof actor.displayName === "string" && actor.displayName ? { displayName: actor.displayName } : {}),
  };
}

function normalizeRunRecord(value: unknown): Message["runRecord"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<NonNullable<Message["runRecord"]>>;
  if (record.status !== "interrupted" && record.status !== "answered") return undefined;
  if (typeof record.attemptId !== "string" || !record.attemptId) return undefined;
  if (typeof record.checkpointId !== "string" || !record.checkpointId) return undefined;
  return {
    status: record.status,
    attemptId: record.attemptId.slice(0, 160),
    checkpointId: record.checkpointId.slice(0, 160),
    ...(record.status === "interrupted" ? { reason: safeInterruptionReason(typeof record.reason === "string" ? record.reason : "运行未完成") } : {}),
    ...(normalizeExecutionEvidence(record.evidence) ? { evidence: normalizeExecutionEvidence(record.evidence)! } : {}),
  };
}

/**
 * 清洗压缩输出（对抗核验发现：cache 复用需复用人格 system，模型偶尔泄漏角色口吻 / 误抄压缩指令）。
 * 去掉：泄漏的开场称呼 + 钥匙 emoji + 误抄进来的指令回显行。
 */
function cleanSummary(text: string): string {
  let s = stripExecutionEvidenceCards(text)
    .split(/\r?\n/)
    .filter((line) => !/(压缩成|以上全部对话|最高优先级|系统指令|不要以角色|不要复述本条|元话语)/.test(line))
    .join("\n");
  s = s
    .replace(/^\s*```(?:markdown|md)?\s*/iu, "")
    .replace(/\s*```\s*$/u, "")
    .replace(/^\s*(用户|用户)\s*[，,、:：]?\s*/u, "")
    .replace(/🗝️?/gu, "")
    .trim();
  return redactSecrets(s).slice(0, 5000).trim();
}

/** 摘要失败时仍保留“旧摘要 + 最近被丢消息的有界片段”，比只留一句截断通知更可恢复。 */
function fallbackCompactionSummary(prevSummary: string, dropped: Message[], dropCount: number): string {
  const excerpts: string[] = [];
  let used = 0;
  for (let i = dropped.length - 1; i >= 0 && excerpts.length < 8; i--) {
    const message = dropped[i]!;
    const flat = redactSecrets(stripExecutionEvidenceCards(message.content)).replace(/\s+/g, " ").trim();
    if (!flat) continue;
    const excerpt = `${message.role === "user" ? "用户" : "助手"}：${flat.slice(0, 420)}`;
    if (used + excerpt.length > 3000) break;
    excerpts.unshift(`- ${excerpt}`);
    used += excerpt.length;
  }
  return redactSecrets([
    prevSummary.trim(),
    `## 历史恢复备注\n- 模型整理失败；已移出 ${dropCount} 条早期消息，以下保留其最近的有界片段。`,
    excerpts.length ? `## 最近早期消息片段\n${excerpts.join("\n")}` : "",
  ].filter(Boolean).join("\n\n")).slice(0, 5000).trim();
}

function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[敏感凭据已省略]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}\b/g, "[敏感凭据已省略]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b/gi, "Bearer [敏感凭据已省略]");
}
