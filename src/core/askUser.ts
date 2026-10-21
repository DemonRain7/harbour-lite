import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

/**
 * askUser —— 工具执行到一半时【停下来问人】，拿到答复再继续。
 *
 * 【为什么需要】bash 这类工具里有些操作既不能一律放行（危险），也不该一律拒绝
 * （删个 build 目录、刷张 SD 卡都是正常需求）。正确答案是把判断交回给人。
 * 这就要求工具能在执行中挂起、等一个跨进程/跨渠道来的答复。
 *
 * 【怎么实现】进程内一张待答表：工具 createAsk() 拿到一个 promise 并 await；
 * 人在前端点了选项 → HTTP 打到 answerAsk() → resolve 那个 promise → 工具继续。
 * 提问同时经 WebSocket 推给前端弹窗（复用已有的 /ws 实时通道）。
 *
 * 【超时即拒】没人回答不能永远挂着——那会把 agent 卡死。超时按【拒绝】处理，
 * 这是唯一安全的默认值：没得到明确同意 ≠ 同意。
 */

export interface AskOption {
  /** 回给工具的值 */
  value: string;
  /** 按钮上显示的字 */
  label: string;
  /** 补充说明（前端显示在标签下方） */
  hint?: string;
}

export interface PendingAsk {
  id: string;
  /**
   * 提问性质，决定前端的措辞：
   *   confirm  = 危险动作确认（bash）。没回答 = 拒绝，标题和倒计时都要说清这一点。
   *   question = agent 主动请教（ask_user）。没回答只是没回答，不该写成"按拒绝处理"。
   */
  kind?: "confirm" | "question";
  /** 问题正文 */
  question: string;
  /** 补充上下文（例如那条待确认的命令原文） */
  detail?: string;
  options: AskOption[];
  /** 谁问的（agent 名），前端显示用 */
  agent?: string;
  /** 从哪个渠道发起（web / discord…），决定前端要不要弹窗 */
  channel?: string;
  /** 会话键（如 "discord:<频道id>:<人格>"）。Discord 侧靠它定位要把确认按钮发到哪个频道。 */
  sessionKey?: string;
  /**
   * 发起这轮对话的人（Discord 用户 ID）。按钮结算时校验点击者 == 这个人：
   * 一个按钮能授权 rm -rf，不能让同频道的其他成员替他点。
   */
  authorId?: string;
  createdAt: string;
  /** 超时时刻（ISO），前端可据此显示倒计时 */
  expiresAt: string;
}

interface Entry extends PendingAsk {
  resolve: (answer: string) => void;
  timer: NodeJS.Timeout;
}

/** 默认等 3 分钟。够你看清命令再决定，又不至于把 agent 挂到天荒地老。 */
export const ASK_MAX_WAIT_MS = 3 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = ASK_MAX_WAIT_MS;
/**
 * 超时/无人应答时返回的值。工具应把它当作「不同意」。
 * 用随机后缀而非固定的 "__timeout__"：后者是人（或伪造请求）能原样打出来的字符串，
 * 会让「你回了 __timeout__」被记成「超时未答复」，审计日志失真。
 */
export const ASK_TIMEOUT = `__ask_timeout_${randomUUID()}__`;

/**
 * 同时待答的提问上限。被注入的 agent 可以连发提问刷爆 Discord 和前端弹窗，
 * 每条还各占一个 worker 三分钟。超过就直接拒，不再打扰人。
 */
const MAX_PENDING = 8;

export class AskUserRegistry {
  private pending = new Map<string, Entry>();
  private listeners = new Set<(ask: PendingAsk, kind: "new" | "resolved") => void>();

  constructor(private logger: Logger) {}

  /** 订阅提问事件（api 层用它把提问经 WebSocket 推给前端）。 */
  onChange(fn: (ask: PendingAsk, kind: "new" | "resolved") => void): void {
    this.listeners.add(fn);
  }

  /** 当前所有待答提问（前端首次连上/刷新后拉一次，避免错过推送）。 */
  list(): PendingAsk[] {
    return [...this.pending.values()].map(({ resolve: _r, timer: _t, ...rest }) => rest);
  }

  /**
   * 发起一次提问，返回人给的答案；超时返回 ASK_TIMEOUT。
   * 注意：调用方必须把 ASK_TIMEOUT 当拒绝处理。
   */
  ask(input: {
    kind?: "confirm" | "question";
    question: string;
    detail?: string;
    options: AskOption[];
    agent?: string;
    channel?: string;
    sessionKey?: string;
    authorId?: string;
    timeoutMs?: number;
  }): Promise<string> {
    if (this.pending.size >= MAX_PENDING) {
      this.logger.warn({ agent: input.agent, pending: this.pending.size }, "askUser: 待答提问过多，直接拒绝");
      return Promise.resolve(ASK_TIMEOUT); // 调用方一律按拒绝处理
    }
    const id = `ask-${randomUUID().slice(0, 8)}`;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        const e = this.pending.get(id);
        if (!e) return;
        this.pending.delete(id);
        this.logger.warn({ id, agent: input.agent }, "askUser: 超时未答复，按拒绝处理");
        this.emit(e, "resolved");
        resolve(ASK_TIMEOUT);
      }, timeoutMs);

      const entry: Entry = {
        id,
        kind: input.kind ?? "confirm",
        question: input.question,
        detail: input.detail,
        options: input.options,
        agent: input.agent,
        channel: input.channel,
        sessionKey: input.sessionKey,
        authorId: input.authorId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
        resolve,
        timer,
      };
      this.pending.set(id, entry);
      this.logger.info({ id, agent: input.agent, question: input.question }, "askUser: 等待答复");
      this.emit(entry, "new");
    });
  }

  /** 取一条待答提问（Discord 结算前用它校验点击者身份）。 */
  get(id: string): PendingAsk | undefined {
    const e = this.pending.get(id);
    if (!e) return undefined;
    const { resolve: _r, timer: _t, ...rest } = e;
    return rest;
  }

  /** 人给出答复。answer 可以是某个 option.value，也可以是自由文本（前端的「其它」输入）。 */
  answer(id: string, answer: string): boolean {
    const e = this.pending.get(id);
    if (!e) return false;
    clearTimeout(e.timer);
    this.pending.delete(id);
    this.logger.info({ id, answer }, "askUser: 已答复");
    this.emit(e, "resolved");
    e.resolve(answer);
    return true;
  }

  private emit(e: Entry, kind: "new" | "resolved"): void {
    const { resolve: _r, timer: _t, ...ask } = e;
    for (const fn of this.listeners) {
      try { fn(ask, kind); } catch { /* 单个订阅者出错不影响其它 */ }
    }
  }
}
