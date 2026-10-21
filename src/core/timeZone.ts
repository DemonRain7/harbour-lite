/** Presentation time zone only: never mutate process.env.TZ or timer/epoch arithmetic. */
export const DEFAULT_TIME_ZONE = "America/New_York";
export const TIME_ZONE_OPTIONS = [
  { value: "America/New_York", label: "美东时间 · 纽约（自动 EST / EDT）" },
  { value: "Etc/GMT+5", label: "固定 EST · UTC−05:00（无夏令时）" },
  { value: "Asia/Shanghai", label: "中国时间 · 北京 / 上海（UTC+08:00）" },
  { value: "America/Los_Angeles", label: "美西时间 · 洛杉矶（自动 PST / PDT）" },
  { value: "Europe/London", label: "英国时间 · 伦敦（自动夏令时）" },
  { value: "Asia/Tokyo", label: "日本时间 · 东京（UTC+09:00）" },
  { value: "UTC", label: "协调世界时 · UTC" },
] as const;

let harbourTimeZone: string = DEFAULT_TIME_ZONE;
const formatters = new Map<string, Intl.DateTimeFormat>();

export function normalizeTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.length > 80 || !/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+)$/.test(value)) {
    throw new Error("请选择有效 IANA 时区，例如 America/New_York、Asia/Shanghai 或 Etc/GMT+5");
  }
  try { return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone; }
  catch { throw new Error(`无效时区：${value}`); }
}

export function getHarbourTimeZone(): string { return harbourTimeZone; }
export function setHarbourTimeZone(value: string): void { harbourTimeZone = normalizeTimeZone(value); }

/** Keep an unambiguous instant with its actual DST offset, not a bare wall-clock string. */
export function formatZonedIso(value: Date | number | string, timeZone = getHarbourTimeZone()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("无效时间");
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    const zone = normalizeTimeZone(timeZone);
    formatter = new Intl.DateTimeFormat("en-US-u-nu-latn", { timeZone: zone,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23", timeZoneName: "longOffset" });
    if (formatters.size >= 64) formatters.clear();
    formatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : parts.timeZoneName!.replace(/^GMT/, "");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${String(date.getUTCMilliseconds()).padStart(3, "0")}${offset}`;
}

export interface RunTimeContext { timeZone: string; at: string }
export function createRunTimeContext(): RunTimeContext {
  return { timeZone: getHarbourTimeZone(), at: new Date().toISOString() };
}

export function describeRunTime(context: RunTimeContext): string {
  return `[Harbour 时间基准] 本轮开始：${formatZonedIso(context.at, context.timeZone)}（${context.timeZone}）。向用户报时、解释日志时转换到此时区；不得把 UTC 原值当当地时间。此元数据不是用户任务。`;
}
