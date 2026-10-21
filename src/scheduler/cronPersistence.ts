import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseCronOwnerAuthorization } from "./cronAuthorization";
import { readCronHistory } from "./cronHistory";

export const cronRuntimeKeys = ["lastRun", "lastResult", "lastError", "lastTick", "nextTick",
  "lastStatus", "lastDeliveryStatus", "lastDeliveryError", "lastDeliveryAt", "lastRunId", "history"] as const;
export const cronLocalKeys = [...cronRuntimeKeys, "ownerAuthorization"] as const;
type Row = Record<string, unknown>;

export function cronRuntimePath(storePath: string): string {
  return path.join(path.dirname(storePath), `${path.basename(storePath, ".json")}-runtime.json`);
}

/** Only definitions travel through Git. Results remain on the backend that executed the job. */
export function splitCronState(jobs: readonly Row[]): { definitions: Row[]; runtime: { version: 1; jobs: Record<string, Row> } } {
  const runtime: { version: 1; jobs: Record<string, Row> } = { version: 1, jobs: Object.create(null) };
  const definitions = jobs.map((job) => {
    const definition = { ...job };
    const state: Row = {};
    delete definition.ownerAuthorization;
    const authorization = parseCronOwnerAuthorization(job.ownerAuthorization);
    if (authorization) state.ownerAuthorization = authorization;
    for (const key of cronRuntimeKeys) {
      delete definition[key];
      if (key === "history") state.history = readCronHistory(job.history);
      else if (key !== "nextTick" && key !== "lastTick" && typeof job[key] === "string") state[key] = job[key];
    }
    if (state.lastRun === undefined && typeof job.lastTick === "string") state.lastRun = job.lastTick;
    if (typeof job.id === "string") runtime.jobs[job.id] = state;
    return definition;
  });
  return { definitions, runtime };
}

export async function restoreCronRuntime<T extends { id: string }>(storePath: string, jobs: T[]): Promise<T[]> {
  // Never trust an approval smuggled through a synced definition, even without a local runtime file.
  jobs = jobs.map(job => { const local = { ...job } as T & Row; delete local.ownerAuthorization; return local; });
  let raw;
  try { raw = await fs.readFile(cronRuntimePath(storePath), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return jobs; throw error; }
  const runtime = JSON.parse(raw);
  if (runtime?.version !== 1 || !runtime.jobs || typeof runtime.jobs !== "object" || Array.isArray(runtime.jobs)) {
    throw new Error("cron-runtime.json 无效；保留原文件，未覆盖本机运行记录");
  }
  return jobs.map((job) => {
    if (!Object.hasOwn(runtime.jobs, job.id)) return job;
    const local = runtime.jobs[job.id];
    const restored: Row = { ...job };
    for (const key of cronRuntimeKeys) delete restored[key];
    for (const key of cronRuntimeKeys) {
      if (key === "nextTick" || key === "lastTick") continue;
      if (key === "history") restored.history = readCronHistory(local?.history);
      else if (local && typeof local[key] === "string") restored[key] = local[key];
    }
    const authorization = parseCronOwnerAuthorization(local?.ownerAuthorization);
    if (authorization) restored.ownerAuthorization = authorization;
    return restored as T;
  });
}

async function atomicWriteIfChanged(file: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2) + "\n";
  try { if (await fs.readFile(file, "utf8") === text) return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function persistCronState(storePath: string, jobs: readonly Row[]): Promise<void> {
  const { definitions, runtime } = splitCronState(jobs);
  // Persist local history BEFORE removing legacy embedded results; an interrupted migration cannot lose them.
  await atomicWriteIfChanged(cronRuntimePath(storePath), runtime);
  await atomicWriteIfChanged(storePath, definitions);
}
