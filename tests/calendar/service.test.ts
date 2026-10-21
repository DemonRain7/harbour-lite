import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { CalendarServiceError, GOOGLE_CALENDAR_SCOPES, GoogleCalendarService } from "../../src/calendar/service";
import type { CalendarEventInput } from "../../src/calendar/types";

const event: CalendarEventInput = { summary: "Fixture personal task", start: { dateTime: "2026-09-21T09:00:00-04:00", timeZone: "America/New_York" },
  end: { dateTime: "2026-09-21T10:00:00-04:00", timeZone: "America/New_York" } };
const token = () => ({ access_token: "ACCESS_SECRET_SENTINEL", refresh_token: "REFRESH_SECRET_SENTINEL", expires_in: 3600,
  token_type: "Bearer", scope: GOOGLE_CALENDAR_SCOPES.join(" ") });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const errorCode = (code: string, outcome?: string) => (error: unknown) => error instanceof CalendarServiceError
  && error.code === code && (outcome === undefined || error.writeOutcome === outcome);
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
interface Call { url: URL; method: string; headers: Headers; body: string }

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "harbour-calendar-"));
  let now = Date.parse("2026-09-17T12:00:00Z");
  const calls: Call[] = [];
  let handler: (call: Call) => Response | Promise<Response> = call => {
    if (call.url.hostname === "oauth2.googleapis.com" && call.url.pathname === "/token") return json(token());
    if (call.url.pathname === "/revoke") return new Response(null, { status: 200 });
    throw new Error(`Unexpected fixture request: ${call.method} ${call.url.pathname}`);
  };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: new URL(input instanceof Request ? input.url : String(input)), method: init?.method ?? "GET",
      headers: new Headers(init?.headers), body: String(init?.body ?? "") };
    assert.equal(init?.redirect, "error", "never redirect credential-bearing requests");
    assert.ok(["oauth2.googleapis.com", "www.googleapis.com"].includes(call.url.hostname));
    calls.push(call); return handler(call);
  }) as typeof fetch;
  const options = { dataDir: directory, clientId: "fixture-client", clientSecret: "CLIENT_SECRET_SENTINEL", fetch: fetcher, now: () => now };
  const service = new GoogleCalendarService(options);
  const connect = async (target = service) => {
    const auth = new URL((await target.beginAuth()).url);
    await target.completeAuth({ state: auth.searchParams.get("state")!, code: "CODE_SECRET_SENTINEL" });
    return auth;
  };
  t.after(async () => {
    assert.ok(path.basename(directory).startsWith("harbour-calendar-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, options, service, calls, connect, set: (next: typeof handler) => { handler = next; }, advance: (ms: number) => { now += ms; } };
}

test("unconfigured service exposes setup only, rejects unsafe redirects and emits no credentials", async t => {
  const f = await fixture(t);
  const service = new GoogleCalendarService({ dataDir: f.directory, redirectUri: "http://example.com/callback?token=SECRET" });
  const status = await service.status();
  assert.equal(status.configured, false); assert.equal(status.connected, false);
  assert.deepEqual(status.missing, ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_CALENDAR_REDIRECT_URI"]);
  assert.doesNotMatch(status.redirectUri, /SECRET|token=/);
  await assert.rejects(service.beginAuth(), errorCode("NOT_CONFIGURED"));
  await assert.rejects(f.service.calendars(), errorCode("NOT_CONNECTED"));
  assert.equal(f.calls.length, 0);
});

test("OAuth uses state+S256 PKCE, consumes callbacks once and stores secrets only locally", async t => {
  const f = await fixture(t);
  const auth = new URL((await f.service.beginAuth()).url);
  assert.equal(auth.origin, "https://accounts.google.com");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(auth.searchParams.get("access_type"), "offline");
  assert.equal(auth.searchParams.get("redirect_uri"), "http://localhost:7788/api/calendar/oauth/callback");
  assert.doesNotMatch(auth.toString(), /CLIENT_SECRET_SENTINEL/);
  await assert.rejects(f.service.completeAuth({ state: "bad", code: "bad" }), errorCode("OAUTH_STATE_INVALID"));
  const state = auth.searchParams.get("state")!;
  await f.service.completeAuth({ state, code: "CODE_SECRET_SENTINEL" });
  const exchange = new URLSearchParams(f.calls[0]!.body);
  assert.equal(createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url"), auth.searchParams.get("code_challenge"));
  assert.equal(exchange.get("client_secret"), "CLIENT_SECRET_SENTINEL");
  const status = await f.service.status();
  assert.equal(status.connected, true);
  assert.doesNotMatch(JSON.stringify(status), /SECRET|code_verifier|state/);
  await assert.rejects(f.service.completeAuth({ state, code: "replay" }), errorCode("OAUTH_STATE_INVALID"));
  assert.equal(f.calls.length, 1);
  assert.ok((await fs.readFile(path.join(f.directory, "tokens.json"), "utf8")).includes("REFRESH_SECRET_SENTINEL"));
  assert.equal((await new GoogleCalendarService(f.options).status()).connected, true);
});

test("OAuth denial, expiry, partial scopes and overlapping attempts cannot silently connect", async t => {
  const f = await fixture(t);
  let auth = new URL((await f.service.beginAuth()).url);
  await assert.rejects(f.service.completeAuth({ state: auth.searchParams.get("state")!, error: "attacker text SECRET" }), errorCode("OAUTH_DENIED"));
  await assert.rejects(f.service.completeAuth({ state: auth.searchParams.get("state")!, code: "replay" }), errorCode("OAUTH_STATE_INVALID"));
  auth = new URL((await f.service.beginAuth()).url); f.advance(10 * 60_000);
  await assert.rejects(f.service.completeAuth({ state: auth.searchParams.get("state")!, code: "expired" }), errorCode("OAUTH_STATE_INVALID"));
  const stale = new URL((await f.service.beginAuth()).url);
  auth = new URL((await f.service.beginAuth()).url);
  await assert.rejects(f.service.completeAuth({ state: stale.searchParams.get("state")!, code: "old" }), errorCode("OAUTH_STATE_INVALID"));
  f.set(() => json({ ...token(), scope: GOOGLE_CALENDAR_SCOPES[0] }));
  await assert.rejects(f.service.completeAuth({ state: auth.searchParams.get("state")!, code: "partial" }), errorCode("OAUTH_INCOMPLETE"));
  assert.equal((await f.service.status()).connected, false);
  assert.equal(f.calls.length, 1);
});

test("disconnect invalidates in-flight OAuth and prevents token resurrection", async t => {
  const f = await fixture(t); const started = gate(); const finish = gate();
  f.set(async () => { started.resolve(); await finish.promise; return json(token()); });
  const auth = new URL((await f.service.beginAuth()).url);
  const complete = f.service.completeAuth({ state: auth.searchParams.get("state")!, code: "inflight" });
  const rejected = assert.rejects(complete, errorCode("CONNECTION_CHANGED"));
  await started.promise; await f.service.disconnect(); finish.resolve(); await rejected;
  assert.equal((await f.service.status()).connected, false);
  await assert.rejects(fs.stat(path.join(f.directory, "tokens.json")), { code: "ENOENT" });
});

test("expired-token refresh is coalesced and never exposes tokens in status or public errors", async t => {
  const f = await fixture(t); await f.connect(); f.advance(3600_000);
  const started = gate(); const finish = gate(); let refreshes = 0;
  f.set(async call => {
    if (call.url.pathname === "/token") {
      refreshes++; assert.equal(new URLSearchParams(call.body).get("grant_type"), "refresh_token");
      started.resolve(); await finish.promise; return json({ access_token: "NEW_ACCESS_SECRET", expires_in: 3600 });
    }
    assert.equal(call.headers.get("authorization"), "Bearer NEW_ACCESS_SECRET");
    return json({ items: [{ id: "fixture@calendar", summary: "Fixture", timeZone: "UTC", accessRole: "owner", primary: true }] });
  });
  const a = f.service.calendars(); const b = f.service.calendars();
  await started.promise; finish.resolve();
  assert.equal((await a).calendars[0]!.id, "fixture@calendar"); await b;
  assert.equal(refreshes, 1);
  assert.doesNotMatch(JSON.stringify(await f.service.status()), /SECRET/);
  f.set(() => json({ error: { message: "CLIENT_SECRET_SENTINEL ACCESS_SECRET_SENTINEL" } }, 403));
  await assert.rejects(f.service.calendars(), error => error instanceof CalendarServiceError && error.code === "PERMISSION_DENIED" && !/SECRET/.test(error.message));
});

test("disconnect wins against refresh and revokes saved tokens even before lazy status load", async t => {
  const f = await fixture(t); await f.connect(); f.advance(3600_000);
  const started = gate(); const finish = gate(); let revoked = 0;
  f.set(async call => {
    if (call.url.pathname === "/revoke") { revoked++; return new Response(null, { status: 200 }); }
    started.resolve(); await finish.promise; return json({ access_token: "RESURRECT_SECRET", expires_in: 3600 });
  });
  const reading = f.service.calendars(); const rejected = assert.rejects(reading, errorCode("CONNECTION_CHANGED"));
  await started.promise; await f.service.disconnect(); finish.resolve(); await rejected;
  assert.equal(revoked, 1); assert.equal((await f.service.status()).connected, false);
  f.set(call => call.url.pathname === "/token" ? json(token()) : new Response(null, { status: 200 }));
  await f.connect();
  const uninitialized = new GoogleCalendarService(f.options);
  await uninitialized.disconnect();
  await assert.rejects(fs.stat(path.join(f.directory, "tokens.json")), { code: "ENOENT" });
});

test("create persists a reservation, uses deterministic IDs/default reminders and coalesces retries", async t => {
  const f = await fixture(t); await f.connect(); const started = gate(); const finish = gate(); let posts = 0;
  let created: Record<string, unknown> | undefined;
  f.set(async call => {
    if (call.method === "GET") return json({ ...created, summary: "Edited on phone", etag: '"phone"' });
    posts++; assert.equal(call.method, "POST"); assert.equal(call.url.searchParams.get("sendUpdates"), "none");
    const body = JSON.parse(call.body);
    assert.match(body.id, /^h[0-9a-f]{64}$/);
    assert.deepEqual(body.reminders, { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] });
    assert.equal(body.attendees, undefined);
    const files = await fs.readdir(path.join(f.directory, "requests"));
    assert.equal(files.length, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, "requests", files[0]!), "utf8")).state, "pending");
    started.resolve(); await finish.promise;
    created = { ...body, etag: '"created"', htmlLink: "https://calendar.google.com/calendar/event?eid=fixture" };
    return json(created);
  });
  const first = f.service.create({ requestId: "request-001", event });
  await started.promise;
  const second = f.service.create({ requestId: "request-001", event });
  await assert.rejects(f.service.create({ requestId: "request-001", event: { ...event, summary: "different" } }), errorCode("REQUEST_ID_CONFLICT"));
  finish.resolve(); const result = await first;
  assert.deepEqual(await second, result); assert.equal(posts, 1);
  const restart = new GoogleCalendarService(f.options);
  const replay = await restart.create({ requestId: "request-001", event });
  assert.equal(replay.replayed, true); assert.equal(replay.event.id, result.event.id); assert.equal(posts, 1);
  assert.equal(replay.event.summary, "Edited on phone", "repeated requests observe the canonical current event, not a stale cached creation");
  assert.equal((replay.event as unknown as Record<string, unknown>).extendedProperties, undefined);
});

test("unknown create never posts again; read reconciliation confirms the exact request and content", async t => {
  const f = await fixture(t); await f.connect(); let written: Record<string, unknown> | undefined; let posts = 0;
  f.set(call => {
    if (call.method === "POST") { posts++; written = JSON.parse(call.body); throw new Error("network reply lost SECRET"); }
    return json({ ...written, etag: '"reconciled"' });
  });
  await assert.rejects(f.service.create({ requestId: "unknown-request", event }), errorCode("WRITE_UNKNOWN", "unknown"));
  const restarted = new GoogleCalendarService(f.options);
  const replay = await restarted.create({ requestId: "unknown-request", event });
  assert.equal(replay.replayed, true); assert.equal(posts, 1);
  assert.equal(replay.event.id, written!.id);
});

test("409 creation conflicts require exact private markers; unknown missing results never replay writes", async t => {
  const f = await fixture(t); await f.connect(); let posts = 0;
  f.set(call => { if (call.method === "POST") { posts++; return json({}, 409); } return json({ ...event, id: "unrelated", etag: '"one"' }); });
  await assert.rejects(f.service.create({ requestId: "collision", event }), errorCode("REQUEST_ID_CONFLICT"));
  assert.equal(posts, 1);
  f.set(call => { if (call.method === "POST") { posts++; throw new Error("lost"); } return json({}, 404); });
  await assert.rejects(f.service.create({ requestId: "unknown-404", event }), errorCode("WRITE_UNKNOWN", "unknown"));
  await assert.rejects(f.service.create({ requestId: "unknown-404", event }), errorCode("WRITE_UNKNOWN", "unknown"));
  assert.equal(posts, 2);
});

test("invalid dates, invitations and oversized windows are rejected before HTTP", async t => {
  const f = await fixture(t); await f.connect(); const before = f.calls.length;
  await assert.rejects(f.service.create({ requestId: "bad", event: { ...event, attendees: [{ email: "someone@example.com" }] } as CalendarEventInput }), errorCode("INVALID_INPUT"));
  await assert.rejects(f.service.create({ requestId: "bad", event: { ...event, start: { dateTime: "2026-03-08T02:30:00-05:00", timeZone: "America/New_York" } } }), errorCode("INVALID_INPUT"));
  await assert.rejects(f.service.events({ timeMin: "2026-01-01T00:00:00Z", timeMax: "2027-01-01T00:00:00Z" }), errorCode("INVALID_INPUT"));
  await assert.rejects(f.service.remove({ eventId: "fixture", etag: "*" }), errorCode("ETAG_REQUIRED"));
  assert.equal(f.calls.length, before);
});

test("update/delete require etags, preserve unrelated fields, permit explicit instances and reject masters/meetings", async t => {
  const f = await fixture(t); await f.connect(); let current: Record<string, unknown> = { ...event, id: "instance_20260921T130000Z", recurringEventId: "series", etag: '"v1"' };
  const writes: Call[] = [];
  f.set(call => {
    if (call.method === "GET") return json(current);
    writes.push(call); assert.equal(call.headers.get("If-Match"), '"v1"'); assert.equal(call.url.searchParams.get("sendUpdates"), "none");
    return call.method === "DELETE" ? new Response(null, { status: 204 }) : json({ ...current, ...JSON.parse(call.body), etag: '"v2"' });
  });
  const updated = await f.service.update({ eventId: current.id as string, etag: '"v1"', event: { ...event, summary: "Moved personal instance" } });
  assert.equal(updated.event.recurringEventId, "series"); assert.equal(writes[0]!.method, "PATCH");
  assert.equal(JSON.parse(writes[0]!.body).reminders, undefined, "update does not reset existing reminder policy");
  await f.service.remove({ eventId: current.id as string, etag: '"v1"' }); assert.equal(writes[1]!.method, "DELETE");
  await assert.rejects(f.service.update({ eventId: current.id as string, etag: '"stale"', event }), errorCode("ETAG_MISMATCH", "rejected"));
  current = { ...event, id: "series", etag: '"v1"', recurrence: ["RRULE:FREQ=DAILY;COUNT=2"] };
  await assert.rejects(f.service.remove({ eventId: "series", etag: '"v1"' }), errorCode("SERIES_UNSUPPORTED", "rejected"));
  current = { ...event, id: "meeting", etag: '"v1"', attendees: [{ email: "someone@example.com" }] };
  await assert.rejects(f.service.update({ eventId: "meeting", etag: '"v1"', event }), errorCode("ATTENDEES_UNSUPPORTED", "rejected"));
  assert.equal(writes.length, 2);
});

test("Google etag conflict and unknown PATCH results are surfaced once without retry", async t => {
  const f = await fixture(t); await f.connect(); let mutations = 0;
  f.set(call => {
    if (call.method === "GET") return json({ ...event, id: "fixture", etag: '"v1"' });
    mutations++; return json({}, 412);
  });
  await assert.rejects(f.service.update({ eventId: "fixture", etag: '"v1"', event }), errorCode("ETAG_MISMATCH", "rejected"));
  assert.equal(mutations, 1);
  f.set(call => {
    if (call.method === "GET") return json({ ...event, id: "fixture", etag: '"v1"' });
    mutations++; throw new Error("lost response");
  });
  await assert.rejects(f.service.update({ eventId: "fixture", etag: '"v1"', event }), errorCode("WRITE_UNKNOWN", "unknown"));
  assert.equal(mutations, 2);
});

test("a connection change between preflight and mutation never writes into another account", async t => {
  const f = await fixture(t); await f.connect(); let mutations = 0;
  f.set(async call => {
    if (call.method === "GET") { await f.service.disconnect(); return json({ ...event, id: "fixture", etag: '"v1"' }); }
    if (call.url.pathname === "/revoke") return new Response(null, { status: 200 });
    mutations++; return json({});
  });
  await assert.rejects(f.service.update({ eventId: "fixture", etag: '"v1"', event }), error => error instanceof CalendarServiceError && ["CONNECTION_CHANGED", "NOT_CONNECTED"].includes(error.code));
  assert.equal(mutations, 0);
});

test("events expand recurring instances, bound pagination and preserve calendar/time-zone metadata", async t => {
  const f = await fixture(t); await f.connect(); let pages = 0;
  f.set(call => {
    pages++; assert.equal(call.url.searchParams.get("singleEvents"), "true"); assert.equal(call.url.searchParams.get("maxResults"), "250");
    assert.equal(call.url.searchParams.get("orderBy"), "startTime");
    return json({ items: [{ ...event, id: `instance${pages}`, recurringEventId: "series", etag: '"v1"' }], timeZone: "America/New_York", nextPageToken: `page-${pages}` });
  });
  const result = await f.service.events({ calendarId: "fixture@example.com", timeMin: "2026-09-01T00:00:00Z", timeMax: "2026-10-01T00:00:00Z", q: "Fixture" });
  assert.equal(pages, 4); assert.equal(result.truncated, true); assert.equal(result.events.length, 4);
  assert.equal(result.events[0]!.calendarId, "fixture@example.com"); assert.equal(result.timeZone, "America/New_York");
});

test("freebusy fails closed for partial errors and returns offset-explicit personal work slots", async t => {
  const f = await fixture(t); await f.connect(); let failing = true;
  f.set(call => {
    assert.equal(call.url.pathname, "/calendar/v3/freeBusy");
    const body = JSON.parse(call.body); assert.deepEqual(body.items, [{ id: "primary" }]);
    return json({ calendars: { primary: failing ? { errors: [{ reason: "forbidden" }] }
      : { busy: [{ start: "2026-09-21T13:00:00Z", end: "2026-09-21T14:00:00Z" }] } } });
  });
  const request = { timeMin: "2026-09-21T12:00:00Z", timeMax: "2026-09-21T22:00:00Z", durationMinutes: 60, timeZone: "America/New_York" };
  await assert.rejects(f.service.findSlots(request), errorCode("FREEBUSY_UNAVAILABLE"));
  failing = false;
  const result = await f.service.findSlots(request);
  assert.ok(result.slots.length > 0); assert.match(result.slots[0]!.start, /T10:00:00\.000-04:00$/);
  assert.equal(result.timeZone, "America/New_York");
});

test("corrupt local credentials fail closed and disconnect never leaks revocation failures", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, "tokens.json"), "broken SECRET");
  const status = await f.service.status();
  assert.equal(status.connected, false); assert.doesNotMatch(JSON.stringify(status), /SECRET/);
  f.set(() => { throw new Error("TOKEN_SECRET raw transport detail"); });
  await f.service.disconnect();
  await assert.rejects(fs.stat(path.join(f.directory, "tokens.json")), { code: "ENOENT" });
});

