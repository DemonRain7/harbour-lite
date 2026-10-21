import { createHash } from "node:crypto";
import path from "node:path";
import OpenAI from "openai";
import Parser from "rss-parser";
import type { Logger } from "pino";
import type { Env } from "../../config/env";
import { resolveDiscordBotConfigs, selectDiscordNewsBot } from "../../config/discordBots";
import type { ToolContext, ToolDef } from "../../types";
import { DEFAULT_DAILY_RSS_SOURCES } from "./dailyNewsSources";
import { buildStockSources, buildQuoteSnapshot, TICKER_INFO } from "./stockNewsSources";
import { StockNewsStore } from "./stockNewsStore";
import { formatZonedIso, getHarbourTimeZone } from "../timeZone";

/**
 * news 工具底座：抓一组 RSS 源 → 用 Kimi（OpenAI 兼容端点）出中文摘要 → 拼 markdown → 投递。
 *
 * 一套管线、两种“口味”（NewsKindConfig 驱动），导出三工具：
 *  - `ai_news_generate`   ——每日 AI 动态简报（抓 17 个 AI RSS，全量摘要，含配图）。
 *  - `stock_news_generate`——美股间隔监控（每票三源，seen-store 跨运行去重 + 现价快照 + 价格异动，
 *                             本轮无新消息且无异动 → hasContent:false，agent 不投递）。
 *  - `news_deliver`       ——两者共用的投递（Discord / web-only；Discord 侧把配图转裸链接自动嵌图）。
 *
 * 设计要点：
 *  - 纯内存生成：简报 markdown 直接作为工具返回值流给 deliver，不写盘（stock 的 seen-store 例外，那是去重态）。
 *  - LLM 走 openai SDK 打 OpenAI 兼容端点（与其他 agent 同一套 Kimi key）；RSS 解析用 rss-parser。
 *  - **kimi-k2.6 只接受 temperature=1（传 0.3 会 400）**，故摘要调用一律不传 temperature、用模型默认值。
 */

// ── 类型 ────────────────────────────────────────────────────────────────
// group 放宽为 string：AI 用固定分组名，stock 用 ticker 作 group。
export type DailyRssSourceGroup = string;

export interface DailyRssSource {
  id: string;
  name: string;
  url: string;
  group: DailyRssSourceGroup;
  enabled: boolean;
  priority?: number;
  maxItems?: number;
  timeoutMs?: number;
  retries?: number;
  /** 每源自定义请求头（如 SEC 要求的表明身份 User-Agent）；覆盖默认 UA。 */
  headers?: Record<string, string>;
}

export interface DailyRssSummary {
  title_cn: string;
  summary_cn: string;
  why_it_matters?: string;
  /** stock：这条消息对标的短期情绪的方向 "up" | "down" | "neutral"。 */
  impact?: string;
  /** stock：影响理由（渲染时替 why_it_matters）。 */
  impact_reason?: string;
  tags?: string[];
  score?: number;
}

export interface DailyRssItem {
  id: string;
  title: string;
  url: string;
  description: string;
  content?: string;
  publishedAt: string;
  sourceName: string;
  sourceGroup: DailyRssSourceGroup;
  author?: string;
  /** 配图 URL（enclosure / media / 正文首图，仅 http(s)）。 */
  imageUrl?: string;
  summary?: DailyRssSummary;
}

export interface DailyRssSourceStatus {
  sourceId: string;
  sourceName: string;
  status: "success" | "failed" | "disabled";
  itemCount: number;
  error?: string;
}

/**
 * 一种新闻“口味”的全部差异都收进这里，管线本身不含 agent 专属逻辑。
 */
export interface NewsKindConfig {
  kind: string;
  toolName: string;
  sources: DailyRssSource[];
  groupTitles: Record<string, string>;
  groupOrder: string[];
  reportTitle: (date: string) => string;
  intro: string;
  summarySystem: string;
  summaryUser: (item: DailyRssItem) => string;
  summaryLimit: number;
  maxAgeDays: number;
  /** 每个 group（AI 分组 / stock 单票）最多【展示】几条。AI=5，stock=3。 */
  perGroupLimit?: number;
  /** stock 专用：摘要前每票先挑几条候选（再按 score 取 perGroupLimit 条最关键的）。 */
  perGroupCandidates?: number;
  /** true：条目用 `###` 大标题 + 消息时间的紧凑排版（stock 用），否则用编号列表（AI 用）。 */
  prominentTitle?: boolean;
  /** true：按 groupOrder 轮转分配摘要名额（防高优先源吃满、后位 group 饿死）。stock 必须开。 */
  balanceGroups?: boolean;
  /** 报头附加块（如 stock 现价快照）。 */
  buildHeaderExtra?: (logger: Logger) => Promise<string>;
  /** 报尾（如 stock 免责声明）。 */
  footer?: string;
  /** 条目标题前徽标（如 stock 的 🟢🔴⚪）。 */
  itemBadge?: (item: DailyRssItem) => string;
  /** 顶部“今日摘要”速览（AI 用）。 */
  digest?: boolean;
  /** 该口味默认投递频道（generate 结果里回传，供 agent 转给 news_deliver）。 */
  deliverChannelId?: string;
}

/** createNewsTools 的运行时配置（LLM/投递 + 两口味的 env 参数）。 */
export interface NewsToolsConfig {
  openaiBase: string;
  openaiKey: string;
  model: string;
  discordToken: string;
  ai: { summaryLimit: number; maxAgeDays: number; discordChannelId: string };
  stock: {
    tickers: string[];
    secUserAgent: string;
    moveThresholdPct: number;
    summaryLimit: number;
    maxAgeDays: number;
    /** 只投递发布时间在最近 N 小时内的消息（应 ≥ 盯盘作业的 cron 间隔）。 */
    windowHours: number;
    seenStorePath: string;
    discordChannelId: string;
  };
}

