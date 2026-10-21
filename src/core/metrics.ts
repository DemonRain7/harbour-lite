import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { estimateUsageCostUsd, type PricingTable } from "./pricing";
import { formatZonedIso, normalizeTimeZone } from "./timeZone";

export interface ActiveRunMetric {
  id: string;
  agent: string;
  taskType?: string;
  modelRef: string;
  surface?: string;
  startedAt: string;
  elapsedMs: number;
}

/** 一天里某个维度（model 或 agent）累计的用量桶。 */
export interface DayBucket {
  input: number;
  output: number;
  cached: number;
  cacheCreation: number;
  /**
   * 用量发生时按当时 PricingTable 计算并换成 USD 的历史账本金额。
   * 更新计价表只影响后续新增量，不允许按新价格追溯重算这个字段。
   */
  cost: number;
  /** cost 账本格式版本；旧文件没有它，启动时只迁移一次。 */
  costVersion?: 1;
  /** 当时没有价格/汇率而未能入账的 token；以后有价也不追溯补算。 */
  unpricedTokens?: number;
  runs: number;
  errors: number;
}
/** 一天的记录：按「model × agent」交叉桶（key = modelRef + \t + agent）。
 *  overall / byModel / byAgent / byModelAgent 都从这份交叉数据派生 → 单一事实源，支持「某模型下各 agent」。 */
interface DayEntry {
  pairs: Record<string, DayBucket>;
}
interface PersistedMetrics {
  days?: Record<string, DayEntry>;
  recent?: FinishedRunMetric[];
  [key: string]: unknown;
}
const PAIR_SEP = "\t";
/**
 * Dashboard 的模型维度只认 Provider model id，不认 Harbour 的连接槽前缀。
 * 因此 model-slot-a/foo 与 model-slot-b/foo 会聚合为同一个 foo；连接仍保留在 recent run 的
 * modelRef 中供排障。去掉 [1m] 这类本地上下文后缀，避免同一模型被拆成两份。
 */
function modelIdOf(modelRef: string): string {
  const slash = modelRef.indexOf("/");
  const id = slash >= 0 ? modelRef.slice(slash + 1) : modelRef;
  return id.replace(/\[[^\]]+\]$/, "");
}
/** 「最近运行」保留条数。够看清刚才发生了什么，又不至于把文件撑大。 */
const RECENT_CAP = 30;
function emptyBucket(): DayBucket {
  return {
    input: 0,
    output: 0,
    cached: 0,
    cacheCreation: 0,
    cost: 0,
    costVersion: 1,
    unpricedTokens: 0,
    runs: 0,
    errors: 0,
  };
}
function addInto(a: DayBucket, b: DayBucket): void {
  a.input += b.input; a.output += b.output; a.cached += b.cached; a.cacheCreation += b.cacheCreation;
  a.cost += b.cost; a.costVersion = 1;
  a.unpricedTokens = (a.unpricedTokens ?? 0) + (b.unpricedTokens ?? 0);
  a.runs += b.runs; a.errors += b.errors;
}
/**
 * 跨进程互斥锁（基于 O_EXCL 建文件，这个操作在文件系统层面是原子的）。
 * 「读磁盘 → 加增量 → 写回」这套动作必须整体互斥：光有原子写不够，
 * 两个实例同时【读】到同一份旧数据，各自加完再写，先写的那份就被后写的抹掉了。
 * 锁超过 stale 时长就强行接管，避免某个进程被 kill -9 之后把锁永久留在盘上。
 */