test("invalid refresh grants clear only the expired connection; transient errors retain it", async t => {
  const f = await fixture(t); await f.connect(); f.advance(3600_000);
  f.set(() => json({ error: "invalid_grant", error_description: "SECRET provider details" }, 400));
  await assert.rejects(f.service.calendars(), error => error instanceof CalendarServiceError
    && error.code === "OAUTH_EXPIRED" && error.httpStatus === 428 && !error.message.includes("SECRET"));
  assert.equal((await f.service.status()).connected, false);
  assert.match((await f.service.status()).connectionError!, /重新连接/);
  await assert.rejects(fs.stat(path.join(f.directory, "tokens.json")), { code: "ENOENT" });
  f.set(() => json(token())); await f.connect(); f.advance(3600_000);
  f.set(() => json({}, 503));
  await assert.rejects(f.service.calendars(), errorCode("GOOGLE_REJECTED"));
  assert.equal((await f.service.status()).connected, true, "transient Google outage does not revoke the connection");
});

test("late invalid-grant refresh cannot disconnect a newly authorized account", async t => {
  const f = await fixture(t); await f.connect(); f.advance(3600_000);
  const started = gate(); const finish = gate();
  f.set(async call => {
    if (new URLSearchParams(call.body).get("grant_type") === "refresh_token") {
      started.resolve(); await finish.promise; return json({ error: "invalid_grant" }, 400);
    }
    return json({ ...token(), access_token: "NEW_ACCOUNT_ACCESS" });
  });
  const old = f.service.calendars(); const rejected = assert.rejects(old, errorCode("OAUTH_EXPIRED"));
  await started.promise; await f.connect(); finish.resolve(); await rejected;
  assert.equal((await f.service.status()).connected, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, "tokens.json"), "utf8")).accessToken, "NEW_ACCOUNT_ACCESS");
});

