import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { WebSocket } from "ws";
import { createCalendarTools } from "../../src/core/tools/calendar";
import { normalizeCalendarCards, recordCalendarCard, snapshotCalendarCards } from "../../src/calendar/cards";
import type { GoogleCalendarService } from "../../src/calendar/service";
import type { ToolContext } from "../../src/types";
import { SessionStore } from "../../src/core/sessionStore";
import { startServer, type ServerDeps } from "../../src/server/api";
import { LogBroadcaster } from "../../src/server/logBroadcaster";

const event = { id: "abc123", calendarId: "primary", summary: "面试准备", etag: '"v1"',
  start: { dateTime: "2026-09-20T15:00:00-04:00", timeZone: "America/New_York" },
  end: { dateTime: "2026-09-20T16:00:00-04:00", timeZone: "America/New_York" } };
const logger = pino({ enabled: false });
function context(): ToolContext {
  return { agent: { name: "main-elaina" } as ToolContext["agent"], logger, permissionMode: "dontAsk",
    source: { channel: "qq", key: "qq:owner", sessionId: "fixture-session", actor: { role: "owner", platform: "qq", id: "fixture" } },
    execution: { calendarCards: new Map() } };
}
function fixture() {
  const calls: Array<{ method: string; input: any }> = [];
  const api = {
    status: async () => ({ configured: true, connected: true }),
    calendars: async () => ({ calendars: [{ id: "primary", summary: "Fixture", timeZone: "America/New_York", accessRole: "owner" }] }),
    events: async (input: any) => { calls.push({ method: "events", input }); return { events: [event], timeZone: "America/New_York", truncated: false }; },
    get: async (input: any) => { calls.push({ method: "get", input }); return { event }; },
    create: async (input: any) => { calls.push({ method: "create", input }); return { event }; },
    update: async (input: any) => { calls.push({ method: "update", input }); return { event }; },
    remove: async (input: any) => { calls.push({ method: "remove", input }); return { removed: true, eventId: event.id, calendarId: "primary" }; },
    findSlots: async () => ({ slots: [{ start: event.start.dateTime, end: event.end.dateTime }], timeZone: "America/New_York" }),
    beginAuth: async () => ({ url: "https://accounts.google.com/o/oauth2/v2/auth?state=fixture" }),
    completeAuth: async (input: any) => { if (input.state !== "valid-once") throw new Error("bad state"); },
    disconnect: async () => { calls.push({ method: "disconnect", input: {} }); },
  } as unknown as GoogleCalendarService;
  return { api, calls, tools: createCalendarTools(api) };
}

test("calendar tools protect private data and deny plan mutations before service calls", async () => {
  const { tools, calls } = fixture();
  for (const tool of tools) {
    for (const role of ["system", "other", undefined]) {
      const ctx = context(); ctx.source!.actor = role ? { role, platform: "qq", id: "fixture" } as any : undefined;
      await assert.rejects(tool.execute({ action: tool.readOnly ? "events" : "create" }, ctx), /主人/);
    }
  }
  const ctx = context(); ctx.permissionMode = "plan";
  await assert.rejects(tools[1]!.execute({ action: "create", requestId: "one", event }, ctx), /plan/);
  assert.equal(calls.length, 0);
  assert.equal(tools[0]!.readOnly, true);
});

test("calendar writes scope stable keys per session; only successful receipts become cards", async () => {
  const { tools, calls, api } = fixture(); const write = tools[1]!, read = tools[0]!, ctx = context();
  await write.execute({ action: "create", requestId: "same-intent", event }, ctx);
  await write.execute({ action: "create", requestId: "same-intent", event }, ctx);
  assert.equal(calls[0]!.input.requestId, calls[1]!.input.requestId);
  ctx.source!.sessionId = "another-session";
  await write.execute({ action: "create", requestId: "same-intent", event }, ctx);
  assert.notEqual(calls[0]!.input.requestId, calls[2]!.input.requestId);
  assert.equal(snapshotCalendarCards(ctx.execution!.calendarCards).length, 1, "same display receipt deduplicates");
  await read.execute({ action: "events", timeMin: event.start.dateTime, timeMax: event.end.dateTime }, ctx);
  assert.equal(snapshotCalendarCards(ctx.execution!.calendarCards).at(-1)!.action, "listed");
  const size = ctx.execution!.calendarCards!.size;
  api.update = async () => { throw new Error("conflict"); };
  await assert.rejects(write.execute({ action: "update", eventId: event.id, etag: event.etag, event }, ctx), /conflict/);
  assert.equal(ctx.execution!.calendarCards!.size, size);
  await assert.rejects(write.execute({ action: "delete", eventId: event.id, etag: event.etag, requestId: "wrong" }, ctx), /未声明/);
});

test("display card normalization discards secrets and non-Google links; bounded content", () => {
  const cards = normalizeCalendarCards([{ action: "created", access_token: "secret", events: [{ ...event, htmlLink: "javascript:alert(1)", description: "not copied", attendees: [{ email: "private" }] }] }]);
  assert.equal(JSON.stringify(cards).includes("secret"), false);
  assert.equal(cards[0]!.events![0]!.htmlLink, undefined);
  assert.equal("attendees" in cards[0]!.events![0]!, false);
  assert.equal(normalizeCalendarCards(Array.from({ length: 30 }, () => ({ action: "listed", events: Array(20).fill(event) }))).length, 12);
  assert.deepEqual(normalizeCalendarCards([{ action: "fake" }]), []);
});

