import { randomUUID } from "node:crypto";
import { loadEnv, parseAllowlist } from "./config/env";
import { makeLogger } from "./core/logger";
import { TimeSettingsStore } from "./core/timeSettingsStore";
import { createRuntime } from "./runtime";
import { TaskQueue } from "./scheduler/queue";
import { createQueueTaskDeadline } from "./scheduler/taskTimeout";
import { runTaskAgent } from "./scheduler/taskExecution";
import { HeartbeatController } from "./scheduler/heartbeat";
import { CronController } from "./scheduler/cron";
import { createCronDeliverySender } from "./scheduler/cronDelivery";
import { DiscordChannel } from "./channels/discord";
import { QQChannel, encodeQQTarget } from "./channels/qq";
import { sendOutgoingSegments } from "./channels/outgoing";
import {
  parseSessionCommand,
  handleSessionCommand,
  commandFromSlash,
  type SessionCommandOptions,
} from "./channels/sessionCommands";
import { LogBroadcaster } from "./server/logBroadcaster";
import { startServer } from "./server/api";
import { enabledModelsForSlot } from "./core/modelSlots";
import type { PricingRefreshWorkflowResult } from "./core/workflows/pricingRefresh";
import { defaultReasoningEffortForAgent } from "./core/modelConfigStore";
import { claudeSdkEffortOptions } from "./core/backends/claudeSdkEffort";
import { closeManagedChrome, resolveBrowserHarnessConfig } from "./core/tools/browserHarness";
import { ensureOpenCliBrowserBridge, resolveOpenCliBrowserConfig } from "./core/tools/openCliBrowser";
import { discordSessionKey, resolveDiscordBotConfigs } from "./config/discordBots";
import { qqBotEnvNames, qqSessionKey, resolveQQBotConfigs } from "./config/qqBot";
import type { Channel } from "./channels/types";
import type { ActorIdentity, ReasoningEffort, Task } from "./types";
import { createGoalChannelControl, interruptGoalForChannelMessage } from "./core/goalChannelControl";
import { ChannelRunControl } from "./core/channelRunControl";
import { ContextWindowExceededError, contextOverflowMessage, isContextOverflowError } from "./core/contextOverflow";
import {
  discordActor,
  parseOwnerDiscordIds,
  parseOwnerQqOpenids,
  qqActor,
  sessionKeyForActor,
} from "./core/identity";
import { buildCompanionUtterance } from "./channels/companion";
import { updateEnvValues } from "./core/envFile";
import { SttGateway, readSttGatewayConfig } from "./core/sttGateway";
import { prepareIncomingSpeech } from "./channels/incomingSpeech";
import { attachmentInputErrorPresentation, isImageInputError, prepareIncomingAttachments } from "./core/imageIntake";
import { OrderedIngress, parseIntakeInput, handleIntakeCommand } from "./channels/messageIntake";
import { createServiceControl, waitForServicePredecessor, type ServiceControl } from "./core/serviceLifecycle";
import { prepareRuntimeStorage } from "./core/storageMigration";
import { sessionReplyNotification } from "./core/sessionStore";

/**
 * 入口（serve）：装载 agents → 起 worker 池 → 起 heartbeat → 连 channels →
 * 起管理 dashboard（WEB_ENABLED 时）。
 *
 * 即使 .env 基本为空也能「起来」：无 OpenRouter key 只是补全时报错（可在
 * dashboard 里热切到 mock 玩），无 Discord token 则跳过 Discord。
 *
 * 想不接真模型先看 loop 怎么跑：`npm run dev`（= demo，强制 mock）。
 */
