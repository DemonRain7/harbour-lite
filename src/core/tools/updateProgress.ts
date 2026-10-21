import { randomUUID } from "node:crypto";
import type { ToolDef } from "../../types";
import { progressStore, publishProgress, restoreProgress, type ExecutionProgress, type ProgressStatus } from "../executionProgress";

const statuses: ProgressStatus[] = ["pending", "in_progress", "completed", "blocked", "cancelled"];
function text(value: unknown, max: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${field} 需要 1–${max} 字的文字`);
  return value.trim();
}

export const updateProgressTool: ToolDef = {
  name: "update_progress",
  description: "更新可视待办（仅展示，不执行任务）。Orchestrator 返回 plan.id 后用 planId+changes 按阶段批量更新，不复述计划。复杂 Skill/Workflow 可建独立局部清单；简单问答不用。完成必须依据实际回执，派发不等于完成。",
  readOnly: true,
  parameters: {
    type: "object", additionalProperties: false,
    properties: {
      planId: { type: "string", description: "更新已有清单的 id（含 submit_plan 返回的 plan.id）" },
      changes: { type: "array", minItems: 1, maxItems: 20, items: {
        type: "object", additionalProperties: false, properties: {
          n: { type: "integer", minimum: 1, maximum: 20 }, status: { type: "string", enum: statuses },
        }, required: ["n", "status"],
      } },
      scope: { type: "string", enum: ["task", "skill", "workflow"], description: "仅新建时：总任务或局部能力清单；默认 task" },
      source: { type: "string", description: "局部清单所属的已挂载 Skill/Workflow 名称" },
      title: { type: "string", maxLength: 160, description: "仅新建时：目标短句" },
      steps: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", maxLength: 160 }, description: "仅新建时：待办短句，不复制工具指令或详细正文" },
    },
  },
  async execute(args, ctx) {
    const store = progressStore(ctx);
    let progress: ExecutionProgress;
    if (args.planId !== undefined) {
      if (["scope", "source", "title", "steps"].some(key => args[key] !== undefined)) throw new Error("更新只传 planId 和 changes；不得覆盖原清单");
      const existing = store.plans.get(text(args.planId, 100, "planId"));
      if (!existing) throw new Error("本轮未找到清单；续接新运行时请重新建立待办，不能引用其它运行的 id。");
      if (existing.owner !== ctx.agent.name) throw new Error("只能更新自己负责的清单；子任务不能改写 Main 总计划。");
      progress = structuredClone(existing);
      if (!Array.isArray(args.changes) || !args.changes.length || args.changes.length > 20) throw new Error("changes 需要 1–20 项");
      const seen = new Set<number>();
      for (const change of args.changes) {
        const n = change?.n;
        const step = progress.steps.find(item => item.n === n);
        if (!Number.isInteger(n) || !step || seen.has(n) || !statuses.includes(change?.status)) throw new Error("changes 包含未知步骤、重复编号或非法状态");
        seen.add(n);
        step.status = change.status;
      }
      progress.revision++;
    } else {
      if (args.changes !== undefined) throw new Error("新建时不传 changes；先建清单，再按阶段更新");
      const scope = (args.scope ?? "task") as ExecutionProgress["scope"];
      if (!["task", "skill", "workflow"].includes(scope)) throw new Error("未知进度范围");
      if (scope === "task" && store.owner !== ctx.agent.name) throw new Error("总计划由当前任务的 Main 维护；子任务只能维护自己的局部清单");
      let source: string | undefined;
      if (scope !== "task") {
        source = text(args.source, 100, "source");
        const mounted = scope === "skill" ? ctx.agent.skills : ctx.agent.workflows;
        if (!mounted?.some(item => item.name === source)) throw new Error("局部清单只能绑定当前 Agent 已挂载的能力");
      } else if (args.source !== undefined) throw new Error("总任务清单不绑定局部能力");
      if (!Array.isArray(args.steps) || !args.steps.length || args.steps.length > 20) throw new Error("steps 需要 1–20 项");
      progress = {
        id: `progress-${randomUUID()}`, scope, title: text(args.title, 160, "title"),
        ...(source ? { source } : {}), owner: ctx.agent.name, revision: 1,
        steps: args.steps.map((title, i) => ({ n: i + 1, title: text(title, 160, "step"), status: "pending" })),
      };
    }
    publishProgress(ctx, progress);
    // Updates return only a small delta. Confirmed checkpoint replay rebuilds the same snapshot.
    return { ok: true, planId: progress.id, completed: progress.steps.filter(step => step.status === "completed").length,
      total: progress.steps.length, revision: progress.revision,
      ...(args.planId === undefined ? { progress } : { changes: args.changes }) };
  },
  onReplay(result, _args, ctx) {
    const receipt = result as { ok?: boolean; progress?: ExecutionProgress; planId?: string; revision?: number;
      changes?: Array<{ n: number; status: ProgressStatus }> } | undefined;
    if (!receipt?.ok) return;
    if (receipt.progress?.owner === ctx.agent.name) restoreProgress(ctx, receipt.progress);
    else if (receipt.planId && Number.isInteger(receipt.revision) && Array.isArray(receipt.changes)) {
      const existing = progressStore(ctx).plans.get(receipt.planId);
      if (!existing || existing.owner !== ctx.agent.name || existing.revision >= receipt.revision!) return;
      const next = structuredClone(existing);
      for (const change of receipt.changes) {
        const step = next.steps.find(item => item.n === change.n);
        if (!step || !statuses.includes(change.status)) return;
        step.status = change.status;
      }
      next.revision = receipt.revision!;
      restoreProgress(ctx, next);
    }
  },
};