export function resolveNewsConfig(env: Env): NewsToolsConfig {
  const discordBots = resolveDiscordBotConfigs({
    ...process.env,
    DISCORD_BOTS: env.DISCORD_BOTS,
    DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN,
    DISCORD_APPLICATION_ID: env.DISCORD_APPLICATION_ID,
    DISCORD_ALLOWLIST: env.DISCORD_ALLOWLIST,
    DEFAULT_AGENT: env.DEFAULT_AGENT,
  }, env.DEFAULT_AGENT);
  const newsBot = selectDiscordNewsBot(discordBots, env.DISCORD_NEWS_BOT);
  return {
    openaiBase: env.DAILY_NEWS_OPENAI_BASE,
    openaiKey: env.DAILY_NEWS_OPENAI_KEY || env.ANTHROPIC_FALLBACK_AUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN,
    model: env.DAILY_NEWS_MODEL,
    discordToken: newsBot?.token ?? "",
    ai: {
      summaryLimit: env.DAILY_NEWS_SUMMARY_LIMIT,
      maxAgeDays: env.DAILY_NEWS_MAX_AGE_DAYS,
      discordChannelId: env.DAILY_NEWS_DISCORD_CHANNEL_ID,
    },
    stock: {
      tickers: parseTickers(env.STOCK_NEWS_TICKERS),
      secUserAgent: env.STOCK_NEWS_SEC_USER_AGENT,
      moveThresholdPct: env.STOCK_NEWS_MOVE_THRESHOLD_PCT,
      summaryLimit: env.STOCK_NEWS_SUMMARY_LIMIT,
      maxAgeDays: env.STOCK_NEWS_MAX_AGE_DAYS,
      windowHours: env.STOCK_NEWS_WINDOW_HOURS,
      seenStorePath: env.STOCK_NEWS_SEEN_STORE,
      discordChannelId: env.STOCK_NEWS_DISCORD_CHANNEL_ID,
    },
  };
}

function parseTickers(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

// 并发/超时属实现细节，常量即可。
const SUMMARY_CONCURRENCY = 3;
const SUMMARY_TIMEOUT_MS = 45000;

// ── 小工具 ──────────────────────────────────────────────────────────────
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];
const randomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Harbour Settings 时区的 YYYY-MM-DD。 */
function getISODate(date = new Date()): string {
  return formatZonedIso(date).slice(0, 10);
}

/** Harbour Settings 时区的 MM-DD HH:mm（给条目标注消息时间）；无法解析则返回空串。 */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: getHarbourTimeZone(),
  });
}

/** 压平空白并硬截断到 max 字（防摘要失败时把整篇正文塞进简报）。 */
function truncateText(s: string, max: number): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 去掉脚本/样式/标签，保留纯文本。 */
function stripHtml(html: string): string {
  if (!html) return "";
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/```css[\s\S]*?```/gi, "");
  return s.replace(/<[^>]+>/g, " ").trim();
}

/** 剥掉 ```json / ```markdown / ``` 代码围栏。 */
function removeCodeFence(text: string): string {
  if (!text) return "";
  let s = text.trim();
  for (const fence of ["```json", "```markdown", "```"]) {
    if (s.startsWith(fence)) {
      s = s.slice(fence.length);
      break;
    }
  }
  if (s.endsWith("```")) s = s.slice(0, -3);
  return s.trim();
}

// ── 简报暂存（reportId 中转，省 agent「回声」）──────────────────────────
// 痛点：日报全文可达数十 KB，若让 agent 把它「工具返回→再塞进 deliver 参数→再当最终答案回显」
// 来回搬运，纯是烧 token 的回声。改法：generate 把全文存这里、只回一个短 reportId；
// deliver 与 web 查看按 id 取回全文——agent 上下文里只过一个 id，不再驮着整篇日报。
// 纯内存 + 保留最近若干份（进程重启即失，Discord 侧已有全文；web 查看取不到会退回短状态）。
const REPORT_STORE = new Map<string, { markdown: string; at: number }>();
const REPORT_KEEP = 40;

function putReport(markdown: string): string {
  const id = `rp-${createHash("sha256").update(markdown).update(String(REPORT_STORE.size)).digest("base64url").slice(0, 12)}`;
  REPORT_STORE.set(id, { markdown, at: Date.now() });
  // 超上限按插入顺序丢最旧（Map 保序）。
  while (REPORT_STORE.size > REPORT_KEEP) {
    const oldest = REPORT_STORE.keys().next().value;
    if (oldest === undefined) break;
    REPORT_STORE.delete(oldest);
  }
  return id;
}

/** 按 reportId 取回暂存的简报全文（web「查看」/ deliver 用）；不存在返回 undefined。 */
export function getNewsReport(id: string): string | undefined {
  return REPORT_STORE.get(id)?.markdown;
}

// ── RSS 抓取 / 解析 ─────────────────────────────────────────────────────
const parser = new Parser({
  customFields: {
    item: [
      ["content:encoded", "contentEncoded"],
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: true }],
    ],
  },
});

