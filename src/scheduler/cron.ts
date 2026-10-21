import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Cron } from "croner";
import type { Task, RunSource } from "../types";
import type { Logger } from "pino";
import { getHarbourTimeZone, normalizeTimeZone } from "../core/timeZone";
import { cronLocalKeys, cronRuntimeKeys, persistCronState, restoreCronRuntime } from "./cronPersistence";
import { CronDeliveryRejectedError, normalizeCronDelivery, type CronDelivery } from "./cronDelivery";
import { assertCronAuthorization, cronRunSource, grantCronOwnerAuthorization, hasCronOwnerAuthorization,
  type CronExecutionIdentity, type CronOwnerAuthorization } from "./cronAuthorization";
import { CRON_HISTORY_LIMIT, cloneCronHistory, cronRunSummary, newCronRun, seedCronHistory, syncCronHistory,
  type CronRunRecord } from "./cronHistory";

/**
 * CronController —— 持久化的定时作业，区别于 heartbeat：
 *  - heartbeat：来自各 agent 的 HEARTBEAT.md，轻量周期自检，默认全局暂停。
 *  - cron：用户在面板显式建的定时作业，存 data/cron.json，按 job.enabled 各自启停。
 * 两者都默认不擅自烧 token：cron job 新建默认 enabled=false，需显式开启。
 */

const STORE = path.resolve(process.cwd(), "data", "cron.json");

/** 会话模式：fresh=每次新会话（无历史）；continue=沿用上次（带 sessionRef，跨次累积记忆 + 压缩，需 SESSIONS_ENABLED）。 */
export type CronSessionMode = "fresh" | "continue";

export class CronJobBusyError extends Error {
  readonly code = "CRON_JOB_BUSY";
  constructor(readonly jobId: string) {
    super(`cron: 作业 ${jobId} 正在保存配置、排队、执行或投递，请等待当前操作结束`);
    this.name = "CronJobBusyError";
  }
}

export interface CronJob {
  id: string;
  name: string;
  /**
   * 内建作业：跑一段【纯代码】而不是派 agent。
   * 为什么要这个：像「刷新模型计费表」这种活儿，让 LLM 去"查价格"等于允许它编一个
   * 看起来合理的数字写进账单展示 —— 比不更新危险得多。这类作业必须是确定性的。
   * 同时它照样出现在 CRON 面板里，可开关、可手动跑一次，和别的作业一个用法。
   */
  builtin?: string;
  agent: string;
  input: string;
  schedule: string; // cron 表达式
  /** 固定的执行时区；全局显示时区变化不重排已有作业。 */
  timeZone: string;
  taskType: string;
  sessionMode: CronSessionMode;
  /** Trusted, stable destination; never grants execution identity. */
  delivery?: CronDelivery;
  executionIdentity?: CronExecutionIdentity;
  /** Local approval only; excluded from definitions and public responses. */
  ownerAuthorization?: CronOwnerAuthorization;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRun?: string;
  lastResult?: string;
  lastError?: string;
  lastStatus?: "queued" | "running" | "completed" | "failed" | "interrupted";
  lastDeliveryStatus?: "pending" | "sending" | "sent" | "failed" | "unknown" | "none";
  lastDeliveryError?: string;
  lastDeliveryAt?: string;
  lastRunId?: string;
  /** Local-only bounded receipts. Not included in job lists. */
  history?: CronRunRecord[];
  nextTick?: string; // 运行时计算
}

export interface CronCreateInput {
  name?: string;
  agent: string;
  input: string;
  schedule: string;
  timeZone?: string;
  taskType?: string;
  sessionMode?: CronSessionMode;
  delivery?: CronDelivery;
  executionIdentity?: CronExecutionIdentity;
}

export interface CronUpdateInput {
  name?: string;
  agent?: string;
  input?: string;
  schedule?: string;
  timeZone?: string;
  taskType?: string;
  sessionMode?: CronSessionMode;
  enabled?: boolean;
  delivery?: CronDelivery | null;
  executionIdentity?: CronExecutionIdentity;
}

