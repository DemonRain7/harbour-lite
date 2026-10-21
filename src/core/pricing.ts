import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

/**
 * 模型计费表 —— dashboard「成本」那块的唯一事实源。
 *
 * 【为什么要从代码里挪出来】原来这张表硬编码在 web/app.js 里，改价格得改代码、
 * 重新部署；而且只写了 kimi 两条，别的模型统统掉进 __default 套用 kimi 单价 ——
 * 接 Claude Opus 会按 ¥4/1M 算，差十倍还看不出来。价格是【会变的数据】，不是代码。
 *
 * 【三条硬规矩】
 *  ① 单价一律按【每 100 万 token】存，和界面显示的口径一致（OpenRouter 给的是
 *    每 token，抓取时就地乘 1e6，别把两种口径混在一张表里）。
 *  ② manual 覆盖 auto；不附带任何用户的合同价，自动刷新不覆盖用户手工设置。
 *  ③ 查不到单价就是查不到，绝不回退到某个"默认价"。宁可界面上显示"未配单价"，
 *    也不给一个看起来像真的的错数字（用户 的选择，2026-07-22）。
 */

/** 每 100 万 token 的一组单价。 */
export interface TokenRates {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Provider 有分时价格时保留两档；主 PriceEntry 采用 selected 指定的一档参与估算。 */
export interface PriceRateSchedule {
  timeZone: "UTC";
  /** 旧版为 peak；新版按每笔 usage 的发生时刻动态选择。 */
  selected: "peak" | "usage-time";
  peakHours: string;
  /** UTC 星期：0=周日；时间段左闭右开。缺失时会从 peakHours 解析。 */
  peakWindows?: Array<{ daysOfWeek: number[]; startMinute: number; endMinute: number }>;
  offPeak: TokenRates;
  peak: TokenRates;
}

/** 每 100 万 token 的单价。cacheRead=命中缓存读取价，cacheWrite=写入缓存价。 */
export interface PriceEntry {
  /** ISO 4217，目前用到 USD / CNY */
  cur: string;
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  /** manual=合同/人工钉住；official=官方直连价；auto=OpenRouter 等上游自动价。 */
  source: "manual" | "official" | "auto";
  updatedAt: string;
  /** 抓取时对应的上游 id，便于回查（如 moonshotai/kimi-k2.7-code） */
  upstreamId?: string;
  /** 分时价元数据；新 usage 按发生时刻选档并把金额冻结进账本。 */
  rateSchedule?: PriceRateSchedule;
  /** 给 Dashboard 解释当前采用哪种价格口径。 */
  rateNote?: string;
}

export interface PricingTable {
  updatedAt: string;
  /** 界面统一显示的币种。多币种直接相加是错的，必须先换算。 */
  displayCurrency: string;
  /**
   * 各币种兑 displayCurrency 的汇率。汇率会漂，界面上要把用的是哪个值显示出来，
   * 让人一眼能判断数字可不可信 —— 藏起来的汇率等于藏起来的误差。
   */
  fx: Record<string, number>;
  fxUpdatedAt?: string;
  models: Record<string, PriceEntry>;
  /** 最近一次自动刷新的结果，给面板显示用 */
  lastRefresh?: { at: string; ok: boolean; added: number; updated: number; warnings?: string[]; error?: string };
}

const FILE = path.resolve(process.cwd(), "data", "modelPricing.json");
const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";
const DEEPSEEK_PRICING = "https://api-docs.deepseek.com/quick_start/pricing";

/**
 * 出厂默认表。只钉 用户 确实签了合同的那些 —— 别的一律留空等抓取，
 * 抓不到就显示"未配单价"。
 */
function defaults(): PricingTable {
  return { updatedAt: new Date().toISOString(), displayCurrency: "USD", fx: { USD: 1 }, models: {} };
}

/** 读表；文件不存在或损坏都回默认表（并把损坏的备份走，别静默盖掉）。 */
export async function loadPricing(logger?: Logger): Promise<PricingTable> {
  let raw: string;
  try {
    raw = await fs.readFile(FILE, "utf8");
  } catch {
    return defaults(); // 首次运行，正常
  }
  try {
    const t = JSON.parse(raw) as PricingTable;
    if (!t || typeof t !== "object" || !t.models) throw new Error("结构不对");
    const base = defaults();
    return {
      ...base,
      ...t,
      fx: { ...base.fx, ...(t.fx ?? {}) },
      // 新版本新增的手工价也要进入已有本地表；原实现是浅合并，data/modelPricing.json
      // 一旦存在就会把 defaults.models 整块盖掉，导致新模型永远显示“未配单价”。
      models: { ...base.models, ...(t.models ?? {}) },
    };
  } catch (e) {
    const backup = `${FILE}.corrupt-${Date.now()}`;
    try { await fs.copyFile(FILE, backup); } catch { /* 备份失败也继续 */ }
    logger?.error({ err: (e as Error).message, backup }, "计费表损坏，已备份并回落到默认表");
    return defaults();
  }
}

export async function savePricing(t: PricingTable): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(t, null, 2), "utf8");
  await fs.rename(tmp, FILE); // 原子写，别留半个 JSON
}

