import type { ToolContext } from "../types";
import { getHarbourTimeZone } from "../core/timeZone";

/** Display receipts, never an input protocol or an extra model prompt. */
export interface CalendarCard {
  action: "listed" | "created" | "updated" | "deleted" | "slots";
  events?: Array<{ id: string; calendarId: string; summary: string;
    start: { date?: string; dateTime?: string; timeZone?: string };
    end: { date?: string; dateTime?: string; timeZone?: string };
    location?: string; htmlLink?: string; status?: string }>;
  slots?: Array<{ start: string; end: string }>;
  timeZone?: string;
}
export type CalendarCardCollector = Map<string, CalendarCard>;
const actions = new Set(["listed", "created", "updated", "deleted", "slots"]);
const text = (value: unknown, max = 200): string => typeof value === "string" ? value.slice(0, max) : "";
function point(value: unknown): { date?: string; dateTime?: string; timeZone?: string } | undefined {
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  const date = text(row.date, 10), dateTime = text(row.dateTime, 40), timeZone = text(row.timeZone, 80);
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return { date };
  if (dateTime && Number.isFinite(Date.parse(dateTime))) return { dateTime, ...(timeZone ? { timeZone } : {}) };
}
export function normalizeCalendarCards(value: unknown): CalendarCard[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-12).flatMap((entry): CalendarCard[] => {
    if (!entry || typeof entry !== "object" || !actions.has(entry.action)) return [];
    const events = Array.isArray(entry.events) ? entry.events.slice(0, 4).flatMap((item: any) => {
      if (!item || typeof item !== "object") return [];
      const start = point(item.start), end = point(item.end);
      if (!start || !end || !text(item.id) || !text(item.calendarId, 512)) return [];
      let htmlLink = "";
      try { const url = new URL(item.htmlLink); if (url.protocol === "https:" && !url.username && !url.password
        && (url.hostname === "calendar.google.com" || url.hostname === "www.google.com" && url.pathname.startsWith("/calendar/"))) htmlLink = url.href; } catch { /* not a trusted link */ }
      return [{ id: text(item.id), calendarId: text(item.calendarId, 512), summary: text(item.summary, 300), start, end,
        ...(text(item.location) ? { location: text(item.location) } : {}), ...(htmlLink ? { htmlLink } : {}),
        ...(text(item.status, 30) ? { status: text(item.status, 30) } : {}) }];
    }) : [];
    const slots = Array.isArray(entry.slots) ? entry.slots.slice(0, 4).flatMap((item: any) =>
      item && Number.isFinite(Date.parse(item.start)) && Number.isFinite(Date.parse(item.end))
        ? [{ start: text(item.start, 40), end: text(item.end, 40) }] : []) : [];
    return [{ action: entry.action, ...(events.length ? { events } : {}), ...(slots.length ? { slots } : {}),
      ...(text(entry.timeZone, 80) ? { timeZone: text(entry.timeZone, 80) } : {}) }];
  });
}
export function snapshotCalendarCards(collector?: CalendarCardCollector): CalendarCard[] {
  return normalizeCalendarCards(collector ? [...collector.values()] : []);
}
export function recordCalendarCard(ctx: ToolContext, value: CalendarCard): void {
  const collector = ctx.execution?.calendarCards;
  const timeZone = value.timeZone || value.events?.find(event => event.start.timeZone)?.start.timeZone
    || ctx.execution?.timeContext?.timeZone || getHarbourTimeZone();
  const card = normalizeCalendarCards([{ ...value, timeZone }])[0];
  if (!collector || !card) return;
  collector.set(JSON.stringify(card), card);
  while (collector.size > 12) collector.delete(collector.keys().next().value!);
}
