import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { isPrivateTownAssetPath } from "./townAssets";
import { createMinecraftApi, MINECRAFT_API_PREFIX } from "./minecraftApi";
import matter from "gray-matter";
import { previewAgentConfig } from "../config/agentConfigEditor";
import { isDelegationConfigurable } from "../core/agentDelegationStore";
import { WebSocketServer } from "ws";
import { desktopClientHub } from "../core/desktopClientHub";
import { dispatchMusic } from "../core/musicControl";
import { coworkDeviceHub, type CoworkDeviceHub } from "../core/cowork/deviceHub";
import { normalizeCoworkTarget, resolveCoworkRequest, serverDeviceInfo } from "../core/cowork/targets";
import { inspectCommandShell } from "../core/commandShell";
import type { Logger } from "pino";
import type { ChannelRunControl } from "../core/channelRunControl";
import type { Env } from "../config/env";
import type { Runtime } from "../runtime";
import type { TaskQueue } from "../scheduler/queue";
import type { LogBroadcaster } from "./logBroadcaster";
import { loadPricing, wantedModels } from "../core/pricingService";
import type { PricingRefreshWorkflowResult } from "../core/workflows/pricingRefresh";
import { readWorkflowGraph, readWorkflowGraphSource, previewWorkflowGraph, WorkflowGraphError } from "../core/workflows/workflowGraph";
import { pricingTableAt } from "../core/pricing";
import type { HeartbeatController } from "../scheduler/heartbeat";
// 技能发现与 loadAgents 共用同一实现：面板重建索引与装 system 时看到的技能必须一致。
import { loadMcpServers, scanSkills, scanSubagents, scanWorkflows } from "../config/loadAgents";
import { CronJobBusyError, type CronController } from "../scheduler/cron";
import { CronAuthorizationError } from "../scheduler/cronAuthorization";
import { CronRequestError, listCronDeliveryTargets, parseCronManagementInput, type CronManagementContext } from "../scheduler/cronManagement";
import {
  applyProposal,
  approveProposal,
  createProposal,
  listProposals,
  rejectProposal,
} from "../governance/proposalStore";
import { listSessions, readSession } from "../core/trace";
import { isOpenSessionGoal, sessionActivityAt, sessionReplyState, sessionReplyNotification, sessionLatestReplyRunId, type ChatSession } from "../core/sessionStore";
import { publicSessionGoal } from "../core/goalScheduler";
import { createSessionGoal, type GoalStartOptions } from "../core/goalState";
import {
  normalizeAgentPermissionMode,
  normalizeReasoningEffort,
  type Attachment,
  type CoworkTarget,
  type ReasoningEffort,
  type SessionRef,
} from "../types";
import { isCheckpointResumeInput } from "../core/checkpoint";
import {
  ContextWindowExceededError,
  contextOverflowMessage,
  isContextOverflowError,
} from "../core/contextOverflow";
import { estimateTextTokens, estimateToolTokens, REQUEST_ENVELOPE_RESERVE_TOKENS } from "../core/tokenEstimate";
import { filterAllowedTools } from "../core/permissions";
import { isLoopbackAddress, webOwnerActor, webRequestNeedsToken } from "../core/identity";
import { listInbox } from "../core/tools/messageAgent";
import { getNewsReport } from "../core/tools/dailyNews";
import { modelContextInfo, modelContextPolicy } from "../core/modelInfo";
import { hasMemoryRepo, memoryLog, memoryFileAt, rollbackGovernedFile } from "../governance/gitStore";
import { rebuildMemoryIndexes } from "../memory/rebuildIndexes";
import { readEnvValues, updateEnvValues } from "../core/envFile";
import {
  enabledModelsForSlot,
  ensureModelInSlot,
  readModelSlots,
  saveModelSlots,
  stableBackendKeyFor,
  type ModelSlot,
} from "../core/modelSlots";
import { refreshModelCatalogForSlot } from "../core/modelCatalog";
import { modelConnectionPresentation, providerCatalog } from "../core/providerCatalog";
import { claudeSdkEffortOptions } from "../core/backends/claudeSdkEffort";
import {
  discordBotEnvNames,
  normalizeDiscordBotKey,
  parseDiscordBotKeys,
  resolveDiscordBotConfigs,
} from "../config/discordBots";
import {
  normalizeQQBotKey,
  parseQQBotKeys,
  qqBotEnvNames,
  qqConfigured,
  resolveQQBotConfigs,
} from "../config/qqBot";
import { buildCompanionUtterance } from "../channels/companion";
import {
  readTtsGatewayConfig,
  synthesizeTts,
  ttsGatewayStatus,
  ttsProviderCatalog,
  ttsVoiceCatalog,
} from "../core/ttsGateway";
import { normalizeNamedVoice, readNamedVoices, readVoiceSelections, VOICE_ID } from "../core/ttsVoices";
import { tencentTtsSettings, tencentTtsSettingsPatch } from "../core/ttsTencent";
import { readSttGatewayConfig, type SttGateway, type SttTranscriptionResult } from "../core/sttGateway";
import { isImageInputError, prepareIncomingAttachments } from "../core/imageIntake";
import { parseIntakeInput, handleIntakeCommand } from "../channels/messageIntake";
import { PendingInputConflict } from "../core/messageIntake";
import { normalizeFileChanges } from "../core/fileChanges";
import { normalizeCalendarCards } from "../calendar/cards";
import { calendarApi, calendarCallback, CALENDAR_CALLBACK } from "../calendar/api";
import { googleApi, gmailCallback, GMAIL_CALLBACK } from "../google/api";
import { readTurnFilePreview } from "./turnFilePreview";
import { previewUpload, serveUploadFile } from "./uploadFiles";
import { defaultReasoningEffortForAgent } from "../core/modelConfigStore";
import { normalizeTimeZone } from "../core/timeZone";
import { ServiceControlError, type ServiceControl } from "../core/serviceLifecycle";
import { spacesApi } from "../spaces/api";
import type { SpaceStore } from "../spaces/store";

/**
 * 管理 dashboard 的控制层：原生 http 提供 REST + 托管静态前端（web/），
 * ws 在 /ws 推实时日志（agent loop 的每轮事件就是从这里流到前端的）。
 *
 * 设计：只读展示 + 关键写操作（运行 agent、建/改/删 agent 并热重载、mock 热切换）。
 * 加新接口 = 在 routes 里加一条；前端无需打包，直接改 web/。
 */

export interface ServerDeps {
  port: number;
  /** 监听地址；默认 0.0.0.0（树莓派/局域网/Electron 桌面端可访问同一 API）。 */
  host?: string;
  logger: Logger;
  broadcaster: LogBroadcaster;
  runtime: Runtime;
  stt: SttGateway;
  env: Env;
  queue: TaskQueue;
  heartbeat: HeartbeatController;
  cron: CronController;
  channels: string[];
  /** 当前成功登录的 Discord botKey。 */
  activeDiscordBotKeys?: () => string[];
  /** 按 botKey 热更新白名单；未运行的实例返回 false。 */
  setDiscordAllowlist?: (botKey: string, list: string[]) => boolean;
  /** 当前成功登录的 QQ botKey。 */
  activeQQBotKeys?: () => string[];
  /** 指定 Bot 已登记的主人 openid 数量（只返回数量，不下发持久绑定内容）。 */
  qqOwnerBindingCount?: (botKey: string) => number;
  /** 按 botKey 热更新 QQ sender/group openid 白名单；未运行时返回 false。 */
  setQQAllowlist?: (botKey: string, list: string[]) => boolean;
  startedAt: number;
  serviceControl?: ServiceControl;
  /** Live channel/GOAL execution leases, separate from this client's Web run. */
  channelRunControl?: ChannelRunControl;
  /** 可选注入独立设备注册表；默认复用生产 singleton。 */
  coworkHub?: CoworkDeviceHub;
  spaceStore?: SpaceStore;
}

interface ActiveWebRun {
  controller: AbortController;
  finished: Promise<void>;
  agent: string;
  sessionId?: string;
  startedAt: number;
  stopKind?: "user" | "connection" | "shutdown";
}

type RequestDeps = ServerDeps & { activeWebRuns: Map<string, ActiveWebRun>; preparingWebSessions: Set<string>;
  webRunFailures: Map<string, { sessionId: string; reason: string; at: number }>;
  minecraft: ReturnType<typeof createMinecraftApi> };

function coworkDevices(deps: ServerDeps) {
  return [serverDeviceInfo(), ...(deps.coworkHub ?? coworkDeviceHub).list().filter((device) => device.id !== "server")];
}

const WEB_DIR = path.resolve(process.cwd(), "web");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".amr": "audio/amr",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};