async function withFileLock<T>(target: string, fn: () => Promise<T>, opts?: { retries?: number; staleMs?: number }): Promise<T> {
  const lock = `${target}.lock`;
  // 重试总时长（200 × 20~50ms ≈ 7s）必须【明显大于】staleMs，否则陈旧接管永远等不到就先超时了：
  // 一个 kill -9 留下的锁会让此后每次落盘都白等一轮再失败。
  const retries = opts?.retries ?? 200;
  const staleMs = opts?.staleMs ?? 3_000;
  // 锁归属令牌：接管场景下锁可能已被别人抢走重建，无条件删会删掉【别人正持有的】锁，
  // 让第三方也进临界区 —— 那就等于没有锁。只删内容确实是自己写的那把。
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  for (let i = 0; i < retries; i++) {
    let fh: Awaited<ReturnType<typeof fs.open>>;
    try {
      fh = await fs.open(lock, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > staleMs) await fs.rm(lock, { force: true });
      } catch { /* 锁刚好被别人释放了，下一轮自然拿得到 */ }
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
      continue;
    }
    // 到这儿锁已经拿到。fn 的异常【不能】再被当成抢锁失败重试（否则会把已合并的增量重跑一遍）。
    try {
      await fh.writeFile(token);
      await fh.close();
      return await fn();
    } finally {
      try {
        if ((await fs.readFile(lock, "utf8")) === token) await fs.rm(lock, { force: true });
      } catch { /* 锁已被接管或删除：不是我的，不动 */ }
    }
  }
  throw new Error(`metrics: 获取文件锁超时（${lock}）`);
}

function localDate(timeZone: string, ms = Date.now()): string {
  return formatZonedIso(ms, timeZone).slice(0, 10);
}

/** 按 scope（overall/model/agent）取的一段时间序列。 */
export interface MetricsTimeseries {
  /** 新增量采用的固定日界线；历史旧桶没有时区记录，不能据此追溯推断或重分桶。 */
  accountingTimeZone: string;
  bucketPolicy: "fixed-accounting-day";
  /** DayBucket.cost 的固定账本币种。 */
  costCurrency: "USD";
  costLedgerVersion: 1;
  days: string[];
  models: string[];
  agents: string[];
  overall: Array<DayBucket & { date: string }>;
  byModel: Record<string, Array<DayBucket & { date: string }>>;
  byAgent: Record<string, Array<DayBucket & { date: string }>>;
  /** 某模型下各 agent 的序列：byModelAgent[modelRef][agent] = 按天桶。 */
  byModelAgent: Record<string, Record<string, Array<DayBucket & { date: string }>>>;
}

export interface FinishedRunMetric extends ActiveRunMetric {
  finishedAt: string;
  durationMs: number;
  status: "ok" | "error";
  error?: string;
}

export interface ModelUsageMetric {
  modelRef: string;
  runs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  /** 缓存命中率 = cachedTokens / 全部 input token；无 input token 时为 null。 */
  cacheHitRatio: number | null;
  estimatedCostUsd: number | null;
  pricingNote: string;
}

export interface MetricsSnapshot {
  activeRuns: ActiveRunMetric[];
  recentRuns: FinishedRunMetric[];
  totals: {
    runs: number;
    errors: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
    cacheHitRatio: number | null;
    estimatedCostUsd: number | null;
  };
  byModel: ModelUsageMetric[];
}

interface RunRecord {
  id: string;
  agent: string;
  taskType?: string;
  modelRef: string;
  surface?: string;
  startedAtMs: number;
}

interface UsageRecord {
  runs: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  unpricedTokens: number;
}

function emptyUsage(): UsageRecord {
  return {
    runs: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    unpricedTokens: 0,
  };
}

export interface MetricsStoreOptions {
  /** 持久化的旧宿主时区；不跟随显示时区热切换，也不重算历史日账。 */
  accountingTimeZone?: string;
}

