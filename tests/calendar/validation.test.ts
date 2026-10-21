import assert from "node:assert/strict";
import { test } from "node:test";
import { findAvailableSlots, normalizeEventInput, validateWindow } from "../../src/calendar/validation";
import { CalendarServiceError } from "../../src/calendar/types";

const timed = () => ({
  summary: " Review ",
  start: { dateTime: "2026-09-18T09:00:00-04:00", timeZone: "America/New_York" },
  end: { dateTime: "2026-09-18T10:00:00-04:00", timeZone: "America/New_York" },
});
const allDay = () => ({ summary: "Holiday", start: { date: "2026-09-18" }, end: { date: "2026-09-19" } });
const window = () => ({ timeMin: "2026-09-18T09:00:00-04:00", timeMax: "2026-09-18T12:00:00-04:00", durationMinutes: 60, timeZone: "America/New_York", busy: [] as Array<{ start: string; end: string }> });

test("event normalization is deterministic, immutable, and defaults only creation reminders", () => {
  const original = timed();
  const normalized = normalizeEventInput(original);
  assert.equal(normalized.summary, "Review");
  assert.equal(normalized.start.dateTime, "2026-09-18T09:00:00.000-04:00");
  assert.deepEqual(normalized.reminders, { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] });
  assert.equal(normalizeEventInput(original, { creating: false }).reminders, undefined);
  assert.equal(original.start.dateTime, "2026-09-18T09:00:00-04:00");
  assert.deepEqual(normalizeEventInput(normalized), normalized);
});

test("reject unknown event and nested fields, including attendees and provider write flags", () => {
  for (const extra of ["attendees", "organizer", "id", "sendUpdates", "conferenceData", "calendarId", "__proto__"]) {
    const input = JSON.parse(JSON.stringify(timed()));
    Object.defineProperty(input, extra, { value: [], enumerable: true });
    assert.throws(() => normalizeEventInput(input), /not supported/);
  }
  assert.throws(() => normalizeEventInput({ ...timed(), start: { ...timed().start, custom: true } }), /not supported/);
  assert.throws(() => normalizeEventInput({ ...timed(), summary: "  " }), /summary/);
  assert.throws(() => normalizeEventInput(null), /object/);
  assert.throws(() => normalizeEventInput([]), /object/);
});

test("dates round-trip; leap dates are valid, normalized impossible dates are rejected", () => {
  assert.equal(normalizeEventInput({ ...allDay(), start: { date: "2028-02-29" }, end: { date: "2028-03-01" } }).start.date, "2028-02-29");
  for (const date of ["2026-02-29", "2026-02-30", "2026-04-31", "2026-00-01", "2026-13-01", "0000-01-01", "2026-9-18", "2026-09-18Z"]) {
    assert.throws(() => normalizeEventInput({ ...allDay(), start: { date } }), /valid/);
  }
});

test("all-day end is exclusive and start/end modes cannot mix", () => {
  assert.deepEqual(normalizeEventInput(allDay()).end, { date: "2026-09-19" });
  assert.throws(() => normalizeEventInput({ ...allDay(), end: { date: "2026-09-18" } }), /exclusive/);
  assert.throws(() => normalizeEventInput({ ...allDay(), end: timed().end }), /both/);
  assert.throws(() => normalizeEventInput({ ...timed(), start: { date: "2026-09-18", dateTime: timed().start.dateTime } }), /exactly one/);
  assert.throws(() => normalizeEventInput({ ...timed(), start: {} }), /exactly one/);
});

