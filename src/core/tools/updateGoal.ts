import type { SessionGoal } from "../sessionStore";
import type { ToolDef } from "../../types";
import { seedGoalVerification, verifyGoalCompletion, type GoalVerification, type GoalVerificationRequirement } from "../goalVerification";

const GOAL_CONTEXT_KEY = "harbour:goal-context";
const GOAL_UPDATE_KEY = "harbour:goal-update";

export interface GoalUpdateIntent {
  goalId: string;
  status: "active" | "completed" | "blocked";
  /** 本轮面向用户的交付正文；不是内部进度摘要，也不进入 checkpoint。 */
  reply: string;
  progress?: string;
  nextStep?: { action: string; reason?: string };
  waiting?: { kind: "user" | "authorization" | "external" | "budget" | "interrupted" | "restart"; reason: string };
  verification?: GoalVerification;
}

/** runtime 在一次 GOAL run 开始前注入；不跨轮、不进 checkpoint。 */
export function seedGoalRunState(runState: Map<string, unknown>, goal: SessionGoal): void {
  runState.set(GOAL_CONTEXT_KEY, { id: goal.id, objective: goal.objective });
  seedGoalVerification(runState, { goalId: goal.id,
    requirement: (goal as SessionGoal & { verificationRequirement?: GoalVerificationRequirement }).verificationRequirement ?? "delivery" });
}

export function goalUpdateIntent(runState: Map<string, unknown>): GoalUpdateIntent | undefined {
  const value = runState.get(GOAL_UPDATE_KEY);
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<GoalUpdateIntent>;
  if (typeof raw.goalId !== "string" || typeof raw.reply !== "string" || !raw.reply.trim() ||
      (raw.status !== "active" && raw.status !== "completed" && raw.status !== "blocked")) return undefined;
  return {
    goalId: raw.goalId,
    status: raw.status,
    reply: raw.reply,
    ...(typeof raw.progress === "string" && raw.progress.trim() ? { progress: raw.progress.trim() } : {}),
    ...(raw.nextStep ? { nextStep: { ...raw.nextStep } } : {}),
    ...(raw.waiting ? { waiting: { ...raw.waiting } } : {}),
    ...(raw.verification ? { verification: { ...raw.verification, evidence: raw.verification.evidence.map(ref => ({ ...ref })) } } : {}),
  };
}

/** 状态提交之后又执行工具或接收用户补充，旧交付已过期；必须基于新输入/结果重新收尾。 */
export function invalidateGoalDelivery(runState: Map<string, unknown>, tool: string): void {
  if (tool === "update_goal" || tool === "mcp__harbour_tools__update_goal") return;
  runState.delete(GOAL_UPDATE_KEY);
}