export class MetricsStore {
  private active = new Map<string, RunRecord>();
  private recent: FinishedRunMetric[] = [];
  private usage = new Map<string, UsageRecord>();
  private runs = 0;
  private errors = 0;
  // —— 按天持久化（重启不丢）——
  /** 合并后的全局视图：本实例的记录 + 每次落盘时从磁盘读回的其它实例的记录。 */
  private daily = new Map<string, DayEntry>();
  /**
   * 本实例【自上次成功落盘以来】的增量。落盘走「读磁盘 → 加增量 → 写回」，
   * 而不是整份覆盖——同一台机器上可能同时跑着好几个 Harbour（开发时很常见），
   * 整份覆盖会让后写的实例把先写的实例的数据整个抹掉（实测 8 次 run 只剩 5 次）。
   */
  private delta = new Map<string, Record<string, DayBucket>>();
  /**
   * 「最近运行」列表也要落盘 —— 它是 dashboard 直接显示的东西，纯内存意味着
   * 每次重启那一栏就空了（用户 2026-07-22 指出）。与 daily 同样走增量合并：
   * 只带走本实例新完成的，落盘时和磁盘上已有的按时间归并，截断到 RECENT_CAP。
   */
  private recentDelta: FinishedRunMetric[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private corruptBackedUp = false;
  private readonly accountingTimeZone: string;

  constructor(
    private logger?: Logger,
    private file?: string,
    private pricingTable?: PricingTable,
    opts: MetricsStoreOptions = {},
  ) {
    this.accountingTimeZone = normalizeTimeZone(opts.accountingTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  }

  /** 热更新只替换【之后新增 usage】使用的报价表；已落进 DayBucket.cost 的旧账不动。 */
  setPricingTable(table: PricingTable): void {
    this.pricingTable = table;
  }

  private quoteCost(
    modelRef: string,
    usage: { input: number; output: number; cached: number; cacheCreation: number },
    occurredAtMs?: number
  ): { costUsd: number; unpricedTokens: number } {
    const tokens = usage.input + usage.output + usage.cached + usage.cacheCreation;
    if (tokens <= 0) return { costUsd: 0, unpricedTokens: 0 };
    // codex-app-server/* 被本项目限定为 ChatGPT OAuth：运行消耗订阅额度，没有可归到
    // 单次 token 的 API 边际账单。固定订阅费不在 Harbour 的 token 成本账本里摊销。
    if (modelRef.startsWith("codex-app-server/")) return { costUsd: 0, unpricedTokens: 0 };
    const priced = this.pricingTable
      ? estimateUsageCostUsd(this.pricingTable, modelRef, usage, occurredAtMs)
      : null;
    return priced == null
      ? { costUsd: 0, unpricedTokens: tokens }
      : { costUsd: priced, unpricedTokens: 0 };
  }

  /**
   * 旧版只存 token，Dashboard 每次按最新价格现场重算。为切换到不可追溯账本，旧桶只在
   * 第一次启动新版时按 last-known-good 表迁移一次并打 costVersion；之后永不重算。
   */
  private migrateLegacyCostBuckets(days: Record<string, DayEntry> | undefined): number {
    if (!days || !this.pricingTable) return 0;
    let migrated = 0;
    for (const entry of Object.values(days)) {
      if (!entry || typeof entry !== "object" || !entry.pairs) continue;
      for (const [key, bucket] of Object.entries(entry.pairs)) {
        if (!bucket || typeof bucket !== "object" || bucket.costVersion === 1) continue;
        const sep = key.indexOf(PAIR_SEP);
        const modelRef = sep >= 0 ? key.slice(0, sep) : key;
        const input = Math.max(0, Number(bucket.input) || 0);
        const output = Math.max(0, Number(bucket.output) || 0);
        const cached = Math.max(0, Number(bucket.cached) || 0);
        const cacheCreation = Math.max(0, Number(bucket.cacheCreation) || 0);
        const existingCost = Number(bucket.cost);
        const quote = Number.isFinite(existingCost) && existingCost > 0
          ? { costUsd: existingCost, unpricedTokens: 0 }
          : this.quoteCost(modelRef, { input, output, cached, cacheCreation });
        bucket.cost = quote.costUsd;
        bucket.costVersion = 1;
        bucket.unpricedTokens = quote.unpricedTokens;
        migrated += 1;
      }
    }
    return migrated;
  }

  private hasLegacyCostBuckets(days: Record<string, DayEntry> | undefined): boolean {
    return !!days && Object.values(days).some((entry) =>
      !!entry?.pairs && Object.values(entry.pairs).some((bucket) => bucket?.costVersion !== 1));
  }

  /** 在跨进程文件锁内完成一次性迁移，避免两个 Harbour 同时启动时彼此覆盖。 */
  private async migratePersistedCosts(parsed: PersistedMetrics): Promise<PersistedMetrics> {
    if (!this.file || !this.pricingTable || !this.hasLegacyCostBuckets(parsed.days)) return parsed;
    const file = this.file;
    return withFileLock(file, async () => {
      let current = parsed;
      try {
        current = JSON.parse(await fs.readFile(file, "utf8")) as PersistedMetrics;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const migrated = this.migrateLegacyCostBuckets(current.days);
      if (!migrated) return current;
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, JSON.stringify(current), "utf8");
      await fs.rename(tmp, file);
      this.logger?.info({ buckets: migrated }, "metrics 历史成本已一次性冻结为用量发生时账本（USD）");
      return current;
    });
  }

  /** 启动装载历史（有 file 才持久化）。旧格式（model/agent 分开、无 pairs）无法还原交叉，直接跳过。 */
  async load(): Promise<void> {
    if (!this.file) return;
    await this.sweepStale();
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch {
      return; // 没有文件 = 首次启动，空起步，这是正常的
    }
    let obj: PersistedMetrics;
    try {
      obj = JSON.parse(raw) as PersistedMetrics;
    } catch (e) {
      // 文件在但解析不了 —— 这跟「没有文件」完全是两回事，绝不能同样地静默空起步：
      // 那会让所有历史无声无息地消失，而下一次落盘就把它永久覆盖掉（实测不可逆）。
      // 留一份损坏备份 + 大声报错，至少还有人工捞回来的余地。
      await this.backupCorrupt(this.file, (e as Error).message, "启动装载时");
      return;
    }
    try {
      obj = await this.migratePersistedCosts(obj);
    } catch (e) {
      // 迁移写盘是增强项，瞬时 IO 失败不能让 dashboard 的整份历史消失。先在内存冻结；
      // 下一次正常 metrics flush 仍会在文件锁内重试迁移。
      this.migrateLegacyCostBuckets(obj.days);
      this.logger?.warn({ err: (e as Error).message }, "metrics 历史成本迁移暂未落盘，已保留内存视图待下次重试");
    }
    for (const [date, entry] of Object.entries(obj.days ?? {})) {
      if (entry && typeof entry === "object" && entry.pairs) this.daily.set(date, { pairs: entry.pairs });
    }
    if (Array.isArray(obj.recent)) this.recent = obj.recent.slice(0, RECENT_CAP);
    this.logger?.info({ days: this.daily.size }, "metrics 历史已加载（按天 model×agent 交叉时间序列）");
  }

  /**
   * 清理上次进程被强杀留下的垃圾：写到一半的 .tmp-* 和没释放的 .lock。
   * 不清的话 tmp 会无限堆积，陈旧锁还会让接下来每次落盘都先白等一轮。
   */
  private async sweepStale(): Promise<void> {
    if (!this.file) return;
    const dir = path.dirname(this.file);
    const base = path.basename(this.file);
    try {
      for (const name of await fs.readdir(dir)) {
        if (!name.startsWith(`${base}.tmp-`) && name !== `${base}.lock`) continue;
        const full = path.join(dir, name);
        try {
          const st = await fs.stat(full);
          if (Date.now() - st.mtimeMs > 60_000) await fs.rm(full, { force: true });
        } catch { /* 别的进程正好清掉了 */ }
      }
    } catch { /* 目录读不了就算了，不该卡住启动 */ }
  }

  /** 立刻落盘并等待完成。进程关停时必须调用，否则 debounce 窗口内的用量会全部丢失。 */
  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    // 循环到增量清空：一次 flush 只带走调用那一刻的 delta，
    // 写盘期间新来的（或写失败退回的）还留在 this.delta 里，只刷一次就跟着 process.exit 一起没了。
    for (let i = 0; i < 5 && (this.delta.size > 0 || this.recentDelta.length > 0); i++) {
      this.flush();
      await this.writeChain.catch(() => undefined);
    }
    if (this.delta.size > 0) {
      this.logger?.warn({ days: this.delta.size }, "metrics 关停时仍有增量未能落盘");
    }
  }

  private dayEntry(date: string): DayEntry {
    let e = this.daily.get(date);
    if (!e) { e = { pairs: {} }; this.daily.set(date, e); }
    return e;
  }
  /** 同一 run 的一次事件：进「modelRef × agent」交叉桶。overall/byModel/byAgent 都从它派生。 */
  private bump(modelRef: string, agent: string, fn: (b: DayBucket) => void): void {
    const date = localDate(this.accountingTimeZone);
    const key = modelRef + PAIR_SEP + agent;
    // ① 进内存视图（timeseries / snapshot 立刻能看到）
    const e = this.dayEntry(date);
    (e.pairs[key] ??= emptyBucket());
    fn(e.pairs[key]!);
    // ② 同一笔也进增量桶。fn 是纯累加，作用在两个独立桶上结果一致。
    let d = this.delta.get(date);
    if (!d) { d = {}; this.delta.set(date, d); }
    (d[key] ??= emptyBucket());
    fn(d[key]!);
    this.scheduleFlush();
  }
  private scheduleFlush(): void {
    // closed 之后不再武装定时器：否则 close() 后来的 bump 会吊住事件循环，
    // 而在 index.ts 里紧跟着就是 process.exit(0)，那笔数据反正也写不出去。
    if (!this.file || this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, 1500);
  }
  /**
   * 落盘：读磁盘 → 把本实例增量加进去 → 原子写回。
   * 这样既不会覆盖别的实例写的数据，也能顺带把它们的数据合并进本实例的视图。
   */
  private flush(): void {
    if (!this.file || (this.delta.size === 0 && this.recentDelta.length === 0)) return;
    const delta = this.delta;
    const recentDelta = this.recentDelta;
    this.delta = new Map();
    this.recentDelta = [];
    const file = this.file;
    this.writeChain = this.writeChain
      .then(async () => {
        // committed：rename 成功即置位。此后再抛错也【不能】把 delta 退回去——
        // 数据已经在盘上了，退回会导致下一轮重复累加（同一笔 run 被算两次）。
        let committed = false;
        let merged: Record<string, DayEntry> = {};
        try {
          // mkdir 必须在 try 内：它也会失败（目录不可写/路径非法），
          // 漏在外面的话整条链直接 reject，delta 永远退不回来 —— 那段用量就真没了。
          await fs.mkdir(path.dirname(file), { recursive: true });
          await withFileLock(file, async () => {
            let onDisk: Record<string, DayEntry> = {};
            let onDiskRecent: FinishedRunMetric[] = [];
            let persistedRoot: PersistedMetrics = {};
            // 读盘：只有「文件不存在」才是正常的空起步。
            // 其它 IO 错误（EMFILE / EACCES / EIO…）必须抛出去走重试，
            // 【绝不能】当成"文件损坏"然后拿 delta 覆盖整份历史 —— 一次瞬时 EMFILE
            // 就会把所有历史抹成只剩当天，正是这次要修的那个症状。
            let raw = "";
            try {
              raw = await fs.readFile(file, "utf8");
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            }
            if (raw) {
              try {
                const parsed = JSON.parse(raw) as PersistedMetrics;
                persistedRoot = parsed;
                onDisk = parsed.days ?? {};
                if (Array.isArray(parsed.recent)) onDiskRecent = parsed.recent;
              } catch (e) {
                // 内容读到了但不是合法 JSON —— 这才是真损坏。
                await this.backupCorrupt(file, (e as Error).message, "落盘前");
              }
            }
            // 即使启动时迁移因瞬时 IO 失败，这里仍会在真正写增量前把旧桶冻结一次。
            this.migrateLegacyCostBuckets(onDisk);
            for (const [date, pairs] of delta) {
              const day = (onDisk[date] ??= { pairs: {} });
              for (const [key, b] of Object.entries(pairs)) addInto((day.pairs[key] ??= emptyBucket()), b);
            }
            // 原子写：先写临时文件再 rename。直接 writeFile 会在崩溃/并发时留下截断的半个 JSON，
            // 而截断 = 下次启动整份历史报废（见 load() 的损坏分支）。
            // 「最近运行」按完成时间归并去重：多实例各写各的，谁都不该覆盖谁。
            const seen = new Set<string>();
            const mergedRecent = [...recentDelta, ...onDiskRecent]
              .filter((r) => r && r.id && !seen.has(r.id) && seen.add(r.id))
              .sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1))
              .slice(0, RECENT_CAP);
            const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
            await fs.writeFile(tmp, JSON.stringify({
              ...persistedRoot,
              costLedger: { version: 1, currency: "USD", policy: "usage-time-price" },
              days: onDisk,
              recent: mergedRecent,
            }), "utf8");
            await fs.rename(tmp, file);
            committed = true;
            merged = onDisk;
            this.recent = mergedRecent; // 视图对齐，dashboard 也能看到别的实例跑过的
          });
        } catch (e) {
          if (!committed) {
            // 还没落盘：把增量还回去，下一次再试——直接丢掉等于这段用量永久消失。
            for (const [date, pairs] of delta) {
              let d = this.delta.get(date);
              if (!d) { d = {}; this.delta.set(date, d); }
              for (const [key, b] of Object.entries(pairs)) addInto((d[key] ??= emptyBucket()), b);
            }
            this.recentDelta = [...recentDelta, ...this.recentDelta].slice(0, RECENT_CAP);
            this.logger?.warn({ err: (e as Error).message }, "metrics 写盘失败，增量已保留待下次重试");
            return;
          }
          this.logger?.warn({ err: (e as Error).message }, "metrics 已落盘但收尾出错（增量不退回，避免重复计数）");
        }
        // 视图重建放在写事务【之外】：它抛错也不该污染"已经写成功"这个事实。
        try {
          this.rebuildView(merged);
        } catch (e) {
          this.logger?.warn({ err: (e as Error).message }, "metrics 视图重建失败（磁盘数据不受影响）");
        }
      })
      // 兜底：writeChain 绝不能停在 rejected 状态，否则后续每次 close() 的 await 都拿到旧的失败。
      .catch((e) => this.logger?.warn({ err: (e as Error).message }, "metrics 落盘链异常"));
  }

  /**
   * 用磁盘合并结果重建内存视图，并把【落盘期间新产生、尚未写入】的增量叠回去。
   * 不叠的话 dashboard 会瞬时读到偏低的数字（写盘是异步的，这中间的 bump 只进了新 delta）。
   */
  private rebuildView(onDisk: Record<string, DayEntry>): void {
    const next = new Map<string, DayEntry>();
    for (const [date, en] of Object.entries(onDisk)) {
      // 与 load() 用同一条守卫：旧格式（无 pairs）/ null 条目必须跳过，
      // 否则 timeseries() 会在 Object.keys(undefined) 上抛错 → dashboard 接口 500。
      if (!en || typeof en !== "object" || !en.pairs) continue;
      const pairs: Record<string, DayBucket> = {};
      for (const [k, b] of Object.entries(en.pairs)) pairs[k] = { ...b };
      next.set(date, { pairs });
    }
    for (const [date, pairs] of this.delta) {
      let day = next.get(date);
      if (!day) { day = { pairs: {} }; next.set(date, day); }
      for (const [key, b] of Object.entries(pairs)) addInto((day.pairs[key] ??= emptyBucket()), b);
    }
    this.daily = next;
  }

  /** 备份损坏文件。每个进程只备份一次：否则每轮 flush 都发现损坏就会不断产生备份把盘塞满。 */
  private async backupCorrupt(file: string, err: string, when: string): Promise<void> {
    if (this.corruptBackedUp) return;
    this.corruptBackedUp = true;
    const backup = `${file}.corrupt-${Date.now()}-${process.pid}`;
    try { await fs.copyFile(file, backup); } catch { /* 备份失败也要继续，别卡住主流程 */ }
    this.logger?.error({ err, backup }, `metrics ${when}发现文件损坏，已备份并重建 —— 历史统计会归零`);
  }

  startRun(input: { agent: string; taskType?: string; modelRef: string; surface?: string }): string {
    const id = `run-${Math.random().toString(16).slice(2, 10)}`;
    this.runs += 1;
    this.active.set(id, { id, ...input, startedAtMs: Date.now() });
    const u = this.usage.get(input.modelRef) ?? emptyUsage();
    u.runs += 1;
    this.usage.set(input.modelRef, u);
    this.bump(input.modelRef, input.agent, (b) => { b.runs += 1; });
    return id;
  }

  recordUsage(
    runId: string,
    usage: { modelRef?: string; promptTokens?: number; completionTokens?: number; cachedTokens?: number; cacheCreationTokens?: number }
  ): void {
    const run = this.active.get(runId);
    const modelRef = usage.modelRef || run?.modelRef || "unknown";
    const u = this.usage.get(modelRef) ?? emptyUsage();
    const input = Math.max(0, usage.promptTokens ?? 0);
    const output = Math.max(0, usage.completionTokens ?? 0);
    const cached = Math.max(0, usage.cachedTokens ?? 0);
    const cacheCreation = Math.max(0, usage.cacheCreationTokens ?? 0);
    const occurredAtMs = Date.now();
    u.promptTokens += input;
    u.completionTokens += output;
    u.cachedTokens += cached;
    u.cacheCreationTokens += cacheCreation;
    const quote = this.quoteCost(modelRef, { input, output, cached, cacheCreation }, occurredAtMs);
    u.costUsd += quote.costUsd;
    u.unpricedTokens += quote.unpricedTokens;
    this.usage.set(modelRef, u);
    this.bump(modelRef, run?.agent ?? "unknown", (b) => {
      b.input += input;
      b.output += output;
      b.cached += cached;
      b.cacheCreation += cacheCreation;
      b.cost += quote.costUsd;
      b.costVersion = 1;
      b.unpricedTokens = (b.unpricedTokens ?? 0) + quote.unpricedTokens;
    });
  }

  /** 时间序列（近 daysBack 天）：从 model×agent 交叉桶派生 overall/byModel/byAgent/byModelAgent。 */
  timeseries(daysBack = 60): MetricsTimeseries {
    const dates = [...this.daily.keys()].sort();
    const recent = dates.slice(-Math.max(1, daysBack));
    const models = new Set<string>();
    const agents = new Set<string>();
    const modelAgents = new Map<string, Set<string>>();
    for (const d of recent) {
      for (const key of Object.keys(this.daily.get(d)!.pairs)) {
        const sep = key.indexOf(PAIR_SEP);
        const m = modelIdOf(key.slice(0, sep)), a = key.slice(sep + 1);
        models.add(m); agents.add(a);
        if (!modelAgents.has(m)) modelAgents.set(m, new Set());
        modelAgents.get(m)!.add(a);
      }
    }
    // 对满足 pred(model, agent) 的交叉桶按天求和。
    const series = (pred: (m: string, a: string) => boolean) =>
      recent.map((date) => {
        const agg = emptyBucket();
        for (const [key, b] of Object.entries(this.daily.get(date)!.pairs)) {
          const sep = key.indexOf(PAIR_SEP);
          if (pred(modelIdOf(key.slice(0, sep)), key.slice(sep + 1))) addInto(agg, b);
        }
        return { date, ...agg };
      });
    const byModelAgent: Record<string, Record<string, Array<DayBucket & { date: string }>>> = {};
    for (const [m, as] of modelAgents) {
      byModelAgent[m] = {};
      for (const a of as) byModelAgent[m][a] = series((mm, aa) => mm === m && aa === a);
    }
    return {
      accountingTimeZone: this.accountingTimeZone,
      bucketPolicy: "fixed-accounting-day",
      costCurrency: "USD",
      costLedgerVersion: 1,
      days: recent,
      models: [...models].sort(),
      agents: [...agents].sort(),
      overall: series(() => true),
      byModel: Object.fromEntries([...models].map((m) => [m, series((mm) => mm === m)])),
      byAgent: Object.fromEntries([...agents].map((a) => [a, series((_, aa) => aa === a)])),
      byModelAgent,
    };
  }

  finishRun(runId: string, status: "ok" | "error", error?: string): void {
    const run = this.active.get(runId);
    if (!run) return;
    this.active.delete(runId);
    if (status === "error") this.errors += 1;
    if (status === "error") this.bump(run.modelRef, run.agent, (b) => { b.errors += 1; });
    const now = Date.now();
    this.recent.unshift({
      id: run.id,
      agent: run.agent,
      taskType: run.taskType,
      modelRef: run.modelRef,
      surface: run.surface,
      startedAt: new Date(run.startedAtMs).toISOString(),
      elapsedMs: now - run.startedAtMs,
      finishedAt: new Date(now).toISOString(),
      durationMs: now - run.startedAtMs,
      status,
      ...(error ? { error } : {}),
    });
    this.recent = this.recent.slice(0, RECENT_CAP);
    this.recentDelta.unshift(this.recent[0]!);
    this.recentDelta = this.recentDelta.slice(0, RECENT_CAP);
    this.scheduleFlush(); // 让它跟着下一次落盘一起写出去
  }

  snapshot(): MetricsSnapshot {
    const now = Date.now();
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;
    let cacheCreationTokens = 0;
    let estimatedCostUsd = 0;
    let hasUnknownCost = false;
    // 运行时仍按精确 modelRef 记账（能区分连接/fallback）；展示时按实际 model id 合并。
    const usageByModel = new Map<string, UsageRecord>();
    for (const [modelRef, usage] of this.usage) {
      const id = modelIdOf(modelRef);
      const agg = usageByModel.get(id) ?? emptyUsage();
      agg.runs += usage.runs;
      agg.promptTokens += usage.promptTokens;
      agg.completionTokens += usage.completionTokens;
      agg.cachedTokens += usage.cachedTokens;
      agg.cacheCreationTokens += usage.cacheCreationTokens;
      agg.costUsd += usage.costUsd;
      agg.unpricedTokens += usage.unpricedTokens;
      usageByModel.set(id, agg);
    }
    const byModel = [...usageByModel.entries()]
      .map(([modelRef, usage]) => {
        promptTokens += usage.promptTokens;
        completionTokens += usage.completionTokens;
        cachedTokens += usage.cachedTokens;
        cacheCreationTokens += usage.cacheCreationTokens;
        if (usage.unpricedTokens > 0) hasUnknownCost = true;
        estimatedCostUsd += usage.costUsd;
        const hasPricedPart = usage.costUsd > 0 || usage.unpricedTokens === 0;
        return {
          modelRef,
          runs: usage.runs,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.promptTokens + usage.cachedTokens + usage.cacheCreationTokens + usage.completionTokens,
          cachedTokens: usage.cachedTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          cacheHitRatio: cacheHitRatio(usage.cachedTokens, usage.promptTokens, usage.cacheCreationTokens),
          estimatedCostUsd: hasPricedPart ? usage.costUsd : null,
          pricingNote: usage.unpricedTokens > 0
            ? (hasPricedPart ? "usage-time ledger; excludes unpriced usage" : "price unavailable when usage occurred")
            : "usage-time price ledger",
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens || b.runs - a.runs);

    return {
      activeRuns: [...this.active.values()].map((run) => ({
        id: run.id,
        agent: run.agent,
        taskType: run.taskType,
        modelRef: run.modelRef,
        surface: run.surface,
        startedAt: new Date(run.startedAtMs).toISOString(),
        elapsedMs: now - run.startedAtMs,
      })),
      recentRuns: this.recent,
      totals: {
        runs: this.runs,
        errors: this.errors,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + cachedTokens + cacheCreationTokens + completionTokens,
        cachedTokens,
        cacheCreationTokens,
        cacheHitRatio: cacheHitRatio(cachedTokens, promptTokens, cacheCreationTokens),
        estimatedCostUsd: hasUnknownCost && estimatedCostUsd === 0 ? null : estimatedCostUsd,
      },
      byModel,
    };
  }
}

/** 缓存命中率：cached /（普通 input + cache read + cache write）。分母为 0 返回 null。 */
function cacheHitRatio(cached: number, uncachedPrompt: number, cacheCreation = 0): number | null {
  const denom = cached + uncachedPrompt + cacheCreation;
  if (denom <= 0) return null;
  return cached / denom;
}