test("new consent waits for an already-writing token commit instead of leaving rejected tokens on disk", async t => {
  const f = await fixture(t); const started = gate(); const finish = gate();
  const rename = fs.rename.bind(fs); let blocked = false;
  const mock = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (!blocked && String(args[1]) === path.join(f.directory, "tokens.json")) {
      blocked = true; started.resolve(); await finish.promise;
    }
    return rename(...args);
  });
  try {
    const old = f.connect(); await started.promise;
    let newStarted = false;
    const next = f.service.beginAuth().then(result => { newStarted = true; return result; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(newStarted, false, "superseding consent is ordered after the durable commit");
    finish.resolve(); await old;
    const nextAuth = new URL((await next).url);
    await assert.rejects(f.service.completeAuth({ state: nextAuth.searchParams.get("state")!, error: "access_denied" }), errorCode("OAUTH_DENIED"));
    assert.equal((await f.service.status()).connected, true, "previously completed consent remains valid after later denial");
    assert.equal((await new GoogleCalendarService(f.options).status()).connected, true);
  } finally { finish.resolve(); mock.mock.restore(); }
});

test("disconnect beats a concurrent lazy credential read", async t => {
  const f = await fixture(t); await f.connect();
  const fresh = new GoogleCalendarService(f.options); const started = gate(); const finish = gate();
  const read = fs.readFile.bind(fs); let blocked = false;
  const mock = t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    const result = await read(...args);
    if (!blocked && String(args[0]) === path.join(f.directory, "tokens.json")) {
      blocked = true; started.resolve(); await finish.promise;
    }
    return result;
  });
  try {
    const status = fresh.status(); await started.promise; await fresh.disconnect(); finish.resolve();
    assert.equal((await status).connected, false);
    assert.equal((await fresh.status()).connected, false);
    await assert.rejects(fs.stat(path.join(f.directory, "tokens.json")), { code: "ENOENT" });
  } finally { finish.resolve(); mock.mock.restore(); }
});