test("calendar card time zone follows the result, then event, then active Harbour run", () => {
  const ctx = context(); ctx.execution!.timeContext = { timeZone: "Asia/Shanghai", at: new Date().toISOString() };
  recordCalendarCard(ctx, { action: "created", events: [event] });
  assert.equal(snapshotCalendarCards(ctx.execution!.calendarCards).at(-1)!.timeZone, "America/New_York");
  recordCalendarCard(ctx, { action: "listed", events: [event], timeZone: "Europe/London" });
  assert.equal(snapshotCalendarCards(ctx.execution!.calendarCards).at(-1)!.timeZone, "Europe/London");
  recordCalendarCard(ctx, { action: "created", events: [{ ...event, start: { dateTime: event.start.dateTime }, end: { dateTime: event.end.dateTime } }] });
  assert.equal(snapshotCalendarCards(ctx.execution!.calendarCards).at(-1)!.timeZone, "Asia/Shanghai");
});

test("calendar receipts survive local history reload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harbour-calendar-history-"));
  try {
    const store = new SessionStore(logger, root); await store.init();
    const session = store.resolveActive("web:fixture", { channel: "web", agentName: "main-elaina" });
    store.appendTurn(session, "schedule", "done", undefined, undefined, undefined, undefined, undefined, "run-1", [{ action: "created", events: [event] }]);
    await store.flush();
    const next = new SessionStore(logger, root); await next.init();
    assert.equal(next.get(session.id)!.messages.at(-1)!.calendarCards![0]!.events![0]!.summary, event.summary);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("harbour-calendar-history-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function unusedPort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
test("calendar HTTP auth and cross-origin guards; only OAuth state callback bypasses bearer", async () => {
  const { api, calls } = fixture(); const port = await unusedPort(), token = "fixture-secret";
  const server = startServer({ port, host: "127.0.0.1", logger, broadcaster: new LogBroadcaster(),
    runtime: { asks: { onChange() {} }, calendar: api }, env: { WEB_AUTH_TOKEN: token, WEB_CORS: true },
    queue: {}, heartbeat: {}, channels: [], startedAt: Date.now(),
  } as unknown as ServerDeps);
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(base + "/api/calendar/status")).status, 401);
    const auth = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(base + "/api/calendar/status", { headers: auth })).status, 200);
    const cross = await fetch(base + "/api/calendar/disconnect", { method: "POST", headers: { ...auth, Origin: "https://evil.invalid" } });
    assert.equal(cross.status, 403); assert.equal(cross.headers.get("access-control-allow-origin"), null); assert.equal(calls.length, 0);
    assert.equal((await fetch(base + "/api/calendar/oauth/callback?state=invalid&code=private")).status, 400);
    const callback = await fetch(base + "/api/calendar/oauth/callback?state=valid-once&code=private");
    assert.equal(callback.status, 200); assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
    assert.equal((await callback.text()).includes("private"), false);
    assert.equal((await fetch(base + "/api/calendar/slots?calendarIds=bad", { headers: auth })).status, 400);
    const wrong = await fetch(base + "/api/calendar/events", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ event, token: "must-not-pass" }) });
    assert.equal(wrong.status, 400);
  } finally { await server.close(); }
});

test("tokenless loopback rejects cross-site calendar access through generic APIs and WebSocket", async () => {
  const { api } = fixture(); const port = await unusedPort();
  const server = startServer({ port, host: "127.0.0.1", logger, broadcaster: new LogBroadcaster(),
    runtime: { asks: { onChange() {} }, calendar: api }, env: { WEB_AUTH_TOKEN: "", WEB_CORS: true },
    queue: {}, heartbeat: {}, channels: [], startedAt: Date.now(),
  } as unknown as ServerDeps);
  const base = `http://127.0.0.1:${port}`;
  const socketClose = (origin?: string) => new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin === undefined ? {} : { origin });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("WebSocket fixture timeout")); }, 3000);
    socket.once("error", error => { clearTimeout(timer); reject(error); });
    socket.once("close", code => { clearTimeout(timer); resolve(code); });
    if (origin === undefined || origin === base) socket.once("open", () => socket.close(1000));
  });
  try {
    for (const origin of ["https://evil.invalid", "null", "file://"]) {
      for (const [pathname, method] of [["/api/run", "POST"], ["/api/conversations/private", "GET"], ["/api/calendar/status", "GET"], ["/uploads/private.png", "GET"]]) {
        const response = await fetch(base + pathname, { method, headers: { Origin: origin } });
        assert.equal(response.status, 403); assert.equal(response.headers.get("access-control-allow-origin"), null);
      }
      assert.equal(await socketClose(origin), 4003);
    }
    assert.equal((await fetch(base + "/api/calendar/status")).status, 200, "native local requests stay supported");
    assert.equal((await fetch(base + "/api/calendar/status", { headers: { Origin: base, "Sec-Fetch-Site": "same-origin" } })).status, 200);
    assert.equal((await fetch(base + "/api/conversations/private", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await fetch(base + "/api/calendar/status", { headers: { Host: `rebound.invalid:${port}`, Origin: `http://rebound.invalid:${port}` } })).status, 403);
    assert.equal(await socketClose(), 1000);
    assert.equal(await socketClose(base), 1000);
    assert.equal((await fetch(base + "/api/calendar/oauth/callback?state=valid-once&code=fixture", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 200, "OAuth remains state-authenticated");
  } finally { await server.close(); }
});