/** 仅接受 http(s) 的 URL（拒 data:/javascript: 等）。 */
function firstHttps(url: unknown): string | undefined {
  if (typeof url === "string" && /^https?:\/\//i.test(url.trim())) return url.trim();
  return undefined;
}

/** 从 RSS 条目里提取配图：enclosure → media:content/thumbnail 的 $.url → 正文首个 <img src>；仅 http(s)。 */
function extractImageUrl(raw: Record<string, any>): string | undefined {
  const enc = raw.enclosure;
  if (enc && typeof enc === "object") {
    const url = firstHttps(enc.url);
    if (url && (/^image\//i.test(String(enc.type || "")) || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url))) return url;
  }
  const media = [...(Array.isArray(raw.mediaContent) ? raw.mediaContent : []), ...(Array.isArray(raw.mediaThumbnail) ? raw.mediaThumbnail : [])];
  for (const m of media) {
    const url = firstHttps(m?.$?.url);
    if (url) return url;
  }
  const html = String(raw.contentEncoded || raw.content || raw.summary || raw.description || "");
  const match = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  return firstHttps(match?.[1]);
}

export function canonicalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.startsWith("utm_") || ["ref", "source", "campaign"].includes(key)) parsed.searchParams.delete(key);
    }
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim().replace(/\/$/, "");
  }
}

function stableId(sourceId: string, item: Record<string, unknown>): string {
  const key = item.guid || item.id || item.link || item.title || `${sourceId}-${Date.now()}`;
  const digest = createHash("sha256").update(String(key)).digest("base64url").slice(0, 20);
  return `${sourceId}:${digest}`;
}

function toItem(source: DailyRssSource, raw: Record<string, any>): DailyRssItem {
  const content = raw.contentEncoded || raw.content || raw.summary || raw.description || "";
  const description = stripHtml(raw.contentSnippet || raw.summary || raw.description || content).replace(/\s+/g, " ").trim();
  const publishedAt = raw.isoDate || raw.pubDate || raw.published || new Date().toISOString();
  return {
    id: stableId(source.id, raw),
    title: raw.title || "无标题",
    url: raw.link || raw.guid || "",
    description,
    content: stripHtml(content).replace(/\s+/g, " ").trim(),
    publishedAt,
    sourceName: source.name,
    sourceGroup: source.group,
    author: raw.creator || raw.author || raw["dc:creator"],
    imageUrl: extractImageUrl(raw),
  };
}

function isRecent(item: DailyRssItem, now: Date, maxAgeDays: number): boolean {
  const t = new Date(item.publishedAt).getTime();
  if (Number.isNaN(t)) return true;
  return now.getTime() - t <= maxAgeDays * 24 * 60 * 60 * 1000;
}

async function fetchWithTimeout(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": randomUserAgent(),
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        // per-source headers（如 SEC 的表明身份 UA）后置，覆盖默认。
        ...headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOneSource(
  source: DailyRssSource,
  now: Date,
  maxAgeDays: number
): Promise<{ items: DailyRssItem[]; status: DailyRssSourceStatus }> {
  if (!source.enabled) {
    return { items: [], status: { sourceId: source.id, sourceName: source.name, status: "disabled", itemCount: 0 } };
  }
  const attempts = Math.max(1, source.retries || 1);
  const timeoutMs = source.timeoutMs || 15000;
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchWithTimeout(source.url, timeoutMs, source.headers);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const feed = await parser.parseString(await response.text());
      const items = (feed.items || [])
        .map((item) => toItem(source, item as Record<string, any>))
        .filter((item) => item.url && isRecent(item, now, maxAgeDays))
        .slice(0, source.maxItems || 10);
      return { items, status: { sourceId: source.id, sourceName: source.name, status: "success", itemCount: items.length } };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < attempts) await sleep(Math.min(1000 * attempt, 3000));
    }
  }
  return { items: [], status: { sourceId: source.id, sourceName: source.name, status: "failed", itemCount: 0, error: lastError } };
}