test("connection changes discard old read results and mark attempted writes unknown", async t => {
  const f = await fixture(t); await f.connect(); const started = gate(); const finish = gate();
  f.set(async call => {
    if (call.url.pathname === "/revoke") return new Response(null, { status: 200 });
    started.resolve(); await finish.promise;
    return json({ items: [{ id: "old-account", summary: "OLD PRIVATE DATA", timeZone: "UTC", accessRole: "owner" }] });
  });
  const reading = f.service.calendars(); const rejectedRead = assert.rejects(reading, errorCode("CONNECTION_CHANGED"));
  await started.promise; await f.service.disconnect(); finish.resolve(); await rejectedRead;
  f.set(() => json(token())); await f.connect();
  const writeStarted = gate(); const writeFinish = gate(); let posts = 0;
  f.set(async call => {
    if (call.url.pathname === "/revoke") return new Response(null, { status: 200 });
    posts++; writeStarted.resolve(); await writeFinish.promise; return json({ ...JSON.parse(call.body), etag: '"created"' });
  });
  const writing = f.service.create({ requestId: "disconnect-during-write", event });
  const rejectedWrite = assert.rejects(writing, errorCode("WRITE_UNKNOWN", "unknown"));
  await writeStarted.promise; await f.service.disconnect(); writeFinish.resolve(); await rejectedWrite;
  assert.equal(posts, 1);
  const files = await fs.readdir(path.join(f.directory, "requests"));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, "requests", files[0]!), "utf8")).state, "unknown");
});

