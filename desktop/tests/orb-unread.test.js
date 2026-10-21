"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const path = require("node:path"), { EventEmitter } = require("node:events");
const { OrbController } = require("../companion/orb-controller");
const { OrbSignals } = require("../companion/orb-signals");
const { status } = require("../renderer/orb-status");

const agents = ["main-elaina", "main-aemeath"];
const receipt = (n = 1, read = n, id = "session-a") => ({ __harbour: "session-read", id, replyRevision: n, readReplyRevision: read });
const activity = (patch = {}) => ({ __harbour: "channel-activity", agent: agents[0], sessionId: "session-a",
  sessionKey: "web:main", source: { platform: "web" }, runId: "run-a", phase: "complete", replyRevision: 1, readReplyRevision: 0, ...patch });
const session = (patch = {}) => ({ id: "session-a", agentName: agents[0], key: "web:main", channel: "web",
  messages: [{ role: "assistant", content: "saved reply", runRecord: { status: "answered", attemptId: "run-a" } }],
  replyRevision: 1, readReplyRevision: 0, ...patch });
function fixture(t) {
  const c = new OrbController({ screen: new EventEmitter(),
    dataDir: path.resolve(__dirname, "../../data/runtime/unused-orb-unread-fixture"), deviceId: "fixture",
    agents: agents.map(agentName => ({ agentName })), getAppearance: () => ({}),
    getConfig: () => ({ url: "http://fixture.invalid", token: "never-sent" }),
    BrowserWindow: class { constructor() { throw new Error("No desktop windows in this test"); } } });
  c.chat.request = async () => { throw new Error("Unexpected network request"); };
  // Exact-window ownership checks still run, without constructing Electron.
  const sender = { mainFrame: { url: c.expectedUrl }, getURL: () => c.expectedUrl,
    isLoadingMainFrame: () => false, send() {} };
  c.win = { webContents: sender, isDestroyed: () => false, destroy() {} };
  c.enabled = true; c.expanded = true;
  const event = { sender, senderFrame: sender.mainFrame };
  t.after(() => c.dispose());
  const show = (value = session()) => {
    const row = c.chat.row(value.agentName); c.chat.acceptSession(row, value, true); c.chat.changed(row); return row;
  };
  const read = (agent = agents[0]) => {
    const s = c.chat.snapshot(agent);
    return c.action(event, { action: "read", agent, sessionId: s.sessionId, replyRevision: s.replyRevision,
      historyRevision: s.historyRevision, noticeKey: s.noticeKey });
  };
  return { c, event, show, read };
}

test("read receipts clear only covered replies, preserve active tasks and never resurrect on late terminal events", () => {
  const s = new OrbSignals({ agents });
  s.consume(activity());
  s.consume(activity({ runId: "new", phase: "error", replyRevision: 2 }));
  s.consume(activity({ runId: "busy", phase: "running", replyRevision: undefined }));
  s.consume(activity({ runId: "other", sessionId: "session-b", agent: agents[1] }));
  s.consume(receipt());
  assert.deepEqual([...s.tasks.keys()], ["new", "busy", "other"]);
  s.consume(receipt(2)); s.consume(receipt());
  assert.deepEqual([...s.tasks.keys()], ["busy", "other"]);
  s.consume(activity()); s.consume(activity({ runId: "new", phase: "error", replyRevision: 2 }));
  assert.deepEqual([...s.tasks.keys()], ["busy", "other"]);
  const late = new OrbSignals({ agents }); late.consume(receipt(2)); late.consume(activity({ phase: "error" }));
  assert.equal(late.tasks.size, 0, "Main read can precede a terminal WS event");
  late.consume(activity({ runId: "fresh", replyRevision: 3 }));
  assert.equal(late.snapshot(agents[0]).notification, "reply");
});

