import dotenv from "dotenv";
import { z } from "zod";
import { applySharedSettingsDefaults, readSharedSettings } from "../core/sharedSettings";
import { DSH_DEFAULT_OUTPUT_TOKENS, DSH_MAX_OUTPUT_TOKENS, DSH_DEFAULT_SPILL_INLINE_TOKENS } from "../core/dshLimits";

// override: true —— 本项目 .env 必须压过机器级环境变量。
// 这台机器在 OS 级设了 ANTHROPIC_BASE_URL（指向别处/anthropic），dotenv 默认不覆盖已存在的
// 环境变量，会导致把 Kimi token 发去错误的 endpoint（401）。override 保证 Harbour 永远走自己
// .env 里的配置，与机器/任何网关解耦。
applySharedSettingsDefaults(process.env, readSharedSettings());
dotenv.config({ override: true });

/**
 * 环境变量校验。共享普通设置可作为默认值；本机 .env 优先，密钥与设备路径绝不入共享文件。
 * 用 zod 给默认值 + 类型转换（env 全是字符串，这里转 bool/number）。
 */

/** "true"/"1"/"yes" → true，其余 → false。 */
const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null ? def : ["true", "1", "yes", "on"].includes(v.toLowerCase())));

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  ANTHROPIC_AUTH_TOKEN: z.string().optional().default(""),
  ANTHROPIC_BASE_URL: z.string().optional().default(""),
  CLAUDE_AGENT_MODEL: z.string().default("sonnet"),
  CLAUDE_AGENT_FALLBACK_MODEL: z.string().optional().default(""),

  // ── 跨端点 fallback 后端（可选）──────────────────────────────────
  // 主后端（claude-agent）挂了/限流时，router 自动切到这里。常见用法：
  // 主 = Kimi Code 会员（api.kimi.com/coding，走会员额度）；
  // 备 = Kimi 开放平台（api.moonshot.cn，走充值余额）。
  // 配了任一 token/key 即注册为 backend 前缀 "claude-agent-fallback"。
  ANTHROPIC_FALLBACK_API_KEY: z.string().optional().default(""),
  ANTHROPIC_FALLBACK_AUTH_TOKEN: z.string().optional().default(""),
  ANTHROPIC_FALLBACK_BASE_URL: z.string().optional().default(""),
  ANTHROPIC_FALLBACK_MODEL: z.string().optional().default(""),

  OPENROUTER_API_KEY: z.string().optional().default(""),
  OPENROUTER_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),

  MOCK_LLM: boolish(false),
  // Backend-only path to a Google-downloaded Web OAuth JSON. Never mirrored to shared settings.
  GOOGLE_OAUTH_CREDENTIALS_FILE: z.string().default(""),
  GOOGLE_CALENDAR_CLIENT_ID: z.string().default(""),
  GOOGLE_CALENDAR_CLIENT_SECRET: z.string().default(""),
  GOOGLE_CALENDAR_REDIRECT_URI: z.string().default("http://localhost:7799/api/calendar/oauth/callback"),
  GOOGLE_GMAIL_CLIENT_ID: z.string().default(""),
  GOOGLE_GMAIL_CLIENT_SECRET: z.string().default(""),
  GOOGLE_GMAIL_REDIRECT_URI: z.string().default("http://localhost:7799/api/gmail/oauth/callback"),
  GOOGLE_MAPS_API_KEY: z.string().default(""),
  GOOGLE_MAPS_DAILY_REQUEST_LIMIT: z.coerce.number().int().min(1).max(10000).default(50),
  LOG_LEVEL: z.string().default("info"),

  // 模型槽允许指向的 host 白名单（逗号分隔，子域自动放行）。dashboard 写模型槽时校验：
  // 模型槽 = 「把某个 env 变量的值当 Bearer 发往某个 URL」，不限制的话一次写入就能把密钥
  // 送去任意端点。这也是「本项目绝不使用公司网关」的结构性保障。留空 = 不限制（不建议）。
  MODEL_HOST_ALLOWLIST: z.string().default("api.anthropic.com,api.kimi.com,api.moonshot.cn,api.deepseek.com,openrouter.ai"),

  // 入口 persona agent：Discord 收到的消息、以及各 API 不显式指定 agent 时都用它。
  // Harbour 支持多个「角色」（agents/main-*），这里选默认那个；web 端可在对话里随时切换。
  // 注意：改这里等于换默认老婆——会话记忆按 agentName 隔离，各角色互不串味。
  DEFAULT_AGENT: z.string().default("main-assistant"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  AGENTS_DIR: z.string().default("./agents"),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),

  ENABLE_CLAUDE_CLI: boolish(false),
  CLAUDE_CLI_BIN: z.string().default("claude"),

  // ── OpenAI Codex Harness（可选、与 Claude Agent SDK 完全并列）────────────
  // 只在显式开启后注册 backend 前缀 codex-app-server/*；绝不进入现有全局 fallback 链。
  // 默认使用项目依赖或本机已验证的新版，通过服务端已有的 ChatGPT OAuth。
  ENABLE_CODEX_HARNESS: boolish(false),
  // 手工指定路径不自动替换；空值由 Harbour 维护最新稳定版。
  CODEX_HARNESS_BIN: z.string().optional().default(""),
  CODEX_HARNESS_AUTO_UPDATE: boolish(true),
  // 留空时从 App Server model/list 自动发现；也可用逗号手工补充模型 id。
  CODEX_HARNESS_MODEL: z.string().optional().default(""),
  CODEX_HARNESS_MODELS: z.string().optional().default(""),
  // 0=沿用 Harbour 对 GPT 的保守推断；非 0 时覆盖 model selector/compaction 的窗口值。
  CODEX_HARNESS_CONTEXT_WINDOW: z.coerce.number().int().nonnegative().default(0),
  CODEX_HARNESS_STARTUP_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  // DSH official kernel experiment; no default/fallback or native plugin loading.
  ENABLE_DSH_HARNESS: boolish(false),
  // Explicit opt-in: default Flash task routes use DSH; exact SDK/Codex selections stay exact.
  DSH_HARNESS_DEFAULT_FLASH: boolish(false),
  DSH_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(DSH_MAX_OUTPUT_TOKENS).default(DSH_DEFAULT_OUTPUT_TOKENS),
  DSH_SPILL_INLINE_TOKENS: z.coerce.number().int().min(0).max(65_536).default(DSH_DEFAULT_SPILL_INLINE_TOKENS),

  // 桌面控制总开关（desktop-control 安全护栏）：默认关，开了才允许鼠标/键盘/截屏。
  ENABLE_DESKTOP_CONTROL: boolish(false),

  // ── Harbour 浏览器工具：专用隔离 Chrome（OpenCLI Browser / browser-harness / CDP）────
  // 只操作这个独立实例，绝不碰主人日常 Chrome（也绝不连日常 Chrome 的 9222）。
  // Harbour 自有运行数据默认留在当前项目 data/runtime，不占系统用户目录，不入 Git。
  HARBOUR_DATA_HOME: z.string().default(""),
  HARBOUR_OPENCLI_BROWSER_HOME: z.string().default(""),
  // browser-harness 可执行名（uv tool install 后在 PATH；也可填全路径）。
  BROWSER_HARNESS_BIN: z.string().default("browser-harness"),
  // OpenCLI Browser Bridge 的固定 profile alias。Harbour 只允许它指向专属隔离 Chrome。
  OPENCLI_PROFILE: z.string().regex(/^[A-Za-z0-9_-]+$/).default("harbour"),
  // OpenCLI session/tab 的 idle lease（秒）。普通任务仍由 finally 立即清理；仅 handoff 页会保留到此上限。
  OPENCLI_BROWSER_IDLE_TIMEOUT: z.coerce.number().int().positive().max(86_400).default(3_600),
  // Electron 自带本机后端时预热 daemon + 隔离 Chrome；普通服务端默认懒启动，避免无 GUI 主机产生噪声。
  OPENCLI_BROWSER_AUTOSTART: boolish(false),
  // 隔离 Chrome 的独立 user-data-dir（登录态存这里，跨重启复用）。空 = 按平台推导默认值。
  HARBOUR_CHROME_PROFILE_DIR: z.string().optional().default(""),
  // OpenCLI Browser Bridge 的 unpacked 扩展目录。空 = 按平台推导到 Harbour 本地目录；
  // 目录存在 manifest.json 时由 Harbour 启动 Chrome 时固定加载，不依赖日常 Chrome 安装状态。
  HARBOUR_CHROME_EXTENSION_DIR: z.string().optional().default(""),
  // 隔离 Chrome 可执行文件路径。空 = 按平台探测常见安装位置。
  HARBOUR_CHROME_PATH: z.string().optional().default(""),
  // 隔离 Chrome 的调试端口（绝不用日常 Chrome 的 9222；配成 9222 会被直接拒绝）。
  HARBOUR_CHROME_DEBUG_PORT: z.coerce.number().int().positive().default(9333),
  // headless：默认 false（有头窗口，便于首次手动登录 + 观察）。
  HARBOUR_CHROME_HEADLESS: boolish(false),
  // browser-harness 状态目录（auth / 截图 / 日志 / socket），落主人本地目录、不入库。空 = 按平台推导。
  HARBOUR_BROWSER_HARNESS_HOME: z.string().optional().default(""),
  // 启动隔离 Chrome 后等待 CDP 端点就绪的超时（ms）。
  HARBOUR_CHROME_START_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),

  // 前端管理 dashboard（serve 时一并启动）
  WEB_ENABLED: boolish(true),
  WEB_PORT: z.coerce.number().int().positive().default(7799),
  // 监听地址：默认 0.0.0.0（树莓派/局域网可访问；Electron 桌面端连同一 API）。
  // 只想本机访问可设 127.0.0.1。
  WEB_HOST: z.string().default("127.0.0.1"),
  // 跨域：默认允许（个人工具 + 方便 Electron/桌面端跨 origin 调 API）。
  WEB_CORS: boolish(true),
  // 访问令牌：非空时所有 /api/* /uploads/* 与 WS 都要带它（静态页放行，便于登录页加载）。
  // 空值只放本机回环；任何局域网/远程请求都会被拒绝，直到配置长随机串。
  WEB_AUTH_TOKEN: z.string().optional().default(""),
  // Independent game credential; never grants Web owner authority or enters shared settings.
  MINECRAFT_API_ENABLED: boolish(false),
  MINECRAFT_API_KEY: z.string().default(""),
  MINECRAFT_API_ALLOW_REMOTE: boolish(false),

  // 多模态上传：落盘目录（gitignore）+ 单文件大小上限（MB）。
  UPLOAD_DIR: z.string().default("./assets/uploads"),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(25),
  // 聊天附件默认保留 30 天；到期后删物理文件，并在原消息位置保留可读占位符。0=关闭。
  ATTACHMENT_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(30),
  ATTACHMENT_CLEANUP_INTERVAL_HOURS: z.coerce.number().positive().max(24 * 30).default(24),

  // ── 远端 STT 网关 ────────────────────────────────────────────────
  // QQ 官方事件已有 ASR 时直接复用；其余语音才发往 OpenAI-compatible
  // POST /v1/audio/transcriptions。Harbour/Electron/树莓派均不启动本地 PyTorch。
  STT_ENABLED: boolish(true),
  STT_URL: z.string().optional().default(""),
  STT_PROVIDER: z.string().default("primary"),
  STT_HEADERS: z.string().optional().default(""),
  STT_MODEL: z.string().default("sensevoice"),
  STT_LANGUAGE: z.string().optional().default("auto"),
  // 后备 Provider 数组；每项可覆盖 name/url/headers/model/language。
  STT_FALLBACKS_JSON: z.string().optional().default(""),
  STT_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  STT_MAX_AUDIO_MB: z.coerce.number().positive().default(25),
  STT_MAX_SECONDS: z.coerce.number().positive().default(300),
  STT_MAX_CONCURRENCY: z.coerce.number().int().positive().default(2),
  STT_MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(12),

  // ── 远端 TTS 网关 ────────────────────────────────────────────────
  // 推理服务可位于另一台 GPU 主机或云端。Harbour/Electron 当前机器不会因此启动 Python/PyTorch。
  // 空 URL 可直接用已配置的腾讯备用；总开关关闭时任何供应商都不调用。
  TTS_ENABLED: boolish(true),
  TTS_URL: z.string().optional().default(""),
  // provider 是面向人的来源标签；format 才决定实际请求协议。二者分开，避免把“厂家”和“接口形状”混为一谈。
  // 空值时由 TTS_FORMAT 推导内建 Provider，兼容升级前只配置 format 的部署。
  TTS_PROVIDER: z.string().optional().default(""),
  TTS_FORMAT: z.enum(["json", "query", "gpt-sovits-v2", "openai-speech", "mimo-chat-audio"]).default("json"),
  TTS_MODEL: z.string().optional().default(""),
  TTS_VOICE: z.string().optional().default(""),
  TTS_HEADERS: z.string().optional().default(""),
  TTS_EXT: z.string().default("wav"),
  TTS_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  TTS_MAX_AUDIO_MB: z.coerce.number().positive().default(25),
  // 角色到声线参数的 JSON。GPT-SoVITS 的 refAudioPath 在推理服务上；MiMo VoiceClone 的在 Harbour 后端上。
  TTS_PROFILES_JSON: z.string().optional().default(""),
  TTS_VOICES_JSON: z.string().optional().default(""),
  TTS_VOICE_SELECTIONS_JSON: z.string().optional().default(""),
  // 音频缓存始终落操作系统用户数据目录，不进入 Harbour 仓库；同一句话/同一声线无需重复付费合成。
  TTS_CACHE_ENABLED: boolish(true),
  TTS_CACHE_DIR: z.string().optional().default(""),
  TTS_CACHE_MAX_MB: z.coerce.number().positive().default(512),
  // 只保存在本机 .env，不进入 sharedSettings 或任何客户端响应。
  TTS_TENCENT_FALLBACK_ENABLED: boolish(false),
  TENCENT_TTS_SECRET_ID: z.string().optional().default(""),
  TENCENT_TTS_SECRET_KEY: z.string().optional().default(""),

  // ── daily_news：每日 AI 动态简报（自包含：抓 RSS → Kimi 中文摘要 → markdown，纯内存）──────
  // 生成用的 OpenAI 兼容端点（指向 Kimi）。默认 moonshot 开放平台 OpenAI 兼容 base。
  DAILY_NEWS_OPENAI_BASE: z.string().default("https://api.moonshot.cn/v1"),
  // 生成用 key。空 = 复用 .env 的 ANTHROPIC_FALLBACK_AUTH_TOKEN（moonshot），再退 ANTHROPIC_AUTH_TOKEN。
  DAILY_NEWS_OPENAI_KEY: z.string().optional().default(""),
  // 生成模型 id（moonshot/kimi）。
  DAILY_NEWS_MODEL: z.string().default("kimi-k2.6"),
  // 投递目标 Discord 频道 id（空 = 不发 Discord，仅 web-only；使用 DISCORD_NEWS_BOT 对应实例的 token）。
  DAILY_NEWS_DISCORD_CHANNEL_ID: z.string().optional().default(""),
  // 最多为多少条资讯出 AI 摘要（每条一次 LLM 调用；省 token 的上限）。
  DAILY_NEWS_SUMMARY_LIMIT: z.coerce.number().int().positive().default(40),
  // 只收 N 天内的资讯（更早的丢弃）。
  DAILY_NEWS_MAX_AGE_DAYS: z.coerce.number().int().positive().default(3),

  // ── stock_news：美股间隔监控（每票 SEC/Yahoo/Google 三源 → 去重出新消息 + 现价快照 + 异动）──
  // 盯盘标的（逗号分隔的 ticker）。NOW=ServiceNow / ORCL=Oracle / CELH=Celsius Holdings。
  STOCK_NEWS_TICKERS: z.string().default("AMD,NOW,ORCL,CELH"),
  // 投递目标 Discord 频道 id（空 = web-only；与 daily_news 频道分开配）。
  STOCK_NEWS_DISCORD_CHANNEL_ID: z.string().optional().default(""),
  // 每轮最多为多少条【新消息】出摘要（省 token 上限）。
  STOCK_NEWS_SUMMARY_LIMIT: z.coerce.number().int().positive().default(20),
  // 只收 N 天内的资讯（间隔监控 → 更短）。
  STOCK_NEWS_MAX_AGE_DAYS: z.coerce.number().int().positive().default(2),
  // 只投递发布时间在最近 N 小时内的消息——确保推送的都是「本盯盘间隔内的新消息」。
  // 建议设成 ≥ 盯盘 cron 间隔（略大一点留余量，避免边界消息被漏投）。当前 cron 每 2h → 设 3。
  STOCK_NEWS_WINDOW_HOURS: z.coerce.number().positive().default(3),
  // 价格异动阈值（%）：较上次报告 |涨跌| ≥ 此值也触发一份简报（哪怕没有新消息）。
  STOCK_NEWS_MOVE_THRESHOLD_PCT: z.coerce.number().positive().default(3),
  // SEC EDGAR 要求带表明身份的 User-Agent（含邮箱），否则可能被限流/封禁。
  // 请改成你自己的，格式如："Your Name your-email@example.com"。
  STOCK_NEWS_SEC_USER_AGENT: z.string().default("Harbour News Bot your-email@example.com"),
  // 跨运行去重 + 存价的落盘文件（gitignore 的本地状态）。
  STOCK_NEWS_SEEN_STORE: z.string().default("./data/stockNewsSeen.json"),

  // ── 跨轮会话记忆 + 压缩（compaction）──────────────────────────────
  // 开启后：每个来源（Discord 频道 / web 主聊天 / cron continue 作业）= 一段会持续
  // 累积的 session（Harbour 记得上文）；正文超阈值就把早前对话摘要成滚动摘要。
  SESSIONS_ENABLED: boolish(true),
  // 会话落盘目录（含对话内容=隐私，已 gitignore）。
  SESSION_DIR: z.string().default("./data/sessions"),
  // 压缩触发阈值（正文估算 token）。>0 用绝对值（便于演示设很小）；=0 用【模型 context window × 0.8】
  //（CC 式「近满才压」：让历史连续攒到逼近窗口才压一次，最大化 prompt cache 命中、最少破前缀）。
  SESSION_COMPACT_TOKENS: z.coerce.number().int().nonnegative().default(0),
  // 压缩时原样保留的最近消息【条数】兜底（至少留这么多条，保证连贯）。默认 2 = 最后一轮问答。
  SESSION_KEEP_RECENT: z.coerce.number().int().positive().default(2),
  // 压缩时按【token】保留的最近原文窗口。默认 0 =「压全部前文」（除兜底 KEEP_RECENT 条外，
  // 其余历史全部收进详尽摘要，context 彻底重置为小体量）；设 >0 则额外保留最近这么多 token 的原文。
  SESSION_KEEP_RECENT_TOKENS: z.coerce.number().int().nonnegative().default(0),

  // 思考模式：开启后 claude-agent SDK 请求带 thinking（Kimi 会员端点据此路由到 K2.7），
  // 思考过程会以 loop:thinking 事件流到前端 trace。默认关（省 token）。
  CLAUDE_AGENT_THINKING: boolish(false),

  // Discord 多 Bot：逗号分隔实例名；空 = 兼容旧版单 Bot（DISCORD_BOT_TOKEN + DEFAULT_AGENT）。
  // 每个命名实例读取 DISCORD_BOT_<NAME>_{TOKEN,APPLICATION_ID,AGENT,ALLOWLIST,LABEL}。
  DISCORD_BOTS: z.string().optional().default(""),
  // 主人 Discord 用户 ID（逗号分隔）。与 allowlist 分离：allowlist=可使用，OWNER=可读取私密 persona/调用工具。
  // 空值 fail-closed：所有 Discord 用户都按 non-owner 公开模式处理。
  OWNER_DISCORD_IDS: z.string().optional().default(""),
  // 新闻主动投递使用哪个 botKey；空 = default（若有）否则第一个已配置 token 的 Bot。
  DISCORD_NEWS_BOT: z.string().optional().default(""),
  // Discord 专用 HTTP CONNECT 代理（REST + Gateway）；如本机 FlClash：http://127.0.0.1:7890。
  // 空 = 直连。只代理 Discord，不改变 Kimi/DeepSeek/RSS 的出站路径。
  DISCORD_PROXY_URL: z.string().optional().default(""),
  // 旧版 default Bot 的非密钥 Application ID（也兼容 DISCORD_CLIENT_ID）。
  DISCORD_APPLICATION_ID: z.string().optional().default(""),
  DISCORD_BOT_TOKEN: z.string().optional().default(""),
  DISCORD_ALLOWLIST: z.string().optional().default(""),

  // ── QQ 官方机器人（QQ 开放平台）────────────────────────────────
  // 只接受 q.qq.com 创建机器人后获得的 AppID + AppSecret；绝不读取个人 QQ 密码。
  // 多 Bot：逗号分隔实例名；命名实例读取 QQ_BOT_<NAME>_*，空值兼容旧版 QQBOT_* 单 Bot。
  QQ_BOTS: z.string().optional().default(""),
  QQBOT_APP_ID: z.string().optional().default(""),
  QQBOT_APP_SECRET: z.string().optional().default(""),
  QQBOT_AGENT: z.string().optional().default(""),
  QQBOT_LABEL: z.string().optional().default("QQ Bot"),
  // sender openid / group openid，逗号分隔；空值 fail-closed（已绑定 owner 始终放行）。
  QQBOT_ALLOWLIST: z.string().optional().default(""),
  // 可手工预置主人 openid；通常留空，使用私聊 `/bind <一次性配对码>` 自动登记。
  OWNER_QQ_OPENIDS: z.string().optional().default(""),
  QQBOT_PAIRING_CODE: z.string().optional().default(""),
  QQBOT_BINDINGS_FILE: z.string().optional().default("./data/qqBindings.json"),
  // 群聊默认只处理 @ 机器人的消息；私聊不受影响。
  QQBOT_REQUIRE_MENTION: boolish(true),
  QQBOT_MARKDOWN: boolish(false),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // 配置错误属于致命：直接报清楚哪一项错了。
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`环境变量校验失败：\n${issues}`);
  }
  return parsed.data;
}

/** 把逗号分隔的白名单解析成 Set。 */
export function parseAllowlist(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}