test("deleted completed requests do not recreate, and known rejected retries remain rejected", async t => {
  const f = await fixture(t); await f.connect(); let posts = 0;
  f.set(call => {
    if (call.method === "POST") { posts++; return json({ ...JSON.parse(call.body), etag: '"created"' }); }
    return json({}, 404);
  });
  await f.service.create({ requestId: "phone-deleted", event });
  await assert.rejects(f.service.create({ requestId: "phone-deleted", event }), errorCode("EVENT_NOT_FOUND", "rejected"));
  assert.equal(posts, 1);
  f.set(call => { if (call.method === "POST") { posts++; return json({}, 403); } return json({}, 404); });
  await assert.rejects(f.service.create({ requestId: "known-rejected", event }), errorCode("PERMISSION_DENIED", "rejected"));
  await assert.rejects(f.service.create({ requestId: "known-rejected", event }), errorCode("PERMISSION_DENIED", "rejected"));
  assert.equal(posts, 2);
});

test("request reservation failure prevents writes, and auth failures never use Harbour HTTP 401", async t => {
  const f = await fixture(t); await f.connect(); let writes = 0;
  f.set(() => { writes++; return json({}, 401); });
  const open = fs.open.bind(fs);
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).includes(`${path.sep}requests${path.sep}`)) throw Object.assign(new Error("private path SECRET"), { code: "EACCES" });
    return open(...args);
  });
  try { await assert.rejects(f.service.create({ requestId: "disk-failure", event }), errorCode("LOCAL_STATE_FAILED", "rejected")); }
  finally { mock.mock.restore(); }
  assert.equal(writes, 0);
  await assert.rejects(f.service.calendars(), error => error instanceof CalendarServiceError && error.code === "NOT_CONNECTED" && error.httpStatus === 428);
  const wrongPath = new GoogleCalendarService({ ...f.options, redirectUri: "http://localhost:7788/unhandled-callback" });
  assert.equal((await wrongPath.status()).configured, false);
});