function dedupeItems(items: DailyRssItem[]): DailyRssItem[] {
  const seen = new Set<string>();
  const out: DailyRssItem[] = [];
  for (const item of items) {
    const key = item.url ? canonicalizeUrl(item.url) : item.title.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function fetchSources(
  sources: DailyRssSource[],
  maxAgeDays: number
): Promise<{ items: DailyRssItem[]; statuses: DailyRssSourceStatus[] }> {
  const now = new Date();
  const results = await Promise.all(sources.map((s) => fetchOneSource(s, now, maxAgeDays)));
  return { items: dedupeItems(results.flatMap((r) => r.items)), statuses: results.map((r) => r.status) };
}

/** 按源 priority + 发布时间倒序排。 */
function sortByPriority(items: DailyRssItem[], sources: DailyRssSource[]): DailyRssItem[] {
  return [...items].sort((a, b) => {
    const pa = sources.find((s) => s.name === a.sourceName)?.priority || 0;
    const pb = sources.find((s) => s.name === b.sourceName)?.priority || 0;
    return pb - pa || new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
  });
}

/**
 * 按 groupOrder 轮转分配（每个 group 先出各自 top1，再第 2 轮…）。
 * 让后续 summaryLimit 的名额均摊到各 group（各 ticker），而非被高优先源吃满。
 * 入参应已按 priority 排好序，故每个 group 内部保持优先级。
 */
function balanceByGroup(items: DailyRssItem[], groupOrder: string[]): DailyRssItem[] {
  const byGroup = new Map<string, DailyRssItem[]>();
  for (const g of groupOrder) byGroup.set(g, []);
  for (const it of items) {
    if (!byGroup.has(it.sourceGroup)) byGroup.set(it.sourceGroup, []);
    byGroup.get(it.sourceGroup)!.push(it);
  }
  const out: DailyRssItem[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const arr of byGroup.values()) {
      const next = arr.shift();
      if (next) {
        out.push(next);
        added = true;
      }
    }
  }
  return out;
}

/** 每个 group 最多保留 limit 条（保持入参顺序）；limit<=0 或未给 → 不限。 */
function capPerGroup(items: DailyRssItem[], limit?: number): DailyRssItem[] {
  if (!limit || limit <= 0) return items;
  const counts = new Map<string, number>();
  const out: DailyRssItem[] = [];
  for (const it of items) {
    const n = counts.get(it.sourceGroup) ?? 0;
    if (n >= limit) continue;
    counts.set(it.sourceGroup, n + 1);
    out.push(it);
  }
  return out;
}

/** 每个 group 内按摘要 score 降序，各取前 n 条（用于 stock 每票挑最关键的几条）。 */
function selectTopPerGroup(items: DailyRssItem[], groupOrder: string[], n: number): DailyRssItem[] {
  const byGroup = new Map<string, DailyRssItem[]>();
  for (const g of groupOrder) byGroup.set(g, []);
  for (const it of items) {
    if (!byGroup.has(it.sourceGroup)) byGroup.set(it.sourceGroup, []);
    byGroup.get(it.sourceGroup)!.push(it);
  }
  const out: DailyRssItem[] = [];
  for (const arr of byGroup.values()) {
    arr.sort((a, b) => (b.summary?.score ?? 0) - (a.summary?.score ?? 0));
    out.push(...arr.slice(0, n));
  }
  return out;
}

/** 只保留发布时间在最近 hours 小时内的条目（盯盘：确保投递的是本间隔内的新消息）。
 *  hours<=0 → 不过滤；时间无法解析的条目按“不在窗口内”丢弃（宁缺毋滥）。 */
function filterWindow(items: DailyRssItem[], hours?: number): DailyRssItem[] {
  if (!hours || hours <= 0) return items;
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return items.filter((it) => {
    const t = new Date(it.publishedAt).getTime();
    return !Number.isNaN(t) && t >= cutoff;
  });
}

// ── AI 摘要（Kimi，OpenAI 兼容）─────────────────────────────────────────
/** 归一化 base：确保以 /v1 结尾（openai SDK 会在其后拼 /chat/completions）。 */
function normalizeBase(base: string): string {
  const trimmed = base.replace(/\/$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function buildAiSummaryPrompt(item: DailyRssItem): string {
  const content = [item.title, item.description, item.content].filter(Boolean).join("\n\n").slice(0, 2500);
  return `请把下面这条英文 AI 资讯整理为中文日报条目。只输出 JSON，不要输出解释。

JSON 字段：
- title_cn: 中文标题，18 字以内
- summary_cn: 中文摘要，80-160 字
- why_it_matters: 为什么重要，50 字以内
- tags: 2-5 个中文标签数组
- score: 1-10 的重要性分数

来源：${item.sourceName}
链接：${item.url}
内容：
${content}`;
}

function buildStockSummaryPrompt(item: DailyRssItem): string {
  const content = [item.title, item.description, item.content].filter(Boolean).join("\n\n").slice(0, 2000);
  return `请把下面这条美股相关资讯压成一条**简短**中文要点。只输出 JSON，不要输出解释。

JSON 字段：
- title_cn: 中文标题，18 字以内，点明关键信息
- summary_cn: 中文摘要，40-60 字，客观复述事件，别啰嗦
- impact: 只能是 "up" / "down" / "neutral" 之一（这条消息对该标的短期情绪的方向；不确定填 neutral）
- impact_reason: 25 字以内，只讲逻辑，不要给出买卖结论
- score: 1-10 的重要性分数（越关键越高，用于挑出最重要的几条）

标的：${item.sourceGroup}
来源：${item.sourceName}
内容：
${content}`;
}

function parseSummaryObject(text: string): DailyRssSummary | null {
  if (!text) return null;
  const cleaned = removeCodeFence(text).trim();
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as DailyRssSummary;
  } catch {
    /* fallthrough：用平衡括号提取第一个完整 JSON 对象 */
  }
  const start = cleaned.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < cleaned.length; i++) {
      if (cleaned[i] === "{") depth++;
      else if (cleaned[i] === "}") {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(cleaned.slice(start, i + 1));
            if (obj && typeof obj === "object") return obj as DailyRssSummary;
          } catch {
            /* ignore */
          }
          break;
        }
      }
    }
  }
  return null;
}

async function summarizeItems(
  items: DailyRssItem[],
  client: OpenAI,
  model: string,
  limit: number,
  system: string,
  buildUser: (item: DailyRssItem) => string
): Promise<DailyRssItem[]> {
  const result = [...items];
  const targets = items.slice(0, limit);
  let nextIndex = 0;

  async function summarizeOne(item: DailyRssItem): Promise<DailyRssItem> {
    // 最多 2 次，避免长文首次超时就退回英文。
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // 注意：kimi-k2.6 只接受 temperature=1（传 0.3 会 400），故不传、用模型默认值。
        const res = await client.chat.completions.create(
          {
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: buildUser(item) },
            ],
          },
          { timeout: SUMMARY_TIMEOUT_MS, maxRetries: 0 }
        );
        const parsed = parseSummaryObject(res.choices[0]?.message?.content ?? "");
        if (parsed && parsed.summary_cn) return { ...item, summary: parsed };
      } catch {
        /* 继续重试 */
      }
    }
    return item;
  }

  async function worker() {
    while (nextIndex < targets.length) {
      const i = nextIndex++;
      result[i] = await summarizeOne(targets[i]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(SUMMARY_CONCURRENCY, targets.length) }, () => worker()));
  return result;
}

