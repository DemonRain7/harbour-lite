import { discordProxyLabel, discordRestProxyAgent } from "./discordProxy";
import {
  ActivityType,
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  type Interaction,
  type Message as DiscordMessage,
  type TextBasedChannel,
} from "discord.js";
import type { Channel, IncomingMessage, MessageHandler } from "./types";
import type { Attachment } from "../types";
import type { Logger } from "pino";
import { QUEUE_RUN_TIMEOUT_MS } from "../scheduler/taskTimeout";


export interface SlashActor {
  id: string;
  name?: string;
}

/** 上层注入的斜杠命令处理：把 (命令名, 参数, 频道, 发起者) 翻成一段回复文本。 */
export type SlashCommandHandler = (
  name: string,
  args: Record<string, string>,
  channelId: string,
  actor: SlashActor
) => Promise<string | { text: string; onSettled: (delivered: boolean) => void }>;
/** 上层注入的自动补全（如 /switch 的 target 候选）。 */
export type SlashAutocompleteHandler = (
  name: string,
  focused: string,
  channelId: string,
  actor: SlashActor
) => Promise<Array<{ name: string; value: string }>>;

/**
 * 原生斜杠命令定义。启动时 bulk 覆盖到 Discord（自动清掉旧命令、注册这批）。
 * 与渠道无关的「该做什么」由上层 setSlashHandlers 注入（复用 sessionCommands）。
 */