export function startServer(deps: ServerDeps): { close: () => Promise<void> } {
  const { logger } = deps;
  const minecraft = createMinecraftApi({
    config: () => ({ enabled: deps.env.MINECRAFT_API_ENABLED, apiKey: deps.env.MINECRAFT_API_KEY || "", allowRemote: deps.env.MINECRAFT_API_ALLOW_REMOTE }),
    getAgent: name => deps.runtime.getAgent(name),
    runAgent: (...args) => deps.runtime.runAgent(...args),
    isRestarting: () => deps.serviceControl?.snapshot().phase === "restarting",
  });
  const requestDeps: RequestDeps = { ...deps, minecraft, activeWebRuns: new Map(), preparingWebSessions: new Set(), webRunFailures: new Map() };
  // Same worker path as channels; pending Web messages continue without an open HTTP request.
  deps.runtime.intake?.setDispatch(task => deps.queue.submit(task));
  deps.runtime.intake?.setRoute("web", async () => {});

  const server = createServer((req, res) => {
    handle(req, res, requestDeps).catch((e) => {
      logger.error({ err: (e as Error).message, url: req.url }, "server:handler-error");
      const status = e instanceof CronJobBusyError ? 409 : e instanceof CronAuthorizationError ? 403 : e instanceof CronRequestError ? 400 : 500;
      if (!res.writableEnded && !res.destroyed) sendJson(res, status, { error: (e as Error).message, ...(e instanceof CronJobBusyError ? { code: e.code } : {}) });
    });
  });

  // —— WebSocket：实时日志流（鉴权开启时校验 ?token=，浏览器 WS 无法带自定义头）——
  // ask 事件走同一条 /ws（前端按 __harbour:"ask" 分流），省一条连接。
  deps.runtime.asks.onChange((ask, kind) => {
    deps.broadcaster.pushEvent({ __harbour: "ask", kind, ask });
    // ask_user 的普通问题也是角色对用户说出的内容；确认框可能含危险命令/路径，绝不朗读。
    if (kind === "new" && ask.kind === "question" && ask.agent) {
      const utterance = buildCompanionUtterance({
        agent: ask.agent,
        runId: ask.id,
        answer: ask.question,
        source: { platform: ask.channel || "web" },
        sessionKey: ask.sessionKey,
      });
      if (utterance) deps.broadcaster.pushEvent(utterance);
    }
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws, req) => {
    if (minecraft.isGameCredential(req, new URL(req.url ?? "/", "http://localhost"))) {
      ws.close(4001, "minecraft-key-cannot-access-dashboard");
      return;
    }
    if (!deps.env.WEB_AUTH_TOKEN && untrustedBrowserOrigin(req, true)) {
      ws.close(4003, "same-origin-required");
      return;
    }
    if (webRequestNeedsToken(deps.env.WEB_AUTH_TOKEN, req.socket.remoteAddress)) {
      const u = new URL(req.url ?? "/", "http://localhost");
      if (!deps.env.WEB_AUTH_TOKEN || u.searchParams.get("token") !== deps.env.WEB_AUTH_TOKEN) {
        ws.close(4001, deps.env.WEB_AUTH_TOKEN ? "unauthorized" : "remote-auth-required");
        return;
      }
    }
    deps.broadcaster.addClient(ws);
    desktopClientHub.attach(ws);
    (deps.coworkHub ?? coworkDeviceHub).attach(ws);
  });

  const host = deps.host || "0.0.0.0";
  server.listen(deps.port, host, () => {
    logger.info({ host, port: deps.port, url: `http://localhost:${deps.port}` }, "管理 dashboard 已启动 ◆");
  });

  return {
    close: async () => {
      const active = [...requestDeps.activeWebRuns.values()];
      await new Promise<void>((resolve) => {
        minecraft.close();
        for (const run of active) {
          run.stopKind = "shutdown";
          if (!run.controller.signal.aborted) run.controller.abort(new Error("server shutdown"));
        }
        // 必须【主动断开】已建立的连接，否则关不掉：server.close() 只是停止接受新连接，
        // 回调要等所有现存连接结束才触发，而 dashboard 的 /ws 是长连接、HTTP 又有 keep-alive
        // —— 于是这个 Promise 永远不 resolve，整个 shutdown 卡死，进程收到 SIGTERM 也不退出
        // （实测三个实例就是这么僵在那儿的）。连带后果：排在 shutdown 后面的 metrics 落盘
        // 永远执行不到，等于「关停不丢数据」那条修复被架空。
        for (const ws of wss.clients) {
          try { ws.terminate(); } catch { /* 已经断了 */ }
        }
        wss.close();
        server.closeAllConnections?.(); // Node 18.2+：踢掉 keep-alive 上的空闲连接
        server.close(() => resolve());
      });
      // An async-acknowledged run has no open HTTP socket for server.close() to
      // wait on. Give its normal cancellation/checkpoint path a bounded drain.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(active.map(run => run.finished)),
          new Promise<void>(resolve => { timer = setTimeout(() => {
            logger.warn({ runs: requestDeps.activeWebRuns.size }, "web:shutdown-drain-timeout"); resolve();
          }, 3_000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    },
  };
}

/* ── 路由分发 ───────────────────────────────────────────────────── */

/** A loopback socket alone is not owner authority for a request made by an arbitrary website. */
function untrustedBrowserOrigin(req: IncomingMessage, loopbackHostOnly = false): boolean {
  const origin = req.headers.origin;
  const site = req.headers["sec-fetch-site"];
  if (origin !== undefined && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return true;
  if (site !== undefined && site !== "same-origin" && site !== "none") return true;
  // Also reject DNS-rebinding origins in the tokenless local-browser convenience mode.
  // Native Electron/CLI requests without browser headers retain the existing loopback boundary.
  if (loopbackHostOnly && (origin !== undefined || site !== undefined)) {
    try {
      const host = new URL(`http://${req.headers.host}`).hostname;
      if (host !== "localhost" && host !== "[::1]" && !isLoopbackAddress(host)) return true;
    } catch { return true; }
  }
  return false;
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: RequestDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  const method = req.method ?? "GET";

  // Separate channel auth BEFORE owner/CORS handling; never mark a game request as Web owner.
  if (pathname === MINECRAFT_API_PREFIX || pathname.startsWith(`${MINECRAFT_API_PREFIX}/`)) {
    return deps.minecraft.handle(req, res, url);
  }
  if (deps.minecraft.isGameCredential(req, url)) {
    return sendJson(res, 403, { error: "Minecraft 专用密钥不能访问 Harbour 管理接口。" });
  }

  // Google redirects without Harbour auth headers. Only the one-use OAuth state authorizes this callback.
  if (pathname === CALENDAR_CALLBACK && method === "GET") return calendarCallback(res, url, deps.runtime.calendar);
  if (pathname === GMAIL_CALLBACK && method === "GET") return gmailCallback(res, url, deps.runtime.gmail);

  const guarded = (pathname.startsWith("/api/") && pathname !== "/api/health") || pathname.startsWith("/uploads/") || isPrivateTownAssetPath(pathname);
  // Protect indirect calendar access as well: Main tools and stored conversation cards use generic APIs.
  if (guarded && !deps.env.WEB_AUTH_TOKEN && untrustedBrowserOrigin(req, true)) {
    return sendJson(res, 403, { error: "本机免登录接口仅接受同源浏览器请求" });
  }

  // —— 人类确认和私人日历：同源专属，【不参与 CORS】——
  // 这条路由是「人类同意」的唯一边界：点一下就等于批准 rm -rf。默认 WEB_CORS=true 会把
  // Access-Control-Allow-Origin 原样反射请求方 Origin，等于你浏览器里打开的任意网页都能
  // 轮询到待确认命令、再 POST 一个 approve 替你点掉。所以这里【不发任何 CORS 头】
  // （跨站 fetch 读不到响应、带 application/json 的 POST 预检必失败），并显式拒掉
  // 带跨站 Origin / Sec-Fetch-Site 的请求。桌面端要用确认功能就得同源加载页面。
  if (pathname.startsWith("/api/asks") || pathname.startsWith("/api/calendar/")
    || pathname.startsWith("/api/google/") || pathname.startsWith("/api/gmail/") || pathname.startsWith("/api/maps/")
    || pathname === "/api/spaces" || pathname.startsWith("/api/spaces/")) {
    if (untrustedBrowserOrigin(req)) {
      return sendJson(res, 403, { error: "此接口仅接受同源请求" });
    }
    if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  } else if (deps.env.WEB_CORS) {
    const origin = (req.headers.origin as string) || "*";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-harbour-token");
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  // Web 是主人管理面板：本机回环可在未配置 token 时开箱即用；任何远程访问都必须先配置并携带 token。
  // 通过这道边界后 /api/run 才能可信地标记 actor=owner，不能仅凭“来源是 web”猜身份。
  if (guarded && webRequestNeedsToken(deps.env.WEB_AUTH_TOKEN, req.socket.remoteAddress)) {
    if (!deps.env.WEB_AUTH_TOKEN) {
      return sendJson(res, 401, { error: "远程访问已拒绝：请先在服务端配置 WEB_AUTH_TOKEN" });
    }
    if (!isAuthed(req, url, deps.env.WEB_AUTH_TOKEN)) {
      return sendJson(res, 401, { error: "未授权：缺少或错误的访问令牌" });
    }
  }

  if (pathname.startsWith("/api/")) {
    return handleApi(req, res, deps, url, pathname, method);
  }
  // 用户上传的多模态文件（图片/语音/文件）回放。
  if (pathname.startsWith("/uploads/")) {
    return serveUploadFile(req, res, uploadsDir(deps), pathname);
  }
  return serveStatic(res, pathname, deps.logger);
}

/** 校验访问令牌：Authorization: Bearer <t> / x-harbour-token 头 / ?token= 查询参数任一命中即可。 */
function isAuthed(req: IncomingMessage, url: URL, token: string): boolean {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ") && auth.slice(7) === token) return true;
  const x = req.headers["x-harbour-token"];
  if (typeof x === "string" && x === token) return true;
  if (url.searchParams.get("token") === token) return true;
  return false;
}

let ttsChoiceWriteTail: Promise<unknown> = Promise.resolve();
function serializeTtsChoice<T>(work: () => Promise<T>): Promise<T> {
  const next = ttsChoiceWriteTail.then(work);
  ttsChoiceWriteTail = next.catch(() => {});
  return next;
}
function voiceCatalogueFor(env: object) {
  return { ...ttsVoiceCatalog(readTtsGatewayConfig({ ...env, TTS_ENABLED: true }, true)),
    enabled: /^(true|1|yes|on)$/i.test(String((env as Record<string, unknown>).TTS_ENABLED ?? "true")) };
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RequestDeps,
  url: URL,
  pathname: string,
  method: string
): Promise<void> {
  const { runtime, env } = deps;

  if (pathname === "/api/spaces" || pathname.startsWith("/api/spaces/")) return spacesApi(req, res, url, env.UPLOAD_DIR, sendJson, deps.spaceStore);

  if (pathname.startsWith("/api/calendar/")) return calendarApi(req, res, url, runtime.calendar, readJson, sendJson);
  if (pathname.startsWith("/api/google/") || pathname.startsWith("/api/gmail/") || pathname.startsWith("/api/maps/")) {
    return googleApi(req, res, url, runtime, readJson, sendJson);
  }

  if (pathname === "/api/music/devices" && method === "GET") return sendJson(res, 200, { devices: desktopClientHub.musicDevices(url.searchParams.get('summary') === '1') });
  if (pathname === "/api/music/control" && method === "POST") {
    try { return sendJson(res, 200, { result: await dispatchMusic(await readJson(req)) }); }
    catch (error) { return sendJson(res, 400, { error: (error as Error).message }); }
  }

  if (pathname === "/api/service" && method === "GET") {
    return sendJson(res, 200, deps.serviceControl?.snapshot() ?? { restartSupported: false });
  }
  if (pathname === "/api/service/restart" && method === "POST") {
    // Lifecycle changes must not be triggered by a third-party page via ambient loopback access.
    const origin = req.headers.origin;
    if (req.headers["x-harbour-service-action"] !== "restart"
      || (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`)) {
      return sendJson(res, 403, { error: "重启只接受明确的 Harbour 管理请求。" });
    }
    if (!deps.serviceControl) return sendJson(res, 503, { error: "当前后端不支持重启接口，请更新后端。" });
    const body = await readJson(req);
    if (typeof body.instanceId !== "string" || !body.instanceId) return sendJson(res, 400, { error: "缺少目标服务实例，请重新读取状态。" });
    const busy = () => {
      const queue = deps.queue.stats();
      return queue.active > 0 || queue.queued > 0 || deps.activeWebRuns.size > 0 || deps.minecraft.activeCount() > 0
        || deps.preparingWebSessions.size > 0 || (deps.broadcaster.activeRunCount?.() ?? 0) > 0;
    };
    try { return sendJson(res, 202, await deps.serviceControl.restart(body.instanceId, busy)); }
    catch (error) { return sendJson(res, error instanceof ServiceControlError ? error.status : 503, { error: (error as Error).message }); }
  }
  if (method !== "GET" && deps.serviceControl?.snapshot().phase === "restarting") {
    return sendJson(res, 503, { error: "Harbour 后端正在重启，请连接恢复后重试。" });
  }

  // GET /api/state —— 全局快照
  if (pathname === "/api/state" && method === "GET") {
    return sendJson(res, 200, snapshot(deps));
  }

  // GET /api/health —— 轻量存活探针（Electron 启动等待 / 树莓派 systemd / 反代健康检查用）。
  if (pathname === "/api/health" && method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      uptimeMs: Date.now() - deps.startedAt,
      agents: runtime.listAgents().length,
      mock: runtime.router.isMock,
      codexHarness: {
        enabled: runtime.codexHarness.enabled,
        ready: runtime.codexHarness.ready,
        authType: runtime.codexHarness.authType ?? null,
        planType: runtime.codexHarness.planType ?? null,
        models: runtime.codexHarness.models.length,
        error: runtime.codexHarness.error ?? null,
      },
    });
  }

  // ── 入站语音转写：统一走远端 OpenAI-compatible Gateway。QQ 平台原生 ASR 不走这里。
  if (pathname === "/api/stt/status" && method === "GET") {
    return sendJson(res, 200, deps.stt.status());
  }

  if (pathname === "/api/stt/config" && method === "GET") {
    return sendJson(res, 200, sttConfigForDashboard(deps));
  }

  if (pathname === "/api/stt/config" && method === "POST") {
    const body = await readJson(req);
    const source = { ...process.env, ...(await readEnvValues()) } as Record<string, string>;
    const patch: Record<string, string> = {};
    if (typeof body.enabled === "boolean") patch.STT_ENABLED = String(body.enabled);
    for (const [bodyKey, envKey] of [
      ["url", "STT_URL"], ["provider", "STT_PROVIDER"], ["model", "STT_MODEL"],
      ["language", "STT_LANGUAGE"],
    ] as const) {
      if (typeof body[bodyKey] === "string") patch[envKey] = body[bodyKey].trim();
    }
    if (body.clearHeaders === true) patch.STT_HEADERS = "";
    else if (typeof body.headers === "string" && body.headers.trim()) patch.STT_HEADERS = body.headers.trim();
    if (body.clearFallbacks === true) patch.STT_FALLBACKS_JSON = "";
    else if (typeof body.fallbacksJson === "string" && body.fallbacksJson.trim()) {
      patch.STT_FALLBACKS_JSON = body.fallbacksJson.trim();
    }
    for (const [bodyKey, envKey] of [
      ["timeoutMs", "STT_TIMEOUT_MS"], ["maxAudioMb", "STT_MAX_AUDIO_MB"],
      ["maxSeconds", "STT_MAX_SECONDS"], ["maxConcurrency", "STT_MAX_CONCURRENCY"],
      ["maxRequestsPerMinute", "STT_MAX_REQUESTS_PER_MINUTE"],
    ] as const) {
      if (body[bodyKey] != null && body[bodyKey] !== "") {
        const value = Number(body[bodyKey]);
        if (!Number.isFinite(value) || value <= 0) return sendJson(res, 400, { error: `${bodyKey} 必须是正数` });
        patch[envKey] = String(value);
      }
    }

    let config;
    try {
      config = readSttGatewayConfig({ ...source, ...patch });
    } catch (error) {
      return sendJson(res, 400, { error: (error as Error).message });
    }
    // 把网关实际采用的边界值写回，避免 .env 留一个看似生效、实际被静默夹紧的数字。
    patch.STT_TIMEOUT_MS = String(config.timeoutMs);
    patch.STT_MAX_AUDIO_MB = String(config.maxAudioBytes / 1024 / 1024);
    patch.STT_MAX_SECONDS = String(config.maxSeconds);
    patch.STT_MAX_CONCURRENCY = String(config.maxConcurrency);
    patch.STT_MAX_REQUESTS_PER_MINUTE = String(config.maxRequestsPerMinute);
    await updateEnvValues(patch);
    for (const [key, value] of Object.entries(patch)) process.env[key] = value;
    syncSttEnv(deps.env, { ...source, ...patch }, config);
    deps.stt.updateConfig(config);
    deps.logger.info({ keys: Object.keys(patch).filter((key) => key !== "STT_HEADERS") }, "web:stt-config-hot-updated");
    return sendJson(res, 200, { ok: true, hot: true, ...sttConfigForDashboard(deps) });
  }

  if (pathname === "/api/stt/test" && method === "POST") {
    await readJson(req);
    const controller = requestAbortController(req, res);
    try {
      const result = await deps.stt.probe(controller.signal);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      if (controller.signal.aborted && (req.destroyed || res.destroyed)) return;
      return sendJson(res, 502, { error: (error as Error).message });
    }
  }

  // ── 出站语音合成：配置只留在 Harbour 后端；Electron 只收到最终音频。
  // Provider（厂家/部署）与 format（请求协议）分开，避免把 OpenAI-compatible、
  // GPT-SoVITS 或自建网关硬编码成彼此排斥的 runtime。
  if (pathname === "/api/tts/config" && method === "GET") {
    return sendJson(res, 200, ttsConfigForDashboard(deps));
  }

  if (pathname === "/api/tts/config" && method === "POST") {
    const body = await readJson(req);
    const source = { ...process.env, ...(await readEnvValues()) } as Record<string, string>;
    const patch: Record<string, string> = {};
    try { Object.assign(patch, tencentTtsSettingsPatch(body.tencentFallback)); }
    catch (error) { return sendJson(res, 400, { error: (error as Error).message }); }
    if (typeof body.enabled === "boolean") patch.TTS_ENABLED = String(body.enabled);
    for (const [bodyKey, envKey] of [
      ["url", "TTS_URL"], ["provider", "TTS_PROVIDER"], ["format", "TTS_FORMAT"],
      ["model", "TTS_MODEL"], ["voice", "TTS_VOICE"], ["ext", "TTS_EXT"],
    ] as const) {
      if (typeof body[bodyKey] === "string") patch[envKey] = body[bodyKey].trim();
    }
    if (body.clearHeaders === true) patch.TTS_HEADERS = "";
    else if (typeof body.headers === "string" && body.headers.trim()) patch.TTS_HEADERS = body.headers.trim();
    if (body.profiles != null) {
      if (!body.profiles || typeof body.profiles !== "object" || Array.isArray(body.profiles)) {
        return sendJson(res, 400, { error: "profiles 必须是以角色 ID 为键的对象" });
      }
      patch.TTS_PROFILES_JSON = JSON.stringify(body.profiles);
    }
    if (typeof body.cacheEnabled === "boolean") patch.TTS_CACHE_ENABLED = String(body.cacheEnabled);
    for (const [bodyKey, envKey] of [
      ["timeoutMs", "TTS_TIMEOUT_MS"], ["maxAudioMb", "TTS_MAX_AUDIO_MB"],
      ["cacheMaxMb", "TTS_CACHE_MAX_MB"],
    ] as const) {
      if (body[bodyKey] != null && body[bodyKey] !== "") {
        const value = Number(body[bodyKey]);
        if (!Number.isFinite(value) || value <= 0) return sendJson(res, 400, { error: `${bodyKey} 必须是正数` });
        patch[envKey] = String(value);
      }
    }

    const candidate = { ...source, ...patch };
    let validated;
    try {
      // 即使暂时关闭或尚未填写 URL，也校验 format、profiles 与边界值；用 loopback
      // 仅完成纯配置解析，不会发出网络请求。
      validated = readTtsGatewayConfig({
        ...candidate,
        TTS_ENABLED: "true",
        TTS_URL: candidate.TTS_URL || "http://127.0.0.1/tts",
      });
      if (!validated) throw new Error("TTS 配置校验失败");
    } catch (error) {
      return sendJson(res, 400, { error: (error as Error).message });
    }
    patch.TTS_TIMEOUT_MS = String(validated.timeoutMs);
    patch.TTS_MAX_AUDIO_MB = String(validated.maxAudioBytes / 1024 / 1024);
    patch.TTS_CACHE_MAX_MB = String(validated.cache.maxBytes / 1024 / 1024);
    await updateEnvValues(patch);
    for (const [key, value] of Object.entries(patch)) process.env[key] = value;
    syncTtsEnv(deps.env, { ...source, ...patch }, validated);
    deps.logger.info({ keys: Object.keys(patch).filter((key) => key !== "TTS_HEADERS") }, "web:tts-config-hot-updated");
    return sendJson(res, 200, { ok: true, hot: true, ...ttsConfigForDashboard(deps) });
  }

  if (pathname === "/api/tts/voices" && method === "GET") {
    return sendJson(res, 200, voiceCatalogueFor(env));
  }
  if ((pathname === "/api/tts/selection" || pathname === "/api/tts/voices") && method === "POST") {
    const body = await readJson(req);
    try {
      const result = await serializeTtsChoice(async () => {
        const source = { ...process.env, ...(await readEnvValues()) };
        const patch: Record<string, string> = {};
        if (pathname === "/api/tts/selection") {
          const { companionId, voiceId } = body;
          if (typeof companionId !== "string" || !/^[a-z0-9_-]{1,48}$/.test(companionId) || !runtime.getAgent(`main-${companionId}`)) throw new Error("请选择有效的 Main 角色");
          if (typeof voiceId !== "string" || !VOICE_ID.test(voiceId)
            || !voiceCatalogueFor(source).voices.some(item => item.id === voiceId && item.available)) throw new Error("音色不存在或尚未连接");
          patch.TTS_VOICE_SELECTIONS_JSON = JSON.stringify({ ...readVoiceSelections(source.TTS_VOICE_SELECTIONS_JSON), [companionId]: voiceId });
        } else {
          const voices = readNamedVoices(source.TTS_VOICES_JSON);
          const old = voices.find(item => item.id === body.id);
          const item = normalizeNamedVoice(body, old);
          const next = old ? voices.map(row => row.id === item.id ? item : row) : [...voices, item];
          if (next.length > 40) throw new Error("音色库最多保存 40 项");
          patch.TTS_VOICES_JSON = JSON.stringify(next);
        }
        await updateEnvValues(patch);
        Object.assign(process.env, patch);
        Object.assign(env, patch);
        return voiceCatalogueFor(env);
      });
      return sendJson(res, 200, result);
    } catch (error) { return sendJson(res, 400, { error: (error as Error).message }); }
  }

  if (pathname === "/api/tts/test" && method === "POST") {
    const body = await readJson(req);
    if (body.target != null && body.target !== "gateway" && body.target !== "tencent-fallback") {
      return sendJson(res, 400, { error: "无效的 TTS 试听目标" });
    }
    if (body.voiceId != null && (typeof body.voiceId !== "string" || !VOICE_ID.test(body.voiceId))) return sendJson(res, 400, { error: "无效的试听音色" });
    const config = readTtsGatewayConfig(body.target === "tencent-fallback" ? { ...env, TTS_URL: "" } : env);
    if (!config || (body.target === "tencent-fallback" && !config.tencentFallback)) return sendJson(res, 503, { error: body.target === "tencent-fallback"
      ? "请先启用 TTS 和腾讯云备用，并保存 SecretId / SecretKey" : "Harbour 后端尚未配置远端 TTS 服务" });
    const companionId = String(body.companionId || "elaina").trim().toLowerCase();
    const text = String(body.text || "今天也一起出发吧。\n").trim().slice(0, 240);
    if (!/^[a-z0-9_-]{1,48}$/.test(companionId) || !runtime.getAgent(`main-${companionId}`)) {
      return sendJson(res, 400, { error: "请选择有效的 Main 角色" });
    }
    const controller = requestAbortController(req, res);
    try {
      const audio = await synthesizeTts(config, { text, companionId, emotion: "gentle", signal: controller.signal,
        voiceId: body.target === "tencent-fallback" ? "tencent:101001" : typeof body.voiceId === "string" ? body.voiceId : undefined,
        ...(body.voiceId || body.target === "tencent-fallback" ? { allowFallback: false } : {}),
      });
      res.writeHead(200, {
        "Content-Type": audio.mime,
        "Content-Length": String(audio.data.byteLength),
        "Cache-Control": "private, no-store",
        "X-Harbour-TTS-Provider": audio.provider,
        "X-Harbour-TTS-Cache": audio.cached ? "hit" : "miss",
        "X-Harbour-TTS-Voice": audio.voiceId || "auto",
        ...(audio.fallbackFrom ? { "X-Harbour-TTS-Fallback-From": audio.fallbackFrom } : {}),
      });
      res.end(audio.data);
      return;
    } catch (error) {
      if (controller.signal.aborted && (req.destroyed || res.destroyed)) return;
      return sendJson(res, 502, { error: (error as Error).message });
    }
  }

  // Web/Electron composer 上传后先转写，结果回填输入框供用户修改；/api/run 会核验内存结果。
  if (pathname === "/api/stt/transcribe" && method === "POST") {
    const body = await readJson(req);
    const attachment = sanitizeAttachments([body.attachment])[0];
    if (!attachment || attachment.kind !== "audio") return sendJson(res, 400, { error: "缺少合法的音频附件" });
    const controller = requestAbortController(req, res);
    try {
      const result = await deps.stt.transcribeAttachment(attachment, {
        platform: "web",
        actorKey: "web-owner",
        uploadDir: deps.env.UPLOAD_DIR,
        signal: controller.signal,
      });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      if (controller.signal.aborted && (req.destroyed || res.destroyed)) return;
      deps.logger.warn({ attachment: attachment.name, err: (error as Error).message }, "web:stt-failed");
      return sendJson(res, 422, { error: (error as Error).message });
    }
  }

  // Electron 桌宠只在本机播放音频和驱动口型；推理由 Harbour 后端转发到远端 GPU 服务/云 API。
  // 这组 companion 端点不下发 URL、鉴权 header 或参考音频路径；只有经过 Dashboard 鉴权的
  // /api/tts/config 能编辑非密钥字段，header 始终只返回“是否已配置”。
  if (pathname === "/api/companion/tts/status" && method === "GET") {
    try {
      return sendJson(res, 200, ttsGatewayStatus(readTtsGatewayConfig(env)));
    } catch (error) {
      return sendJson(res, 500, {
        configured: false,
        mode: "remote",
        provider: null,
        error: (error as Error).message,
      });
    }
  }

  if (pathname === "/api/companion/tts" && method === "POST") {
    const config = readTtsGatewayConfig(env);
    if (!config) return sendJson(res, 503, { error: "Harbour 后端尚未配置远端 TTS 服务" });
    const body = await readJson(req);
    const companionId = String(body.companionId || "").trim().toLowerCase();
    const text = String(body.text || "").trim();
    const emotion = String(body.emotion || "neutral").trim().slice(0, 40);
    if (!/^[a-z0-9_-]{1,48}$/.test(companionId)) return sendJson(res, 400, { error: "无效的 companionId" });
    if (!runtime.getAgent(`main-${companionId}`)) return sendJson(res, 404, { error: `未知桌宠角色: ${companionId}` });
    if (!text || text.length > 1_200) return sendJson(res, 400, { error: "语音文本必须为 1–1200 个字符" });

    const controller = new AbortController();
    const cancel = () => controller.abort();
    req.once("aborted", cancel);
    res.once("close", () => { if (!res.writableEnded) cancel(); });
    try {
      const audio = await synthesizeTts(config, { text, companionId, emotion, signal: controller.signal });
      res.writeHead(200, {
        "Content-Type": audio.mime,
        "Content-Length": String(audio.data.byteLength),
        "Cache-Control": "private, no-store",
        "X-Harbour-TTS-Provider": audio.provider,
        "X-Harbour-TTS-Cache": audio.cached ? "hit" : "miss",
        "X-Harbour-TTS-Voice": audio.voiceId || "auto",
        ...(audio.fallbackFrom ? { "X-Harbour-TTS-Fallback-From": audio.fallbackFrom } : {}),
      });
      res.end(audio.data);
      return;
    } catch (error) {
      if (controller.signal.aborted && (req.destroyed || res.destroyed)) return;
      deps.logger.warn({ companionId, error: (error as Error).message }, "companion:tts-failed");
      return sendJson(res, 502, { error: (error as Error).message });
    }
  }

  // GET /api/metrics —— 运行指标快照（活跃 run / 最近 run / 按模型 token & 成本估算）。
  // 供 dashboard 图表消费；纯内存态，随进程重启清零。
  if (pathname === "/api/metrics" && method === "GET") {
    return sendJson(res, 200, runtime.metrics.snapshot());
  }
  // GET /api/metrics/timeseries —— 按天时间序列（overall + byModel + byAgent），持久化、重启不丢。dashboard 画图/求和用。
  if (pathname === "/api/metrics/timeseries" && method === "GET") {
    const days = Number(url.searchParams.get("days")) || 60;
    return sendJson(res, 200, runtime.metrics.timeseries(days));
  }

  // POST /api/upload —— 多模态附件落盘（base64）。前端 composer 先传文件拿回引用，再随 /api/run 发出。
  if (pathname === "/api/upload" && method === "POST") {
    const body = await readJson(req);
    return saveUpload(res, deps, body);
  }

  // 附件保留策略：默认每日自动执行；这里提供只读状态与手动立即执行入口。
  if (pathname === "/api/attachments/retention" && method === "GET") {
    return sendJson(res, 200, {
      enabled: deps.env.ATTACHMENT_RETENTION_DAYS > 0,
      retentionDays: deps.env.ATTACHMENT_RETENTION_DAYS,
      cleanupIntervalHours: deps.env.ATTACHMENT_CLEANUP_INTERVAL_HOURS,
    });
  }
  if (pathname === "/api/attachments/cleanup" && method === "POST") {
    if (!runtime.sessions) return sendJson(res, 404, { error: "会话记忆未开启" });
    const result = await runtime.sessions.cleanupExpiredAttachments(
      deps.env.UPLOAD_DIR,
      deps.env.ATTACHMENT_RETENTION_DAYS
    );
    return sendJson(res, 200, { result });
  }

  // GET /api/agents
  if (pathname === "/api/agents" && method === "GET") {
    return sendJson(res, 200, { agents: runtime.listAgents().map((a) => agentSummary(a, runtime)) });
  }

  // POST /api/agents —— 建/改 agent（写 .md 并热重载）
  if (pathname === "/api/agents" && method === "POST") {
    const body = await readJson(req);
    return saveAgent(res, deps, body);
  }

  const agentDelegationMatch = pathname.match(/^\/api\/agents\/([^/]+)\/delegation$/);
  if (agentDelegationMatch && method === "POST") {
    const name = decodeURIComponent(agentDelegationMatch[1]!);
    if (!runtime.getAgent(name)) return sendJson(res, 404, { error: `未知 agent: ${name}` });
    if (!isDelegationConfigurable(name)) return sendJson(res, 400, { error: "Main 是对话入口，不适用暂停委派开关" });
    const body = await readJson(req);
    if (typeof body.enabled !== "boolean" || Object.keys(body).some(key => key !== "enabled")) {
      return sendJson(res, 400, { error: "仅接受 enabled: true 或 false" });
    }
    await runtime.setAgentDelegationEnabled(name, body.enabled);
    return sendJson(res, 200, { ok: true, agent: name, delegationEnabled: runtime.agentDelegation.isEnabled(name) });
  }

  // GET / DELETE /api/agents/:name
  const agentConfigMatch = pathname.match(/^\/api\/agent-config\/([^/]+)\/preview$/);
  if (agentConfigMatch && method === "POST") {
    const name = decodeURIComponent(agentConfigMatch[1]!);
    if (!runtime.getAgent(name)?.agentDir) return sendJson(res, 404, { error: "找不到文件夹型 Agent" });
    const body = await readJson(req);
    try {
      // Pure draft transformation, never writes or bypasses file proposal approval.
      return sendJson(res, 200, previewAgentConfig(body.source, body.patch ?? {}));
    } catch (error) {
      return sendJson(res, 400, { error: (error as Error).message });
    }
  }

  // GET / DELETE /api/agents/:name
  const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (agentMatch) {
    const name = decodeURIComponent(agentMatch[1]!);
    if (method === "GET") {
      const a = runtime.getAgent(name);
      if (!a) return sendJson(res, 404, { error: `未知 agent: ${name}` });
      return sendJson(res, 200, { agent: { ...agentSummary(a, runtime), systemPrompt: a.systemPrompt } });
    }
    if (method === "DELETE") {
      return deleteAgent(res, deps, name);
    }
  }

  // GET /api/tools
  if (pathname === "/api/tools" && method === "GET") {
    return sendJson(res, 200, { tools: deps.runtime.registry.list() });
  }

  // GET /api/skills?agent=name
  if (pathname === "/api/skills" && method === "GET") {
    return sendJson(res, 200, { skills: await readSkills(url.searchParams.get("agent"), runtime) });
  }

  // 全局 Skill / Workflow / MCP 真身浏览器，只开放对应项目根下的文本文件；
  // 写入统一走 Governance proposal，避免再造一条无审计的直写通道。
  if (pathname === "/api/capabilities" && method === "GET") {
    return sendJson(res, 200, await capabilityOverview(runtime));
  }
  if (pathname === "/api/capabilities/file" && method === "GET") {
    return sendCapabilityFile(res, url.searchParams.get("path") || "");
  }
  const workflowGraphMatch = pathname.match(/^\/api\/workflow-graphs\/([a-z0-9-]+)(?:\/(source|proposals))?$/);
  if (workflowGraphMatch) {
    const name = workflowGraphMatch[1]!, action = workflowGraphMatch[2];
    try {
      if (!runtime.workflows.get(name)) return sendJson(res, 404, { error: "Workflow 执行器未注册；请查看契约，或重启加载新版后端" });
      if (method === "GET" && !action) return sendJson(res, 200, await readWorkflowGraph(name));
      if (method === "GET" && action === "source") return sendJson(res, 200, await readWorkflowGraphSource(name, url.searchParams.get("node") || ""));
      if (method === "POST" && action === "proposals") {
        const preview = await previewWorkflowGraph(name, await readJson(req));
        const proposal = await createProposal({ targetType: "workflow", targetPath: preview.targetPath,
          operation: "write", content: preview.content, expectedBeforeHash: preview.beforeHash,
          reason: `画布编辑 ${name}：布局、备注与已绑定的执行默认值`, sourceAgent: "web" });
        return sendJson(res, 201, { proposal, applied: false });
      }
      return sendJson(res, 405, { error: "不支持此画布操作" });
    } catch (error) {
      return sendJson(res, error instanceof WorkflowGraphError ? error.status : 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  // —— askUser：工具执行到一半停下来问人（目前只有 bash 的删除/密钥外泄档用）——
  // GET  /api/asks           当前待答提问（前端连上 WS 后拉一次补齐，因为 ask 不进日志 ring）
  // POST /api/asks/:id/answer  {answer} —— answer 可以是 option.value，也可以是「其它」的自由文本
  if (pathname === "/api/asks" && method === "GET") {
    return sendJson(res, 200, { asks: runtime.asks.list() });
  }
  const askAnswer = pathname.match(/^\/api\/asks\/([^/]+)\/answer$/);
  if (askAnswer && method === "POST") {
    const body = await readJson(req);
    const answer = String(body.answer ?? "").trim();
    if (!answer) return sendJson(res, 400, { error: "缺少 answer" });
    const ok = runtime.asks.answer(decodeURIComponent(askAnswer[1] ?? ""), answer);
    // 404 而不是静默成功：提问可能已超时/被别处答掉，前端要能把弹窗关掉并告诉人「来晚了」。
    if (!ok) return sendJson(res, 404, { error: "该提问已不存在（可能已超时或已答复）" });
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/router —— 策略表
  if (pathname === "/api/router" && method === "GET") {
    return sendJson(res, 200, { strategy: runtime.router.getStrategy() });
  }

  // An exact run lookup never starts/replays a model request. Persisted replies survive
  // a lost POST response, a page refresh and the live registry being retired.
  const webRunMatch = pathname.match(/^\/api\/runs\/([A-Za-z0-9_-]{8,64})$/);
  if (webRunMatch && method === "GET") {
    const runId = webRunMatch[1]!;
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const session = runtime.sessions?.get(sessionId);
    if (!session || session.channel !== "web") return sendJson(res, 404, { error: "Web 会话不存在", code: "RUN_SESSION_NOT_FOUND" });
    const active = deps.activeWebRuns.get(runId);
    if (active) {
      if (active.sessionId !== sessionId) return sendJson(res, 409, { error: "运行与会话不匹配", code: "RUN_SESSION_MISMATCH" });
      return sendJson(res, 200, { runId, sessionId, status: active.controller.signal.aborted ? "stopping" : "running", startedAt: active.startedAt });
    }
    const index = session.messages.findIndex(message => message.role === "assistant" &&
      (message.runRecord?.attemptId ?? message.fileChangeRunId) === runId);
    const message = session.messages[index];
    if (message) return sendJson(res, 200, { runId, sessionId, status: "settled", agent: session.agentName, answer: message.content,
      incomplete: message.runRecord?.status === "interrupted", durationMs: session.durations?.[index],
      fileChanges: normalizeFileChanges(message.fileChanges), calendarCards: normalizeCalendarCards(message.calendarCards),
      trace: session.traces?.[index] ?? [],
      session: { id: session.id, title: session.title, messageCount: index + 1, compactions: session.compactions,
        ...sessionReplyState(session), checkpoint: checkpointSummary(session.checkpoint), goal: publicGoal(session), cowork: session.cowork ?? null } });
    const failure = deps.webRunFailures.get(runId);
    if (failure?.sessionId === sessionId && Date.now() - failure.at < 30 * 60_000)
      return sendJson(res, 200, { runId, sessionId, status: "failed", error: failure.reason });
    return sendJson(res, 404, { error: "没有找到该运行的可核实结果，请查看原会话记录；不要重新提交原任务", code: "RUN_NOT_FOUND" });
  }

  // Only the explicit control endpoint stops an accepted, session-backed task.
  const abortRunMatch = pathname.match(/^\/api\/runs\/([^/]+)\/abort$/);
  if (abortRunMatch && method === "POST") {
    const runId = decodeURIComponent(abortRunMatch[1]!);
    const active = deps.activeWebRuns.get(runId);
    if (!active) return sendJson(res, 404, { error: "该运行已结束或不在此 Harbour 实例中", code: "RUN_NOT_ACTIVE" });
    const stopBody = await readJson(req);
    if (stopBody.sessionId !== undefined && stopBody.sessionId !== active.sessionId)
      return sendJson(res, 409, { error: "运行与会话不匹配，未停止任何任务", code: "RUN_SESSION_MISMATCH" });
    active.stopKind = "user";
    const goalSession = active.sessionId ? runtime.sessions?.get(active.sessionId) : undefined;
    if (goalSession) runtime.intake?.pause({ id: goalSession.id, key: goalSession.key, channel: "web", actor: webOwnerActor() }, goalSession.agentName);
    if (goalSession?.goal && isOpenSessionGoal(goalSession.goal)) {
      runtime.sessions!.pauseGoal(goalSession, goalSession.goal.id, { kind: "user", reason: "你已停止本轮，断点保留；恢复 GOAL 后继续。" });
      runtime.goals?.publish(goalSession);
    }
    if (!active.controller.signal.aborted) active.controller.abort(new Error("user stop"));
    deps.logger.info({ runId, agent: active.agent, sessionId: active.sessionId }, "web:run:explicit-stop");
    return sendJson(res, 202, { ok: true, runId, sessionId: active.sessionId, status: "stopping" });
  }

  // 渠道镜像只开放精确运行的停止，不放开发送、切换来源活跃会话或其它配置权限。
  const channelAbortMatch = pathname.match(/^\/api\/channel-runs\/([^/]+)\/abort$/);
  if (channelAbortMatch && method === "POST") {
    const runId = decodeURIComponent(channelAbortMatch[1]!);
    const body = await readJson(req);
    if (typeof body.sessionId !== "string" || !body.sessionId.trim()) {
      return sendJson(res, 400, { error: "中止必须指定原会话", code: "SESSION_REQUIRED" });
    }
    const status = deps.channelRunControl?.stop(runId, body.sessionId, () => {
      const session = runtime.sessions?.get(body.sessionId as string);
      const actor = session?.checkpoint?.actor || session?.messages.find(m => m.actor)?.actor;
      if (session && actor) runtime.intake?.pause({ id: session.id, key: session.key, channel: session.channel, actor }, session.agentName);
      if (session?.goal && isOpenSessionGoal(session.goal)) {
        runtime.sessions!.pauseGoal(session, session.goal.id, { kind: "user", reason: "你已从 Harbour 中止本轮，GOAL 同步暂停；断点保留，确认后可恢复。" });
        runtime.goals?.publish(session);
      }
    }) ?? "not_active";
    if (status === "not_active") return sendJson(res, 404, { error: "该运行已结束或不在此 Harbour 实例中", code: "RUN_NOT_ACTIVE" });
    if (status === "session_mismatch") return sendJson(res, 409, { error: "运行与会话不匹配，未停止任何任务", code: "RUN_SESSION_MISMATCH" });
    deps.logger.info({ runId, sessionId: body.sessionId }, "channel:run:explicit-stop");
    return sendJson(res, 202, { ok: true, runId, sessionId: body.sessionId, status });
  }

  // 设备接口处于同一 Web owner 鉴权边界内；设备标签只用于展示和明确的 @device 路由。
  if (pathname === "/api/cowork/devices" && method === "GET") {
    await inspectCommandShell();
    return sendJson(res, 200, { devices: coworkDevices(deps) });
  }
  const coworkDeviceMatch = pathname.match(/^\/api\/cowork\/devices\/([^/]+)$/);
  if (coworkDeviceMatch && method === "PATCH") {
    const id = decodeURIComponent(coworkDeviceMatch[1]!);
    const body = await readJson(req);
    if (typeof body.label !== "string" || !body.label.trim()) return sendJson(res, 400, { error: "设备名称不能为空" });
    if (id === "server") return sendJson(res, 400, { error: "Harbour 服务端使用固定名称；客户端设备可重命名" });
    try {
      const device = (deps.coworkHub ?? coworkDeviceHub).rename(id, body.label);
      return sendJson(res, 200, { device });
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "COWORK_INVALID_DEVICE";
      return sendJson(res, code === "COWORK_DEVICE_NOT_FOUND" ? 404 : 400, { error: (error as Error).message, code });
    }
  }

  if (pathname === "/api/message-intake/settings") {
    if (method === "GET") return sendJson(res, 200, runtime.intake.settings);
    if (method === "PATCH") {
      try { return sendJson(res, 200, runtime.intake.configure(await readJson(req))); }
      catch (error) { return sendJson(res, 400, { error: (error as Error).message }); }
    }
  }
  const intakeMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/inputs$/);
  if (intakeMatch) {
    const session = runtime.sessions?.get(decodeURIComponent(intakeMatch[1]!));
    if (!session) return sendJson(res, 404, { error: "会话不存在" });
    const ref: SessionRef = { id: session.id, key: session.key, channel: session.channel, actor: webOwnerActor(), origin: session.origin, cowork: session.cowork };
    if (method === "GET") {
      const records = runtime.intake.list(session.id, true);
      const controls = new Map(records.map(r => [r.id, runtime.intake.pendingControls(ref, session.agentName, r.id)]));
      const revision = createHash("sha256").update(JSON.stringify(records.map(r => [r.id, r.updatedAt, r.state, r.delivery, r.archived, controls.get(r.id)]))).digest("hex").slice(0, 24);
      const unchanged = url.searchParams.get("revision") === revision;
      return sendJson(res, 200, {
        revision, unchanged, recoveryError: runtime.intake.recoveryError,
        readOnly: session.channel !== "web",
        mode: session.channel === "web" ? runtime.intake.mode(ref, session.agentName) : runtime.intake.settings.defaultMode,
        busy: runtime.inputs.isBusy(session.id),
        ...(!unchanged ? { records: records.filter(r => !r.archived && (r.state !== "completed" || r.delivery !== "delivered")).slice(-256).map(r => ({ id: r.id, state: r.state, archived: r.archived, mode: r.mode, runId: r.runId, delivery: r.delivery,
          createdAt: r.createdAt, updatedAt: r.updatedAt, hold: r.hold, isolated: r.isolated, error: r.error,
          ...controls.get(r.id),
          messages: r.messages.map(t => ({ id: t.id, input: t.input, attachments: t.attachments?.map(publicAttachment) })),
          ...(r.output && r.delivery !== "delivered" ? { output: r.output } : {}) })) } : {}),
      });
    }
    const body = await readJson(req);
    if (method === "PATCH") {
      try {
        if (Object.keys(body).some(k => !["mode", "action", "id", "confirmUnknown", "revision"].includes(k)) ||
          body.action !== undefined && !["resume", "stop", "resend", "acknowledge", "withdraw", "steer"].includes(String(body.action))) throw new Error("未知收件箱操作");
        if (body.action === "withdraw" || body.action === "steer") {
          if (session.channel !== "web") return sendJson(res, 403, { error: "渠道会话为只读镜像，不能在此撤回或改投。" });
          if (typeof body.id !== "string" || !Number.isSafeInteger(body.revision) || Number(body.revision) < 1
            || body.mode !== undefined || body.confirmUnknown !== undefined) throw new Error("需要精确消息编号及版本；不同时修改会话模式");
          const record = runtime.intake.changePending(ref, session.agentName, body.id, body.action, body.revision as number);
          return sendJson(res, 200, { ok: true, id: record.id, state: record.state, mode: record.mode,
            messages: record.messages.map(t => ({ input: t.input, attachments: t.attachments?.map(publicAttachment) })) });
        }
        if (body.action === "resend" || body.action === "acknowledge") {
          const record = runtime.intake.list(session.id).find(r => r.id === body.id);
          const original = record?.messages[0]?.sessionRef;
          if (!original || original.actor?.role !== "owner") throw new Error("只能操作已验证主人的本会话回执");
          if (body.action === "resend") await runtime.intake.resend(original, record!.messages[0]!.agentName, record!.id, body.confirmUnknown === true);
          else runtime.intake.acknowledge(original, record!.messages[0]!.agentName, record!.id);
          return sendJson(res, 200, { ok: true });
        }
        if (session.channel !== "web") return sendJson(res, 403, { error: "外部渠道镜像只读；请在原渠道使用 /steer、/queue、/pending resume" });
        if (body.mode !== undefined) runtime.intake.setMode(ref, session.agentName, body.mode as "steer" | "queue");
        if (body.action === "resume") runtime.intake.resume(ref, session.agentName);
        if (body.action === "stop") {
          runtime.intake.pause(ref, session.agentName);
          deps.channelRunControl?.stopSession(session.id);
          for (const run of deps.activeWebRuns.values()) if (run.sessionId === session.id) { run.stopKind = "user"; run.controller.abort(new Error("user stop")); }
          runtime.stopGoalRun(session.id);
        }
        return sendJson(res, 200, { ok: true });
      } catch (error) { return sendJson(res, error instanceof PendingInputConflict ? 409 : 400, { error: (error as Error).message }); }
    }
    if (session.channel !== "web") return sendJson(res, 403, { error: "外部渠道镜像只读；请在原渠道发送" });
    if (method === "POST") {
      if (Object.keys(body).some(k => !["input", "attachments", "mode", "clientMessageId"].includes(k))) return sendJson(res, 400, { error: "补充不能改变模型、权限或会话配置" });
      if (typeof body.input !== "string" || typeof body.clientMessageId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(body.clientMessageId)) return sendJson(res, 400, { error: "需要输入及稳定的 clientMessageId" });
      try {
        const intakeInput = parseIntakeInput(body.input, true, Array.isArray(body.attachments) && body.attachments.length > 0);
        if (intakeInput.command) {
          const reply = handleIntakeCommand(body.input, runtime.intake, ref, session.agentName, () => {
            deps.channelRunControl?.stopSession(session.id);
            for (const run of deps.activeWebRuns.values()) if (run.sessionId === session.id) run.controller.abort(new Error("user stop"));
            runtime.stopGoalRun(session.id);
          });
          return sendJson(res, 200, { reply });
        }
        if (!intakeInput.input.trim() && !Array.isArray(body.attachments)) throw new Error("消息不能为空");
        const preparation = runtime.intake.beginPreparation(session.key);
        try {
        const prepared = await prepareIncomingAttachments(sanitizeAttachments(body.attachments), {
          platform: "web", uploadDir: env.UPLOAD_DIR, maxSourceBytes: env.MAX_UPLOAD_MB * 1024 * 1024,
        }, deps.logger);
        if (!intakeInput.input.trim() && !prepared.attachments.length) throw new Error("消息不能为空");
        if (runtime.sessions?.get(session.id) !== session) throw new Error("原会话已删除，未转投其它会话");
        const record = runtime.intake.enqueue({ id: body.clientMessageId, agentName: session.agentName, input: intakeInput.input,
          attachments: prepared.attachments, sessionRef: ref, meta: { channel: "web", sessionId: session.id } }, "web",
          { immediate: true, mode: intakeInput.mode ?? body.mode as "steer" | "queue" | undefined, isolated: !!intakeInput.mode, messageId: body.clientMessageId, paused: preparation.wasStopped() });
        return sendJson(res, 202, { id: record.id, state: record.state, mode: record.mode, isolated: record.isolated });
        } finally { preparation.release(); }
      } catch (error) { return sendJson(res, 400, { error: (error as Error).message }); }
    }
  }

  // POST /api/run —— 跑一个 agent，返回最终答案（loop 事件经 WS 实时流出）。
  // 带 session:{key,channel} = 有状态对话（跨轮记忆 + 自动压缩），返回里带 session 进度。
  if (pathname === "/api/run" && method === "POST") {
    const body = await readJson(req);
    const agent = String(body.agent ?? "");
    let input = String(body.input ?? "");
    const taskType = body.taskType ? String(body.taskType) : undefined;
    const hasModelOverride = Object.prototype.hasOwnProperty.call(body, "model");
    let modelOverride = hasModelOverride && body.model ? String(body.model) : undefined;
    const hasPermissionMode = Object.prototype.hasOwnProperty.call(body, "permissionMode") && body.permissionMode !== "";
    let permissionMode = hasPermissionMode ? normalizeAgentPermissionMode(body.permissionMode) : undefined;
    if (hasPermissionMode && !permissionMode) {
      return sendJson(res, 400, { error: `未知 permissionMode: ${String(body.permissionMode)}` });
    }
    const hasReasoningEffort = Object.prototype.hasOwnProperty.call(body, "reasoningEffort") && body.reasoningEffort !== "";
    const reasoningEffortRaw = hasReasoningEffort ? String(body.reasoningEffort ?? "").trim() : "";
    const reasoningEffort = reasoningEffortRaw ? normalizeReasoningEffort(reasoningEffortRaw) : undefined;
    if (hasReasoningEffort && reasoningEffortRaw && !reasoningEffort) {
      return sendJson(res, 400, { error: `未知 reasoningEffort: ${reasoningEffortRaw}` });
    }
    const attachments = sanitizeAttachments(body.attachments);
    // A first Web message has no active run to steer/queue. Strip a one-shot prefix
    // before the ordinary start path; subsequent/busy sends use /inputs above.
    const initialIntake = parseIntakeInput(input, true, attachments.length > 0);
    if (initialIntake.mode) input = initialIntake.input;
    const hasGoalRequest = Object.prototype.hasOwnProperty.call(body, "goal");
    const goalBody = hasGoalRequest && body.goal && typeof body.goal === "object"
      ? body.goal as Record<string, unknown>
      : null;
    if (goalBody && typeof goalBody.objective !== "string") return sendJson(res, 400, { error: "GOAL objective 必须是非空文本" });
    const goalObjective = goalBody ? (goalBody.objective as string).trim() : "";
    if (hasGoalRequest && !goalObjective) return sendJson(res, 400, { error: "GOAL 模式需要用本轮文字作为明确目标" });
    let goalOptions: GoalStartOptions | undefined;
    if (goalBody) {
      goalOptions = { autoContinue: goalBody.autoContinue === undefined ? true : goalBody.autoContinue as boolean,
        acceptance: goalBody.acceptance as string[] | undefined,
        verificationRequirement: goalBody.verificationRequirement as GoalStartOptions["verificationRequirement"],
        budget: goalBody.budget as GoalStartOptions["budget"] };
      try { createSessionGoal(goalObjective, goalOptions); } catch (error) { return sendJson(res, 400, { error: String(error) }); }
    }
    // 允许「只发附件、无文字」：有附件时 input 可空（backend 会并入附件清单）。
    if (!agent || (!input && !attachments.length)) return sendJson(res, 400, { error: "缺少 agent 或 input" });
    if (!runtime.getAgent(agent)) return sendJson(res, 404, { error: `未知 agent: ${agent}` });

    // 在任何 STT / 排队 await 之前固定会话；另一客户端切 active 不能搬走本轮输入。
    // 没有活跃会话时暂不创建：纯语音失败仍不得制造空 session。成功后只 create，绝不重读 active。
    const sb = body.session && typeof body.session === "object" && !Array.isArray(body.session)
      ? body.session as Record<string, unknown> : null;
    const sKey = sb ? String(sb.key ?? "") : "";
    const requestedSessionId = sb?.id == null ? "" : String(sb.id).trim();
    const channel = String(sb?.channel ?? "web");
    const requestActor = webOwnerActor();
    const origin = {
      platform: "web", accountKey: "harbour", accountLabel: "Harbour", scope: "web" as const,
      locationName: sKey.startsWith("web:cowork:") ? "Cowork" : sKey.startsWith("web:orb:") ? "悬浮助手" : "Main Chat",
      authorName: requestActor.displayName, actorRole: requestActor.role,
    };
    let sObj: ChatSession | null = null;
    let compBefore = 0;
    let sessionRef: SessionRef | undefined;
    if (requestedSessionId && (!sKey || !runtime.sessions)) return sendJson(res, 400, { error: "指定 session.id 需要开启会话记忆并提供 key" });
    if (sKey && runtime.sessions) {
      if (channel !== "web") return sendJson(res, 409, { error: "外部渠道会话在 Web 中仅可读取；请回原渠道回复" });
      const pinnedId = requestedSessionId || runtime.sessions.activeId(sKey);
      sObj = pinnedId ? runtime.sessions.get(pinnedId) ?? null : null;
      if (requestedSessionId && !sObj) return sendJson(res, 404, { error: `未知会话: ${requestedSessionId}` });
      if (sObj && (sObj.key !== sKey || sObj.channel !== channel)) return sendJson(res, 409, { error: "会话 key/channel 不匹配，已拒绝跨来源提交" });
      if (sObj && sObj.agentName !== agent) return sendJson(res, 409, { error: "会话 Agent 不匹配，已拒绝跨角色提交" });
      if (sObj && (deps.preparingWebSessions.has(sObj.id) || [...deps.activeWebRuns.values()].some((run) => run.sessionId === sObj!.id))) {
        return sendJson(res, 409, { error: "这条会话已有运行，请等待完成或停止后再发送", code: "SESSION_ALREADY_ACTIVE" });
      }
    }
    let requestCowork: CoworkTarget | undefined;
    try {
      const hasCowork = Object.prototype.hasOwnProperty.call(body, "cowork");
      const target = hasCowork ? normalizeCoworkTarget(body.cowork) : normalizeCoworkTarget(sObj?.cowork);
      const checkpoint = sObj?.checkpoint?.status === "interrupted" && isCheckpointResumeInput(input) ? sObj.checkpoint : null;
      requestCowork = resolveCoworkRequest(checkpoint ? "" : input, checkpoint ? normalizeCoworkTarget(checkpoint.cowork) : target, coworkDevices(deps));
      if (requestCowork && (!sKey || !runtime.sessions)) return sendJson(res, 400, { error: "Cowork 需要开启会话记忆并绑定 session" });
    } catch (error) {
      return sendJson(res, 409, { error: (error as Error).message, code: (error as { code?: string }).code || "COWORK_TARGET_UNAVAILABLE" });
    }
    let releasePreparation: (() => void) | undefined;
    if (sObj) {
      const pinnedSessionId = sObj.id;
      deps.preparingWebSessions.add(pinnedSessionId);
      const releaseIntake = runtime.inputs?.reserve(pinnedSessionId);
      let released = false;
      releasePreparation = () => { if (released) return; released = true; deps.preparingWebSessions.delete(pinnedSessionId); releaseIntake?.(); };
      const release = () => {
        if (![...deps.activeWebRuns.values()].some(run => run.sessionId === pinnedSessionId)) releasePreparation?.();
      };
      res.once("finish", release);
      res.once("close", release);
    }

    // Web/Electron 录音在发送前先转写并允许编辑；老客户端或直接 API 调用若没预转写，
    // 服务端在创建 session/标题之前补做。客户端不能伪造 Attachment.transcription。
    const sttPrepared = new Set(
      Array.isArray(body.sttPrepared)
        ? body.sttPrepared.map((value) => String(value || "")).filter(Boolean)
        : []
    );
    const sttTrace: Array<Record<string, unknown>> = [];
    let failedAudio = 0;
    const intakeAbort = new AbortController();
    const abortIntake = () => {
      if (!intakeAbort.signal.aborted) intakeAbort.abort(new Error("client connection lost"));
    };
    req.once("aborted", abortIntake);
    // 接收前断开连接必须终止转写，不能在已关闭的响应背后启动 Main。
    // 会话 UI 的提前 STOP 会保留原查询，等 run 登记后再送达精确停止请求。
    res.once("close", abortIntake);
    for (const attachment of attachments.filter((item) => item.kind === "audio")) {
      const cached = deps.stt.recentResult(attachment.url);
      if (sttPrepared.has(attachment.url)) {
        if (cached) sttTrace.push(sttTraceFromResult(cached, attachment.name));
        continue;
      }
      try {
        const result = cached ?? await deps.stt.transcribeAttachment(attachment, {
          platform: "web",
          actorKey: "web-owner",
          uploadDir: deps.env.UPLOAD_DIR,
          signal: intakeAbort.signal,
        });
        input = [input.trim(), `[语音转写 · ${result.provider}] ${result.text}`].filter(Boolean).join("\n");
        sttTrace.push(sttTraceFromResult(result, attachment.name));
      } catch (error) {
        failedAudio += 1;
        sttTrace.push({
          msg: "stt:failed",
          source: "gateway",
          attachment: attachment.name,
          err: (error as Error).message.replace(/[\r\n]+/g, " ").slice(0, 300),
        });
      }
    }
    req.off("aborted", abortIntake);
    res.off("close", abortIntake);
    if (intakeAbort.signal.aborted) return;
    const hasAudio = attachments.some((item) => item.kind === "audio");
    if (hasAudio && !input.trim()) {
      return sendJson(res, 422, { error: "语音转写文本为空；请重试转写或补充文字后再发送" });
    }
    if (failedAudio) {
      input = [input.trim(), `[系统：${failedAudio} 条语音未能转写，原音频仅供用户播放；禁止推测、杜撰其内容。]`]
        .filter(Boolean).join("\n");
    }

    // 沿用 STT 前固定的对象；无旧会话才创建一条属于本次请求的新会话。
    if (sKey && runtime.sessions) {
      sObj ??= runtime.sessions.create(sKey, { channel, agentName: agent, origin });
      if (runtime.sessions.get(sObj.id) !== sObj) return sendJson(res, 409, { error: "准备期间会话已被删除，请重新选择会话" });
      compBefore = sObj.compactions;
      sessionRef = { id: sObj.id, key: sKey, channel, actor: requestActor, origin, cowork: requestCowork };
      if (goalObjective) {
        if (channel !== "web") return sendJson(res, 400, { error: "GOAL 目前只允许在可写的 Web 会话创建" });
        sessionRef.goalObjective = goalObjective;
        sessionRef.goalOptions = goalOptions;
      }
      // 显式选择会持久化到当前会话；没有显式传入时沿用该会话上次选择。
      if (hasModelOverride) runtime.sessions.setModel(sObj.id, modelOverride);
      else if (sObj.modelRef) {
        if (buildModelList(runtime, env).some((m) => m.modelRef === sObj!.modelRef)) modelOverride = sObj.modelRef;
        else runtime.sessions.setModel(sObj.id, undefined); // 槽被删/模型下线：安全回到自动路由
      }
      if (hasPermissionMode) runtime.sessions.setPermissionMode(sObj.id, permissionMode);
      else if (sObj.permissionMode) permissionMode = sObj.permissionMode;
      const effortModelRef = modelOverride || sObj.modelRef || runtime.resolveAgentModel(agent) || "";
      if (hasReasoningEffort) {
        if (reasoningEffort && !modelSupportsReasoningEffort(runtime, env, effortModelRef, reasoningEffort)) {
          return sendJson(res, 400, { error: `${effortModelRef || "当前模型"} 不支持 Effort=${reasoningEffort}` });
        }
        runtime.sessions.setReasoningEffort(sObj.id, reasoningEffort);
      } else if (sObj.reasoningEffort && !modelSupportsReasoningEffort(runtime, env, effortModelRef, sObj.reasoningEffort)) {
        // 模型目录或会话模型改变后，旧 Effort 不兼容就自动回到模型默认，不能在运行时 400。
        runtime.sessions.setReasoningEffort(sObj.id, undefined);
      }
      sessionRef.reasoningEffort = sObj.reasoningEffort;
    }
    const resumedCheckpointId = sObj?.checkpoint?.status === "interrupted" && isCheckpointResumeInput(input)
      ? sObj.checkpoint.id
      : null;

    const requestedRunId = String(body.runId ?? "").trim();
    if (requestedRunId && !/^[A-Za-z0-9_-]{8,64}$/.test(requestedRunId)) {
      return sendJson(res, 400, { error: "runId 格式无效" });
    }
    if (goalObjective && !sessionRef) {
      return sendJson(res, 400, { error: "GOAL 需要开启会话记忆并绑定 session" });
    }
    if (requestedRunId && deps.activeWebRuns.has(requestedRunId)) {
      return sendJson(res, 409, { error: "相同 runId 已在运行；已拒绝重复提交", code: "RUN_ALREADY_ACTIVE" });
    }
    if (requestedRunId && (sObj?.messages.some(message => (message.runRecord?.attemptId ?? message.fileChangeRunId) === requestedRunId) ||
        deps.webRunFailures.has(requestedRunId))) {
      return sendJson(res, 409, { error: "该运行已有执行记录，请查询原运行；未重复执行", code: "RUN_ALREADY_SETTLED" });
    }
    const runId = requestedRunId || randomUUID().slice(0, 8);
    if (sessionRef) sessionRef.runId = runId;
    deps.logger.info({ runId, agent, attachments: attachments.length, session: sKey || null }, "web:run:start");
    const activityTask = input.replace(/\s+/g, " ").trim().slice(0, 320)
      || `发送了 ${attachments.length} 个附件`;
    const activitySource = sObj?.origin || {
      platform: sessionRef?.channel || "web",
      scope: "web" as const,
      locationName: sessionRef?.channel === "cron" ? "定时任务" : "Main Chat",
    };
    const apiRunStartedAtMs = Date.now();
    const pushActivity = (phase: "running" | "complete" | "error" | "cancelled", detail?: string) => {
      deps.broadcaster.pushEvent({
        __harbour: "channel-activity",
        phase,
        agent,
        runId,
        task: activityTask,
        input,
        detail,
        startedAt: apiRunStartedAtMs,
        sessionId: sObj?.id,
        sessionKey: sessionRef?.key,
        ...(["complete", "error"].includes(phase) && sObj ? sessionReplyNotification(runtime.sessions?.get(sObj.id), runId) : {}),
        source: activitySource,
        canStop: phase === "running" && !!sObj,
      });
    };
    let traceClosed = false;
    deps.broadcaster.beginRunTrace(runId);
    for (const event of sttTrace) deps.broadcaster.recordRunTraceEvent(runId, { ...event, agent });
    pushActivity("running");
    // Accepted Web sessions belong to the backend, not to the lifetime of one
    // renderer/fetch. Stateless calls still cancel on disconnect (no recovery target).
    const runAbort = new AbortController();
    let finishRun!: () => void;
    const finished = new Promise<void>(resolve => { finishRun = resolve; });
    deps.activeWebRuns.set(runId, {
      controller: runAbort,
      finished,
      agent,
      sessionId: sObj?.id,
      startedAt: apiRunStartedAtMs,
    });
    let settled = false;
    const releaseGoalDelivery = sObj ? runtime.goals?.hold(sObj.id) : undefined;
    let transportClosed = res.destroyed;
    const releaseDeliveredGoal = () => {
      if (settled && (transportClosed || res.writableEnded || res.destroyed)) {
        releaseGoalDelivery?.();
        res.off("finish", onGoalTransportFinished);
        res.off("close", onGoalTransportFinished);
      }
    };
    const onGoalTransportFinished = () => { transportClosed = true; releaseDeliveredGoal(); };
    res.once("finish", onGoalTransportFinished);
    res.once("close", onGoalTransportFinished);
    // 请求体未读完用 req.aborted；响应连接意外关闭用 res.close + !writableEnded。
    // 不监听 req.close：新 Node 里它也可能表示请求体正常读完，曾会误杀健康 run。
    const onClientGone = () => {
      if (settled || runAbort.signal.aborted || res.writableEnded) return;
      if (sObj && runtime.sessions?.get(sObj.id) === sObj) {
        deps.logger.info({ runId, agent, sessionId: sObj.id }, "web:run:detached（原任务继续在服务端执行，不重派）");
        return;
      }
      deps.logger.info({ runId, agent }, "web:run:client-gone→abort");
      const active = deps.activeWebRuns.get(runId);
      if (active) active.stopKind = "connection";
      runAbort.abort(new Error("client connection lost"));
    };
    req.on("aborted", onClientGone);
    res.on("close", onClientGone);
    // Opt-in async submission removes Chromium/proxy's long idle-response timeout.
    // Compatibility clients may keep waiting; either path retains the SAME run ID.
    let answer: string;
    try {
      if (sObj && /(?:^|[,;\s])respond-async(?:$|[,;\s])/i.test(String(req.headers.prefer ?? ""))) {
        res.setHeader("Preference-Applied", "respond-async");
        sendJson(res, 202, { runId, sessionId: sObj.id, status: "running", accepted: true });
      }
      answer = await runtime.runAgent(
        agent,
        input,
        taskType,
        attachments.length ? attachments : undefined,
        sessionRef,
        modelOverride,
        permissionMode,
        runAbort.signal,
        undefined,
        sessionRef ? undefined : {
          source: { channel: "web", key: sKey || "web:stateless", runId, actor: requestActor },
        }
      );
      const runTrace = deps.broadcaster.finishRunTrace(runId);
      traceClosed = true;
      if (sObj && runTrace.length) {
        runtime.sessions!.annotateLatest(sObj, { trace: runTrace, expectMsgCount: sObj.messages.length });
      }
    } catch (e) {
      const runTrace = !traceClosed ? deps.broadcaster.finishRunTrace(runId) : [];
      traceClosed = true;
      const durationMs = Date.now() - apiRunStartedAtMs;
      const reason = runAbort.signal.aborted
        ? (runAbort.signal.reason instanceof Error ? runAbort.signal.reason.message : "运行被取消")
        : (e instanceof Error ? e.message : String(e));
      if (sObj) {
        deps.webRunFailures.set(runId, { sessionId: sObj.id, reason, at: Date.now() });
        while (deps.webRunFailures.size > 128) deps.webRunFailures.delete(deps.webRunFailures.keys().next().value!);
      }
      if (sObj) {
        runtime.sessions!.annotateInterruptedAttempt(sObj, runId, { trace: runTrace, durationMs, reason });
      }
      if (runAbort.signal.aborted) {
        const active = deps.activeWebRuns.get(runId);
        const detail = active?.stopKind === "user"
          ? "已由你停止"
          : active?.stopKind === "shutdown"
            ? "服务正在重启，已保存断点"
            : "客户端连接中断，已保存断点";
        deps.logger.info({ runId, agent, stopKind: active?.stopKind }, "web:run:aborted");
        pushActivity("cancelled", detail);
        if (!res.writableEnded && !res.destroyed) {
          return sendJson(res, 499, {
            aborted: true,
            code: "RUN_ABORTED",
            reason: detail,
            runId,
            ...(sObj ? { session: { id: sObj.id, messageCount: sObj.messages.length, checkpoint: checkpointSummary(sObj.checkpoint), goal: publicGoal(sObj), cowork: sObj.cowork ?? null } } : {}),
          });
        }
        return;
      }
      if (isImageInputError(e)) {
        pushActivity("error", "图片输入不可用");
        if (!res.writableEnded && !res.destroyed) sendJson(res, 422, { error: e.message, code: "IMAGE_INPUT_ERROR" });
        return;
      }
      if (isContextOverflowError(e)) {
        const message = e instanceof ContextWindowExceededError ? e.message : contextOverflowMessage(false);
        pushActivity("error", "上下文窗口已满");
        if (!res.writableEnded && !res.destroyed) sendJson(res, 413, { error: message, code: "CONTEXT_WINDOW_EXCEEDED" });
        return;
      }
      pushActivity("error", e instanceof Error ? e.message.slice(0, 120) : "运行失败");
      throw e;
    } finally {
      settled = true;
      req.off("aborted", onClientGone);
      res.off("close", onClientGone);
      deps.activeWebRuns.delete(runId);
      releasePreparation?.();
      releaseDeliveredGoal();
      finishRun();
    }
    const session = sObj
      ? {
          id: sObj.id,
          title: sObj.title,
          compactions: sObj.compactions,
          compactedThisRun: sObj.compactions > compBefore,
          messageCount: sObj.messages.length,
          ...sessionReplyState(sObj),
          resumedFromCheckpoint: !!resumedCheckpointId && !sObj.checkpoint,
          checkpoint: checkpointSummary(sObj.checkpoint),
          goal: publicGoal(sObj),
          cowork: sObj.cowork ?? null,
          ...sessionContext(runtime, env, sObj, agent),
        }
      : undefined;
    const storedDuration = sObj?.durations?.[sObj.messages.length - 1];
    const durationMs = typeof storedDuration === "number" && Number.isFinite(storedDuration)
      ? storedDuration
      : Date.now() - apiRunStartedAtMs;
    const companionEvent = buildCompanionUtterance({
      agent,
      runId,
      answer,
      source: activitySource,
      sessionId: sObj?.id,
      sessionKey: sessionRef?.key,
    });
    if (companionEvent) deps.broadcaster.pushEvent(companionEvent);
    pushActivity("complete");
    // 以本轮 attemptId 关联，不能从全局 latest 取文件，避免另一端紧接着发消息后串轮。
    const fileChanges = normalizeFileChanges(sObj?.messages.find((message) =>
      message.role === "assistant" && (message.runRecord?.attemptId ?? message.fileChangeRunId) === runId)?.fileChanges);
    const calendarCards = normalizeCalendarCards(sObj?.messages.find((message) =>
      message.role === "assistant" && (message.runRecord?.attemptId ?? message.fileChangeRunId) === runId)?.calendarCards);
    if (!res.writableEnded && !res.destroyed) sendJson(res, 200, { runId, agent, answer, durationMs, fileChanges, calendarCards, ...(session ? { session } : {}) });
    return;
  }

  // —— 新闻简报全文（按 reportId 取回暂存全文；给 CRON「查看」按钮用，省 agent 回声全文）——
  if (pathname === "/api/news/report" && method === "GET") {
    const id = url.searchParams.get("id");
    const markdown = id ? getNewsReport(id) : undefined;
    if (markdown == null) return sendJson(res, 404, { error: "报告不存在或已过期（进程重启后暂存即失）" });
    return sendJson(res, 200, { markdown });
  }

  // —— 图片代理：服务端抓外链图片再吐回，绕过新闻站的防盗链/referrer 限制（前端 <img> 从 localhost 直连常被 403）。
  //    仅本机 dashboard 用（WEB_HOST=127.0.0.1）；限 http(s) + 图片类型 + 超时 + 大小上限，避免被当通用 SSRF。
  if (pathname === "/api/img-proxy" && method === "GET") {
    const target = url.searchParams.get("url") ?? "";
    if (!/^https?:\/\//i.test(target)) return sendText(res, 400, "bad url");
    try {
      const upstream = await fetch(target, {
        headers: { "User-Agent": "Mozilla/5.0 (Harbour news image proxy)", Referer: new URL(target).origin + "/" },
        signal: AbortSignal.timeout(10000),
      });
      const ct = upstream.headers.get("content-type") || "";
      if (!upstream.ok || !/^image\//i.test(ct)) return sendText(res, 502, "upstream not an image");
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (buf.byteLength > 8 * 1024 * 1024) return sendText(res, 413, "image too large");
      res.writeHead(200, { "Content-Type": ct, "Cache-Control": "public, max-age=86400" });
      return void res.end(buf);
    } catch {
      return sendText(res, 502, "image proxy failed");
    }
  }

  // —— 逐模型配置（effort / compact 触发线）：Settings 读写 ——
  // —— 模型计费表 ——
  // GET  /api/pricing          取表（前端据此算成本；查不到单价的模型由前端单独标出、不计入）
  // POST /api/pricing/refresh  立刻运行同一条模型目录+计价 Workflow（cron 每天 8:00 也会自动跑）
  if (pathname === "/api/pricing" && method === "GET") {
    const table = await loadPricing(deps.logger);
    // 支持运行中手工编辑 data/modelPricing.json：读取面板时同步给新 usage，历史账本不重算。
    runtime.metrics.setPricingTable(table);
    return sendJson(res, 200, { pricing: pricingTableAt(table), wanted: wantedModels(runtime) });
  }
  if (pathname === "/api/pricing/refresh" && method === "POST") {
    const result = await runtime.workflows.executeSystem("pricing-refresh", {
      action: "refresh",
      input: { trigger: "api" },
    }) as PricingRefreshWorkflowResult;
    return sendJson(res, result.ok ? 200 : 502, result);
  }

  if (pathname === "/api/models" && method === "GET") {
    return sendJson(res, 200, { models: buildModelList(runtime, env) });
  }
  if (pathname === "/api/models" && method === "POST") {
    const body = await readJson(req);
    const modelRef = String(body.modelRef ?? "");
    if (!modelRef) return sendJson(res, 400, { error: "缺少 modelRef" });
    const modelRow = buildModelList(runtime, env).find((model) => model.modelRef === modelRef);
    if (!modelRow) return sendJson(res, 400, { error: `未知或不可用模型: ${modelRef}` });
    const patch: { effort?: ReasoningEffort | null; compactTokens?: number | null } = {};
    if (body.effort !== undefined) {
      const raw = body.effort === null ? "" : String(body.effort).trim();
      const effort = raw ? normalizeReasoningEffort(raw) : undefined;
      if (raw && !effort) return sendJson(res, 400, { error: `未知 effort: ${raw}` });
      if (effort && !modelRow.supportedEfforts.includes(effort)) {
        return sendJson(res, 400, { error: `${modelRef} 不支持 Effort=${effort}` });
      }
      patch.effort = effort ?? null;
    }
    if (body.compactTokens !== undefined) {
      patch.compactTokens = body.compactTokens === null || body.compactTokens === "" ? null : Number(body.compactTokens);
    }
    const config = runtime.modelConfig.set(modelRef, patch);
    return sendJson(res, 200, { modelRef, config, models: buildModelList(runtime, env) });
  }

  // —— per-agent 运行默认：模型 + Mode 共用一份 API；旧 /api/agent-models 保留兼容。——
  const agentDefaultsPath = pathname === "/api/agent-defaults" || pathname === "/api/agent-models";
  if (agentDefaultsPath && method === "GET") {
    return sendJson(res, 200, buildAgentDefaultSettings(runtime, env));
  }
  if (agentDefaultsPath && method === "POST") {
    const body = await readJson(req);
    const agentName = String(body.agent ?? "").trim();
    const agent = runtime.getAgent(agentName);
    if (!agent) return sendJson(res, 404, { error: `未知 agent: ${agentName}` });
    const hasModel = Object.prototype.hasOwnProperty.call(body, "modelRef");
    const hasMode = Object.prototype.hasOwnProperty.call(body, "permissionMode");
    if (!hasModel && !hasMode) return sendJson(res, 400, { error: "缺少 modelRef 或 permissionMode" });
    if (hasModel) {
      const raw = body.modelRef == null ? "" : String(body.modelRef).trim();
      const modelRef = raw ? runtime.router.canonicalize(raw) : null;
      if (modelRef && !buildModelList(runtime, env).some((m) => m.modelRef === modelRef)) {
        return sendJson(res, 400, { error: `未知或不可用模型: ${modelRef}` });
      }
      runtime.agentModels.set(agentName, modelRef);
    }
    if (hasMode) {
      const raw = body.permissionMode == null ? "" : String(body.permissionMode).trim();
      const mode = raw ? normalizeAgentPermissionMode(raw) : null;
      if (raw && !mode) return sendJson(res, 400, { error: `未知 permissionMode: ${raw}` });
      runtime.agentModes.set(agentName, mode ?? null);
    }
    return sendJson(res, 200, { ok: true, ...buildAgentDefaultSettings(runtime, env) });
  }

  // —— 模型槽的 .env 编辑（主/备后端的 model id / base url / key）——
  // 决策：非密钥（model/baseURL/keyEnv）落 data/models.json；key 值仍只写 .env（keyEnv 指向的变量）。
  // 槽增删改 / key / url / model 变动均需重启后端才生效（backends 启动定死，返回 restartRequired 标记）。
  if (pathname === "/api/models/env" && method === "GET") {
    return sendJson(res, 200, {
      slots: await buildModelSlots(),
      connections: await buildModelConnections(runtime),
      providers: providerCatalog(),
    });
  }
  if (pathname === "/api/models/env" && method === "POST") {
    const body = await readJson(req);
    const action = String(body.action ?? "upsert");
    const slots = await readModelSlots();
    if (action === "refresh-models") {
      const id = String(body.id ?? "").trim();
      if (id === "codex-harness") {
        const result = await runtime.refreshCodexCatalog();
        return sendJson(res, result.ok ? 200 : 502, {
          ...result,
          restartRequired: false,
          connections: await buildModelConnections(runtime),
        });
      }
      const idx = slots.findIndex((s) => s.id === id);
      if (idx < 0) return sendJson(res, 404, { error: "槽不存在" });
      const values = await readEnvValues();
      const result = await refreshModelCatalogForSlot(slots[idx]!, values[slots[idx]!.keyEnv] ?? "", deps.logger);
      const next = slots.map((s, i) => i === idx ? result.slot : s);
      await saveModelSlots(next);
      runtime.updateModelCatalog(id, result.slot.models, result.slot.catalog);
      return sendJson(res, result.ok ? 200 : 502, { ...result, slot: undefined, slots: await buildModelSlots() });
    }
    if (action === "set-model-enabled") {
      const id = String(body.id ?? "").trim();
      const modelId = String(body.modelId ?? "").trim();
      const idx = slots.findIndex((s) => s.id === id);
      if (idx < 0) return sendJson(res, 404, { error: "槽不存在" });
      if (!modelId) return sendJson(res, 400, { error: "缺少 modelId" });
      if (modelId === slots[idx]!.model && body.enabled === false) {
        return sendJson(res, 400, { error: "默认模型不能隐藏；请先切换默认模型" });
      }
      const found = slots[idx]!.models.some((m) => m.id === modelId);
      if (!found) return sendJson(res, 404, { error: "模型不在该槽目录中" });
      const updated = { ...slots[idx]!, models: slots[idx]!.models.map((m) => m.id === modelId ? { ...m, enabled: body.enabled !== false } : m) };
      const next = slots.map((s, i) => i === idx ? updated : s);
      await saveModelSlots(next);
      runtime.updateModelCatalog(id, updated.models, updated.catalog);
      return sendJson(res, 200, { ok: true, restartRequired: false, slots: await buildModelSlots() });
    }
    if (action === "set-primary") {
      const id = String(body.id ?? "").trim();
      if (!id) return sendJson(res, 400, { error: "缺少 id" });
      const idx = slots.findIndex((s) => s.id === id);
      if (idx < 0) return sendJson(res, 404, { error: "槽不存在" });
      if (idx === 0) return sendJson(res, 200, { ok: true, restartRequired: false, slots: await buildModelSlots() });
      // 不允许把没有 key 的空槽切成主 API；否则重启后所有 agent 会先撞一个必失败端点。
      const e = await readEnvValues();
      const target = slots[idx]!;
      if (!(e[target.keyEnv] ?? "").trim()) {
        return sendJson(res, 400, { error: `模型槽「${target.label}」尚未配置 key，不能设为主 API` });
      }
      const next = [target, ...slots.slice(0, idx), ...slots.slice(idx + 1)];
      await saveModelSlots(next);
      deps.logger.warn({ id, previous: slots[0]?.id }, "web:models:set-primary（重启后生效）");
      return sendJson(res, 200, { ok: true, restartRequired: true, slots: await buildModelSlots() });
    }
    if (action === "delete") {
      const id = String(body.id ?? "");
      if (!id) return sendJson(res, 400, { error: "缺少 id" });
      if (slots[0]?.id === id) return sendJson(res, 400, { error: "主槽（第一个）不可删除" });
      const next = slots.filter((s) => s.id !== id);
      if (next.length === slots.length) return sendJson(res, 404, { error: "槽不存在" });
      await saveModelSlots(next);
      deps.logger.warn({ id }, "web:models:slot-delete（重启后生效）");
      return sendJson(res, 200, { ok: true, restartRequired: true, slots: await buildModelSlots() });
    }
    // upsert（新增或改）
    const s = body.slot && typeof body.slot === "object" ? (body.slot as Record<string, unknown>) : {};
    const id = String(s.id ?? "").trim();
    if (!id || !/^[a-z0-9_-]+$/i.test(id)) {
      return sendJson(res, 400, { error: "槽 id 必填、只能含字母数字/-/_（如 main、kimi2）" });
    }
    const idx = slots.findIndex((x) => x.id === id);
    const prev = idx >= 0 ? slots[idx]! : null;
    const keyEnv =
      (typeof s.keyEnv === "string" && s.keyEnv.trim()) ||
      prev?.keyEnv ||
      `MODEL_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_AUTH_TOKEN`;
    // ── 校验：模型槽是「把某个 env 变量的值当 Bearer 发往某个 URL」的指令，
    // 两个字段都不设限的话，一次写入就能把任意密钥（如 DISCORD_BOT_TOKEN）送去任意端点。
    // 同时这也是「绝不使用公司网关」这条要求的结构性保障——白名单之外的 host 一律拒。
    if (!/^[A-Z][A-Z0-9_]*_(API_KEY|AUTH_TOKEN)$/.test(keyEnv)) {
      return sendJson(res, 400, {
        error: `keyEnv 非法：${keyEnv}。只允许形如 XXX_API_KEY / XXX_AUTH_TOKEN 的变量名，` +
          `防止把任意环境变量（如 bot token）当密钥发出去。`,
      });
    }
    const baseURL = String(s.baseURL ?? prev?.baseURL ?? "").trim();
    if (baseURL) {
      let host = "";
      try {
        const u = new URL(baseURL);
        if (u.protocol !== "https:") throw new Error("must be https");
        host = u.hostname.toLowerCase();
      } catch {
        return sendJson(res, 400, { error: `baseURL 非法（必须是 https:// 绝对地址）：${baseURL}` });
      }
      const allowed = deps.env.MODEL_HOST_ALLOWLIST.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
      if (allowed.length && !allowed.some((a) => host === a || host.endsWith(`.${a}`))) {
        return sendJson(res, 400, {
          error: `baseURL 的 host「${host}」不在允许名单内（当前允许：${allowed.join(", ")}）。` +
            `要新增端点请改 .env 的 MODEL_HOST_ALLOWLIST——这道闸是为了防止密钥被指向非预期网关。`,
        });
      }
    }
    const selectedModel = (String(s.model ?? prev?.model ?? "default").trim()) || "default";
    let merged: ModelSlot = {
      id,
      label: String(s.label ?? prev?.label ?? id),
      model: selectedModel,
      baseURL,
      keyEnv,
      keyKind: (s.keyKind === "api" ? "api" : s.keyKind === "auth" ? "auth" : prev?.keyKind ?? "auth") as "auth" | "api",
      models: prev?.models ?? [],
      ...(prev?.catalog ? { catalog: prev.catalog } : {}),
    };
    merged = ensureModelInSlot(merged, selectedModel);
    const next = idx >= 0 ? slots.map((x, i) => (i === idx ? merged : x)) : [...slots, merged];
    await saveModelSlots(next);
    // key 值写 .env（留空=不改，避免误清空已存 key）。
    if (typeof body.key === "string" && body.key.trim() !== "") {
      await updateEnvValues({ [keyEnv]: body.key.trim() });
    }
    deps.logger.warn({ id, keyEnv, new: idx < 0 }, "web:models:slot-upsert（重启后生效）");
    return sendJson(res, 200, { ok: true, restartRequired: true, slots: await buildModelSlots() });
  }

  // One server-owned display/conversation/log clock shared by every authenticated client.
  if (pathname === "/api/time-settings" && method === "GET") {
    return sendJson(res, 200, runtime.timeSettings.snapshot());
  }
  if (pathname === "/api/time-settings" && method === "PUT") {
    const body = await readJson(req);
    let timeZone: string;
    try { timeZone = normalizeTimeZone(body.timeZone); }
    catch (error) { return sendJson(res, 400, { error: (error as Error).message }); }
    const payload = await runtime.timeSettings.set(timeZone);
    deps.broadcaster.pushEvent({ type: "time-settings:changed", payload });
    deps.logger.info({ timeZone: payload.timeZone, revision: payload.revision }, "time-settings:changed");
    return sendJson(res, 200, payload);
  }

  // —— 用户配置字段（data/config.json KV：备忘 + agent 经 get_config 按需读）——
  if (pathname === "/api/config" && method === "GET") {
    return sendJson(res, 200, { config: runtime.configStore.all() });
  }
  if (pathname === "/api/config" && method === "POST") {
    const body = await readJson(req);
    const key = String(body.key ?? "").trim();
    if (!key) return sendJson(res, 400, { error: "缺少 key" });
    runtime.configStore.set(key, String(body.value ?? ""));
    return sendJson(res, 200, { ok: true, config: runtime.configStore.all() });
  }
  if (pathname === "/api/config" && method === "DELETE") {
    const key = url.searchParams.get("key") ?? "";
    if (!key) return sendJson(res, 400, { error: "缺少 key 查询参数" });
    runtime.configStore.delete(key);
    return sendJson(res, 200, { ok: true, config: runtime.configStore.all() });
  }

  // —— Discord 多 Bot 配置 —— allowlist 可按实例热生效；身份/token 写 .env 后重启生效。
  if (pathname === "/api/channels/discord" && method === "GET") {
    const source = await readDiscordSource(env);
    const bots = resolveDiscordBotConfigs(source, env.DEFAULT_AGENT);
    const active = new Set(deps.activeDiscordBotKeys?.() ?? []);
    const primary = bots.find((bot) => bot.key === "default") ?? bots[0];
    return sendJson(res, 200, {
      configured: bots.some((bot) => !!bot.token),
      configuredCount: bots.filter((bot) => !!bot.token).length,
      bots: bots.map((bot) => ({
        key: bot.key,
        label: bot.label,
        applicationId: bot.applicationId,
        agentName: bot.agentName,
        configured: !!bot.token,
        tokenMask: maskKey(bot.token),
        allowlist: bot.allowlist,
        active: active.has(bot.key),
        hotAllowlist: active.has(bot.key) && !!deps.setDiscordAllowlist,
        legacy: bot.legacy,
      })),
      availableAgents: runtime.listAgents().map((agent) => agent.name).filter((name) => name.startsWith("main-")),
      newsBotKey: String(source.DISCORD_NEWS_BOT ?? ""),
      aiNewsChannelId: String(source.DAILY_NEWS_DISCORD_CHANNEL_ID ?? ""),
      stockNewsChannelId: String(source.STOCK_NEWS_DISCORD_CHANNEL_ID ?? ""),
      // 旧前端兼容字段；新前端使用 bots[]。
      tokenMask: maskKey(primary?.token ?? ""),
      allowlist: primary?.allowlist ?? "",
      hotAllowlist: primary ? active.has(primary.key) && !!deps.setDiscordAllowlist : false,
    });
  }
  if (pathname === "/api/channels/discord" && method === "POST") {
    const body = await readJson(req);
    const source = await readDiscordSource(env);
    const botKey = normalizeDiscordBotKey(body.botKey ?? "default");
    const names = discordBotEnvNames(botKey);
    const listed = parseDiscordBotKeys(source.DISCORD_BOTS);
    const currentBot = resolveDiscordBotConfigs(source, env.DEFAULT_AGENT).find((bot) => bot.key === botKey);
    const envPatch: Record<string, string> = {};
    let hot = false;
    let restartRequired = false;

    const currentKeys = listed.length ? listed : ["default"];
    if (!currentKeys.includes(botKey)) {
      if (listed.length) {
        envPatch.DISCORD_BOTS = [...listed, botKey].join(",");
      } else if (botKey !== "default") {
        const legacyHasData = ["DISCORD_BOT_TOKEN", "DISCORD_APPLICATION_ID", "DISCORD_ALLOWLIST", "DISCORD_BOT_LABEL"]
          .some((key) => String(source[key] ?? "").trim());
        envPatch.DISCORD_BOTS = [...(legacyHasData ? ["default"] : []), botKey].join(",");
      }
      restartRequired = true;
    }

    if (typeof body.allowlist === "string") {
      const cleaned = body.allowlist.split(",").map((x: string) => x.trim()).filter(Boolean).join(",");
      if (cleaned !== (currentBot?.allowlist ?? "")) {
        envPatch[names.allowlist] = cleaned;
        if (deps.setDiscordAllowlist) {
          hot = deps.setDiscordAllowlist(botKey, cleaned ? cleaned.split(",") : []);
        }
        if (!hot && currentBot?.token) restartRequired = true;
      }
    }
    if (typeof body.token === "string" && body.token.trim() !== "" && body.token.trim() !== currentBot?.token) {
      envPatch[names.token] = body.token.trim();
      restartRequired = true;
    }
    if (typeof body.applicationId === "string") {
      const applicationId = body.applicationId.trim();
      if (applicationId && !/^\d{16,22}$/.test(applicationId)) return sendJson(res, 400, { error: "Application ID 应为 16~22 位数字" });
      if (applicationId !== (currentBot?.applicationId ?? "")) {
        envPatch[names.applicationId] = applicationId;
        restartRequired = true;
      }
    }
    if (typeof body.agentName === "string") {
      const agentName = body.agentName.trim();
      if (!agentName || !runtime.getAgent(agentName)) return sendJson(res, 400, { error: `未知 agent: ${agentName || "（空）"}` });
      if (agentName !== currentBot?.agentName) {
        envPatch[names.agentName] = agentName;
        restartRequired = true;
      }
    }
    if (typeof body.label === "string") {
      const label = body.label.trim();
      if (label !== (currentBot?.label ?? "")) {
        envPatch[names.label] = label;
        restartRequired = true;
      }
    }
    if (typeof body.newsBotKey === "string") {
      const newsBotKey = body.newsBotKey.trim() ? normalizeDiscordBotKey(body.newsBotKey) : "";
      const futureKeys = parseDiscordBotKeys(envPatch.DISCORD_BOTS ?? source.DISCORD_BOTS);
      const selectableKeys = futureKeys.length ? futureKeys : ["default"];
      if (newsBotKey && !selectableKeys.includes(newsBotKey)) return sendJson(res, 400, { error: `新闻 Bot「${newsBotKey}」不在 DISCORD_BOTS 中` });
      if (newsBotKey !== String(source.DISCORD_NEWS_BOT ?? "")) {
        envPatch.DISCORD_NEWS_BOT = newsBotKey;
        restartRequired = true;
      }
    }
    if (typeof body.aiNewsChannelId === "string" && body.aiNewsChannelId.trim() !== String(source.DAILY_NEWS_DISCORD_CHANNEL_ID ?? "")) {
      envPatch.DAILY_NEWS_DISCORD_CHANNEL_ID = body.aiNewsChannelId.trim();
      restartRequired = true;
    }
    if (typeof body.stockNewsChannelId === "string" && body.stockNewsChannelId.trim() !== String(source.STOCK_NEWS_DISCORD_CHANNEL_ID ?? "")) {
      envPatch.STOCK_NEWS_DISCORD_CHANNEL_ID = body.stockNewsChannelId.trim();
      restartRequired = true;
    }
    if (!Object.keys(envPatch).length) return sendJson(res, 200, { ok: true, botKey, hot: false, restartRequired: false, unchanged: true });
    await updateEnvValues(envPatch);
    deps.logger.warn({ botKey, keys: Object.keys(envPatch), hot, restartRequired }, "web:channels:discord-write");
    return sendJson(res, 200, { ok: true, botKey, hot, restartRequired });
  }
  if (pathname === "/api/channels/discord" && method === "DELETE") {
    const source = await readDiscordSource(env);
    const botKey = normalizeDiscordBotKey(url.searchParams.get("botKey") ?? "default");
    const listed = parseDiscordBotKeys(source.DISCORD_BOTS);
    const currentKeys = listed.length ? listed : ["default"];
    if (!currentKeys.includes(botKey)) return sendJson(res, 404, { error: `Discord Bot「${botKey}」不存在` });
    const names = discordBotEnvNames(botKey);
    const envPatch: Record<string, string> = {
      [names.token]: "",
      [names.applicationId]: "",
      [names.allowlist]: "",
      [names.label]: "",
    };
    if (botKey !== "default") envPatch[names.agentName] = "";
    if (listed.length) envPatch.DISCORD_BOTS = listed.filter((key) => key !== botKey).join(",");
    if (String(source.DISCORD_NEWS_BOT ?? "") === botKey) envPatch.DISCORD_NEWS_BOT = "";
    await updateEnvValues(envPatch);
    deps.logger.warn({ botKey, keys: Object.keys(envPatch) }, "web:channels:discord-delete（重启后生效）");
    return sendJson(res, 200, { ok: true, botKey, restartRequired: true });
  }

  // —— QQ 官方机器人多账号配置 —— 一个 botKey 固定绑定一个 Main；拒绝个人 QQ 账号密码。
  if (pathname === "/api/channels/qq" && method === "GET") {
    const source = await readQQSource(env);
    const bots = resolveQQBotConfigs(source, env.DEFAULT_AGENT);
    const activeBotKeys = deps.activeQQBotKeys?.() ?? [];
    return sendJson(res, 200, {
      configured: bots.some(qqConfigured),
      configuredCount: bots.filter(qqConfigured).length,
      activeBotKeys,
      bots: bots.map((bot) => ({
        key: bot.key,
        label: bot.label,
        appId: bot.appId,
        appSecretMask: maskKey(bot.appSecret),
        agentName: bot.agentName,
        allowlist: bot.allowlist,
        ownerOpenids: bot.ownerOpenids,
        pairingConfigured: !!bot.pairingCode,
        persistedOwnerCount: deps.qqOwnerBindingCount?.(bot.key) ?? 0,
        requireMention: bot.requireMention,
        markdownSupport: bot.markdownSupport,
        configured: qqConfigured(bot),
        active: activeBotKeys.includes(bot.key),
        hotAllowlist: activeBotKeys.includes(bot.key),
      })),
      availableAgents: runtime.listAgents().map((agent) => agent.name).filter((name) => name.startsWith("main-")),
      platformUrl: "https://q.qq.com/",
    });
  }
  if (pathname === "/api/channels/qq" && method === "POST") {
    const body = await readJson(req);
    if (body.password != null || body.qqPassword != null || body.qqNumber != null || body.account != null) {
      return sendJson(res, 400, { error: "Harbour 不接收个人 QQ 号或密码；请使用 QQ 开放平台 AppID + AppSecret" });
    }
    const source = await readQQSource(env);
    const botKey = normalizeQQBotKey(body.botKey ?? "default");
    const listed = parseQQBotKeys(source.QQ_BOTS);
    const currentKeys = listed.length ? listed : ["default"];
    const nextKeys = currentKeys.includes(botKey) ? currentKeys : [...currentKeys, botKey];
    const configs = resolveQQBotConfigs({ ...source, QQ_BOTS: nextKeys.join(",") }, env.DEFAULT_AGENT);
    const current = configs.find((bot) => bot.key === botKey)!;
    const names = qqBotEnvNames(botKey);
    const envPatch: Record<string, string> = {};
    let restartRequired = false;
    let hot = false;

    if (!currentKeys.includes(botKey)) {
      envPatch.QQ_BOTS = nextKeys.join(",");
      restartRequired = true;
    }
    if (typeof body.appId === "string") {
      const appId = body.appId.trim();
      if (appId && !/^\d{5,32}$/.test(appId)) return sendJson(res, 400, { error: "QQ Bot AppID 应为数字" });
      if (appId !== current.appId) {
        envPatch[names.appId] = appId;
        restartRequired = true;
      }
    }
    if (body.clearAppSecret === true) {
      if (current.appSecret) {
        envPatch[names.appSecret] = "";
        restartRequired = true;
      }
    } else if (typeof body.appSecret === "string" && body.appSecret.trim() && body.appSecret.trim() !== current.appSecret) {
      envPatch[names.appSecret] = body.appSecret.trim();
      restartRequired = true;
    }
    if (typeof body.agentName === "string") {
      const agentName = body.agentName.trim();
      if (!agentName || !runtime.getAgent(agentName)) return sendJson(res, 400, { error: `未知 agent: ${agentName || "（空）"}` });
      if (agentName !== current.agentName) {
        envPatch[names.agentName] = agentName;
        restartRequired = true;
      }
    }
    if (typeof body.label === "string" && body.label.trim() !== current.label) {
      envPatch[names.label] = body.label.trim();
      restartRequired = true;
    }
    if (typeof body.allowlist === "string") {
      const allowlist = body.allowlist.split(",").map((item: string) => item.trim()).filter(Boolean).join(",");
      if (allowlist !== current.allowlist) {
        envPatch[names.allowlist] = allowlist;
        hot = deps.setQQAllowlist?.(botKey, allowlist ? allowlist.split(",") : []) === true;
        if (!hot && current.appId && current.appSecret) restartRequired = true;
      }
    }
    if (typeof body.ownerOpenids === "string") {
      const owners = body.ownerOpenids.split(",").map((item: string) => item.trim()).filter(Boolean).join(",");
      if (owners !== current.ownerOpenids) {
        envPatch[names.ownerOpenids] = owners;
        restartRequired = true;
      }
    }
    if (body.clearPairingCode === true) {
      if (current.pairingCode) {
        envPatch[names.pairingCode] = "";
        restartRequired = true;
      }
    } else if (typeof body.pairingCode === "string" && body.pairingCode.trim() && body.pairingCode.trim() !== current.pairingCode) {
      if (body.pairingCode.trim().length < 8) return sendJson(res, 400, { error: "一次性配对码至少 8 个字符" });
      envPatch[names.pairingCode] = body.pairingCode.trim();
      restartRequired = true;
    }
    if (typeof body.requireMention === "boolean" && body.requireMention !== current.requireMention) {
      envPatch[names.requireMention] = String(body.requireMention);
      restartRequired = true;
    }
    if (typeof body.markdownSupport === "boolean" && body.markdownSupport !== current.markdownSupport) {
      envPatch[names.markdownSupport] = String(body.markdownSupport);
      restartRequired = true;
    }

    if (!Object.keys(envPatch).length) {
      return sendJson(res, 200, { ok: true, botKey, hot: false, restartRequired: false, unchanged: true });
    }
    await updateEnvValues(envPatch);
    deps.logger.warn({ botKey, keys: Object.keys(envPatch), hot, restartRequired }, "web:channels:qq-write");
    return sendJson(res, 200, { ok: true, botKey, hot, restartRequired });
  }
  if (pathname === "/api/channels/qq" && method === "DELETE") {
    const source = await readQQSource(env);
    const botKey = normalizeQQBotKey(url.searchParams.get("botKey") ?? "default");
    const listed = parseQQBotKeys(source.QQ_BOTS);
    const currentKeys = listed.length ? listed : ["default"];
    if (!currentKeys.includes(botKey)) return sendJson(res, 404, { error: `QQ Bot「${botKey}」不存在` });
    const names = qqBotEnvNames(botKey);
    const envPatch: Record<string, string> = {
      [names.appId]: "",
      [names.appSecret]: "",
      [names.agentName]: "",
      [names.label]: "",
      [names.allowlist]: "",
      [names.ownerOpenids]: "",
      [names.pairingCode]: "",
      [names.requireMention]: "",
      [names.markdownSupport]: "",
    };
    if (listed.length) envPatch.QQ_BOTS = listed.filter((key) => key !== botKey).join(",");
    await updateEnvValues(envPatch);
    deps.logger.warn({ botKey, keys: Object.keys(envPatch) }, "web:channels:qq-delete（本地 OpenID 绑定记录保留；重启后断开）");
    return sendJson(res, 200, { ok: true, botKey, restartRequired: true, bindingsPreserved: true });
  }

  // —— 会话记忆（跨轮 session：列出 / 新开 / 切换 / 读历史）——
  // 注意：区别于下方 /api/sessions（那是只读的 run trace）。
  if (pathname === "/api/conversations/explorer" && method === "GET") {
    if (!runtime.sessions) return sendJson(res, 200, { enabled: false, sessions: [] });
    const agentName = url.searchParams.get("agentName") || deps.env.DEFAULT_AGENT;
    return sendJson(res, 200, {
      enabled: true,
      agentName,
      sessions: runtime.sessions.listForAgent(agentName).map((s) => ({
        ...sessionSummary(s, runtime.sessions!.activeId(s.key)),
        ...sessionContext(runtime, env, s, s.agentName),
      })),
    });
  }
  if (pathname === "/api/conversations" && method === "GET") {
    if (!runtime.sessions) return sendJson(res, 200, { enabled: false, sessions: [], activeId: null });
    const key = url.searchParams.get("key");
    if (!key) return sendJson(res, 400, { error: "缺少 key 查询参数（如 web:default）" });
    return sendJson(res, 200, {
      enabled: true,
      key,
      activeId: runtime.sessions.activeId(key) ?? null,
      sessions: runtime.sessions.listForKey(key).map((s) => ({
        ...sessionSummary(s, runtime.sessions!.activeId(key)),
        ...sessionContext(runtime, env, s, s.agentName),
      })),
    });
  }
  if (pathname === "/api/conversations/new" && method === "POST") {
    if (!runtime.sessions) return sendJson(res, 400, { error: "会话记忆未开启（SESSIONS_ENABLED=false）" });
    const body = await readJson(req);
    const key = String(body.key ?? "");
    if (!key) return sendJson(res, 400, { error: "缺少 key" });
    const s = runtime.sessions.create(key, {
      channel: String(body.channel ?? "web"),
      agentName: String(body.agentName ?? deps.env.DEFAULT_AGENT),
    });
    return sendJson(res, 201, { session: { ...sessionDetail(s, s.id), ...sessionContext(runtime, env, s, s.agentName) } });
  }
  // 给某会话附加展示态数据（todo 计划 / 本轮运行轨迹）。纯展示，不进 LLM 上下文。
  // 前端在收到 plan:submitted、以及每轮 run 结束后调用，实现切会话/刷新后仍能看到。
  if (pathname === "/api/conversations/annotate" && method === "POST") {
    if (!runtime.sessions) return sendJson(res, 400, { error: "会话记忆未开启（SESSIONS_ENABLED=false）" });
    const body = await readJson(req);
    const id = String(body.id ?? "");
    if (!id) return sendJson(res, 400, { error: "缺少 id" });
    const s = runtime.sessions.get(id);
    if (!s) return sendJson(res, 404, { error: `未知会话: ${id}` });
    // 归属校验：id + key 必须匹配（与 /switch 一致），别让已鉴权客户端按 id 覆写任意会话。
    if (body.key && s.key !== String(body.key)) return sendJson(res, 400, { error: "会话 key 不匹配" });
    const patch: { plan?: unknown; trace?: unknown[] | null; expectMsgCount?: number } = {};
    if ("plan" in body) patch.plan = body.plan;
    if (Array.isArray(body.trace)) patch.trace = body.trace as unknown[];
    if (typeof body.expectMsgCount === "number") patch.expectMsgCount = body.expectMsgCount;
    runtime.sessions.annotateLatest(s, patch);
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === "/api/conversations/switch" && method === "POST") {
    if (!runtime.sessions) return sendJson(res, 400, { error: "会话记忆未开启（SESSIONS_ENABLED=false）" });
    const body = await readJson(req);
    const key = String(body.key ?? "");
    const id = String(body.id ?? "");
    if (!key || !id) return sendJson(res, 400, { error: "缺少 key 或 id" });
    try {
      const s = runtime.sessions.switchActive(key, id);
      return sendJson(res, 200, { session: { ...sessionDetail(s, s.id, body.view === "chat"), ...sessionContext(runtime, env, s, s.agentName) } });
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
  }
  const readMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/read$/);
  if (readMatch && method === "POST") {
    const store = runtime.sessions;
    const session = store?.get(decodeURIComponent(readMatch[1]!));
    if (!store || !session) return sendJson(res, 404, { error: "会话不存在或会话记忆未开启" });
    const body = await readJson(req);
    if (body.key !== session.key) return sendJson(res, 400, { error: "会话 key 不匹配" });
    try {
      const before = sessionReplyState(session).readReplyRevision;
      store.markRepliesRead(session.id, body.replyRevision as number);
      const replyRunId = sessionLatestReplyRunId(session);
      const reading = { id: session.id, ...sessionReplyState(session), ...(replyRunId ? { replyRunId } : {}) };
      if (reading.readReplyRevision !== before) deps.broadcaster.pushEvent({ __harbour: "session-read", ...reading });
      return sendJson(res, 200, reading);
    } catch (error) {
      return sendJson(res, 400, { error: (error as Error).message });
    }
  }
  const checkpointMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/checkpoint$/);
  if (checkpointMatch && method === "DELETE") {
    if (!runtime.sessions) return sendJson(res, 404, { error: "会话记忆未开启" });
    const id = decodeURIComponent(checkpointMatch[1]!);
    const session = runtime.sessions.get(id);
    if (!session) return sendJson(res, 404, { error: `未知会话: ${id}` });
    try {
      const discarded = runtime.sessions.discardCheckpoint(session);
      return sendJson(res, 200, {
        discarded,
        session: sessionDetail(session, runtime.sessions.activeId(session.key)),
      });
    } catch (error) {
      return sendJson(res, 409, { error: (error as Error).message });
    }
  }
  const goalMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/goal$/);
  if (goalMatch && method === "POST") {
    if (!runtime.sessions) return sendJson(res, 404, { error: "会话记忆未开启" });
    const id = decodeURIComponent(goalMatch[1]!);
    const session = runtime.sessions.get(id);
    if (!session) return sendJson(res, 404, { error: `未知会话: ${id}` });
    if (session.channel !== "web") return sendJson(res, 409, { error: "外部渠道镜像不能从 Web 修改 GOAL" });
    const body = await readJson(req);
    const action = String(body.action || "");
    try {
      const goal = session.goal;
      if (!goal) throw new Error("当前会话没有 GOAL");
      if (body.goalId !== goal.id || body.expectedRevision !== goal.revision) throw new Error("GOAL 已变化，请刷新后重试（旧目标或旧版本）");
      if (action === "complete" || action === "cancel") {
        runtime.sessions.setGoalStatus(session, action === "complete" ? "completed" : "cancelled", String(body.progress || ""));
        runtime.stopGoalRun?.(id, "user stop");
      } else if (action === "pause") {
        runtime.sessions.pauseGoal(session, goal.id, { kind: "user", reason: "你已暂停目标；当前运行停止，断点保留。" }, goal.revision);
        runtime.stopGoalRun?.(id, "user stop");
      } else if (action === "resume") {
        runtime.sessions.resumeGoal(session, goal.id, goal.revision);
      } else if (action === "configure") {
        runtime.sessions.configureGoal(session, goal.id, {
          autoContinue: body.autoContinue as boolean | undefined, acceptance: body.acceptance as string[] | undefined,
          verificationRequirement: body.verificationRequirement as GoalStartOptions["verificationRequirement"],
          budget: body.budget as GoalStartOptions["budget"],
        }, goal.revision);
      } else return sendJson(res, 400, { error: "action 只能是 complete / cancel / pause / resume / configure；新 GOAL 随 /api/run 创建" });
      await runtime.sessions.flushSessionDurably(session);
      runtime.goals?.publish(session);
      runtime.goals?.nudge(id);
      return sendJson(res, 200, { session: sessionDetail(session, runtime.sessions.activeId(session.key)) });
    } catch (error) {
      return sendJson(res, 409, { error: (error as Error).message });
    }
  }
  if (pathname === "/api/files/preview" && method === "GET") {
    return previewUpload(res, uploadsDir(deps), url.searchParams.get("url") || "");
  }
  const changedFileMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/files\/([^/]+)$/);
  if (changedFileMatch && method === "GET") {
    res.setHeader("Cache-Control", "no-store");
    const conversation = runtime.sessions?.get(decodeURIComponent(changedFileMatch[1]!));
    if (!conversation) return sendJson(res, 404, { error: "会话不存在或已移除" });
    const changeId = decodeURIComponent(changedFileMatch[2]!);
    const file = conversation.messages.filter((message) => message.role === "assistant")
      .flatMap((message) => normalizeFileChanges(message.fileChanges)).find((change) => change.id === changeId);
    if (!file) return sendJson(res, 404, { error: "本会话没有该文件的修改记录；不接受任意路径预览" });
    return sendJson(res, 200, await readTurnFilePreview(file));
  }
  const convMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (convMatch && method === "GET" && convMatch[1] !== "new" && convMatch[1] !== "switch") {
    if (!runtime.sessions) return sendJson(res, 404, { error: "会话记忆未开启" });
    const id = decodeURIComponent(convMatch[1]!);
    const s = runtime.sessions.get(id);
    if (!s) return sendJson(res, 404, { error: `未知会话: ${id}` });
    return sendJson(res, 200, { session: { ...sessionDetail(s, runtime.sessions.activeId(s.key), url.searchParams.get("view") === "chat"), ...sessionContext(runtime, env, s, s.agentName) } });
  }
  if (convMatch && method === "PATCH" && convMatch[1] !== "new" && convMatch[1] !== "switch") {
    if (!runtime.sessions) return sendJson(res, 404, { error: "会话记忆未开启" });
    const id = decodeURIComponent(convMatch[1]!);
    const body = await readJson(req);
    const hasTitle = Object.prototype.hasOwnProperty.call(body, "title");
    const hasModel = Object.prototype.hasOwnProperty.call(body, "modelRef");
    const hasMode = Object.prototype.hasOwnProperty.call(body, "permissionMode");
    const hasEffort = Object.prototype.hasOwnProperty.call(body, "reasoningEffort");
    const hasCowork = Object.prototype.hasOwnProperty.call(body, "cowork");
    const title = String(body.title ?? "").trim();
    const modelRef = String(body.modelRef ?? "").trim();
    const permissionModeRaw = String(body.permissionMode ?? "").trim();
    const permissionMode = permissionModeRaw ? normalizeAgentPermissionMode(permissionModeRaw) : undefined;
    const reasoningEffortRaw = String(body.reasoningEffort ?? "").trim();
    const reasoningEffort = reasoningEffortRaw ? normalizeReasoningEffort(reasoningEffortRaw) : undefined;
    if (!hasTitle && !hasModel && !hasMode && !hasEffort && !hasCowork) return sendJson(res, 400, { error: "缺少 title、modelRef、permissionMode、reasoningEffort 或 cowork" });
    if (hasTitle && !title) return sendJson(res, 400, { error: "title 不能为空" });
    if (modelRef && !buildModelList(runtime, env).some((m) => m.modelRef === modelRef)) {
      return sendJson(res, 400, { error: `未知或不可用模型: ${modelRef}` });
    }
    if (hasMode && permissionModeRaw && !permissionMode) {
      return sendJson(res, 400, { error: `未知 permissionMode: ${permissionModeRaw}` });
    }
    if (hasEffort && reasoningEffortRaw && !reasoningEffort) {
      return sendJson(res, 400, { error: `未知 reasoningEffort: ${reasoningEffortRaw}` });
    }
    let cowork: CoworkTarget | undefined;
    if (hasCowork) {
      try { cowork = normalizeCoworkTarget(body.cowork); }
      catch (error) { return sendJson(res, 400, { error: (error as Error).message }); }
    }
    try {
      let s = runtime.sessions.get(id);
      if (!s) throw new Error(`未知 session: ${id}`);
      if (hasCowork && s.channel !== "web") return sendJson(res, 409, { error: "外部渠道镜像不能从 Web 修改 Cowork 目标" });
      if ((hasModel || hasMode || hasEffort || hasCowork) && (s.checkpoint?.status === "running" || deps.preparingWebSessions.has(id) || [...deps.activeWebRuns.values()].some((run) => run.sessionId === id))) {
        return sendJson(res, 409, { error: "本轮 Model / Effort / Mode / Cowork 已锁定，请等待完成或停止后再修改", code: "SESSION_CONFIG_LOCKED" });
      }
      const nextModelRef = hasModel ? modelRef || runtime.resolveAgentModel(s.agentName) || "" : s.modelRef || runtime.resolveAgentModel(s.agentName) || "";
      // Validate the complete patch before mutating any part of the session.
      if (hasEffort && reasoningEffort && !modelSupportsReasoningEffort(runtime, env, nextModelRef, reasoningEffort)) {
        return sendJson(res, 400, { error: `${nextModelRef || "当前模型"} 不支持 Effort=${reasoningEffort}` });
      }
      if (hasTitle) s = runtime.sessions.rename(id, title);
      if (hasModel) s = runtime.sessions.setModel(id, modelRef || undefined);
      if (hasMode) s = runtime.sessions.setPermissionMode(id, permissionMode);
      const effortModelRef = s.modelRef || runtime.resolveAgentModel(s.agentName) || "";
      if (hasModel && s.reasoningEffort && !modelSupportsReasoningEffort(runtime, env, effortModelRef, s.reasoningEffort)) {
        s = runtime.sessions.setReasoningEffort(id, undefined);
      }
      if (hasEffort) {
        s = runtime.sessions.setReasoningEffort(id, reasoningEffort);
      }
      if (hasCowork) s = runtime.sessions.setCowork(id, cowork);
      return sendJson(res, 200, { session: { ...sessionDetail(s, runtime.sessions.activeId(s.key)), ...sessionContext(runtime, env, s, s.agentName) } });
    } catch (e) {
      return sendJson(res, 404, { error: (e as Error).message });
    }
  }
  if (convMatch && method === "DELETE") {
    if (!runtime.sessions) return sendJson(res, 404, { error: "会话记忆未开启" });
    const id = decodeURIComponent(convMatch[1]!);
    const existing = runtime.sessions.get(id);
    if (existing && (existing.checkpoint?.status === "running" || runtime.inputs?.isBusy(id)
      || deps.preparingWebSessions.has(id) || [...deps.activeWebRuns.values()].some(run => run.sessionId === id)
      || deps.broadcaster.hasActiveSession(id))) {
      return sendJson(res, 409, { error: "任务仍在运行或收尾，请先停止并等待保存完成后删除会话", code: "SESSION_BUSY" });
    }
    if (existing?.goal?.continuation.runId || runtime.goals?.isRunning?.(id)) {
      return sendJson(res, 409, { error: "GOAL 仍在运行或保存结果，请先暂停并等待本轮结算后删除会话" });
    }
    if (existing && runtime.intake?.blocksAutomatic(id, existing.key)) {
      return sendJson(res, 409, { error: "此会话还有排队消息、待核对回执或消息正在接收，请先处理完再删除", code: "SESSION_INPUT_PENDING" });
    }
    try { await runtime.sessions.remove(id); }
    catch (error) {
      deps.logger.warn({ err: (error as Error).message, sessionId: id }, "web:session-delete-failed");
      return sendJson(res, 500, { error: "会话文件删除失败，记录已保留，请稍后重试" });
    }
    deps.broadcaster.pushEvent({ __harbour: "session-deleted", id });
    return sendJson(res, 200, { removed: id });
  }

  // POST /api/mock —— 热切换 mock 模式
  if (pathname === "/api/mock" && method === "POST") {
    const body = await readJson(req);
    const enabled = !!body.enabled;
    runtime.router.setMockMode(enabled);
    return sendJson(res, 200, { mockMode: runtime.router.isMock });
  }

  // Heartbeat control —— 默认暂停，UI/API 显式开启。
  if (pathname === "/api/heartbeat" && method === "GET") {
    return sendJson(res, 200, deps.heartbeat.status());
  }
  if (pathname === "/api/heartbeat/toggle" && method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 200, deps.heartbeat.setEnabled(!!body.enabled));
  }
  if (pathname === "/api/heartbeat/run-once" && method === "POST") {
    const body = await readJson(req);
    const task = deps.heartbeat.runOnce(body.taskId ? String(body.taskId) : undefined);
    return sendJson(res, 202, { queued: true, task, status: deps.heartbeat.status() });
  }

  // Authenticated dashboard only; destination metadata never grants execution identity.
  const cronAuthorizationSource = () => ({ channel: "web", key: "web:cron-management", actor: webOwnerActor() });
  const cronContext = (): CronManagementContext => ({
    sessions: runtime.sessions,
    agentNames: runtime.listAgents().map(agent => agent.name),
    activeQQBotKeys: deps.activeQQBotKeys?.() ?? [],
    activeDiscordBotKeys: deps.activeDiscordBotKeys?.() ?? [],
  });
  // Cron control —— 持久化定时作业（区别于 heartbeat）。
  if (pathname === "/api/cron/delivery-targets" && method === "GET") {
    return sendJson(res, 200, { targets: listCronDeliveryTargets(cronContext()) });
  }
  if (pathname === "/api/cron" && method === "GET") {
    return sendJson(res, 200, { jobs: deps.cron.list() });
  }
  if (pathname === "/api/cron" && method === "POST") {
    const body = await readJson(req);
    const job = await deps.cron.add(parseCronManagementInput(body, cronContext(), true), cronAuthorizationSource());
    return sendJson(res, 201, { job, jobs: deps.cron.list() });
  }
  const cronHistoryMatch = pathname.match(/^\/api\/cron\/([^/]+)\/history(?:\/([^/]+))?$/);
  if (cronHistoryMatch && method === "GET") {
    const id = decodeURIComponent(cronHistoryMatch[1]!);
    if (!deps.cron.list().some(job => job.id === id)) return sendJson(res, 404, { error: "Cron 作业不存在" });
    if (cronHistoryMatch[2]) {
      const run = deps.cron.runRecord(id, decodeURIComponent(cronHistoryMatch[2]));
      return run ? sendJson(res, 200, { run }) : sendJson(res, 404, { error: "执行记录不存在或已超出保留范围" });
    }
    return sendJson(res, 200, deps.cron.history(id));
  }
  const cronMatch = pathname.match(/^\/api\/cron\/([^/]+)(?:\/(toggle|run-once))?$/);
  if (cronMatch) {
    const id = decodeURIComponent(cronMatch[1]!);
    const action = cronMatch[2];
    if (method === "POST" && action === "toggle") {
      const body = await readJson(req);
      if (typeof body.enabled !== "boolean") throw new CronRequestError("enabled 必须为布尔值");
      return sendJson(res, 200, { job: await deps.cron.toggle(id, body.enabled), jobs: deps.cron.list() });
    }
    if (method === "POST" && action === "run-once") {
      return sendJson(res, 202, { job: deps.cron.runOnce(id), jobs: deps.cron.list() });
    }
    // PATCH /api/cron/:id —— 编辑作业（名字/agent/input/schedule/taskType/sessionMode/enabled）。
    if (method === "PATCH" && !action) {
      const body = await readJson(req);
      const patch = parseCronManagementInput(body, cronContext(), false);
      return sendJson(res, 200, { job: await deps.cron.update(id, patch, cronAuthorizationSource()), jobs: deps.cron.list() });
    }
    if (method === "DELETE" && !action) {
      await deps.cron.remove(id);
      return sendJson(res, 200, { removed: id, jobs: deps.cron.list() });
    }
  }

  // Sessions —— 会话 trace（assets/sessions/<id>.jsonl）只读浏览。
  if (pathname === "/api/sessions" && method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? 50);
    return sendJson(res, 200, { sessions: await listSessions(Number.isFinite(limit) ? limit : 50) });
  }
  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch && method === "GET") {
    const id = decodeURIComponent(sessionMatch[1]!);
    return sendJson(res, 200, { id, events: await readSession(id) });
  }

  // Inbox —— agent 间异步消息（message_agent 投递的 agents/<name>/inbox/）。
  if (pathname === "/api/inbox" && method === "GET") {
    const agent = url.searchParams.get("agent");
    if (!agent) return sendJson(res, 400, { error: "缺少 agent 查询参数" });
    return sendJson(res, 200, { agent, messages: await listInbox(agent) });
  }

  // Governance proposals
  if (pathname === "/api/governance" && method === "GET") {
    return sendJson(res, 200, { proposals: await listProposals() });
  }
  if (pathname === "/api/governance/proposals" && method === "POST") {
    const body = await readJson(req);
    try {
      const proposal = await createProposal({
        targetType:
          body.targetType === "agent" ? "agent"
            : body.targetType === "skill" ? "skill"
              : body.targetType === "workflow" ? "workflow"
                : body.targetType === "mcp" ? "mcp"
                  : "memory",
        targetPath: String(body.targetPath ?? ""),
        operation: body.operation === "append" ? "append" : "write",
        content: String(body.content ?? ""),
        reason: String(body.reason ?? "web governance proposal"),
        sourceAgent: body.sourceAgent ? String(body.sourceAgent) : "web",
      });
      return sendJson(res, 201, { proposal });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  const proposalMatch = pathname.match(/^\/api\/governance\/proposals\/([^/]+)\/(approve|reject|apply)$/);
  if (proposalMatch && method === "POST") {
    const id = decodeURIComponent(proposalMatch[1]!);
    const action = proposalMatch[2]!;
    const proposal =
      action === "approve"
        ? await approveProposal(id)
        : action === "reject"
          ? await rejectProposal(id)
          : await applyProposal(id);
    if (action === "apply") {
      // 【派生物自愈】agent 文件一落盘，就把该 agent 的能力 index 正文重建一遍再热重载。
      // 为什么必须在这里：索引是【派生物】，改了源头它立刻过期——
      //   · 改了某个 skill 的 SKILL.md description → skills/index.md 的那行描述就在撒谎；
      //   · 改了 tools/mcp 的 frontmatter 白名单   → 对应正文列的还是旧条目；
      //   · 新增/删除技能目录                      → skills/index.md 的 id 列表对不上。
      // 挂在 apply 而不是让 AI 去改索引：索引该是机器生成的，让 AI 手写它迟早写歪。
      // 与「重建索引」按钮同一口径（只重写正文/扫描结果、内容没变不写盘），故不再开新提案。
      const m = /^agents\/([^/]+)\//.exec(proposal.targetPath);
      const globalCapabilityChanged = /^(?:skills|workflows|mcp)\//.test(proposal.targetPath);
      // 某个目标 Agent 的 description 是所有调用方 subagents/index.md 的派生源；
      // 改 CLAUDE.md 时要刷新全部调用方，而不只刷新目标自己的索引。
      const subagentDescriptionChanged = /^agents\/[^/]+\/CLAUDE\.md$/.test(proposal.targetPath);
      let indexRebuild: "ok" | "failed" | "skipped" = "skipped";
      let memoryIndexRebuild: "ok" | "failed" | "skipped" = "skipped";
      let memoryIndexesChanged: string[] = [];
      const rebuildTargets = globalCapabilityChanged || subagentDescriptionChanged
        ? runtime.listAgents().filter((agent) => !!agent.agentDir).map((agent) => agent.name)
        : m
          ? [m[1]!]
          : [];
      if (rebuildTargets.length) {
        indexRebuild = "ok";
        try {
          for (const agentName of rebuildTargets) await rebuildAgentIndexes(agentName, runtime);
        } catch (e) {
          // 重建失败【不能静默】：这个钩子存在的唯一理由就是「索引是派生物，不重建就会撒谎」，
          // 吞掉异常等于精确地退回它要防的那个状态，而且没有任何信号。
          // 失败不让已落盘的 apply 显得失败，但要留日志 + 在响应里告知（面板可提示手动重建）。
          indexRebuild = "failed";
          deps.logger.warn(
            { agents: rebuildTargets, proposal: proposal.id, err: e instanceof Error ? e.message : String(e) },
            "governance:apply 后索引重建失败（请手动点「重建索引」）"
          );
        }
      }
      if (proposal.targetType === "memory") {
        memoryIndexRebuild = "ok";
        try {
          const rebuilt = await rebuildMemoryIndexes();
          memoryIndexesChanged = rebuilt.changed;
        } catch (e) {
          memoryIndexRebuild = "failed";
          deps.logger.warn(
            { proposal: proposal.id, err: e instanceof Error ? e.message : String(e) },
            "governance:apply 后 Memory 子目录索引重建失败（可手动运行 npm run index）"
          );
        }
      }
      await runtime.reload();
      return sendJson(res, 200, {
        proposal,
        indexRebuild,
        memoryIndexRebuild,
        memoryIndexesChanged,
        proposals: await listProposals(),
      });
    }
    return sendJson(res, 200, { proposal, proposals: await listProposals() });
  }

  // Git 版本治理 —— log / diff / rollback。范围 = GOVERNED_ROOTS（Memory / Agent / Skill / Workflow / MCP）。
  // 版本管理直接用项目自己的 git 仓库，所以这三个就是 git log / git show / git checkout 的薄封装。
  if (pathname === "/api/governance/history" && method === "GET") {
    if (!(await hasMemoryRepo())) return sendJson(res, 200, { hasRepo: false, commits: [] });
    const p = url.searchParams.get("path") || undefined;
    return sendJson(res, 200, { hasRepo: true, path: p ?? null, commits: await memoryLog(p ?? undefined, 40) });
  }
  if (pathname === "/api/governance/diff" && method === "GET") {
    const p = url.searchParams.get("path");
    const commit = url.searchParams.get("commit");
    if (!p || !commit) return sendJson(res, 400, { error: "缺少 path 或 commit" });
    if (!(await hasMemoryRepo())) return sendJson(res, 200, { hasRepo: false });
    return sendJson(res, 200, {
      hasRepo: true,
      path: p,
      commit,
      atCommit: await memoryFileAt(p, commit),
      current: await memoryFileAt(p, "HEAD"),
    });
  }
  if (pathname === "/api/governance/rollback" && method === "POST") {
    const body = await readJson(req);
    const p = String(body.path ?? "");
    const commit = String(body.commit ?? "");
    if (!p || !commit) return sendJson(res, 400, { error: "缺少 path 或 commit" });
    // 用 governed 版：它按路径所属的根提交（agents/ 的回滚要提交 agents/，
    // 旧的 rollbackMemoryFile 只 add assets/Memory，回滚 agent 文件会提交不上。
    const sha = await rollbackGovernedFile(p, commit);
    await runtime.reload();
    return sendJson(res, 200, { rolledBack: p, to: commit, commit: sha });
  }

  // —— 记忆库（assets/Memory）：只读浏览 + 知识图谱嵌入 ——
  // 写入仍走上面的 governance 提案 + git 版本治理（这里不开任何直写口）。
  // GET /api/memory —— 总览：文件树 + frontmatter 摘要 + 类型计数 + 是否有图谱/仓库。
  if (pathname === "/api/memory" && method === "GET") {
    return sendJson(res, 200, await memoryOverview());
  }
  // GET /api/memory/file?path=concepts/x.md —— 读单个记忆文件（防目录穿越）。
  if (pathname === "/api/memory/file" && method === "GET") {
    return sendMemoryFile(res, url.searchParams.get("path") || "");
  }
  // GET /api/memory/graph —— 自包含知识图谱 HTML（前端 iframe srcdoc 嵌入）。
  if (pathname === "/api/memory/graph" && method === "GET") {
    return serveMemoryGraph(res);
  }

  // Folder-agent file editor helpers（写入只生成 governance proposal）。
  // POST /api/agent-files/:name/reindex —— 重建该 agent 的能力 index.md 正文。
  // 【为什么可以绕过 governance 审批】这些正文是【机器从运行时注册表回填】的，不含人的意图，
  // frontmatter（真正的白名单）原样保留、只重写正文。给它走提案审批只是徒增点击。
  // 人手改 agent 文件仍然照常走 proposal —— 这里只开「重建索引」这一种操作的特例。
  const reindexMatch = pathname.match(/^\/api\/agent-files\/([^/]+)\/reindex$/);
  if (reindexMatch && method === "POST") {
    const name = decodeURIComponent(reindexMatch[1]!);
    try {
      const changed = await rebuildAgentIndexes(name, runtime);
      await runtime.reload();   // 索引进 systemPrompt，重建完要热重载才生效
      return sendJson(res, 200, { ok: true, changed, files: await readAgentFiles(name, runtime) });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // POST /api/ai-edit —— 「AI 修改」：拿一段现有内容 + 一句自然语言意图，返回改写后的全文。
  // 【只回内容，不落盘】改完塞回编辑器让 用户 过目，仍要他点提交 → 照常走 governance 审批。
  // 这样 AI 只是个打字快的助手，不构成绕过审批的新口子。
  if (pathname === "/api/ai-edit" && method === "POST") {
    const body = await readJson(req);
    const content = String(body.content ?? "");
    const instruction = String(body.instruction ?? "").trim();
    const label = String(body.file ?? "文件");
    if (!instruction) return sendJson(res, 400, { error: "缺少修改要求 instruction" });
    const modelRef = runtime.modelSlots[0]?.modelRef;
    if (!modelRef) return sendJson(res, 500, { error: "没有可用的模型槽" });

    // 多文件模式：body.files = [{file, content}]，一次把【整个技能目录】交给模型，
    // 让它跨文件保持一致（改了 SKILL.md 的步骤，reference/eval 也能同步跟上）。
    const multi = Array.isArray(body.files) ? (body.files as Array<{ file?: unknown; content?: unknown }>) : null;
    try {
      if (multi && multi.length) {
        const bundle = multi
          .map((f) => `<<<FILE ${String(f.file ?? "")}>>>\n${String(f.content ?? "")}\n<<<END>>>`)
          .join("\n\n");
        const result = await runtime.router.complete({
          modelRef,
          agentName: "web:ai-edit",
          messages: [
            {
              role: "system",
              content:
                "你是文件编辑助手。下面给出【同一个技能目录下的全部文件】，请按用户要求改写。\n" +
                "硬性要求：\n" +
                '1) 只输出一个 JSON 对象：{"files":{"<原样的文件路径>":"<改写后的完整内容>"}}。\n' +
                "2) 只放【确实需要改动】的文件；没改的不要出现在 JSON 里。\n" +
                "3) 路径必须与输入给你的完全一致，不要新增文件、不要改名。\n" +
                "4) 保留各文件原有格式约定（YAML frontmatter、标题层级、列表风格、语言）。\n" +
                "5) 【不要修改 SKILL.md frontmatter 里的 name 字段】——Agent Skills 规范要求它与目录名一致，\n" +
                "   改了会让技能失效。同理不要试图改目录名。\n" +
                "6) 如果你改了 SKILL.md 的 description，不用管 skills/index.md——\n" +
                "   那份索引是机器按 description 自动重建的，不要手写它。\n" +
                "7) 不要输出解释、不要套代码围栏。",
            },
            { role: "user", content: `修改要求：${instruction}\n\n---以下是该技能目录的全部文件---\n${bundle}` },
          ],
        });
        let raw = result.message.content.trim();
        const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(raw);
        if (fence) raw = fence[1]!.trim();
        let parsed: { files?: Record<string, unknown> };
        try {
          parsed = JSON.parse(raw);
        } catch {
          return sendJson(res, 502, { error: "模型没有返回可解析的 JSON，请重试或换一句更明确的要求" });
        }
        const known = new Set(multi.map((f) => String(f.file ?? "")));
        const files: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed.files ?? {})) {
          if (known.has(k) && typeof v === "string") files[k] = v;   // 只认原有路径，杜绝模型编出新文件
        }
        return sendJson(res, 200, { files, changed: Object.keys(files) });
      }

      // 单文件模式（原路径）
      const result = await runtime.router.complete({
        modelRef,
        agentName: "web:ai-edit",
        messages: [
          {
            role: "system",
            content:
              "你是文件编辑助手。根据用户的修改要求改写给定文件的内容。\n" +
              "硬性要求：\n" +
              "1) 只输出改写后的【完整文件内容】，不要任何解释、前后缀、代码围栏。\n" +
              "2) 保留原文的格式约定（YAML frontmatter、标题层级、列表风格、语言）。\n" +
              "3) 只做用户要求的改动，不要顺手重写无关部分。",
          },
          { role: "user", content: `文件：${label}\n\n修改要求：${instruction}\n\n---当前内容---\n${content}` },
        ],
      });
      // 模型偶尔仍会套一层 ``` 围栏，这里剥掉，避免把围栏写进真文件。
      let out = result.message.content.trim();
      const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(out);
      if (fence) out = fence[1]!;
      return sendJson(res, 200, { content: out });
    } catch (e) {
      return sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  const agentFilesMatch = pathname.match(/^\/api\/agent-files\/([^/]+)$/);
  if (agentFilesMatch) {
    const name = decodeURIComponent(agentFilesMatch[1]!);
    if (method === "GET") return sendJson(res, 200, { files: await readAgentFiles(name, runtime) });
    if (method === "POST") {
      const body = await readJson(req);
      const file = String(body.file ?? "");
      const proposal = await createProposal({
        targetType: "agent",
        targetPath: `agents/${name}/${file}`,
        operation: "write",
        content: String(body.content ?? ""),
        reason: String(body.reason ?? `web edit agent ${name}/${file}`),
        sourceAgent: "web",
      });
      return sendJson(res, 201, { proposal });
    }
  }

  // POST /api/enqueue —— 把任务丢进真实队列（演示 worker 池）
  if (pathname === "/api/enqueue" && method === "POST") {
    const body = await readJson(req);
    const agent = String(body.agent ?? "");
    const input = String(body.input ?? "");
    if (!agent || !input) return sendJson(res, 400, { error: "缺少 agent 或 input" });
    deps.queue.enqueue({ id: randomUUID().slice(0, 8), agentName: agent, input });
    return sendJson(res, 202, { queued: true, stats: deps.queue.stats() });
  }

  void env;
  return sendJson(res, 404, { error: `未知接口: ${method} ${pathname}` });
}

/* ── 业务 ───────────────────────────────────────────────────────── */

function snapshot(deps: ServerDeps) {
  const { runtime, env, queue, heartbeat, channels, startedAt } = deps;
  const claudeSlots = runtime.modelSlots.filter((slot) => slot.kind === "claude-agent");
  const primarySlot = claudeSlots[0];
  const fallbackSlot = claudeSlots[1];
  const discordBots = resolveDiscordBotConfigs({
    ...process.env,
    DISCORD_BOTS: env.DISCORD_BOTS,
    DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN,
    DISCORD_APPLICATION_ID: env.DISCORD_APPLICATION_ID,
    DISCORD_ALLOWLIST: env.DISCORD_ALLOWLIST,
    DEFAULT_AGENT: env.DEFAULT_AGENT,
  }, env.DEFAULT_AGENT);
  const activeDiscordBotKeys = deps.activeDiscordBotKeys?.() ?? [];
  const qqBots = resolveQQBotConfigs({
    ...process.env,
    QQ_BOTS: env.QQ_BOTS,
    QQBOT_APP_ID: env.QQBOT_APP_ID,
    QQBOT_APP_SECRET: env.QQBOT_APP_SECRET,
    QQBOT_AGENT: env.QQBOT_AGENT,
    QQBOT_ALLOWLIST: env.QQBOT_ALLOWLIST,
  }, env.DEFAULT_AGENT);
  const activeQQBotKeys = deps.activeQQBotKeys?.() ?? [];
  return {
    name: "Harbour",
    uptimeMs: Date.now() - startedAt,
    // 入口 persona：前端据此决定首屏默认打开哪个角色，避免前后端各持一份硬编码默认值。
    defaultAgent: env.DEFAULT_AGENT,
    agents: runtime.listAgents().map((a) => agentSummary(a, runtime)),
    router: { strategy: runtime.router.getStrategy() },
    backends: {
      mock: runtime.router.isMock,
      claudeAgent: {
        configured: !!(primarySlot && process.env[primarySlot.keyEnv]),
        baseURL: primarySlot?.baseURL || "default",
        model: primarySlot?.model || env.CLAUDE_AGENT_MODEL,
        label: primarySlot?.label || "主 API",
        thinking: env.CLAUDE_AGENT_THINKING,
      },
      // 当前容灾链的第一项；任意 N 槽的完整顺序在 Settings → 模型管理里展示。
      fallback: {
        configured: !!(fallbackSlot && process.env[fallbackSlot.keyEnv]),
        baseURL: fallbackSlot?.baseURL || "default",
        model: fallbackSlot?.model || "",
        label: fallbackSlot?.label || "首个 fallback",
      },
      openrouter: { configured: !!env.OPENROUTER_API_KEY, baseURL: env.OPENROUTER_BASE_URL },
      claudeCli: { enabled: env.ENABLE_CLAUDE_CLI },
      codexHarness: {
        enabled: runtime.codexHarness.enabled,
        ready: runtime.codexHarness.ready,
        authType: runtime.codexHarness.authType ?? null,
        planType: runtime.codexHarness.planType ?? null,
        models: runtime.codexHarness.models.length,
        error: runtime.codexHarness.error ?? null,
      },
    },
    // 隔离浏览器 / 桌面控制能力（只读展示，供 Settings 面板显示配置状态）。
    control: {
      browserHarnessBin: env.BROWSER_HARNESS_BIN,
      chromeDebugPort: env.HARBOUR_CHROME_DEBUG_PORT,
      chromeHeadless: env.HARBOUR_CHROME_HEADLESS,
      desktopControl: env.ENABLE_DESKTOP_CONTROL,
    },
    queue: queue.stats(),
    sessions: { enabled: !!runtime.sessions, ...(runtime.sessions ? runtime.sessions.stats() : { sessions: 0, keys: 0 }) },
    scheduler: heartbeat.status(),
    channels: {
      active: channels,
      discord: {
        configured: discordBots.some((bot) => !!bot.token),
        configuredCount: discordBots.filter((bot) => !!bot.token).length,
        activeBotKeys: activeDiscordBotKeys,
        bots: discordBots.map((bot) => ({
          key: bot.key,
          agentName: bot.agentName,
          configured: !!bot.token,
          active: activeDiscordBotKeys.includes(bot.key),
          allowlistSize: bot.allowlist.split(",").filter(Boolean).length,
        })),
      },
      qq: {
        configured: qqBots.some(qqConfigured),
        configuredCount: qqBots.filter(qqConfigured).length,
        activeBotKeys: activeQQBotKeys,
        bots: qqBots.map((bot) => ({
          key: bot.key,
          agentName: bot.agentName,
          configured: qqConfigured(bot),
          active: activeQQBotKeys.includes(bot.key),
          allowlistSize: bot.allowlist.split(",").filter(Boolean).length,
          ownerBindingCount: deps.qqOwnerBindingCount?.(bot.key) ?? 0,
        })),
      },
      wecom: { implemented: false },
    },
    tools: runtime.registry.list(),
  };
}

async function readSkills(agentName: string | null, runtime: Runtime): Promise<Array<{ agent: string; name: string; description: string }>> {
  const agents = agentName ? [runtime.getAgent(agentName)].filter(Boolean) : runtime.listAgents();
  const out: Array<{ agent: string; name: string; description: string }> = [];
  for (const agent of agents) {
    if (!agent) continue;
    for (const skill of agent.skills ?? []) {
      out.push({ agent: agent.name, name: skill.name, description: skill.description });
    }
  }
  return out;
}

/**
 * 重建一个 agent 的 tools / skills / workflows / subagents / mcp index.md 【正文】，frontmatter 原样不动
 * （frontmatter 才是真正的白名单，是人的意图；正文只是给模型看的可读清单）。
 *
 * 数据源是【运行时真实注册表 + 磁盘实际内容】，所以比 `npm run index` 里那张静态描述表更准。
 * 返回实际被改写的文件（内容没变就不写盘，避免制造无谓的 git 噪声）。
 */
async function rebuildAgentIndexes(name: string, runtime: Runtime): Promise<string[]> {
  const agent = runtime.getAgent(name);
  if (!agent?.agentDir) throw new Error(`「${name}」不是文件夹型 agent`);
  const dir = agent.agentDir;
  const changed: string[] = [];
  const descOf = new Map(runtime.registry.list().map((t) => [t.name, t.description]));

  /** 只重写正文，frontmatter 原样保留（tools / mcp 的白名单是人的意图，不能动）。
   *  build 拿得到【现有正文】，好让「没东西可生成时保留人写的说明」成为可能。 */
  const rewrite = async (
    rel: string,
    build: (data: Record<string, unknown>, curBody: string) => Promise<string> | string
  ) => {
    await rewriteWithData(rel, async (data, curBody) => ({ data, body: await build(data, curBody) }));
  };
  /** frontmatter 也一起重写（技能索引用：它的 frontmatter 是扫描结果、不是人的意图）。 */
  const rewriteWithData = async (
    rel: string,
    build: (data: Record<string, unknown>, curBody: string) => Promise<{ data: Record<string, unknown>; body: string }> | { data: Record<string, unknown>; body: string }
  ) => {
    const abs = path.join(dir, rel);
    let raw: string;
    try { raw = await fs.readFile(abs, "utf8"); } catch { return; }   // 该 agent 没这份索引就跳过
    const parsed = matter(raw);
    const { data, body } = await build(parsed.data as Record<string, unknown>, parsed.content.trim());
    const next = matter.stringify(`\n${body}\n`, data);
    if (next !== raw) { await fs.writeFile(abs, next, "utf8"); changed.push(rel); }
  };

  await rewrite("tools/index.md", (data) => {
    const tools = Array.isArray(data.tools) ? data.tools.map(String) : [];
    const lines = [`# TOOL 白名单 —— ${name}`, "", "> frontmatter `tools` 是白名单；正文由面板「重建索引」从工具注册表回填。", ""];
    if (tools.length) for (const t of tools) lines.push(`- \`${t}\` — ${descOf.get(t) ?? "（未注册工具）"}`);
    else lines.push("- （无）");
    return lines.join("\n");
  });

  // Agent index frontmatter 是挂载白名单；Skill/Workflow/MCP 真身统一从项目根目录解析。
  await rewriteWithData("skills/index.md", (data) => {
    const mounted = Array.isArray(data.skills) ? data.skills.map(String) : [];
    return scanSkills(mounted).then((discovered) => {
    const lines = [
      `# SKILL 清单 —— ${name}`, "",
      "> frontmatter `skills` 是挂载白名单；真身统一位于项目根 `skills/<name>/`。",
      "> 正文由「重建索引」回填；模型按需自主加载，用户无需点名。", "",
    ];
    if (!discovered.length) lines.push("- （无）");
    for (const s of discovered) lines.push(`- \`${s.name}\` — ${s.description}`);
      return { data, body: lines.join("\n") };
    });
  });

  await rewrite("workflows/index.md", async (data) => {
    const mounted = Array.isArray(data.workflows) ? data.workflows.map(String) : [];
    const discovered = await scanWorkflows(mounted);
    const lines = [
      `# WORKFLOW 挂载 —— ${name}`, "",
      "> frontmatter `workflows` 是挂载白名单；真身统一位于项目根 `workflows/<name>/WORKFLOW.md`。",
      "> 正文由「重建索引」回填；完整契约按需使用 `read_workflow` 懒加载。", "",
    ];
    if (!discovered.length) lines.push("- （无）");
    for (const workflow of discovered) lines.push(`- \`${workflow.name}\` — ${workflow.description}`);
    return lines.join("\n");
  });

  await rewrite("subagents/index.md", async (data) => {
    const mounted = Array.isArray(data.subagents) ? data.subagents.map(String) : [];
    const discovered = await scanSubagents(mounted, path.dirname(dir), undefined, name);
    const lines = [
      `# SUBAGENT 白名单 —— ${name}`, "",
      "> frontmatter `subagents` 是可同步派发白名单；描述来自目标 Agent 的 `CLAUDE.md` frontmatter。",
      "> 正文由「重建索引」回填；目标 Agent 的完整 prompt 仅在真正派发后装载。", "",
    ];
    if (!discovered.length) lines.push("- （无）");
    for (const agent of discovered) lines.push(`- \`${agent.name}\` — ${agent.description}`);
    return lines.join("\n");
  });

  await rewrite("mcp/index.md", async (data) => {
    const mounted = Array.isArray(data.servers) ? data.servers.map(String) : [];
    const servers = await loadMcpServers(mounted);
    const lines = [
      `# MCP 挂载 —— ${name}`, "",
      "> frontmatter `servers` 是挂载白名单；真身统一位于项目根 `mcp/<name>/MCP.md`。",
      "> 正文由「重建索引」回填；具体工具 schema 由 MCP server 运行时提供。", "",
    ];
    if (!servers.length) lines.push("- （无）");
    for (const server of servers) lines.push(`- \`${server.name}\` — ${server.description || "外部 MCP server"}`);
    return lines.join("\n");
  });

  return changed;
}

/**
 * 列出一个文件夹型 agent 的可编辑文件。
 *
 * 【为什么不再写死清单】原来是硬编码 7 个路径，后果：MASTER.md / PREFERENCE.md 改不了
 * （main-* 的主人档案与内容边界），每个 skill 的 SKILL.md 更是完全看不见。
 * Skill/Workflow/MCP 真身已统一到项目根；Agent 编辑器只展示自身配置与挂载 index。
 *
 * group 供前端分组渲染：persona / schedule / index。
 */
async function readAgentFiles(
  name: string,
  runtime: Runtime
): Promise<Array<{ file: string; content: string; group: string }>> {
  const agent = runtime.getAgent(name);
  if (!agent?.agentDir) throw new Error(`「${name}」不是文件夹型 agent`);
  const dir = agent.agentDir;
  const out: Array<{ file: string; content: string; group: string }> = [];

  const read = async (rel: string): Promise<string | null> => {
    try { return await fs.readFile(path.join(dir, rel), "utf8"); } catch { return null; }
  };
  /** alwaysShow：即使文件不存在也列出来（内容空 = 可新建），保持原有「能建 SOUL.md」的行为。 */
  const push = async (rel: string, group: string, alwaysShow = false) => {
    const content = await read(rel);
    if (content === null && !alwaysShow) return;
    out.push({ file: rel, content: content ?? "", group });
  };

  // 人格骨架：核心四件always列出（可新建）；MASTER/PREFERENCE 只在存在时列，
  // 免得给没有主人档案的子 agent 平添两个空条目。
  await push("CLAUDE.md", "persona", true);
  await push("SOUL.md", "persona", true);
  await push("PUBLIC.md", "persona");
  await push("MASTER.md", "persona");
  await push("PREFERENCE.md", "persona");
  await push("MEMORY.md", "persona", true);
  await push("HEARTBEAT.md", "schedule", true);
  for (const rel of ["tools/index.md", "skills/index.md", "workflows/index.md", "subagents/index.md", "mcp/index.md"]) await push(rel, "index", true);

  return out;
}

/* ── 全局 Skill / Workflow / MCP 真身浏览与编辑入口 ─────────────── */
const CAPABILITY_ROOTS = {
  skill: path.resolve(process.cwd(), "skills"),
  workflow: path.resolve(process.cwd(), "workflows"),
  mcp: path.resolve(process.cwd(), "mcp"),
} as const;
const CAPABILITY_TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".sh", ".bash",
  ".html", ".css", ".scss", ".svg", ".xml", ".csv",
]);

type CapabilityKind = keyof typeof CAPABILITY_ROOTS;
type CapabilityFile = { path: string; relativePath: string; size: number };

function isCapabilityTextFile(name: string): boolean {
  return name === "LICENSE" || name === "NOTICE" || CAPABILITY_TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

async function walkCapabilityTextFiles(root: string, dir = root): Promise<CapabilityFile[]> {
  const out: CapabilityFile[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (
      entry.name.startsWith(".") ||
      ["node_modules", "__pycache__", "fixtures", "dist", "build"].includes(entry.name)
    ) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkCapabilityTextFiles(root, abs)));
      continue;
    }
    if (!entry.isFile() || !isCapabilityTextFile(entry.name)) continue;
    const stat = await fs.stat(abs);
    if (stat.size > 2 * 1024 * 1024) continue;
    const repoPath = path.relative(process.cwd(), abs).split(path.sep).join("/");
    out.push({
      path: repoPath,
      relativePath: path.relative(root, abs).split(path.sep).join("/"),
      size: stat.size,
    });
  }
  return out.sort((a, b) => {
    const rank = (p: string) => /^(?:SKILL|WORKFLOW|MCP)\.md$/.test(p) ? 0 : p === "LICENSE" ? 2 : 1;
    return rank(a.relativePath) - rank(b.relativePath) || a.relativePath.localeCompare(b.relativePath);
  });
}

