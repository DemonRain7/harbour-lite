import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const locks = new Map<string, Promise<void>>();
interface Reservation { anlas: number; state: "active" | "uncertain" | "settled"; updatedAt: string }
interface Ledger { version: 1; entries: Record<string, Reservation> }
/** One central Harbour/NovelAI account. No timers expire unknown paid operations. */
export class NovelAiAccountReservations {
  readonly file: string;
  constructor(file: string) { this.file = path.resolve(file); }
  private key(onceKey: string) { return createHash("sha256").update(onceKey).digest("hex"); }
  private async mutate<T>(work: (ledger: Ledger) => T): Promise<T> {
    const previous = locks.get(this.file) ?? Promise.resolve();
    let release!: () => void;
    const next = previous.then(() => new Promise<void>(resolve => { release = resolve; }));
    locks.set(this.file, next);
    await previous;
    try {
      const ledger: Ledger = await fs.readFile(this.file, "utf8").then(JSON.parse).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return { version: 1, entries: {} }; throw error;
      });
      if (ledger.version !== 1 || !ledger.entries || typeof ledger.entries !== "object" || Array.isArray(ledger.entries)) throw new Error("NovelAI 余额预留账本损坏，未提交生成");
      for (const [key, row] of Object.entries(ledger.entries)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !row || !Number.isSafeInteger(row.anlas) || row.anlas < 0 || !["active", "uncertain", "settled"].includes(row.state)) throw new Error("NovelAI 余额预留记录无效");
      }
      const result = work(ledger);
      // Settled rows are just replay tombstones; authoritative onceKeys remain in each Job.
      const settled = Object.entries(ledger.entries).filter(([, row]) => row.state === "settled").sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt));
      for (const [key] of settled.slice(4096)) delete ledger.entries[key];
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temp, JSON.stringify(ledger), { flag: "wx" }); await fs.rename(temp, this.file); }
      finally { await fs.unlink(temp).catch(() => undefined); }
      return result;
    } finally { release(); if (locks.get(this.file) === next) locks.delete(this.file); }
  }
  async reserve(onceKey: string, anlas: number): Promise<number> {
    if (!Number.isSafeInteger(anlas) || anlas < 0) throw new Error("NovelAI 预留额度无效");
    return this.mutate(ledger => {
      const key = this.key(onceKey);
      if (ledger.entries[key]) throw new Error("此 onceKey 已有余额预留/执行记录；先查原 Job，不能再次提交");
      const others = Object.values(ledger.entries).reduce((sum, row) => sum + (row.state === "settled" ? 0 : row.anlas), 0);
      ledger.entries[key] = { anlas, state: "active", updatedAt: new Date().toISOString() };
      return others;
    });
  }
  async settle(onceKey: string, chargeState: "charged" | "not_charged" | "unknown", visibleCost?: number): Promise<void> {
    await this.mutate(ledger => {
      const row = ledger.entries[this.key(onceKey)];
      if (!row) return; // Legacy/import-only jobs may predate the shared account ledger.
      // A known page cost is already booked in the Job. "settled" only releases this
      // in-flight reservation; it does not relabel the Job's chargeState as charged.
      row.state = chargeState === "unknown" && visibleCost === undefined ? "uncertain" : "settled";
      if (chargeState === "unknown" && typeof visibleCost === "number" && Number.isSafeInteger(visibleCost) && visibleCost >= 0) row.anlas = visibleCost;
      row.updatedAt = new Date().toISOString();
    });
  }
}

/** Page balance must cover this Generate and all other outstanding central reservations. */
export function assertNovelAiAvailableBalance(balance: unknown, cost: number, otherReserved: number): void {
  if (!otherReserved || cost === 0) return;
  if (typeof balance !== "number" || !Number.isFinite(balance) || balance < cost + otherReserved) {
    throw new Error(`NovelAI 可用余额不足或待核对：本次 ${cost} Anlas，其他任务预留 ${otherReserved}；未提交 Generate`);
  }
}