test("timed events need strict round-trip RFC 3339 instants, not host-local guesses", () => {
  for (const dateTime of ["2026-09-18T09:00:00", "2026-09-18T09:00", "2026-09-18 09:00:00Z", "2026-02-30T09:00:00Z", "2026-09-18T24:00:00Z", "2026-09-18T09:60:00Z", "2026-09-18T09:00:60Z", "2026-09-18T09:00:00-00:00", "2026-09-18T09:00:00+24:00", "2026-09-18T09:00:00+08:60", "2026-09-18T09:00:00.1234Z"]) {
    assert.throws(() => normalizeEventInput({ ...timed(), start: { dateTime } }), /valid|offset|RFC/);
  }
  const result = normalizeEventInput({ ...timed(), start: { dateTime: "2026-09-18T13:00:00.1Z" }, end: { dateTime: "2026-09-18T14:00:00Z" } });
  assert.equal(result.start.dateTime, "2026-09-18T13:00:00.100+00:00");
  assert.throws(() => normalizeEventInput({ ...timed(), end: timed().start }), /after/);
});

test("explicit IANA zone must agree with supplied instant offset and wall time", () => {
  for (const timeZone of ["EST", "UTC+8", "Invalid/Zone", "", 8]) {
    assert.throws(() => normalizeEventInput({ ...timed(), start: { ...timed().start, timeZone } }));
  }
  assert.throws(() => normalizeEventInput({ ...timed(), start: { dateTime: "2026-09-18T09:00:00-05:00", timeZone: "America/New_York" } }), /does not match/);
  assert.throws(() => normalizeEventInput({ ...timed(), start: { dateTime: "2026-09-18T13:00:00Z", timeZone: "America/New_York" } }), /does not match/);
  const result = normalizeEventInput({ summary: "UTC", start: { dateTime: "2026-09-18T13:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-09-18T14:00:00+00:00", timeZone: "UTC" } });
  assert.equal(result.start.timeZone, "UTC");
});

test("spring gap times fail while explicit fall-fold offsets remain distinct", () => {
  for (const offset of ["-04:00", "-05:00"]) {
    assert.throws(() => normalizeEventInput({ summary: "gap", start: { dateTime: `2026-03-08T02:30:00${offset}`, timeZone: "America/New_York" }, end: { dateTime: "2026-03-08T04:00:00-04:00", timeZone: "America/New_York" } }), /does not match/);
  }
  const result = normalizeEventInput({ summary: "fold", start: { dateTime: "2026-11-01T01:30:00-04:00", timeZone: "America/New_York" }, end: { dateTime: "2026-11-01T01:30:00-05:00", timeZone: "America/New_York" } });
  assert.equal(Date.parse(result.end.dateTime!) - Date.parse(result.start.dateTime!), 3_600_000);
});

test("recurrence accepts bounded rules and explicit UTC date inclusions/exclusions", () => {
  const recurrence = ["RRULE:FREQ=WEEKLY;COUNT=10;BYDAY=MO,WE;WKST=MO", "RDATE:20260922T130000Z", "EXDATE;VALUE=DATE-TIME:20260923T130000Z"];
  assert.deepEqual(normalizeEventInput({ ...timed(), recurrence }).recurrence, recurrence);
  assert.deepEqual(normalizeEventInput({ ...timed(), recurrence: ["RRULE:FREQ=MONTHLY;UNTIL=20270918T130000Z;BYDAY=1MO,-1FR;BYSETPOS=1"] }).recurrence, ["RRULE:FREQ=MONTHLY;UNTIL=20270918T130000Z;BYDAY=1MO,-1FR;BYSETPOS=1"]);
  assert.deepEqual(normalizeEventInput({ ...allDay(), recurrence: ["RRULE:FREQ=YEARLY;UNTIL=20300918", "RDATE;VALUE=DATE:20261018", "EXDATE;VALUE=DATE:20270918"] }).recurrence, ["RRULE:FREQ=YEARLY;UNTIL=20300918", "RDATE;VALUE=DATE:20261018", "EXDATE;VALUE=DATE:20270918"]);
  assert.deepEqual(normalizeEventInput({ ...timed(), recurrence: [] }).recurrence, []);
});

test("timed recurrence requires matching explicit time zones", () => {
  const recurrence = ["RRULE:FREQ=DAILY;COUNT=2"];
  assert.throws(() => normalizeEventInput({ ...timed(), start: { dateTime: timed().start.dateTime }, recurrence }), /same explicit/);
  assert.throws(() => normalizeEventInput({ ...timed(), end: { dateTime: "2026-09-18T14:00:00Z", timeZone: "UTC" }, recurrence }), /same explicit/);
});