/** Ignore empty migration shells, but keep broken packages with real files repairable. */
async function isEmptyCapabilityDirectory(dir: string): Promise<boolean> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    // A symlink or any file makes the package nonempty; never follow links here.
    if (!entry.isDirectory() || !await isEmptyCapabilityDirectory(path.join(dir, entry.name))) return false;
  }
  return true;
}

async function capabilityOverview(runtime: Runtime) {
  const mountedSkills = new Map<string, string[]>();
  const mountedWorkflows = new Map<string, string[]>();
  const mountedMcp = new Map<string, string[]>();
  for (const agent of runtime.listAgents()) {
    for (const skill of agent.skills ?? []) {
      const list = mountedSkills.get(skill.name) ?? [];
      list.push(agent.name);
      mountedSkills.set(skill.name, list);
    }
    for (const workflow of agent.workflows ?? []) {
      const list = mountedWorkflows.get(workflow.name) ?? [];
      list.push(agent.name);
      mountedWorkflows.set(workflow.name, list);
    }
    for (const server of agent.mcpServers ?? []) {
      const list = mountedMcp.get(server.name) ?? [];
      list.push(agent.name);
      mountedMcp.set(server.name, list);
    }
  }

  const packages: Array<{
    kind: CapabilityKind;
    name: string;
    description: string;
    valid: boolean;
    files: CapabilityFile[];
    mountedBy: string[];
  }> = [];

  for (const kind of ["skill", "workflow", "mcp"] as const) {
    const root = CAPABILITY_ROOTS[kind];
    let entries: Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const packageRoot = path.join(root, entry.name);
      const mainName = kind === "skill" ? "SKILL.md" : kind === "workflow" ? "WORKFLOW.md" : "MCP.md";
      let description = "";
      let valid = false;
      try {
        const parsed = matter(await fs.readFile(path.join(packageRoot, mainName), "utf8"));
        description = typeof parsed.data.description === "string"
          ? parsed.data.description.trim()
          : parsed.content.trim().split("\n").find((line) => line.trim() && !line.startsWith("#"))?.trim() ?? "";
        valid = typeof parsed.data.name === "string" && parsed.data.name.trim() === entry.name;
      } catch {
        /* 无主定义也照列，方便在面板里修复。 */
      }
      const files = await walkCapabilityTextFiles(packageRoot);
      if (!valid && !files.length && await isEmptyCapabilityDirectory(packageRoot)) continue;
      packages.push({
        kind,
        name: entry.name,
        description,
        valid,
        files,
        mountedBy: (kind === "skill" ? mountedSkills : kind === "workflow" ? mountedWorkflows : mountedMcp).get(entry.name) ?? [],
      });
    }
  }
  const kindRank: Record<CapabilityKind, number> = { skill: 0, workflow: 1, mcp: 2 };
  packages.sort((a, b) => kindRank[a.kind] - kindRank[b.kind] || a.name.localeCompare(b.name));
  return {
    roots: { skill: "skills", workflow: "workflows", mcp: "mcp" },
    counts: {
      skill: packages.filter((item) => item.kind === "skill").length,
      workflow: packages.filter((item) => item.kind === "workflow").length,
      mcp: packages.filter((item) => item.kind === "mcp").length,
    },
    packages,
  };
}

