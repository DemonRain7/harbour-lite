import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { SessionRef, Task } from "../types";
import { ActiveRunInputs, inputScope, type MessageMode } from "./runInputs";

export interface IntakeSettings {
  defaultMode: MessageMode; textDelayMs: number; mediaDelayMs: number; maxWaitMs: number;
  maxMessages: number; maxPendingPerSession: number;
}
export const DEFAULT_INTAKE_SETTINGS: IntakeSettings = {
  defaultMode: "steer", textDelayMs: 5000, mediaDelayMs: 8000, maxWaitMs: 30000,
  maxMessages: 32, maxPendingPerSession: 128,
};
export type IntakeState = "collecting" | "waiting" | "sending" | "accepted" | "running" | "completed" | "paused" | "unknown" | "withdrawn";
type SavedTask = Omit<Task, "reply" | "onSettled">;
export interface IntakeRecord {
  version: 1; id: string; scope: string; route: string; mode: MessageMode;
  state: IntakeState; createdAt: number; updatedAt: number; dueAt: number; hold: boolean;
  messages: SavedTask[]; runId?: string; output?: string;
  delivery?: "pending" | "sending" | "delivered" | "unknown"; error?: string;
  segments?: Record<string, "sending" | "delivered" | "unknown">;
  archived?: boolean;
  /** Explicit one-shot mode: do not merge adjacent messages into this batch. */
  isolated?: boolean;
  /** Stable admission order, including same-millisecond messages across restarts. */
  sequence?: number;
  /** Durable CAS revision, including same-millisecond edits. */
  revision?: number;
  /** Keep original POST idempotency after an explicit queue → steer change. */
  admittedMode?: MessageMode;
  pendingChange?: { action: "withdraw" | "steer"; revision: number };
}
export class PendingInputConflict extends Error {}
function atomicJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx");
  try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
const terminal = (r: IntakeRecord) => !!r.archived || r.state === "completed" && r.delivery === "delivered";
const admissionOrder = (a: IntakeRecord, b: IntakeRecord) => {
  // Legacy records precede sequenced admissions; mixing timestamps and sequence comparisons
  // would not be transitive when the system clock moves backwards across an upgrade.
  if (a.sequence === undefined && b.sequence !== undefined) return -1;
  if (a.sequence !== undefined && b.sequence === undefined) return 1;
  return (a.sequence !== undefined && b.sequence !== undefined ? a.sequence - b.sequence : 0)
    || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
};