// ── 渲染 markdown ───────────────────────────────────────────────────────
function renderItem(item: DailyRssItem, index: number, kindCfg: NewsKindConfig): string {
  const badge = kindCfg.itemBadge?.(item) ?? "";
  const title = item.summary?.title_cn || item.title;
  // 摘要缺失（Kimi 调用失败/超时）时【硬截断】兜底，绝不把整篇正文塞进来。
  const whyText = item.summary?.impact_reason ?? item.summary?.why_it_matters;

  // stock 口味：`###` 大标题 + 消息时间 + 短正文的紧凑排版（标题显眼、字少）。
  if (kindCfg.prominentTitle) {
    const summary = item.summary?.summary_cn || truncateText(item.description || item.content || "", 100) || "暂无摘要。";
    const time = formatTime(item.publishedAt);
    const meta = [time ? `🕒 ${time}` : "", item.sourceName].filter(Boolean).join(" · ");
    const why = whyText ? `　｜　潜在影响：${whyText}` : "";
    const lines = [`### ${badge}[${title}](${item.url})`];
    if (meta) lines.push(`_${meta}_`);
    lines.push("", `${summary}${why}`);
    return lines.join("\n");
  }

  // AI 口味：编号列表 + 配图 + 标签（沿用原“很规范”的排版）。
  const image = item.imageUrl ? `\n\n   ![](${item.imageUrl})` : "";
  const summary = item.summary?.summary_cn || truncateText(item.description || item.content || "", 180) || "暂无摘要。";
  const whyLabel = item.summary?.impact_reason != null ? "潜在影响" : "为什么重要";
  const why = whyText ? `\n\n   **${whyLabel}：** ${whyText}` : "";
  const tags = item.summary?.tags?.length ? `\n\n   标签：${item.summary.tags.map((t) => `\`${t}\``).join(" ")}` : "";
  return `${index}. ${badge}**[${title}](${item.url})**${image}\n\n   ${summary}${why}${tags}\n\n   来源：${item.sourceName}`;
}

function renderReportMarkdown(kindCfg: NewsKindConfig, date: string, items: DailyRssItem[], headerExtra: string): string {
  const lines: string[] = [kindCfg.reportTitle(date), "", `> ${kindCfg.intro}`, ""];
  if (headerExtra) lines.push(headerExtra, "");
  if (kindCfg.digest) {
    lines.push("## 今日摘要", "");
    const top = items.slice(0, 5);
    if (top.length === 0) {
      lines.push("今日没有抓取到可用内容。", "");
    } else {
      lines.push("```");
      for (const it of top) lines.push(`- ${it.summary?.title_cn || it.title}`);
      lines.push("```", "");
    }
  }
  const cap = kindCfg.perGroupLimit;
  for (const group of kindCfg.groupOrder) {
    const grouped = items.filter((it) => it.sourceGroup === group);
    const shown = cap ? grouped.slice(0, cap) : grouped;
    if (shown.length === 0) continue;
    lines.push(`## ${kindCfg.groupTitles[group] ?? group}`, "");
    shown.forEach((it, idx) => lines.push(renderItem(it, idx + 1, kindCfg), ""));
  }
  // 兜底：group 不在 groupOrder 里的条目也别丢（同样受每组上限约束）。
  const extra = items.filter((it) => !kindCfg.groupOrder.includes(it.sourceGroup));
  const extraShown = cap ? extra.slice(0, cap) : extra;
  if (extraShown.length) {
    lines.push("## 其它", "");
    extraShown.forEach((it, idx) => lines.push(renderItem(it, idx + 1, kindCfg), ""));
  }
  if (kindCfg.footer) lines.push("---", "", kindCfg.footer, "");
  return `${lines.join("\n").trim()}\n`;
}

/** AI 口味端到端：抓源 → 排序 → Kimi 摘要 → 拼 markdown（纯内存，不写盘）。 */
async function generateBrief(
  kindCfg: NewsKindConfig,
  cfg: NewsToolsConfig,
  logger: Logger
): Promise<{ markdown: string; itemCount: number; statuses: DailyRssSourceStatus[]; headlines: string[] }> {
  const date = getISODate();
  const { items, statuses } = await fetchSources(kindCfg.sources, kindCfg.maxAgeDays);
  const ordered = kindCfg.balanceGroups
    ? balanceByGroup(sortByPriority(items, kindCfg.sources), kindCfg.groupOrder)
    : sortByPriority(items, kindCfg.sources);
  // 先按每组上限裁剪，再摘要——保证【展示的每一条】都有摘要，绝不出现未摘要的正文兜底刷屏。
  const selected = capPerGroup(ordered, kindCfg.perGroupLimit);
  const client = new OpenAI({ baseURL: normalizeBase(cfg.openaiBase), apiKey: cfg.openaiKey });
  const summarized = await summarizeItems(selected, client, cfg.model, kindCfg.summaryLimit, kindCfg.summarySystem, kindCfg.summaryUser);
  const headerExtra = kindCfg.buildHeaderExtra ? await kindCfg.buildHeaderExtra(logger) : "";
  const okCount = statuses.filter((s) => s.status === "success").length;
  const failed = statuses.filter((s) => s.status === "failed");
  logger.info({ kind: kindCfg.kind, items: summarized.length, sourcesOk: okCount, sourcesFailed: failed.length }, "news: 简报生成完成");
  // 头条清单（前 8 条标题）：给 agent 当「短状态」用，无需驮着全文。
  const headlines = summarized.slice(0, 8).map((it) => it.summary?.title_cn || it.title);
  return { markdown: renderReportMarkdown(kindCfg, date, summarized, headerExtra), itemCount: summarized.length, statuses, headlines };
}

