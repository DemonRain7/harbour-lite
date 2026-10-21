import type { CronJob } from "./cron";

export const CRON_HISTORY_LIMIT = 50;
const RESULT_LIMIT = 65_536;
const INPUT_LIMIT = 16_384;

/** Local execution receipts, never part of a synced task definition or an Agent prompt. */
export interface CronRunRecord {
  id: string;
  trigger: "manual" | "cron" | "unknown";
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  status?: CronJob["lastStatus"];
  result?: string;
  resultTruncated?: boolean;
  error?: string;
  deliveryStatus?: CronJob["lastDeliveryStatus"];
  deliveryError?: string;
  deliveryAt?: string;
  legacy?: boolean;
  configuration?: {
    name: string; agent: string; builtin?: string; input: string; inputTruncated?: boolean;
    schedule: string; timeZone: string; taskType: string; sessionMode: string;
    executionIdentity: string; deliveryLabel?: string;
  };
}

export function newCronRun(job: CronJob, id: string, trigger: "manual" | "cron", queuedAt: string): CronRunRecord {
  return {
    id, trigger, queuedAt, status: "queued",
    configuration: {
      name: job.name, agent: job.agent, builtin: job.builtin,
      input: job.input.slice(0, INPUT_LIMIT), ...(job.input.length > INPUT_LIMIT ? { inputTruncated: true } : {}),
      schedule: job.schedule, timeZone: job.timeZone, taskType: job.taskType,
      sessionMode: job.sessionMode, executionIdentity: job.executionIdentity || "system",
      ...(job.delivery ? { deliveryLabel: job.delivery.label || job.delivery.channel } : {}),
    },
  };
}

/** The old store retained only lastRun. Do not invent a trigger, duration or past configuration. */
export function seedCronHistory(job: CronJob): boolean {
  if (!job.lastRun || job.history?.length) return false;
  job.history = [{ id: job.lastRunId || `legacy:${job.lastRun}`, trigger: "unknown", queuedAt: job.lastRun, legacy: true }];
  syncCronHistory(job);
  return true;
}

export function syncCronHistory(job: CronJob): void {
  const record = job.history?.find(run => run.id === (job.lastRunId || `legacy:${job.lastRun}`));
  if (!record) return;
  record.status = job.lastStatus;
  record.error = job.lastError?.slice(0, 4096);
  record.deliveryStatus = job.lastDeliveryStatus;
  record.deliveryError = job.lastDeliveryError?.slice(0, 4096);
  record.deliveryAt = job.lastDeliveryAt;
  if (!record.legacy && ["completed", "failed", "interrupted"].includes(job.lastStatus || "") && !record.finishedAt) {
    record.finishedAt = new Date().toISOString();
  }
  // lastResult deliberately survives failures for compatibility. Never assign that older result to a new failed run.
  if (job.lastStatus === "completed" && typeof job.lastResult === "string") {
    record.result = job.lastResult.slice(0, RESULT_LIMIT);
    record.resultTruncated = job.lastResult.length > RESULT_LIMIT || undefined;
  }
}

export function cronRunSummary(run: CronRunRecord) {
  const { configuration: _configuration, result, ...summary } = run;
  return {
    ...summary,
    summary: (run.error || result || "").slice(0, 220),
    hasResult: typeof result === "string",
    ...(run.startedAt && run.finishedAt ? { durationMs: Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt)) } : {}),
  };
}

export function cloneCronHistory(history?: CronRunRecord[]): CronRunRecord[] | undefined {
  return history?.slice(0, CRON_HISTORY_LIMIT).map(run => ({ ...run,
    ...(run.configuration ? { configuration: { ...run.configuration } } : {}),
  }));
}

/** Local files are still validated; unknown metadata (including authorization material) is not exposed. */
export function readCronHistory(value: unknown): CronRunRecord[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Cron 执行历史格式无效，未覆盖本机记录");
  return value.slice(0, CRON_HISTORY_LIMIT).map(raw => {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || typeof raw.queuedAt !== "string"
      || !["manual", "cron", "unknown"].includes(raw.trigger)) throw new Error("Cron 执行回执格式无效，未覆盖本机记录");
    const run: CronRunRecord = { id: raw.id, queuedAt: raw.queuedAt, trigger: raw.trigger };
    for (const key of ["startedAt", "finishedAt", "result", "error", "deliveryError", "deliveryAt"] as const) {
      if (typeof raw[key] === "string") run[key] = raw[key].slice(0, key === "result" ? RESULT_LIMIT : 4096);
    }
    if (["queued", "running", "completed", "failed", "interrupted"].includes(raw.status)) run.status = raw.status;
    if (["none", "pending", "sending", "sent", "failed", "unknown"].includes(raw.deliveryStatus)) run.deliveryStatus = raw.deliveryStatus;
    if (raw.legacy === true) run.legacy = true;
    if (raw.resultTruncated === true || typeof raw.result === "string" && raw.result.length > RESULT_LIMIT) run.resultTruncated = true;
    if (raw.configuration && typeof raw.configuration === "object" && !Array.isArray(raw.configuration)) {
      const c = raw.configuration;
      const text = (key: string, limit = 4096) => typeof c[key] === "string" ? c[key].slice(0, limit) : "";
      run.configuration = { name: text("name"), agent: text("agent"), input: text("input", INPUT_LIMIT), schedule: text("schedule"),
        timeZone: text("timeZone"), taskType: text("taskType"), sessionMode: text("sessionMode"), executionIdentity: text("executionIdentity"),
        ...(text("builtin") ? { builtin: text("builtin") } : {}), ...(text("deliveryLabel") ? { deliveryLabel: text("deliveryLabel") } : {}),
        ...(c.inputTruncated === true || typeof c.input === "string" && c.input.length > INPUT_LIMIT ? { inputTruncated: true } : {}),
      };
    }
    return run;
  });
}