test("recurrence fails closed on unbounded rules, unsafe properties and invalid dates", () => {
  for (const recurrence of [
    ["RRULE:FREQ=DAILY"], ["RRULE:FREQ=DAILY;COUNT=1001"], ["RRULE:FREQ=DAILY;COUNT=0"],
    ["RRULE:FREQ=DAILY;COUNT=2;UNTIL=20260920T130000Z"], ["RRULE:FREQ=DAILY;UNTIL=20250918T130000Z"],
    ["RRULE:FREQ=DAILY;UNTIL=20260920"], ["RRULE:FREQ=DAILY;COUNT=2;INTERVAL=0"],
    ["RRULE:FREQ=WEEKLY;COUNT=2;BYDAY=1MO"], ["RRULE:FREQ=MONTHLY;COUNT=2;BYMONTHDAY=0"],
    ["RRULE:FREQ=DAILY;COUNT=2;BYHOUR=24"], ["RRULE:FREQ=DAILY;COUNT=2;BYSETPOS=1"],
    ["RRULE:FREQ=DAILY;COUNT=2;COUNT=3"], ["RRULE:FREQ=DAILY;COUNT=2;X-THING=1"],
    ["RRULE:FREQ=DAILY;COUNT=2\nATTENDEE:someone@example.com"], ["DTSTART:20260918T130000Z"], ["DTEND:20260918T140000Z"],
    ["RDATE;TZID=America/New_York:20260918T090000"], ["RDATE:20260230T130000Z"], ["RDATE;VALUE=DATE:20260918"],
    ["RRULE:FREQ=DAILY;COUNT=2", "RRULE:FREQ=WEEKLY;COUNT=2"],
  ]) assert.throws(() => normalizeEventInput({ ...timed(), recurrence }), `must reject ${recurrence.join("|")}`);
  assert.throws(() => normalizeEventInput({ ...allDay(), recurrence: ["RRULE:FREQ=HOURLY;COUNT=2"] }));
  assert.throws(() => normalizeEventInput({ ...allDay(), recurrence: ["EXDATE:20260918"] }));
});

test("reminders permit explicit disable/default/overrides and enforce bounded known fields", () => {
  for (const reminders of [{ useDefault: true }, { useDefault: false, overrides: [] }, { useDefault: false, overrides: [{ method: "email", minutes: 0 }, { method: "popup", minutes: 40320 }] }]) {
    assert.deepEqual(normalizeEventInput({ ...timed(), reminders }).reminders, reminders);
  }
  for (const reminders of [{}, { useDefault: "false" }, { useDefault: false, unknown: true }, { useDefault: true, overrides: [] }, { useDefault: false, overrides: [{ method: "sms", minutes: 10 }] }, { useDefault: false, overrides: [{ method: "popup", minutes: -1 }] }, { useDefault: false, overrides: [{ method: "popup", minutes: 40321 }] }, { useDefault: false, overrides: [{ method: "popup", minutes: 1.5 }] }, { useDefault: false, overrides: [{ method: "popup", minutes: 15, email: "other@example.com" }] }, { useDefault: false, overrides: Array.from({ length: 6 }, () => ({ method: "popup", minutes: 15 })) }]) {
    assert.throws(() => normalizeEventInput({ ...timed(), reminders }));
  }
});

test("window validates explicit instants, chronology, and the default 93-day bound", () => {
  const result = validateWindow("2026-01-01T00:00:00Z", "2026-04-04T00:00:00Z");
  assert.equal(result.end - result.start, 93 * 86_400_000);
  assert.equal(result.timeMin, "2026-01-01T00:00:00.000+00:00");
  assert.throws(() => validateWindow("2026-01-01T00:00:00Z", "2026-04-04T00:00:00.001Z"), /93/);
  assert.throws(() => validateWindow("2026-01-01T00:00:00", "2026-01-02T00:00:00Z"), /offset/);
  assert.throws(() => validateWindow("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"), /follow/);
  assert.throws(() => validateWindow("2026-01-01T00:00:00Z", "2025-12-31T00:00:00Z"), /follow/);
});