// ── stock 编排（seen-store 去重 + 现价 + 异动 + hasContent 分支）──────────
function renderStockMoveAlerts(moves: { ticker: string; prev: number; cur: number; pct: number }[]): string {
  if (!moves.length) return "";
  const lines = moves.map(
    (m) => `- ⚠️ **${m.ticker}** 较上次报告 ${m.pct >= 0 ? "📈 +" : "📉 "}${m.pct.toFixed(2)}%（${m.prev.toFixed(2)} → ${m.cur.toFixed(2)}）`
  );
  return ["**⚠️ 价格异动**", "", ...lines].join("\n");
}

async function generateStockBrief(
  kindCfg: NewsKindConfig,
  cfg: NewsToolsConfig,
  store: StockNewsStore,
  logger: Logger
): Promise<Record<string, unknown>> {
  const date = getISODate();
  const { items, statuses } = await fetchSources(kindCfg.sources, kindCfg.maxAgeDays);
  // 只保留发布时间在盯盘窗口（≈ cron 间隔）内的消息，再跨运行去重出【本轮新出现】的。
  const windowed = filterWindow(items, cfg.stock.windowHours);
  const fresh = store.filterUnseen(windowed);
  const snapshot = await buildQuoteSnapshot(kindCfg.groupOrder, logger);
  const moves = store.priceMoves(snapshot.prices, cfg.stock.moveThresholdPct);
  const okCount = statuses.filter((s) => s.status === "success").length;

  const hasContent = fresh.length > 0 || moves.length > 0;
  if (!hasContent) {
    logger.info(
      { scanned: items.length, windowed: windowed.length, windowHours: cfg.stock.windowHours, sourcesOk: okCount },
      "stock_news: 本轮窗口内无新消息、无异动（不投递）"
    );
    return {
      ok: true,
      hasContent: false,
      note: "本轮无新增消息、无价格异动，无需投递。",
      scanned: items.length,
      windowed: windowed.length,
      sources: { ok: okCount, failed: statuses.filter((s) => s.status === "failed").map((s) => s.sourceName) },
    };
  }

  // 每票先挑 ≤perGroupCandidates 条候选 → 摘要（拿到 score）→ 每票按 score 取前 perGroupLimit 条最关键的。
  const ordered = balanceByGroup(sortByPriority(fresh, kindCfg.sources), kindCfg.groupOrder);
  const candidates = capPerGroup(ordered, kindCfg.perGroupCandidates);
  const client = new OpenAI({ baseURL: normalizeBase(cfg.openaiBase), apiKey: cfg.openaiKey });
  const summarized = await summarizeItems(candidates, client, cfg.model, kindCfg.summaryLimit, kindCfg.summarySystem, kindCfg.summaryUser);
  const top = selectTopPerGroup(summarized, kindCfg.groupOrder, kindCfg.perGroupLimit ?? 3);
  const moveText = renderStockMoveAlerts(moves);
  const headerExtra = [snapshot.markdown, moveText].filter(Boolean).join("\n\n");
  const markdown = renderReportMarkdown(kindCfg, date, top, headerExtra);
  const reportId = putReport(markdown);
  // 更新 seen（把【所有】fresh 都标记已见，含未展示的，避免下轮重现）+ 存价（下轮据此算异动）。
  await store.commit(store.keysOf(fresh), snapshot.prices);
  logger.info(
    { fresh: fresh.length, shown: top.length, moves: moves.length, sourcesOk: okCount },
    "stock_news: 简报生成完成"
  );
  // 头条清单（每条：徽标 + 中文标题）：给 agent 当「短状态」，无需驮着全文。
  const headlines = top.map((it) => `${stockBadge(it)}${it.summary?.title_cn || it.title}`);
  return {
    ok: true,
    hasContent: true,
    reportId,
    itemCount: top.length,
    newItems: fresh.length,
    moves: moves.length,
    headlines,
    channelId: kindCfg.deliverChannelId || undefined,
    sources: { ok: okCount, failed: statuses.filter((s) => s.status === "failed").map((s) => s.sourceName) },
  };
}

// ── Discord 投递 ────────────────────────────────────────────────────────
/**
 * 把简报 markdown 调整成适合 Discord 的形态：
 *  - 独占一行的 `![](https…)`：保留前 4 张改成裸 URL（Discord 会自动嵌图），其余整行删（防刷屏）。
 *  - 行内图片：删掉图片语法、保留其余文字。
 */
function discordify(text: string): string {
  const MAX_IMAGES = 6; // 保留前若干张配图（Discord 会自动嵌图）；再多整行删，防刷屏。
  let kept = 0;
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)\s*$/.exec(line);
    if (m) {
      if (kept < MAX_IMAGES) {
        out.push(m[1]!);
        kept++;
      }
      continue; // 超过上限的独占图片行整行删
    }
    out.push(line.replace(/!\[[^\]]*\]\((?:https?:\/\/[^)\s]+)\)/g, "").replace(/[ \t]+$/g, ""));
  }
  return out.join("\n");
}

/** 按 Discord 单条 2000 字上限把长文分段。 */
function chunk(text: string, size = 1900): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size; // 没有合适换行就硬切
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

/**
 * 按顶层 `## ` 小节把简报切成多个「块」：首个 `## ` 之前的报头（标题/引言/现价快照/异动）自成一块，
 * 其后每个 `## ` 小节（stock=每支票 / AI=每个分组）各自成一块。
 *
 * 为什么要切：Discord 会把一条消息里【所有链接】的预览 embed 统一堆到【该条消息的末尾】。
 * 若整份简报塞进一条消息，AMD 的链接预览就会跑到最后一支票（CELH）的标题下面（串台）。
 * 一小节一条消息后，每支票的链接预览只落在它自己那条消息末尾，各归各位。
 * 没有 `## ` 小节（理论上不会）时退化为整段一块，行为与旧版一致。
 */