/** 只拦明确的单句第三人称备忘，不用关键词判断业务内容或擅自改写答复。 */
function isDeliveryMemo(reply: string): boolean {
  if (reply.includes("\n")) return false;
  return /^(?:已(?:经)?向\s*(?:用户(?:大人)?|用户|主人)\s*(?:说明|告知|汇报)|已(?:经)?(?:告知|回复)(?:用户|主人|用户)|(?:I have|I've) (?:already )?(?:informed|told|notified) (?:the user|用户))/iu.test(reply);
}

/**
 * GOAL 生命周期工具只提交“本轮成功后的意图”。真正的 SessionStore 写入由 runtime 在最终
 * 回答加入 SessionStore 后提交；模型/工具中途失败不会把目标误标为完成。
 */
export const updateGoalTool: ToolDef = {
  name: "update_goal",
  description:
    "仅在 GOAL 模式中使用。active 提交下一步；completed 提交完成证据引用；确实等待用户、外部状态或授权时 blocked。证据规则由用户设置，不能降级。" +
    "仅在最后调用，并用 reply 提交本轮完整用户答复（逐项回答最新请求与阻塞原因），progress 仅为内部摘要。不要写‘已向用户说明’备忘。",
  readOnly: false,
  checkpoint: false,
  parameters: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["active", "completed", "blocked"],
        description: "active=仍有下一步；completed=目标完成并提供要求的证据；blocked=等待明确外部条件",
      },
      progress: {
        type: "string",
        description: "简短证据或阻塞原因；不要写 thinking、密钥或整段 trace",
      },
      reply: {
        type: "string",
        minLength: 1,
        description: "最终面向用户的完整答复，不是任务备忘。覆盖本轮每个要求；未完成的说明具体证据和阻塞。原图交付由运行时保序补齐。",
      },
      nextStep: { type: "object", properties: {
        action: { type: "string", maxLength: 800 }, reason: { type: "string", maxLength: 800 },
      }, required: ["action"], additionalProperties: false },
      waiting: { type: "object", properties: {
        kind: { type: "string", enum: ["user", "authorization", "external", "budget", "interrupted", "restart"] },
        reason: { type: "string", maxLength: 800 },
      }, required: ["kind", "reason"], additionalProperties: false },
      evidence: { type: "array", maxItems: 8, description: "completed 的已记录工具/文件ref；主观交付可提供summary。文件变更不代表测试通过；用户验收不能自述。",
        items: { type: "object", properties: {
          kind: { type: "string", enum: ["tool", "file", "subjective"] },
          ref: { type: "string", maxLength: 160 }, summary: { type: "string", maxLength: 800 },
        }, required: ["kind"], additionalProperties: false } },
    },
    required: ["status", "reply"],
  },
  async execute(args, ctx) {
    const goal = ctx.runState?.get(GOAL_CONTEXT_KEY);
    if (!goal || typeof goal !== "object" || typeof (goal as { id?: unknown }).id !== "string") {
      throw new Error("update_goal 只在 Harbour GOAL 模式的顶层会话中可用");
    }
    if (ctx.runState?.has(GOAL_UPDATE_KEY)) {
      throw new Error("本轮已经提交过一次 GOAL 状态；请保持第一次判断并直接收尾");
    }
    const status = String(args.status || "");
    if (status !== "active" && status !== "completed" && status !== "blocked") {
      throw new Error("status 只能是 active、completed 或 blocked");
    }
    const progress = String(args.progress || "").replace(/\r\n/g, "\n").trim().slice(0, 2_000);
    const reply = typeof args.reply === "string" ? args.reply.replace(/\r\n/g, "\n").trim() : "";
    if (!reply || isDeliveryMemo(reply)) {
      return {
        accepted: false,
        status: "needs_input",
        reasonCode: reply ? "USER_REPLY_NOT_DELIVERY" : "USER_REPLY_REQUIRED",
        instruction: "GOAL 状态尚未提交。请将本轮各项要求的实际结果或具体阻塞写入 reply，再调用；progress/‘已向用户说明’不能替代答复。无需为此询问用户。",
      };
    }
    const bounded = (value: unknown) => typeof value === "string" ? value.trim().slice(0, 800) : "";
    const next = args.nextStep && typeof args.nextStep === "object" && !Array.isArray(args.nextStep)
      ? args.nextStep as Record<string, unknown> : undefined;
    const wait = args.waiting && typeof args.waiting === "object" && !Array.isArray(args.waiting)
      ? args.waiting as Record<string, unknown> : undefined;
    const action = bounded(next?.action);
    const waitReason = bounded(wait?.reason) || (status === "blocked" ? bounded(progress) : "");
    const waitKind = wait?.kind ?? "user";
    if (status === "active" && !action || status === "blocked" && (!waitReason ||
      !["user", "authorization", "external", "budget", "interrupted", "restart"].includes(String(waitKind)))) {
      return { accepted: false, status: "needs_input", reasonCode: status === "active" ? "GOAL_NEXT_STEP_REQUIRED" : "GOAL_WAITING_REASON_REQUIRED",
        instruction: "状态尚未暂存。active 请提供明确 nextStep.action；blocked 请提供 waiting.kind/reason（旧 progress 可作原因）。" };
    }
    const check = status === "completed" ? verifyGoalCompletion(ctx.runState!, (goal as { id: string }).id, args.evidence) : undefined;
    if (check && !check.accepted) {
      return { accepted: false, status: "needs_evidence", reasonCode: check.reasonCode, verification: check.verification,
        availableEvidence: check.availableEvidence,
        instruction: "完成状态未暂存。引用匹配的真实证据；已有记录不足则用 active 明确下一步，或 blocked 等待用户验收。不要重复无变化的完成申请，也不要为校验擅自执行命令。" };
    }
    const intent: GoalUpdateIntent = {
      goalId: (goal as { id: string }).id,
      status,
      reply,
      ...(progress ? { progress } : {}),
      ...(status === "active" ? { nextStep: { action, ...(bounded(next?.reason) ? { reason: bounded(next?.reason) } : {}) } } : {}),
      ...(status === "blocked" ? { waiting: { kind: waitKind as NonNullable<GoalUpdateIntent["waiting"]>["kind"], reason: waitReason } } : {}),
      ...(check ? { verification: check.verification } : {}),
    };
    ctx.runState?.set(GOAL_UPDATE_KEY, intent);
    ctx.logger.info({ goalId: intent.goalId, status }, "goal:update-requested");
    return {
      accepted: true,
      status,
      note: "reply 已暂存为本轮交付正文（尚未发送）；成功收尾才发送并提交状态。请直接结束，不再执行其它工具。",
    };
  },
};
