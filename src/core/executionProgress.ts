import { randomUUID } from "node:crypto";
import type { ToolContext } from "../types";
import type { SubmittedPlan } from "./submittedPlan";

/** Presentation only. Never used as evidence of execution, billing or permission. */
export type ProgressStatus = "pending" | "in_progress" | "completed" | "blocked" | "cancelled";
export interface ExecutionProgress {
  id: string;
  scope: "task" | "skill" | "workflow";
  title: string;
  source?: string;
  owner: string;
  revision: number;
  steps: Array<{ n: number; title: string; status: ProgressStatus; detail?: string; agent?: string }>;
}
export interface ExecutionProgressStore {
  owner: string;
  plans: Map<string, ExecutionProgress>;
}
export function createExecutionProgressStore(owner: string): ExecutionProgressStore {
  return { owner, plans: new Map() };
}

export function progressStore(ctx: ToolContext): ExecutionProgressStore {
  ctx.execution ??= {};
  return ctx.execution.progress ??= createExecutionProgressStore(ctx.agent.name);
}

export function publishProgress(ctx: ToolContext, progress: ExecutionProgress): void {
  const store = progressStore(ctx);
  if (!store.plans.has(progress.id) && store.plans.size >= 16) {
    throw new Error("本轮最多 16 份进度清单；请更新已有清单，不要为每次工具调用新建。");
  }
  store.plans.set(progress.id, structuredClone(progress));
  ctx.logger.info({ progress }, "progress:updated");
}

/** Orchestrator hands over one plan. Returning from the planner completes no task steps. */
export function publishSubmittedPlanProgress(ctx: ToolContext, plan: SubmittedPlan): void {
  plan.id ??= `plan-${randomUUID()}`;
  const store = progressStore(ctx);
  if (store.plans.has(plan.id)) return; // checkpoint replay must not reset subsequent updates
  publishProgress(ctx, {
    id: plan.id, scope: "task", title: plan.goal, owner: store.owner, revision: 1,
    steps: plan.steps.map(step => ({ n: step.n, title: step.title, status: "pending",
      ...(step.detail ? { detail: step.detail } : {}), ...(step.agent ? { agent: step.agent } : {}) })),
  });
}

/** Only a confirmed tool receipt, never arbitrary model prose, can restore display state. */
export function restoreProgress(ctx: ToolContext, progress: ExecutionProgress): void {
  const existing = progressStore(ctx).plans.get(progress.id);
  if (!existing || existing.revision < progress.revision) publishProgress(ctx, progress);
}
