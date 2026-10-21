import type { Attachment, Message, SessionRef } from "../types";

export type MessageMode = "steer" | "queue";
export type SteerResult = "accepted" | "unavailable" | "unknown";
/** A submitted native supplement must not be replayed by provider fallback. */
export class NativeInputDeliveryError extends Error {
  constructor(cause: unknown) {
    super("原生补充期间运行中断；请核对已保存的输入与进度，不能自动重放本轮。", { cause });
    this.name = "NativeInputDeliveryError";
  }
}
export interface RunInput {
  id: string;
  text: string;
  attachments?: Attachment[];
  /** Must persist before transport submission, including acceptance-unknown. */
  record: (state: "sending" | "accepted" | "waiting" | "unknown", runId: string) => Promise<void>;
}
export function inputScope(ref: SessionRef, agent: string): string {
  if (!ref.id || !ref.actor) throw new Error("消息必须绑定已确认的会话和入口身份");
  return JSON.stringify([ref.id, ref.key, ref.channel, agent, ref.actor.platform, ref.actor.id, ref.actor.role]);
}

/** One lease per root run. Children receive only revision/hasPending, never this mailbox. */
export class RunInputLease {
  revision = 0;
  private pending: RunInput[] = [];
  private native?: (input: RunInput) => Promise<SteerResult>;
  private transport = Promise.resolve();
  private closing = false;
  private uncertain = false;
  private nativeOnly = false;
  private nativeDeliveryHolds = 0;
  constructor(readonly runId: string, readonly scope: string,
    private accepted: (message: Message, id: string) => Promise<void>, private changed: () => void) {}
  get hasPending(): boolean { return this.pending.length > 0 || this.uncertain; }
  /** Even an unavailable native send can still own an input until this lease finishes. */
  hasInput(id: string): boolean { return this.pending.some(input => input.id === id); }
  offer(input: RunInput): boolean {
    if (this.closing || this.pending.some(value => value.id === input.id)) return false;
    this.pending.push(input); this.revision++; this.changed(); this.pump(); return true;
  }
  bindNative(send: (input: RunInput) => Promise<SteerResult>, options?: { nativeOnly?: boolean }): () => void {
    this.nativeOnly ||= options?.nativeOnly === true;
    this.native = send; this.pump();
    return () => { if (this.native === send) this.native = undefined; };
  }
  /** Defer unsent native input until the caller has persisted its side-effect boundary.
   * Pending input remains visible so active workflows can yield. Acquiring/releasing a
   * hold never waits for an already-submitted native receipt, which may await this tool. */
  holdNativeDelivery(): () => void {
    this.nativeDeliveryHolds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.nativeDeliveryHolds === 0) this.pump();
    };
  }
  private pump(): void {
    this.transport = this.transport.then(async () => {
      while (this.native && this.pending.length && !this.closing && !this.uncertain && !this.nativeDeliveryHolds) {
        const input = this.pending[0]!;
        const send = this.native;
        await input.record("sending", this.runId);
        if (this.native !== send || this.closing || this.nativeDeliveryHolds) { await input.record("waiting", this.runId); break; }
        let result: SteerResult;
        try { result = await send(input); } catch { result = "unknown"; }
        if (result === "unavailable") { await input.record("waiting", this.runId); break; }
        if (result === "unknown") { this.uncertain = true; await input.record("unknown", this.runId); this.pending.shift(); break; }
        await this.accepted({ role: "user", content: input.text, attachments: input.attachments }, input.id);
        await input.record("accepted", this.runId);
        this.pending.shift();
      }
    }).catch(async () => { this.uncertain = true;
      await this.pending[0]?.record("unknown", this.runId).catch(() => undefined); this.changed(); });
  }
  /** After detaching a native sender, settle its durable acceptance records before final delivery. */
  async settleNative(): Promise<void> { await this.transport; }
  /** Legacy backend path only; native-only adapters queue known-unsent inputs for the next run. */
  async drainAtBoundary(): Promise<Message[]> {
    this.native = undefined;
    await this.transport;
    if (this.uncertain || this.nativeOnly) return [];
    const result: Message[] = [];
    // Images must be routed with a confirmed multimodal backend next round, not silently captioned.
    while (this.pending.length && !this.pending[0]!.attachments?.length) {
      const input = this.pending[0]!;
      await input.record("sending", this.runId);
      const message: Message = { role: "user", content: input.text };
      try {
        await this.accepted(message, input.id);
        await input.record("accepted", this.runId);
      } catch (error) {
        this.uncertain = true;
        await input.record("unknown", this.runId).catch(() => undefined);
        throw error;
      }
      this.pending.shift(); result.push(message);
    }
    return result;
  }
  /** Close admission synchronously before final delivery; a late message belongs to the next run. */
  seal(): void { this.closing = true; this.native = undefined; }
  async finish(): Promise<void> {
    this.seal(); await this.transport;
    for (const input of this.pending.splice(0)) await input.record(this.uncertain ? "unknown" : "waiting", this.runId);
  }
}

export class ActiveRunInputs {
  private leases = new Map<string, RunInputLease>();
  private preparing = new Map<string, number>();
  private listeners = new Set<() => void>();
  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private changed = () => { for (const fn of this.listeners) fn(); };
  isBusy(sessionId: string): boolean { return this.leases.has(sessionId) || (this.preparing.get(sessionId) ?? 0) > 0; }
  reserve(sessionId: string): () => void {
    this.preparing.set(sessionId, (this.preparing.get(sessionId) ?? 0) + 1); this.changed(); let released = false;
    return () => { if (released) return; released = true;
      const remaining = (this.preparing.get(sessionId) ?? 1) - 1;
      if (remaining) this.preparing.set(sessionId, remaining); else this.preparing.delete(sessionId); this.changed(); };
  }
  offer(ref: SessionRef, agent: string, input: RunInput): boolean {
    const lease = this.leases.get(ref.id!);
    return !!lease && lease.scope === inputScope(ref, agent) && lease.offer(input);
  }
  hasInput(ref: SessionRef, agent: string, id: string): boolean {
    const lease = this.leases.get(ref.id!);
    return !!lease && lease.scope === inputScope(ref, agent) && lease.hasInput(id);
  }
  register(ref: SessionRef, agent: string, runId: string, accepted: (message: Message, id: string) => Promise<void>): RunInputLease {
    if (this.leases.has(ref.id!)) throw new Error("同一会话已有活跃运行");
    const lease = new RunInputLease(runId, inputScope(ref, agent), accepted, this.changed);
    this.leases.set(ref.id!, lease); this.changed(); return lease;
  }
  async release(ref: SessionRef, lease: RunInputLease): Promise<void> {
    try { await lease.finish(); }
    finally { if (this.leases.get(ref.id!) === lease) this.leases.delete(ref.id!); this.changed(); }
  }
}
