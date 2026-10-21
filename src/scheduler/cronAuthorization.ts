import { createHash, randomUUID } from "node:crypto";
import type { ActorIdentity, RunSource } from "../types";
import { isInteractiveOwner, systemActor } from "../core/identity";
import type { CronJob } from "./cron";

export type CronExecutionIdentity = "system" | "owner";

/** Local approval of an exact definition, not a portable identity supplied by a prompt. */
export interface CronOwnerAuthorization {
  version: 1;
  id: string;
  definitionHash: string;
  grantedAt: string;
  grantedBy: Pick<ActorIdentity, "role" | "platform" | "id">;
}

export class CronAuthorizationError extends Error {
  readonly code = "CRON_AUTHORIZATION_REQUIRED";
  override readonly name = "CronAuthorizationError";
}

export function cronDefinitionHash(job: CronJob): string {
  return createHash("sha256").update(JSON.stringify([
    job.id, job.builtin ?? null, job.agent, job.input, job.schedule, job.timeZone,
    job.taskType, job.sessionMode, job.executionIdentity ?? "system",
    job.delivery ? [job.delivery.channel, job.delivery.accountKey, job.delivery.scope, job.delivery.targetId] : null,
  ])).digest("hex");
}

export function parseCronOwnerAuthorization(value: unknown): CronOwnerAuthorization | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const grant = value as Partial<CronOwnerAuthorization>;
  const actor = grant.grantedBy;
  if (grant.version !== 1 || typeof grant.id !== "string" || !/^[\da-f-]{36}$/.test(grant.id)
    || typeof grant.definitionHash !== "string" || !/^[\da-f]{64}$/.test(grant.definitionHash)
    || typeof grant.grantedAt !== "string" || !Number.isFinite(Date.parse(grant.grantedAt))
    || actor?.role !== "owner" || typeof actor.id !== "string" || !actor.id.trim()
    || !["web", "qq", "discord"].includes(actor.platform)) return;
  return { version: 1, id: grant.id, definitionHash: grant.definitionHash, grantedAt: grant.grantedAt,
    grantedBy: { role: "owner", platform: actor.platform, id: actor.id } };
}

export function grantCronOwnerAuthorization(job: CronJob, source?: RunSource): CronOwnerAuthorization {
  if (job.builtin) throw new CronAuthorizationError("内建代码任务不能改为主人授权执行");
  if (!isInteractiveOwner(source) || !source?.actor?.id?.trim()
    || !["web", "qq", "discord"].includes(source.actor.platform)) {
    throw new CronAuthorizationError("只有已验证的主人交互会话可以授权定时任务；自动任务不能自行授权");
  }
  // Saving an unchanged authorized definition is idempotent, including a UI rename.
  if (hasCronOwnerAuthorization(job)) return parseCronOwnerAuthorization(job.ownerAuthorization)!;
  return { version: 1, id: randomUUID(), definitionHash: cronDefinitionHash(job),
    grantedAt: new Date().toISOString(), grantedBy: {
      role: "owner", platform: source.actor.platform, id: source.actor.id,
    } };
}

export function hasCronOwnerAuthorization(job: CronJob): boolean {
  const grant = parseCronOwnerAuthorization(job.ownerAuthorization);
  return !job.builtin && job.executionIdentity === "owner" && !!grant
    && grant.definitionHash === cronDefinitionHash(job);
}

export function assertCronAuthorization(job: CronJob): void {
  if (job.executionIdentity === "owner" && !hasCronOwnerAuthorization(job)) {
    throw new CronAuthorizationError("此定时任务缺少当前后端的有效主人授权（配置已变更或来自另一台设备）；请在编辑中选择「主人授权执行」并保存。未启动模型或外部操作。");
  }
}

/** Keep automation and its job scope visible, never impersonate the QQ delivery recipient. */
export function cronRunSource(job: CronJob, runId: string): RunSource {
  assertCronAuthorization(job);
  return { channel: "cron", key: `cron:${job.id}`, runId,
    actor: job.executionIdentity === "owner"
      ? { role: "owner", platform: "cron", id: job.id, displayName: "主人授权定时任务" }
      : systemActor("cron", job.id) };
}
