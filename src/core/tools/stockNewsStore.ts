import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { DailyRssItem } from "./dailyNews";
import { canonicalizeUrl } from "./dailyNews";

/**
 * stock_news 的跨运行去重 + 存价 store。
 *
 * 为什么需要：股票是**间隔监控**（如每 10 分钟一跑），若每轮都把当前所有条目都当“新消息”，
 * 就会每 10 分钟重推同一批 → 刷屏。所以要跨运行记住“已见过哪些 URL”，只报增量；
 * 同时存下上次现价，用于算“较上次报告 |涨跌| ≥ 阈值”的价格异动。
 *
 * 结构：{ seen: {canonicalUrl: 首次见到的 epochMs}, prices: {ticker: {price, at}} }。
 * 落盘：原子写（tmp + rename），避免间隔作业与其它读写撞出半截 JSON。默认 data/stockNewsSeen.json（gitignore）。
 */

export interface StockSeenStore {
  seen: Record<string, number>;
  prices: Record<string, { price: number; at: number }>;
}

export interface PriceMove {
  ticker: string;
  prev: number;
  cur: number;
  pct: number;
}

export class StockNewsStore {
  private store: StockSeenStore = { seen: {}, prices: {} };
  /** 每次写盘自增，拼进 tmp 名，保证同进程并发 commit 不会撞同一临时文件（防半截 JSON）。 */
  private writeSeq = 0;

  constructor(
    private logger: Logger,
    private file: string,
    /** seen 记录的保留时长（ms）；超时的条目在 commit 时 prune 掉，避免文件无限膨胀。 */
    private seenTtlMs: number
  ) {}

  /** 从磁盘载入（缺失/损坏则按空起步，绝不抛）。 */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<StockSeenStore>;
      this.store = {
        seen: parsed?.seen && typeof parsed.seen === "object" ? parsed.seen : {},
        prices: parsed?.prices && typeof parsed.prices === "object" ? parsed.prices : {},
      };
    } catch {
      this.store = { seen: {}, prices: {} };
    }
  }

  private keyOf(item: DailyRssItem): string {
    return item.url ? canonicalizeUrl(item.url) : item.title.trim().toLowerCase();
  }

  /** 过滤出【本次新出现】的条目（既排除历史已见、也排除本批内重复）。 */
  filterUnseen(items: DailyRssItem[]): DailyRssItem[] {
    const out: DailyRssItem[] = [];
    const local = new Set<string>();
    for (const it of items) {
      const key = this.keyOf(it);
      if (this.store.seen[key] != null || local.has(key)) continue;
      local.add(key);
      out.push(it);
    }
    return out;
  }

  /** 一批条目的 canonical key（供 commit 落 seen）。 */
  keysOf(items: DailyRssItem[]): string[] {
    return items.map((i) => this.keyOf(i));
  }

  /** 与上次存价比较，返回 |涨跌| ≥ 阈值的 ticker。首次（无历史价）不算异动。 */
  priceMoves(current: Record<string, number>, thresholdPct: number): PriceMove[] {
    const out: PriceMove[] = [];
    for (const [ticker, cur] of Object.entries(current)) {
      const prev = this.store.prices[ticker]?.price;
      if (prev == null || prev === 0) continue;
      const pct = ((cur - prev) / prev) * 100;
      if (Math.abs(pct) >= thresholdPct) out.push({ ticker, prev, cur, pct });
    }
    return out;
  }

  /** 落新见 URL + 更新存价，并 prune 过期 seen；原子写盘。 */
  async commit(newUrls: string[], currentPrices: Record<string, number>): Promise<void> {
    const now = Date.now();
    for (const u of newUrls) if (u) this.store.seen[u] = this.store.seen[u] ?? now;
    for (const [t, p] of Object.entries(currentPrices)) this.store.prices[t] = { price: p, at: now };
    const cutoff = now - this.seenTtlMs;
    for (const [u, ts] of Object.entries(this.store.seen)) if (ts < cutoff) delete this.store.seen[u];
    await this.write();
  }

  /** 原子写：写临时文件再 rename（rename 在同盘是原子的），避免半截 JSON。 */
  private async write(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${this.writeSeq++}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.store, null, 2), "utf8");
    await fs.rename(tmp, this.file);
  }
}
