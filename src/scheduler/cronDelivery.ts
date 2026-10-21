import type { DiscordChannel } from "../channels/discord";
import { sendOutgoingSegments } from "../channels/outgoing";
import { encodeQQTarget, type QQChannel } from "../channels/qq";
import { normalizeQQOpenid } from "../channels/qqBindings";

/** A frozen transport address, not an execution identity or a reply-message token. */
export interface CronDelivery {
  channel: "qq" | "discord";
  accountKey: string;
  targetId: string;
  scope: "dm" | "group" | "guild";
  label: string;
}

/** Only thrown when this delivery is known not to have reached a transport. */
export class CronDeliveryRejectedError extends Error {
  override readonly name = "CronDeliveryRejectedError";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new CronDeliveryRejectedError("定时投递目标字段无效");
  }
  return value.trim();
}

export function normalizeCronDelivery(value: unknown): CronDelivery {
  const input = record(value);
  if (!input || Object.keys(input).some(key => !["channel", "accountKey", "targetId", "scope", "label"].includes(key))) {
    throw new CronDeliveryRejectedError("定时投递目标无效；不能保存回复消息 ID 或任意渠道参数");
  }
  const channel = input.channel;
  if (channel !== "qq" && channel !== "discord") throw new CronDeliveryRejectedError("定时投递仅支持 QQ 或 Discord");
  const accountKey = boundedText(input.accountKey, 32);
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(accountKey)) throw new CronDeliveryRejectedError("定时投递 Bot 标识无效");
  const scope = input.scope;
  if (scope !== "dm" && !(channel === "qq" && scope === "group") && !(channel === "discord" && scope === "guild")) {
    throw new CronDeliveryRejectedError("定时投递场景与渠道不匹配");
  }
  let targetId = boundedText(input.targetId, 256);
  // SDK paths interpolate this identifier. Do not accept URLs or encoded
  // path/query separators. Identity must come from the trusted selection boundary.
  if (channel === "qq") {
    if (!/^[a-zA-Z0-9_-]+$/.test(targetId)) throw new CronDeliveryRejectedError("QQ 定时投递需要有效的 OpenID");
    targetId = normalizeQQOpenid(targetId);
  } else if (!/^\d{1,32}$/.test(targetId)) throw new CronDeliveryRejectedError("Discord 定时投递需要有效的频道 ID");
  return { channel, accountKey, targetId, scope, label: boundedText(input.label, 240) };
}

/** Selection helper only: callers still authorize the requesting owner at their boundary. */
export function deliveryFromSession(session: { channel?: unknown; origin?: unknown }): CronDelivery {
  const origin = record(session.origin);
  if (!origin || origin.actorRole !== "owner" || origin.platform !== session.channel) {
    throw new CronDeliveryRejectedError("只能选择已有可信主人 QQ/Discord 会话作为定时投递目标");
  }
  const accountKey = boundedText(origin.accountKey, 32);
  const label = [origin.accountLabel, origin.locationName]
    .filter((item): item is string => typeof item === "string" && !!item.trim())
    .join(" · ") || `${session.channel}:${accountKey}`;
  return normalizeCronDelivery({ channel: session.channel, accountKey, targetId: origin.targetId, scope: origin.scope, label: label.slice(0, 240) });
}

function qqFailureHint(error: unknown): string {
  const failure = record(error);
  const code = typeof failure?.bizCode === "number" ? failure.bizCode : undefined;
  if (code === 40034100 || failure?.httpStatus === 429) return "QQ 主动消息触发频控，请检查配额和发送频率";
  if (code === 40034105 || code === 11253 || code === 11254) return "QQ 主动消息权限不足，请检查该 Bot 的平台权限及接收方主动消息设置";
  if (code === 40054013) return "QQ 接收方已拒收消息，请检查允许主动发送设置";
  if (code === 40054004) return "QQ Bot 与接收方没有有效好友关系，请核对所选 Bot 和会话";
  if (code === 40054016) return "QQ Bot 已离线，请检查渠道连接";
  return "QQ 发送失败或回执未知，请检查渠道日志";
}

export function createCronDeliverySender(channels: {
  qq: Map<string, QQChannel>;
  discord: Map<string, DiscordChannel>;
}): (delivery: CronDelivery, text: string) => Promise<void> {
  return async (value, text) => {
    // Normalize before awaits, so editing the job cannot redirect in-flight segments.
    const delivery = normalizeCronDelivery(value);
    if (typeof text !== "string" || !text.trim()) throw new CronDeliveryRejectedError("定时任务没有可投递的结果");
    const channel = delivery.channel === "qq" ? channels.qq.get(delivery.accountKey) : channels.discord.get(delivery.accountKey);
    if (!channel) throw new CronDeliveryRejectedError(`定时投递 Bot「${delivery.accountKey}」未连接；未改投其它 Bot`);
    const target = delivery.channel === "qq"
      ? encodeQQTarget({ scope: delivery.scope === "group" ? "group" : "c2c", targetId: delivery.targetId })
      : delivery.targetId;
    try {
      await sendOutgoingSegments(text, (clean, attachments) => delivery.channel === "qq"
        ? (channel as QQChannel).sendScheduledMessage(target, clean, attachments)
        : (channel as DiscordChannel).sendScheduledMessage(target, clean, attachments));
    } catch (error) {
      const hint = delivery.channel === "qq" ? qqFailureHint(error) : "Discord 发送失败或回执未知，请检查渠道日志";
      throw new Error(`${hint}；可能已有部分内容送达，结果已保留，请勿自动重跑或重复发送。`, { cause: error });
    }
  };
}
