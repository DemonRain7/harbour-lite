// Deterministic races against the real dashboard functions; no models or production data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const app = fs.readFileSync(path.resolve(__dirname, "../../web/app.js"), "utf8");
function source(name) {
  const match = app.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^}`, "m"));
  assert.ok(match, `missing testable function ${name}`);
  return match[0];
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const key = "web:default:main-elaina";
function session(id, channel = "web") {
  return { id, key: channel === "web" ? key : "qq:fixture", channel, agentName: "main-elaina", title: `会话 ${id}`, messages: [{ role: "user", content: `${id} question` }, { role: "assistant", content: `${id} answer` }], modelRef: `${id}-model`, permissionMode: "plan", goal: { id: `${id}-goal`, status: "active" }, cowork: { deviceId: `${id}-device` } };
}
const functions = ["viewedChatSessionId", "viewedChatMessages", "inspectChatSession", "closeChatInspection", "switchChatSession", "sessionChatMessages", "channelRunMessages", "overlaySelectedChannelRuns", "renderSelectedChannelRuns", "handleChannelActivity", "pushTraceEvent", "executeChat", "submitRecoverableChatRun", "requestChatStop", "persistChatAnnotations", "syncActiveCheckpoint", "loadConversationMessages", "chatRunContext", "chatDraftKey", "saveChatDraft", "restoreChatDraft", "chatDraftBusy"];
function fixture() {
  const sessions = [session("A"), session("B"), session("C"), session("Q", "qq")];
  const chat = { agent: "main-elaina", mode: "main", sessionId: "A", sessionKey: key, selectedSessionKey: key, sessions,
    messages: [{ role: "user", content: "original" }, { role: "assistant", content: "", pending: true }],
    trace: [], subagents: {}, channelRuns: {}, attachments: [], model: "A-model", reasoningEffort: "high", permissionMode: "dontAsk", skill: "skill-A", goal: { id: "A-goal" }, checkpoint: { id: "A-cp" }, cowork: { deviceId: "A-device" }, running: true, activeRunId: "local-run", detailRequestSeq: 0, sessionListRequestSeq: 0 };
  const state = { chat, cowork: {}, runningAgent: "main-elaina" };
  const requests = [], notices = [], timers = [];
  const controls = { "#chatInput": { value: "A draft" }, "#chatSkill": { value: "skill-A" }, "#chatAgent": { value: "main-elaina" }, "#chatStream": { scrollTop: 123 }, "#chatSend": {} };
  const ctx = vm.createContext({ state, console, AbortController, AbortSignal, DEFAULT_PERSONA: "main-elaina", controls, requests,
    $: (id) => controls[id] || null,
    document: { querySelector: () => null },
    isOpenChatGoal: () => false, currentSessionKey: () => key, createClientRunId: () => "local-run",
    toast: (message) => notices.push(message), updateSessionUnreadIndicators() {}, pinChatWindow() {},
    setInterval: () => 1, clearInterval() {}, clearTimeout() {}, setTimeout: (fn) => { timers.push(fn); return timers.length; }, window: { setTimeout: (fn) => timers.push(fn) },
    visualPoll: () => 1, stopVisualTimer() {},
    api: async (url, options) => { requests.push({ url, ...(options ? { body: JSON.parse(options.body || "{}") } : {}) }); return { session: sessions.find((s) => url.endsWith(s.id)) }; },
    ...Object.fromEntries(["syncChatControlLocks", "setChatSendMode", "renderSessionList", "renderChatMessages", "renderChatInspectionBar", "syncInlineAskDeck", "renderChatAttachments", "renderChatGoal", "renderChatCheckpoint", "renderChatPlan", "updateRunningIndicator", "enrichNewsReports", "refreshSessionList", "updatePendingActivity", "updatePendingDuration", "updatePendingTrace", "updateChannelRunDom"].map((name) => [name, () => {}])),
    isCoworkTraceEvent: (obj) => String(obj.msg).startsWith("cowork:"),
    normalizeStoredTrace: (rows) => rows,
    normalizeTraceEvent: (obj) => ({ tag: obj.msg, text: obj.preview || "event" }),
    appendRoutedTrace: (rows, subs, obj) => { const event = { tag: obj.msg, text: obj.preview || "event" }; rows.push(event); return event; },
    applySessionDetail: (s) => { chat.messages = plain(s.messages); chat.model = s.modelRef; chat.goal = s.goal; chat.cowork = s.cowork; chat.selectedSessionKey = s.key; },
  });
  vm.runInContext(functions.map(source).join("\n"), ctx);
  return { ctx, state, chat, sessions, requests, notices, controls, timers };
}

async function testBrowseRaces() {
  const f = fixture();
  const original = plain(f.chat);
  const pending = [];
  f.ctx.api = (url, options) => { assert.equal(options, undefined, "running browse is GET only"); const d = deferred(); pending.push({ url, ...d }); return d.promise; };
  const b1 = f.ctx.switchChatSession("B");
  assert.equal(f.ctx.viewedChatSessionId(), "B");
  const c = f.ctx.switchChatSession("C");
  const b2 = f.ctx.switchChatSession("B");
  pending[2].resolve({ session: session("B") }); await b2;
  pending[0].resolve({ session: { ...session("B"), title: "stale B" } }); await b1;
  pending[1].resolve({ session: session("C") }); await c;
  assert.equal(f.chat.inspection.session.title, "会话 B");
  for (const field of ["sessionId", "selectedSessionKey", "messages", "trace", "model", "goal", "checkpoint", "cowork", "activeRunId", "attachments"]) assert.deepEqual(plain(f.chat[field]), original[field], `browse cannot mutate ${field}`);
  assert.equal(f.controls["#chatInput"].value, "A draft");
  assert.deepEqual(plain(f.ctx.viewedChatMessages()).map((m) => m.content), ["B question", "B answer"]);
  const later = f.ctx.inspectChatSession("C");
  f.ctx.closeChatInspection();
  pending[3].resolve({ session: session("C") }); await later;
  assert.equal(f.chat.inspection, null, "late response cannot reopen a closed view");
  assert.equal(f.ctx.viewedChatSessionId(), "A");
  assert.equal(f.controls["#chatStream"].scrollTop, 123);
  const mismatch = f.ctx.inspectChatSession("B");
  pending[4].resolve({ session: { ...session("B"), agentName: "main-aemeath" } }); await mismatch;
  assert.match(f.chat.inspection.error, /归属不匹配/);
  assert.equal(f.chat.inspection.session, null);
  const retry = f.ctx.inspectChatSession("B", true);
  pending[5].reject(new Error("connection unavailable")); await retry;
  assert.match(f.chat.inspection.error, /connection unavailable/);
  assert.equal(f.chat.sessionId, "A");
}

async function testEventsAndStop() {
  const f = fixture();
  await f.ctx.switchChatSession("B");
  const activity = { __harbour: "channel-activity", source: { platform: "web" }, sessionId: "A", sessionKey: key, agent: f.chat.agent, phase: "running", runId: "other-tab" };
  f.ctx.handleChannelActivity(activity);
  f.ctx.handleChannelActivity({ ...activity, runId: "foreign-session", sessionId: "C" });
  f.ctx.handleChannelActivity({ ...activity, runId: "local-run", phase: "complete" });
  assert.equal(f.chat.activeRunId, "local-run", "other clients and terminal events cannot replace/drop local run correlation");
  f.ctx.pushTraceEvent({ runId: "other-tab", agent: f.chat.agent, msg: "loop:thinking", preview: "foreign" });
  f.ctx.pushTraceEvent({ agent: f.chat.agent, msg: "plan:submitted", plan: { goal: "unbound" } });
  f.ctx.pushTraceEvent({ agent: f.chat.agent, msg: "loop:thinking", preview: "unbound" });
  f.ctx.pushTraceEvent({ runId: "local-run", agent: f.chat.agent, msg: "loop:thinking", preview: "local" });
  assert.equal(f.chat.trace.length, 1);
  assert.equal(f.chat.trace[0].text, "local");
  assert.equal(f.chat.channelRuns["other-tab"].trace[0].text, "foreign");
  f.ctx.pushTraceEvent({ runId: "local-run", msg: "plan:submitted", plan: { goal: "A plan" } });
  const annotation = f.requests.find((r) => r.url === "/api/conversations/annotate");
  assert.equal(annotation.body.id, "A");
  assert.equal(annotation.body.plan.goal, "A plan");
  const before = f.requests.length;
  await f.ctx.executeChat();
  await f.ctx.requestChatStop();
  assert.equal(f.requests.length, before, "browsing cannot submit or abort a run, even through a shortcut");
  assert.equal(f.chat.stopping, undefined);
  f.ctx.closeChatInspection();
  await f.ctx.requestChatStop();
  assert.equal(f.requests.at(-1).url, "/api/runs/local-run/abort");
  assert.equal(f.chat.stopping, true);
  await f.ctx.requestChatStop();
  assert.equal(f.requests.filter((r) => r.url.includes("/abort")).length, 1, "stop is single-flight");
}

async function testCompletion(kind) {
  const f = fixture();
  f.chat.running = false; f.chat.activeRunId = ""; f.chat.checkpoint = null;
  const run = deferred();
  f.ctx.api = async (url, options) => {
    f.requests.push({ url, body: options ? JSON.parse(options.body || "{}") : undefined });
    if (url === "/api/run") return kind === "async" ? { accepted: true, runId: "local-run", sessionId: "A" } : run.promise;
    if (url.startsWith("/api/runs/")) return run.promise;
    if (kind === "async" && url === "/api/conversations/A") return { session: { ...session("A"), messages: [
      { role: "user", content: "A draft" }, { role: "assistant", content: "A persisted final" },
    ] } };
    return { session: session(url.split("/").at(-1)) };
  };
  const executing = f.ctx.executeChat();
  assert.equal(f.chat.running, true);
  f.controls["#chatInput"].value = "next draft in A";
  await f.ctx.switchChatSession("B");
  f.ctx.pushTraceEvent({ runId: "local-run", agent: f.chat.agent, msg: "loop:thinking", preview: "original trace" });
  if (kind === "success") run.resolve({ answer: "A finished", session: { messageCount: 4, checkpoint: null, goal: { id: "A-final-goal" }, compactedThisRun: true, compactions: 1 } });
  else if (kind === "async") run.resolve({ runId: "local-run", sessionId: "A", status: "settled", answer: "A finished", session: { id: "A", messageCount: 2, checkpoint: null } });
  else run.reject(Object.assign(new Error(kind), kind === "cancelled" ? { status: 499, data: { session: { checkpoint: { id: "A-checkpoint" }, goal: { id: "A-final-goal" } } } } : { status: 422 }));
  await executing;
  assert.equal(f.chat.running, false);
  assert.equal(f.chat.sessionId, "A");
  assert.equal(f.ctx.viewedChatSessionId(), "B");
  assert.deepEqual(plain(f.ctx.viewedChatMessages()).map((m) => m.content), ["B question", "B answer"], `${kind} cannot cover the view with A's response`);
  assert.equal(f.controls["#chatInput"].value, "next draft in A");
  assert.equal(f.requests.find((r) => r.url === "/api/run").body.session.id, "A");
  for (const request of f.requests.filter((r) => r.url === "/api/conversations/annotate")) assert.equal(request.body.id, "A");
  assert.equal(f.requests.some((r) => r.url.endsWith("/switch")), false);
  if (kind === "async") {
    assert.equal(f.chat.messages.at(-1).content, "A persisted final");
    assert.equal(f.requests.some(r => r.url === "/api/conversations/annotate"), false, "recovery must not overwrite stored trace with a partial client trace");
  }
  if (kind === "cancelled") {
    // Deferred checkpoint sync must remain bound to A after a later real session switch.
    f.chat.sessionId = "C";
    const before = f.requests.length;
    await f.timers[0]();
    assert.equal(f.requests.length, before);
  }
}