test("reconnect unknown status clears only with an exact saved run read, not an older reply", () => {
  const s = new OrbSignals({ agents });
  s.consume(activity({ phase: "running" }));
  s.consume({ __harbour: "activity-snapshot", activeRunIds: [] });
  s.consume({ ...receipt(), replyRunId: "previous-run" });
  assert.equal(s.snapshot(agents[0]).task.kind, "unknown");
  s.consume({ ...receipt(2), replyRunId: "run-a" });
  assert.equal(s.snapshot(agents[0]).task, null);
  s.consume(activity({ phase: "running" }));
  assert.equal(s.tasks.size, 0, "old activity cannot resurrect after reconnect acknowledgement");
});

test("malformed/cross-session receipts and legacy blanket acknowledgement cannot clear a newer reply", () => {
  const s = new OrbSignals({ agents }); s.consume(activity());
  for (const r of [receipt(1, 2), receipt(1, -1), receipt("1", "1"), receipt(1, 1, "other"), receipt(0)]) s.consume(r);
  s.acknowledgeSession(agents[0], "session-a");
  assert.equal(s.tasks.size, 1);
  s.consume(activity({ runId: "already-read", sessionId: "read-before-event", replyRevision: 5, readReplyRevision: 5 }));
  assert.equal(s.tasks.size, 1);
});

test("restored idle history requires a rendered receipt; Main Chat reading clears collapsed orb notifications", async t => {
  const { c, show, read } = fixture(t), row = show();
  c.signals.consume(activity({ phase: "error" }));
  row.feedback.reset("run-a", row.sessionId, row.agent); row.feedback.consume(activity({ phase: "error" }));
  c.chat.changed(row);
  assert.equal(c.unreadAgents.has(agents[0]), true, "loaded/expanded is not read");
  assert.equal(row.phase, "idle");
  const requests = [];
  c.chat.request = async (url, body) => { requests.push({ url, body }); return receipt(); };
  await read();
  assert.deepEqual(requests, [{ url: "/api/conversations/session-a/read", body: { key: "web:main", replyRevision: 1 } }]);
  assert.equal(c.unreadAgents.size, 0); assert.equal(c.signals.tasks.size, 0);
  assert.ok(row.feedback.snapshot(), "reading does not erase failure facts");
  assert.equal(c.chat.snapshot(agents[0]).notificationRead, true);
  const view = status({ ...c.snapshot(), connection: "open" }, { mood: "failed", label: "本轮执行失败" });
  assert.equal(view.kind, "failed"); assert.equal(view.alert, "none");
  show(); // stale HTTP snapshot cannot undo the read receipt
  assert.equal(c.unreadAgents.size, 0);
  show(session({ replyRevision: 2, messages: [{ role: "assistant", content: "new reply" }] }));
  c.expanded = false; c.consume(receipt(2));
  assert.equal(c.unreadAgents.size, 0, "reading in Main works while orb is collapsed");
});

test("late read IPC cannot mark a new reply, different session or persona read; duplicate requests coalesce", async t => {
  const { c, show, read } = fixture(t); const row = show();
  let resolve, count = 0;
  c.chat.request = () => { count++; return new Promise(done => { resolve = done; }); };
  const first = read(), duplicate = read();
  assert.equal(count, 1);
  show(session({ replyRevision: 2, messages: [{ role: "assistant", content: "unseen new reply" }] }));
  resolve(receipt(2, 1)); await Promise.all([first, duplicate]);
  assert.equal(c.unreadAgents.has(agents[0]), true); assert.equal(c.chat.snapshot(agents[0]).notificationRead, false);
  assert.equal(row.replyRevision, 2);
  const later = read();
  show(session({ id: "session-b", messages: [{ role: "assistant", content: "different session" }] }));
  resolve(receipt(2)); await later;
  assert.equal(c.chat.row(agents[0]).sessionId, "session-b");
  assert.equal(c.chat.snapshot(agents[0]).notificationRead, false);
  assert.equal(c.unreadSessions.has("session-b"), true);
  show(session({ id: "session-c", agentName: agents[1] }));
  assert.equal(await read(agents[1]), false, "IPC cannot acknowledge an invisible persona");
});

