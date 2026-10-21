import type { ToolContext } from "../types";

const MUTATING_TOOL_STARTED_KEY = "runtime:mutating-tool-started";

export interface MutatingToolActivity {
  tool: string;
  startedAt: string;
}

/**
 * 记录本轮已经进入过非只读工具。模型 backend 若在这之后断流，不能换端点从头
 * 重跑整段 agentic loop；否则网页提交、发消息、写文件等副作用会被重复执行。
 */
export function markMutatingToolStarted(ctx: ToolContext, tool: string): void {
  ctx.runState ??= new Map<string, unknown>();
  if (ctx.runState.has(MUTATING_TOOL_STARTED_KEY)) return;
  ctx.runState.set(MUTATING_TOOL_STARTED_KEY, {
    tool,
    startedAt: new Date().toISOString(),
  } satisfies MutatingToolActivity);
}

export function mutatingToolActivity(ctx: ToolContext | undefined): MutatingToolActivity | null {
  const value = ctx?.runState?.get(MUTATING_TOOL_STARTED_KEY);
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<MutatingToolActivity>;
  return typeof row.tool === "string" && typeof row.startedAt === "string"
    ? { tool: row.tool, startedAt: row.startedAt }
    : null;
}
