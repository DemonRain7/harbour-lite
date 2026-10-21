import { createHash } from "node:crypto";
import { atomicJson, boundedResponse, GoogleOAuthConnection } from "../google/oauth";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CalendarServiceError, type CalendarEvent, type CalendarEventDateTime, type CalendarEventInput,
  type CalendarListItem, type CalendarReminder, type CalendarStatus } from "./types";
import { findAvailableSlots, normalizeEventInput, validateWindow } from "./validation";

export { CalendarServiceError } from "./types";
export type { CalendarEvent, CalendarEventInput, CalendarStatus } from "./types";

export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.freebusy",
] as const;

const API = "https://www.googleapis.com/calendar/v3";
type Json = Record<string, unknown>;

interface CreateReceipt {
  version: 1;
  calendarId: string;
  eventId: string;
  inputHash: string;
  state: "pending" | "completed" | "rejected" | "unknown";
  event?: CalendarEvent;
  rejectionCode?: string;
  rejectionStatus?: number;
}

export interface GoogleCalendarServiceOptions {
  dataDir?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Execution control only; never accept this object from model or HTTP JSON input. */
export interface CalendarWriteOptions { signal?: AbortSignal }

/** One owner-authorized connection. No method invents targets, times, invitations, or write retries. */
export class GoogleCalendarService {
  private readonly directory: string;
  private readonly fetcher: typeof fetch;
  private readonly oauthConnection: GoogleOAuthConnection;
  private creates = new Map<string, { hash: string; promise: Promise<{ event: CalendarEvent; replayed?: boolean }> }>();

  constructor(options: GoogleCalendarServiceOptions = {}) {
    this.directory = path.resolve(options.dataDir ?? path.join(process.cwd(), "data", "calendar"));
    this.fetcher = options.fetch ?? fetch;
    this.oauthConnection = new GoogleOAuthConnection({ ...options, dataDir: this.directory,
      scopes: GOOGLE_CALENDAR_SCOPES, callbackPath: "/api/calendar/oauth/callback", configPrefix: "GOOGLE_CALENDAR",
      errorFactory: (...args) => new CalendarServiceError(...args) });
  }

  status(): Promise<CalendarStatus> { return this.oauthConnection.status(); }
  beginAuth(): Promise<{ url: string }> { return this.oauthConnection.beginAuth(); }
  completeAuth(input: { state: string; code?: string; error?: string }): Promise<void> { return this.oauthConnection.completeAuth(input); }
  disconnect(): Promise<void> { return this.oauthConnection.disconnect(); }
  private get generation(): number { return this.oauthConnection.currentGeneration; }
  private access() { return this.oauthConnection.access(); }
  private assertGeneration(generation: number): void { this.oauthConnection.assertGeneration(generation); }

  async calendars(): Promise<{ calendars: CalendarListItem[]; truncated: boolean }> {
    const auth = await this.access();
    const calendars: CalendarListItem[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const data = await this.api("/users/me/calendarList", { expectedGeneration: auth.generation, query: { maxResults: "100", showHidden: "false",
        ...(pageToken ? { pageToken } : {}) } });
      for (const item of array(data.items)) {
        const row = object(item);
        if (typeof row.id !== "string") continue;
        calendars.push({ id: row.id, summary: string(row.summary) || row.id, timeZone: string(row.timeZone) || "UTC",
          accessRole: string(row.accessRole), ...(row.primary === true ? { primary: true } : {}),
          ...(Array.isArray(row.defaultReminders) ? { defaultReminders: reminders(row.defaultReminders) } : {}) });
      }
      pageToken = optionalPage(data.nextPageToken);
      if (!pageToken) break;
    }
    return { calendars, truncated: !!pageToken };
  }

  async events(input: { calendarId?: string; timeMin: string; timeMax: string; q?: string }) {
    const calendarId = identifier(input.calendarId ?? "primary", "日历 ID");
    const window = validateWindow(input.timeMin, input.timeMax);
    const q = input.q === undefined ? undefined : bounded(input.q, "搜索词", 500);
    const auth = await this.access();
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    let timeZone: string | undefined;
    for (let page = 0; page < 4; page++) {
      const data = await this.api(`/calendars/${segment(calendarId)}/events`, { expectedGeneration: auth.generation, query: {
        timeMin: window.timeMin, timeMax: window.timeMax, singleEvents: "true", orderBy: "startTime",
        showDeleted: "false", maxResults: "250", ...(q ? { q } : {}), ...(pageToken ? { pageToken } : {}) } });
      if (typeof data.timeZone === "string") timeZone = data.timeZone;
      for (const item of array(data.items).slice(0, 250)) events.push(compactEvent(item, calendarId));
      pageToken = optionalPage(data.nextPageToken);
      if (!pageToken) break;
    }
    return { events, ...(timeZone ? { timeZone } : {}), truncated: !!pageToken };
  }

