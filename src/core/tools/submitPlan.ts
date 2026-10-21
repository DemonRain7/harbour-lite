import type { ToolDef } from "../../types";
import { recordSubmittedPlan, type SubmittedPlan } from "../submittedPlan";
import { publishSubmittedPlanProgress } from "../executionProgress";

/**
 * submit_plan —— orchestrator 把执行计划以【结构化】形式交出来，前端渲染成
 * 可视 todo 清单（像 Codex 那样），鼠标悬停看某一步的细节。
 *
 * 【为什么要这个工具】orchestrator 原本只把计划写在自由文本回复里，前端想显示成
 * todo 就只能去正则解析编号列表 —— 模型换个写法就崩，纯脆。让它直接给结构化数据。
 *
 * 同一份已提交计划既广播给前端，也随子任务回执交给调用方。即使最终叙述被
 * 预算/步数限制截断，也不会丢掉已确认的计划；计划本身不代表任务已执行。
 *
 * 【只读】它不产生任何副作用，符合 orchestrator「只规划不执行」的红线。
 */

const MAX_STEPS = 20;

/** 宽容解析一步：接受纯字符串，也接受各种键名的对象。 */
function normalizeStep(o: unknown, i: number): { n: number; title: string; agent?: string; detail?: string; capabilities?: string[]; parallel?: boolean } | null {
  if (typeof o === "string" || typeof o === "number") {
    const t = String(o).trim();
    return t ? { n: i + 1, title: t } : null;
  }
  if (o && typeof o === "object") {
    const v = o as Record<string, unknown>;
    const title = String(v.title ?? v.step ?? v.name ?? v.text ?? v.what ?? v.summary ?? "").trim();
    if (!title) return null;
    const agent = String(v.agent ?? v.who ?? v.assignee ?? "").trim();
    const detail = String(v.detail ?? v.description ?? v.desc ?? v.note ?? v.output ?? "").trim();
    const capabilities = normalizeList(v.capabilities ?? v.uses ?? v.skills ?? v.mcp);
    const parallel = v.parallel === true || v.mode === "parallel";
    return {
      n: i + 1,
      title,
      ...(agent ? { agent } : {}),
      ...(detail ? { detail } : {}),
      ...(capabilities.length ? { capabilities } : {}),
      ...(parallel ? { parallel } : {}),
    };
  }
  return null;
}

/** 宽容解析字符串列表（风险 / 待澄清）。 */
function normalizeList(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  return arr
    .map((x) => (typeof x === "string" || typeof x === "number" ? String(x).trim() : x && typeof x === "object" ? String((x as Record<string, unknown>).text ?? (x as Record<string, unknown>).title ?? "").trim() : ""))
    .filter(Boolean)
    .slice(0, 10);
}

export const submitPlanTool: ToolDef = {
  name: "submit_plan",
  description:
    "把你规划好的执行计划以结构化形式提交一次，Web 面板会渲染成可视 todo 清单。" +
    "同一份计划会随子任务回执交给 Main；无需在最后回复重复全文，可简要补充风险。提交计划不代表已经执行。",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      goal: { type: "string", description: "一句话复述你理解的用户目标" },
      steps: {
        type: "array",
        description:
          `有序步骤，最多 ${MAX_STEPS} 条。每步可以只给一句话字符串，` +
          `也可以给对象 {"title":"这步干什么","agent":"派给谁","detail":"产出什么/交给谁","parallel":true}。`,
        items: {
          type: ["string", "object"],
          properties: {
            title: { type: "string", description: "这一步做什么（短句）" },
            agent: { type: "string", description: "派给哪个 agent（Main 自己执行就写 self）" },
            detail: { type: "string", description: "产出什么、交给下一步谁（悬停时显示）" },
            capabilities: {
              type: "array",
              description: "可选：会影响分工或交接的能力建议，如 skill:leader、mcp:chrome_devtools；不要罗列普通底层调用",
              items: { type: "string" },
            },
            parallel: { type: "boolean", description: "是否可与上一步并行" },
          },
        },
      },
      risks: { type: "array", description: "风险 / 不可逆动作 / 易失败环节", items: { type: "string" } },
      clarifications: { type: "array", description: "需要用户澄清的点", items: { type: "string" } },
    },
    required: ["goal", "steps"],
  },
  async execute(args, ctx) {
    const goal = String(args.goal ?? "").trim();
    const rawSteps: unknown[] = Array.isArray(args.steps)
      ? args.steps
      : args.steps && typeof args.steps === "object"
        ? Object.values(args.steps as Record<string, unknown>)
        : [];
    const steps = rawSteps
      .map(normalizeStep)
      .filter((s): s is NonNullable<ReturnType<typeof normalizeStep>> => s !== null)
      .slice(0, MAX_STEPS)
      .map((s, i) => ({ ...s, n: i + 1 })); // 过滤后重新编号，避免断号

    if (!goal || steps.length === 0) {
      throw new Error(
        'submit_plan: 需要 goal 和至少一步 steps。steps 可以是字符串数组（如 ["先查花名册","再派 trajectory-checker"]）' +
          '或对象数组（如 [{"title":"查花名册","agent":"self"}]）。'
      );
    }

    const plan: SubmittedPlan = {
      goal,
      steps,
      risks: normalizeList(args.risks),
      clarifications: normalizeList(args.clarifications),
      by: ctx.agent?.name ?? "orchestrator",
      at: new Date().toISOString(),
    };
    // 走 logger → LogBroadcaster → /ws，前端按 msg==="plan:submitted" 取 obj.plan 渲染。
    // 复用既有 trace 管道，不新开连接、不加注册表。
    publishSubmittedPlanProgress(ctx, plan);
    ctx.logger.info({ plan }, "plan:submitted");
    recordSubmittedPlan(ctx.execution, plan);

    return {
      ok: true,
      steps: steps.length,
      plan,
      note: "计划已提交并在 Web 面板显示；同一份计划会随子任务回执交给 Main，无需在最终回复重复全文。计划是建议，不代表步骤已执行。",
    };
  },
  onReplay(result, _args, ctx) {
    // Only a checkpoint-confirmed tool result can restore this capture. Old
    // receipts lacking the plan are not reconstructed from model arguments.
    if (!result || typeof result !== "object") return;
    const row = result as { ok?: unknown; plan?: SubmittedPlan };
    if (row.ok === true && row.plan?.by === ctx.agent.name && Array.isArray(row.plan.steps)) {
      publishSubmittedPlanProgress(ctx, row.plan);
      recordSubmittedPlan(ctx.execution, row.plan);
    }
  },
};