function splitTopLevelSections(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const body = current.join("\n").trim();
    if (body) blocks.push(body);
    current = [];
  };
  for (const line of text.split(/\r?\n/)) {
    // 恰好两个 # 的顶层小节标题开新块（`### ` 三级标题不算）；当前块已有内容才切，避免开头空块。
    if (/^##(?!#)\s+/.test(line) && current.some((l) => l.trim())) flush();
    current.push(line);
  }
  flush();
  return blocks;
}

async function sendDiscord(cfg: NewsToolsConfig, channelId: string, text: string): Promise<number> {
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  // 一小节一条消息（stock=每票 / AI=每分组）：让链接预览 embed 落在各自小节末尾，不串到别的票下面。
  // 单节仍可能超 2000 字，故每块再走 chunk 兜底分段。
  let sent = 0;
  for (const block of splitTopLevelSections(text)) {
    for (const part of chunk(block)) {
      await postDiscordSegment(url, cfg.discordToken, part);
      sent++;
    }
  }
  return sent;
}

/**
 * 单段投递，带超时 + 退避重试。cron 跑很久、网络（尤其翻墙）偶尔抖一下就整条日报投递失败太亏，
 * 故把「网络错误 / 请求超时 / 429 限流 / 5xx」都当暂时性，退避重试至多 4 次；429 读 retry_after。
 * 其它 4xx（400 正文非法 / 403 无权限 / 404 频道不存在）是真错，立即抛、不空转重试。
 */
async function postDiscordSegment(url: string, token: string, content: string): Promise<void> {
  const maxAttempts = 4;
  let lastErr = "未知错误";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bot ${token}` },
        body: JSON.stringify({ content }),
        signal: controller.signal,
      });
      if (res.ok) return;
      const body = (await res.text()).slice(0, 300);
      if (res.status !== 429 && res.status < 500) throw new Error(`Discord 发送失败（${res.status}）：${body}`);
      lastErr = `HTTP ${res.status}: ${body}`;
      let waitMs = 800 * attempt;
      try {
        const j = JSON.parse(body) as { retry_after?: number };
        if (typeof j.retry_after === "number") waitMs = Math.ceil(j.retry_after * 1000) + 250;
      } catch {
        /* 非 JSON 正文，用默认退避 */
      }
      if (attempt < maxAttempts) await sleep(waitMs);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Discord 发送失败（")) throw e; // 真 4xx：向上抛
      lastErr = (e as Error).name === "AbortError" ? "请求超时(15s)" : String((e as Error).message || e);
      if (attempt < maxAttempts) await sleep(800 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Discord 发送失败（重试 ${maxAttempts} 次仍失败）：${lastErr}`);
}

// ── 口味构造 ────────────────────────────────────────────────────────────
const AI_GROUP_TITLES: Record<string, string> = {
  company: "OpenAI / Google / Anthropic 公司动态",
  practitioner: "从业者观点",
  community: "社区热点",
  papers: "论文与模型",
  products: "每日产品",
  github: "GitHub 项目",
};
const AI_GROUP_ORDER = ["company", "products", "github", "papers", "practitioner", "community"];

function buildAiKind(cfg: NewsToolsConfig): NewsKindConfig {
  return {
    kind: "ai",
    toolName: "ai_news_generate",
    sources: DEFAULT_DAILY_RSS_SOURCES,
    groupTitles: AI_GROUP_TITLES,
    groupOrder: AI_GROUP_ORDER,
    reportTitle: (date) => `# AI 资讯日报 ${date}`,
    intro: "自动抓取 AI 公司博客、从业者博客与社区聚合源，并生成中文摘要。",
    summarySystem: "你是专业的中文 AI 行业日报编辑。",
    summaryUser: buildAiSummaryPrompt,
    summaryLimit: cfg.ai.summaryLimit,
    maxAgeDays: cfg.ai.maxAgeDays,
    // 每个分组最多 5 条；轮转分配摘要名额，让各分组都摊到（而非高优先源吃满）。
    perGroupLimit: 5,
    balanceGroups: true,
    digest: true,
    deliverChannelId: cfg.ai.discordChannelId,
  };
}

function stockBadge(item: DailyRssItem): string {
  const im = item.summary?.impact;
  return im === "up" ? "🟢 " : im === "down" ? "🔴 " : "⚪ ";
}

function buildStockKind(cfg: NewsToolsConfig): NewsKindConfig {
  const tickers = cfg.stock.tickers;
  const groupTitles: Record<string, string> = {};
  for (const t of tickers) {
    const info = TICKER_INFO[t];
    groupTitles[t] = info ? `${info.company}（${t}）` : t;
  }
  return {
    kind: "stock",
    toolName: "stock_news_generate",
    sources: buildStockSources(tickers, cfg.stock.secUserAgent),
    groupTitles,
    groupOrder: tickers,
    reportTitle: (date) => `# 美股盯盘简报 ${date}`,
    intro: `盯盘标的：${tickers.join(" / ")}。汇总 SEC 披露 / 财经媒体 / 新闻聚合，仅信息聚合、不构成投资建议。`,
    summarySystem: "你是专业的美股盯盘分析助理，只做信息聚合与要点提炼，绝不给出买卖建议。",
    summaryUser: buildStockSummaryPrompt,
    summaryLimit: cfg.stock.summaryLimit,
    maxAgeDays: cfg.stock.maxAgeDays,
    // 每票先挑 ≤8 条候选摘要，再按重要性挑最关键的 3 条投递；标题走 `###` 大字紧凑排版。
    perGroupLimit: 3,
    perGroupCandidates: 8,
    prominentTitle: true,
    balanceGroups: true,
    itemBadge: stockBadge,
    footer: "— 本简报仅为公开信息聚合，不构成任何投资建议；据此操作，风险自负。",
    deliverChannelId: cfg.stock.discordChannelId,
  };
}