test("failed, hidden, stale or forged read requests do not consume messages", async t => {
  const { c, show, read, event } = fixture(t); show();
  let count = 0; c.chat.request = async () => { count++; throw new Error("offline"); };
  for (const mode of ["expanded", "enabled", "visualQuiet"]) {
    const before = c[mode]; c[mode] = mode === "visualQuiet";
    assert.equal(await read(), false); c[mode] = before;
  }
  assert.equal(count, 0);
  await assert.rejects(read(), /offline/); assert.equal(c.unreadAgents.size, 1);
  c.chat.request = async () => receipt(0);
  await assert.rejects(read(), /已读回执/); assert.equal(c.unreadAgents.size, 1);
  await assert.rejects(c.action({ ...event, senderFrame: { url: c.expectedUrl } }, { action: "read" }), /专属窗口/);
  assert.equal(await c.chat.markRead(agents[0], { sessionId: "session-a", historyRevision: -1 }), false);
});

test("Main reading a saved interruption dismisses the orb's stale failure notice without unlocking the uncertain task", t => {
  const { c, show } = fixture(t), row = show(session({ readReplyRevision: 1 }));
  row.feedback.reset("failed-new-run", row.sessionId, row.agent);
  row.feedback.consume(activity({ runId: "failed-new-run", phase: "error" }));
  row.phase = "uncertain"; row.messages.push({ role: "user", content: "interrupted request" }); c.chat.changed(row);
  assert.equal(c.chat.snapshot(row.agent).notificationRead, false);
  c.consume({ ...receipt(2, 1), replyRunId: "failed-new-run" });
  assert.equal(c.chat.snapshot(row.agent).notificationRead, false, "old reply's late receipt cannot acknowledge this failure");
  c.consume({ ...receipt(2), replyRunId: "failed-new-run" });
  assert.equal(c.chat.snapshot(row.agent).notificationRead, true);
  assert.equal(row.phase, "uncertain"); assert.ok(row.feedback.snapshot()); assert.equal(row.replyRevision, 1, "not pretending the new history is rendered");
  assert.equal(status({ ...c.snapshot(), connection: "open" }, { mood: "failed" }).alert, "none");
});

test("identical consecutive reply text is still a new unread reply", async t => {
  const { c, show, read } = fixture(t); show();
  c.chat.request = async () => receipt(); await read();
  show(session({ replyRevision: 2 }));
  assert.equal(c.chat.snapshot(agents[0]).notificationRead, false);
  assert.equal(c.unreadAgents.has(agents[0]), true);
});

test("reconnect reconciles missed reads once, without polling or erasing another task's result", async t => {
  const { c, show } = fixture(t); show();
  c.signals.consume(activity({ phase: "running" }));
  c.signals.consume({ __harbour: "activity-snapshot", activeRunIds: [] });
  c.signals.consume(activity({ runId: "other", sessionId: "session-b", phase: "error", replyRevision: 3 }));
  const requests = [];
  c.chat.request = async url => { requests.push(url); return { sessions: [session({ readReplyRevision: 1, replyRunId: "run-a" })] }; };
  await Promise.all([c.reconcileReadState(), c.reconcileReadState()]);
  assert.deepEqual(requests, ["/api/conversations/explorer?agentName=main-elaina"]);
  assert.equal(c.unreadAgents.size, 0); assert.deepEqual([...c.signals.tasks.keys()], ["other"]);
  for (let i = 0; i < 10; i++) c.consume({ msg: "loop:thinking", runId: "unrelated" });
  assert.equal(requests.length, 1);
});

test("viewed notification cannot hide active failure, unknown connection or waiting confirmation", () => {
  for (const phase of ["waiting", "running"]) {
    const state = { connection: "open", chat: { phase, runId: "active", notificationRead: true } };
    assert.notEqual(status(state, { mood: "failed" }).alert, "none");
    assert.notEqual(status({ ...state, connection: "closed" }).alert, "none");
  }
  assert.equal(status({ connection: "closed", chat: { notificationRead: true },
    signals: { task: { kind: "unknown", runId: "another-task" } } }, { mood: "failed" }).alert, "unknown");
});