/** Durable admission and scheduling, no LLM. The same lane handles channels and Web follow-ups. */
export class MessageIntake {
  private records = new Map<string, IntakeRecord>();
  private nextSequence = 1;
  private routes = new Map<string, (task: Task, output: string) => Promise<void>>();
  private callbacks = new Map<string, () => void>();
  private held = new Set<string>();
  private paused = new Set<string>();
  private modes = new Map<string, MessageMode>();
  private offered = new Set<string>();
  private dispatch?: (task: Task) => Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private pumping = false;
  private stopped = false;
  private inFlight = new Set<string>();
  private preparation = new Map<string, number>();
  private stopEpochs = new Map<string, number>();
  private listeners = new Set<() => void>();
  private detachActive: () => void;
  recoveryError?: string;
  settings: IntakeSettings;
  constructor(private directory: string, readonly active: ActiveRunInputs, private settingsFile: string,
    private now: () => number = Date.now, private concurrency = 4) {
    this.settings = { ...DEFAULT_INTAKE_SETTINGS };
    if (fs.existsSync(settingsFile)) try { this.settings = this.validateSettings(JSON.parse(fs.readFileSync(settingsFile, "utf8"))); }
    catch { this.recoveryError = "消息设置损坏，自动投递已暂停；原文件未覆盖，请修复后重启。"; }
    fs.mkdirSync(directory, { recursive: true });
    const controlFile = path.join(directory, "control.json");
    if (fs.existsSync(controlFile)) try {
      const saved = JSON.parse(fs.readFileSync(controlFile, "utf8"));
      this.held = new Set(saved.held ?? []); this.paused = new Set(saved.paused ?? []); this.modes = new Map(saved.modes ?? []);
    } catch { this.recoveryError = "收件箱控制记录损坏，自动投递已暂停；原文件未覆盖，请核对后恢复。"; }
    for (const file of fs.readdirSync(directory).filter(name => /^[a-f0-9-]+\.json$/.test(name))) {
      try {
      const record = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")) as IntakeRecord;
      if (record.version !== 1 || !Array.isArray(record.messages) || record.id !== file.slice(0, -5)) throw new Error("收件记录损坏，请先核查本机收件箱");
      if (record.sequence !== undefined && (!Number.isSafeInteger(record.sequence) || record.sequence < 1)) throw new Error("收件顺序损坏，请先核查本机收件箱");
      if (["sending", "accepted", "running"].includes(record.state)) {
        record.state = "unknown"; record.error = "服务重启：上一运行的接收/执行结果需核对，不会自动重发。";
      }
      if (record.delivery === "sending") record.delivery = "unknown";
      this.records.set(record.id, record);
      if (Number.isSafeInteger(record.sequence) && record.sequence! >= this.nextSequence) this.nextSequence = record.sequence! + 1;
      if (record.hold && !record.archived) this.held.add(record.scope);
      if (!record.archived && ["paused", "unknown"].includes(record.state)) this.paused.add(record.scope);
      this.save(record);
      } catch { this.recoveryError = "本机有收件记录无法读取，自动投递已暂停；原文件未删除，请核对后重启。"; }
    }
    // readdir order is by UUID, not arrival; it must never decide what runs first.
    this.records = new Map([...this.records.values()].sort(admissionOrder).map(record => [record.id, record]));
    this.detachActive = active.onChange(() => this.wake());
  }
  private validateSettings(value: Partial<IntakeSettings>): IntakeSettings {
    const clean = { ...DEFAULT_INTAKE_SETTINGS, ...value };
    if (!["steer", "queue"].includes(clean.defaultMode)) throw new Error("消息模式无效");
    for (const [key, min, max] of [["textDelayMs", 0, 30000], ["mediaDelayMs", 0, 60000], ["maxWaitMs", 1000, 120000],
      ["maxMessages", 1, 64], ["maxPendingPerSession", 1, 256]] as const) {
      if (!Number.isInteger(clean[key]) || clean[key] < min || clean[key] > max) throw new Error(`${key} 超出允许范围 ${min}–${max}`);
    }
    return clean;
  }
  configure(patch: Partial<IntakeSettings>): IntakeSettings {
    const allowed = Object.keys(DEFAULT_INTAKE_SETTINGS);
    if (Object.keys(patch).some(key => !allowed.includes(key))) throw new Error("未知消息设置");
    const clean = this.validateSettings({ ...this.settings, ...patch });
    atomicJson(this.settingsFile, clean); this.settings = clean; return { ...clean };
  }
  setDispatch(fn: (task: Task) => Promise<void>): void { this.dispatch = fn; this.wake(); }
  setRoute(route: string, reply: (task: Task, output: string) => Promise<void>): void { this.routes.set(route, reply); this.wake(); }
  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private save(record: IntakeRecord, commit?: () => void): void {
    record.revision = (record.revision ?? 0) + 1;
    record.updatedAt = this.now(); atomicJson(path.join(this.directory, `${record.id}.json`), record);
    commit?.();
    for (const fn of this.listeners) fn();
  }
  list(sessionId: string, pendingOnly = false): IntakeRecord[] {
    return [...this.records.values()].filter(r => r.messages[0]?.sessionRef?.id === sessionId && (!pendingOnly || !terminal(r)))
      .sort(admissionOrder).map(r => structuredClone(r));
  }
  pendingControls(ref: SessionRef, agent: string, id: string) {
    const record = this.records.get(id);
    const canWithdraw = !!record && record.scope === this.scope(ref, agent) && !this.recoveryError && !record.archived
      && ["collecting", "waiting", "paused"].includes(record.state) && !this.offered.has(id) && !this.active.hasInput(ref, agent, id);
    return { revision: record?.revision ?? 0, canWithdraw,
      canSteer: canWithdraw && record!.mode === "queue" && record!.state !== "paused" && !record!.hold && !this.paused.has(record!.scope) };
  }
  /** No await between authority/CAS checks and durable removal: dispatch cannot race withdrawal. */
  changePending(ref: SessionRef, agent: string, id: string, action: "withdraw" | "steer", revision: number): IntakeRecord {
    const record = this.records.get(id);
    if (!record || record.scope !== this.scope(ref, agent)) throw new PendingInputConflict("这条消息不属于当前会话，未修改。");
    if (record.pendingChange?.action === action && record.pendingChange.revision === revision) return structuredClone(record);
    const controls = this.pendingControls(ref, agent, id);
    if (revision !== controls.revision) throw new PendingInputConflict("消息状态已更新，请查看最新状态后再操作。");
    if (!(action === "withdraw" ? controls.canWithdraw : controls.canSteer)) throw new PendingInputConflict("消息已交给运行处理、已暂停引导或结果待核对，不能撤回或改投。");
    // Persist a replacement before publishing it. Failed disk writes must not mutate live scheduling.
    const next = structuredClone(record);
    next.pendingChange = { action, revision };
    if (action === "withdraw") { next.state = "withdrawn"; next.archived = true; }
    else { next.admittedMode ??= next.mode; next.mode = "steer"; next.state = "waiting"; next.dueAt = this.now(); }
    this.save(next, () => this.records.set(id, next)); this.wake();
    if (action === "withdraw") for (const message of next.messages) {
      const settled = this.callbacks.get(message.id); this.callbacks.delete(message.id); settled?.();
    }
    return structuredClone(next);
  }
  /** Admission before slow attachment/ASR work. Stop also covers messages not enqueued yet. */
  beginPreparation(key: string) {
    const epoch = this.stopEpochs.get(key) ?? 0;
    this.preparation.set(key, (this.preparation.get(key) ?? 0) + 1);
    let released = false;
    return { wasStopped: () => epoch !== (this.stopEpochs.get(key) ?? 0), release: () => {
      if (released) return; released = true;
      const count = (this.preparation.get(key) ?? 1) - 1;
      if (count) this.preparation.set(key, count); else this.preparation.delete(key);
      this.wake(); for (const listener of this.listeners) listener();
    } };
  }
  blocksAutomatic(sessionId: string, key: string): boolean {
    return !!this.recoveryError || this.active.isBusy(sessionId) || this.preparation.has(key) || [...this.records.values()].some(r =>
      r.messages[0]?.sessionRef?.id === sessionId && !terminal(r));
  }
  private scope(ref: SessionRef, agent: string): string { return inputScope(ref, agent); }
  private saveControls(): void { atomicJson(path.join(this.directory, "control.json"), { held: [...this.held], paused: [...this.paused], modes: [...this.modes] }); }
  mode(ref: SessionRef, agent: string): MessageMode { return this.modes.get(this.scope(ref, agent)) ?? this.settings.defaultMode; }
  setMode(ref: SessionRef, agent: string, mode: MessageMode): void {
    if (!["steer", "queue"].includes(mode)) throw new Error("消息模式无效");
    this.modes.set(this.scope(ref, agent), mode); this.saveControls();
  }
  enqueue(task: Task, route: string, options: { mode?: MessageMode; isolated?: boolean; immediate?: boolean; messageId?: string; paused?: boolean } = {}): IntakeRecord {
    if (this.recoveryError) throw new Error(this.recoveryError);
    const ref = task.sessionRef!; const scope = this.scope(ref, task.agentName);
    const mode = options.mode ?? this.mode(ref, task.agentName);
    if (mode !== "queue" && mode !== "steer") throw new Error("消息模式无效");
    if (task.input.length > 128000 || (task.attachments?.length ?? 0) > 10) throw new Error("单条消息过大；每条最多 10 个附件，请分批提交");
    const messageId = options.messageId ? createHash("sha256").update(`${route}:${scope}:${options.messageId}`).digest("hex") : task.id;
    const duplicate = [...this.records.values()].find(r => r.messages.some(t => t.id === messageId));
    if (duplicate) {
      const original = duplicate.messages.find(t => t.id === messageId)!;
      if (original.input !== task.input || JSON.stringify(original.attachments ?? []) !== JSON.stringify(task.attachments ?? [])) throw new Error("同一消息编号对应不同内容；未覆盖或重复执行旧消息");
      if (options.mode !== undefined && (duplicate.admittedMode ?? duplicate.mode) !== options.mode || !!duplicate.isolated !== !!options.isolated) throw new Error("同一消息编号对应不同投递方式；未改投或重复执行旧消息");
      return structuredClone(duplicate);
    }
    // An explicit NEW message may proceed after stop; earlier paused/unknown work stays visible, never replayed.
    if (!options.paused && this.paused.delete(scope)) this.saveControls();
    const pending = [...this.records.values()].filter(r => r.scope === scope && !terminal(r));
    if (pending.reduce((sum, r) => sum + r.messages.length, 0) >= this.settings.maxPendingPerSession ||
      [...this.records.values()].filter(r => !terminal(r)).length >= 1000) throw new Error("待处理消息已达容量上限，原待办已保留；请先发完或处理待办后再发");
    const last = pending.at(-1);
    const canMerge = last && last.state === "collecting" && last.mode === mode && last.route === route && !last.isolated && !options.isolated && !options.immediate && !options.paused &&
      last.messages.length < this.settings.maxMessages &&
      last.messages.reduce((sum, t) => sum + t.input.length, task.input.length) < 128000 &&
      last.messages.reduce((sum, t) => sum + (t.attachments?.length ?? 0), task.attachments?.length ?? 0) <= 10;
    const at = this.now();
    const record: IntakeRecord = canMerge ? last : { version: 1, id: randomUUID(), scope, route, mode,
      state: "collecting", createdAt: at, updatedAt: at, dueAt: at, hold: this.held.has(scope), messages: [], sequence: this.nextSequence++, ...(options.isolated ? { isolated: true } : {}) };
    const { reply: _reply, onSettled, ...saved } = task;
    record.messages.push(structuredClone({ ...saved, id: messageId }));
    if (onSettled) this.callbacks.set(messageId, onSettled);
    const delay = record.messages.some(t => t.attachments?.length) ? this.settings.mediaDelayMs : this.settings.textDelayMs;
    record.dueAt = options.immediate ? at : Math.min(at + delay, record.createdAt + this.settings.maxWaitMs);
    if (options.paused) record.state = "paused";
    this.records.set(record.id, record); this.save(record); this.wake();
    return structuredClone(record);
  }
  collect(ref: SessionRef, agent: string, hold: boolean): void {
    const scope = this.scope(ref, agent);
    if (hold) this.held.add(scope); else this.held.delete(scope);
    this.saveControls();
    for (const r of this.records.values()) if (r.scope === scope && r.state === "collecting") {
      r.hold = hold; if (!hold) { r.dueAt = this.now(); r.state = "waiting"; } this.save(r);
    }
    this.wake();
  }
  pause(ref: SessionRef, agent: string): void {
    this.stopEpochs.set(ref.key, (this.stopEpochs.get(ref.key) ?? 0) + 1);
    const scope = this.scope(ref, agent); this.paused.add(scope);
    this.saveControls();
    for (const r of this.records.values()) if (r.scope === scope && ["collecting", "waiting"].includes(r.state) && !this.offered.has(r.id)) { r.state = "paused"; this.save(r); }
  }
  resume(ref: SessionRef, agent: string): void {
    const scope = this.scope(ref, agent);
    if ([...this.records.values()].some(r => r.scope === scope && r.state === "unknown" && !r.archived)) throw new Error("有结果未知的输入，请先核对运行记录；不能自动重复执行");
    this.paused.delete(scope);
    this.saveControls();
    for (const r of this.records.values()) if (r.scope === scope && r.state === "paused" && !r.archived) { r.state = "waiting"; r.dueAt = this.now(); this.save(r); }
    this.wake();
  }
  /** Acknowledge a reviewed stale receipt, NEVER claim its execution succeeded or replay it. */
  acknowledge(ref: SessionRef, agent: string, id: string): void {
    const r = this.records.get(id);
    if (!r || r.scope !== this.scope(ref, agent) || !["unknown", "paused", "completed"].includes(r.state)) throw new Error("只能归档已核对的未知回执、暂停消息或保存的答复");
    r.error = `${r.error ? `${r.error}\n` : ""}用户已归档此回执；未重新执行，原文及运行记录仍保留。`;
    r.archived = true; this.save(r);
    this.wake();
  }
  private task(record: IntakeRecord): Task {
    const last = record.messages.at(-1)!;
    return { ...structuredClone(last), id: record.id,
      input: record.messages.length === 1 ? last.input : record.messages.map((t, i) =>
        `[消息 ${i + 1}${t.attachments?.length ? ` · 附件：${t.attachments.map(a => a.name || a.kind).join("、")}` : ""}]\n${t.input}`).join("\n\n"),
      attachments: record.messages.flatMap(t => t.attachments ?? []),
      sessionRef: { ...last.sessionRef!, runId: record.id },
      meta: { ...last.meta, intakeId: record.id, intakeTrace: record.messages.flatMap(t => Array.isArray(t.meta?.intakeTrace) ? t.meta.intakeTrace : []) },
      reply: output => this.deliver(record.id, output),
      onSettled: () => { for (const t of record.messages) { this.callbacks.get(t.id)?.(); this.callbacks.delete(t.id); } },
    };
  }
  async deliver(id: string, output: string): Promise<void> {
    const record = this.records.get(id)!;
    if (record.delivery === "delivered") return;
    if (record.delivery === "unknown" || record.delivery === "sending") throw new Error("渠道回执未知；不会自动重发结果");
    record.output = output; record.delivery = "pending"; this.save(record);
    const send = this.routes.get(record.route); if (!send) throw new Error("渠道未连接，结果已保存");
    record.delivery = "sending"; this.save(record);
    try { await send(this.task(record), output); record.delivery = "delivered"; this.save(record); }
    catch (error) { record.delivery = "unknown"; record.error = "发送结果未知；已保存答复，不会重做任务。"; this.save(record); throw error; }
  }
  /** Send segment journals are independent of generation/Agent execution. */
  segmentHooks(id: unknown) {
    const r = typeof id === "string" ? this.records.get(id) : undefined;
    return r ? {
      skip: (index: number) => r.segments?.[index] === "delivered",
      before: async (index: number) => { r.segments ??= {}; r.segments[index] = "sending"; this.save(r); },
      after: async (index: number) => { r.segments ??= {}; r.segments[index] = "delivered"; this.save(r); },
    } : undefined;
  }
  async resend(ref: SessionRef, agent: string, id: string, confirmUnknown = false): Promise<void> {
    const r = this.records.get(id);
    if (!r || r.scope !== this.scope(ref, agent) || r.state !== "completed" || !r.output) throw new Error("没有可补发的已完成结果");
    if (r.delivery === "sending") throw new Error("仍在发送，不能并发补发");
    if (r.delivery === "unknown" && !confirmUnknown) throw new Error("上次可能已经送达；确认可能重复后才能补发未确认的片段");
    if (r.delivery === "delivered") return;
    r.delivery = "pending"; this.save(r); await this.deliver(id, r.output);
  }
  executed(id: unknown, output: string): void {
    if (typeof id !== "string") return;
    const r = this.records.get(id); if (!r) return;
    r.state = "completed"; r.output = output; r.delivery = "pending"; this.save(r);
    for (const child of this.records.values()) if (child.runId === id && child.state === "accepted") {
      child.state = "completed"; child.delivery = "delivered"; this.save(child);
    }
  }
  async releaseRun(runId: string, completed: boolean): Promise<void> {
    for (const r of this.records.values()) if (r.runId === runId && r.state === "accepted") {
      r.state = completed ? "completed" : "unknown";
      r.delivery = completed ? "delivered" : undefined;
      if (!completed) { r.error = "补充已接收，但运行中断；查看原会话断点，不会单独重跑补充。"; this.paused.add(r.scope); }
      this.save(r);
    }
    this.wake();
  }
  private wake(): void {
    if (this.stopped || this.timer || this.recoveryError) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.pump().catch(() => { this.recoveryError = "收件箱持久化失败，自动投递已暂停；请检查本机存储。"; }); }, 25); this.timer.unref?.();
  }
  async pump(): Promise<void> {
    if (this.stopped || this.pumping || this.recoveryError) return;
    this.pumping = true;
    try {
      const lanes = new Set<string>();
      for (const r of this.records.values()) {
        if (r.archived) continue;
        if (["completed", "accepted", "paused", "unknown"].includes(r.state)) continue;
        // Already-dispatched roots must not occupy the pending-input lane: channel
        // originals also live in this inbox, unlike directly-started Web runs.
        // ActiveRunInputs routes supplements; inFlight still guards the root through
        // reply delivery, including the interval after its native lease is released.
        if (r.state === "running") continue;
        if (lanes.has(r.scope)) continue;
        // Queued work is for the next run. While a run is active it must not block a
        // later supplement to that run. Steer inputs still retain their own FIFO:
        // an unsent image/unknown receipt cannot be overtaken by later text.
        if (r.mode !== "queue" || !this.active.isBusy(r.messages[0]!.sessionRef!.id!)) lanes.add(r.scope);
        if (this.paused.has(r.scope) || r.hold || r.dueAt > this.now() || this.preparation.has(r.messages[0]!.sessionRef!.key) || !["collecting", "waiting"].includes(r.state) || this.offered.has(r.id)) continue;
        const task = this.task(r); const ref = task.sessionRef!;
        if (r.state === "collecting") { r.state = "waiting"; this.save(r); }
        if (this.active.isBusy(ref.id!)) {
          if (r.mode === "steer") {
            this.offered.add(r.id);
            const offered = this.active.offer(ref, task.agentName, { id: r.id, text: task.input, attachments: task.attachments,
              record: async (state, runId) => {
                r.state = state === "waiting" && this.paused.has(r.scope) ? "paused" : state; r.runId = runId;
                if (state === "unknown") this.paused.add(r.scope);
                if (state !== "sending") this.offered.delete(r.id);
                this.save(r); this.wake();
              } });
            if (!offered) this.offered.delete(r.id);
          }
          continue;
        }
        if (!this.dispatch || !this.routes.has(r.route) || this.inFlight.has(r.scope) || this.inFlight.size >= this.concurrency) continue;
        this.inFlight.add(r.scope); r.state = "running"; r.runId = r.id; this.save(r);
        void this.dispatch(task).catch(error => { r.error = String(error).slice(0, 300); }).finally(() => {
          if (r.state === "running") {
            r.state = "unknown"; r.error ||= "本轮已停止或失败；发送“继续”走原会话断点，不会重新投递本条原始要求。";
            this.pause(ref, task.agentName); this.save(r);
          }
          this.inFlight.delete(r.scope); task.onSettled?.(); this.wake();
        }).catch(() => { this.recoveryError = "执行结果无法持久化，自动投递已暂停；请核对原会话和存储。"; });
      }
    } finally {
      this.pumping = false;
      if ([...this.records.values()].some(r => ["collecting", "waiting"].includes(r.state) && !r.hold && !this.paused.has(r.scope))) {
        this.timer = setTimeout(() => { this.timer = undefined; this.wake(); }, 150); this.timer.unref?.();
      }
    }
  }
  close(): void { this.stopped = true; this.detachActive(); if (this.timer) clearTimeout(this.timer); }
}
