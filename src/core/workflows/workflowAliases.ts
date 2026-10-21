import type { ToolContext } from "../../types";

/** Compatibility only: old jobs/tool calls keep their IDs; no second catalog or implementation. */
export const NOVELAI_WORKFLOW_ALIASES: Record<string, string> = {
  "comic-generation": "references/comic-execution.md",
  "novelai-image-set": "references/image-execution.md",
};

/** A validator's recovery hint may name an old Job; it is not an execution binding. */
export function hasWorkflowExecution(result: Record<string, unknown>): boolean {
  if (result.retrySafety === "uncertain" || ["started", "unknown", "running"].includes(String(result.status))) return true;
  return result.executionStarted !== false && Boolean(result.jobId ||
    ["completed", "blocked", "paused"].includes(String(result.status)));
}

/** Old and new names refer to the same durable operation, not fresh authority.
 * Keep snapshot IDs in their original namespace; only discovery/locks are shared. */
export function workflowPersistenceNames(name: string, ctx: ToolContext): string[] {
  if (!ctx.agent.workflows?.some(workflow => workflow.name === "novelai-generation") ||
      !["novelai-generation", ...Object.keys(NOVELAI_WORKFLOW_ALIASES)].includes(name)) return [name];
  return ["novelai-generation", ...Object.keys(NOVELAI_WORKFLOW_ALIASES).filter(alias =>
    !(ctx.agent.name === "comic_generator" && alias === "novelai-image-set") &&
    !(ctx.agent.name === "novelai_artist" && alias === "comic-generation"))];
}

export function workflowContextFor(name: string, ctx: ToolContext): ToolContext {
  if (ctx.agent.workflows?.some(workflow => workflow.name === name)) return ctx;
  if (!Object.hasOwn(NOVELAI_WORKFLOW_ALIASES, name)) return ctx;
  if ((ctx.agent.name === "comic_generator" && name === "novelai-image-set") ||
    (ctx.agent.name === "novelai_artist" && name === "comic-generation")) return ctx;
  const unified = ctx.agent.workflows?.find(workflow => workflow.name === "novelai-generation");
  if (!unified) return ctx;
  return { ...ctx, agent: { ...ctx.agent, workflows: [...ctx.agent.workflows!, { ...unified, name, executor: name }] } };
}