async function testDraftsAndAdoption() {
  const f = fixture();
  f.chat.attachments = [{ kind: "image", url: "/uploads/A.png", name: "A.png" }];
  await f.ctx.inspectChatSession("B");
  await f.ctx.switchChatSession("B", true);
  assert.equal(f.chat.sessionId, "A", "enter cannot bypass an active run");
  f.chat.running = false;
  f.chat.pendingUploads = 1;
  await f.ctx.switchChatSession("B", true);
  assert.equal(f.chat.sessionId, "A", "unresolved upload still belongs to original composer");
  f.chat.pendingUploads = 0;
  const switching = deferred();
  const originalApi = f.ctx.api;
  f.ctx.api = (url, options) => url.endsWith("/switch") ? switching.promise : originalApi(url, options);
  const enter = f.ctx.switchChatSession("B", true);
  assert.equal(f.chat.switchingSession, true);
  const navigationSeq = f.chat.detailRequestSeq;
  await f.ctx.loadConversationMessages("A");
  assert.equal(f.chat.detailRequestSeq, navigationSeq, "background detail refresh cannot invalidate explicit navigation or leave its lock stuck");
  await f.ctx.executeChat();
  assert.equal(f.requests.some((r) => r.url === "/api/run"), false);
  switching.resolve({ session: session("B") }); await enter;
  assert.equal(f.chat.switchingSession, false);
  assert.equal(f.chat.sessionId, "B");
  assert.equal(f.chat.inspection, null);
  assert.equal(f.controls["#chatInput"].value, "");
  assert.deepEqual(plain(f.chat.attachments), []);
  f.controls["#chatInput"].value = "B draft";
  f.ctx.api = async () => ({ session: session("A") });
  await f.ctx.switchChatSession("A");
  assert.equal(f.controls["#chatInput"].value, "A draft");
  assert.equal(f.chat.attachments[0].name, "A.png");
  assert.equal(f.chat.drafts.get("B").text, "B draft");

  // Even a successful old /switch response must not replace a newer read-only selection.
  const stale = deferred(); f.ctx.api = () => stale.promise;
  const old = f.ctx.switchChatSession("B");
  const current = deferred(); f.ctx.api = () => current.promise;
  const peek = f.ctx.inspectChatSession("C");
  current.resolve({ session: session("C") }); await peek;
  stale.resolve({ session: session("B") }); await old;
  assert.equal(f.chat.sessionId, "A"); assert.equal(f.ctx.viewedChatSessionId(), "C");

  f.ctx.closeChatInspection();
  const abandoned = deferred(); f.ctx.api = () => abandoned.promise;
  const enterB = f.ctx.switchChatSession("B");
  await f.ctx.switchChatSession("A");
  abandoned.resolve({ session: session("B") }); await enterB;
  assert.equal(f.chat.sessionId, "A", "clicking the origin cancels a pending ordinary switch");
  assert.equal(f.chat.switchingSession, false);
}

