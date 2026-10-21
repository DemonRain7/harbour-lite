import type { Logger } from "pino";
import type { DailyRssSource } from "./dailyNews";

/**
 * stock_news 的数据源 + 现价快照（自包含，全免费源）。
 *
 * 每个 ticker 三源（都实测可用、月成本 0）：
 *  - SEC EDGAR 8-K atom：官方重大事件披露（priority 最高）。**SEC 政策要求带表明身份的 User-Agent**
 *    （含邮箱），故 headers 里注入调用方给的 secUA；硬编码/伪造 UA 可能被 SEC 限流封禁。
 *  - Yahoo Finance 个股 RSS：财经媒体标题流。
 *  - Google News 搜索 RSS（= “自动 search”的 RSS 化）：广谱新闻聚合。
 *    注意：`<link>` 是超长跳转链、标题常带 “ - 媒体名”、且 **NOW 必须用公司名（ServiceNow）查询**
 *    ——“NOW stock” 会把英文单词 now 当噪声、召回一堆无关结果。
 *
 * 现价：Yahoo chart API（v8，免 key）。stooq 已 404 弃用；Finnhub 付费超预算不用。
 */

export interface TickerInfo {
  ticker: string;
  /** 公司全名（渲染分组标题 + Google News 查询词用）。 */
  company: string;
  /** Google News 搜索用的查询词（歧义 ticker 用公司名，如 NOW→ServiceNow）。 */
  query: string;
}

export const TICKER_INFO: Record<string, TickerInfo> = {
  AMD: { ticker: "AMD", company: "AMD", query: "AMD" },
  // NOW 作为英文单词歧义严重——Google News 必须用公司名查询。
  NOW: { ticker: "NOW", company: "ServiceNow", query: "ServiceNow" },
  ORCL: { ticker: "ORCL", company: "Oracle", query: "Oracle" },
  CELH: { ticker: "CELH", company: "Celsius Holdings", query: "Celsius Holdings" },
};

/** 浏览器 UA（Yahoo/Google 对无 UA 或脚本 UA 更易 429）。SEC 另用调用方传入的表明身份 UA。 */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 为一组 ticker 生成 RSS 源（每票三源，group 一律 = ticker）。 */
export function buildStockSources(tickers: string[], secUA: string): DailyRssSource[] {
  const sources: DailyRssSource[] = [];
  for (const t of tickers) {
    const info = TICKER_INFO[t] ?? { ticker: t, company: t, query: t };
    sources.push({
      id: `sec-${t}`,
      name: `${t} · SEC 8-K`,
      url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(
        t
      )}&type=8-K&count=20&output=atom`,
      group: t,
      enabled: true,
      priority: 100,
      maxItems: 3,
      timeoutMs: 15000,
      retries: 2,
      // SEC 要求 UA 表明身份（含邮箱）；由调用方从 STOCK_NEWS_SEC_USER_AGENT 传入。
      headers: { "User-Agent": secUA },
    });
    sources.push({
      id: `yahoo-${t}`,
      name: `${t} · Yahoo`,
      url: `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(t)}&region=US&lang=en-US`,
      group: t,
      enabled: true,
      priority: 90,
      maxItems: 8,
      timeoutMs: 15000,
      retries: 2,
    });
    sources.push({
      id: `gnews-${t}`,
      name: `${t} · Google News`,
      url: `https://news.google.com/rss/search?q=${encodeURIComponent(
        `${info.query} stock`
      )}&hl=en-US&gl=US&ceid=US:en`,
      group: t,
      enabled: true,
      priority: 80,
      maxItems: 8,
      timeoutMs: 15000,
      retries: 2,
    });
  }
  return sources;
}

export interface QuoteSnapshot {
  /** 围栏等宽表 markdown（lite/Discord 都能对齐；不用 md `|` 表格，两端都不渲染）。 */
  markdown: string;
  /** ticker → 现价（仅成功抓到的）；供 seen-store 存价 / 算异动。 */
  prices: Record<string, number>;
}

async function fetchQuote(ticker: string): Promise<{ ticker: string; price?: number; prevClose?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`,
      { signal: controller.signal, headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number } }> };
    };
    const meta = data?.chart?.result?.[0]?.meta;
    const price = typeof meta?.regularMarketPrice === "number" ? meta.regularMarketPrice : undefined;
    const prevClose =
      typeof meta?.chartPreviousClose === "number"
        ? meta.chartPreviousClose
        : typeof meta?.previousClose === "number"
          ? meta.previousClose
          : undefined;
    return { ticker, price, prevClose };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 逐票抓现价（Promise.allSettled，单票失败填 “—”，全失败返回降级文案）。**绝不 throw**——
 * 行情挂了也不能拖垮整条简报（消息面仍可出）。
 */
export async function buildQuoteSnapshot(tickers: string[], logger: Logger): Promise<QuoteSnapshot> {
  const settled = await Promise.allSettled(tickers.map((t) => fetchQuote(t)));
  const prices: Record<string, number> = {};
  const rows: Array<{ ticker: string; price: string; chg: string }> = [];
  let okCount = 0;
  settled.forEach((r, i) => {
    const ticker = tickers[i]!;
    if (r.status === "fulfilled" && r.value.price != null) {
      okCount++;
      prices[ticker] = r.value.price;
      const price = r.value.price;
      const prevClose = r.value.prevClose;
      const chg = prevClose ? ((price - prevClose) / prevClose) * 100 : null;
      rows.push({
        ticker,
        price: `$${price.toFixed(2)}`,
        chg: chg == null ? "—" : `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`,
      });
    } else {
      rows.push({ ticker, price: "—", chg: "—" });
      if (r.status === "rejected") {
        logger.warn({ ticker, err: String(r.reason).slice(0, 120) }, "stock_news: 现价抓取失败");
      }
    }
  });

  if (okCount === 0) {
    return { markdown: "**现价快照**：暂时无法获取行情（数据源不可达），本轮仅列消息面。", prices };
  }

  // 等宽对齐（表头用 ASCII，避免 CJK 全角字符破坏 padEnd 对齐）。
  const head = { ticker: "Ticker", price: "Price", chg: "Chg%" };
  const wT = Math.max(head.ticker.length, ...rows.map((r) => r.ticker.length));
  const wP = Math.max(head.price.length, ...rows.map((r) => r.price.length));
  const fmt = (r: { ticker: string; price: string; chg: string }) =>
    `${r.ticker.padEnd(wT)}  ${r.price.padStart(wP)}  ${r.chg}`;
  const markdown = ["**现价快照**", "```", fmt(head), ...rows.map(fmt), "```"].join("\n");
  return { markdown, prices };
}
