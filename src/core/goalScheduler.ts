import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { ChatSession, SessionGoal, SessionStore } from "./sessionStore";

export function publicSessionGoal(goal?: SessionGoal) {
  if (!goal) return null;
  const { source: _source, runUsage: _runUsage, ...publicGoal } = goal;
  return structuredClone(publicGoal);
}

export type GoalEvent =
  | { type: "goal:updated"; sessionId: string; goal: ReturnType<typeof publicSessionGoal> }
  | { type: "goal:start"; sessionId: string; runId: string; agent: string }
  | { type: "goal:turn"; sessionId: string; runId: string; agent: string; answer: string }
  | { type: "goal:error"; sessionId: string; runId: string; agent: string; reason: string };

/** Server-owned continuation queue. Timers never run an LLM until durable state,
 * delivery holds, active leases and the captured goal/revision all agree. */
export class GoalScheduler {
  private enabled = false;
  private timer?: NodeJS.Timeout;
  private active = new Map<string, { controller: AbortController; runId: string }>();
  private holds = new Map<string, number>();
  private listeners = new Set<(event: GoalEvent) => void | Promise<void>>();
  private pending = new Set<string>();
  private preparing = new Set<string>();
  private generation = 0;
  constructor(private store: SessionStore | null, private opts: {
    sessions(): ChatSession[];
    run(session: ChatSession, goalId: string, revision: number, runId: string, signal: AbortSignal): Promise<string>;
    logger: Logger;
    concurrency?: number;
    hasPendingInput?(session: ChatSession): boolean;
  }) {}