// ── 工具导出 ────────────────────────────────────────────────────────────
export function createNewsTools(cfg: NewsToolsConfig): ToolDef[] {
  const aiKind = buildAiKind(cfg);
  const stockKind = buildStockKind(cfg);

  // seen-store 懒初始化（首次调用 stock_news_generate 时载入，复用 ctx.logger）。
  let stockStore: StockNewsStore | null = null;
  const seenTtlMs = Math.max(cfg.stock.maxAgeDays, 7) * 24 * 60 * 60 * 1000;
  async function getStockStore(logger: Logger): Promise<StockNewsStore> {
    if (!stockStore) {
      const file = path.isAbsolute(cfg.stock.seenStorePath)
        ? cfg.stock.seenStorePath
        : path.resolve(process.cwd(), cfg.stock.seenStorePath);
      stockStore = new StockNewsStore(logger, file, seenTtlMs);
      await stockStore.load();
    }
    return stockStore;
  }

  const aiGenerate: ToolDef = {
    name: "ai_news_generate",
    description:
      "生成当天 AI 动态中文简报：抓取 AI 相关 RSS 源，用 Kimi 出中文摘要（含配图）。全文暂存服务端，只返回 reportId + 头条清单 + 抓取统计——投递时把 reportId 传给 news_deliver 即可，无需搬运全文。",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx: ToolContext) {
      if (!cfg.openaiKey) {
        return { ok: false, error: "缺少生成用的 AI key（DAILY_NEWS_OPENAI_KEY 或 .env 的 ANTHROPIC_FALLBACK_AUTH_TOKEN 皆空）。" };
      }
      const { markdown, itemCount, statuses, headlines } = await generateBrief(aiKind, cfg, ctx.logger);
      if (itemCount === 0) {
        return {
          ok: false,
          error: "所有 RSS 源都没抓到可用内容（可能网络/源失效）。",
          failedSources: statuses.filter((s) => s.status === "failed").map((s) => s.sourceName),
        };
      }
      const reportId = putReport(markdown);
      return {
        ok: true,
        reportId,
        itemCount,
        headlines,
        channelId: aiKind.deliverChannelId || undefined,
        sources: {
          ok: statuses.filter((s) => s.status === "success").length,
          failed: statuses.filter((s) => s.status === "failed").map((s) => s.sourceName),
        },
      };
    },
  };

  const stockGenerate: ToolDef = {
    name: "stock_news_generate",
    description:
      "美股间隔监控：抓每个标的的 SEC/Yahoo/Google 源，跨运行去重出【新消息】+ 现价快照 + 价格异动。本轮无新消息且无异动则返回 hasContent:false（不必投递）；否则返回 markdown 全文。",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx: ToolContext) {
      if (!cfg.openaiKey) {
        return { ok: false, error: "缺少生成用的 AI key（DAILY_NEWS_OPENAI_KEY 或 .env 的 ANTHROPIC_FALLBACK_AUTH_TOKEN 皆空）。" };
      }
      if (!cfg.stock.tickers.length) {
        return { ok: false, error: "未配置盯盘标的（STOCK_NEWS_TICKERS 为空）。" };
      }
      const store = await getStockStore(ctx.logger);
      return generateStockBrief(stockKind, cfg, store, ctx.logger);
    },
  };

  const deliver: ToolDef = {
    name: "news_deliver",
    description:
      "投递简报：优先传 generate 返回的 reportId（按 id 取回暂存全文，省得把整篇日报再塞进参数）；也兼容直接传 text。配了 DISCORD_BOT_TOKEN + 频道则发 Discord（每小节分条发、配图转裸链接自动嵌图）；否则 web-only（简报在 Web CRON tab 的 LAST RESULT 按 reportId 查看）。",
    parameters: {
      type: "object",
      properties: {
        reportId: { type: "string", description: "generate 返回的 reportId（优先）：按它取回暂存的简报全文投递" },
        text: { type: "string", description: "简报 Markdown 全文（无 reportId 时的兜底；一般传 reportId 即可）" },
        channelId: { type: "string", description: "可选：覆盖默认 Discord 频道 id（generate 结果里回传了对应口味的频道）" },
      },
    },
    async execute(args, ctx: ToolContext) {
      const reportId = String(args.reportId || "").trim();
      let text = String(args.text ?? "").trim();
      if (reportId) {
        const stored = getNewsReport(reportId);
        if (stored) text = stored;
        else if (!text) return { delivered: false, reason: `reportId ${reportId} 未找到（可能已过期），且未提供 text` };
      }
      if (!text) return { delivered: false, reason: "未提供 reportId 或 text，无可投递内容" };
      const channelId = String(args.channelId || cfg.ai.discordChannelId || "");
      if (!cfg.discordToken || !channelId) {
        return {
          delivered: false,
          channel: "web-only",
          reason: !cfg.discordToken ? "DISCORD_BOT_TOKEN 未配置" : "未指定 Discord 频道",
          note: "简报已作为最终回答返回，会在 Harbour Web「CRON」tab 的 LAST RESULT 呈现。",
        };
      }
      const segments = await sendDiscord(cfg, channelId, discordify(text));
      ctx.logger.info({ channelId, segments }, "news_deliver:discord");
      return { delivered: true, channel: "discord", channelId, segments };
    },
  };

  return [aiGenerate, stockGenerate, deliver];
}