test("free slots use five-minute absolute grid and preserve exact duration", () => {
  const original = window();
  const result = findAvailableSlots(original);
  assert.equal(result.slots.length, 25);
  assert.equal(result.slots[0]!.start, "2026-09-18T09:00:00.000-04:00");
  assert.equal(result.slots[24]!.end, "2026-09-18T12:00:00.000-04:00");
  assert.equal(result.truncated, false);
  assert.equal(result.timeZone, "America/New_York");
  assert.deepEqual(original, window());
  const fractional = findAvailableSlots({ ...window(), timeMin: "2026-09-18T09:01:00.001-04:00", durationMinutes: 7 });
  assert.equal(fractional.slots[0]!.start, "2026-09-18T09:05:00.000-04:00");
  assert.equal(fractional.slots[0]!.end, "2026-09-18T09:12:00.000-04:00");
});

test("busy intervals merge without mutation and obey half-open boundary semantics", () => {
  const busy = [{ start: "2026-09-18T10:30:00-04:00", end: "2026-09-18T11:00:00-04:00" }, { start: "2026-09-18T10:00:00-04:00", end: "2026-09-18T10:45:00-04:00" }];
  const copy = JSON.stringify(busy);
  const result = findAvailableSlots({ ...window(), busy });
  assert.deepEqual(result.slots.map((slot) => slot.start), ["2026-09-18T09:00:00.000-04:00", "2026-09-18T11:00:00.000-04:00"]);
  assert.equal(JSON.stringify(busy), copy);
  assert.equal(findAvailableSlots({ ...window(), busy: [{ start: "2026-09-18T08:00:00-04:00", end: "2026-09-18T12:00:00-04:00" }] }).slots.length, 0);
});

test("slots respect local working hours and weekends rather than UTC or host-local days", () => {
  const input = { ...window(), timeMin: "2026-09-18T21:00:00Z", timeMax: "2026-09-19T01:00:00Z" };
  assert.deepEqual(findAvailableSlots(input).slots.map((slot) => slot.start), ["2026-09-18T17:00:00.000-04:00"]);
  const weekend = { ...window(), timeMin: "2026-09-19T09:00:00-04:00", timeMax: "2026-09-19T10:00:00-04:00" };
  assert.equal(findAvailableSlots(weekend).slots.length, 0);
  assert.equal(findAvailableSlots({ ...weekend, excludeWeekends: false }).slots.length, 1);
  const asia = findAvailableSlots({ ...window(), timeMin: "2026-09-18T01:00:00Z", timeMax: "2026-09-18T02:00:00Z", timeZone: "Asia/Shanghai" });
  assert.equal(asia.slots[0]!.start, "2026-09-18T09:00:00.000+08:00");
});

test("spring-forward slots use real instants with correct endpoint offsets", () => {
  const result = findAvailableSlots({ ...window(), timeMin: "2026-03-08T01:00:00-05:00", timeMax: "2026-03-08T04:00:00-04:00", workStartHour: 1, workEndHour: 4, excludeWeekends: false });
  assert.equal(result.slots[0]!.start, "2026-03-08T01:00:00.000-05:00");
  assert.equal(result.slots[0]!.end, "2026-03-08T03:00:00.000-04:00");
  assert.equal(result.slots.length, 13);
  assert.ok(result.slots.every((slot) => !slot.start.includes("T02:") && !slot.end.includes("T02:")));
  assert.ok(result.slots.every((slot) => Date.parse(slot.end) - Date.parse(slot.start) === 3_600_000));
});