  async get(input: { calendarId?: string; eventId: string }): Promise<{ event: CalendarEvent }> {
    const calendarId = identifier(input.calendarId ?? "primary", "日历 ID");
    const eventId = eventIdentifier(input.eventId);
    return { event: compactEvent(await this.rawEvent(calendarId, eventId), calendarId) };
  }

  async create(input: { calendarId?: string; requestId: string; event: CalendarEventInput },
    options: CalendarWriteOptions = {}): Promise<{ event: CalendarEvent; replayed?: boolean }> {
    assertWriteNotCancelled(options.signal);
    const calendarId = identifier(input.calendarId ?? "primary", "日历 ID");
    const requestId = bounded(input.requestId, "请求 ID", 200);
    const event = normalizeEventInput(input.event, { creating: true });
    const inputHash = hash(JSON.stringify(event));
    const auth = await this.access();
    assertWriteNotCancelled(options.signal);
    const requestHash = hash(`${calendarId}\n${requestId}`);
    const key = hash(`${auth.connectionId}\n${requestHash}`);
    const existing = this.creates.get(key);
    if (existing) {
      if (existing.hash !== inputHash) throw keyConflict();
      return existing.promise;
    }
    const promise = this.createOnce({ calendarId, event, inputHash, requestHash, key, generation: auth.generation }, options);
    this.creates.set(key, { hash: inputHash, promise });
    try { return await promise; }
    finally { if (this.creates.get(key)?.promise === promise) this.creates.delete(key); }
  }

  async update(input: { calendarId?: string; eventId: string; etag: string; event: CalendarEventInput },
    options: CalendarWriteOptions = {}): Promise<{ event: CalendarEvent }> {
    assertWriteNotCancelled(options.signal);
    const calendarId = identifier(input.calendarId ?? "primary", "日历 ID");
    const eventId = eventIdentifier(input.eventId);
    const etag = exactEtag(input.etag);
    const event = normalizeEventInput(input.event, { creating: false });
    if (event.recurrence !== undefined) throw new CalendarServiceError("SERIES_UNSUPPORTED", "修改重复规则会影响整组事件；当前仅支持明确的单次事件或重复实例。");
    const auth = await this.access();
    assertWriteNotCancelled(options.signal);
    await this.assertPersonalTarget(calendarId, eventId, etag, auth.generation);
    assertWriteNotCancelled(options.signal);
    const result = await this.api(`/calendars/${segment(calendarId)}/events/${segment(eventId)}`, {
      method: "PATCH", query: { sendUpdates: "none" }, headers: { "If-Match": etag }, body: event, write: true,
      expectedGeneration: auth.generation, beforeWrite: () => assertWriteNotCancelled(options.signal) });
    return { event: compactEvent(result, calendarId, true) };
  }

  async remove(input: { calendarId?: string; eventId: string; etag: string },
    options: CalendarWriteOptions = {}): Promise<{ removed: true; eventId: string; calendarId: string }> {
    assertWriteNotCancelled(options.signal);
    const calendarId = identifier(input.calendarId ?? "primary", "日历 ID");
    const eventId = eventIdentifier(input.eventId);
    const etag = exactEtag(input.etag);
    const auth = await this.access();
    assertWriteNotCancelled(options.signal);
    await this.assertPersonalTarget(calendarId, eventId, etag, auth.generation);
    assertWriteNotCancelled(options.signal);
    await this.api(`/calendars/${segment(calendarId)}/events/${segment(eventId)}`, {
      method: "DELETE", query: { sendUpdates: "none" }, headers: { "If-Match": etag }, write: true,
      expectedGeneration: auth.generation, beforeWrite: () => assertWriteNotCancelled(options.signal) });
    return { removed: true, eventId, calendarId };
  }

