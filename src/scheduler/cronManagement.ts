import { z } from "zod";
import { Cron } from "croner";
import type { SessionStore } from "../core/sessionStore";
import { normalizeTimeZone } from "../core/timeZone";
import { deliveryFromSession, type CronDelivery } from "./cronDelivery";
import type { CronCreateInput, CronUpdateInput } from "./cron";

export interface CronManagementContext {
  sessions: Pick<SessionStore, "get" | "listForAgent"> | null;
  agentNames: string[];
  activeQQBotKeys: string[];
  activeDiscordBotKeys: string[];
}

export class CronRequestError extends Error {
  override readonly name = "CronRequestError";
}

function available(delivery: CronDelivery, ctx: CronManagementContext): boolean {
  return (delivery.channel === "qq" ? ctx.activeQQBotKeys : ctx.activeDiscordBotKeys).includes(delivery.accountKey);
}

/** Owner-authenticated surfaces share the same destination picker; metadata grants no permissions. */
export function listCronDeliveryTargets(ctx: CronManagementContext) {
  const seen = new Set<string>();
  const targets: Array<CronDelivery & { sessionId: string; available: boolean }> = [];
  for (const agent of ctx.agentNames) for (const session of ctx.sessions?.listForAgent(agent) ?? []) {
    try {
      const delivery = deliveryFromSession(session);
      const key = JSON.stringify([delivery.channel, delivery.accountKey, delivery.scope, delivery.targetId]);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ ...delivery, sessionId: session.id, available: available(delivery, ctx) });
    } catch { /* Historical/non-owner/incomplete sessions are not selectable destinations. */ }
  }
  return targets;
}

export function resolveCronDeliverySession(value: string, ctx: CronManagementContext): CronDelivery {
  const session = ctx.sessions?.get(value);
  if (!session) throw new CronRequestError("找不到投递会话；先在目标 QQ/Discord 会话与 Bot 聊天，再选择已知会话。");
  let delivery: CronDelivery;
  try { delivery = deliveryFromSession(session); }
  catch (error) { throw new CronRequestError((error as Error).message); }
  if (!available(delivery, ctx)) throw new CronRequestError(`投递 Bot「${delivery.accountKey}」未连接，不能新增或改绑此目标；既有目标不会改投其它 Bot。`);
  return delivery;
}

const fields = {
  name: z.string().trim().max(200).optional(),
  agent: z.string().trim().min(1).max(128).optional(),
  input: z.string().trim().min(1).max(100_000).optional(),
  schedule: z.string().trim().min(1).max(128).optional(),
  timeZone: z.string().trim().min(1).max(100).optional(),
  taskType: z.string().trim().min(1).max(128).optional(),
  sessionMode: z.enum(["fresh", "continue"]).optional(),
  executionIdentity: z.enum(["system", "owner"]).optional(),
  deliverySessionId: z.string().trim().min(1).max(128).nullable().optional(),
};
const createSchema = z.object(fields).strict();
const updateSchema = z.object({ ...fields, enabled: z.boolean().optional() }).strict();

export function parseCronManagementInput(body: unknown, ctx: CronManagementContext, create: true): CronCreateInput;
export function parseCronManagementInput(body: unknown, ctx: CronManagementContext, create: false): CronUpdateInput;
export function parseCronManagementInput(body: unknown, ctx: CronManagementContext, create: boolean): CronCreateInput | CronUpdateInput {
  const parsed = (create ? createSchema : updateSchema).safeParse(body);
  if (!parsed.success) throw new CronRequestError(`定时任务参数无效：${parsed.error.issues.map(issue => `${issue.path.join(".") || "input"}: ${issue.message}`).join("；")}`);
  const { deliverySessionId, ...input } = parsed.data;
  if (create && (!input.agent || !input.input || !input.schedule)) throw new CronRequestError("agent/input/schedule 必填");
  if (input.agent && !ctx.agentNames.includes(input.agent)) throw new CronRequestError(`未知 Agent：${input.agent}`);
  try {
    if (input.timeZone !== undefined) input.timeZone = normalizeTimeZone(input.timeZone);
    if (input.schedule !== undefined) new Cron(input.schedule, { paused: true, ...(input.timeZone ? { timezone: input.timeZone } : {}) }).stop();
  } catch { throw new CronRequestError("Cron 表达式或 IANA 时区无效"); }
  // No arbitrary target strings, stale reply tokens, or implicit 'default' Bot routing.
  const delivery = deliverySessionId === undefined ? undefined
    : deliverySessionId === null ? null : resolveCronDeliverySession(deliverySessionId, ctx);
  return { ...input, ...(delivery !== undefined && !(create && delivery === null) ? { delivery } : {}) } as CronCreateInput | CronUpdateInput;
}