test("one account generation is pinned across calendar and event pagination", async t => {
  const f = await fixture(t); await f.connect(); let requests = 0;
  f.set(call => {
    requests++;
    return json(call.url.pathname.endsWith("calendarList")
      ? { items: [{ id: "first-account", summary: "private", timeZone: "UTC", accessRole: "owner" }], nextPageToken: "old-account-page" }
      : { items: [{ ...event, id: "first-account-event" }], nextPageToken: "old-account-page" });
  });
  const boundary = f.service as unknown as { api: (...args: unknown[]) => Promise<unknown> };
  const api = boundary.api.bind(f.service);
  let switched = false;
  const mock = t.mock.method(boundary, "api", async (...args: unknown[]) => {
    const response = await api(...args);
    if (!switched) { switched = true; await f.service.beginAuth(); }
    return response;
  });
  try {
    await assert.rejects(f.service.calendars(), errorCode("CONNECTION_CHANGED"));
    assert.equal(requests, 1, "old account page tokens never reach the replacement connection");
    switched = false;
    await assert.rejects(f.service.events({ timeMin: "2026-09-01T00:00:00Z", timeMax: "2026-10-01T00:00:00Z" }), errorCode("CONNECTION_CHANGED"));
    assert.equal(requests, 2);
  } finally { mock.mock.restore(); }
});