async function testStopBeforeAdmission(lostAuth = false) {
  const f = fixture();
  f.chat.running = false; f.chat.activeRunId = ""; f.chat.checkpoint = null;
  f.ctx.setTimeout = fn => setTimeout(fn, 0); f.ctx.clearTimeout = clearTimeout;
  const accepted = deferred();
  let aborts = 0, queries = 0;
  f.ctx.api = async (url, options) => {
    f.requests.push({ url, body: options ? JSON.parse(options.body || "{}") : undefined });
    if (url === "/api/run") return accepted.promise;
    if (url === "/api/runs/local-run/abort") {
      if (++aborts === 1) throw Object.assign(new Error("not admitted yet"), { status: 404 });
      return { runId: "local-run", sessionId: "A", status: "stopping" };
    }
    if (url === "/api/runs/local-run?sessionId=A") {
      if (lostAuth) throw Object.assign(new Error("auth expired; stop not confirmed"), { status: 401 });
      return ++queries === 1 ? { runId: "local-run", sessionId: "A", status: "running" }
        : { runId: "local-run", sessionId: "A", status: "settled", incomplete: true, answer: "stopped", session: { id: "A", messageCount: 2 } };
    }
    return { session: session("A") };
  };
  const running = f.ctx.executeChat();
  const observation = f.chat.abort;
  await f.ctx.requestChatStop();
  assert.equal(f.chat.stopping, true);
  assert.equal(observation.signal.aborted, false, "early STOP cannot mistake observation disconnect for cancellation");
  assert.match(f.chat.messages.at(-1).activity, /核对原任务/);
  assert.equal(f.timers.length, 0, "session STOP must not fall back to a local abort timer");
  accepted.resolve({ accepted: true, runId: "local-run", sessionId: "A" });
  await running;
  assert.equal(f.requests.filter(r => r.url === "/api/run").length, 1, "never resubmit execution to deliver STOP");
  for (const r of f.requests.filter(r => r.url.endsWith("/abort"))) assert.equal(r.body.sessionId, "A");
  assert.equal(aborts, lostAuth ? 1 : 2, "pending stop is delivered when the original run becomes visible");
  assert.equal(observation.signal.aborted, false);
  assert.equal(f.chat.running, false);
  assert.equal(f.chat.checkpoint, null, "failed lookup is not evidence for a fabricated stopped checkpoint");
  if (lostAuth) assert.ok(f.notices.some(text => text.includes("stop not confirmed")));
}

async function main() {
  await testBrowseRaces();
  await testEventsAndStop();
  for (const kind of ["success", "async", "error", "cancelled"]) await testCompletion(kind);
  await testStopBeforeAdmission();
  await testStopBeforeAdmission(true);
  await testDraftsAndAdoption();
  console.log("session browsing tests passed (read-only view, race ordering, run identity, stop isolation, completion/error/cancel and drafts)");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