async function resolveCapabilityFile(rel: string): Promise<{ path: string; content: string }> {
  const normalized = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  const kind: CapabilityKind | null = normalized.startsWith("skills/")
    ? "skill"
    : normalized.startsWith("workflows/")
      ? "workflow"
      : normalized.startsWith("mcp/")
        ? "mcp"
        : null;
  if (!kind || normalized.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error("能力文件路径非法");
  }
  if (!isCapabilityTextFile(path.basename(normalized))) throw new Error("只允许读取可编辑的文本文件");
  const root = CAPABILITY_ROOTS[kind];
  const target = path.resolve(process.cwd(), normalized);
  if (!target.startsWith(root + path.sep)) throw new Error("能力文件路径越界");
  const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
  if (!realTarget.startsWith(realRoot + path.sep)) throw new Error("能力文件路径越界");
  const stat = await fs.stat(realTarget);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("能力文件不可编辑或过大");
  return { path: normalized, content: await fs.readFile(realTarget, "utf8") };
}

async function sendCapabilityFile(res: ServerResponse, rel: string): Promise<void> {
  if (!rel) return sendJson(res, 400, { error: "缺少 path 查询参数" });
  try {
    return sendJson(res, 200, await resolveCapabilityFile(rel));
  } catch (e) {
    return sendJson(res, 404, { error: e instanceof Error ? e.message : String(e) });
  }
}