test("new consent waits for pending disconnect revocation", async t => {
  const f = await fixture(t); await f.connect(); const started = gate(); const finish = gate();
  f.set(async call => {
    assert.equal(call.url.pathname, "/revoke"); started.resolve(); await finish.promise;
    return new Response(null, { status: 200 });
  });
  const disconnected = f.service.disconnect(); await started.promise;
  let consentReturned = false;
  const consent = f.service.beginAuth().then(result => { consentReturned = true; return result; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(consentReturned, false);
  finish.resolve(); await disconnected; await consent;
  assert.equal((await f.service.status()).connected, false);
});

for (const action of ["create", "update", "remove"] as const) {
  test(`stopping ${action} during credential refresh prevents every Calendar request`, async t => {
    const f = await fixture(t); await f.connect(); f.advance(3600_000);
    const started = gate(); const finish = gate(); const controller = new AbortController(); let requests = 0;
    f.set(async call => {
      if (call.url.pathname === "/token") { started.resolve(); await finish.promise; return json(token()); }
      requests++; return json({});
    });
    const writing = action === "create" ? f.service.create({ requestId: "stop-refresh", event }, { signal: controller.signal })
      : action === "update" ? f.service.update({ eventId: "fixture", etag: '"v1"', event }, { signal: controller.signal })
        : f.service.remove({ eventId: "fixture", etag: '"v1"' }, { signal: controller.signal });
    const rejected = assert.rejects(writing, errorCode("OPERATION_CANCELLED", "rejected"));
    await started.promise; controller.abort(); finish.resolve(); await rejected;
    assert.equal(requests, 0);
  });
}

for (const action of ["update", "remove"] as const) {
  test(`stopping ${action} during read preflight never submits the later mutation`, async t => {
    const f = await fixture(t); await f.connect(); const started = gate(); const finish = gate();
    const controller = new AbortController(); let writes = 0;
    f.set(async call => {
      if (call.method === "GET") { started.resolve(); await finish.promise; return json({ ...event, id: "fixture", etag: '"v1"' }); }
      writes++; return action === "remove" ? new Response(null, { status: 204 }) : json({ ...event, id: "fixture", etag: '"v2"' });
    });
    const writing = action === "update" ? f.service.update({ eventId: "fixture", etag: '"v1"', event }, { signal: controller.signal })
      : f.service.remove({ eventId: "fixture", etag: '"v1"' }, { signal: controller.signal });
    const rejected = assert.rejects(writing, errorCode("OPERATION_CANCELLED", "rejected"));
    await started.promise; controller.abort(); finish.resolve(); await rejected;
    assert.equal(writes, 0);
  });
}

test("stopping after a create reservation records a known rejection without touching Google", async t => {
  const f = await fixture(t); await f.connect(); const controller = new AbortController(); let writes = 0;
  f.set(() => { writes++; return json({}); });
  const open = fs.open.bind(fs);
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]).includes(`${path.sep}requests${path.sep}`) && String(args[0]).endsWith(".json")) {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => { await sync(); controller.abort(); });
    }
    return handle;
  });
  try {
    await assert.rejects(f.service.create({ requestId: "stop-reserved", event }, { signal: controller.signal }), errorCode("OPERATION_CANCELLED", "rejected"));
  } finally { mock.mock.restore(); }
  assert.equal(writes, 0);
  const files = await fs.readdir(path.join(f.directory, "requests"));
  const receipt = JSON.parse(await fs.readFile(path.join(f.directory, "requests", files[0]!), "utf8"));
  assert.equal(receipt.state, "rejected");
  assert.equal(receipt.rejectionCode, "OPERATION_CANCELLED");
});