async function main(): Promise<void> {
  const env = loadEnv();
  await waitForServicePredecessor();
  await prepareRuntimeStorage();
  let serviceControl: ServiceControl | undefined;
  // Load before the first log and before any scheduler. Do not change the host's TZ.
  const timeSettings = new TimeSettingsStore();
  await timeSettings.load();
  const startedAt = Date.now();

  // 先建广播器，再建 logger——这样 logger 产生的每行日志都能分流到 dashboard。
  const broadcaster = new LogBroadcaster();
  const logger = makeLogger(env.LOG_LEVEL, env.WEB_ENABLED ? broadcaster : undefined);

  // Electron 自带本机后端时提前拉起 OpenCLI daemon 与专属 Chrome。普通 serve/树莓派仍
  // 保持懒启动；预热失败不拖垮聊天服务，真正调用时同一套 ensure 会再次自愈并明确报错。
  if (env.OPENCLI_BROWSER_AUTOSTART) {
    void ensureOpenCliBrowserBridge(
      resolveOpenCliBrowserConfig(env),
      logger.child({ component: "opencli-prewarm" })
    ).then(
      () => logger.info("opencli: 桌面浏览器链路预热完成"),
      (error) => logger.warn({ err: (error as Error).message }, "opencli: 桌面浏览器链路预热失败（按需重试）")
    );
  }

  // Declare exact Bot maps before Cron timers can fire.
  const scheduledDiscordChannels = new Map<string, DiscordChannel>();
  const scheduledQQChannels = new Map<string, QQChannel>();
  let cronController: CronController | undefined;
  const runtime = await createRuntime(env, logger, { timeSettings, cron: {
    controller: () => cronController,
    activeQQBotKeys: () => [...scheduledQQChannels.keys()],
    activeDiscordBotKeys: () => [...scheduledDiscordChannels.keys()],
  } });
  const channelGoalControl = (actor: ActorIdentity, key: string) => createGoalChannelControl(runtime, actor, key);
  const interruptChannelGoal = (actor: ActorIdentity, key: string) => interruptGoalForChannelMessage(runtime, actor, key);
  const sessionConfigOptions = (
    agentName: string,
    isOwner: boolean
  ): Pick<SessionCommandOptions,
    "isOwner" | "models" | "skills" | "defaultModelRef" | "defaultPermissionMode" | "defaultReasoningEffort"> => {
    const agent = runtime.getAgent(agentName);
    const agentDefaultEffort = agent?.reasoningEffort ?? defaultReasoningEffortForAgent(agentName);
    const models = runtime.modelSlots.flatMap((slot) => enabledModelsForSlot(slot).map((model) => {
      const modelRef = `${slot.backendKey}/${model.id}`;
      const supportedEfforts: ReasoningEffort[] = slot.kind !== "claude-agent"
        ? (model.supportedReasoningEfforts?.map((option) => option.effort) ?? ["low", "medium", "high"])
        : claudeSdkEffortOptions(slot.baseURL).map(option => option.effort);
      const configuredEffort = runtime.modelConfig.get(modelRef).effort ?? agentDefaultEffort;
      const defaultEffort = supportedEfforts.includes(configuredEffort)
        ? configuredEffort
        : model.defaultReasoningEffort && supportedEfforts.includes(model.defaultReasoningEffort)
          ? model.defaultReasoningEffort
          : supportedEfforts.includes("medium")
            ? "medium"
            : supportedEfforts[0];
      return {
        modelRef,
        label: `${slot.label} · ${model.label || model.id}`,
        supportedEfforts,
        ...(defaultEffort ? { defaultEffort } : {}),
      };
    }));
    return {
      isOwner,
      models,
      skills: agent?.skills?.map((skill) => skill.name) ?? [],
      defaultModelRef: runtime.resolveAgentModel(agentName),
      defaultPermissionMode: runtime.resolveAgentPermissionMode(agentName),
      defaultReasoningEffort: agentDefaultEffort,
    };
  };
  const stt = new SttGateway(readSttGatewayConfig(env), logger.child({ component: "stt" }));
  let attachmentCleanupRunning = false;
  const runAttachmentCleanup = async () => {
    if (!runtime.sessions || env.ATTACHMENT_RETENTION_DAYS <= 0 || attachmentCleanupRunning) return;
    attachmentCleanupRunning = true;
    try {
      await runtime.sessions.cleanupExpiredAttachments(env.UPLOAD_DIR, env.ATTACHMENT_RETENTION_DAYS);
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "attachments:cleanup-failed");
    } finally {
      attachmentCleanupRunning = false;
    }
  };
  await runAttachmentCleanup();
  const attachmentCleanupTimer = env.ATTACHMENT_RETENTION_DAYS > 0
    ? setInterval(() => { void runAttachmentCleanup(); }, env.ATTACHMENT_CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000)
    : undefined;
  attachmentCleanupTimer?.unref?.();

  // —— worker 池：从队列取 Task，跑对应 agent 的 loop，回发结果 ——
  // 队列驱动的 run（QQ / Discord / cron 等）使用共享的整轮时限，从 worker 开始执行计时。
  // 到点沿现有 AbortSignal 停止并保存断点；单个工具/子 Agent 的时限保持独立。
  const channelRunControl = new ChannelRunControl();
  const pushChannelActivity = (
    task: Task,
    phase: "running" | "stopping" | "complete" | "error",
    detail?: string,
    activityStartedAt?: number
  ) => {
    const channel = task.sessionRef?.channel || String(task.meta?.channel || "task");
    const source = task.sessionRef?.origin || {
      platform: channel,
      locationName: task.taskType || (channel === "cron" ? "定时任务" : "后台任务"),
    };
    const sessionId = task.sessionRef?.id || (typeof task.meta?.sessionId === "string" ? task.meta.sessionId : undefined);
    broadcaster.pushEvent({
      __harbour: "channel-activity",
      phase,
      canStop: channelRunControl.canStop(task.id),
      agent: task.agentName,
      runId: task.id,
      task: task.input.replace(/\s+/g, " ").trim().slice(0, 320),
      input: task.input,
      ...(detail ? { detail } : {}),
      ...(activityStartedAt ? { startedAt: activityStartedAt } : {}),
      sessionId,
      ...(["complete", "error"].includes(phase) && sessionId ? sessionReplyNotification(runtime.sessions?.get(sessionId), task.id) : {}),
      sessionKey: task.sessionRef?.key,
      source,
    });
  };
  const pushCompanionUtterance = (task: Task, answer: string) => {
    const channel = task.sessionRef?.channel || String(task.meta?.channel || "task");
    const event = buildCompanionUtterance({
      agent: task.agentName,
      runId: task.id,
      answer,
      source: task.sessionRef?.origin || {
        platform: channel,
        locationName: task.taskType || (channel === "cron" ? "定时任务" : "后台任务"),
      },
      sessionId: typeof task.meta?.sessionId === "string" ? task.meta.sessionId : undefined,
      sessionKey: task.sessionRef?.key,
    });
    if (event) broadcaster.pushEvent(event);
  };
  const queue = new TaskQueue(
    env.WORKER_CONCURRENCY,
    async (task: Task) => {
      if (serviceControl?.snapshot().phase === "restarting") {
        try {
          const message = "Harbour 后端正在重启，本条任务尚未开始；连接恢复后请重新发送。";
          if (task.onError) await task.onError(new Error(message));
          else await task.reply?.(message);
        } finally { task.onSettled?.(); }
        return;
      }
      const ac = new AbortController();
      const goalSessionId = task.sessionRef?.id || (typeof task.meta?.sessionId === "string" ? task.meta.sessionId : undefined);
      const releaseGoalDelivery = goalSessionId ? runtime.goals.hold(goalSessionId) : undefined;
      let traceClosed = false;
      let executionDelivered = false;
      let timedOut = false;
      const activityStartedAt = Date.now();
      let releaseStop: (() => void) | undefined;
      const deadline = createQueueTaskDeadline(ac, () => {
        timedOut = true;
        logger.warn({ agent: task.agentName, channel: task.sessionRef?.channel, timeoutMinutes: deadline.timeoutMinutes }, "queue:task-timeout→abort（队列任务超时，释放 worker）");
      });
      try {
        await task.onStart?.();
        if (task.sessionRef && !task.sessionRef.runId) task.sessionRef.runId = task.id;
        broadcaster.beginRunTrace(task.id);
        if (Array.isArray(task.meta?.intakeTrace)) for (const event of task.meta.intakeTrace) {
          broadcaster.recordRunTraceEvent(task.id, { ...event, agent: task.agentName });
        }
        if (goalSessionId) releaseStop = channelRunControl.register(task.id, goalSessionId,
          () => ac.abort(new Error("user stop")),
          () => pushChannelActivity(task, "stopping", "正在中止并保存断点…", activityStartedAt));
        pushChannelActivity(task, "running", undefined, activityStartedAt);
        const out = await runTaskAgent(runtime.runAgent, task, ac.signal);
        executionDelivered = true;
        runtime.intake.executed(task.meta?.intakeId, out);
        releaseStop?.();
        pushChannelActivity(task, "running", "执行已结束，正在发送结果…", activityStartedAt);
        const runTrace = broadcaster.finishRunTrace(task.id);
        traceClosed = true;
        const sessionId = typeof task.meta?.sessionId === "string" ? task.meta.sessionId : "";
        const session = sessionId ? runtime.sessions?.get(sessionId) : undefined;
        if (session && runTrace.length) {
          // runAgent 已同步 appendTurn；此处没有 await，下一轮同 key 不可能抢先改掉 latest assistant。
          runtime.sessions!.annotateLatest(session, { trace: runTrace, expectMsgCount: session.messages.length });
        }
        if (task.reply) await task.reply(out);
        pushCompanionUtterance(task, out);
        pushChannelActivity(task, "complete");
      } catch (error) {
        releaseStop?.();
        pushChannelActivity(task, ac.signal.aborted ? "stopping" : "running", "正在保存记录并回发渠道…", activityStartedAt);
        if (executionDelivered && goalSessionId && !task.onError) {
          const session = runtime.sessions?.get(goalSessionId);
          if (session?.goal) {
            if (session.goal.status === "active") runtime.sessions!.pauseGoal(session, session.goal.id, {
              kind: "external", reason: "本轮已完成并保存，但渠道发送失败。请在 Harbour 查看结果后恢复，不会重做本轮。",
            });
            runtime.goals.publish(session);
            await runtime.sessions!.flushSessionDurably(session);
            logger.warn({ sessionId: session.id, err: String(error) }, "goal:initial-delivery-failed");
            pushChannelActivity(task, "error", "结果已保存，渠道发送失败");
            return;
          }
          logger.warn({ sessionId: goalSessionId, err: String(error) }, "channel:delivery-failed");
          pushChannelActivity(task, "error", "结果已保存，发送失败；请在会话查看，不会重做任务");
          return;
        }
        // 失败/停止轮也要把已经发生的 Trace 挂回 Session；过去 finally 直接 discard，
        // Main Chat 刷新后只剩 checkpoint，看不到“刚才究竟慢在哪一步”。
        if (!traceClosed) {
          const runTrace = broadcaster.finishRunTrace(task.id);
          traceClosed = true;
          const sessionId = typeof task.meta?.sessionId === "string" ? task.meta.sessionId : "";
          const session = sessionId ? runtime.sessions?.get(sessionId) : undefined;
          if (session) runtime.sessions!.annotateInterruptedAttempt(session, task.id, { trace: runTrace });
        }
        // Cron execution failures are not successful output to be sent to a channel.
        if (task.onError) {
          await task.onError(error);
          pushChannelActivity(task, "error", executionDelivered ? "结果已保存，投递未确认" : "执行失败，已记录原因");
          return;
        }
        if (task.reply && isImageInputError(error)) {
          const presentation = attachmentInputErrorPresentation(error);
          await task.reply(presentation.reply);
          pushChannelActivity(task, "error", presentation.activity);
          return;
        }
        // Discord 等队列渠道没有 HTTP 状态码可看：上下文超限必须回一条可执行的提示，
        // 不能只在服务端日志里失败后让 bot 沉默。
        if (task.reply && isContextOverflowError(error)) {
          const message = error instanceof ContextWindowExceededError ? error.message : contextOverflowMessage(false);
          await task.reply(message);
          pushChannelActivity(task, "error", "上下文窗口已满");
          return;
        }
        // 渠道没有 HTTP 错误页。过去普通异常/自动超时只写服务端日志，QQ/DC 看起来就像
        // Bot 突然不回复；现在任何失败都必须收口成一条不泄露内部路径/密钥的可执行提示。
        if (task.reply) {
          const message = timedOut
            ? `⏱️ ${deadline.description}并保存断点。发送“继续”可以从断点恢复；不想继续可在 Harbour 会话页放弃断点。`
            : ac.signal.aborted
              ? "⏹️ 本次任务已停止，进度已保存为断点。发送“继续”可以恢复。"
              : "⚠️ 本次任务执行失败，已保存断点。发送“继续”可以重试；不想继续可在 Harbour 会话页放弃断点。";
          try {
            await task.reply(message);
          } catch (replyError) {
            logger.warn({ id: task.id, err: (replyError as Error).message }, "queue:失败提示回发失败");
          }
          pushChannelActivity(task, "error", timedOut ? "运行超时，已保存断点" : ac.signal.aborted ? "任务已停止" : "执行失败，已保存断点");
          return;
        }
        pushChannelActivity(task, "error", timedOut ? "运行超时" : ac.signal.aborted ? "任务已停止" : "执行失败");
        throw error;
      } finally {
        releaseStop?.();
        if (!traceClosed) broadcaster.discardRunTrace(task.id);
        deadline.dispose();
        task.onSettled?.();
        releaseGoalDelivery?.();
      }
    },
    logger
  );

  runtime.intake.setDispatch(task => queue.submit(task));
  runtime.intake.setRoute("web", async () => {});
  const orderedIngress = new OrderedIngress();

  // —— heartbeat：由各 agent 的 HEARTBEAT.md 驱动，默认暂停，需由 UI/API 显式开启 ——
  const heartbeat = new HeartbeatController({
    legacyTimeZone: timeSettings.legacyScheduleTimeZone,
    agents: runtime.listAgents(),
    enqueue: (t) => queue.enqueue(t),
    logger,
  });

  // —— cron：持久化定时作业（data/cron.json），区别于 heartbeat；各 job enabled 自控 ——
  const cron = new CronController({
    legacyTimeZone: timeSettings.legacyScheduleTimeZone,
    enqueue: (t) => queue.enqueue(t),
    logger,
    deliver: createCronDeliverySender({ qq: scheduledQQChannels, discord: scheduledDiscordChannels }),
    // 内建作业：纯代码、不烧 token。见 CronJob.builtin 的注释。
    builtins: {
      "pricing-refresh": async () => {
        const result = await runtime.workflows.executeSystem("pricing-refresh", {
          action: "refresh",
          input: { trigger: "cron" },
        }) as PricingRefreshWorkflowResult;
        return result.summary;
      },
    },
  });
  // —— channels：Discord（一个 botKey = 一个独立 Discord Client + 一个入口 persona）——
  const channels: Channel[] = [];
  const discordRefs = scheduledDiscordChannels; // shared with scheduled delivery
  const discordBots = resolveDiscordBotConfigs({
    ...process.env,
    DISCORD_BOTS: env.DISCORD_BOTS,
    DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN,
    DISCORD_APPLICATION_ID: env.DISCORD_APPLICATION_ID,
    DISCORD_ALLOWLIST: env.DISCORD_ALLOWLIST,
    DEFAULT_AGENT: env.DEFAULT_AGENT,
  }, env.DEFAULT_AGENT);
  const configuredDiscordBots = discordBots.filter((bot) => !!bot.token);
  const ownerDiscordIds = parseOwnerDiscordIds(env.OWNER_DISCORD_IDS);
  if (configuredDiscordBots.length && ownerDiscordIds.size === 0) {
    logger.warn("OWNER_DISCORD_IDS 为空：所有 Discord 发言者都会按 non-owner 公开模式处理（fail-closed）");
  }
  const invalidDiscordBot = configuredDiscordBots.find((bot) => !runtime.getAgent(bot.agentName));
  if (invalidDiscordBot) {
    throw new Error(
      `Discord Bot「${invalidDiscordBot.key}」绑定了不存在的 agent「${invalidDiscordBot.agentName}」。` +
      `可用入口：${runtime.listAgents().map((agent) => agent.name).filter((name) => name.startsWith("main-")).join(" / ")}`
    );
  }

  const startDiscordBot = async (bot: (typeof discordBots)[number]): Promise<void> => {
    const botLogger = logger.child({ channel: "discord", botKey: bot.key, agent: bot.agentName });
    const discord = new DiscordChannel({
      token: bot.token,
      allowlist: parseAllowlist(bot.allowlist),
      logger: botLogger,
      botKey: bot.key,
      botLabel: bot.label,
      agentName: bot.agentName,
      expectedApplicationId: bot.applicationId || undefined,
    });
    const persona = bot.agentName;
    // 命名 Bot 的 key 同时带 botKey + channelId + agent；default 保留旧 key，已有会话不迁移也能续接。
    const sessionKeyOf = (target: string) => discordSessionKey(bot, target);

    discord.onMessage(async (msg) => {
      const actor = discordActor(msg.authorId, msg.origin?.authorName, ownerDiscordIds);
      const origin = {
        platform: "discord",
        ...(msg.origin ?? {}),
        actorRole: actor.role,
      };
      // 主人沿用原 key；每个 non-owner 自动隔离，绝不能读到主人或其他外部用户的历史。
      const sessionKey = sessionKeyForActor(sessionKeyOf(msg.target), actor);

      // 先看是不是会话/配置命令——是就直接处理并回复，不跑 agent。
      const cmd = parseSessionCommand(msg.text);
      if (cmd && runtime.sessions) {
        const goalControl = channelGoalControl(actor, sessionKey);
        const reply = handleSessionCommand(
          runtime.sessions,
          sessionKey,
          {
            channel: "discord",
            agentName: persona,
            origin,
            ...sessionConfigOptions(persona, actor.role === "owner"),
            onGoalChanged: goalControl.onGoalChanged,
          },
          cmd
        );
        let delivered = false;
        try { await discord.sendMessage(msg.target, reply); delivered = true; } finally { goalControl.release(delivered); }
        return;
      }
      const pinnedId = runtime.sessions?.activeId(sessionKey);
      const intakeInput = parseIntakeInput(msg.text, actor.role === "owner", !!msg.attachments?.length);
      if (intakeInput.command && runtime.sessions) {
        const session = runtime.sessions.resolveActive(sessionKey, { channel: "discord", agentName: persona, origin });
        const ref = { id: session.id, key: sessionKey, channel: "discord", actor, origin };
        try {
          const handle = () => Promise.resolve(handleIntakeCommand(msg.text, runtime.intake, ref, persona,
            () => { channelRunControl.stopSession(session.id); runtime.stopGoalRun(session.id); }));
          const reply = /^\/(发完|send)(?:\s|$)/i.test(msg.text.trim()) ? await orderedIngress.run(sessionKey, handle) : await handle();
          await discord.sendMessage(msg.target, reply);
        }
        catch (error) { await discord.sendMessage(msg.target, (error as Error).message); }
        return;
      }
      if (!pinnedId || !runtime.inputs.isBusy(pinnedId)) interruptChannelGoal(actor, sessionKey);
      const preparation = runtime.intake.beginPreparation(sessionKey);
      return orderedIngress.run(sessionKey, async () => {

      // 「<角色> 正在输入…」：收到消息即开始转圈，回复发出时停（含排队+跑 loop 全程）。
      const stopTyping = discord.startTyping(msg.target);
      const taskId = randomUUID().slice(0, 8);
      try {
      const hasAudio = msg.attachments?.some((attachment) => attachment.kind === "audio") === true;
      broadcaster.beginRunTrace(taskId);
      broadcaster.pushEvent({
        __harbour: "channel-activity",
        phase: "incoming",
        agent: persona,
        runId: taskId,
        task: hasAudio ? "正在转写 Discord 语音…" : msg.text.replace(/\s+/g, " ").trim().slice(0, 320),
        input: msg.text,
        sessionKey,
        source: origin,
      });

      const prepared = await prepareIncomingSpeech({ ...msg, text: intakeInput.input }, {
        gateway: stt,
        platform: "discord",
        actorKey: `discord:${bot.key}:${actor.id}`,
        uploadDir: env.UPLOAD_DIR,
      });
      for (const event of prepared.trace) {
        broadcaster.recordRunTraceEvent(taskId, { ...event, agent: persona });
      }
      if (prepared.blockedReply) {
        stopTyping();
        await discord.sendMessage(msg.target, prepared.blockedReply);
        broadcaster.pushEvent({ __harbour: "channel-activity", phase: "error", agent: persona, runId: taskId, source: origin });
        broadcaster.discardRunTrace(taskId);
        return;
      }
      for (const warning of prepared.warnings) {
        try { await discord.sendMessage(msg.target, warning); }
        catch (error) { botLogger.warn({ err: (error as Error).message }, "Discord STT 警告回发失败"); }
      }
      const ready = prepared.message;
      const activeSession = pinnedId ? runtime.sessions?.get(pinnedId) : runtime.sessions?.resolveActive(sessionKey, {
        channel: "discord",
        agentName: persona,
        origin,
      });
      broadcaster.pushEvent({
        __harbour: "channel-activity",
        phase: "incoming",
        agent: persona,
        runId: taskId,
        task: ready.text.replace(/\s+/g, " ").trim().slice(0, 320),
        input: ready.text,
        attachments: ready.attachments,
        sessionId: activeSession?.id,
        sessionKey,
        source: origin,
      });

      const task: Task = {
        id: taskId,
        agentName: persona,
        input: ready.text,
        attachments: (await prepareIncomingAttachments(ready.attachments, { platform: "discord", uploadDir: env.UPLOAD_DIR,
          maxSourceBytes: env.MAX_UPLOAD_MB * 1024 * 1024 }, botLogger)).attachments,
        // 有状态对话：带上 sessionRef，让 Harbour 记得这个频道的上文（开启 SESSIONS_ENABLED 时生效）。
        // 即使关闭跨轮 sessions 也要携带 SessionRef：runtime 会走无状态路径，但仍需可信 actor
        // 来选择私密/公开 persona 与工具权限。
        sessionRef: { id: activeSession?.id, key: sessionKey, runId: taskId, channel: "discord", authorId: msg.authorId, actor, origin },
        // 出站：从回答里抽出 Harbour 引用的图片/语音/文件，作为 Discord 附件一并发出。
        reply: (text) => {
          stopTyping();
          return sendOutgoingSegments(text, (clean, attachments) => discord.sendMessage(msg.target, clean, attachments));
        },
        onSettled: stopTyping,
        meta: { channel: "discord", accountKey: bot.key, target: msg.target, authorId: msg.authorId, sessionId: activeSession?.id, intakeTrace: prepared.trace },
      };
      if (pinnedId && !activeSession) throw new Error("原会话已删除，消息未转投其它会话");
      if (activeSession) runtime.intake.enqueue(task, `discord:${bot.key}`, { messageId: msg.messageId, paused: preparation.wasStopped(), mode: intakeInput.mode, isolated: !!intakeInput.mode });
      else queue.enqueue(task);
      } finally {
        stopTyping(); broadcaster.discardRunTrace(taskId);
        // Retire only the preparation presentation lease. Keep the legacy terminal
        // phase so already-open desktop clients don't retain an immortal activity.
        broadcaster.pushEvent({ __harbour: "channel-activity", phase: "cancelled", intakeHandoff: true, agent: persona, runId: taskId, sessionKey, source: origin, detail: "入站准备结束；处理进度见会话收件箱" });
      }
      }).catch(async error => { await discord.sendMessage(msg.target, `消息尚未提交：${(error as Error).message}`); }).finally(preparation.release);
    });

    // 原生斜杠命令（会话 + Model/Effort/Mode/Skill/GOAL）——复用同一套 SessionStore 逻辑。
    if (runtime.sessions) {
      const sessions = runtime.sessions;
      discord.setSlashHandlers({
        command: async (name, args, channelId, author) => {
          const actor = discordActor(author.id, author.name, ownerDiscordIds);
          const key = sessionKeyForActor(sessionKeyOf(channelId), actor);
          const cmd = commandFromSlash(name, args);
          if (!cmd) return "未知命令。";
          const goalControl = channelGoalControl(actor, key);
          try { const text = handleSessionCommand(sessions, key, {
            channel: "discord",
            agentName: persona,
            origin: {
              platform: "discord",
              accountKey: bot.key,
              accountLabel: bot.label,
              targetId: channelId,
              scope: "unknown",
              locationName: `频道/私信 ${channelId}`,
              authorId: author.id,
              authorName: author.name,
              actorRole: actor.role,
            },
            ...sessionConfigOptions(persona, actor.role === "owner"),
            onGoalChanged: goalControl.onGoalChanged,
          }, cmd); return { text, onSettled: goalControl.release }; }
          catch (error) { goalControl.release(false); throw error; }
        },
        autocomplete: async (name, focused, channelId, author) => {
          const actor = discordActor(author.id, author.name, ownerDiscordIds);
          if (name !== "switch" && actor.role !== "owner") return [];
          const key = sessionKeyForActor(sessionKeyOf(channelId), actor);
          const f = focused.trim().toLowerCase();
          if (name === "switch") {
            return sessions
              .listForKey(key)
              .map((s, i) => ({ name: `${i + 1}. ${s.title}`.slice(0, 100), value: String(i + 1) }))
              .filter((c) => !f || c.name.toLowerCase().includes(f))
              .slice(0, 25);
          }
          const options = sessionConfigOptions(persona, true);
          if (name === "model") {
            return [
              { name: "Auto · 跟随 Agent", value: "auto" },
              ...(options.models ?? []).map((model) => ({ name: model.label.slice(0, 100), value: model.modelRef })),
            ].filter((choice) => !f || `${choice.name} ${choice.value}`.toLowerCase().includes(f)).slice(0, 25);
          }
          if (name === "skill") {
            return [
              { name: "Auto · 自动语义路由", value: "auto" },
              ...(options.skills ?? []).map((skill) => ({ name: skill.slice(0, 100), value: skill })),
            ].filter((choice) => !f || choice.name.toLowerCase().includes(f)).slice(0, 25);
          }
          return [];
        },
      });
    }

    // askUser 在 Discord 上【不做按钮】：用户 要的是正常对话感（2026-07-21）。
    // runtime 只给 web 渠道注入 askUser，Discord 侧工具会走叙述分支，
    // agent 把问题写进回复正常问，用户 下一条消息就是答案。

    try {
      await discord.start();
      channels.push(discord);
      discordRefs.set(bot.key, discord);
      runtime.intake.setRoute(`discord:${bot.key}`, (task, output) => sendOutgoingSegments(output,
        (text, attachments) => discord.sendMessage(String(task.meta?.target), text, attachments), runtime.intake.segmentHooks(task.meta?.intakeId)));
    } catch (e) {
      botLogger.error({ err: (e as Error).message }, "Discord Bot 启动失败，跳过该实例");
    }
  };

  if (configuredDiscordBots.length) {
    // 多 Bot 独立登录；某一个失败不阻塞其它实例和 Web dashboard。
    await Promise.all(configuredDiscordBots.map((bot) => startDiscordBot(bot)));
  } else {
    logger.warn({ botKeys: discordBots.map((bot) => bot.key) }, "Discord Bot token 均未设置：跳过 Discord 渠道");
  }

  // —— QQ 官方机器人：一个 botKey = 一个独立 Gateway + 一个入口 persona。——
  // 身份只信 Open Platform openid；不同 QQ 应用的 OpenID 不互认，也不读取数字 QQ 号/密码。
  const qqRefs = scheduledQQChannels;
  const qqBots = resolveQQBotConfigs({
    ...process.env,
    QQ_BOTS: env.QQ_BOTS,
    QQBOT_APP_ID: env.QQBOT_APP_ID,
    QQBOT_APP_SECRET: env.QQBOT_APP_SECRET,
    QQBOT_AGENT: env.QQBOT_AGENT,
    QQBOT_LABEL: env.QQBOT_LABEL,
    QQBOT_ALLOWLIST: env.QQBOT_ALLOWLIST,
    OWNER_QQ_OPENIDS: env.OWNER_QQ_OPENIDS,
    QQBOT_PAIRING_CODE: env.QQBOT_PAIRING_CODE,
    QQBOT_BINDINGS_FILE: env.QQBOT_BINDINGS_FILE,
    QQBOT_REQUIRE_MENTION: String(env.QQBOT_REQUIRE_MENTION),
    QQBOT_MARKDOWN: String(env.QQBOT_MARKDOWN),
  }, env.DEFAULT_AGENT);
  const configuredQQBots = qqBots.filter((bot) => !!bot.appId && !!bot.appSecret);
  const invalidQQBot = configuredQQBots.find((bot) => !runtime.getAgent(bot.agentName));
  if (invalidQQBot) {
    throw new Error(
      `QQ Bot「${invalidQQBot.key}」绑定了不存在的 agent「${invalidQQBot.agentName}」。` +
      `可用入口：${runtime.listAgents().map((agent) => agent.name).filter((name) => name.startsWith("main-")).join(" / ")}`
    );
  }

  const startQQBot = async (bot: (typeof qqBots)[number]): Promise<void> => {
    const qqLogger = logger.child({ channel: "qq", botKey: bot.key, agent: bot.agentName });
    const qq = new QQChannel({
      botKey: bot.key,
      appId: bot.appId,
      appSecret: bot.appSecret,
      agentName: bot.agentName,
      label: bot.label,
      allowlist: parseAllowlist(bot.allowlist),
      ownerOpenids: parseOwnerQqOpenids(bot.ownerOpenids),
      pairingCode: bot.pairingCode,
      bindingsFile: bot.bindingsFile,
      requireMention: bot.requireMention,
      markdownSupport: bot.markdownSupport,
      uploadDir: env.UPLOAD_DIR,
      logger: qqLogger,
      onPairingConsumed: async () => {
        const pairingCodeKey = qqBotEnvNames(bot.key).pairingCode;
        await updateEnvValues({ [pairingCodeKey]: "" });
        // 当前进程配置只用于状态快照；同步置空避免重启前面板继续显示“已配置配对码”。
        bot.pairingCode = "";
        qqLogger.info({ envKey: pairingCodeKey }, "QQ 一次性配对码已消费并持久清空");
      },
    });
    const persona = bot.agentName;

    qq.onMessage(async (msg) => {
      // ownerOpenids() 会包含此 botKey 运行期间 `/bind` 新增的绑定，因此身份无需重启即可生效。
      const actor = qqActor(msg.authorId, msg.origin?.authorName, new Set(qq.ownerOpenids()));
      const origin = {
        platform: "qq",
        ...(msg.origin ?? {}),
        actorRole: actor.role,
      };
      const scope: "group" | "dm" = origin.scope === "group" ? "group" : "dm";
      const targetId = origin.targetId || msg.authorId;
      const sessionKey = sessionKeyForActor(qqSessionKey(bot, scope, targetId), actor);

      const cmd = parseSessionCommand(msg.text);
      if (cmd && runtime.sessions) {
        const goalControl = channelGoalControl(actor, sessionKey);
        const reply = handleSessionCommand(runtime.sessions, sessionKey, {
          channel: "qq",
          agentName: persona,
          origin,
          ...sessionConfigOptions(persona, actor.role === "owner"),
          onGoalChanged: goalControl.onGoalChanged,
        }, cmd);
        let delivered = false;
        try { await qq.sendMessage(msg.target, reply); delivered = true; } finally { goalControl.release(delivered); }
        return;
      }
      const pinnedId = runtime.sessions?.activeId(sessionKey);
      const intakeInput = parseIntakeInput(msg.text, actor.role === "owner", !!msg.attachments?.length);
      if (intakeInput.command && runtime.sessions) {
        const session = runtime.sessions.resolveActive(sessionKey, { channel: "qq", agentName: persona, origin });
        const ref = { id: session.id, key: sessionKey, channel: "qq", actor, origin };
        try {
          const handle = () => Promise.resolve(handleIntakeCommand(msg.text, runtime.intake, ref, persona,
            () => { channelRunControl.stopSession(session.id); runtime.stopGoalRun(session.id); }));
          const reply = /^\/(发完|send)(?:\s|$)/i.test(msg.text.trim()) ? await orderedIngress.run(sessionKey, handle) : await handle();
          await qq.sendMessage(msg.target, reply);
        }
        catch (error) { await qq.sendMessage(msg.target, (error as Error).message); }
        return;
      }
      if (!pinnedId || !runtime.inputs.isBusy(pinnedId)) interruptChannelGoal(actor, sessionKey);
      const preparation = runtime.intake.beginPreparation(sessionKey);
      return orderedIngress.run(sessionKey, async () => {

      const stopTyping = qq.startTyping(msg.target);
      const taskId = randomUUID().slice(0, 8);
      try {
      const hasAudio = msg.attachments?.some((attachment) => attachment.kind === "audio") === true;
      broadcaster.beginRunTrace(taskId);
      broadcaster.pushEvent({
        __harbour: "channel-activity",
        phase: "incoming",
        agent: persona,
        runId: taskId,
        task: hasAudio ? "正在转写 QQ 语音…" : msg.text.replace(/\s+/g, " ").trim().slice(0, 320),
        input: msg.text,
        sessionKey,
        source: origin,
      });
      const prepared = await prepareIncomingSpeech({ ...msg, text: intakeInput.input }, {
        gateway: stt,
        platform: "qq",
        actorKey: `qq:${bot.key}:${actor.id}`,
        uploadDir: env.UPLOAD_DIR,
      });
      for (const event of prepared.trace) {
        broadcaster.recordRunTraceEvent(taskId, { ...event, agent: persona });
      }
      if (prepared.blockedReply) {
        stopTyping();
        await qq.sendMessage(msg.target, prepared.blockedReply);
        broadcaster.pushEvent({ __harbour: "channel-activity", phase: "error", agent: persona, runId: taskId, source: origin });
        broadcaster.discardRunTrace(taskId);
        return;
      }
      for (const warning of prepared.warnings) {
        try { await qq.sendMessage(msg.target, warning); }
        catch (error) { qqLogger.warn({ err: (error as Error).message }, "QQ STT 警告回发失败"); }
      }
      const ready = prepared.message;
      const activeSession = pinnedId ? runtime.sessions?.get(pinnedId) : runtime.sessions?.resolveActive(sessionKey, {
        channel: "qq",
        agentName: persona,
        origin,
      });
      broadcaster.pushEvent({
        __harbour: "channel-activity",
        phase: "incoming",
        agent: persona,
        runId: taskId,
        task: ready.text.replace(/\s+/g, " ").trim().slice(0, 320),
        input: ready.text,
        attachments: ready.attachments,
        sessionId: activeSession?.id,
        sessionKey,
        source: origin,
      });
      const task: Task = {
        id: taskId,
        agentName: persona,
        input: ready.text,
        attachments: (await prepareIncomingAttachments(ready.attachments, { platform: "qq", uploadDir: env.UPLOAD_DIR,
          maxSourceBytes: env.MAX_UPLOAD_MB * 1024 * 1024 }, qqLogger)).attachments,
        sessionRef: { id: activeSession?.id, key: sessionKey, runId: taskId, channel: "qq", authorId: msg.authorId, actor, origin },
        reply: (text) => {
          stopTyping();
          return sendOutgoingSegments(text, (clean, attachments) => qq.sendMessage(msg.target, clean, attachments));
        },
        onSettled: stopTyping,
        meta: { channel: "qq", accountKey: bot.key, target: msg.target, authorId: msg.authorId, sessionId: activeSession?.id, intakeTrace: prepared.trace },
      };
      if (pinnedId && !activeSession) throw new Error("原会话已删除，消息未转投其它会话");
      if (activeSession) runtime.intake.enqueue(task, `qq:${bot.key}`, { messageId: msg.messageId, paused: preparation.wasStopped(), mode: intakeInput.mode, isolated: !!intakeInput.mode });
      else queue.enqueue(task);
      } finally {
        stopTyping(); broadcaster.discardRunTrace(taskId);
        broadcaster.pushEvent({ __harbour: "channel-activity", phase: "cancelled", intakeHandoff: true, agent: persona, runId: taskId, sessionKey, source: origin, detail: "入站准备结束；处理进度见会话收件箱" });
      }
      }).catch(async error => { await qq.sendMessage(msg.target, `消息尚未提交：${(error as Error).message}`); }).finally(preparation.release);
    });

    try {
      await qq.start();
      qqRefs.set(bot.key, qq);
      runtime.intake.setRoute(`qq:${bot.key}`, (task, output) => sendOutgoingSegments(output,
        (text, attachments) => qq.sendMessage(String(task.meta?.target), text, attachments), runtime.intake.segmentHooks(task.meta?.intakeId)));
      channels.push(qq);
      if (qq.ownerOpenids().length === 0) {
        qqLogger.warn("尚未绑定主人 OpenID：请私聊该机器人发送 /bind <该 Bot 的一次性配对码>");
      }
    } catch (error) {
      qqLogger.error({ err: (error as Error).message }, "QQ Bot 启动失败，跳过该实例");
    }
  };

  if (configuredQQBots.length) {
    // 每个应用独立 token cache / Gateway；某一个失败不阻塞另一个和 Web dashboard。
    await Promise.all(configuredQQBots.map((bot) => startQQBot(bot)));
  } else {
    logger.info({ botKeys: qqBots.map((bot) => bot.key) }, "QQ Bot AppID/AppSecret 均未设置：跳过 QQ 渠道");
  }

  // Start timers only after configured channels have settled, never against half-built Bot maps.
  // Management stays unavailable until loading is complete, so an early channel message cannot
  // create a job in an empty controller and then have it overwritten by init().
  await cron.init();
  await cron.ensureBuiltin({ builtin: "pricing-refresh", name: "刷新模型目录与计费表", schedule: "0 8 * * *" });
  cronController = cron;

  // Autonomous turns use the same persisted conversation and transport, not another Main.
  // Keep their delivery inside the scheduler lease; a failed send must never replay the work.
  const goalActivity = new Map<string, { task: Task; startedAt: number; stopTyping?: () => void; releaseStop: () => void }>();
  runtime.goals.subscribe(async (event) => {
    if (event.type === "goal:updated") { broadcaster.pushEvent(event); return; }
    const session = runtime.sessions?.get(event.sessionId);
    if (!session) return;
    const origin = session.origin;
    const source = session.goal?.source;
    const channel = session.channel;
    const accountKey = origin?.accountKey || "default";
    const targetId = origin?.targetId;
    const qq = channel === "qq" ? qqRefs.get(accountKey) : undefined;
    const discord = channel === "discord" ? discordRefs.get(accountKey) : undefined;
    const qqTarget = targetId ? encodeQQTarget({ scope: origin?.scope === "group" ? "group" : "c2c", targetId }) : undefined;
    const task: Task = goalActivity.get(event.runId)?.task ?? {
      id: event.runId, agentName: event.agent, input: session.goal?.nextStep?.action || session.goal?.objective || "GOAL",
      sessionRef: { id: session.id, key: session.key, channel, origin, actor: source?.actor, runId: event.runId },
      meta: { channel, sessionId: session.id },
    };
    if (event.type === "goal:start") {
      broadcaster.pushEvent(event);
      const startedAt = Date.now();
      broadcaster.beginRunTrace(event.runId);
      goalActivity.set(event.runId, { task, startedAt,
        releaseStop: channelRunControl.register(event.runId, session.id,
          () => runtime.goals.interruptRun(session.id, event.runId),
          () => pushChannelActivity(task, "stopping", "正在中止并保存断点…", startedAt)),
        stopTyping: qq && qqTarget ? qq.startTyping(qqTarget) : discord && targetId ? discord.startTyping(targetId) : undefined });
      pushChannelActivity(task, "running", "GOAL 自动推进", startedAt);
      return;
    }
    const activity = goalActivity.get(event.runId);
    activity?.releaseStop();
    pushChannelActivity(task, "running", "执行已结束，正在发送结果…", activity?.startedAt);
    const trace = broadcaster.finishRunTrace(event.runId);
    const last = session.messages.at(-1);
    if (event.type === "goal:turn" && last?.runRecord?.attemptId === event.runId) {
      runtime.sessions!.annotateLatest(session, { trace, expectMsgCount: session.messages.length,
        durationMs: activity ? Date.now() - activity.startedAt : undefined });
    } else if (event.type === "goal:error") {
      runtime.sessions!.annotateInterruptedAttempt(session, event.runId, { trace });
    }
    try {
      const answer = event.type === "goal:turn" ? event.answer
        : event.reason === "GOAL 续轮票据在调用前已失效；本轮未执行。"
          ? "⏸️ 本次 GOAL 续轮尚未执行：目标状态已变化或被新消息接管，请以会话中的目标状态为准。"
          : "⏸️ GOAL 本轮已中断，进度和断点已保留。请查看会话状态后使用 /goal resume 恢复。";
      if (channel === "qq" && qq && qqTarget) await sendOutgoingSegments(answer, (text, attachments) => qq.sendMessage(qqTarget, text, attachments));
      else if (channel === "discord" && discord && targetId) await sendOutgoingSegments(answer, (text, attachments) => discord.sendMessage(targetId, text, attachments));
      else if (channel !== "web") throw new Error("目标渠道暂不可用，结果已保留在原会话");
      if (event.type === "goal:turn") pushCompanionUtterance(task, answer);
    } catch (error) {
      if (session.goal?.status === "active") runtime.sessions!.pauseGoal(session, session.goal.id, {
        kind: "external", reason: "本轮结果已保存，但渠道发送失败；请在 Harbour 查看后恢复，不会重新执行已完成工作。",
      });
      runtime.goals.publish(session);
      logger.warn({ sessionId: session.id, err: String(error) }, "goal:channel-delivery-failed");
    } finally {
      activity?.stopTyping?.(); goalActivity.delete(event.runId);
      pushChannelActivity(task, event.type === "goal:turn" ? "complete" : "error");
      await runtime.sessions!.flushSessionDurably(session);
      broadcaster.pushEvent(event);
    }
  });

  // —— 管理 dashboard ——
  let web: { close: () => Promise<void> } | undefined;
  serviceControl = createServiceControl({ shutdown: () => shutdown(), onError: error => logger.error({ err: String(error) }, "service:restart-failed") });
  if (env.WEB_ENABLED) {
    web = startServer({
      port: env.WEB_PORT,
      host: env.WEB_HOST,
      logger,
      broadcaster,
      runtime,
      stt,
      env,
      queue,
      heartbeat,
      cron,
      channels: channels.map((c) => c.name),
      activeDiscordBotKeys: () => [...discordRefs.keys()],
      setDiscordAllowlist: (botKey, list) => {
        const discord = discordRefs.get(botKey);
        if (!discord) return false;
        discord.setAllowlist(list);
        return true;
      },
      activeQQBotKeys: () => [...qqRefs.keys()],
      qqOwnerBindingCount: (botKey) => qqRefs.get(botKey)?.ownerOpenids().length ?? 0,
      setQQAllowlist: (botKey, list) => {
        const qq = qqRefs.get(botKey);
        if (!qq) return false;
        qq.setAllowlist(list);
        return true;
      },
      startedAt,
      serviceControl,
      channelRunControl,
    });
  }

  logger.info(
    {
      agents: runtime.listAgents().map((a) => a.name),
      concurrency: env.WORKER_CONCURRENCY,
      channels: channels.map((c) => c.name),
      dashboard: env.WEB_ENABLED ? `http://localhost:${env.WEB_PORT}` : "off",
    },
    "Harbour 已启动 ✦"
  );
  runtime.goals.start();

  // —— 优雅退出 ——
  let closing = false;
  const shutdown = async () => {
    if (closing) return; // 连按两次 Ctrl-C 不该把各路 close() 跑两遍
    closing = true;
    logger.info("收到退出信号，正在关闭…");
    // 兜底闹钟：任何一步【卡住】（不是抛错，是永远不 resolve）都不能把进程钉死。
    // try/finally 只挡得住抛异常，挡不住挂起 —— 挂起时 finally 同样不执行，
    // 指标一样落不了盘。所以到点无论如何都强制走完收尾。
    const forceExit = setTimeout(() => {
      logger.warn("关闭超时（8s），强制收尾");
      runtime.metrics.close().finally(() => process.exit(0));
    }, 8_000);
    forceExit.unref?.();
    try {
      if (attachmentCleanupTimer) clearInterval(attachmentCleanupTimer);
      heartbeat.close();
      cron.close();
      await cron.flush();
      runtime.goals.stop();
      runtime.intake.close();
      await closeManagedChrome(resolveBrowserHarnessConfig(env));
      for (const c of channels) await c.stop?.();
      await web?.close();
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "关闭过程出错，继续收尾");
    } finally {
      // 必须放 finally：指标落盘有 1.5s 防抖，上面任何一步抛错都不能跳过它，
      // 否则最后这段用量每次重启都丢 —— 那正是这轮要修的 bug 之一。
      clearTimeout(forceExit);
      await runtime.metrics.close().catch((e) => logger.warn({ err: (e as Error).message }, "metrics 关停落盘失败"));
      await runtime.sessions?.flush();
    }
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
}

main().catch((e) => {
  console.error("启动失败:", e);
  process.exit(1);
});