const SLASH_COMMANDS = [
  new SlashCommandBuilder().setName("new").setDescription("新开一段会话（旧的自动存档）"),
  new SlashCommandBuilder().setName("sessions").setDescription("列出本频道的会话（▶=当前）"),
  new SlashCommandBuilder()
    .setName("switch")
    .setDescription("切换到另一段会话")
    .addStringOption((o) =>
      o.setName("target").setDescription("会话序号或 #id").setRequired(true).setAutocomplete(true)
    ),
  new SlashCommandBuilder().setName("config").setDescription("查看当前会话的 Model / Effort / Mode / Skill / GOAL"),
  new SlashCommandBuilder()
    .setName("model")
    .setDescription("查看或修改当前会话模型")
    .addStringOption((o) => o.setName("value").setDescription("模型或 auto；留空查看列表").setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName("effort")
    .setDescription("查看或修改当前会话推理力度")
    .addStringOption((o) => o.setName("value").setDescription("留空查看可选项").addChoices(
      { name: "跟随默认", value: "auto" },
      { name: "off", value: "off" },
      { name: "none", value: "none" },
      { name: "minimal", value: "minimal" },
      { name: "low", value: "low" },
      { name: "medium", value: "medium" },
      { name: "high", value: "high" },
      { name: "xhigh", value: "xhigh" },
      { name: "max", value: "max" },
      { name: "ultra", value: "ultra" }
    )),
  new SlashCommandBuilder()
    .setName("mode")
    .setDescription("查看或修改当前会话权限模式")
    .addStringOption((o) => o.setName("value").setDescription("留空查看可选项").addChoices(
      { name: "跟随 Agent", value: "follow" },
      { name: "default", value: "default" },
      { name: "acceptEdits", value: "acceptEdits" },
      { name: "don't ask", value: "dontAsk" },
      { name: "plan", value: "plan" },
      { name: "auto", value: "auto" },
      { name: "bypassPermissions", value: "bypassPermissions" }
    )),
  new SlashCommandBuilder()
    .setName("skill")
    .setDescription("查看、钉住或清除当前会话 Skill")
    .addStringOption((o) => o.setName("value").setDescription("Skill 或 auto；留空查看列表").setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName("goal")
    .setDescription("查看或管理当前会话的持续目标")
    .addStringOption((o) => o.setName("action").setDescription("默认查看").addChoices(
      { name: "查看", value: "show" },
      { name: "开始", value: "start" },
      { name: "完成", value: "complete" },
      { name: "退出", value: "cancel" },
      { name: "暂停", value: "pause" },
      { name: "预算", value: "budget" },
      { name: "恢复", value: "resume" }
    ))
    .addStringOption((o) => o.setName("text").setDescription("目标内容或进度说明")),
  new SlashCommandBuilder().setName("help").setDescription("会话与配置命令说明"),
].map((c) => c.toJSON());

/**
 * Discord 单条消息上限是 2000 字符；留 100 字符余量，避免后续包装文本越界。
 * 优先在换行/空格处分段，中文长段落等没有分隔符时再硬切，绝不静默截断内容。
 */
const DISCORD_TEXT_LIMIT = 1900;
export function splitDiscordText(text: string, limit = DISCORD_TEXT_LIMIT): string[] {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("Discord 分段上限必须是正整数");
  let remaining = text.trim();
  const chunks: string[] = [];
  while (remaining.length > limit) {
    const newline = remaining.lastIndexOf("\n", limit);
    const space = remaining.lastIndexOf(" ", limit);
    const natural = Math.max(newline, space);
    const cut = natural >= Math.floor(limit * 0.4) ? natural : limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/** Discord 自定义状态必须跟绑定 persona 走，不能让多 Bot 共用 Elaina 的钥匙意象。 */
export function discordPresenceState(agentName?: string): string {
  if (agentName === "main-aemeath") return "✦ 今天有在好好当救世主吗？";
  if (agentName === "main-elaina") return "🗝️ 随时待命";
  return "◇ Harbour 在线";
}

/**
 * Discord adapter（v1 落地）。
 *
 * 流程：收到消息 → 包成 IncomingMessage 交给 handler（上层把它塞进队列）→
 *       agent 处理完 → 用 sendMessage 回发到原频道。
 *
 * 安全：默认走 allowlist（白名单），按「作者 ID 或频道 ID」放行。
 *       白名单为空 = 谁都不放行——绝不默认对所有人开放。
 */
export class DiscordChannel implements Channel {
  readonly name: string;
  private client: Client;
  private handler?: MessageHandler;
  private onSlash?: SlashCommandHandler;
  private onSlashAC?: SlashAutocompleteHandler;

  constructor(
    private opts: {
      token: string;
      allowlist: Set<string>;
      logger: Logger;
      /** 多 Bot 的稳定实例名；缺省保持旧的 channel 名。 */
      botKey?: string;
      /** Dashboard / 桌宠展示用的 Bot 名称。 */
      botLabel?: string;
      /** Bot 绑定的 persona；用于 persona 专属 presence 等渠道表现。 */
      agentName?: string;
      /** 可选身份护栏：token 登录到的 Application 必须与配置一致。 */
      expectedApplicationId?: string;
    }
  ) {
    this.name = opts.botKey ? `discord:${opts.botKey}` : "discord";
    this.client = this.createClient(true);
  }

  private createClient(includeMessageContent: boolean): Client {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        ...(includeMessageContent ? [GatewayIntentBits.MessageContent] : []),
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel], // 收 DM 需要
      // 显式声明在线状态——否则 bot 连上后侧栏头像会显示灰色（离线）。
      // 注：bot 的在线状态/活动，只有「和它共享至少一个服务器」的用户才看得到；
      //     纯 DM（没把它拉进任何服务器）时 Discord 仍会把它显示成灰色，这是平台限制。
      presence: {
        status: "online",
        // Custom 状态：只显示 state 文本，不带「正在玩/正在听」前缀。
        activities: [{ name: "harbour", type: ActivityType.Custom, state: discordPresenceState(this.opts.agentName) }],
      },
    });
    if (discordRestProxyAgent) client.rest.setAgent(discordRestProxyAgent);
    return client;
  }

  private bindClientEvents(): void {
    this.client.on(Events.MessageCreate, (msg: DiscordMessage) => {
      void this.handleIncoming(msg);
    });
    this.client.on(Events.InteractionCreate, (i: Interaction) => {
      void this.handleInteraction(i);
    });
    this.client.once(Events.ClientReady, (c) => {
      this.opts.logger.info({ user: c.user.tag, botKey: this.opts.botKey ?? "default" }, "Discord 已连接");
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** 热更新白名单（前端 CHANNELS 面板改 allowlist 即时生效）：就地重建同一 Set，
   *  msg/interaction 校验读的就是这个引用，无需重连客户端。 */
  setAllowlist(list: string[]): void {
    this.opts.allowlist.clear();
    for (const id of list) {
      const t = id.trim();
      if (t) this.opts.allowlist.add(t);
    }
    this.opts.logger.info({ size: this.opts.allowlist.size }, "discord:allowlist 已热更新");
  }

  /** 注入斜杠命令的业务处理（上层用 SessionStore 实现，复用 sessionCommands）。 */
  setSlashHandlers(h: { command: SlashCommandHandler; autocomplete?: SlashAutocompleteHandler }): void {
    this.onSlash = h.command;
    this.onSlashAC = h.autocomplete;
  }

  async start(): Promise<void> {
    if (discordRestProxyAgent) {
      this.opts.logger.info({ proxy: discordProxyLabel() }, "Discord REST + Gateway 使用显式代理");
    }
    if (this.opts.allowlist.size === 0) {
      this.opts.logger.warn("Discord 白名单为空：当前不放行任何人（不对所有人开放）。在 DISCORD_ALLOWLIST 填用户/频道 ID。");
    }

    this.bindClientEvents();
    try {
      await this.client.login(this.opts.token);
    } catch (error) {
      if (!/disallowed intents/i.test((error as Error).message)) throw error;
      this.opts.logger.warn(
        "Discord 未开启 Message Content Intent；自动降级为私聊 / @提及安全模式后重连。若要读取回复机器人但未再次 @ 的频道消息，请在 Developer Portal 开启该 Intent。"
      );
      await this.client.destroy();
      this.client = this.createClient(false);
      this.bindClientEvents();
      await this.client.login(this.opts.token);
    }
    const actualApplicationId = this.client.application?.id ?? "";
    if (this.opts.expectedApplicationId && actualApplicationId !== this.opts.expectedApplicationId) {
      await this.client.destroy();
      throw new Error(
        `Discord token 身份不匹配：botKey=${this.opts.botKey ?? "default"} ` +
        `期望 Application ${this.opts.expectedApplicationId}，实际 ${actualApplicationId || "未知"}`
      );
    }
    await this.syncSlashCommands();
  }

  /** 清洗旧命令 + 同步当前命令：bulk 覆盖全局命令，并清掉各服务器残留的命令。 */
  private async syncSlashCommands(): Promise<void> {
    const app = this.client.application;
    if (!app) return;
    try {
      const before = await app.commands.fetch();
      await app.commands.set(SLASH_COMMANDS); // 覆盖式：自动删旧命令、注册这批
      let guildCleared = 0;
      for (const g of this.client.guilds.cache.values()) {
        try {
          const gc = await g.commands.fetch();
          if (gc.size) {
            await g.commands.set([]);
            guildCleared += gc.size;
          }
        } catch {
          /* 单个服务器清理失败不影响整体 */
        }
      }
      this.opts.logger.info(
        { replacedGlobal: before.size, nowGlobal: SLASH_COMMANDS.length, guildCleared },
        "Discord 斜杠命令已同步（清旧 + 注册）"
      );
    } catch (e) {
      this.opts.logger.warn({ err: (e as Error).message }, "Discord 斜杠命令同步失败");
    }
  }

  /** 处理斜杠命令交互与自动补全；委托给注入的 handler。 */
  private async handleInteraction(i: Interaction): Promise<void> {
    try {
      const channelId = i.channelId ?? "";
      const allowed = this.opts.allowlist.has(i.user.id) || this.opts.allowlist.has(channelId);
      const actor = {
        id: i.user.id,
        name: i.user.globalName ?? i.user.username,
      };
      if (i.isAutocomplete()) {
        // 自动补全也会暴露会话标题；必须与真正执行命令走同一白名单与 actor-scoped key。
        if (!allowed) {
          await i.respond([]);
          return;
        }
        if (!this.onSlashAC) {
          await i.respond([]);
          return;
        }
        const focused = String(i.options.getFocused() ?? "");
        const choices = await this.onSlashAC(i.commandName, focused, channelId, actor);
        await i.respond(choices.slice(0, 25));
        return;
      }
      if (!i.isChatInputCommand()) return;

      // 白名单：用户 ID 或频道 ID 命中其一（与消息路径一致）。
      if (!allowed) {
        await i.reply("（你不在白名单内，无法使用会话命令。）");
        return;
      }
      if (!this.onSlash) {
        await i.reply("（会话功能未启用。）");
        return;
      }
      const args: Record<string, string> = {};
      for (const opt of i.options.data) {
        if (typeof opt.value === "string") args[opt.name] = opt.value;
      }
      const reply = await this.onSlash(i.commandName, args, channelId, actor);
      let delivered = false;
      try { await i.reply((typeof reply === "string" ? reply : reply.text).slice(0, 1900)); delivered = true; }
      finally { if (typeof reply !== "string") reply.onSettled(delivered); }
    } catch (e) {
      this.opts.logger.warn({ err: (e as Error).message }, "Discord 交互处理失败");
      try {
        if (i.isRepliable() && !i.replied && !i.deferred) await i.reply("处理出错了，稍后再试。");
      } catch {
        /* ignore */
      }
    }
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  /**
   * 触发「当前角色正在输入…」指示，并每 ~8s 续一次（Discord 端 typing 约 10s 过期）。
   * 返回停止函数；队列在所有收尾路径调用它。最终保险比队列任务上限多留 1 分钟。
   */
  startTyping(target: string): () => void {
    let stopped = false;
    let channel: { sendTyping?: () => Promise<unknown> } | null = null;
    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        if (!channel) {
          const fetched = await this.client.channels.fetch(target);
          if (fetched && fetched.isTextBased()) channel = fetched as unknown as { sendTyping?: () => Promise<unknown> };
        }
        if (channel && typeof channel.sendTyping === "function") await channel.sendTyping();
      } catch {
        /* 输入指示失败不影响主流程 */
      }
    };
    void tick(); // 立刻来一发，收到消息就开始转圈
    const timer = setInterval(() => void tick(), 8000);
    timer.unref?.();
    const safety = setTimeout(() => {
      stopped = true;
      clearInterval(timer);
    }, QUEUE_RUN_TIMEOUT_MS + 60_000);
    safety.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(safety);
    };
  }

  async sendMessage(target: string, text: string, attachments?: Attachment[]): Promise<void> {
    return this.sendOutgoing(target, text, attachments, false);
  }

  /** Cron must surface unavailable targets instead of treating a no-op as delivery. */
  async sendScheduledMessage(target: string, text: string, attachments?: Attachment[]): Promise<void> {
    return this.sendOutgoing(target, text, attachments, true);
  }

  private async sendOutgoing(target: string, text: string, attachments: Attachment[] | undefined, strict: boolean): Promise<void> {
    const channel = await this.client.channels.fetch(target);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      if (strict) throw new Error("Discord 定时投递目标不存在或不可发消息");
      this.opts.logger.warn({ target }, "Discord 目标频道不可发消息");
      return;
    }
    if (strict && attachments?.some(attachment => !attachment.path && !attachment.url)) {
      throw new Error("Discord 定时投递附件没有可用路径/URL，未发送该段");
    }
    // 出站附件：本地路径或 URL 都交给 discord.js 的 AttachmentBuilder（接受 path/url/buffer）。
    const files = (attachments ?? [])
      .map((a) => a.path || a.url)
      .filter((src): src is string => !!src)
      .map((src) => new AttachmentBuilder(src));
    const chunks = splitDiscordText(text);
    if (!chunks.length && !files.length) return;
    const sender = channel as TextBasedChannel & { send: (p: unknown) => Promise<unknown> };
    const total = Math.max(1, chunks.length);
    for (let i = 0; i < total; i += 1) {
      const payload: { content?: string; files?: AttachmentBuilder[] } = {};
      if (chunks[i]) payload.content = chunks[i];
      if (i === 0 && files.length) payload.files = files;
      await sender.send(payload);
    }
  }

  private async handleIncoming(msg: DiscordMessage): Promise<void> {
    if (msg.author.bot) return; // 忽略机器人自己/其它 bot
    if (!this.handler) return;

    // 白名单：作者 ID 或频道 ID 命中其一即可。
    const allowed =
      this.opts.allowlist.has(msg.author.id) || this.opts.allowlist.has(msg.channelId);
    if (!allowed) {
      this.opts.logger.debug({ author: msg.author.id, channel: msg.channelId }, "Discord 消息不在白名单，忽略");
      return;
    }

    // OpenClaw 风触发规则：DM 一律响应；服务器频道里仅当 @ 到机器人，或直接回复机器人的
    // 消息时响应。后者让 ask_user 的下一轮答案自然续接，同时仍不会被普通闲聊唤醒。
    const isDM = !msg.guild;
    const botId = this.client.user?.id;
    const mentioned = botId ? msg.mentions.users.has(botId) : false;
    let repliedToBot = false;
    if (!isDM && !mentioned && botId && msg.reference?.messageId) {
      try {
        const referenced = await msg.fetchReference();
        repliedToBot = referenced.author.id === botId;
      } catch {
        // 引用消息被删、无读取权限或网络抖动时保持 fail-closed：仍要求显式 @。
      }
    }
    if (!isDM && !mentioned && !repliedToBot) {
      this.opts.logger.debug({ channel: msg.channelId }, "Discord 频道消息未 @ 或回复机器人，忽略");
      return;
    }

    // 去掉开头的 @机器人 提及，得到干净文本。
    const text = botId
      ? msg.content.replace(new RegExp(`^\\s*<@!?${botId}>\\s*`), "").trim()
      : msg.content.trim();

    const attachments = parseDiscordAttachments(msg);
    if (!text && attachments.length === 0) return; // 空消息（纯提及）不触发

    const authorName = msg.author.globalName ?? msg.author.username;
    const channelName = (msg.channel as { name?: string } | undefined)?.name;

    const incoming: IncomingMessage = {
      messageId: msg.id,
      text,
      target: msg.channelId,
      authorId: msg.author.id,
      attachments: attachments.length ? attachments : undefined,
      origin: {
        platform: "discord",
        accountKey: this.opts.botKey ?? "default",
        accountLabel: this.opts.botLabel ?? this.opts.botKey ?? "Discord Bot",
        targetId: msg.channelId,
        scope: isDM ? "dm" : "guild",
        ...(msg.guild ? { containerId: msg.guild.id, containerName: msg.guild.name } : {}),
        locationName: isDM ? `与 ${authorName} 的私聊` : channelName ? `#${channelName}` : `频道 ${msg.channelId}`,
        authorId: msg.author.id,
        authorName,
      },
      raw: msg,
    };
    await this.handler(incoming);
  }
}

/** 把 Discord 附件映射成中台统一的 Attachment（用 CDN url，先不落盘）。 */
function parseDiscordAttachments(msg: DiscordMessage): Attachment[] {
  const out: Attachment[] = [];
  for (const att of msg.attachments.values()) {
    const mime = att.contentType ?? "application/octet-stream";
    const kind: Attachment["kind"] = mime.startsWith("image/")
      ? "image"
      : mime.startsWith("audio/")
        ? "audio"
        : mime.startsWith("video/")
          ? "video"
          : "file";
    out.push({ kind, url: att.url, mime, name: att.name ?? "attachment", size: att.size ?? undefined });
  }
  return out;
}