  async findSlots(input: { calendarIds?: string[]; timeMin: string; timeMax: string; durationMinutes: number;
    timeZone: string; workStartHour?: number; workEndHour?: number; excludeWeekends?: boolean }) {
    const window = validateWindow(input.timeMin, input.timeMax, 31);
    const timeZone = findAvailableSlots({ ...input, busy: [] }).timeZone;
    const ids = input.calendarIds ?? ["primary"];
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20) throw new CalendarServiceError("INVALID_INPUT", "请选择 1 至 20 个日历。");
    const calendarIds = [...new Set(Array.from(ids, id => identifier(id, "日历 ID")))];
    const response = await this.api("/freeBusy", { method: "POST", body: {
      timeMin: window.timeMin, timeMax: window.timeMax, timeZone, calendarExpansionMax: 20,
      items: calendarIds.map(id => ({ id })) } });
    const calendars = object(response.calendars);
    const busy: Array<{ start: string; end: string }> = [];
    for (const id of calendarIds) {
      const calendar = object(calendars[id]);
      if (!Array.isArray(calendar.busy) || array(calendar.errors).length) {
        throw new CalendarServiceError("FREEBUSY_UNAVAILABLE", "至少一个日历的忙闲查询失败；未把未知时间当成空闲。", 502);
      }
      for (const entry of calendar.busy) {
        const row = object(entry);
        if (typeof row.start !== "string" || typeof row.end !== "string") throw protocolError();
        busy.push({ start: row.start, end: row.end });
        if (busy.length > 10000) throw new CalendarServiceError("RESULT_LIMIT", "忙闲结果过多，请缩短查询范围。");
      }
    }
    return findAvailableSlots({ ...input, timeZone, busy });
  }

  private async assertPersonalTarget(calendarId: string, eventId: string, etag: string, generation: number): Promise<void> {
    const current = await this.rawEvent(calendarId, eventId, generation);
    if (current.etag !== etag) throw new CalendarServiceError("ETAG_MISMATCH", "事件已被修改，请重新读取并确认后再操作。", 409, "rejected");
    if (array(current.recurrence).length && !current.recurringEventId) throw new CalendarServiceError("SERIES_UNSUPPORTED",
      "这是重复事件的整组主记录；请从时间范围查询中选择明确的单次实例。", 400, "rejected");
    if (array(current.attendees).length) throw new CalendarServiceError("ATTENDEES_UNSUPPORTED",
      "当前仅支持个人日程；含参与者的会议请在 Google Calendar 中操作。", 400, "rejected");
    if (current.status === "cancelled") throw new CalendarServiceError("EVENT_CANCELLED", "事件已取消，未执行修改。", 409, "rejected");
  }

  private async rawEvent(calendarId: string, eventId: string, generation?: number): Promise<Json> {
    return this.api(`/calendars/${segment(calendarId)}/events/${segment(eventId)}`, { expectedGeneration: generation });
  }