/**
 * 查单价。查不到返回 null —— 调用方必须把 null 当"未知"处理，
 * 不许自己编一个默认值（见文件头规矩③）。
 */
export function priceOf(t: PricingTable, model: string): PriceEntry | null {
  const key = String(model ?? "").trim();
  if (!key) return null;
  if (t.models[key]) return t.models[key]!;
  // 宽松匹配一次：去掉 provider 前缀（moonshotai/kimi-k2.6 → kimi-k2.6）和 /default 后缀。
  const bare = key.replace(/^[^/]+\//, "").replace(/\/default$/, "").replace(/\[[^\]]+\]$/, "");
  return t.models[bare] ?? null;
}

/** 换算到 displayCurrency。汇率缺失返回 null（同样不许猜）。 */
export function toDisplay(t: PricingTable, amount: number, cur: string): number | null {
  const rate = t.fx[cur];
  return typeof rate === "number" ? amount * rate : null;
}

/**
 * 把某币种金额换成稳定的 USD 账本金额。PricingTable.fx 的口径是「币种 →
 * displayCurrency」，所以 displayCurrency 不是 USD 时要除以 USD 自己的换算率。
 * 缺汇率就返回 null，账本会把这段用量标为未计价，绝不猜价。
 */
export function toUsd(t: PricingTable, amount: number, cur: string): number | null {
  if (cur === "USD") return amount;
  const sourceToDisplay = t.fx[cur];
  if (typeof sourceToDisplay !== "number" || !Number.isFinite(sourceToDisplay)) return null;
  if (t.displayCurrency === "USD") return amount * sourceToDisplay;
  const usdToDisplay = t.fx.USD;
  if (typeof usdToDisplay !== "number" || !Number.isFinite(usdToDisplay) || usdToDisplay <= 0) return null;
  return amount * sourceToDisplay / usdToDisplay;
}

/**
 * 按【当前这张表】给一次 usage 报价，并立即换成 USD。调用方应把结果直接累计进
 * 历史账本；以后刷新 PricingTable 只影响新 usage，不能拿新价格重算旧 token。
 */
export function estimateUsageCostUsd(
  t: PricingTable,
  model: string,
  usage: { input: number; output: number; cached?: number; cacheCreation?: number },
  occurredAt?: number | Date
): number | null {
  const input = Math.max(0, Number(usage.input) || 0);
  const output = Math.max(0, Number(usage.output) || 0);
  const cached = Math.max(0, Number(usage.cached) || 0);
  const cacheCreation = Math.max(0, Number(usage.cacheCreation) || 0);
  if (input + output + cached + cacheCreation === 0) return 0;
  const price = priceOf(t, model);
  if (!price) return null;
  const rates = occurredAt === undefined ? price : tokenRatesAt(price, occurredAt);
  const amount = (
    input * rates.in +
    cached * rates.cacheRead +
    cacheCreation * rates.cacheWrite +
    output * rates.out
  ) / 1_000_000;
  return toUsd(t, amount, price.cur);
}

function parsedPeakWindows(schedule: PriceRateSchedule): NonNullable<PriceRateSchedule["peakWindows"]> {
  if (schedule.peakWindows?.length) return schedule.peakWindows;
  const days = /monday\s+through\s+friday|monday\s*[-–]\s*friday/i.test(schedule.peakHours)
    ? [1, 2, 3, 4, 5]
    : [0, 1, 2, 3, 4, 5, 6];
  const windows: NonNullable<PriceRateSchedule["peakWindows"]> = [];
  for (const match of schedule.peakHours.matchAll(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/g)) {
    const startMinute = Number(match[1]) * 60 + Number(match[2]);
    const endMinute = Number(match[3]) * 60 + Number(match[4]);
    if (startMinute >= 0 && endMinute > startMinute && endMinute <= 24 * 60) {
      windows.push({ daysOfWeek: days, startMinute, endMinute });
    }
  }
  return windows;
}

export function priceRateTierAt(price: PriceEntry, occurredAt: number | Date = Date.now()): "flat" | "offPeak" | "peak" {
  const schedule = price.rateSchedule;
  if (!schedule) return "flat";
  const windows = parsedPeakWindows(schedule);
  // 无法解析官方时段时宁可保守用峰值，不静默低估账单。
  if (!windows.length) return "peak";
  const date = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  const day = date.getUTCDay();
  return windows.some((window) => window.daysOfWeek.includes(day) &&
    minute >= window.startMinute && minute < window.endMinute) ? "peak" : "offPeak";
}

export function tokenRatesAt(price: PriceEntry, occurredAt: number | Date = Date.now()): TokenRates {
  const tier = priceRateTierAt(price, occurredAt);
  if (tier === "peak") return price.rateSchedule!.peak;
  if (tier === "offPeak") return price.rateSchedule!.offPeak;
  return { in: price.in, out: price.out, cacheRead: price.cacheRead, cacheWrite: price.cacheWrite };
}

/** Dashboard 只读视图：保留完整峰谷表，同时明确当前时刻会使用哪一档。 */
export function pricingTableAt(t: PricingTable, occurredAt: number | Date = Date.now()): PricingTable {
  return {
    ...t,
    models: Object.fromEntries(Object.entries(t.models).map(([model, price]) => {
      const tier = priceRateTierAt(price, occurredAt);
      return [model, {
        ...price,
        activeRateTier: tier,
        activeRates: tokenRatesAt(price, occurredAt),
      }];
    })) as PricingTable["models"],
  };
}

const SOURCE_FETCH_ATTEMPTS = 2;

function fetchErrorMessage(error: unknown): string {
  const e = error instanceof Error ? error : new Error(String(error));
  const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause;
  const details = [e.message];
  if (cause?.code) details.push(cause.code);
  if (cause?.message && cause.message !== e.message) details.push(cause.message);
  return [...new Set(details.filter(Boolean))].join(" · ");
}

/** 价格源是日常 cron：瞬时网络抖动重试一次；连续失败仍保留 last-known-good。 */
async function fetchPricingSource(url: string, accept: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SOURCE_FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: accept,
          "User-Agent": "Harbour-Pricing/0.1",
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === SOURCE_FETCH_ATTEMPTS) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === SOURCE_FETCH_ATTEMPTS) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
  }
  throw new Error(fetchErrorMessage(lastError));
}

