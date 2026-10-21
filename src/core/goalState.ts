import { randomUUID } from "node:crypto";
import type { RunSource } from "../types";
import type { GoalVerification, GoalVerificationRequirement } from "./goalVerification";

export type SessionGoalStatus = "active" | "blocked" | "paused" | "completed" | "cancelled";
export interface GoalNextStep { action: string; reason?: string }
export interface GoalWaiting {
  kind: "user" | "authorization" | "external" | "budget" | "interrupted" | "restart" | "error";
  reason: string;
}
export interface GoalBudget { maxRounds: number; maxTokens: number | null }
export interface GoalRunUsage { totalTokens: number; outcome?: "answered" | "interrupted" | "error" }
export interface SessionGoal {
  version: 2;
  id: string;
  revision: number;
  objective: string;
  status: SessionGoalStatus;
  createdAt: string;
  updatedAt: string;
  progress?: string;
  completedAt?: string;
  cancelledAt?: string;
  pausedAt?: string;
  autoContinue: boolean;
  acceptance: string[];
  verificationRequirement: GoalVerificationRequirement;
  verification?: GoalVerification;
  nextStep?: GoalNextStep;
  waiting?: GoalWaiting;
  budget: GoalBudget;
  usage: { totalTokens: number; roundsStarted: number; roundsCompleted: number };
  /** Cumulative per trusted top-level run, including usage reported by its descendants. */
  runUsage: Record<string, GoalRunUsage>;
  continuation: { state: "idle" | "scheduled" | "running"; revision: number; runId?: string; scheduledAt?: string };
  /** Bound only by authenticated runtime code; never accepted from model/config patches. */
  source?: RunSource;
}
export interface GoalStartOptions {
  autoContinue?: boolean;
  acceptance?: string[];
  verificationRequirement?: GoalVerificationRequirement;
  budget?: Partial<GoalBudget>;
  nextStep?: GoalNextStep;
}
export interface GoalConfiguration extends GoalStartOptions { progress?: string; waiting?: GoalWaiting | null; nextStep?: GoalNextStep }
export interface GoalRunBinding { goalId: string; runId: string; automatic?: boolean; scheduleRevision?: number }
export interface GoalRunUpdate {
  status?: "active" | "blocked" | "completed";
  nextStep?: GoalNextStep;
  waiting?: GoalWaiting;
  progress?: string;
  verification?: GoalVerification;
}
export interface GoalRunFinish {
  goalId: string;
  runId: string;
  outcome: "answered" | "interrupted" | "error";
  update?: GoalRunUpdate;
}
export const GOAL_DEFAULT_MAX_ROUNDS = 20;
export const GOAL_MAX_ROUNDS = 1000;
const statuses: SessionGoalStatus[] = ["active", "blocked", "paused", "completed", "cancelled"];
const requirements: GoalVerificationRequirement[] = ["delivery", "recorded", "file_change", "user_acceptance"];
const waitingKinds: GoalWaiting["kind"][] = ["user", "authorization", "external", "budget", "interrupted", "restart", "error"];
export function goalText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim().slice(0, maximum) || undefined : undefined;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function count(value: unknown, fallback = 0): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback; }
export function normalizeGoalNextStep(value: unknown): GoalNextStep | undefined {
  const row = typeof value === "string" ? { action: value } : object(value);
  const action = goalText(row?.action, 2000);
  return action ? { action, ...(goalText(row?.reason, 1000) ? { reason: goalText(row?.reason, 1000)! } : {}) } : undefined;
}
export function normalizeGoalWaiting(value: unknown): GoalWaiting | undefined {
  const row = object(value); const reason = goalText(row?.reason, 2000);
  return reason && waitingKinds.includes(row?.kind as GoalWaiting["kind"]) ? { kind: row!.kind as GoalWaiting["kind"], reason } : undefined;
}
export function normalizeGoalSource(value: unknown): RunSource | undefined {
  const row = object(value); const actor = object(row?.actor);
  const channel = goalText(row?.channel, 80); const key = goalText(row?.key, 1000);
  const id = goalText(actor?.id, 240); const platform = goalText(actor?.platform, 80);
  if (!channel || !key || actor?.role !== "owner" || !id || !platform) return;
  return { channel, key, actor: { role: "owner", id, platform,
    ...(goalText(actor.displayName, 160) ? { displayName: goalText(actor.displayName, 160)! } : {}) },
    ...(goalText(row?.authorId, 240) ? { authorId: goalText(row?.authorId, 240)! } : {}) };
}
export function normalizeGoalVerification(value: unknown): GoalVerification | undefined {
  const row = object(value);
  if (!row || !["recorded", "user_accepted", "model_reported", "needs_evidence"].includes(String(row.status))
    || !requirements.includes(row.requirement as GoalVerificationRequirement)
    || row.coverage !== "recorded-boundaries-only" || !goalText(row.checkedAt, 80) || !Array.isArray(row.evidence)) return;
  const evidence = row.evidence.slice(0, 32).flatMap((item) => {
    const entry = object(item); const ref = goalText(entry?.ref, 500);
    if (!entry || !ref || !["tool", "file", "subjective", "user"].includes(String(entry.kind))) return [];
    return [{ kind: entry.kind as GoalVerification["evidence"][number]["kind"], ref,
      ...(goalText(entry.runId, 160) ? { runId: goalText(entry.runId, 160)! } : {}),
      ...(goalText(entry.summary, 500) ? { summary: goalText(entry.summary, 500)! } : {}) }];
  });
  return { status: row.status as GoalVerification["status"], requirement: row.requirement as GoalVerificationRequirement,
    checkedAt: goalText(row.checkedAt, 80)!, coverage: "recorded-boundaries-only", evidence };
}
export function goalCompletionVerified(goal: SessionGoal, verification = goal.verification): boolean {
  if (!verification || verification.requirement !== goal.verificationRequirement || verification.status === "needs_evidence") return false;
  if (goal.verificationRequirement === "delivery") return true;
  if (verification.status === "user_accepted") return true;
  if (goal.verificationRequirement === "user_acceptance") return false;
  return verification.status === "recorded" && verification.evidence.some((item) => goal.verificationRequirement === "file_change" ? item.kind === "file" : item.kind === "tool" || item.kind === "file");
}
export function validateGoalConfiguration(patch: GoalConfiguration): void {
  const allowed = new Set(["autoContinue", "acceptance", "verificationRequirement", "budget", "nextStep", "progress", "waiting"]);
  if (Object.keys(patch).some((key) => !allowed.has(key))) throw new Error("GOAL 配置含不允许的字段");
  if (patch.autoContinue !== undefined && typeof patch.autoContinue !== "boolean") throw new Error("autoContinue 必须为 boolean");
  if (patch.acceptance !== undefined && (!Array.isArray(patch.acceptance) || patch.acceptance.length > 24 || patch.acceptance.some((value) => !goalText(value, 1000)))) throw new Error("GOAL acceptance 必须为最多 24 条非空文本");
  if (patch.verificationRequirement !== undefined && !requirements.includes(patch.verificationRequirement)) throw new Error("未知 GOAL verificationRequirement");
  if (patch.nextStep !== undefined && !normalizeGoalNextStep(patch.nextStep)) throw new Error("GOAL nextStep.action 不能为空");
  if (patch.waiting !== undefined && patch.waiting !== null && !normalizeGoalWaiting(patch.waiting)) throw new Error("GOAL waiting 无效");
  if (patch.budget !== undefined) {
    if (!object(patch.budget) || Object.keys(patch.budget).some((key) => !["maxRounds", "maxTokens"].includes(key))) throw new Error("GOAL budget 无效");
    const { maxRounds, maxTokens } = patch.budget;
    if (maxRounds !== undefined && (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > GOAL_MAX_ROUNDS)) throw new Error(`GOAL maxRounds 必须为 1–${GOAL_MAX_ROUNDS}`);
    if (maxTokens !== undefined && maxTokens !== null && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) throw new Error("GOAL maxTokens 必须为正整数或 null");
  }
}
export function createSessionGoal(objective: string, options: GoalStartOptions = {}): SessionGoal {
  const text = goalText(objective, 4000);
  if (!text) throw new Error("GOAL 目标不能为空");
  validateGoalConfiguration(options);
  const now = new Date().toISOString();
  return { version: 2, id: `goal-${randomUUID().slice(0, 8)}`, revision: 1, objective: text, status: "active", createdAt: now, updatedAt: now,
    autoContinue: options.autoContinue === true, acceptance: options.acceptance?.map((item) => goalText(item, 1000)!) ?? [],
    verificationRequirement: options.verificationRequirement ?? "delivery",
    ...(options.nextStep ? { nextStep: normalizeGoalNextStep(options.nextStep)! } : {}),
    budget: { maxRounds: options.budget?.maxRounds ?? GOAL_DEFAULT_MAX_ROUNDS, maxTokens: options.budget?.maxTokens ?? null },
    usage: { totalTokens: 0, roundsStarted: 0, roundsCompleted: 0 }, runUsage: {}, continuation: { state: "idle", revision: 1 } };
}
export function goalRemainingTokens(goal: SessionGoal): number | undefined {
  return goal.budget.maxTokens === null ? undefined : Math.max(0, goal.budget.maxTokens - goal.usage.totalTokens);
}
export function goalBudgetExhausted(goal: SessionGoal): "rounds" | "tokens" | undefined {
  if (goal.budget.maxTokens !== null && goal.usage.totalTokens >= goal.budget.maxTokens) return "tokens";
  if (goal.usage.roundsStarted >= goal.budget.maxRounds) return "rounds";
}
/** Read compatibility: legacy goals never gain autonomous authorization by migration. */
export function normalizeSessionGoal(value: unknown): SessionGoal | undefined {
  const raw = object(value); const objective = goalText(raw?.objective, 4000);
  if (!raw || !objective || !statuses.includes(raw.status as SessionGoalStatus)) return;
  const goal = createSessionGoal(objective);
  goal.id = goalText(raw.id, 160) ?? goal.id;
  goal.status = raw.status as SessionGoalStatus;
  goal.revision = Math.max(1, count(raw.revision, 1));
  goal.createdAt = goalText(raw.createdAt, 80) ?? goal.createdAt;
  goal.updatedAt = goalText(raw.updatedAt, 80) ?? goal.createdAt;
  for (const key of ["progress", "completedAt", "cancelledAt", "pausedAt"] as const) {
    const text = goalText(raw[key], key === "progress" ? 2000 : 80); if (text) goal[key] = text;
  }
  if (raw.version === 2) {
    goal.autoContinue = raw.autoContinue === true;
    goal.acceptance = Array.isArray(raw.acceptance) ? raw.acceptance.slice(0, 24).flatMap((item) => goalText(item, 1000) ? [goalText(item, 1000)!] : []) : [];
    goal.verificationRequirement = requirements.includes(raw.verificationRequirement as GoalVerificationRequirement) ? raw.verificationRequirement as GoalVerificationRequirement : "delivery";
    const verification = normalizeGoalVerification(raw.verification);
    const nextStep = normalizeGoalNextStep(raw.nextStep); const waiting = normalizeGoalWaiting(raw.waiting);
    const source = normalizeGoalSource(raw.source);
    if (verification) goal.verification = verification;
    if (nextStep) goal.nextStep = nextStep;
    if (waiting) goal.waiting = waiting;
    if (source) goal.source = source;
    const budget = object(raw.budget); const rounds = count(budget?.maxRounds, GOAL_DEFAULT_MAX_ROUNDS);
    goal.budget = { maxRounds: rounds >= 1 && rounds <= GOAL_MAX_ROUNDS ? rounds : GOAL_DEFAULT_MAX_ROUNDS,
      maxTokens: budget?.maxTokens === null || budget?.maxTokens === undefined ? null : Math.max(1, count(budget.maxTokens, 1)) };
    const usage = object(raw.usage); const runs = object(raw.runUsage);
    let summed = 0; let completed = 0;
    for (const [id, entry] of Object.entries(runs ?? {}).slice(0, GOAL_MAX_ROUNDS)) {
      if (!/^[\w.:-]{1,160}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) continue;
      const row = object(entry); if (!row) continue;
      const tokens = count(row.totalTokens); const outcome = ["answered", "interrupted", "error"].includes(String(row.outcome)) ? row.outcome as GoalRunUsage["outcome"] : undefined;
      goal.runUsage[id] = { totalTokens: tokens, ...(outcome ? { outcome } : {}) };
      summed = Math.min(Number.MAX_SAFE_INTEGER, summed + tokens); if (outcome === "answered") completed++;
    }
    goal.usage = { totalTokens: Math.max(count(usage?.totalTokens), summed), roundsStarted: Math.max(count(usage?.roundsStarted), Object.keys(goal.runUsage).length), roundsCompleted: Math.max(count(usage?.roundsCompleted), completed) };
    const continuation = object(raw.continuation);
    const state = continuation?.state;
    goal.continuation = { state: state === "scheduled" || state === "running" ? state : "idle", revision: Math.max(1, count(continuation?.revision, goal.revision)),
      ...(goalText(continuation?.scheduledAt, 80) ? { scheduledAt: goalText(continuation?.scheduledAt, 80)! } : {}),
      ...(goalText(continuation?.runId, 160) ? { runId: goalText(continuation?.runId, 160)! } : {}) };
    if (goal.continuation.state === "running" || goal.continuation.runId) {
      if (goal.status !== "completed" && goal.status !== "cancelled") {
        goal.status = "paused"; goal.waiting = { kind: "restart", reason: "上次运行在服务重启前未完成；请核对 checkpoint 后明确恢复" }; goal.pausedAt = new Date().toISOString();
      }
      goal.revision++; goal.continuation = { state: "idle", revision: goal.revision };
    } else if (goal.continuation.state === "scheduled" && (goal.status !== "active" || !goal.autoContinue || !goal.source)) {
      goal.continuation = { state: "idle", revision: goal.revision };
    }
  }
  return goal;
}
