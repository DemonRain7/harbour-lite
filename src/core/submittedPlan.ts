import type { RunExecutionContext } from "../types";

export interface SubmittedPlan {
  id?: string;
  goal: string;
  steps: Array<{ n: number; title: string; agent?: string; detail?: string; capabilities?: string[]; parallel?: boolean }>;
  risks: string[];
  clarifications: string[];
  by: string;
  at: string;
}

type RunOutcome = "completed" | "incomplete" | "failed" | "interrupted";
interface PlanCapture {
  agent: string;
  closed: boolean;
  plan?: SubmittedPlan;
  outcome?: RunOutcome;
}
// Enumerable symbol survives trusted execution-context spreads, but not JSON/model
// arguments. Each dispatch replaces its inherited capture, isolating nested calls.
const CAPTURE = Symbol("submitted-plan-capture");
const captures = new WeakSet<PlanCapture>();
type PlanExecution = RunExecutionContext & { [CAPTURE]?: PlanCapture };

function captureFor(execution: RunExecutionContext | undefined, agent: string): PlanCapture | undefined {
  const capture = (execution as PlanExecution | undefined)?.[CAPTURE];
  return capture && captures.has(capture) && !capture.closed && capture.agent === agent ? capture : undefined;
}

export function beginSubmittedPlanCapture(execution: RunExecutionContext | undefined, agent: string) {
  const capture: PlanCapture = { agent, closed: false };
  captures.add(capture);
  return {
    execution: { ...execution, [CAPTURE]: capture } as RunExecutionContext,
    finish() {
      capture.closed = true;
      return capture.plan ? { plan: structuredClone(capture.plan), outcome: capture.outcome ?? "incomplete" as RunOutcome } : undefined;
    },
  };
}

/** A confirmed submit_plan call records a proposal, never proof of task execution. */
export function recordSubmittedPlan(execution: RunExecutionContext | undefined, plan: SubmittedPlan): void {
  const capture = captureFor(execution, plan.by);
  if (capture) capture.plan = structuredClone(plan);
}

/** Called by agentLoop, not inferred from the model's final prose. */
export function recordSubmittedPlanRunOutcome(execution: RunExecutionContext | undefined, agent: string, outcome: string): void {
  const capture = captureFor(execution, agent);
  if (capture) capture.outcome = outcome === "completed" || outcome === "failed" || outcome === "interrupted" ? outcome : "incomplete";
}