export interface CronControllerOptions {
  enqueue: (task: Task) => void;
  logger: Logger;
  /** 内建作业处理器：名字 → 干活的函数，返回一句给面板显示的结果。 */
  builtins?: Record<string, () => Promise<string>>;
  /** 首次升级前宿主时区的持久快照，旧作业无显式时区时使用。 */
  legacyTimeZone?: string;
  /** 测试/嵌入场景可使用独立存储，不触碰生产 cron.json。 */
  storePath?: string;
  deliver?: (delivery: CronDelivery, text: string) => Promise<void>;
  validateDelivery?: (delivery: CronDelivery) => void;
}

export class CronController {
  private jobs: CronJob[] = [];
  private crons = new Map<string, Cron>();
  private readonly storePath: string;
  private readonly legacyTimeZone: string;
  private writes: Promise<void> = Promise.resolve();
  private activeRuns = new Map<string, string>();
  private starts = new Set<Promise<void>>();
  private changes: Promise<void> = Promise.resolve();
  private configuring = new Set<string>();
  private closed = false;

  constructor(private opts: CronControllerOptions) {
    this.storePath = opts.storePath ?? STORE;
    this.legacyTimeZone = normalizeTimeZone(opts.legacyTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  }

  /**
   * 确保某个内建作业存在（幂等）。用户删掉了就不会再自动加回来 —— 尊重他的选择，
   * 只在【从没建过】时补一次。判据是 builtin 名字，不是 id。
   */
  async ensureBuiltin(input: { builtin: string; name: string; schedule: string }): Promise<void> {
    const existing = this.jobs.filter((j) => j.builtin === input.builtin);
    if (existing.length) {
      // 旧版 migrate 漏掉 builtin，导致每次重启都再建一条；新迁移会把这些旧行识别回来，
      // 此处只保留最新一条并撤销其余定时器，启动一次即可自动修复本地历史脏数据。
      const keep = existing[0]!;
      for (const duplicate of existing.slice(1)) this.unschedule(duplicate.id);
      this.jobs = this.jobs.filter((j) => j.builtin !== input.builtin || j.id === keep.id);
      // Existing names/schedules are editable configuration, not defaults to overwrite on every boot.
      keep.agent = "-";
      keep.input = "";
      keep.taskType = "builtin";
      await this.save();
      return;
    }
    const timeZone = getHarbourTimeZone();
    assertValidCron(input.schedule, timeZone);
    const now = new Date().toISOString();
    this.jobs.unshift({
      id: `cron-${randomUUID().slice(0, 8)}`,
      name: input.name,
      builtin: input.builtin,
      agent: "-",          // 内建作业不派 agent
      input: "",
      schedule: input.schedule,
      timeZone,
      taskType: "builtin",
      sessionMode: "fresh",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    await this.save();
    const job = this.jobs[0]!;
    this.schedule(job);
    this.opts.logger.info({ builtin: input.builtin, schedule: input.schedule }, "cron:builtin 已登记");
  }

  async init(): Promise<void> {
    const loaded = await load(this.storePath, this.legacyTimeZone);
    this.jobs = await restoreCronRuntime(this.storePath, loaded.jobs);
    let recovered = false;
    for (const job of this.jobs) {
      if (seedCronHistory(job)) recovered = true;
      if (job.enabled && job.executionIdentity === "owner" && !hasCronOwnerAuthorization(job)) {
        job.enabled = false;
        this.opts.logger.warn({ id: job.id }, "cron:owner-authorization-missing（暂停，需本机主人重新授权）");
        recovered = true;
      }
      if (job.lastStatus === "queued" || job.lastStatus === "running"
        || job.lastDeliveryStatus === "pending" || job.lastDeliveryStatus === "sending") {
        if (job.lastStatus === "queued" || job.lastStatus === "running") {
          job.lastStatus = "interrupted";
          job.lastError = "后端在本轮完成前停止；未自动重跑任务或重发结果。";
        }
        if (job.lastDeliveryStatus === "sending") {
          job.lastDeliveryStatus = "unknown";
          job.lastDeliveryError = "重启前投递未完成确认，请先核对目标渠道；不会自动重发。";
        } else if (job.lastDeliveryStatus === "pending") {
          job.lastDeliveryStatus = "failed";
          job.lastDeliveryError = "后端停止时尚未开始投递；结果不会自动重发。";
        }
        recovered = true;
      }
    }
    // 必须先保存旧作业的执行时区，成功后才开 timer，避免迁移到另一台机器时漂移。
    if (loaded.needsTimeZoneMigration || loaded.needsRuntimeMigration || recovered) await this.save();
    for (const j of this.jobs) if (j.enabled) this.schedule(j);
    this.opts.logger.info(
      { count: this.jobs.length, enabled: this.jobs.filter((j) => j.enabled).length },
      "cron 已加载（持久化定时作业；各自 enabled 控制）"
    );
  }

  list() {
    return this.jobs.map((j) => ({ ...publicJob(j), nextTick: this.crons.get(j.id)?.nextRun()?.toISOString() }));
  }

  history(id: string) {
    const job = this.find(id);
    return { runs: (job.history || []).map(cronRunSummary), retentionLimit: CRON_HISTORY_LIMIT };
  }

  runRecord(id: string, runId: string): CronRunRecord | undefined {
    return cloneCronHistory(this.find(id).history)?.find(run => run.id === runId);
  }

  async add(input: CronCreateInput, authorizationSource?: RunSource): Promise<CronJob> {
    const frozen = { ...input, ...(input.delivery ? { delivery: { ...input.delivery } } : {}) };
    const source = cloneSource(authorizationSource);
    return this.change(() => this.addJob(frozen, source));
  }

  private async addJob(input: CronCreateInput, authorizationSource?: RunSource): Promise<CronJob> {
    if (!input.agent || !input.input || !input.schedule) throw new Error("cron: agent/input/schedule 必填");
    const timeZone = normalizeTimeZone(input.timeZone ?? getHarbourTimeZone());
    assertValidCron(input.schedule, timeZone);
    const delivery = input.delivery === undefined ? undefined : this.validateDelivery(input.delivery);
    const now = new Date().toISOString();
    const job: CronJob = {
      id: `cj-${randomUUID().slice(0, 8)}`,
      name: input.name?.trim() || defaultName(input.agent, input.schedule),
      agent: input.agent,
      input: input.input,
      schedule: input.schedule,
      timeZone,
      taskType: input.taskType ?? "cron",
      sessionMode: input.sessionMode === "continue" ? "continue" : "fresh",
      ...(delivery ? { delivery } : {}),
      ...(input.executionIdentity ? { executionIdentity: input.executionIdentity } : {}),
      enabled: false, // 默认暂停，需显式开启，避免一建就烧 token
      createdAt: now,
      updatedAt: now,
    };
    if (job.executionIdentity === "owner") job.ownerAuthorization = grantCronOwnerAuthorization(job, authorizationSource);
    this.jobs.unshift(job);
    try { await this.save(); }
    catch (error) {
      this.jobs = this.jobs.filter(candidate => candidate !== job);
      await this.saveRollback(job.id);
      throw error;
    }
    return publicJob(job);
  }

  /** PATCH 编辑：可显式改执行时区，并按需重排；全局时区不参与已有作业更新。 */
  async update(id: string, patch: CronUpdateInput, authorizationSource?: RunSource): Promise<CronJob> {
    const frozen = { ...patch, ...(patch.delivery ? { delivery: { ...patch.delivery } } : {}) };
    const source = cloneSource(authorizationSource);
    return this.change(() => this.updateJob(id, frozen, source));
  }

  private async updateJob(id: string, patch: CronUpdateInput, authorizationSource?: RunSource): Promise<CronJob> {
    const job = this.find(id);
    // 先验证全部排程参数再修改内存，非法 timezone 不能留下半次 schedule 更新。
    const timeZone = normalizeTimeZone(patch.timeZone ?? job.timeZone);
    const schedule = patch.schedule ?? job.schedule;
    assertValidCron(schedule, timeZone);
    const delivery = patch.delivery === undefined ? job.delivery
      : patch.delivery === null ? undefined : this.validateDelivery(patch.delivery);
    if (job.builtin && delivery) throw new Error("cron: 内建作业不能配置渠道投递");
    const before = cloneJob(job);
    const next = { ...cloneJob(job), ...patch, schedule, timeZone, delivery,
      name: patch.name?.trim() || job.name, updatedAt: new Date().toISOString() };
    if (patch.executionIdentity === "owner") next.ownerAuthorization = grantCronOwnerAuthorization(next, authorizationSource);
    else if (next.executionIdentity !== "owner" || !hasCronOwnerAuthorization(next)) delete next.ownerAuthorization;
    if (next.executionIdentity === "owner" && !hasCronOwnerAuthorization(next)) {
      if (patch.enabled === true) assertCronAuthorization(next);
      next.enabled = false;
    }
    this.configuring.add(id);
    Object.assign(job, next);
    if (!next.ownerAuthorization) delete job.ownerAuthorization;
    try {
      await this.save();
      // A rejected update must never arm a timer with a configuration that was not saved.
      if (job.enabled) this.schedule(job);
      else this.unschedule(id);
    } catch (error) {
      // Preserve concurrently completed run/delivery receipts; only undo definition fields.
      for (const key of Object.keys(job) as Array<keyof CronJob>) {
        if (!(cronRuntimeKeys as readonly string[]).includes(key)) delete job[key];
      }
      Object.assign(job, definitionOf(before));
      if (before.ownerAuthorization) job.ownerAuthorization = before.ownerAuthorization;
      await this.saveRollback(id);
      throw error;
    } finally { this.configuring.delete(id); }
    this.opts.logger.info({ id, enabled: job.enabled }, "cron:update");
    return publicJob(job);
  }

  async toggle(id: string, enabled: boolean): Promise<CronJob> {
    return this.update(id, { enabled });
  }

  async remove(id: string): Promise<void> {
    if (this.activeRuns.has(id)) throw new CronJobBusyError(id);
    return this.change(async () => {
      if (this.activeRuns.has(id)) throw new CronJobBusyError(id);
      const before = [...this.jobs];
      this.configuring.add(id);
      this.jobs = this.jobs.filter((j) => j.id !== id);
      try { await this.save(); this.unschedule(id); }
      catch (error) {
        this.jobs = before;
        await this.saveRollback(id);
        throw error;
      } finally { this.configuring.delete(id); }
    });
  }

  runOnce(id: string): CronJob {
    const job = this.find(id);
    this.trigger(job, "manual");
    return publicJob(job);
  }

  close(): void {
    this.closed = true;
    for (const c of this.crons.values()) c.stop();
    this.crons.clear();
  }

  /** Wait for queued persistence, without executing any job. */
  async flush(): Promise<void> {
    await this.changes;
    while (this.starts.size) await Promise.all([...this.starts]);
    await this.writes;
  }

  /** Serialize configuration commits, so a rejected change cannot leak into a later snapshot. */
  private change<T>(operation: () => Promise<T>): Promise<T> {
    const change = this.changes.then(operation);
    this.changes = change.then(() => {}, () => {});
    return change;
  }

  private async saveRollback(id: string): Promise<void> {
    try { await this.save(); }
    catch (error) { this.opts.logger.error({ id, err: errorMessage(error) }, "cron:rollback-persist-failed"); }
  }

  private validateDelivery(value: CronDelivery): CronDelivery {
    const delivery = normalizeCronDelivery(value);
    this.opts.validateDelivery?.({ ...delivery });
    return delivery;
  }

  private find(id: string): CronJob {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new Error(`未知 cron job: ${id}`);
    return job;
  }

  private schedule(job: CronJob): void {
    this.unschedule(job.id);
    if (this.closed) return;
    try {
      const timezone = normalizeTimeZone(job.timeZone);
      this.crons.set(job.id, new Cron(job.schedule, { unref: true, timezone }, () => {
        try { this.trigger(job, "cron"); }
        catch (error) { this.opts.logger.warn({ id: job.id, err: errorMessage(error) }, "cron:trigger-skipped"); }
      }));
    } catch (e) {
      job.enabled = false;
      job.lastError = (e as Error).message;
      this.opts.logger.warn({ id: job.id, schedule: job.schedule, err: job.lastError }, "cron:invalid");
    }
  }

  private unschedule(id: string): void {
    this.crons.get(id)?.stop();
    this.crons.delete(id);
  }

  private trigger(job: CronJob, kind: "cron" | "manual"): void {
    if (this.closed) throw new Error("cron: 调度器已关闭，未启动新任务");
    if (this.activeRuns.has(job.id) || this.configuring.has(job.id)) throw new CronJobBusyError(job.id);
    assertCronAuthorization(job);
    const runId = `cron-${randomUUID()}`;
    this.activeRuns.set(job.id, runId);
    const frozen = cloneJob(job);
    const source = cronRunSource(frozen, runId);
    job.lastRun = new Date().toISOString();
    job.lastRunId = runId;
    job.lastStatus = "queued";
    job.lastError = undefined;
    job.lastDeliveryStatus = frozen.delivery ? "pending" : "none";
    job.lastDeliveryError = undefined;
    job.lastDeliveryAt = undefined;
    job.history = [newCronRun(frozen, runId, kind, job.lastRun), ...(job.history || [])].slice(0, CRON_HISTORY_LIMIT);
    let completion: Promise<void> | undefined;
    let failure: Promise<void> | undefined;
    let started: Promise<void> | undefined;
    const settle = () => {
      if (this.activeRuns.get(job.id) === runId) this.activeRuns.delete(job.id);
    };
    const fail = (error: unknown): Promise<void> => {
      // A transport failure is not an execution failure, and must not replace its saved output.
      if (completion) return Promise.resolve();
      return failure ??= (async () => {
        job.lastStatus = "failed";
        job.lastError = errorMessage(error);
        if (frozen.delivery) {
          job.lastDeliveryStatus = "failed";
          job.lastDeliveryError = "任务执行失败，未开始投递。";
        }
        await this.save();
      })();
    };
    const complete = async (text: string): Promise<void> => {
      job.lastResult = text;
      job.lastStatus = "completed";
      job.lastError = undefined;
      let sendStarted = false;
      try {
        // The output is durable before even reserving the irreversible send boundary.
        await this.save();
        if (!frozen.delivery) return;
        if (!this.opts.deliver) throw new Error("cron: 未配置渠道投递器，结果已保留");
        this.validateDelivery(frozen.delivery);
        job.lastDeliveryStatus = "sending";
        await this.save();
        sendStarted = true;
        await this.opts.deliver({ ...frozen.delivery }, text);
        job.lastDeliveryStatus = "sent";
        job.lastDeliveryAt = new Date().toISOString();
        await this.save();
      } catch (error) {
        if (frozen.delivery) {
          job.lastDeliveryStatus = sendStarted && !(error instanceof CronDeliveryRejectedError) ? "unknown" : "failed";
          job.lastDeliveryError = errorMessage(error);
        } else job.lastError = `结果保存失败：${errorMessage(error)}`;
        try { await this.save(); }
        catch (saveError) { this.opts.logger.error({ id: job.id, err: errorMessage(saveError) }, "cron:persist-failed"); }
        throw error;
      }
    };
    const task: Task = {
      id: runId,
      agentName: frozen.agent,
      taskType: frozen.taskType,
      input: frozen.input,
      source,
      // continue 模式：挂上稳定的 session key，让这个作业跨次累积记忆（runtime 未开 sessions 时自动忽略）。
      ...(frozen.sessionMode === "continue" ? { sessionRef: { key: `cron:${job.id}`, channel: "cron", runId, actor: { ...source.actor! } } } : {}),
      meta: { cron: true, channel: "cron", kind, cronJobId: job.id, agent: frozen.agent, sessionMode: frozen.sessionMode },
      onStart: () => {
        if (completion || failure || this.activeRuns.get(job.id) !== runId) return Promise.resolve();
        return started ??= (async () => {
          if (this.closed) throw new Error("cron: 调度器已关闭，本轮未开始执行");
          if (frozen.executionIdentity === "owner") {
            assertCronAuthorization(job);
            if (!hasCronOwnerAuthorization(job) || job.ownerAuthorization?.id !== frozen.ownerAuthorization?.id) {
              throw new Error("cron: 排队期间授权已撤销或配置已变更，本轮未开始执行");
            }
          }
          job.lastStatus = "running";
          const record = job.history?.find(run => run.id === runId);
          if (record) record.startedAt = new Date().toISOString();
          await this.save();
          if (this.closed) throw new Error("cron: 调度器已关闭，本轮未开始执行");
        })();
      },
      reply: (text) => failure ? failure : (completion ??= complete(text)),
      onError: fail,
      onSettled: settle,
    };
    // Do not hand work to the queue until its reservation has been saved successfully.
    const start = this.save().then(async () => {
      if (this.closed) throw new Error("cron: 调度器已关闭，本轮尚未入队，未启动新任务");
      if (!this.jobs.includes(job)) { settle(); return; }
      if (frozen.builtin) {
        const fn = this.opts.builtins?.[frozen.builtin];
        if (!fn) throw new Error(`未注册的内建作业：${frozen.builtin}`);
        await task.onStart!();
        void Promise.resolve().then(fn).then((text) => task.reply!(text))
          .catch(async (error) => {
            this.opts.logger.error({ id: job.id, err: errorMessage(error) }, "cron:builtin-failed");
            try { await fail(error); }
            catch (saveError) { this.opts.logger.error({ id: job.id, err: errorMessage(saveError) }, "cron:persist-failed"); }
          }).finally(settle);
      } else {
        this.opts.enqueue(task);
        this.opts.logger.info({ id: job.id, agent: frozen.agent, kind }, "cron:enqueue");
      }
    }).catch(async (error) => {
      this.opts.logger.error({ id: job.id, err: errorMessage(error) }, "cron:start-failed");
      try { await fail(error); }
      catch (saveError) { this.opts.logger.error({ id: job.id, err: errorMessage(saveError) }, "cron:persist-failed"); }
      settle();
    });
    this.starts.add(start);
    void start.finally(() => this.starts.delete(start));
  }

  private async save(): Promise<void> {
    for (const job of this.jobs) syncCronHistory(job);
    const snapshot = this.jobs.map(job => ({ ...cloneJob(job) }));
    const write = this.writes.then(() => persistCronState(this.storePath, snapshot));
    this.writes = write.catch(() => {});
    await write;
  }

}

function cloneJob(job: CronJob): CronJob {
  return { ...job, ...(job.delivery ? { delivery: { ...job.delivery } } : {}),
    ...(job.history ? { history: cloneCronHistory(job.history) } : {}),
    ...(job.ownerAuthorization ? { ownerAuthorization: { ...job.ownerAuthorization, grantedBy: { ...job.ownerAuthorization.grantedBy } } } : {}) };
}

function cloneSource(source?: RunSource): RunSource | undefined {
  return source ? { ...source, ...(source.actor ? { actor: { ...source.actor } } : {}) } : undefined;
}

function publicJob(job: CronJob) {
  const { ownerAuthorization: _localOnly, history: _history, ...view } = job;
  return { ...view, ...(job.delivery ? { delivery: { ...job.delivery } } : {}), authorizationStatus: job.executionIdentity !== "owner" ? "system" as const
    : hasCronOwnerAuthorization(job) ? "authorized" as const : "required" as const };
}

function definitionOf(job: CronJob): Partial<CronJob> {
  const definition: Partial<CronJob> = cloneJob(job);
  for (const key of cronLocalKeys) delete definition[key as keyof CronJob];
  return definition;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultName(agent: string, schedule: string): string {
  return `${agent} @ ${schedule}`;
}

function assertValidCron(expr: string, timeZone: string): void {
  try {
    new Cron(expr, { paused: true, timezone: timeZone }).stop();
  } catch {
    throw new Error(`非法 cron 表达式: ${expr}`);
  }
}

async function load(storePath: string, legacyTimeZone: string): Promise<{ jobs: CronJob[]; needsTimeZoneMigration: boolean; needsRuntimeMigration: boolean }> {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CronJob>[];
    if (!Array.isArray(parsed)) throw new Error("cron.json 无效；保留原文件，未启动定时任务");
    // 向后兼容旧 data/cron.json（无 name/sessionMode/updatedAt/lastRun）。
    return {
      jobs: parsed.map((j) => migrate(j, legacyTimeZone)),
      needsTimeZoneMigration: parsed.some((j) => j.timeZone == null),
      needsRuntimeMigration: parsed.some((j) => cronLocalKeys.some((key) => Object.hasOwn(j, key))),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { jobs: [], needsTimeZoneMigration: false, needsRuntimeMigration: false };
    throw error;
  }
}

function migrate(j: Partial<CronJob> & { lastTick?: string }, legacyTimeZone: string): CronJob {
  const createdAt = j.createdAt ?? new Date(0).toISOString();
  // 兼容 2026-07 旧文件：保存时有 builtin，但旧 migrate 读回来时把它漏了；更早已经
  // 被重写成无 builtin 的行则可由这组稳定特征识别，再交 ensureBuiltin 自动去重。
  const builtin = j.builtin || (
    j.taskType === "builtin" && j.agent === "-" && /^刷新模型(?:目录与)?计费表$/.test(j.name ?? "")
      ? "pricing-refresh"
      : undefined
  );
  return {
    id: j.id ?? `cj-${randomUUID().slice(0, 8)}`,
    name: j.name ?? defaultName(j.agent ?? "?", j.schedule ?? "* * * * *"),
    ...(builtin ? { builtin } : {}),
    agent: j.agent ?? "",
    input: j.input ?? "",
    schedule: j.schedule ?? "* * * * *",
    timeZone: j.timeZone ?? legacyTimeZone,
    taskType: j.taskType ?? "cron",
    sessionMode: j.sessionMode === "continue" ? "continue" : "fresh",
    ...(j.executionIdentity === "owner" ? { executionIdentity: "owner" as const } : {}),
    ...(j.delivery === undefined ? {} : { delivery: normalizeCronDelivery(j.delivery) }),
    enabled: !!j.enabled,
    createdAt,
    updatedAt: j.updatedAt ?? createdAt,
    lastRun: j.lastRun ?? j.lastTick,
    lastResult: j.lastResult,
    lastError: j.lastError,
    lastStatus: j.lastStatus,
    lastDeliveryStatus: j.lastDeliveryStatus,
    lastDeliveryError: j.lastDeliveryError,
    lastDeliveryAt: j.lastDeliveryAt,
    lastRunId: j.lastRunId,
  };
}
