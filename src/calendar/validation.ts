import { formatZonedIso, normalizeTimeZone as canonicalTimeZone } from "../core/timeZone";
import { CalendarServiceError, type CalendarEventDateTime, type CalendarEventInput, type CalendarSlot } from "./types";

class CalendarInputError extends CalendarServiceError {
  constructor(message: string) { super("INVALID_INPUT", message, 400); }
}

function normalizeTimeZone(value: unknown): string {
  try { return canonicalTimeZone(value); }
  catch { throw new CalendarInputError("timeZone must be a valid IANA zone, such as America/New_York or UTC"); }
}

const MINUTE = 60_000;
const DAY = 86_400_000;
const GRID = 5 * MINUTE;
const EVENT_FIELDS = ["summary", "description", "location", "start", "end", "recurrence", "reminders"];

function record(value: unknown, name: string, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new CalendarInputError(`${name} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw new CalendarInputError(`${name}.${key} is not supported`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string, max: number, nonempty = false): string {
  if (typeof value !== "string" || value.length > max || (nonempty && !value.trim())) {
    throw new CalendarInputError(`${name} must be ${nonempty ? "a nonempty" : "a"} string of at most ${max} characters`);
  }
  if (value.includes("\0")) throw new CalendarInputError(`${name} contains an invalid character`);
  return value;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new CalendarInputError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function parseDate(value: unknown, name: string): { value: string; epoch: number } {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) {
    throw new CalendarInputError(`${name} must be a valid YYYY-MM-DD date`);
  }
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== value) {
    throw new CalendarInputError(`${name} must be a valid YYYY-MM-DD date`);
  }
  return { value, epoch };
}

/** Explicit RFC 3339 offsets only; never ask Date.parse to infer a local time. */
function parseInstant(value: unknown, name: string): { value: string; epoch: number; local: string; offset: string } {
  const match = typeof value === "string"
    ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
    : null;
  if (!match) throw new CalendarInputError(`${name} must be an RFC 3339 dateTime with seconds and an explicit offset`);
  parseDate(match[1], name);
  const hour = Number(match[2]), minute = Number(match[3]), second = Number(match[4]);
  const offset = match[6] === "Z" ? "+00:00" : match[6]!;
  const offsetHour = Number(offset.slice(1, 3)), offsetMinute = Number(offset.slice(4, 6));
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59 || offset === "-00:00") {
    throw new CalendarInputError(`${name} has an invalid time or offset`);
  }
  const local = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${(match[5] ?? "").padEnd(3, "0")}`;
  const normalized = `${local}${offset}`;
  const epoch = Date.parse(normalized);
  const offsetMs = (offsetHour * 60 + offsetMinute) * MINUTE * (offset[0] === "-" ? -1 : 1);
  if (!Number.isFinite(epoch) || new Date(epoch + offsetMs).toISOString() !== `${local}Z`) {
    throw new CalendarInputError(`${name} is not a valid round-trip dateTime`);
  }
  return { value: normalized, epoch, local, offset };
}

function eventDateTime(value: unknown, name: string): { value: CalendarEventDateTime; epoch: number; allDay: boolean } {
  const input = record(value, name, ["date", "dateTime", "timeZone"]);
  const allDay = input.date !== undefined;
  if (allDay === (input.dateTime !== undefined)) throw new CalendarInputError(`${name} requires exactly one of date or dateTime`);
  const timeZone = input.timeZone === undefined ? undefined : normalizeTimeZone(input.timeZone);
  if (allDay) {
    const date = parseDate(input.date, `${name}.date`);
    return { value: { date: date.value, ...(timeZone ? { timeZone } : {}) }, epoch: date.epoch, allDay };
  }
  const instant = parseInstant(input.dateTime, `${name}.dateTime`);
  if (timeZone && formatZonedIso(instant.epoch, timeZone) !== instant.value) {
    throw new CalendarInputError(`${name}.dateTime offset/local time does not match timeZone ${timeZone}`);
  }
  return { value: { dateTime: instant.value, ...(timeZone ? { timeZone } : {}) }, epoch: instant.epoch, allDay };
}

function basicRecurrenceDate(value: string, allDay: boolean, name: string): number {
  if (allDay) {
    if (!/^\d{8}$/.test(value)) throw new CalendarInputError(`${name} requires YYYYMMDD dates`);
    return parseDate(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`, name).epoch;
  }
  if (!/^\d{8}T\d{6}Z$/.test(value)) throw new CalendarInputError(`${name} requires explicit UTC YYYYMMDDTHHMMSSZ instants`);
  return parseInstant(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`, name).epoch;
}

function numericRuleList(value: string, name: string, min: number, max: number, nonzero = false): void {
  const entries = value.split(",");
  if (entries.length > 366) throw new CalendarInputError(`${name} has too many values`);
  for (const entry of entries) {
    if (!/^[+-]?\d{1,3}$/.test(entry)) throw new CalendarInputError(`${name} contains an invalid integer`);
    const n = integer(Number(entry), name, min, max);
    if (nonzero && n === 0) throw new CalendarInputError(`${name} cannot contain zero`);
  }
}

/** Small, explicit iCalendar subset. No local recurrence instants or embedded event properties. */
function normalizeRecurrence(value: unknown, allDay: boolean, start: number): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new CalendarInputError("recurrence must contain at most 20 lines");
  let rules = 0;
  return Array.from(value, (entry, index) => {
    const name = `recurrence[${index}]`;
    const line = string(entry, name, 2048, true);
    if (/[\r\n]/.test(line)) throw new CalendarInputError(`${name} cannot contain line breaks`);
    if (line.startsWith("RRULE:")) {
      if (++rules > 1) throw new CalendarInputError("recurrence supports only one RRULE");
      const fields = new Map<string, string>();
      for (const part of line.slice(6).split(";")) {
        const match = /^([A-Z]+)=([^=;:]+)$/.exec(part);
        if (!match || fields.has(match[1]!)) throw new CalendarInputError(`${name} has a malformed or repeated RRULE field`);
        fields.set(match[1]!, match[2]!);
      }
      const frequency = fields.get("FREQ");
      if (!frequency || !["SECONDLY", "MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(frequency)) {
        throw new CalendarInputError(`${name} requires a valid FREQ`);
      }
      if (allDay && ["SECONDLY", "MINUTELY", "HOURLY"].includes(frequency)) throw new CalendarInputError(`${name} frequency does not match all-day dates`);
      if (fields.has("COUNT") === fields.has("UNTIL")) throw new CalendarInputError(`${name} requires exactly one bounded COUNT or UNTIL`);
      for (const [key, ruleValue] of fields) {
        switch (key) {
          case "FREQ": break;
          case "COUNT":
          case "INTERVAL":
            if (!/^\d{1,4}$/.test(ruleValue)) throw new CalendarInputError(`${name}.${key} must be a positive integer`);
            integer(Number(ruleValue), `${name}.${key}`, 1, 1000);
            break;
          case "UNTIL":
            if (basicRecurrenceDate(ruleValue, allDay, `${name}.UNTIL`) < start) throw new CalendarInputError(`${name}.UNTIL must not precede start`);
            break;
          case "BYSECOND": case "BYMINUTE": case "BYHOUR":
            if (allDay) throw new CalendarInputError(`${name}.${key} does not match all-day dates`);
            numericRuleList(ruleValue, `${name}.${key}`, 0, key === "BYHOUR" ? 23 : 59);
            break;
          case "BYMONTH": numericRuleList(ruleValue, `${name}.${key}`, 1, 12); break;
          case "BYMONTHDAY": numericRuleList(ruleValue, `${name}.${key}`, -31, 31, true); break;
          case "BYYEARDAY": case "BYSETPOS": numericRuleList(ruleValue, `${name}.${key}`, -366, 366, true); break;
          case "BYWEEKNO": numericRuleList(ruleValue, `${name}.${key}`, -53, 53, true); break;
          case "WKST":
            if (!/^(MO|TU|WE|TH|FR|SA|SU)$/.test(ruleValue)) throw new CalendarInputError(`${name}.WKST is invalid`);
            break;
          case "BYDAY":
            for (const day of ruleValue.split(",")) {
              const match = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(day);
              if (!match) throw new CalendarInputError(`${name}.BYDAY is invalid`);
              if (match[1]) {
                const ordinal = integer(Number(match[1]), `${name}.BYDAY`, -53, 53);
                if (!ordinal || !["MONTHLY", "YEARLY"].includes(frequency)) throw new CalendarInputError(`${name}.BYDAY ordinal requires MONTHLY or YEARLY`);
              }
            }
            break;
          default: throw new CalendarInputError(`${name}.${key} is not supported`);
        }
      }
      if (fields.has("BYWEEKNO") && frequency !== "YEARLY") throw new CalendarInputError(`${name}.BYWEEKNO requires YEARLY`);
      if (fields.has("BYMONTHDAY") && frequency === "WEEKLY") throw new CalendarInputError(`${name}.BYMONTHDAY cannot use WEEKLY`);
      if (fields.has("BYYEARDAY") && ["DAILY", "WEEKLY", "MONTHLY"].includes(frequency)) throw new CalendarInputError(`${name}.BYYEARDAY has an incompatible frequency`);
      if (fields.has("BYSETPOS") && ![...fields.keys()].some((key) => key !== "BYSETPOS" && key.startsWith("BY"))) {
        throw new CalendarInputError(`${name}.BYSETPOS requires another BY field`);
      }
      if (frequency === "YEARLY" && fields.has("BYWEEKNO") && /(?:^|,)[+-]?\d/.test(fields.get("BYDAY") ?? "")) {
        throw new CalendarInputError(`${name}.BYDAY ordinal cannot accompany BYWEEKNO`);
      }
      return line;
    }
    const dates = /^(RDATE|EXDATE)(?:;VALUE=(DATE|DATE-TIME))?:(.+)$/.exec(line);
    if (!dates || (allDay ? dates[2] !== "DATE" : dates[2] === "DATE")) {
      throw new CalendarInputError(`${name} supports only RRULE and matching UTC RDATE/EXDATE (VALUE=DATE for all-day)`);
    }
    const entries = dates[3]!.split(",");
    if (entries.length > 100) throw new CalendarInputError(`${name} contains too many dates`);
    for (const date of entries) basicRecurrenceDate(date, allDay, name);
    return line;
  });
}

export function normalizeEventInput(value: unknown, options: { creating?: boolean } = {}): CalendarEventInput {
  const input = record(value, "event", EVENT_FIELDS);
  const start = eventDateTime(input.start, "start");
  const end = eventDateTime(input.end, "end");
  if (start.allDay !== end.allDay) throw new CalendarInputError("start and end must both be all-day dates or timed dateTimes");
  if (end.epoch <= start.epoch) throw new CalendarInputError("end must be after start (all-day end is exclusive)");
  const result: CalendarEventInput = {
    summary: string(input.summary, "summary", 1024, true).trim(), start: start.value, end: end.value,
  };
  if (input.description !== undefined) result.description = string(input.description, "description", 16_384);
  if (input.location !== undefined) result.location = string(input.location, "location", 2048);
  if (input.recurrence !== undefined) {
    result.recurrence = normalizeRecurrence(input.recurrence, start.allDay, start.epoch);
    if (result.recurrence.length && !start.allDay
      && (!start.value.timeZone || start.value.timeZone !== end.value.timeZone)) {
      throw new CalendarInputError("timed recurrence requires the same explicit IANA timeZone on start and end");
    }
  }
  if (input.reminders !== undefined) {
    const reminders = record(input.reminders, "reminders", ["useDefault", "overrides"]);
    if (typeof reminders.useDefault !== "boolean") throw new CalendarInputError("reminders.useDefault must be boolean");
    result.reminders = { useDefault: reminders.useDefault };
    if (reminders.overrides !== undefined) {
      if (reminders.useDefault) throw new CalendarInputError("default reminders cannot include overrides");
      if (!Array.isArray(reminders.overrides) || reminders.overrides.length > 5) throw new CalendarInputError("reminders.overrides supports at most 5 entries");
      result.reminders.overrides = Array.from(reminders.overrides, (value, index) => {
        const override = record(value, `reminders.overrides[${index}]`, ["method", "minutes"]);
        if (override.method !== "popup" && override.method !== "email") throw new CalendarInputError("reminder method must be popup or email");
        return { method: override.method, minutes: integer(override.minutes, "reminder minutes", 0, 40_320) };
      });
    }
  } else if (options.creating !== false) {
    result.reminders = { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] };
  }
  return result;
}

export function validateWindow(timeMin: unknown, timeMax: unknown, maxDays = 93): { timeMin: string; timeMax: string; start: number; end: number } {
  integer(maxDays, "maxDays", 1, 3660);
  const start = parseInstant(timeMin, "timeMin"), end = parseInstant(timeMax, "timeMax");
  if (end.epoch <= start.epoch || end.epoch - start.epoch > maxDays * DAY) {
    throw new CalendarInputError(`timeMax must follow timeMin within ${maxDays} days`);
  }
  return { timeMin: start.value, timeMax: end.value, start: start.epoch, end: end.epoch };
}

export interface AvailableSlotsInput {
  timeMin: unknown;
  timeMax: unknown;
  durationMinutes: unknown;
  timeZone: unknown;
  workStartHour?: unknown;
  workEndHour?: unknown;
  excludeWeekends?: unknown;
  busy: Array<{ start: string; end: string }>;
}

/** Candidates are absolute five-minute-grid instants; local clock gaps/folds are never inferred. */
export function findAvailableSlots(input: AvailableSlotsInput): { slots: CalendarSlot[]; timeZone: string; truncated: boolean } {
  const window = validateWindow(input.timeMin, input.timeMax, 31);
  const duration = integer(input.durationMinutes, "durationMinutes", 1, 1440) * MINUTE;
  const timeZone = normalizeTimeZone(input.timeZone);
  const workStart = integer(input.workStartHour === undefined ? 9 : input.workStartHour, "workStartHour", 0, 24);
  const workEnd = integer(input.workEndHour === undefined ? 18 : input.workEndHour, "workEndHour", 0, 24);
  if (workEnd <= workStart) throw new CalendarInputError("workEndHour must be after workStartHour");
  const excludeWeekends = input.excludeWeekends === undefined ? true : input.excludeWeekends;
  if (typeof excludeWeekends !== "boolean") throw new CalendarInputError("excludeWeekends must be boolean");
  if (!Array.isArray(input.busy) || input.busy.length > 10_000) throw new CalendarInputError("busy must contain at most 10000 intervals");
  const busy = Array.from(input.busy, (entry, index) => {
    const value = record(entry, `busy[${index}]`, ["start", "end"]);
    const start = parseInstant(value.start, `busy[${index}].start`).epoch;
    const end = parseInstant(value.end, `busy[${index}].end`).epoch;
    if (end <= start) throw new CalendarInputError(`busy[${index}].end must follow start`);
    return { start, end };
  }).filter((entry) => entry.end > window.start && entry.start < window.end).sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of busy) {
    const previous = merged[merged.length - 1];
    if (previous && previous.end >= interval.start) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", hourCycle: "h23" });
  const allowedMinute = new Map<number, boolean>();
  const isAllowed = (instant: number): boolean => {
    const cached = allowedMinute.get(instant);
    if (cached !== undefined) return cached;
    const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
    const hour = Number(parts.hour);
    const allowed = hour >= workStart && hour < workEnd && (!excludeWeekends || (parts.weekday !== "Sat" && parts.weekday !== "Sun"));
    allowedMinute.set(instant, allowed);
    return allowed;
  };
  const slots: CalendarSlot[] = [];
  let busyIndex = 0;
  for (let start = Math.ceil(window.start / GRID) * GRID; start + duration <= window.end; start += GRID) {
    const end = start + duration;
    while (busyIndex < merged.length && merged[busyIndex]!.end <= start) busyIndex++;
    if (busyIndex < merged.length && merged[busyIndex]!.start < end) continue;
    // Inspect the entire interval, not just its endpoints: a DST fold can cross
    // out of and back into working hours (including half-hour transitions).
    let allowed = true;
    for (let instant = start; instant < end; instant += MINUTE) {
      if (!isAllowed(instant)) { allowed = false; break; }
    }
    if (!allowed) continue;
    if (slots.length === 100) return { slots, timeZone, truncated: true };
    slots.push({ start: formatZonedIso(start, timeZone), end: formatZonedIso(end, timeZone), timeZone });
  }
  return { slots, timeZone, truncated: false };
}