test("fall-back slots keep both fold occurrences and validate interior work hours", () => {
  const result = findAvailableSlots({ ...window(), timeMin: "2026-11-01T01:00:00-04:00", timeMax: "2026-11-01T03:00:00-05:00", workStartHour: 1, workEndHour: 3, excludeWeekends: false });
  assert.equal(result.slots[0]!.start, "2026-11-01T01:00:00.000-04:00");
  assert.equal(result.slots[0]!.end, "2026-11-01T01:00:00.000-05:00");
  assert.ok(result.slots.some((slot) => slot.start === "2026-11-01T01:00:00.000-05:00"));
  assert.equal(result.slots.length, 25);
  assert.ok(result.slots.every((slot) => Date.parse(slot.end) - Date.parse(slot.start) === 3_600_000));
  const narrow = findAvailableSlots({ ...window(), timeMin: "2026-11-01T00:00:00-04:00", timeMax: "2026-11-01T04:00:00-05:00", workStartHour: 2, workEndHour: 3, excludeWeekends: false });
  assert.deepEqual(narrow.slots.map((slot) => slot.start), ["2026-11-01T02:00:00.000-05:00"]);
});

test("24-hour work windows support midnight and non-hour-offset time zones", () => {
  const result = findAvailableSlots({ ...window(), timeMin: "2026-09-18T23:00:00+05:45", timeMax: "2026-09-19T00:00:00+05:45", timeZone: "Asia/Kathmandu", workStartHour: 0, workEndHour: 24 });
  assert.equal(result.slots.length, 1);
  assert.equal(result.slots[0]!.end, "2026-09-19T00:00:00.000+05:45");
});

test("slot output is bounded and truncated means a further available slot exists", () => {
  const full = findAvailableSlots({ ...window(), timeMin: "2026-09-18T00:00:00Z", timeMax: "2026-09-19T00:00:00Z", timeZone: "UTC", durationMinutes: 1, workStartHour: 0, workEndHour: 24 });
  assert.equal(full.slots.length, 100);
  assert.equal(full.truncated, true);
  const exact = findAvailableSlots({ ...window(), timeMin: "2026-09-18T00:00:00Z", timeMax: "2026-09-18T08:16:00Z", timeZone: "UTC", durationMinutes: 1, workStartHour: 0, workEndHour: 24 });
  assert.equal(exact.slots.length, 100);
  assert.equal(exact.truncated, false);
});

test("slot inputs fail closed on invalid ranges, invalid busy instants and unsupported values", () => {
  for (const patch of [
    { durationMinutes: 0 }, { durationMinutes: 1441 }, { durationMinutes: 1.5 }, { durationMinutes: "60" },
    { workStartHour: -1 }, { workEndHour: 25 }, { workStartHour: 9.5 }, { workStartHour: 18, workEndHour: 9 },
    { workStartHour: 9, workEndHour: 9 }, { workStartHour: null }, { excludeWeekends: null }, { excludeWeekends: "true" }, { timeZone: "EST" },
    { timeMin: "2026-01-01T00:00:00Z", timeMax: "2026-02-01T00:00:00.001Z" },
    { busy: [{ start: "2026-09-18T09:00:00", end: "2026-09-18T10:00:00Z" }] },
    { busy: [{ start: "2026-09-18T09:00:00Z", end: "2026-09-18T09:00:00Z" }] },
  ]) assert.throws(() => findAvailableSlots({ ...window(), ...patch }));
  assert.equal(findAvailableSlots({ ...window(), durationMinutes: 1440 }).slots.length, 0);
});

test("all validation errors carry the service INVALID_INPUT status and sparse arrays fail closed", () => {
  for (const run of [
    () => normalizeEventInput(null),
    () => normalizeEventInput({ ...timed(), start: { ...timed().start, timeZone: "EST" } }),
    () => normalizeEventInput({ ...timed(), recurrence: new Array(1) }),
    () => normalizeEventInput({ ...timed(), reminders: { useDefault: false, overrides: new Array(1) } }),
    () => findAvailableSlots({ ...window(), busy: new Array(1) }),
    () => findAvailableSlots({ ...window(), timeZone: "EST" }),
    () => validateWindow("bad", "bad"),
  ]) {
    assert.throws(run, (error: unknown) => error instanceof CalendarServiceError && error.code === "INVALID_INPUT" && error.httpStatus === 400);
  }
});