for (const outcome of ["success", "unknown"] as const) {
  test(`stop after create submission preserves ${outcome} receipts for the original and coalesced callers`, async t => {
    const f = await fixture(t); await f.connect(); const started = gate(); const finish = gate();
    const owner = new AbortController(); const follower = new AbortController(); let writes = 0;
    f.set(async call => {
      writes++; started.resolve(); await finish.promise;
      if (outcome === "unknown") throw new Error("provider reply lost after submission");
      return json({ ...JSON.parse(call.body), etag: '"committed"' });
    });
    const first = f.service.create({ requestId: "submitted-once", event }, { signal: owner.signal });
    const firstRejected = outcome === "unknown" ? assert.rejects(first, errorCode("WRITE_UNKNOWN", "unknown")) : undefined;
    await started.promise;
    const second = f.service.create({ requestId: "submitted-once", event }, { signal: follower.signal });
    const secondRejected = outcome === "unknown" ? assert.rejects(second, errorCode("WRITE_UNKNOWN", "unknown")) : undefined;
    await new Promise<void>(resolve => setImmediate(resolve));
    follower.abort(); owner.abort(); finish.resolve();
    if (outcome === "success") assert.deepEqual(await second, await first);
    else { await firstRejected; await secondRejected; }
    assert.equal(writes, 1);
    const files = await fs.readdir(path.join(f.directory, "requests"));
    const receipt = JSON.parse(await fs.readFile(path.join(f.directory, "requests", files[0]!), "utf8"));
    assert.equal(receipt.state, outcome === "success" ? "completed" : "unknown");
    assert.equal(receipt.rejectionCode, undefined);
  });
}

for (const action of ["update", "remove"] as const) {
  test(`stop after ${action} submission still returns the confirmed successful result`, async t => {
    const f = await fixture(t); await f.connect(); const started = gate(); const finish = gate(); const controller = new AbortController();
    let writes = 0;
    f.set(async call => {
      if (call.method === "GET") return json({ ...event, id: "fixture", etag: '"v1"' });
      writes++; started.resolve(); await finish.promise;
      return action === "remove" ? new Response(null, { status: 204 }) : json({ ...event, id: "fixture", etag: '"v2"' });
    });
    const writing = action === "update" ? f.service.update({ eventId: "fixture", etag: '"v1"', event }, { signal: controller.signal })
      : f.service.remove({ eventId: "fixture", etag: '"v1"' }, { signal: controller.signal });
    await started.promise; controller.abort(); finish.resolve();
    const result = await writing;
    assert.equal(writes, 1);
    if ("removed" in result) assert.equal(result.removed, true);
    else assert.equal(result.event.etag, '"v2"');
  });
}
