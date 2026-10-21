// Deterministic display-clock and shared-setting races; no server, models or private files.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const moduleSource = fs.readFileSync(path.join(root, "web/time-zone.js"), "utf8");
const appSource = fs.readFileSync(path.join(root, "web/app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
function source(name) {
  const match = appSource.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^}`, "m"));
  assert.ok(match, `missing function ${name}`); return match[0];
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const instant = "2026-07-01T12:00:00.000Z";
const payload = (timeZone, revision) => ({ timeZone, revision, updatedAt: instant, now: instant, formattedNow: instant,
  options: [{ value: "America/New_York", label: "纽约" }, { value: "Asia/Shanghai", label: "上海" }, { value: "Etc/GMT+5", label: "固定 EST" }], schedulePolicy: "fixed-existing", legacyScheduleTimeZone: "America/New_York" });

function fixture() {
  const stamps = [
    { dataset: { harbourTime: instant, timeStyle: "short" }, textContent: "before", title: "" },
    { dataset: { harbourTime: String(Date.parse(instant)), timeStyle: "time" }, textContent: "before", title: "" },
  ];
  const tooltip = { dataset: { harbourTimeTitle: instant }, title: "" };
  const editor = { value: "UNSAVED MANUAL DRAFT", selectionStart: 8, scrollTop: 41 };
  const chat = { running: true, activeRunId: "run-A", sessionId: "session-A", goal: { id: "goal-A" },
    checkpoint: { id: "checkpoint-A" }, messages: [{ role: "user", content: "KEEP RAW", at: instant }], attachments: [{ name: "draft.png" }] };
  const requests = [], notices = [];
  const context = vm.createContext({ console, Intl, Date, esc: escape, state: { chat },
    document: {
      querySelectorAll: (selector) => selector === "[data-harbour-time]" ? stamps : selector === "[data-harbour-time-title]" ? [tooltip] : [],
      getElementById: () => null,
    },
    toast: (message) => notices.push(message),
    api: async (url, options) => { requests.push({ url, ...(options || {}) }); return payload("America/New_York", 0); },
    route: () => assert.fail("timezone updates must not route or recreate the panel"),
    renderChatMessages: () => assert.fail("timezone updates must not recreate chat"),
    executeChat: () => assert.fail("timezone updates must not execute a model"),
    location: { reload: () => assert.fail("timezone updates must not reload the page") },
  });
  vm.runInContext(moduleSource, context);
  const functions = ["formatDate", "formatDateShort", "shortTime", "timeHtml", "timeTitleAttrs", "refreshDisplayedTimes",
    "isTimeSettingsPayload", "applyTimeSettingsPayload", "loadTimeSettings", "saveTimeSettings", "syncTimeSettingsForm", "syncTimeSettingsClock", "scheduleTimeZone", "scheduleTimeZoneOptions"];
  const stateDeclaration = appSource.match(/^const timeSettingsState = .*;$/m)?.[0];
  assert.ok(stateDeclaration);
  vm.runInContext([stateDeclaration, ...functions.map(source), "globalThis.readTimeState=()=>timeSettingsState;"].join("\n"), context);
  return { context, time: context.HarbourTime, timeState: context.readTimeState(), stamps, tooltip, editor, chat, requests, notices };
}

function testFormatter() {
  const { time } = fixture();
  assert.equal(time.getTimeZone(), "America/New_York");
  assert.equal(time.format(instant), "2026-07-01 08:00:00 EDT");
  assert.equal(time.format("2026-01-01T12:00:00Z"), "2026-01-01 07:00:00 EST");
  assert.equal(time.format("2026-09-07T00:30:00Z", "short"), "09/06 20:30");
  assert.equal(time.format("2026-09-07T00:30:00Z", "date"), "2026-09-06");
  assert.equal(time.format("2026-09-07T00:30:00Z", "filename"), "20260906-203000");
  assert.equal(time.format("2026-03-08T06:59:59Z"), "2026-03-08 01:59:59 EST");
  assert.equal(time.format("2026-03-08T07:00:00Z"), "2026-03-08 03:00:00 EDT");
  assert.equal(time.format("2026-11-01T05:30:00Z"), "2026-11-01 01:30:00 EDT");
  assert.equal(time.format("2026-11-01T06:30:00Z"), "2026-11-01 01:30:00 EST");
  assert.equal(time.setTimeZone("Etc/GMT+5"), true);
  assert.equal(time.format(instant), "2026-07-01 07:00:00 EST");
  assert.equal(time.format("2026-01-01T12:00:00Z"), "2026-01-01 07:00:00 EST");
  assert.equal(time.setTimeZone("Asia/Shanghai"), true);
  assert.equal(time.format(instant, "time"), "20:00:00");
  assert.equal(time.format("2026-07-01T16:00:00Z", "short"), "07/02 00:00", "never render midnight as 24:00");
  assert.equal(time.format(Date.parse(instant), "time"), "20:00:00");
  assert.equal(time.format(String(Date.parse(instant)), "time"), "20:00:00", "DOM epoch attributes retain exact instants");
  assert.equal(time.format(0, "time"), "08:00:00");
  assert.equal(time.format("0", "time"), "08:00:00");
  assert.equal(time.format("not a date"), "not a date");
  assert.equal(time.format(null), "—");
  assert.equal(time.format(undefined, "time"), "");
  assert.equal(time.setTimeZone("Mars/Olympus"), false);
  assert.equal(time.getTimeZone(), "Asia/Shanghai", "invalid settings cannot replace a valid timezone");
}

function testInPlaceBroadcast() {
  const f = fixture();
  const original = plain({ editor: f.editor, chat: f.chat });
  const messageRef = f.chat.messages, stampRef = f.stamps[0];
  assert.equal(f.context.applyTimeSettingsPayload(payload("Asia/Shanghai", 2)), true);
  assert.equal(f.stamps[0].textContent, "07/01 20:00");
  assert.equal(f.stamps[1].textContent, "20:00:00");
  assert.match(f.tooltip.title, /2026-07-01 20:00:00/);
  assert.equal(f.stamps[0], stampRef);
  assert.equal(f.chat.messages, messageRef);
  assert.deepEqual(plain({ editor: f.editor, chat: f.chat }), original, "drafts, focus positions, raw UTC, run and session state stay untouched");
  assert.equal(f.requests.length, 0, "broadcast rendering does not issue requests");
  assert.equal(f.context.applyTimeSettingsPayload(payload("America/New_York", 1)), false, "late lower revision is rejected");
  assert.equal(f.context.applyTimeSettingsPayload(payload("America/New_York", 2)), false, "conflicting equal revision is rejected");
  f.timeState.draft = "America/New_York";
  f.context.applyTimeSettingsPayload(payload("Etc/GMT+5", 3));
  assert.equal(f.timeState.draft, "America/New_York", "remote change never overwrites an unsaved Settings choice");
  assert.equal(f.context.applyTimeSettingsPayload({ ...payload("UTC", 4), revision: NaN }), false);
  assert.match(f.context.timeHtml('<img src=x onerror="alert(1)">'), /&lt;img/);
  assert.doesNotMatch(f.context.timeHtml('<img src=x onerror="alert(1)">'), /<img/);
}

async function testReadAndSaveRaces() {
  const f = fixture(), pendingGet = deferred();
  f.context.api = async (url) => { f.requests.push({ url }); return pendingGet.promise; };
  const a = f.context.loadTimeSettings(), b = f.context.loadTimeSettings();
  assert.equal(a, b, "initial fetch and socket-open fetch are coalesced");
  f.context.applyTimeSettingsPayload(payload("Asia/Shanghai", 2));
  pendingGet.resolve(payload("America/New_York", 1)); await a;
  assert.equal(f.time.getTimeZone(), "Asia/Shanghai");
  assert.equal(f.requests.length, 1);

  const pendingPut = deferred();
  f.timeState.draft = "America/New_York";
  f.context.api = async (url, options) => { f.requests.push({ url, options: plain(options) }); return pendingPut.promise; };
  const save = f.context.saveTimeSettings();
  assert.equal(f.timeState.saving, true);
  await f.context.saveTimeSettings();
  assert.equal(f.requests.length, 2, "a second save while pending cannot duplicate the PUT");
  f.context.applyTimeSettingsPayload(payload("Etc/GMT+5", 4));
  pendingPut.resolve(payload("America/New_York", 3)); await save;
  assert.equal(f.time.getTimeZone(), "Etc/GMT+5", "late save response cannot override a newer broadcast");
  assert.equal(f.timeState.saving, false);
  assert.equal(f.timeState.draft, "Etc/GMT+5");
  assert.deepEqual(JSON.parse(f.requests[1].options.body), { timeZone: "America/New_York" });
  assert.equal(f.requests[1].options.method, "PUT");
}

async function testFallbackAndFailure() {
  const f = fixture();
  f.context.api = async () => { throw Object.assign(new Error("未知接口: GET /api/time-settings"), { status: 404 }); };
  await f.context.loadTimeSettings();
  assert.equal(f.time.getTimeZone(), "America/New_York");
  assert.equal(f.timeState.current, null);
  assert.match(f.timeState.error, /重启或更新 Harbour 后端/);
  assert.match(f.timeState.error, /重试连接/);
  assert.equal(f.timeState.loading, null, "a failed request can be retried after the server upgrades");
  // A retry must fetch the new API, not require reloading the dashboard or fallback to local settings.
  f.context.api = async () => payload("America/New_York", 0);
  await f.context.loadTimeSettings();
  assert.equal(f.timeState.current.timeZone, "America/New_York");
  assert.equal(f.timeState.error, "");
  f.timeState.draft = "Asia/Shanghai";
  f.context.api = async () => { throw new Error("offline"); };
  await f.context.saveTimeSettings();
  assert.equal(f.time.getTimeZone(), "America/New_York");
  assert.equal(f.timeState.draft, "Asia/Shanghai");
  assert.equal(f.timeState.saving, false);
  assert.match(f.timeState.error, /保存失败/);
  f.context.api = async () => payload("Asia/Shanghai", 1);
  await f.context.saveTimeSettings();
  assert.equal(f.time.getTimeZone(), "Asia/Shanghai");
  assert.equal(f.timeState.error, "");
}

async function testMalformedSettings() {
  const f = fixture();
  for (const invalid of [{}, { ...payload("Asia/Shanghai", 0), revision: -1 }]) {
    f.context.api = async () => invalid;
    await f.context.loadTimeSettings();
    assert.equal(f.timeState.current, null);
    assert.equal(f.timeState.loading, null);
    assert.match(f.timeState.error, /未返回有效时区配置/, "a malformed HTTP 200 must not leave the form loading forever");
  }
  f.context.applyTimeSettingsPayload(payload("America/New_York", 1));
  f.timeState.draft = "Asia/Shanghai";
  f.context.api = async () => { throw new Error("offline"); };
  await f.context.loadTimeSettings();
  assert.equal(f.timeState.draft, "Asia/Shanghai");
  assert.match(f.timeState.error, /最近同步的时区/);
  f.context.api = async () => payload("America/New_York", 1);
  await f.context.loadTimeSettings();
  assert.equal(f.timeState.draft, "Asia/Shanghai", "retry must keep the unsaved selection");
  assert.equal(f.timeState.error, "");
  f.context.api = async () => payload("Asia/Shanghai", -1);
  await f.context.saveTimeSettings();
  assert.equal(f.time.getTimeZone(), "America/New_York");
  assert.equal(f.timeState.draft, "Asia/Shanghai");
  assert.match(f.timeState.error, /保存失败/);
  assert.deepEqual(f.notices, [], "an invalid save response must not announce success");
}

function testWiring() {
  assert.ok(html.indexOf('/time-zone.js') < html.indexOf('/app.js'), "shared formatter loads before dashboard");
  assert.match(source("connectWs"), /obj\?\.type === "time-settings:changed".*applyTimeSettingsPayload\(obj.payload\)/);
  assert.match(source("connectWs"), /void loadTimeSettings\(\)/, "reconnect refreshes shared settings missed offline");
  assert.doesNotMatch(source("saveTimeSettings") + source("applyTimeSettingsPayload") + source("refreshDisplayedTimes"), /\broute\(|location\.reload|renderChatMessages\(|executeChat\(/);
  assert.match(source("renderSettingsTime"), /固定 EST.*UTC−05:00/);
  assert.match(source("renderSettingsTime"), /既有|已有 Cron/);
  assert.match(source("renderSettingsTime"), /#timeSettingsRetry.*addEventListener\("click".*loadTimeSettings/, "retry button is wired to the server read");
  assert.match(source("traceRowsHtml"), /timeHtml\(e.at, "time", "ct-time"\)/);
  assert.match(source("appendRoutedTrace"), /ev.at = obj.at \?\? obj.time \?\? obj.t/);
  assert.match(source("pushTraceEvent"), /ev.at = obj.at \?\? obj.time \?\? obj.t/, "current-client run trace also retains epoch timestamps");
  assert.doesNotMatch(appSource, /\.getHours\(\)|\.getMonth\(\)|return d\.toLocaleString\(\)/, "UI wall-clock display never relies on the browser timezone");
  assert.match(source("executeChat"), /at: new Date\(\)\.toISOString\(\)/, "message storage stays UTC ISO");
  assert.match(source("formatRunDuration"), /Math\.floor\(raw \/ 1000\)/, "elapsed times remain duration arithmetic");
  assert.match(source("renderDashMain"), /const dates = sl\(ts.days \|\| \[\]\)/, "accounting-day keys pass through unchanged, without UTC parsing");
  assert.match(source("renderDashMain"), /dashView.ts\?\.accountingTimeZone/);
  assert.match(source("renderDashMain"), /日账按 \$\{accountingZone\} 分日；明细时刻按当前显示时区/);
  assert.doesNotMatch(source("saveTimeSettings"), /\/api\/cron/, "display-time changes never mutate schedule execution");
  assert.match(source("openCronModal"), /cronTimeZone/);
  assert.match(source("openCronModal"), /editing && body.timeZone !== originalTimeZone/);
}

function testScheduleIndependence() {
  const f = fixture();
  assert.equal(f.context.scheduleTimeZone(), "America/New_York");
  f.context.applyTimeSettingsPayload(payload("Asia/Shanghai", 1));
  assert.equal(f.context.scheduleTimeZone(), "Asia/Shanghai", "new jobs inherit the current display setting");
  assert.equal(f.context.scheduleTimeZone({ timeZone: "Etc/GMT+5" }), "Etc/GMT+5", "editing retains the job's own execution timezone");
  assert.equal(f.context.scheduleTimeZone({}), "America/New_York", "legacy schedules do not acquire the new display timezone");
  assert.match(f.context.scheduleTimeZoneOptions("Europe/London"), /value="Europe\/London" selected/, "existing IANA zones absent from recommendations remain selectable");
  assert.equal(f.requests.length, 0);
}

function testLiveTraceTimestamp() {
  const f = fixture();
  Object.assign(f.chat, { trace: [], subagents: {}, channelRuns: {} });
  Object.assign(f.context, {
    isCoworkTraceEvent: () => false,
    normalizeTraceEvent: () => ({ cls: "result", tag: "TOOL", text: "fixture only" }),
    updatePendingTrace: () => {},
  });
  f.context.state.runningAgent = "main-fixture";
  vm.runInContext(source("pushTraceEvent"), f.context);
  f.context.pushTraceEvent({ msg: "loop:tool-result", agent: "main-fixture", runId: "run-A", time: Date.parse(instant) });
  f.context.pushTraceEvent({ msg: "spawn_subagent", from: "main-fixture", to: "worker-fixture", runId: "run-A", time: Date.parse(instant) + 1 });
  assert.equal(f.chat.trace[0].at, Date.parse(instant));
  assert.equal(f.chat.trace[1].at, Date.parse(instant) + 1);
  assert.equal(f.chat.trace[1].depth, 0);
  assert.equal(f.requests.length, 0);
}

(async () => {
  testFormatter(); testInPlaceBroadcast(); await testReadAndSaveRaces(); await testFallbackAndFailure(); await testMalformedSettings(); testScheduleIndependence(); testLiveTraceTimestamp(); testWiring();
  console.log("time zone web tests passed (DST, fixed EST, Shanghai, epoch/UTC preservation, in-place sync, revisions, retries, old-server fallback, fixed schedules and accounting-day labels)");
})().catch((error) => { console.error(error); process.exitCode = 1; });