/* ── 记忆库（assets/Memory）浏览；写入仍经 Governance ───────────── */
const MEMORY_DIR = path.resolve(process.cwd(), "assets", "Memory");

async function walkMd(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkMd(full)));
    else if (e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/** 顶层目录 → 展示用类型（无 frontmatter type 时的兜底分类）。 */
function dirToMemType(dir: string): string {
  switch (dir) {
    case "concepts": return "Concept";
    case "entities": return "Entity";
    case "journals": return "Journal";
    case "outputs": return "Output";
    case "treasury": return "Treasure";
    default: return "Page";
  }
}

/** 记忆库总览：每个 .md 页的路径 + frontmatter 摘要（title/type/description/related）。 */
async function memoryOverview() {
  const files = await walkMd(MEMORY_DIR);
  const pages: Array<{ path: string; name: string; dir: string; title: string; type: string; description: string; related: string[] }> = [];
  for (const f of files) {
    let data: Record<string, unknown> = {};
    try {
      data = matter(await fs.readFile(f, "utf8")).data as Record<string, unknown>;
    } catch {
      /* 无 frontmatter 也照列 */
    }
    const rel = path.relative(MEMORY_DIR, f).split(path.sep).join("/");
    const name = path.basename(f);
    const relatedRaw = data.related;
    // 分类：优先 frontmatter type；没有则按顶层目录归类（本库是目录制分类法）。
    const topDir = rel.includes("/") ? rel.split("/")[0] ?? "" : "";
    pages.push({
      path: rel,
      name,
      dir: path.dirname(rel) === "." ? "" : path.dirname(rel),
      title: String(data.title ?? name.replace(/\.md$/, "")),
      type: data.type ? String(data.type) : dirToMemType(topDir),
      description: String(data.description ?? ""),
      related: Array.isArray(relatedRaw) ? relatedRaw.map(String) : relatedRaw ? [String(relatedRaw)] : [],
    });
  }
  const byType: Record<string, number> = {};
  for (const p of pages) byType[p.type] = (byType[p.type] || 0) + 1;
  return {
    root: "assets/Memory",
    total: pages.length,
    byType,
    hasGraph: await pathExists(path.join(MEMORY_DIR, "memory-graph.html")),
    hasRepo: await hasMemoryRepo(),
    pages: pages.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

async function sendMemoryFile(res: ServerResponse, rel: string): Promise<void> {
  if (!rel) return sendJson(res, 400, { error: "缺少 path 查询参数" });
  const target = path.normalize(path.join(MEMORY_DIR, rel));
  if (target !== MEMORY_DIR && !target.startsWith(MEMORY_DIR + path.sep)) {
    return sendJson(res, 403, { error: "路径越界" });
  }
  try {
    const content = await fs.readFile(target, "utf8");
    return sendJson(res, 200, { path: rel, content });
  } catch {
    return sendJson(res, 404, { error: `找不到记忆文件: ${rel}` });
  }
}

async function serveMemoryGraph(res: ServerResponse): Promise<void> {
  try {
    const html = await fs.readFile(path.join(MEMORY_DIR, "memory-graph.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  } catch {
    sendText(res, 404, "memory-graph.html 尚未生成（跑 npm run memory:graph 生成）");
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 列出已 wire 的模型槽 + 其 effort/compact 配置（chat 选模型 + Settings 逐模型配置用）。 */
function buildModelList(runtime: Runtime, env: Env) {
  return runtime.modelSlots.flatMap((s) => enabledModelsForSlot(s).map((entry) => {
    const model = entry.id;
    const modelRef = `${s.backendKey}/${model}`;
    const { contextWindow, contextWindowSource } = modelContextInfo(modelRef, env, runtime.modelSlots);
    const cfg = runtime.modelConfig.get(modelRef);
    const presentation = modelConnectionPresentation(s, s.kind);
    // DSH's derived catalog already carries its backend suffix. SDK models need
    // the same explicit distinction; only display labels change, never modelRef.
    const modelLabel = s.kind === "claude-agent"
      ? `${entry.label || model} · ${presentation.runtimeLabel}`
      : entry.label || model;
    const effortOptions = s.kind !== "claude-agent"
      ? (entry.supportedReasoningEfforts?.length
          ? entry.supportedReasoningEfforts.map((option) => ({ ...option }))
          : ["low", "medium", "high"].map((effort) => ({ effort: effort as ReasoningEffort })))
      : claudeSdkEffortOptions(s.baseURL);
    return {
      modelRef,
      // 单一扁平选择器中同时展示「连接/key 槽 + 模型」，选择值则是精确组合。
      model: `${s.label} · ${modelLabel}`,
      modelLabel,
      modelName: model,
      connectionId: s.id,
      connectionLabel: s.label,
      ...presentation,
      default: model === s.model,
      contextWindow,
      contextWindowSource,
      capabilities: entry.capabilities ?? [],
      backendKind: s.kind,
      effort: cfg.effort,
      // Harbour 的普通 Agent 默认从 medium 起步；Main 的 high 在 Agent 层覆盖并由前端标明。
      // Codex 若不支持 medium，运行时仍会按 model/list 安全回到该模型目录默认值。
      defaultEffort: s.kind === "dsh-harness" ? "high" as const : "medium" as const,
      effortOptions,
      supportedEfforts: effortOptions.map((option) => option.effort),
      compactTokens: cfg.compactTokens,
      defaultCompactTokens: Math.floor(contextWindow * 0.8),
    };
  }));
}

function modelSupportsReasoningEffort(
  runtime: Runtime,
  env: Env,
  modelRef: string,
  effort: ReasoningEffort
): boolean {
  if (!modelRef) return false;
  return buildModelList(runtime, env)
    .find((model) => model.modelRef === modelRef)
    ?.supportedEfforts.includes(effort) === true;
}

function buildAgentDefaultSettings(runtime: Runtime, env: Env) {
  const models = buildModelList(runtime, env);
  return {
    agents: runtime.listAgents().map((agent) => {
      const manifestModelRef = runtime.router.canonicalize(runtime.router.pick(agent));
      const overrideModelRef = runtime.agentModels.get(agent.name) ?? null;
      const overridePermissionMode = runtime.agentModes.get(agent.name) ?? null;
      return {
        name: agent.name,
        description: agent.description ?? "",
        manifestModelRef,
        overrideModelRef,
        effectiveModelRef: runtime.resolveAgentModel(agent.name) ?? manifestModelRef,
        manifestPermissionMode: agent.permissionMode,
        overridePermissionMode,
        effectivePermissionMode: runtime.resolveAgentPermissionMode(agent.name) ?? agent.permissionMode,
        defaultReasoningEffort: agent.reasoningEffort ?? defaultReasoningEffortForAgent(agent.name),
        delegationConfigurable: isDelegationConfigurable(agent.name),
        delegationEnabled: runtime.agentDelegation?.isEnabled(agent.name) ?? true,
      };
    }),
    models,
  };
}

/** 密钥打码：只留首尾 4 位。空 → 空串。 */
function maskKey(k: string): string {
  if (!k) return "";
  return k.length <= 8 ? "•".repeat(k.length) : `${k.slice(0, 4)}…${k.slice(-4)}`;
}

/** .env 文件值优先于当前进程；后者保留机器级/启动时动态命名 Bot 的兼容。 */
async function readDiscordSource(env: Env): Promise<Record<string, unknown>> {
  const file = await readEnvValues();
  return {
    ...process.env,
    DISCORD_BOTS: env.DISCORD_BOTS,
    DISCORD_NEWS_BOT: env.DISCORD_NEWS_BOT,
    DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN,
    DISCORD_APPLICATION_ID: env.DISCORD_APPLICATION_ID,
    DISCORD_ALLOWLIST: env.DISCORD_ALLOWLIST,
    DEFAULT_AGENT: env.DEFAULT_AGENT,
    DAILY_NEWS_DISCORD_CHANNEL_ID: env.DAILY_NEWS_DISCORD_CHANNEL_ID,
    STOCK_NEWS_DISCORD_CHANNEL_ID: env.STOCK_NEWS_DISCORD_CHANNEL_ID,
    ...file,
  };
}

/** QQ 配置同样以 .env 文件最新值为准，便于 Dashboard 保存后立即回显。 */
async function readQQSource(env: Env): Promise<Record<string, unknown>> {
  const file = await readEnvValues();
  return {
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
    DEFAULT_AGENT: env.DEFAULT_AGENT,
    ...file,
  };
}

/**
 * 模型管理槽（任意 N 个）：从 data/models.json 读注册表 + 当前 .env 读 key（打码）。
 * model / baseURL / keyEnv 存 models.json；key 值只在 .env（keyEnv 指向）。第 0 槽为主、不可删。
 */
async function buildModelSlots() {
  const slots = await readModelSlots();
  const e = await readEnvValues();
  return slots.map((s, i) => {
    const key = e[s.keyEnv] ?? "";
    const presentation = modelConnectionPresentation(s, "claude-agent");
    return {
      id: s.id,
      label: s.label,
      index: i,
      primary: i === 0,
      model: s.model,
      baseURL: s.baseURL,
      keyEnv: s.keyEnv,
      keyKind: s.keyKind,
      models: s.models,
      catalog: s.catalog ?? null,
      keyMask: maskKey(key),
      configured: !!key,
      ...presentation,
    };
  });
}

/**
 * UI 的 Runtime 全景：可编辑 Claude SDK 槽 + 只读 Codex OAuth / DSH 实验虚拟槽。
 * 编辑 API 仍只接受 slots，因此展示层不会把虚拟槽写进 models.json 或 fallback 链。
 */
async function buildModelConnections(runtime: Runtime) {
  const editable = await buildModelSlots();
  const codex = runtime.modelSlots
    .filter((slot) => slot.kind === "codex-harness")
    .map((slot) => ({
      id: slot.id,
      label: slot.label,
      model: slot.model,
      models: slot.models,
      catalog: slot.catalog ?? null,
      configured: runtime.codexHarness.enabled,
      ready: runtime.codexHarness.ready,
      error: runtime.codexHarness.error ?? null,
      component: runtime.codexHarness.component ?? null,
      ...modelConnectionPresentation(slot, "codex-harness"),
    }));
  const dsh = runtime.modelSlots.filter(slot => slot.kind === "dsh-harness").map(slot => ({
    id: slot.id, label: slot.label, model: slot.model, models: slot.models, catalog: slot.catalog ?? null,
    configured: !!process.env[slot.keyEnv], ready: !!process.env[slot.keyEnv],
    ...modelConnectionPresentation(slot, "dsh-harness"),
  }));
  return [...editable, ...codex, ...dsh];
}

/**
 * 估算某会话当前上下文占用 + 该会话 agent 所用模型的 context window（前端 context 环用）。
 * contextTokens ≈ 人格 system + 会话正文/附件 + GOAL + 已挂载工具 schema + 请求包装余量。
 * 使用与 ContextManager 相同的中英混合估算；尚未发送的 composer 输入由运行前预检计入。
 */
function sessionContext(
  runtime: Runtime,
  env: Env,
  s: ChatSession,
  agentName: string
) {
  const a = runtime.getAgent(agentName);
  const modelRef = s.modelRef || (a ? runtime.resolveAgentModel(agentName) ?? "" : "");
  const policy = modelRef ? modelContextPolicy(modelRef, env, runtime.modelSlots, a?.contextBudget ?? "auto", runtime.modelConfig.get(modelRef).compactTokens)
    : { contextModelRef: "", contextWindow: 0, contextWindowSource: "fallback" as const, contextBudget: 0, contextLimit: 0, compactAtTokens: 0,
      contextBudgetMode: "auto" as const, configuredContextBudget: null, reservedOutputTokens: 0,
      compactSource: "window-ratio" as const, compactRequestedTokens: 0, compactClamped: false };
  const systemTokens = a ? estimateTextTokens(a.systemPrompt) : 0;
  const bodyTokens = runtime.sessions ? runtime.sessions.bodyTokenEstimate(s) : 0;
  const goalTokens = isOpenSessionGoal(s.goal)
    ? estimateTextTokens(`当前持续目标（GOAL 模式）\n目标：${s.goal.objective}\n${s.goal.progress || ""}`)
    : 0;
  const toolTokens = a && runtime.registry
    ? estimateToolTokens(filterAllowedTools(a, runtime.registry.resolveTools(a.tools)))
    : 0;
  const requestOverheadTokens = REQUEST_ENVELOPE_RESERVE_TOKENS;
  // 拆开返回：新会话正文=0 但 system 仍占一两千 token，前端不说清楚就会被当成
  // 「新建会话没清空」（用户 2026-07-22 就这么理解的）。数字没错，是没解释。
  const backupContextTokens = systemTokens + bodyTokens + goalTokens + toolTokens + requestOverheadTokens;
  const native = s.nativeContext;
  const nativeMatches = native && native.agentName === agentName && Number.isFinite(native.tokens) && native.tokens >= 0 &&
    runtime.router.canonicalize(native.modelRef) === runtime.router.canonicalize(modelRef);
  const contextTokens = nativeMatches ? native.tokens : backupContextTokens;
  return { ...policy, contextTokens, systemTokens, bodyTokens, goalTokens, toolTokens, requestOverheadTokens,
    contextTokenSource: nativeMatches ? "native-observed" : "harbour-estimate",
    backupContextTokens, ...(nativeMatches ? { contextObservedAt: native.observedAt } : {}),
    contextNeedsCompaction: policy.compactAtTokens > 0 && contextTokens >= policy.compactAtTokens };
}

/** 会话列表项（不含 messages，轻量）。 */
function sessionSummary(s: ChatSession, activeId?: string) {
  return {
    id: s.id,
    key: s.key,
    channel: s.channel,
    agentName: s.agentName,
    modelRef: s.modelRef ?? null,
    permissionMode: s.permissionMode ?? null,
    reasoningEffort: s.reasoningEffort ?? null,
    pinnedSkill: s.pinnedSkill ?? null,
    cowork: s.cowork ? { ...s.cowork } : null,
    title: s.title,
    messageCount: s.messages.length,
    compactions: s.compactions,
    hasSummary: !!s.summary,
    active: s.id === activeId,
    readOnlyMirror: s.channel !== "web",
    source: sessionSource(s),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    lastMessageAt: sessionActivityAt(s),
    ...sessionReplyState(s),
    replyRunId: sessionLatestReplyRunId(s),
    checkpoint: checkpointSummary(s.checkpoint),
    goal: publicGoal(s),
  };
}

function publicGoal(s: ChatSession) {
  return publicSessionGoal(s.goal);
}

/** 把持久 key + 可选 origin 归一成前端稳定可读的来源标签；旧会话也不会只剩一串 ID。 */
function sessionSource(s: ChatSession) {
  const platform = (s.origin?.platform || s.channel || "unknown").toLowerCase();
  if (platform === "web") {
    return {
      app: "web",
      appLabel: "WEB",
      accountKey: "harbour",
      accountLabel: "Harbour",
      scope: "web",
      scopeLabel: "管理前端",
      locationLabel: s.key.startsWith("web:cowork:") ? "Cowork" : "Main Chat",
      actorRole: s.origin?.actorRole || "owner",
      authorName: s.origin?.authorName || "用户",
    };
  }

  let accountKey = s.origin?.accountKey || "";
  let targetId = s.origin?.targetId || "";
  if (platform === "discord" && (!accountKey || !targetId)) {
    const parts = s.key.split(":");
    if (parts.length >= 4) {
      accountKey ||= parts[1] || "default";
      targetId ||= parts[2] || "";
    } else {
      accountKey ||= "default";
      targetId ||= parts[1] || "";
    }
  }
  if (platform === "qq" && (!accountKey || !targetId)) {
    const parts = s.key.split(":");
    accountKey ||= parts[1] || "default";
    targetId ||= parts.length >= 5 ? decodeURIComponent(parts[3] || "") : parts[1] || "";
  }
  const shortTarget = targetId ? `${targetId.slice(0, 6)}…${targetId.slice(-4)}` : "未知位置";
  const scope = s.origin?.scope || "unknown";
  const scopeLabel = scope === "dm" ? "私聊" : scope === "guild" ? "服务器" : scope === "group" ? "群聊" : "频道/私聊";
  const locationLabel = s.origin?.containerName
    ? [s.origin.containerName, s.origin.locationName].filter(Boolean).join(" · ")
    : s.origin?.locationName || `${scopeLabel} · ${shortTarget}`;
  const isDiscord = platform === "discord";
  const isQQ = platform === "qq";
  const isWeCom = platform === "wecom" || platform === "wechat";
  return {
    app: isWeCom ? "wecom" : platform,
    appLabel: isDiscord ? "DISCORD" : isQQ ? "QQ" : isWeCom ? "企业微信" : platform.toUpperCase(),
    accountKey: accountKey || null,
    accountLabel: s.origin?.accountLabel || accountKey || (isDiscord ? "Discord Bot" : isQQ ? "QQ Bot" : "Harbour"),
    targetId: targetId || null,
    scope,
    scopeLabel,
    locationLabel,
    containerName: s.origin?.containerName || null,
    authorName: s.origin?.authorName || null,
    actorRole: s.origin?.actorRole || null,
  };
}

/** 发给 Web/Electron 的附件引用不暴露服务端绝对路径；播放器只需要受鉴权的 /uploads URL。 */
function publicAttachment(attachment: Attachment) {
  const { path: _serverPath, ...publicValue } = attachment;
  return {
    ...publicValue,
    ...(attachment.image ? { image: { ...attachment.image } } : {}),
    ...(attachment.transcription ? { transcription: { ...attachment.transcription } } : {}),
  };
}

/** 会话详情（含 summary + messages，供前端载入历史）。 */
function sessionDetail(s: ChatSession, activeId?: string, chatOnly = false) {
  return {
    ...sessionSummary(s, activeId),
    summary: s.summary,
    messages: s.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.actor ? { actor: { ...m.actor } } : {}),
      ...(m.attachments?.length ? { attachments: m.attachments.map(publicAttachment) } : {}),
      ...(m.runRecord ? { runRecord: { ...m.runRecord } } : {}),
      ...(m.role === "assistant" && m.fileChanges?.length ? { fileChanges: normalizeFileChanges(m.fileChanges) } : {}),
      ...(m.role === "assistant" && m.calendarCards?.length ? { calendarCards: normalizeCalendarCards(m.calendarCards) } : {}),
    })),
    // A compact reader needs every retained message, not the much larger raw
    // tool trace. This is display projection only; no history/context mutation.
    ...(!chatOnly ? {
      plan: checkpointPlan(s.checkpoint) ?? s.plan ?? null,
      traces: s.traces ?? null,
      times: s.times ?? null,
      durations: s.durations ?? null,
      checkpoint: checkpointDetail(s.checkpoint),
    } : {}),
  };
}

function checkpointSummary(checkpoint: ChatSession["checkpoint"]) {
  if (!checkpoint) return null;
  const completed = checkpoint.tools.filter((c) => c.status === "completed").length;
  const replayable = checkpoint.tools.filter((c) => c.status === "completed" && c.replayable).length;
  const next = checkpoint.tools.find((c) => c.status !== "completed");
  return {
    id: checkpoint.id,
    status: checkpoint.status,
    agentName: checkpoint.agentName,
    modelRef: checkpoint.modelRef ?? null,
    reasoningEffort: checkpoint.reasoningEffort ?? null,
    permissionMode: checkpoint.permissionMode ?? null,
    cowork: checkpoint.cowork ? { ...checkpoint.cowork } : null,
    completed,
    replayable,
    pending: checkpoint.tools.length - completed,
    total: checkpoint.tools.length,
    resumeCount: checkpoint.resumeCount,
    nextStep: next ? { sequence: next.sequence, agent: next.agent, tool: next.tool, status: next.status } : null,
    createdAt: checkpoint.createdAt,
    updatedAt: checkpoint.updatedAt,
    interruptedAt: checkpoint.interruptedAt ?? null,
    reason: checkpoint.reason ?? null,
  };
}

function checkpointDetail(checkpoint: ChatSession["checkpoint"]) {
  const summary = checkpointSummary(checkpoint);
  if (!checkpoint || !summary) return null;
  return {
    ...summary,
    originalInput: checkpoint.originalInput,
    latestResumeInput: checkpoint.latestResumeInput ?? null,
    actor: checkpoint.actor ? { ...checkpoint.actor } : null,
    attachments: checkpoint.attachments?.map(publicAttachment) ?? [],
    tools: checkpoint.tools.map((call) => ({
      id: call.id,
      sequence: call.sequence,
      agent: call.agent,
      tool: call.tool,
      args: call.args,
      kind: call.kind,
      status: call.status,
      replayable: call.replayable,
      replayCount: call.replayCount ?? 0,
      error: call.error ?? null,
      resultPreview: checkpointResultPreview(call.result),
    })),
  };
}

function checkpointPlan(checkpoint: ChatSession["checkpoint"]): unknown | null {
  if (!checkpoint) return null;
  const call = [...checkpoint.tools].reverse().find((c) => c.tool === "submit_plan" && c.status === "completed");
  if (!call) return null;
  const args = call.args;
  const rawSteps = Array.isArray(args.steps) ? args.steps : [];
  const steps = rawSteps.map((raw, index) => {
    if (typeof raw === "string" || typeof raw === "number") {
      return { n: index + 1, title: String(raw) };
    }
    const step = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    return {
      ...step,
      n: index + 1,
      title: String(step.title ?? step.step ?? step.name ?? step.text ?? `步骤 ${index + 1}`),
    };
  });
  return {
    goal: String(args.goal ?? ""),
    steps,
    risks: Array.isArray(args.risks) ? args.risks : [],
    clarifications: Array.isArray(args.clarifications) ? args.clarifications : [],
    by: call.agent,
    at: call.completedAt ?? call.startedAt,
  };
}

function checkpointResultPreview(value: unknown): string | null {
  if (value === undefined) return null;
  let text: string;
  try { text = typeof value === "string" ? value : JSON.stringify(value); }
  catch { text = String(value); }
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

function agentSummary(a: ReturnType<Runtime["listAgents"]>[number], runtime?: Runtime) {
  return {
    name: a.name,
    description: a.description ?? "",
    model: a.model ?? null,
    taskType: a.taskType,
    tools: a.tools,
    workflows: (a.workflows ?? []).map((workflow) => ({
      name: workflow.name,
      description: workflow.description,
      version: workflow.version,
    })),
    subagents: (a.subagents ?? []).map((agent) => ({ ...agent })),
    contextBudget: a.contextBudget,
    contextBudgetMode: a.contextBudget === "auto" ? "auto" : "manual",
    configuredContextBudget: a.contextBudget === "auto" ? null : a.contextBudget,
    maxSteps: a.maxSteps ?? 20,
    permissionMode: runtime?.resolveAgentPermissionMode(a.name) ?? a.permissionMode,
    manifestPermissionMode: a.permissionMode,
    reasoningEffort: a.reasoningEffort ?? null,
    governance: a.governance ?? null,
    readsGlobalMemory: !!a.readsGlobalMemory,
    folder: !!a.agentDir,
    heartbeats: (a.heartbeats ?? []).length,
  };
}

async function saveAgent(res: ServerResponse, deps: ServerDeps, body: Record<string, unknown>): Promise<void> {
  const rawName = String(body.name ?? "").trim();
  const name = rawName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) return sendJson(res, 400, { error: "name 非法（只允许字母数字与连字符）" });
  const systemPrompt = String(body.systemPrompt ?? "").trim();
  if (!systemPrompt) return sendJson(res, 400, { error: "systemPrompt 不能为空" });
  const permissionMode = normalizeAgentPermissionMode(body.permissionMode ?? "dontAsk");
  if (!permissionMode) return sendJson(res, 400, { error: `未知 permissionMode: ${String(body.permissionMode)}` });
  const taskType = String(body.taskType ?? "research");
  const budgetInput = body.contextBudget === undefined ? "auto" : body.contextBudget;
  const contextBudget = budgetInput === "auto" ? "auto" : typeof budgetInput === "number" ? budgetInput : NaN;
  if (contextBudget !== "auto" && (!Number.isSafeInteger(contextBudget) || contextBudget <= 0)) {
    return sendJson(res, 400, { error: "contextBudget 必须为 auto 或正整数 token 数" });
  }

  // 防误伤：文件夹型 agent 不允许从面板用扁平 .md 覆盖（会造成同名重复）。
  const dirPath = path.join(path.resolve(process.cwd(), deps.runtime.agentsDir), name);
  if (await isDir(dirPath)) {
    return sendJson(res, 409, {
      error: `「${name}」是文件夹型 agent，请直接在磁盘编辑 agents/${name}/（SOUL.md / CLAUDE.md 等），面板暂不支持覆盖。`,
    });
  }

  const frontmatter: Record<string, unknown> = {
    name,
    description: String(body.description ?? "") || undefined,
    model: body.model ? String(body.model) : undefined,
    taskType,
    tools: Array.isArray(body.tools) ? body.tools.map(String) : [],
    contextBudget,
    maxSteps: body.maxSteps ? Number(body.maxSteps) : undefined,
    permissionMode,
  };
  // 去掉 undefined，gray-matter 才不会写出 null。
  for (const k of Object.keys(frontmatter)) if (frontmatter[k] === undefined) delete frontmatter[k];

  const file = path.join(path.resolve(process.cwd(), deps.runtime.agentsDir), `${name}.md`);
  const content = matter.stringify(`\n${systemPrompt}\n`, frontmatter);
  await fs.writeFile(file, content, "utf8");
  const agents = await deps.runtime.reload();
  deps.logger.info({ name, file }, "web:agent-saved（已热重载）");
  return sendJson(res, 200, { saved: name, agents: agents.map((a) => agentSummary(a, deps.runtime)) });
}

async function deleteAgent(res: ServerResponse, deps: ServerDeps, name: string): Promise<void> {
  const safe = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const file = path.join(path.resolve(process.cwd(), deps.runtime.agentsDir), `${safe}.md`);
  try {
    await fs.unlink(file);
  } catch {
    return sendJson(res, 404, { error: `找不到 agent 文件: ${safe}.md` });
  }
  const agents = await deps.runtime.reload();
  deps.logger.info({ name: safe }, "web:agent-deleted（已热重载）");
  return sendJson(res, 200, { deleted: safe, agents: agents.map((a) => agentSummary(a, deps.runtime)) });
}

/* ── 静态文件 ───────────────────────────────────────────────────── */

async function serveStatic(res: ServerResponse, pathname: string, logger: Logger): Promise<void> {
  let rel = pathname === "/" ? "/index.html" : pathname;
  // 防目录穿越
  const target = path.normalize(path.join(WEB_DIR, rel));
  if (!target.startsWith(WEB_DIR)) {
    return sendText(res, 403, "Forbidden");
  }
  // 本地 dev dashboard：禁缓存，确保每次刷新都拿到最新 css/js（否则改了样式看不到）。
  const noCache = { "Cache-Control": "no-store, must-revalidate", Pragma: "no-cache", Expires: "0" } as const;
  try {
    const data = await fs.readFile(target);
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream", ...noCache });
    res.end(data);
  } catch {
    // SPA 兜底：未知路径回 index.html
    try {
      const data = await fs.readFile(path.join(WEB_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[".html"]!, ...noCache });
      res.end(data);
    } catch {
      logger.warn({ pathname }, "static:not-found");
      sendText(res, 404, "Not found（web/ 目录缺失？）");
    }
  }
}

/* ── 多模态上传 ─────────────────────────────────────────────────── */

function sttConfigForDashboard(deps: ServerDeps): Record<string, unknown> {
  return {
    status: deps.stt.status(),
    config: {
      enabled: deps.env.STT_ENABLED,
      url: deps.env.STT_URL,
      provider: deps.env.STT_PROVIDER,
      headersConfigured: !!deps.env.STT_HEADERS,
      model: deps.env.STT_MODEL,
      language: deps.env.STT_LANGUAGE || "auto",
      fallbacksConfigured: !!deps.env.STT_FALLBACKS_JSON,
      timeoutMs: deps.env.STT_TIMEOUT_MS,
      maxAudioMb: deps.env.STT_MAX_AUDIO_MB,
      maxSeconds: deps.env.STT_MAX_SECONDS,
      maxConcurrency: deps.env.STT_MAX_CONCURRENCY,
      maxRequestsPerMinute: deps.env.STT_MAX_REQUESTS_PER_MINUTE,
    },
  };
}

function syncSttEnv(env: Env, source: Record<string, unknown>, config: ReturnType<typeof readSttGatewayConfig>): void {
  env.STT_ENABLED = config.enabled;
  env.STT_URL = String(source.STT_URL ?? "");
  env.STT_PROVIDER = String(source.STT_PROVIDER ?? "primary") || "primary";
  env.STT_HEADERS = String(source.STT_HEADERS ?? "");
  env.STT_MODEL = String(source.STT_MODEL ?? "sensevoice") || "sensevoice";
  env.STT_LANGUAGE = String(source.STT_LANGUAGE ?? "auto") || "auto";
  env.STT_FALLBACKS_JSON = String(source.STT_FALLBACKS_JSON ?? "");
  env.STT_TIMEOUT_MS = config.timeoutMs;
  env.STT_MAX_AUDIO_MB = config.maxAudioBytes / 1024 / 1024;
  env.STT_MAX_SECONDS = config.maxSeconds;
  env.STT_MAX_CONCURRENCY = config.maxConcurrency;
  env.STT_MAX_REQUESTS_PER_MINUTE = config.maxRequestsPerMinute;
}

function ttsConfigForDashboard(deps: ServerDeps): Record<string, unknown> {
  let configured = null;
  let draft = null;
  let error: string | null = null;
  try {
    configured = readTtsGatewayConfig(deps.env);
    // URL 尚未填写或功能关闭时，UI 仍要能回显角色 Profile；只借 loopback 解析，绝不请求它。
    draft = configured ?? readTtsGatewayConfig({
      ...deps.env,
      TTS_ENABLED: true,
      TTS_URL: deps.env.TTS_URL || "http://127.0.0.1/tts",
    });
  } catch (cause) {
    error = (cause as Error).message;
  }
  const parsed = draft;
  const characters = deps.runtime.listAgents()
    .filter((agent) => agent.name.startsWith("main-"))
    .map((agent) => ({
      id: agent.name.slice(5),
      agent: agent.name,
      label: agent.name.slice(5).replace(/(^|[-_])([a-z])/g, (_match, _prefix, char) => char.toUpperCase()),
    }));
  return {
    status: error
      ? { configured: false, mode: "remote", provider: null, error }
      : ttsGatewayStatus(configured),
    providers: ttsProviderCatalog(),
    characters,
    config: {
      enabled: deps.env.TTS_ENABLED,
      url: deps.env.TTS_URL,
      provider: parsed?.provider ?? deps.env.TTS_PROVIDER,
      format: parsed?.format ?? deps.env.TTS_FORMAT,
      model: deps.env.TTS_MODEL,
      voice: deps.env.TTS_VOICE,
      headersConfigured: !!deps.env.TTS_HEADERS,
      ext: parsed?.ext ?? deps.env.TTS_EXT,
      timeoutMs: parsed?.timeoutMs ?? deps.env.TTS_TIMEOUT_MS,
      maxAudioMb: (parsed?.maxAudioBytes ?? deps.env.TTS_MAX_AUDIO_MB * 1024 * 1024) / 1024 / 1024,
      profiles: parsed?.profiles ?? {},
      cacheEnabled: parsed?.cache.enabled ?? deps.env.TTS_CACHE_ENABLED,
      cacheMaxMb: (parsed?.cache.maxBytes ?? deps.env.TTS_CACHE_MAX_MB * 1024 * 1024) / 1024 / 1024,
      tencentFallback: tencentTtsSettings(deps.env),
      namedVoices: (parsed?.namedVoices || readNamedVoices("")).map(({ headers, ...item }) => ({ ...item, headersConfigured: !!headers })),
    },
  };
}

function syncTtsEnv(env: Env, source: Record<string, unknown>, validated: NonNullable<ReturnType<typeof readTtsGatewayConfig>>): void {
  const rawEnabled = String(source.TTS_ENABLED ?? "true").trim().toLowerCase();
  env.TTS_ENABLED = ["true", "1", "yes", "on"].includes(rawEnabled);
  env.TTS_URL = String(source.TTS_URL ?? "").trim();
  env.TTS_PROVIDER = validated.provider;
  env.TTS_FORMAT = validated.format;
  env.TTS_MODEL = String(source.TTS_MODEL ?? "").trim();
  env.TTS_VOICE = String(source.TTS_VOICE ?? "").trim();
  env.TTS_HEADERS = String(source.TTS_HEADERS ?? "");
  env.TTS_EXT = validated.ext;
  env.TTS_TIMEOUT_MS = validated.timeoutMs;
  env.TTS_MAX_AUDIO_MB = validated.maxAudioBytes / 1024 / 1024;
  env.TTS_PROFILES_JSON = String(source.TTS_PROFILES_JSON ?? "");
  env.TTS_CACHE_ENABLED = validated.cache.enabled;
  env.TTS_CACHE_DIR = String(source.TTS_CACHE_DIR ?? "").trim();
  env.TTS_CACHE_MAX_MB = validated.cache.maxBytes / 1024 / 1024;
  env.TTS_TENCENT_FALLBACK_ENABLED = /^(true|1|yes|on)$/i.test(String(source.TTS_TENCENT_FALLBACK_ENABLED ?? "false").trim());
  env.TENCENT_TTS_SECRET_ID = String(source.TENCENT_TTS_SECRET_ID ?? "").trim();
  env.TENCENT_TTS_SECRET_KEY = String(source.TENCENT_TTS_SECRET_KEY ?? "").trim();
}

function requestAbortController(req: IncomingMessage, res: ServerResponse): AbortController {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  req.once("aborted", cancel);
  res.once("close", () => { if (!res.writableEnded) cancel(); });
  return controller;
}

function sttTraceFromResult(result: SttTranscriptionResult, attachment: string): Record<string, unknown> {
  return {
    msg: "stt:complete",
    source: "gateway",
    provider: result.provider,
    processingMs: result.processingMs,
    ...(result.audioDurationMs ? { audioDurationMs: result.audioDurationMs } : {}),
    preview: result.text.replace(/\s+/g, " ").slice(0, 180),
    attachment,
  };
}

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
  "audio/amr": ".amr",
  "video/webm": ".video.webm",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
};

function kindFromMime(mime: string): Attachment["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

function uploadsDir(deps: ServerDeps): string {
  return path.resolve(process.cwd(), deps.env.UPLOAD_DIR);
}

/** POST /api/upload 实现：base64 落盘到 UPLOAD_DIR，返回可随消息流转的 Attachment。 */
async function saveUpload(res: ServerResponse, deps: ServerDeps, body: Record<string, unknown>): Promise<void> {
  const name = String(body.name ?? "upload").replace(/[\r\n]/g, "").slice(0, 200);
  const mime = String(body.mime ?? "application/octet-stream");
  // 接受裸 base64 或 data URL（data:image/png;base64,xxxx）。
  let raw = String(body.dataBase64 ?? body.data ?? "");
  const comma = raw.indexOf(",");
  if (raw.startsWith("data:") && comma >= 0) raw = raw.slice(comma + 1);
  if (!raw) return sendJson(res, 400, { error: "缺少 dataBase64" });

  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "base64");
  } catch {
    return sendJson(res, 400, { error: "dataBase64 解码失败" });
  }
  const maxBytes = deps.env.MAX_UPLOAD_MB * 1024 * 1024;
  if (buf.byteLength > maxBytes) {
    return sendJson(res, 413, { error: `文件超过上限 ${deps.env.MAX_UPLOAD_MB}MB` });
  }

  const kind = (["image", "video", "audio", "file"].includes(String(body.kind)) ? String(body.kind) : kindFromMime(mime)) as
    Attachment["kind"];
  const ext = MIME_EXT[mime] ?? path.extname(name) ?? "";
  const fileName = `${randomUUID()}${ext}`;
  const dir = path.join(uploadsDir(deps), "inbound");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, fileName), buf);

  const attachment = {
    kind,
    url: `/uploads/inbound/${fileName}`,
    path: path.relative(process.cwd(), path.join(dir, fileName)).split(path.sep).join("/"),
    mime,
    name,
    size: buf.byteLength,
    ...(Number.isFinite(Number(body.durationMs)) && Number(body.durationMs) > 0
      ? { durationMs: Math.round(Number(body.durationMs)) }
      : {}),
  };
  deps.logger.info({ kind, name, size: buf.byteLength }, "web:upload");
  return sendJson(res, 201, { attachment });
}

