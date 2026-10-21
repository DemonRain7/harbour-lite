import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_TIME_ZONE, TIME_ZONE_OPTIONS, formatZonedIso, normalizeTimeZone, setHarbourTimeZone } from "./timeZone";

interface TimeSettings {
  version: 1;
  timeZone: string;
  /** Captured once before schedules start; display changes never rewrite old schedule semantics. */
  legacyScheduleTimeZone: string;
  revision: number;
  updatedAt: string | null;
}

export class TimeSettingsStore {
  private state: TimeSettings;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private file = path.resolve("data/timeSettings.json"), legacyTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    this.state = { version: 1, timeZone: DEFAULT_TIME_ZONE, legacyScheduleTimeZone: normalizeTimeZone(legacyTimeZone), revision: 0, updatedAt: null };
  }
  get legacyScheduleTimeZone(): string { return this.state.legacyScheduleTimeZone; }
  get timeZone(): string { return this.state.timeZone; }

  async load(): Promise<void> {
    let exists = true;
    try {
      const data = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (data.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0 ||
          !(data.updatedAt === null || (typeof data.updatedAt === "string" && Number.isFinite(Date.parse(data.updatedAt))))) {
        throw new Error("时区配置格式无效；请检查 data/timeSettings.json，未覆盖原文件");
      }
      this.state = { version: 1, timeZone: normalizeTimeZone(data.timeZone),
        legacyScheduleTimeZone: normalizeTimeZone(data.legacyScheduleTimeZone), revision: data.revision, updatedAt: data.updatedAt };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
    }
    // Persist the old host's scheduling zone before a later migration can change it.
    if (!exists) await this.persist(this.state);
    setHarbourTimeZone(this.state.timeZone);
  }

  snapshot() {
    const now = new Date().toISOString();
    return { timeZone: this.state.timeZone, revision: this.state.revision, updatedAt: this.state.updatedAt,
      legacyScheduleTimeZone: this.state.legacyScheduleTimeZone, options: TIME_ZONE_OPTIONS,
      now, formattedNow: formatZonedIso(now, this.state.timeZone), schedulePolicy: "fixed-existing" as const };
  }

  async set(value: unknown) {
    const timeZone = normalizeTimeZone(value);
    const write = this.writes.then(async () => {
      if (timeZone !== this.state.timeZone) {
        const next = { ...this.state, timeZone, revision: this.state.revision + 1, updatedAt: new Date().toISOString() };
        await this.persist(next);
        this.state = next;
        setHarbourTimeZone(timeZone);
      }
      return this.snapshot();
    });
    this.writes = write.catch(() => {});
    return write;
  }

  private async persist(state: TimeSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
      await fs.rename(temporary, this.file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
}