  private async createOnce(input: { calendarId: string; event: CalendarEventInput; inputHash: string;
    requestHash: string; key: string; generation: number }, options: CalendarWriteOptions): Promise<{ event: CalendarEvent; replayed?: boolean }> {
    const eventId = `h${input.requestHash}`;
    const file = path.join(this.directory, "requests", `${input.key}.json`);
    const receipt: CreateReceipt = { version: 1, calendarId: input.calendarId, eventId, inputHash: input.inputHash, state: "pending" };
    let first = false;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const handle = await fs.open(file, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); first = true; }
      finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new CalendarServiceError("LOCAL_STATE_FAILED", "请求记录保存失败；未开始创建事件。", 503, "rejected");
    }
    if (!first) {
      let previous: CreateReceipt;
      try { previous = JSON.parse(await fs.readFile(file, "utf8")); }
      catch { throw new CalendarServiceError("WRITE_UNKNOWN", "该请求的本地记录不完整；请先核对 Google Calendar，未重复创建。", 409, "unknown"); }
      if (previous.version !== 1 || previous.inputHash !== input.inputHash || previous.calendarId !== input.calendarId || previous.eventId !== eventId) throw keyConflict();
      return this.reconcileCreate(input, file, previous);
    }
    try {
      this.assertGeneration(input.generation);
      assertWriteNotCancelled(options.signal);
      const created = await this.api(`/calendars/${segment(input.calendarId)}/events`, { method: "POST", write: true,
        expectedGeneration: input.generation, beforeWrite: () => assertWriteNotCancelled(options.signal),
        query: { sendUpdates: "none" }, body: { ...input.event, id: eventId,
          extendedProperties: { private: { harbourRequest: input.requestHash, harbourInput: input.inputHash } } } });
      const event = compactEvent(created, input.calendarId, true);
      if (event.id !== eventId) throw protocolError(true);
      await atomicJson(file, { ...receipt, state: "completed", event });
      return { event };
    } catch (error) {
      if (error instanceof CalendarServiceError && error.code === "CONFLICT") return this.reconcileCreate(input, file, receipt);
      const state = error instanceof CalendarServiceError && error.writeOutcome === "rejected" ? "rejected" : "unknown";
      try { await atomicJson(file, { ...receipt, state, ...(state === "rejected" && error instanceof CalendarServiceError
        ? { rejectionCode: error.code, rejectionStatus: error.httpStatus } : {}) }); } catch { /* pending is deliberately non-replayable too */ }
      if (error instanceof CalendarServiceError) throw error;
      throw new CalendarServiceError("WRITE_UNKNOWN", "事件可能已创建，但回执未完整保存；请按请求 ID 核对，禁止盲目重试。", 502, "unknown");
    }
  }

  private async reconcileCreate(input: { calendarId: string; inputHash: string; requestHash: string; generation: number },
    file: string, receipt: CreateReceipt): Promise<{ event: CalendarEvent; replayed: true }> {
    this.assertGeneration(input.generation);
    let current: Json;
    try { current = await this.rawEvent(input.calendarId, receipt.eventId, input.generation); }
    catch (error) {
      if (error instanceof CalendarServiceError && error.code === "NOT_FOUND") {
        if (receipt.state === "completed") throw new CalendarServiceError("EVENT_NOT_FOUND", "该请求曾创建的事件已不存在；不会重新创建。", 409, "rejected");
        if (receipt.state === "rejected") throw new CalendarServiceError(receipt.rejectionCode || "PREVIOUS_REQUEST_REJECTED",
          "该请求先前已被明确拒绝，远端没有对应事件；未自动重试，请修正问题并重新确认操作。", receipt.rejectionStatus || 409, "rejected");
      }
      throw new CalendarServiceError("WRITE_UNKNOWN", "该请求已有记录，但尚未核实远端结果；未重复创建，请稍后核对。", 409, "unknown");
    }
    const properties = object(object(current.extendedProperties).private);
    if (properties.harbourRequest !== input.requestHash || properties.harbourInput !== input.inputHash) throw keyConflict();
    if (current.status === "cancelled") throw new CalendarServiceError("EVENT_CANCELLED", "同一请求对应的事件已取消；不会重新创建。", 409, "rejected");
    const event = compactEvent(current, input.calendarId);
    await atomicJson(file, { ...receipt, state: "completed", event });
    return { event, replayed: true };
  }

  private async api(route: string, options: { method?: string; query?: Record<string, string>;
    headers?: Record<string, string>; body?: unknown; write?: boolean; expectedGeneration?: number; beforeWrite?: () => void } = {}): Promise<Json> {
    const auth = await this.access();
    if (options.expectedGeneration !== undefined) this.assertGeneration(options.expectedGeneration);
    const url = new URL(`${API}${route}`);
    if (options.query) url.search = new URLSearchParams(options.query).toString();
    this.assertGeneration(auth.generation);
    if (options.write) options.beforeWrite?.();
    const result = await this.http(url.toString(), { method: options.method ?? "GET",
      headers: { Authorization: `Bearer ${auth.token}`, ...(options.body !== undefined ? { "content-type": "application/json" } : {}), ...options.headers },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }, !!options.write);
    if (auth.generation !== this.generation) {
      if (options.write) throw new CalendarServiceError("WRITE_UNKNOWN", "写入期间 Google Calendar 连接发生变化；原账户操作可能已完成，请核对后再继续。", 409, "unknown");
      this.assertGeneration(auth.generation);
    }
    return result;
  }

  private async http(url: string, init: RequestInit, write: boolean): Promise<Json> {
    let response: Response;
    try { response = await this.fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) }); }
    catch { throw new CalendarServiceError(write ? "WRITE_UNKNOWN" : "GOOGLE_UNAVAILABLE",
      write ? "Google 写入回执未知；可能已执行，请先核对，未自动重试。" : "无法连接 Google Calendar，请检查网络或稍后重试。", 502, write ? "unknown" : undefined); }
    if (!response.ok) {
      const status = response.status;
      const code = status === 401 ? "NOT_CONNECTED" : status === 403 ? "PERMISSION_DENIED" : status === 404 ? "NOT_FOUND"
        : status === 409 ? "CONFLICT" : status === 412 ? "ETAG_MISMATCH" : status === 429 ? "RATE_LIMITED" : "GOOGLE_REJECTED";
      const message = status === 401 ? "Google 授权已失效，请重新连接。" : status === 403 ? "Google Calendar 权限不足，请检查授权范围和日历写权限。"
        : status === 404 ? "Google 日历或事件不存在。" : status === 412 ? "事件版本已变化，请重新读取并确认，未覆盖他人修改。"
          : status === 429 ? "Google Calendar 请求频率受限；未自动重试。" : `Google Calendar 返回 ${status}；未自动重试。`;
      void response.body?.cancel().catch(() => {});
      throw new CalendarServiceError(code, message, status === 401 ? 428 : status === 412 ? 409 : status, write ? (status >= 500 || status === 408 ? "unknown" : "rejected") : undefined);
    }
    if (response.status === 204) return {};
    try {
      const value = JSON.parse(await boundedResponse(response));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value as Json;
    } catch { throw protocolError(write); }
  }
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function assertWriteNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CalendarServiceError("OPERATION_CANCELLED", "日历操作已停止，尚未向 Google 提交本次写入。", 409, "rejected");
}
function object(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function bounded(value: unknown, field: string, length: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > length || /[\u0000-\u001f\u007f]/u.test(value)) throw new CalendarServiceError("INVALID_INPUT", `${field} 无效。`);
  return value.trim();
}
function identifier(value: unknown, field: string): string {
  const result = bounded(value, field, 1024);
  if (result === "." || result === "..") throw new CalendarServiceError("INVALID_INPUT", `${field} 无效。`);
  return result;
}
function eventIdentifier(value: unknown): string {
  const result = bounded(value, "事件 ID", 1024);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) throw new CalendarServiceError("INVALID_INPUT", "事件 ID 无效。");
  return result;
}
function exactEtag(value: unknown): string {
  const result = bounded(value, "事件版本 etag", 256);
  if (!/^"[^"\r\n]+"$/.test(result)) throw new CalendarServiceError("ETAG_REQUIRED", "必须提供读取事件时取得的精确 etag，不能使用通配符。");
  return result;
}
function segment(value: string): string { return encodeURIComponent(value); }
function optionalPage(value: unknown): string | undefined { return typeof value === "string" && value.length <= 4096 && value ? value : undefined; }
function keyConflict(): CalendarServiceError { return new CalendarServiceError("REQUEST_ID_CONFLICT", "该请求 ID 已用于不同内容或与已有事件冲突；未创建重复事件。", 409, "rejected"); }
function protocolError(write = false): CalendarServiceError { return new CalendarServiceError(write ? "WRITE_UNKNOWN" : "GOOGLE_RESPONSE_INVALID",
  write ? "Google 写入回执不完整；可能已执行，未自动重试。" : "Google Calendar 返回了无效结果。", 502, write ? "unknown" : undefined); }