/** 把 /api/run body 里的 attachments 净化成合法的 Attachment[]（丢弃畸形项）。 */
function sanitizeAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const url = String(a.url ?? "");
    if (!url) continue;
    const kind = (["image", "video", "audio", "file"].includes(String(a.kind)) ? String(a.kind) : "file") as
      Attachment["kind"];
    out.push({
      kind,
      url,
      // 客户端不能自行指定服务器路径；/uploads URL 会在受控图片/STT 入站层解析。
      mime: String(a.mime ?? "application/octet-stream"),
      name: String(a.name ?? "attachment"),
      ...(typeof a.size === "number" ? { size: a.size } : {}),
      ...(typeof a.durationMs === "number" && Number.isFinite(a.durationMs) && a.durationMs > 0
        ? { durationMs: Math.round(a.durationMs) }
        : {}),
    });
  }
  return out;
}

/* ── 小工具 ─────────────────────────────────────────────────────── */

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  // 【必须要求 application/json —— 这是 CSRF 护栏，不是格式洁癖】
  // 浏览器对 text/plain、form-urlencoded、multipart 这三种 Content-Type 的跨站 POST
  // 【不发预检】（simple request），会直接打到本机服务；而本项目默认 WEB_AUTH_TOKEN 为空、
  // 只靠监听 127.0.0.1 —— 那挡得住局域网，挡不住【你自己浏览器里打开的任意网页】。
  // 于是一个恶意页面就能静默触发 /api/governance/rollback 这类真实变更。
  // 要求 application/json 会强制浏览器走预检，而预检在 WEB_CORS=false 时被拒 → 攻击断在门口。
  const ct = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct && ct !== "application/json") {
    throw new Error(`请求体必须是 application/json（收到 ${ct}）`);
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  // 没带 Content-Type 但带了 body 的，同样拒绝：正常客户端都会带，裸 body 更像是绕检查。
  if (!ct) throw new Error("请求体缺少 Content-Type: application/json");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}
