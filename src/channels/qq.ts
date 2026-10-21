import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { Attachment } from "../types";
import type { Channel, IncomingMessage, MessageHandler } from "./types";
import { normalizeQQOpenid, QQBindingStore, sharedQQBindingStore } from "./qqBindings";
import { QUEUE_RUN_TIMEOUT_MS } from "../scheduler/taskTimeout";
import { installQQTokenRecovery, qqApiFailureDetails, type QQSdkTransport } from "./qqTokenRecovery";

interface QQReplyTarget {
  scope: "c2c" | "group";
  targetId: string;
  msgId?: string;
}

interface QQInboundAttachment {
  content_type?: string;
  url?: string;
  filename?: string;
  size?: number;
  voice_wav_url?: string;
  asr_refer_text?: string;
}

interface QQInboundMessage {
  kind: "c2c" | "group" | "guild" | "dm";
  rawEventType: string;
  senderId: string;
  senderName?: string;
  senderIsBot?: boolean;
  content: string;
  messageId: string;
  groupOpenid?: string;
  attachments?: QQInboundAttachment[];
  replyTarget: QQReplyTarget;
}

interface QQBotLike extends QQSdkTransport {
  use(middleware: unknown): void;
  on(event: "ready" | "resumed", handler: (data: unknown) => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  on(event: "message", handler: (context: unknown, message: QQInboundMessage) => void | Promise<void>): void;
  start(signal?: AbortSignal): Promise<void>;
  stop(): void;
  sendText(target: QQReplyTarget, content: string): Promise<unknown>;
  sendTyping(target: QQReplyTarget, durationSec?: number): Promise<unknown>;
  sendImage(target: QQReplyTarget, source: QQMediaSource): Promise<unknown>;
  sendVoice(target: QQReplyTarget, source: QQMediaSource): Promise<unknown>;
  sendFile(target: QQReplyTarget, source: QQMediaSource, options?: { fileName?: string }): Promise<unknown>;
}

interface QQMediaSource {
  url?: string;
  localPath?: string;
}

interface QQSdkModule {
  QQBot: new (options: Record<string, unknown>) => QQBotLike;
  messageFilter?: (options?: Record<string, unknown>) => unknown;
  contentSanitizer?: (options?: Record<string, unknown>) => unknown;
}

export interface QQChannelOptions {
  /** 多 Bot 稳定实例名；用于 SDK token cache、身份绑定和来源展示。 */
  botKey: string;
  appId: string;
  appSecret: string;
  agentName: string;
  label: string;
  allowlist: Set<string>;
  ownerOpenids: Set<string>;
  pairingCode?: string;
  requireMention?: boolean;
  markdownSupport?: boolean;
  bindingsFile?: string;
  uploadDir?: string;
  logger: Logger;
  loadSdk?: () => Promise<QQSdkModule>;
  /** QQ 客户端可能在切换前后台/重新打开会话时清掉气泡；这里允许测试或部署微调心跳。 */
  typing?: {
    durationSec?: number;
    keepAliveIntervalMs?: number;
    maxLifetimeMs?: number;
  };
  /** 配对成功后持久清空该 Bot 的一次性码；绑定已落盘，即使清码失败也不回滚身份。 */
  onPairingConsumed?: () => Promise<void> | void;
}

const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;

function secureEqual(left: string, right: string): boolean {
  const hash = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(hash(left), hash(right));
}

function splitText(text: string, limit = 1_800): string[] {
  const clean = String(text || "").trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > limit) {
    let end = rest.lastIndexOf("\n", limit);
    if (end < limit * 0.45) end = rest.lastIndexOf("。", limit) + 1;
    if (end < limit * 0.45) end = limit;
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function encodeQQTarget(target: QQReplyTarget): string {
  return `qq:${Buffer.from(JSON.stringify(target), "utf8").toString("base64url")}`;
}

export function decodeQQTarget(value: string): QQReplyTarget {
  if (!value.startsWith("qq:")) throw new Error("无效 QQ 回复目标");
  const parsed = JSON.parse(Buffer.from(value.slice(3), "base64url").toString("utf8")) as Partial<QQReplyTarget>;
  if ((parsed.scope !== "c2c" && parsed.scope !== "group") || !parsed.targetId) {
    throw new Error("无效 QQ 回复目标");
  }
  return {
    scope: parsed.scope,
    targetId: String(parsed.targetId),
    ...(parsed.msgId ? { msgId: String(parsed.msgId) } : {}),
  };
}

export function parseQQAttachments(items: QQInboundAttachment[] | undefined): Attachment[] {
  const out: Attachment[] = [];
  for (const item of items ?? []) {
    const mime = String(item.content_type || "application/octet-stream");
    const url = String(item.voice_wav_url || item.url || "");
    if (!url) continue;
    const kind: Attachment["kind"] = item.voice_wav_url || mime.startsWith("audio/")
      ? "audio"
      : mime.startsWith("image/")
        ? "image"
        : mime.startsWith("video/")
          ? "video"
          : "file";
    out.push({
      kind,
      url,
      mime: item.voice_wav_url ? "audio/wav" : mime,
      name: item.filename || (kind === "audio" ? "qq-voice.wav" : "qq-attachment"),
      ...(typeof item.size === "number" ? { size: item.size } : {}),
      ...(kind === "audio" && String(item.asr_refer_text || "").trim() ? {
        // 这是 QQ 开放平台事件携带的官方 ASR，不是用户可伪造的 Web 请求字段。
        // 统一入站中间件会优先消费它，避免再向外部 STT 重复付费/计算。
        transcription: {
          text: String(item.asr_refer_text).trim(),
          source: "platform" as const,
          provider: "qq-native-asr",
        },
      } : {}),
    });
  }
  return out;
}

export class QQChannel implements Channel {
  readonly name = "qq";
  private handler?: MessageHandler;
  private bot?: QQBotLike;
  private runPromise?: Promise<void>;
  private stopping = false;
  private readonly bindings: QQBindingStore;
  private readonly owners: Set<string>;
  private readonly pairingAttempts = new Map<string, { count: number; since: number }>();
  private readonly authorizationNotices = new Map<string, number>();

  constructor(private readonly opts: QQChannelOptions) {
    this.bindings = sharedQQBindingStore(path.resolve(opts.bindingsFile || "./data/qqBindings.json"));
    this.owners = new Set([...opts.ownerOpenids].map(normalizeQQOpenid).filter(Boolean));
    const configuredAllowlist = [...opts.allowlist];
    opts.allowlist.clear();
    for (const value of configuredAllowlist) {
      const clean = value === "*" ? "*" : normalizeQQOpenid(value);
      if (clean) opts.allowlist.add(clean);
    }
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  setAllowlist(values: string[]): void {
    this.opts.allowlist.clear();
    for (const value of values) {
      const clean = value === "*" ? "*" : normalizeQQOpenid(value);
      if (clean) this.opts.allowlist.add(clean);
    }
    this.opts.logger.info({ size: this.opts.allowlist.size }, "qq:allowlist 已热更新");
  }

  ownerOpenids(): string[] {
    return [...this.owners];
  }

  async start(): Promise<void> {
    await this.bindings.load();
    for (const id of this.bindings.owners(this.opts.botKey)) this.owners.add(id);
    // 配对码成功使用后会由 onPairingConsumed 从 .env 持久清空。若此处仍有值，说明
    // 主人刚在面板明确生成了恢复码；不能因为已有旧 OpenID 就把恢复入口再次锁死。
    const sdk = await (this.opts.loadSdk
      ? this.opts.loadSdk()
      : nativeImport("@tencent-connect/qqbot-nodejs") as Promise<QQSdkModule>);
    const sdkLogger = {
      debug: (message: string, meta?: Record<string, unknown>) => this.opts.logger.debug(meta ?? {}, message),
      info: (message: string, meta?: Record<string, unknown>) => this.opts.logger.info(meta ?? {}, message),
      warn: (message: string, meta?: Record<string, unknown>) => this.opts.logger.warn(meta ?? {}, message),
      error: (message: string, meta?: Record<string, unknown>) => this.opts.logger.error(meta ?? {}, message),
    };
    const bot = new sdk.QQBot({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      accountId: `harbour-${this.opts.botKey}`,
      markdownSupport: this.opts.markdownSupport === true,
      logger: sdkLogger,
    });
    installQQTokenRecovery(bot, this.opts, this.opts.logger);
    this.bot = bot;
    if (sdk.messageFilter) bot.use(sdk.messageFilter({ skipSelfEcho: true, dedup: { windowMs: 10_000 } }));
    if (sdk.contentSanitizer) bot.use(sdk.contentSanitizer({ stripBotMention: true }));

    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    bot.on("ready", () => {
      this.opts.logger.info({ owners: this.owners.size }, "QQ 官方机器人已连接");
      readyResolve();
    });
    bot.on("resumed", () => this.opts.logger.info("QQ Gateway 会话已恢复"));
    bot.on("error", (error) => this.opts.logger.error({ err: error.message }, "QQ SDK 错误"));
    bot.on("message", async (_context, message) => this.handleIncoming(message));

    this.stopping = false;
    this.runPromise = bot.start().catch((error) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      readyReject(normalized);
      if (!this.stopping) this.opts.logger.error({ err: normalized.message }, "QQ Gateway 已停止");
    });
    const timeout = new Promise<void>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("QQ Gateway 连接超时")), 30_000);
      timer.unref?.();
      ready.finally(() => clearTimeout(timer)).catch(() => {});
    });
    try {
      await Promise.race([ready, timeout]);
    } catch (error) {
      bot.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.bot?.stop();
    await this.runPromise?.catch(() => {});
    this.bot = undefined;
  }

  startTyping(target: string): () => void {
    try {
      const reply = decodeQQTarget(target);
      if (reply.scope !== "c2c" || !this.bot) return () => {};
      const durationSec = Math.max(5, Math.floor(this.opts.typing?.durationSec ?? 60));
      // QQ 客户端在重新打开聊天、切换前后台时会主动清掉当前气泡；不能只贴着 TTL 续租。
      // 腾讯自己的 QQ Bot 接入实现采用 5 秒心跳，最坏也只会空窗 5 秒。
      // 生产默认固定为 5 秒；较小值只通过构造参数用于确定性的快速测试。
      const keepAliveIntervalMs = Math.max(10, Math.floor(this.opts.typing?.keepAliveIntervalMs ?? 5_000));
      const maxLifetimeMs = Math.max(
        keepAliveIntervalMs * 2,
        Math.floor(this.opts.typing?.maxLifetimeMs ?? (QUEUE_RUN_TIMEOUT_MS + 60_000)),
      );
      let stopped = false;
      let inFlight = false;
      let consecutiveFailures = 0;
      const tick = async (): Promise<void> => {
        if (stopped || !this.bot || inFlight) return;
        inFlight = true;
        try {
          await this.bot.sendTyping(reply, durationSec);
          if (consecutiveFailures > 0) {
            this.opts.logger.info({ failures: consecutiveFailures }, "qq:typing 心跳已恢复");
          }
          consecutiveFailures = 0;
        } catch (error) {
          consecutiveFailures += 1;
          // 输入提示不是关键路径，但不能再把所有失败静默吞掉；首次及持续失败时留下可诊断证据。
          if (consecutiveFailures === 1 || consecutiveFailures % 12 === 0) {
            this.opts.logger.warn({
              failures: consecutiveFailures,
              err: error instanceof Error ? error.message : String(error),
            }, "qq:typing 心跳发送失败（回答继续运行）");
          }
        } finally {
          inFlight = false;
        }
      };
      void tick();
      const timer = setInterval(() => void tick(), keepAliveIntervalMs);
      timer.unref?.();
      // onSettled 是主清理；这里再留一个略高于队列超时的最终保险。
      const safety = setTimeout(() => {
        stopped = true;
        clearInterval(timer);
      }, maxLifetimeMs);
      safety.unref?.();
      return () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        clearTimeout(safety);
      };
    } catch { /* opaque target 已失效时静默 */ }
    return () => {};
  }

  async sendMessage(target: string, text: string, attachments?: Attachment[]): Promise<void> {
    return this.sendOutgoing(target, text, attachments, false);
  }

  /** Scheduled delivery must not report success after silently losing media. */
  async sendScheduledMessage(target: string, text: string, attachments?: Attachment[]): Promise<void> {
    return this.sendOutgoing(target, text, attachments, true);
  }

  private async sendOutgoing(target: string, text: string, attachments: Attachment[] | undefined, strict: boolean): Promise<void> {
    if (!this.bot) throw new Error("QQ Bot 尚未连接");
    const reply = decodeQQTarget(target);
    if (strict && reply.msgId) throw new Error("QQ 定时投递不能复用旧回复消息 ID");
    const media = attachments ?? [];
    if (media.length > 6) throw new Error("QQ 投递单段附件超过 6 个，未发送该段");
    for (const chunk of splitText(text)) await this.bot.sendText(reply, chunk);
    let mediaSent = 0;
    for (const attachment of media) {
      try {
        const source = this.mediaSource(attachment);
        if (!source) throw new Error("QQ 投递附件没有可用路径/URL；此前文字可能已送达");
        if (attachment.kind === "image") await this.bot.sendImage(reply, source);
        else if (attachment.kind === "audio") await this.bot.sendVoice(reply, source);
        else await this.bot.sendFile(reply, source, { fileName: attachment.name });
        mediaSent += 1;
      } catch (error) {
        this.opts.logger.warn({ mediaSent, mediaTotal: media.length, kind: attachment.kind,
          ...qqApiFailureDetails(error) }, "QQ 附件未确认送达；中止剩余投递，不标记整条回复成功");
        if (!strict) {
          try {
            await this.bot.sendText(reply, "有附件未确认送达，请在 Harbour 会话中查看；不会自动重发或重新生成。");
          } catch (noticeError) {
            this.opts.logger.warn(qqApiFailureDetails(noticeError), "QQ 附件投递提醒也未确认送达");
          }
        }
        // The intake journal keeps the generated result, marks delivery unknown,
        // and requires explicit confirmation before resending any partial segment.
        throw error;
      }
    }
  }

  private mediaSource(attachment: Attachment): QQMediaSource | null {
    if (attachment.path) {
      const localPath = path.isAbsolute(attachment.path) ? attachment.path : path.resolve(attachment.path);
      return existsSync(localPath) ? { localPath } : null;
    }
    if (attachment.url.startsWith("/uploads/")) {
      const root = path.resolve(this.opts.uploadDir || "./assets/uploads");
      const requested = path.resolve(root, decodeURIComponent(attachment.url.slice("/uploads/".length)));
      if ((requested === root || requested.startsWith(`${root}${path.sep}`)) && existsSync(requested)) return { localPath: requested };
      return null;
    }
    return /^https?:\/\//i.test(attachment.url) ? { url: attachment.url } : null;
  }

  private async handleIncoming(message: QQInboundMessage): Promise<void> {
    if (!this.handler || message.senderIsBot || (message.kind !== "c2c" && message.kind !== "group")) return;
    if (message.kind === "group" && this.opts.requireMention !== false && message.rawEventType !== "GROUP_AT_MESSAGE_CREATE") return;
    const senderId = normalizeQQOpenid(message.senderId);
    const rawConversationId = message.kind === "group" ? String(message.groupOpenid || message.replyTarget.targetId) : senderId;
    const conversationId = normalizeQQOpenid(rawConversationId);
    const text = String(message.content || "").trim();

    if (message.kind === "c2c" && await this.tryPair(message, text)) return;
    const allowed = this.owners.has(senderId)
      || this.opts.allowlist.has("*")
      || this.opts.allowlist.has(senderId)
      || this.opts.allowlist.has(message.senderId)
      || this.opts.allowlist.has(conversationId)
      || this.opts.allowlist.has(rawConversationId);
    if (!allowed) {
      await this.rejectUnauthorized(message, conversationId);
      return;
    }

    const parsedAttachments = parseQQAttachments(message.attachments);
    // 平台 ASR 与外部 STT 均由模型调用前的 incomingSpeech 中间件统一拼入 text。
    // 这里保留真正的空文本，让中间件能区分“纯语音”与“用户还附了文字”。
    if (!text && !parsedAttachments.length) return;
    const shortId = `${conversationId.slice(0, 6)}…${conversationId.slice(-4)}`;
    const authorName = message.senderName || "QQ 用户";
    const incoming: IncomingMessage = {
      messageId: message.messageId,
      text,
      target: encodeQQTarget(message.replyTarget),
      authorId: senderId,
      attachments: parsedAttachments.length ? parsedAttachments : undefined,
      origin: {
        platform: "qq",
        accountKey: this.opts.botKey,
        accountLabel: this.opts.label,
        targetId: conversationId,
        scope: message.kind === "c2c" ? "dm" : "group",
        ...(message.kind === "group" ? { containerId: conversationId, containerName: `QQ群 ${shortId}` } : {}),
        locationName: message.kind === "c2c" ? `与 ${authorName} 的私聊` : `QQ群 ${shortId}`,
        authorId: senderId,
        authorName,
      },
      raw: message,
    };
    await this.handler(incoming);
  }

  private async rejectUnauthorized(message: QQInboundMessage, conversationId: string): Promise<void> {
    const fingerprint = (value: string) => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 10);
    this.opts.logger.info({
      botKey: this.opts.botKey,
      kind: message.kind,
      sender: fingerprint(normalizeQQOpenid(message.senderId)),
      conversation: fingerprint(conversationId),
      ownerCount: this.owners.size,
      allowlistSize: this.opts.allowlist.size,
      pairingAvailable: !!this.opts.pairingCode,
    }, "QQ 消息已收到但身份未授权；未创建会话");

    // 群聊里不主动刷屏；私聊则明确告诉用户消息已经抵达 Harbour，以及为什么没有 session。
    if (message.kind !== "c2c" || !this.bot) return;
    const now = Date.now();
    const senderId = normalizeQQOpenid(message.senderId);
    const lastNotice = this.authorizationNotices.get(senderId) ?? 0;
    if (now - lastNotice < 60_000) return;
    if (this.authorizationNotices.size >= 512) {
      for (const [sender, sentAt] of this.authorizationNotices) {
        if (now - sentAt >= 60_000) this.authorizationNotices.delete(sender);
      }
      if (this.authorizationNotices.size >= 512) this.authorizationNotices.clear();
    }
    this.authorizationNotices.set(senderId, now);

    const guidance = this.opts.pairingCode
      ? "请在 Harbour 的 Channels → QQ 页面重置/复制此 Bot 的一次性配对码，然后私聊发送：/bind <配对码>。绑定成功后，再发一条普通消息即可创建会话。"
      : "请由主人在 Harbour 的 Channels → QQ 页面为此 Bot 配置一次性配对码，或把你的 OpenID 加入 allowlist。";
    try {
      await this.bot.sendText(
        message.replyTarget,
        `Harbour 已收到你的消息，但这个 QQ 身份尚未授权，因此没有创建会话。${guidance}`,
      );
    } catch (error) {
      this.opts.logger.warn({ botKey: this.opts.botKey, err: (error as Error).message }, "QQ 未授权提示发送失败");
    }
  }

  private async tryPair(message: QQInboundMessage, text: string): Promise<boolean> {
    const match = text.match(/^\/(?:bind|绑定)\s+(.+)$/i);
    if (!match) return false;
    const expected = String(this.opts.pairingCode || "");
    if (!expected) return false;
    const now = Date.now();
    const senderId = normalizeQQOpenid(message.senderId);
    const attempt = this.pairingAttempts.get(senderId);
    const current = !attempt || now - attempt.since > 10 * 60_000 ? { count: 0, since: now } : attempt;
    current.count += 1;
    this.pairingAttempts.set(senderId, current);
    if (current.count > 5) {
      await this.bot?.sendText(message.replyTarget, "配对尝试过多，请稍后再试。");
      return true;
    }
    if (!secureEqual(match[1]!.trim(), expected)) {
      await this.bot?.sendText(message.replyTarget, "配对码无效。");
      return true;
    }
    await this.bindings.addOwner(this.opts.botKey, senderId);
    this.owners.add(senderId);
    // 先让当前进程立即失效，再持久清掉 .env；两步都完成后这才是真正的一次性码。
    this.opts.pairingCode = "";
    this.pairingAttempts.delete(senderId);
    try {
      await this.opts.onPairingConsumed?.();
    } catch (error) {
      this.opts.logger.warn({ err: (error as Error).message }, "QQ 绑定已保存，但一次性配对码持久清理失败");
    }
    await this.bot?.sendText(message.replyTarget, `✅ 已绑定为 Harbour 主人账号（${this.opts.label}）。此绑定会长期保存，一次性配对码已失效，无需每天重绑。`);
    this.opts.logger.info({ ownerCount: this.owners.size }, "QQ owner 配对成功");
    return true;
  }
}