function reminders(value: unknown[]): CalendarReminder[] {
  return value.slice(0, 5).flatMap(item => {
    const row = object(item);
    return (row.method === "popup" || row.method === "email") && typeof row.minutes === "number"
      ? [{ method: row.method, minutes: row.minutes } as CalendarReminder] : [];
  });
}
function compactTime(value: unknown): CalendarEventDateTime {
  const row = object(value);
  return { ...(typeof row.date === "string" ? { date: row.date } : {}),
    ...(typeof row.dateTime === "string" ? { dateTime: row.dateTime } : {}),
    ...(typeof row.timeZone === "string" ? { timeZone: row.timeZone } : {}) };
}
function compactEvent(value: unknown, calendarId: string, write = false): CalendarEvent {
  const row = object(value);
  if (typeof row.id !== "string") throw protocolError(write);
  const output: CalendarEvent = { id: row.id, calendarId, summary: string(row.summary), start: compactTime(row.start), end: compactTime(row.end) };
  if (row.status !== "cancelled" && (!(output.start.date || output.start.dateTime) || !(output.end.date || output.end.dateTime))) throw protocolError(write);
  for (const key of ["description", "location", "etag", "htmlLink", "status", "recurringEventId"] as const) {
    if (typeof row[key] === "string") output[key] = row[key];
  }
  if (Array.isArray(row.recurrence)) output.recurrence = row.recurrence.filter((line): line is string => typeof line === "string").slice(0, 20);
  if (row.reminders && typeof row.reminders === "object") {
    const reminder = object(row.reminders);
    output.reminders = { useDefault: reminder.useDefault === true,
      ...(Array.isArray(reminder.overrides) ? { overrides: reminders(reminder.overrides) } : {}) };
  }
  return output;
}