/**
 * 从 OpenRouter 公开接口刷新（无需 key）。它给的是【每 token 美元价】，
 * 这里就地换算成每 100 万 token。
 *
 * 只补 auto 条目：manual 的一律跳过（见规矩②）。想要哪些模型由 wanted 决定 ——
 * 全量 342 个模型灌进来只会让表没法看，按项目实际配置的模型来。
 */
export async function refreshFromOpenRouter(
  t: PricingTable,
  wanted: string[],
  logger?: Logger
): Promise<{ added: number; updated: number; skippedManual: number; notFound: string[] }> {
  const res = await fetchPricingSource(OPENROUTER_MODELS, "application/json");
  if (!res.ok) throw new Error(`OpenRouter 返回 HTTP ${res.status}`);
  const list = (await res.json()) as { data?: Array<{ id: string; pricing?: Record<string, string> }> };
  const rows = list.data ?? [];
  if (rows.length === 0) throw new Error("OpenRouter 返回空列表");

  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n * 1e6 : 0; // 每 token → 每 1M token
  };
  const now = new Date().toISOString();
  let added = 0, updated = 0, skippedManual = 0;
  const notFound: string[] = [];

  for (const want of wanted) {
    const existing = t.models[want];
    if (existing?.source === "manual" || existing?.source === "official") { skippedManual++; continue; }
    // 精确 id 优先，其次按去掉 provider 前缀的名字匹配。
    const hit =
      rows.find((r) => r.id === want) ??
      rows.find((r) => r.id.replace(/^[^/]+\//, "") === want) ??
      rows.find((r) => r.id.replace(/^[^/]+\//, "").replace(/^~/, "") === want);
    if (!hit?.pricing) { notFound.push(want); continue; }
    const p = hit.pricing;
    const entry: PriceEntry = {
      cur: "USD", // OpenRouter 一律美元计价
      in: num(p.prompt),
      out: num(p.completion),
      cacheRead: num(p.input_cache_read),
      cacheWrite: num(p.input_cache_write),
      source: "auto",
      updatedAt: now,
      upstreamId: hit.id,
    };
    // 全 0 说明这行没有有效价格（免费模型或字段缺失），别写进去污染表。
    if (entry.in === 0 && entry.out === 0) { notFound.push(want); continue; }
    if (existing) updated++; else added++;
    t.models[want] = entry;
  }

  t.updatedAt = now;
  logger?.info({ added, updated, skippedManual, notFound }, "计费表已从 OpenRouter 刷新");
  return { added, updated, skippedManual, notFound };
}

interface ParsedDeepSeekRate extends TokenRates {
  rateSchedule?: PriceRateSchedule;
  rateNote?: string;
}

function pricingDocumentText(document: string): string {
  return document
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&dollar;/gi, "$")
    .replace(/&#36;/gi, "$")
    .replace(/\s+/g, " ")
    .trim();
}

type DeepSeekPricePair = {
  flat?: [number, number];
  offPeak?: [number, number];
  peak?: [number, number];
};

function deepSeekPriceRow(text: string, label: string): DeepSeekPricePair {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:1M\\s+)?${escaped}`, "i").exec(text);
  if (!match) throw new Error(`DeepSeek 官方定价页缺少价格行：${label}`);
  const tail = text.slice(match.index + match[0].length);
  const next = tail.search(/\s+(?:1M\s+)?(?:INPUT TOKENS \(CACHE (?:HIT|MISS)\)|OUTPUT TOKENS|Concurrency Limit)\b/i);
  const row = next >= 0 ? tail.slice(0, next) : tail.slice(0, 260);
  const tiered = /\bOFF-PEAK\b/i.test(row) && /(?:^|\s)PEAK(?:\s|$)/i.test(row);
  if (tiered) {
    // 当前表还有第三列 vision 模型。不能把整行价格按 [offFlash,offPro,peakFlash,peakPro]
    // 硬切，否则第三列的 offPeak 会被错当成 Flash peak（2026-08-25 实际踩中过）。
    const peakAt = row.search(/(?:^|\s)PEAK(?:\s|$)/i);
    const offPrices = [...row.slice(0, peakAt).matchAll(/\$\s*([0-9]+(?:\.[0-9]+)?)/g)]
      .map((item) => Number(item[1]));
    const peakPrices = [...row.slice(peakAt).matchAll(/\$\s*([0-9]+(?:\.[0-9]+)?)/g)]
      .map((item) => Number(item[1]));
    if (offPrices.length < 2 || peakPrices.length < 2) {
      throw new Error(`DeepSeek 官方定价页分时价格行无法解析：${label}`);
    }
    return { offPeak: [offPrices[0]!, offPrices[1]!], peak: [peakPrices[0]!, peakPrices[1]!] };
  }
  const prices = [...row.matchAll(/\$\s*([0-9]+(?:\.[0-9]+)?)/g)].map((item) => Number(item[1]));
  if (prices.length < 2) throw new Error(`DeepSeek 官方定价页价格行无法解析：${label}`);
  return { flat: [prices[0]!, prices[1]!] };
}

/**
 * 纯解析函数，供离线 fixture 测试。兼容旧版单一价格，以及当前 OFF-PEAK / PEAK
 * 两档表格；结构不完整时宁可失败，也不把错位列写进账单。
 */
export function parseDeepSeekPricingDocument(document: string): Record<string, ParsedDeepSeekRate> {
  const text = pricingDocumentText(document);
  // Read actual MODEL columns, not legacy aliases mentioned in retirement footnotes.
  // V4.1 renamed the first column to deepseek-flash; reordered/unknown columns fail closed.
  const header = /\bMODEL\s+(deepseek-(?:v4-flash|flash))\s*(?:\(\d+\)\s*)?deepseek-v4-pro\b/i.exec(text);
  if (!header) {
    throw new Error("DeepSeek 官方定价页模型表结构已变化");
  }
  // 模型详情区本身有 “MAX OUTPUT TOKENS”；只在 PRICING 段找三条价格行，
  // 否则会把后面缓存价格的首两个数字错位当成输出价。
  const pricingAt = text.indexOf("PRICING", header.index + header[0].length);
  if (pricingAt < 0) throw new Error("DeepSeek 官方定价页缺少 PRICING 表");
  const pricingText = text.slice(pricingAt);
  const hit = deepSeekPriceRow(pricingText, "INPUT TOKENS (CACHE HIT)");
  const miss = deepSeekPriceRow(pricingText, "INPUT TOKENS (CACHE MISS)");
  const output = deepSeekPriceRow(pricingText, "OUTPUT TOKENS");
  const tiered = !!(hit.peak && miss.peak && output.peak && hit.offPeak && miss.offPeak && output.offPeak);
  const flat = !!(hit.flat && miss.flat && output.flat);
  if (!tiered && !flat) throw new Error("DeepSeek 官方定价页价格档位结构不一致");

  const allNumbers = [
    ...(hit.flat ?? []), ...(miss.flat ?? []), ...(output.flat ?? []),
    ...(hit.offPeak ?? []), ...(miss.offPeak ?? []), ...(output.offPeak ?? []),
    ...(hit.peak ?? []), ...(miss.peak ?? []), ...(output.peak ?? []),
  ];
  if (allNumbers.some((n) => !Number.isFinite(n) || n < 0 || n > 1000)) {
    throw new Error("DeepSeek 官方定价页出现异常价格");
  }

  const peakHoursRaw = /Peak hours are\s+(.+?)\s*\(all other hours/i.exec(text)?.[1]?.trim();
  const peakHours = peakHoursRaw || "以 DeepSeek 官方页面为准";
  const build = (index: 0 | 1): ParsedDeepSeekRate => {
    if (flat) {
      return {
        cacheRead: hit.flat![index],
        in: miss.flat![index],
        cacheWrite: miss.flat![index],
        out: output.flat![index],
      };
    }
    const offPeak: TokenRates = {
      cacheRead: hit.offPeak![index],
      in: miss.offPeak![index],
      cacheWrite: miss.offPeak![index],
      out: output.offPeak![index],
    };
    const peak: TokenRates = {
      cacheRead: hit.peak![index],
      in: miss.peak![index],
      cacheWrite: miss.peak![index],
      out: output.peak![index],
    };
    return {
      ...peak,
      rateSchedule: {
        timeZone: "UTC",
        selected: "usage-time",
        peakHours,
        peakWindows: parsedPeakWindows({ timeZone: "UTC", selected: "usage-time", peakHours, offPeak, peak }),
        offPeak,
        peak,
      },
      rateNote: "官方分时价；Harbour 按每笔 usage 的实际发生时刻选择峰/谷并立即冻结成本。",
    };
  };

  return {
    [header[1]!.toLowerCase()]: build(0),
    "deepseek-v4-pro": build(1),
  };
}

/**
 * 从 DeepSeek 官方定价页刷新直连价。官方目前没有独立 JSON pricing API，所以解析
 * 文档表格；结构或数字任一不匹配就抛错，调用方保留 last-known-good。
 */
export async function refreshFromDeepSeekOfficial(
  t: PricingTable,
  wanted: string[],
  logger?: Logger
): Promise<{ added: number; updated: number; skippedManual: number; notFound: string[] }> {
  const deepseekWanted = wanted.filter((m) => /^deepseek-/i.test(m));
  if (!deepseekWanted.length) return { added: 0, updated: 0, skippedManual: 0, notFound: [] };
  const res = await fetchPricingSource(DEEPSEEK_PRICING, "text/html");
  if (!res.ok) throw new Error(`DeepSeek 官方定价页返回 HTTP ${res.status}`);
  const rows = parseDeepSeekPricingDocument(await res.text());
  const now = new Date().toISOString();
  let added = 0, updated = 0, skippedManual = 0;
  const notFound: string[] = [];
  for (const model of deepseekWanted) {
    const row = rows[model as keyof typeof rows];
    if (!row) { notFound.push(model); continue; }
    const existing = t.models[model];
    // 真正的合同/用户手工价优先级最高；旧版把 DeepSeek 官方价标成 manual，凭 upstreamId
    // 或模型名迁移为 official，避免从此永远无法自动更新。
    if (existing?.source === "manual" && !existing.upstreamId?.startsWith("official:")) {
      skippedManual++;
      continue;
    }
    const entry: PriceEntry = {
      cur: "USD",
      in: row.in,
      cacheRead: row.cacheRead,
      cacheWrite: row.cacheWrite,
      out: row.out,
      source: "official",
      updatedAt: now,
      upstreamId: DEEPSEEK_PRICING,
      ...(row.rateSchedule ? { rateSchedule: row.rateSchedule } : {}),
      ...(row.rateNote ? { rateNote: row.rateNote } : {}),
    };
    if (existing) updated++; else added++;
    t.models[model] = entry;
  }
  t.updatedAt = now;
  logger?.info({ added, updated, skippedManual, notFound }, "计费表已从 DeepSeek 官方定价页刷新");
  return { added, updated, skippedManual, notFound };
}