  subscribe(listener: (event: GoalEvent) => void | Promise<void>) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private async emit(event: GoalEvent) {
    for (const listener of this.listeners) {
      try { await listener(event); } catch (error) {
        this.opts.logger.warn({ type: event.type, err: String(error) }, "goal:delivery-failed");
        // Delivery failure must not be mistaken for an execution failure or replay work.
      }
    }
  }
  publish(session: ChatSession) { void this.emit({ type: "goal:updated", sessionId: session.id, goal: publicSessionGoal(session.goal) }); }
  start() {
    if (this.enabled || !this.store) return;
    this.enabled = true;
    for (const session of this.opts.sessions()) if (session.goal?.autoContinue && session.goal.status === "active") this.nudge(session.id);
  }
  stop() {
    this.enabled = false;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined; this.pending.clear();
    for (const run of this.active.values()) run.controller.abort(new Error("server shutdown"));
  }
  isRunning(sessionId: string) { return this.active.has(sessionId); }
  /** Hold through transport delivery as well as the model run. */
  hold(sessionId: string) {
    this.holds.set(sessionId, (this.holds.get(sessionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return; released = true;
      const count = (this.holds.get(sessionId) ?? 1) - 1;
      if (count) this.holds.set(sessionId, count); else this.holds.delete(sessionId);
      this.nudge(sessionId);
    };
  }
  interrupt(sessionId: string, reason = "user stop") { this.active.get(sessionId)?.controller.abort(new Error(reason)); }
  /** Dashboard stop buttons target a captured run, never whichever turn is now active. */
  interruptRun(sessionId: string, runId: string) {
    const run = this.active.get(sessionId);
    if (run?.runId === runId) run.controller.abort(new Error("user stop"));
  }
  nudge(sessionId: string) {
    if (!this.enabled || !this.store) return;
    this.pending.add(sessionId);
    this.tick();
  }
  private tick() {
    if (!this.enabled || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.pump(); }, 0);
    this.timer.unref?.();
  }
  private async pump() {
    if (!this.enabled || !this.store) return;
    const generation = this.generation;
    for (const sessionId of [...this.pending]) {
      if (this.active.size + this.preparing.size >= (this.opts.concurrency ?? 2)) break;
      if (this.active.has(sessionId) || this.preparing.has(sessionId) || this.holds.has(sessionId)) continue;
      this.pending.delete(sessionId);
      const session = this.store.get(sessionId), goal = session?.goal;
      if (session && this.opts.hasPendingInput?.(session)) { this.pending.add(sessionId); continue; }
      if (!session || !goal || goal.status !== "active" || !goal.autoContinue || !goal.nextStep?.action || goal.waiting || goal.source?.actor?.role !== "owner") continue;
      if (session.permissionMode === "plan") {
        this.store.pauseGoal(session, goal.id, { kind: "user", reason: "PLAN 模式只做规划，切换执行模式后再恢复 GOAL。" }); this.publish(session); continue;
      }
      this.preparing.add(sessionId);
      try {
        if (goal.continuation.state === "running" || goal.continuation.runId) continue;
        // SessionStore replaces goal objects on every transition; never retain the
        // pre-schedule revision or use it to check pause/config changes after await.
        const scheduled = goal.continuation.state === "scheduled" ? goal : this.store.scheduleGoalContinuation(session, goal.id);
        const revision = scheduled.continuation.revision;
        await this.store.flushSessionDurably(session);
        if (generation !== this.generation || !this.ticketReady(session, goal.id, revision)) {
          if (this.enabled && session.goal?.status === "active") this.pending.add(sessionId);
          this.publish(session);
          continue;
        }
        const controller = new AbortController(), runId = `goal-${randomUUID()}`;
        this.active.set(sessionId, { controller, runId });
        void this.execute(session, goal.id, revision, runId, controller).finally(() => {
          if (this.active.get(sessionId)?.runId === runId) this.active.delete(sessionId);
          this.nudge(sessionId); this.tick();
        });
      } catch (error) {
        if (this.store.get(sessionId) === session && session.goal?.id === goal.id && session.goal.status === "active") {
          this.store.pauseGoal(session, goal.id, { kind: "interrupted", reason: `无法安排安全续轮：${String(error).slice(0, 300)}` });
        }
        this.publish(session);
      } finally {
        this.preparing.delete(sessionId);
        if (this.pending.size) this.tick();
      }
    }
  }
  private ticketReady(session: ChatSession, goalId: string, revision: number) {
    const goal = session.goal;
    return this.enabled && this.store?.get(session.id) === session && !this.holds.has(session.id) && !this.opts.hasPendingInput?.(session) &&
      session.permissionMode !== "plan" && goal?.id === goalId && goal.status === "active" && goal.autoContinue &&
      !!goal.nextStep?.action && !goal.waiting && goal.source?.actor?.role === "owner" &&
      goal.continuation.state === "scheduled" && !goal.continuation.runId && goal.continuation.revision === revision;
  }
  private async execute(session: ChatSession, goalId: string, revision: number, runId: string, controller: AbortController) {
    const agent = session.agentName;
    await this.emit({ type: "goal:start", sessionId: session.id, runId, agent });
    try {
      controller.signal.throwIfAborted();
      // Delivery listeners may pause/cancel/configure the goal while handling start.
      if (!this.ticketReady(session, goalId, revision)) {
        // A start event already opened trace/typing/activity state. Close that
        // presentation lease even though no runtime/model call was dispatched.
        await this.emit({ type: "goal:error", sessionId: session.id, runId, agent,
          reason: "GOAL 续轮票据在调用前已失效；本轮未执行。" });
        return;
      }
      const answer = await this.opts.run(session, goalId, revision, runId, controller.signal);
      await this.emit({ type: "goal:turn", sessionId: session.id, runId, agent, answer });
    } catch (error) {
      if (this.store?.get(session.id) === session && session.goal?.id === goalId && session.goal.status === "active") {
        this.store!.pauseGoal(session, goalId, { kind: "interrupted", reason: "运行已中断，保留原断点；确认后恢复，不自动重放未知写入。" });
      }
      await this.emit({ type: "goal:error", sessionId: session.id, runId, agent, reason: controller.signal.aborted ? String(controller.signal.reason) : String(error) });
    } finally {
      this.publish(session);
      try { await this.store!.flushSessionDurably(session); } catch { /* next pump's barrier still refuses execution */ }
    }
  }
}
