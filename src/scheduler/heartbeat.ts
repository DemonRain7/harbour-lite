import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { Agent, HeartbeatTask, Task } from "../types";
import type { Logger } from "pino";
import { normalizeTimeZone } from "../core/timeZone";

/**
 * HeartbeatController
 *
 * HEARTBEAT.md 仍是配置来源，但 serve 启动后默认只加载任务，不自动开始 timer。
 * UI/API 显式启用后才创建 interval/cron，避免管理端一启动就烧 token。
 */

export interface HeartbeatControllerOptions {
  agents: Agent[];
  enqueue: (task: Task) => void;
  logger: Logger;
  /** 未声明时区的任务沿用持久化的旧宿主时区（含以后新增的未声明任务）。 */
  legacyTimeZone?: string;
}

export interface HeartbeatConfiguredTask {
  id: string;
  agent: string;
  cron?: string;
  every?: string;
  timeZone: string;
  input: string;
  taskType: string;
  enabled: boolean;
  lastTick?: string;
  lastResult?: string;
  lastError?: string;
  nextTick?: string;
  dailyEstimate?: number;
}

export interface HeartbeatStatus {
  enabled: boolean;
  running: boolean;
  count: number;
  dailyEstimate: number;
  lastTick?: string;
  tasks: HeartbeatConfiguredTask[];
}

interface InternalHeartbeatTask extends HeartbeatConfiguredTask {
  parsedEveryMs?: number;
  configurationError?: string;
}

export class HeartbeatController {
  private enabled = false;
  private tasks: InternalHeartbeatTask[] = [];
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private jobs = new Map<string, Cron>();
  private lastTick?: string;
  private readonly legacyTimeZone: string;

  constructor(private opts: HeartbeatControllerOptions) {
    this.legacyTimeZone = normalizeTimeZone(opts.legacyTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    this.tasks = opts.agents.flatMap((agent) =>
      (agent.heartbeats ?? []).map((hb, index) => this.toTask(agent, hb, index))
    );
    opts.logger.info(
      { tasks: this.tasks.length, enabled: this.enabled },
      "heartbeat 已加载（默认暂停；通过 UI/API 显式开启）"
    );
  }

  status(): HeartbeatStatus {
    const tasks = this.tasks.map((t) => this.publicTask(t));
    return {
      enabled: this.enabled,
      running: this.timers.size > 0 || this.jobs.size > 0,
      count: tasks.length,
      dailyEstimate: Math.round(tasks.reduce((sum, t) => sum + (t.dailyEstimate ?? 0), 0) * 10) / 10,
      lastTick: this.lastTick,
      tasks,
    };
  }

  setEnabled(enabled: boolean): HeartbeatStatus {
    if (enabled === this.enabled) return this.status();
    this.enabled = enabled;
    if (enabled) this.startTimers();
    else this.stopTimers();
    this.opts.logger.info({ enabled }, "heartbeat:toggle");
    return this.status();
  }

  runOnce(taskId?: string): HeartbeatConfiguredTask {
    const task = taskId ? this.tasks.find((t) => t.id === taskId) : this.tasks[0];
    if (!task) throw new Error(taskId ? `未知 heartbeat task: ${taskId}` : "没有可运行的 heartbeat task");
    if (task.configurationError) throw new Error(task.configurationError);
    this.trigger(task, "manual");
    return this.publicTask(task);
  }

  close(): void {
    this.stopTimers();
  }

  private startTimers(): void {
    this.stopTimers();
    for (const task of this.tasks) {
      if (task.configurationError) {
        task.lastError = task.configurationError;
        continue;
      }
      task.enabled = true;
      task.lastError = undefined;
      if (task.parsedEveryMs != null) {
        task.nextTick = iso(Date.now() + task.parsedEveryMs);
        const timer = setInterval(() => {
          this.trigger(task, "interval");
          task.nextTick = iso(Date.now() + task.parsedEveryMs!);
        }, task.parsedEveryMs);
        timer.unref?.();
        this.timers.set(task.id, timer);
      } else if (task.cron) {
        try {
          const job = new Cron(task.cron, { unref: true, timezone: task.timeZone }, () => this.trigger(task, "cron"));
          this.jobs.set(task.id, job);
        } catch (e) {
          task.enabled = false;
          task.lastError = (e as Error).message;
          this.opts.logger.warn({ id: task.id, cron: task.cron, err: task.lastError }, "heartbeat:cron-invalid");
        }
      }
    }
  }

  private stopTimers(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    for (const job of this.jobs.values()) job.stop();
    this.timers.clear();
    this.jobs.clear();
    for (const task of this.tasks) {
      task.enabled = false;
      task.nextTick = undefined;
    }
  }

  private trigger(task: InternalHeartbeatTask, kind: "interval" | "cron" | "manual"): void {
    const tick = new Date().toISOString();
    this.lastTick = tick;
    task.lastTick = tick;
    task.lastError = undefined;

    const queued: Task = {
      id: `hb-${randomUUID().slice(0, 8)}`,
      agentName: task.agent,
      taskType: task.taskType,
      input: task.input,
      meta: { heartbeat: true, kind, heartbeatTaskId: task.id, agent: task.agent },
      reply: async (text) => {
        task.lastResult = text;
      },
    };

    this.opts.logger.info({ id: queued.id, taskId: task.id, agent: task.agent, kind }, "heartbeat:enqueue");
    this.opts.enqueue(queued);
  }

  private toTask(agent: Agent, hb: HeartbeatTask, index: number): InternalHeartbeatTask {
    const parsedEveryMs = hb.every ? parseEvery(hb.every) ?? undefined : undefined;
    let timeZone = hb.timeZone ?? this.legacyTimeZone;
    let configurationError: string | undefined;
    try { timeZone = normalizeTimeZone(timeZone); }
    catch (error) { configurationError = (error as Error).message; }
    const task: InternalHeartbeatTask = {
      id: `${agent.name}:${index + 1}`,
      agent: agent.name,
      cron: hb.cron,
      every: hb.every,
      timeZone,
      input: hb.input,
      taskType: hb.taskType ?? "heartbeat",
      enabled: false,
      parsedEveryMs,
      dailyEstimate: estimateDailyRuns(hb, parsedEveryMs),
      configurationError,
    };
    if (hb.every && parsedEveryMs == null) task.lastError = `无法解析 every: ${hb.every}`;
    if (configurationError) task.lastError = configurationError;
    return task;
  }

  private publicTask(task: InternalHeartbeatTask): HeartbeatConfiguredTask {
    const job = this.jobs.get(task.id);
    const nextTick = task.enabled
      ? task.parsedEveryMs != null
        ? task.nextTick
        : job?.nextRun()?.toISOString()
      : undefined;
    return {
      id: task.id,
      agent: task.agent,
      cron: task.cron,
      every: task.every,
      timeZone: task.timeZone,
      input: task.input,
      taskType: task.taskType,
      enabled: task.enabled,
      lastTick: task.lastTick,
      lastResult: task.lastResult,
      lastError: task.lastError,
      nextTick,
      dailyEstimate: task.dailyEstimate,
    };
  }
}

/** "30m" / "90s" / "2h" / "500ms" -> 毫秒；无法解析返回 null。 */
function parseEvery(s: string): number | null {
  const m = /^(\d+)\s*(ms|s|m|h)$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      return null;
  }
}

function estimateDailyRuns(hb: HeartbeatTask, everyMs?: number): number {
  if (everyMs && everyMs > 0) return Math.round((86_400_000 / everyMs) * 10) / 10;
  if (hb.cron) return 1;
  return 0;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
