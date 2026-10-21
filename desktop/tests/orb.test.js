"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const http = require("node:http"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events");
const { OrbChat } = require("../companion/orb-chat");
const { sessionContext } = require("../companion/orb-context");
const { OrbController } = require("../companion/orb-controller");
const { placeOrb, dockAt, hitOrb } = require("../companion/orb-geometry");
const { imageTarget, projectMessage, rasterMime } = require("../companion/orb-messages");

test("orb voice choice keeps exact-window ownership and binds the initiated persona", async () => {
  const expectedUrl = "file:///orb.html", calls = [];
  const sender = { mainFrame: { url: expectedUrl }, getURL: () => expectedUrl };
  const event = { sender, senderFrame: sender.mainFrame };
  const controller = Object.create(OrbController.prototype);
  Object.assign(controller, { expectedUrl, win: { webContents: sender, isDestroyed: () => false }, agent: "main-elaina",
    chat: { row: agent => { if (!["main-elaina", "main-aemeath"].includes(agent)) throw new Error("invalid persona"); } },
    voiceChoice: async input => { calls.push(input); return { selections: {} }; } });
  await controller.action(event, { action: "voice-choice", choice: "select", agent: "main-aemeath", companionId: "elaina", voiceId: "custom:aemeath" });
  assert.deepEqual(calls[0], { action: "select", companionId: "aemeath", voiceId: "custom:aemeath" });
  await assert.rejects(controller.action({ ...event, senderFrame: { url: expectedUrl } }, { action: "voice-choice", choice: "preview" }));
  await assert.rejects(controller.action(event, { action: "voice-choice", choice: "select", agent: "untrusted" }));
  assert.equal(calls.length, 1);
});
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1kAAAAASUVORK5CYII=", "base64");
const agents = [{ agentName: "main-elaina", displayName: "Elaina" }, { agentName: "main-aemeath", displayName: "Aemeath" }];
const json = (res, value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
async function fixture(t, handle, options = {}) {
  const calls = [], sessions = new Map(); let sequence = 0;
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : undefined, url = new URL(req.url, "http://fixture");
    calls.push({ path: req.url, method: req.method, body: data, authorization: req.headers.authorization });
    if (handle && await handle(req, res, data, url)) return;
    if (url.pathname === "/api/conversations/new") {
      const session = { id: `cs-${++sequence}`, key: data.key, channel: "web", agentName: data.agentName, messages: [] };
      sessions.set(session.id, session); return json(res, { session });
    }
    if (url.pathname === "/api/conversations") {
      const list = [...sessions.values()].filter(s => s.key === url.searchParams.get("key"));
      return json(res, { enabled: true, sessions: list, activeId: list.at(-1)?.id || null });
    }
    if (url.pathname === "/api/conversations/explorer") return json(res, { enabled: true,
      sessions: [...sessions.values()].filter(s => s.agentName === url.searchParams.get("agentName")).reverse() });
    if (url.pathname === "/api/conversations/switch") return json(res, { session: sessions.get(data.id) });
    if (url.pathname.startsWith("/api/conversations/")) {
      const session = sessions.get(url.pathname.split("/").at(-1));
      if (req.method === "PATCH") Object.assign(session, data);
      return json(res, { session });
    }
    if (url.pathname === "/api/asks") return json(res, { asks: [] });
    return json(res, { answer: "fixture reply" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = { url: `http://127.0.0.1:${server.address().port}`, token: "private-fixture-token" };
  const chat = new OrbChat({ getConfig: () => config, deviceId: "fixture-device", agents, ...options });
  t.after(async () => { chat.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { chat, calls, sessions, config };
}

// Shape emitted by POST /api/run and replayed by LogBroadcaster.addClient.
function activity(row, overrides = {}) {
  return { __harbour: "channel-activity", phase: "running", agent: row.agent, runId: "dashboard-run-1",
    sessionId: row.sessionId, sessionKey: row.key, source: { platform: "web", scope: "web" },
    input: "从完整会话继续提问", task: "从完整会话继续提问", startedAt: Date.now(), ...overrides };
}
function saveReply(f, event, answer = "完整会话的回答", status = "answered") {
  f.sessions.get(event.sessionId).messages.push({ role: "user", content: event.input },
    { role: "assistant", content: answer, runRecord: { attemptId: event.runId, status } });
}

test("context ring uses effective input capacity and saved observations, never cumulative billing", () => {
  for (const value of [undefined, {}, {contextTokens:-1,contextLimit:100}, {contextTokens:NaN,contextLimit:100}, {contextTokens:1,contextLimit:0}, {totalTokens:500000,contextLimit:100}]) assert.equal(sessionContext(value), null);
  const base = {contextTokens:0,contextWindow:1000,contextLimit:950,compactAtTokens:800,contextModelRef:'mock/large'};
  assert.equal(sessionContext(base).ratio, 0, 'known zero differs from unknown');
  assert.equal(sessionContext({...base,contextTokens:475}).ratio, .5);
  assert.equal(sessionContext({...base,contextTokens:700}).tone, 'warm');
  assert.equal(sessionContext({...base,contextTokens:800}).tone, 'compact');
  const full = sessionContext({...base,contextTokens:1400,contextTokenSource:'native-observed'});
  assert.equal(full.ratio, 1); assert.equal(full.tone, 'full'); assert.equal(full.source, 'native');
  assert.equal(sessionContext({contextTokens:20,contextWindow:100}).ratio, .2);
});

test("settings snapshots pin their session; stale editors and mismatched read/write receipts cannot update another session", async t => {
  let mismatch = "";
  const f = await fixture(t, (req, res, _data, url) => {
    if (req.url === '/api/agent-defaults') { json(res, {models:[],agents:[]}); return true; }
    if (mismatch === req.method && url.pathname.startsWith('/api/conversations/')) {
      const s = f.sessions.get(url.pathname.split('/').at(-1)); json(res, {session:{...s,id:'wrong-session'}}); return true;
    }
  });
  const first = await f.chat.load('main-elaina', true), settings = await f.chat.settings('main-elaina');
  assert.equal(settings.sessionId, first.sessionId);
  const second = await f.chat.load('main-elaina', true);
  await assert.rejects(f.chat.configure('main-elaina', {permissionMode:'plan'}, settings.sessionId), /会话已切换/);
  mismatch = "GET";
  await assert.rejects(f.chat.configure('main-elaina', {permissionMode:'plan'}, second.sessionId), /会话编号/);
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 0);
  mismatch = "PATCH";
  await assert.rejects(f.chat.configure('main-elaina', {permissionMode:'plan'}, second.sessionId), /会话编号/);
  assert.equal(f.chat.snapshot('main-elaina').sessionId, second.sessionId);
  assert.equal(f.chat.snapshot('main-elaina').config.permissionMode, "", "bad response cannot change the displayed session configuration");
});

test("context follows each persona and exact session, refreshes after own reply and does not count usage trace", async t => {
  const f = await fixture(t, (req, res, data) => {
    if (req.url === '/api/run') { json(res, {answer:'done',session:{id:data.session.id,contextTokens:800,contextLimit:1000,compactAtTokens:800,contextTokenSource:'native-observed'}}); return true; }
  });
  for (const {agentName:agent} of agents) {
    const s = await f.chat.load(agent, true);
    Object.assign(f.sessions.get(s.sessionId), {contextTokens:200,contextLimit:1000,contextModelRef:'mock/first'});
    await f.chat.load(agent);
    assert.equal(f.chat.snapshot(agent).context.ratio, .2);
    f.chat.consume({msg:'usage',agent,totalTokens:100000,runId:'foreign'});
    assert.equal(f.chat.snapshot(agent).context.ratio, .2);
    await f.chat.send(agent,'hello'); assert.equal(f.chat.snapshot(agent).context.ratio, .8);
    assert.equal(f.chat.snapshot(agent).context.source, 'native');
    await f.chat.load(agent,true); assert.equal(f.chat.snapshot(agent).context, null, 'new history does not retain another session ring');
  }
});

test("composer queue and steer use the exact active session inbox for both personas, not another run", async t => {
  const f = await fixture(t, (req, res, data) => {
    if (req.url.endsWith('/inputs')) { json(res, { id: data.clientMessageId, state: 'waiting', mode: data.mode }, 202); return true; }
  });
  for (const { agentName: agent } of agents) {
    await f.chat.load(agent, true);
    const row = f.chat.row(agent), event = activity(row, { runId: `busy-${agent}` });
    f.chat.consume(event); await row.syncing;
    for (const mode of ['queue', 'steer']) {
      row.staged.set('image', { kind: 'image', url: '/uploads/fixture.png', name: 'fixture.png' });
      const before = row.messages.length;
      await f.chat.submit(agent, `消息 ${mode}`, ['image'], mode);
      const call = f.calls.at(-1);
      assert.equal(call.path, `/api/conversations/${row.sessionId}/inputs`);
      assert.equal(call.body.mode, mode); assert.equal(call.body.attachments[0].url, '/uploads/fixture.png');
      assert.equal(call.authorization, 'Bearer private-fixture-token');
      assert.match(call.body.clientMessageId, /^orb-input-/);
      assert.equal(row.runId, event.runId); assert.equal(row.messages.length, before, 'receipt is not an invented reply');
      assert.equal(row.staged.size, 0); assert.equal(f.chat.snapshot(agent).canStop, false);
      assert.match(f.chat.snapshot(agent).inputNotice, mode === 'queue' ? /已排队/ : /已提交补充/);
    }
    await assert.rejects(f.chat.submit(agent, 'invalid mode', [], 'interrupt'), /模式/);
    row.readOnly = true;
    await assert.rejects(f.chat.submit(agent, 'channel mirror', [], 'steer'), /只读/);
  }
  assert.equal(f.calls.filter(c => c.path === '/api/run' || c.method === 'PATCH').length, 0);
});

test("uncertain orb inbox receipt retains ID, mode and attachments after the running task ends", async t => {
  let attempt = 0;
  const f = await fixture(t, (req, res, data) => {
    if (req.url.endsWith('/inputs')) {
      if (!attempt++) json(res, { error: 'lost receipt' }, 503);
      else json(res, { id: data.clientMessageId, state: 'waiting', mode: data.mode }, 202);
      return true;
    }
  });
  await f.chat.load('main-elaina', true); const row = f.chat.row('main-elaina');
  f.chat.consume(activity(row)); await row.syncing;
  row.staged.set('image', { kind: 'image', url: '/uploads/fixture.png' });
  await assert.rejects(f.chat.submit(row.agent, '保留原文', ['image'], 'queue'), /未确认投递/);
  const original = f.calls.at(-1).body;
  assert.equal(row.staged.size, 1); assert.ok(row.inputRequest);
  assert.equal(row.inputSending, false);
  await assert.rejects(f.chat.submit(row.agent, '不要偷换正文', ['image'], 'steer'), /原文/);
  row.runId = null; row.external = null; row.phase = 'complete';
  await assert.rejects(f.chat.select(row.agent, 'other'), /回执尚未确认/);
  await f.chat.submit(row.agent, '保留原文', ['image'], 'steer');
  assert.deepEqual(f.calls.at(-1).body, original);
  assert.equal(attempt, 2); assert.equal(row.inputRequest, null); assert.equal(row.staged.size, 0);
  assert.equal(f.calls.filter(c => c.path === '/api/run').length, 0, 'retry cannot turn into a new idle run');
});

test("orb-origin task keeps run/stop ownership while accepting additional messages and blocking duplicate sends", async t => {
  let run, intake;
  const f = await fixture(t, (req, res, data) => {
    if (req.url === '/api/run') { run = { res, data }; return true; }
    if (req.url.endsWith('/inputs')) { intake = { res, data }; return true; }
  });
  const started = f.chat.submit('main-aemeath', '第一条', [], 'queue');
  while (!run) await new Promise(r => setTimeout(r, 5));
  const row = f.chat.row('main-aemeath'), runId = row.runId;
  const supplement = f.chat.submit(row.agent, '追加要求', [], 'steer');
  while (!intake) await new Promise(r => setTimeout(r, 5));
  assert.equal(row.inputSending, true);
  await assert.rejects(f.chat.submit(row.agent, '重复按键', [], 'queue'), /正在提交/);
  assert.equal(row.localRunId, runId); assert.equal(f.chat.snapshot(row.agent).canStop, true);
  json(intake.res, { id: intake.data.clientMessageId, mode: 'steer', state: 'accepted' }, 202); await supplement;
  assert.equal(row.runId, runId); assert.equal(row.preparing, true); assert.equal(row.inputSending, false);
  json(run.res, { answer: '原任务结果' }); await started;
  assert.equal(row.messages.at(-1).content, '原任务结果'); assert.equal(row.phase, 'complete');
  assert.equal(f.calls.filter(c => c.path === '/api/run').length, 1);
});

test("both personas mirror same-session Dashboard questions, trace and saved image replies without another run", async t => {
  const f = await fixture(t);
  for (const agent of agents.map(a => a.agentName)) {
    await f.chat.load(agent, true);
    const row = f.chat.row(agent), start = activity(row, { runId: `dashboard-${agent}` });
    f.chat.consume(start);
    assert.equal(row.messages.at(-1).content, start.input, "question appears synchronously, before history fetch");
    assert.equal(row.runId, start.runId); assert.equal(row.phase, "running");
    assert.equal(f.chat.snapshot(agent).canStop, false, "mirror never borrows the orb's local abort handle");
    await assert.rejects(f.chat.send(agent, "do not duplicate"), /正在处理/);
    await assert.rejects(f.chat.stop(agent), /完整会话/);
    await row.syncing;
    const reads = f.calls.filter(c => c.path.startsWith("/api/conversations/")).length;
    f.chat.consume({ runId: start.runId, agent, msg: "loop:tool-calls", calls: ["read_file"], time: 100 });
    assert.match(row.detail, /read_file/);
    f.chat.consume({ runId: start.runId, agent: "browser_controller", msg: "loop:thinking", time: 110 });
    assert.match(row.detail, /browser_controller.*思考/);
    f.chat.consume({ runId: start.runId, agent, msg: "progress:updated", time: 120,
      progress: { title: "完成任务", steps: [{ title: "核查", status: "completed" }, { title: "测试", status: "in_progress" }] } });
    assert.equal(row.detail, "1/2 · 测试");
    f.chat.consume({ runId: start.runId, agent, msg: "loop:thinking", time: 105 });
    assert.equal(row.detail, "1/2 · 测试", "older replay cannot move current progress back");
    assert.equal(f.calls.filter(c => c.path.startsWith("/api/conversations/")).length, reads, "trace never polls history");
    const ask = { id: `ask-${agent}`, channel: "web", sessionKey: row.key, expiresAt: new Date(Date.now()+60000).toISOString(), question: "请确认" };
    f.chat.consume({ __harbour: "ask", kind: "new", ask }); assert.equal(row.asks.length, 0, "key-only ask cannot grant a mirrored run's confirmation handle");
    f.chat.consume({ runId: start.runId, agent, msg: "loop:tool-calls", calls: ["ask_user"], time: 130 });
    assert.match(row.detail, /完整会话中等你确认/);
    saveReply(f, start, "![会话图片](/uploads/reply.png)");
    f.chat.consume({ ...start, phase: "complete" }); await row.syncing;
    assert.equal(row.runId, null); assert.equal(row.phase, "complete"); assert.ok(row.replyReadyAt > 0);
    assert.equal(row.messages.length, 2); assert.ok(!row.messages.some(m => m.pendingRunId));
    assert.equal(row.messages[1].parts[0].type, "image");
    const readyAt = row.replyReadyAt;
    f.chat.consume(start); assert.equal(row.runId, null, "replayed start cannot resurrect completed task");
    f.chat.consume({ ...start, phase: "complete" }); await row.syncing;
    assert.equal(row.messages.length, 2); assert.equal(row.replyReadyAt, readyAt);
  }
  assert.equal(f.calls.filter(c => c.path === "/api/run" || c.path.endsWith("/abort")).length, 0);
});

test("mirroring requires the exact selected key, session, persona and channel", async t => {
  const f = await fixture(t); await f.chat.load("main-elaina", true);
  const row = f.chat.row("main-elaina"), start = activity(row);
  for (const wrong of [{ sessionKey: "web:default" }, { sessionKey: "web:orb:other-device:main-elaina" },
    { sessionId: "another-history" }, { agent: "main-aemeath" }, { source: { platform: "qq" } }]) f.chat.consume({ ...start, ...wrong });
  assert.equal(row.runId, null); assert.equal(row.messages.length, 0);
  f.chat.consume(start); await row.syncing;
  f.chat.consume({ runId: "other-run", msg: "loop:thinking", agent: row.agent });
  assert.equal(row.detail, "正在完整会话中处理");
  f.chat.consume({ ...start, runId: "old-run", startedAt: start.startedAt - 1000 });
  assert.equal(row.runId, start.runId);
  f.chat.consume({ ...start, phase: "error", sessionId: "another-history" });
  assert.equal(row.phase, "running"); assert.equal(row.feedback.snapshot(), null);
});

test("QQ/Discord intake supplements cannot replace the running task or strand its final reply", async t => {
  const f = await fixture(t);
  for (const [agent, channel] of [["main-elaina", "qq"], ["main-aemeath", "discord"]]) {
    const session = { id: `mirror-${channel}`, key: `${channel}:fixture`, channel, agentName: agent, messages: [] };
    f.sessions.set(session.id, session);
    await f.chat.select(agent, session.id);
    const row = f.chat.row(agent), run = activity(row, { runId: `formal-${channel}`, source: { platform: channel } });
    f.chat.consume(run); await row.syncing;
    f.chat.consume({ runId: run.runId, agent, msg: "loop:thinking", time: 100 });
    const detail = row.detail;
    const incoming = { ...run, runId: `intake-${channel}`, phase: "incoming", input: "本轮补充", startedAt: undefined };
    f.chat.consume(incoming); await row.syncing;
    assert.equal(row.runId, run.runId, "receiving a supplement does not end/supersede the formal run");
    assert.equal(row.detail, detail, "progress remains attached to the formal task");
    const { sessionId, ...handoff } = incoming;
    f.chat.consume({ ...handoff, phase: "cancelled", intakeHandoff: true });
    assert.equal(row.runId, run.runId);
    assert.equal(f.chat.sync.finished.has(run.runId), false);
    saveReply(f, run, "包含补充的最终回复");
    f.chat.consume({ ...run, phase: "complete" }); await row.syncing;
    assert.equal(row.runId, null); assert.equal(row.phase, "complete");
    assert.equal(row.messages.at(-1).content, "包含补充的最终回复");
    assert.equal(row.messages.some(m => m.pendingRunId), false);
    assert.equal(f.chat.snapshot(agent).readOnly, true); assert.equal(f.chat.snapshot(agent).canStop, false);
    await f.chat.load(agent);
    assert.equal(row.phase, "complete");
  }
  assert.equal(f.calls.some(c => c.method !== "GET"), false, "mirroring never submits, switches, configures or stops channel work");
});

test("intake handoff without sessionId clears only its exact cached intake, not a cancelled task", async t => {
  const f = await fixture(t); await f.chat.load("main-elaina", true);
  const row = f.chat.row("main-elaina"), incoming = activity(row, { runId: "incoming-only", phase: "incoming" });
  f.chat.consume(incoming); await row.syncing;
  const { sessionId, ...base } = incoming;
  const handoff = { ...base, phase: "cancelled", intakeHandoff: true };
  for (const wrong of [{ agent: "main-aemeath" }, { sessionId: "other" }, { sessionKey: "other" }, { source: { platform: "qq" } }]) {
    f.chat.consume({ ...handoff, ...wrong });
    assert.equal(row.runId, incoming.runId, "handoff cannot clear another session/persona/channel");
  }
  f.chat.consume(handoff); await row.syncing;
  assert.equal(row.runId, null); assert.equal(row.phase, "idle");
  assert.equal(row.messages.some(m => m.pendingRunId), false);
  assert.equal(row.replyReadyAt, 0, "handoff is neither a completed answer nor a cancellation");
  f.chat.consume(incoming); assert.equal(row.runId, null, "replayed intake cannot resurrect after handoff");
  const run = activity(row, { runId: "after-handoff" });
  f.chat.consume(run); await row.syncing;
  f.chat.consume({ ...run, phase: "cancelled", intakeHandoff: true });
  assert.equal(row.runId, run.runId, "handoff is valid only for a cached incoming phase");
  saveReply(f, run); f.chat.consume({ ...run, phase: "complete" }); await row.syncing;
  assert.equal(row.phase, "complete");
});

test("orb-origin HTTP response still owns completion; WS echo cannot duplicate question/reply or hydrate over it", async t => {
  let pending;
  const f = await fixture(t, (req, res) => { if (req.url === "/api/run") { pending = res; return true; } });
  const sending = f.chat.send("main-elaina", "local question");
  while (!pending) await new Promise(r => setTimeout(r, 5));
  const row = f.chat.row("main-elaina"), start = activity(row, { runId: row.runId, input: "local question" });
  const before = f.calls.length;
  f.chat.consume(start); f.chat.consume({ ...start, phase: "complete" });
  f.chat.consume({ __harbour: "activity-snapshot", activeRunIds: [], serverEpoch: "new" });
  assert.equal(f.calls.length, before); assert.equal(row.messages.length, 1); assert.ok(row.runId);
  assert.equal(f.chat.snapshot(row.agent).canStop, true);
  json(pending, { answer: "local answer" }); await sending;
  assert.deepEqual(row.messages.map(m => m.content), ["local question", "local answer"]);
  assert.equal(f.calls.filter(c => c.path === "/api/run").length, 1);
});

test("reconnect snapshot resolves a missed terminal from exact stored run evidence, not absence alone", async t => {
  const f = await fixture(t); await f.chat.load("main-elaina", true);
  const row = f.chat.row("main-elaina"), first = activity(row);
  f.chat.consume(first); await row.syncing; saveReply(f, first);
  f.chat.consume({ __harbour: "activity-snapshot", activeRunIds: [], serverEpoch: "server-1" }); await row.syncing;
  assert.equal(row.phase, "complete"); assert.equal(row.runId, null); assert.equal(row.messages.length, 2);
  const second = activity(row, { runId: "unknown-after-restart" });
  f.chat.consume(second); await row.syncing;
  f.chat.consume({ __harbour: "activity-snapshot", activeRunIds: [], serverEpoch: "server-2" }); await row.syncing;
  assert.equal(row.phase, "uncertain"); assert.equal(row.runId, null); assert.match(row.detail, /尚未确认/);
  await assert.rejects(f.chat.send(row.agent, "retry"), /核对/);
  assert.equal(f.calls.filter(c => c.path === "/api/run").length, 0);
});

test("reconnect catches whole missed turns; selected history stays pinned despite a different active session", async t => {
  const f = await fixture(t); await f.chat.load("main-aemeath", true);
  const row = f.chat.row("main-aemeath"), firstId = row.sessionId, event = activity(row);
  saveReply(f, event);
  f.sessions.set("other-active", { ...f.sessions.get(firstId), id: "other-active", messages: [{ role: "assistant", content: "另一会话" }] });
  f.chat.consume({ __harbour: "activity-snapshot", activeRunIds: [], serverEpoch: "server" }); await row.syncing;
  assert.equal(row.messages.at(-1).content, "完整会话的回答"); assert.equal(row.sessionId, firstId);
  const readyAt = row.replyReadyAt; await f.chat.load(row.agent);
  assert.equal(row.sessionId, firstId); assert.equal(row.replyReadyAt, readyAt);
});

test("active WS replay before session load is retained and binds only after ownership-checked history", async t => {
  const f = await fixture(t); const row = f.chat.row("main-elaina");
  const session = { id: "existing-orb", key: row.key, agentName: row.agent, channel: "web", messages: [] };
  f.sessions.set(session.id, session);
  const start = activity(row, { sessionId: session.id }); f.chat.consume(start);
  f.chat.consume({ runId: start.runId, agent: row.agent, msg: "loop:tool-calls", calls: ["read_file"], time: Date.now() });
  assert.equal(row.sessionId, null); assert.equal(f.calls.length, 0, "collapsed startup does not load history");
  await f.chat.load(row.agent);
  assert.equal(row.runId, start.runId); assert.equal(row.messages.at(-1).content, start.input);
  assert.match(row.detail, /read_file/, "latest replayed progress survives opening the panel later");
  await assert.rejects(f.chat.send(row.agent, "duplicate"), /正在处理/);
});

test("late final read cannot overwrite the next external run; concurrent lifecycle reads coalesce", async t => {
  let hold = false, pending, release, readCount = 0;
  const f = await fixture(t, (req, res, _data, url) => {
    if (req.method === "GET" && /^\/api\/conversations\/cs-/.test(url.pathname) && hold) {
      const value = structuredClone(f.sessions.get(url.pathname.split("/").at(-1)));
      readCount++; pending = res; release = () => json(res, { session: value }); return true;
    }
  });
  await f.chat.load("main-elaina", true); const row = f.chat.row("main-elaina"), first = activity(row);
  f.chat.consume(first); await row.syncing; saveReply(f, first);
  hold = true; f.chat.consume({ ...first, phase: "complete" });
  while (!pending) await new Promise(r => setTimeout(r, 5));
  const second = activity(row, { runId: "dashboard-next", input: "下一问", startedAt: first.startedAt + 1 });
  f.chat.consume(second);
  f.chat.consume({ __harbour: "activity-snapshot", activeRunIds: [second.runId] });
  assert.equal(row.runId, second.runId); assert.equal(row.messages.at(-1).content, "下一问");
  hold = false; release(); await row.syncing;
  assert.equal(readCount, 1); assert.equal(row.phase, "running"); assert.equal(row.runId, second.runId);
  assert.deepEqual(row.messages.map(m => m.content), [first.input, "完整会话的回答", "下一问"]);
  saveReply(f, second, "第二问的回答"); f.chat.consume({ ...second, phase: "complete" }); await row.syncing;
  assert.equal(row.messages.length, 4); assert.equal(row.messages.at(-1).content, "第二问的回答");
});

test("external failure/cancellation and failed hydration never replay; opening retries only the read", async t => {
  let deny = false;
  const f = await fixture(t, (req, res, _data, url) => {
    if (deny && req.method === "GET" && /^\/api\/conversations\/cs-/.test(url.pathname)) { json(res, { error: "fixture" }, 503); return true; }
  });
  await f.chat.load("main-aemeath", true); const row = f.chat.row("main-aemeath");
  const first = activity(row); f.chat.consume(first); await row.syncing;
  saveReply(f, first, "失败后保留的断点", "interrupted");
  deny = true; f.chat.consume({ ...first, phase: "error", detail: "执行失败" }); await row.syncing;
  assert.ok(row.runId); assert.match(row.detail, /无法同步/); assert.equal(row.feedback.snapshot().scope, "task");
  deny = false; await f.chat.load(row.agent); assert.equal(row.runId, null); assert.equal(row.phase, "idle");
  assert.equal(row.feedback.snapshot().scope, "task"); assert.equal(row.replyReadyAt, 0);
  const next = activity(row, { runId: "cancelled-external" }); f.chat.consume(next); await row.syncing;
  f.chat.consume({ ...next, phase: "cancelled" }); await row.syncing;
  assert.equal(row.phase, "cancelled"); assert.equal(row.feedback.snapshot(), null);
  assert.equal(f.calls.filter(c => c.path === "/api/run").length, 0);
});

test("a next Dashboard run arriving before the orb HTTP settles is adopted after, without duplicating messages", async t => {
  let pending, posted;
  const f = await fixture(t, (req, res, data) => { if (req.url === "/api/run") { pending = res; posted = data; return true; } });
  const sending = f.chat.send("main-elaina", "球里的问题");
  while (!pending) await new Promise(r => setTimeout(r, 5));
  const row = f.chat.row("main-elaina"), ownId = row.runId;
  saveReply(f, { ...posted, sessionId: posted.session.id }, "球里的回复");
  f.chat.consume(activity(row, { runId: ownId, phase: "complete" }));
  const next = activity(row, { runId: "next-before-http", input: "主窗口接着问" });
  f.chat.consume(next); assert.equal(row.runId, ownId);
  json(pending, { answer: "球里的回复" }); await sending; await row.syncing;
  assert.equal(row.runId, next.runId); assert.equal(row.localRunId, null); assert.equal(row.phase, "running");
  assert.deepEqual(row.messages.map(m => m.content), ["球里的问题", "球里的回复", "主窗口接着问"]);
  assert.equal(f.calls.filter(c => c.path === "/api/run").length, 1);
});

test("reading an old reply cannot unlock an uncertain submission; only its matching saved answer can", async t => {
  const f = await fixture(t, (req, res) => { if (req.url === "/api/run") { json(res, { error: "fixture" }, 500); return true; } });
  await f.chat.load("main-elaina", true); const row = f.chat.row("main-elaina");
  f.sessions.get(row.sessionId).messages.push({ role: "user", content: "旧问题" }, { role: "assistant", content: "旧回复" });
  await f.chat.load(row.agent);
  await assert.rejects(f.chat.send(row.agent, "新问题"), /500/);
  await f.chat.load(row.agent); assert.equal(row.phase, "uncertain");
  await assert.rejects(f.chat.send(row.agent, "重复"), /核对/);
  saveReply(f, activity(row, { runId: row.feedback.runId, input: "新问题" }));
  await f.chat.load(row.agent); assert.equal(row.phase, "complete");
  assert.equal(f.calls.filter(c => c.path === "/api/run").length, 1);
});

test("a terminal event during initial history loading triggers one fresh read instead of losing the reply", async t => {
  let release;
  const f = await fixture(t, (req, res) => {
    if (req.url === "/api/conversations/existing?view=chat" && !release) {
      const old = structuredClone(f.sessions.get("existing")); release = () => json(res, { session: old }); return true;
    }
  });
  const row = f.chat.row("main-elaina");
  f.sessions.set("existing", { id: "existing", agentName: row.agent, key: row.key, channel: "web", messages: [] });
  const loading = f.chat.load(row.agent);
  while (!release) await new Promise(r => setTimeout(r, 5));
  const start = activity(row, { sessionId: "existing" }); f.chat.consume(start); saveReply(f, start);
  f.chat.consume({ ...start, phase: "complete" }); release(); await loading;
  assert.equal(row.phase, "complete"); assert.equal(row.messages.at(-1).content, "完整会话的回答");
  assert.equal(f.calls.filter(c => c.path === "/api/conversations/existing?view=chat").length, 2);
});

test("geometry: both sides, negative monitor origins, small screens and restored offscreen position", () => {
  const stable = placeOrb({ x: 640, y: 450 }, { x: 0, y: 0, width: 1280, height: 900 }, true);
  assert.deepEqual(stable.anchor, { x: 640, y: 450 }, "opening must not move the orb away from the pointer");
  assert.equal(stable.bounds.x + stable.ball.x + 34, 640);
  assert.equal(stable.bounds.y + stable.ball.y + 34, 450);
  for (const work of [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: -1600, y: -100, width: 1600, height: 900 }, { x: 0, y: 0, width: 360, height: 460 }]) {
    for (const point of [{ x: -5000, y: -5000 }, { x: 5000, y: 5000 }, { x: work.x + 90, y: work.y + 80 }]) {
      for (const expanded of [false, true]) {
        const g = placeOrb(point, work, expanded);
        assert.ok(g.bounds.x >= work.x && g.bounds.y >= work.y);
        assert.ok(g.bounds.x + g.bounds.width <= work.x + work.width);
        assert.ok(g.bounds.y + g.bounds.height <= work.y + work.height);
        assert.equal(hitOrb({ x: g.bounds.x + g.ball.x + 34, y: g.bounds.y + g.ball.y + 34 }, g), true);
        assert.equal(hitOrb({ x: g.bounds.x, y: g.bounds.y }, g), false, "transparent margin passes through");
      }
    }
    assert.equal(dockAt({ x: work.x, y: 100 }, work), "left");
    assert.equal(dockAt({ x: work.x + work.width, y: 100 }, work), "right");
    assert.equal(dockAt({ x: work.x + 100, y: 100 }, work), null);
    for (const dock of ["left", "right"]) {
      const g = placeOrb({ x: work.x + 100, y: work.y + 100 }, work, false, dock);
      assert.equal(g.bounds.width, 68); assert.ok(g.bounds.x >= work.x);
      assert.equal(hitOrb({ x: g.bounds.x + 14, y: g.bounds.y + 20 }, g), true);
    }
  }
});

test("uploads use the original API, strip paths, bind handles to persona and allow attachment-only turns", async t => {
  const f = await fixture(t, (req, res, data) => {
    if (req.url === "/api/upload") { json(res, { attachment: { ...data, dataBase64: undefined, path: "private/server/path", url: "/uploads/inbound/test.png", size: 5 } }); return true; }
  });
  const upload = await f.chat.upload("main-aemeath", { name: "hello.png", mime: "image/png", dataBase64: Buffer.from("hello").toString("base64") });
  assert.equal(upload.path, undefined); assert.equal(upload.dataBase64, undefined);
  await assert.rejects(f.chat.send("main-elaina", "wrong persona", [upload.id]), /不属于/);
  await assert.rejects(f.chat.send("main-aemeath", "wrong handle", ["forged-id"]), /不属于/);
  await assert.rejects(f.chat.send("main-aemeath", "duplicate", [upload.id, upload.id]), /不属于/);
  await f.chat.send("main-aemeath", "", [upload.id]);
  const run = f.calls.find(c => c.path === "/api/run").body;
  assert.equal(run.agent, "main-aemeath"); assert.equal(run.attachments[0].url, upload.url);
  assert.equal(run.attachments[0].path, undefined); assert.equal(run.attachments[0].id, undefined);
  assert.match(run.input, /附件/);
  await assert.rejects(f.chat.send("main-aemeath", "used handle", [upload.id]), /已失效/);
  for (const file of [{ name: "../secret", dataBase64: "YQ==" }, { name: "x", dataBase64: "not base64" }, { name: "x", dataBase64: "YR==" }]) {
    await assert.rejects(f.chat.upload("main-aemeath", file), /无效/);
  }
  assert.equal(f.calls.filter(c => c.path === "/api/upload").length, 1);
});

test("invalid upload responses, draft counts, removal and inflight upload reservations", async t => {
  let resolveUpload;
  const f = await fixture(t, (req, res) => {
    if (req.url === "/api/upload") { resolveUpload = () => json(res, { attachment: { url: "https://foreign.invalid/secret" } }); return true; }
  });
  const row = f.chat.row("main-elaina");
  row.uploading = 2;
  await assert.rejects(f.chat.upload(row.agent, { name: "a", dataBase64: "YQ==" }), /等待/);
  row.uploading = 0; row.reservedBytes = 64 * 1024 * 1024;
  await assert.rejects(f.chat.upload(row.agent, { name: "a", dataBase64: "YQ==" }), /64 MB/);
  row.reservedBytes = 0;
  const waiting = f.chat.upload(row.agent, { name: "a", dataBase64: "YQ==" });
  while (!resolveUpload) await new Promise(r => setTimeout(r, 5));
  assert.equal(row.uploading, 1); assert.equal(row.reservedBytes, 1); resolveUpload();
  await assert.rejects(waiting, /有效附件/);
  assert.equal(row.uploading, 0); assert.equal(row.reservedBytes, 0); assert.equal(row.staged.size, 0);
});

test("history and settings only operate on owned sessions, PATCH never changes Main defaults", async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === "/api/agent-defaults") { json(res, { models: [{ modelRef: "mock/small", model: "Mock", effortOptions: [{ effort: "low" }] }], agents: [{ name: "main-elaina", effectiveModelRef: "mock/small" }] }); return true; }
  });
  const first = await f.chat.load("main-elaina", true), second = await f.chat.load("main-elaina", true);
  const other = await f.chat.load("main-aemeath", true);
  const rows = await f.chat.history("main-elaina"); assert.equal(rows.length, 2); assert.ok(rows.every(r => r.id !== other.sessionId));
  await assert.rejects(f.chat.select("main-elaina", other.sessionId), /归属/);
  assert.equal(f.calls.filter(c => c.path === "/api/conversations/switch").length, 0);
  await f.chat.select("main-elaina", first.sessionId); assert.equal(f.chat.row("main-elaina").sessionId, first.sessionId);
  const settings = await f.chat.settings("main-elaina"); assert.equal(settings.defaults.modelRef, "mock/small");
  assert.deepEqual(settings.models[0].efforts, [{ effort: "low" }]);
  await f.chat.configure("main-elaina", { modelRef: "mock/small", reasoningEffort: "low", permissionMode: "plan" });
  assert.equal(f.chat.row("main-elaina").config.permissionMode, "plan");
  assert.equal(f.sessions.get(second.sessionId).permissionMode, undefined);
  const patch = f.calls.filter(c => c.method === "PATCH"); assert.equal(patch.length, 1); assert.equal(patch[0].path, `/api/conversations/${first.sessionId}`);
  await assert.rejects(f.chat.configure("main-elaina", { token: "no" }), /设置无效/);
  f.chat.row("main-elaina").runId = "running";
  await assert.rejects(f.chat.configure("main-elaina", { permissionMode: "bypassPermissions" }), /正在处理/);
  await assert.rejects(f.chat.select("main-elaina", second.sessionId), /正在处理/);
});

test("Main Chat and orb share existing IDs and all history across devices; persona boundaries remain", async t => {
  const f = await fixture(t);
  for (const { agentName: agent } of agents) {
    const base = { agentName: agent, channel: "web", messages: [] };
    const id = `main-${agent}`;
    f.sessions.set(id, { ...base, id, key: `web:default:${agent}`, title: "Main 历史",
      messages: Array.from({ length: 122 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `history ${i}` })) });
    f.sessions.set(`old-${agent}`, { ...base, id: `old-${agent}`, key: `web:orb:other-device:${agent}`, title: "旧悬浮对话" });
    f.sessions.set(`town-${agent}`, { ...base, id: `town-${agent}`, key: `web:town:${agent}`, title: "小镇对话" });
    await f.chat.load(agent);
    assert.equal(f.chat.row(agent).sessionId, id);
    assert.equal(f.chat.snapshot(agent).messages.length, 122, "reading is not silently truncated to 40 messages");
    assert.equal(f.chat.snapshot(agent).messages[0].content, "history 0");
    await f.chat.send(agent, "继续 Main 的对话");
    const run = f.calls.filter(c => c.path === "/api/run").at(-1).body;
    assert.deepEqual(run.session, { id, key: `web:default:${agent}`, channel: "web" });
    assert.equal(f.chat.snapshot(agent).messages.length, 124, "sending does not discard older messages");
    const rows = await f.chat.history(agent);
    assert.equal(rows.length, 3); assert.ok(rows.every(r => r.id.endsWith(agent)));
    assert.deepEqual(new Set(rows.map(r => r.source.kind)), new Set(["web", "orb", "town"]));
    await f.chat.select(agent, `old-${agent}`);
    assert.equal(f.chat.row(agent).key, `web:orb:other-device:${agent}`);
    const start = activity(f.chat.row(agent), { runId: `legacy-${agent}` });
    f.chat.consume(start); await f.chat.row(agent).syncing;
    saveReply(f, start); f.chat.consume({ ...start, phase: "complete" }); await f.chat.row(agent).syncing;
    assert.equal(f.chat.row(agent).messages.at(-1).content, "完整会话的回答");
  }
  assert.equal(f.calls.filter(c => c.path === "/api/conversations/new").length, 0, "no migration, copy or hidden new session");
});

test("history includes every channel and more than 100 records; channel/Cowork views never switch or send", async t => {
  const f = await fixture(t), agent = "main-aemeath";
  for (let i = 0; i < 125; i++) f.sessions.set(`history-${i}`, { id: `history-${i}`, key: `web:default:${agent}`, agentName: agent, channel: "web", messages: [] });
  const cases = [{ id: "qq", channel: "qq", key: "qq:elaina:dm:owner" },
    { id: "dc", channel: "discord", key: "discord:bot:channel" },
    { id: "cowork", channel: "web", key: `web:cowork:${agent}`, cowork: { deviceId: "windows" } }];
  for (const value of cases) f.sessions.set(value.id, { ...value, agentName: agent, title: "原入口的历史", messages: [{ role: "assistant", content: "完整历史" }] });
  const rows = await f.chat.history(agent); assert.equal(rows.length, 128);
  for (const value of cases) {
    await f.chat.select(agent, value.id);
    assert.equal(f.chat.snapshot(agent).readOnly, true);
    assert.equal(f.chat.snapshot(agent).messages[0].content, "完整历史");
    await assert.rejects(f.chat.send(agent, "不能在这里跨渠道发送"), /只读/);
    await assert.rejects(f.chat.configure(agent, { permissionMode: "plan" }), /只读/);
    await assert.rejects(f.chat.upload(agent, { name: "x", dataBase64: "YQ==" }), /只读/);
  }
  await f.chat.select(agent, "qq");
  const row = f.chat.row(agent), event = activity(row, { runId: "qq-live", source: { platform: "qq" } });
  f.chat.consume(event); await row.syncing; assert.equal(row.runId, event.runId);
  saveReply(f, event, "QQ 同步回复"); f.chat.consume({ ...event, phase: "complete" }); await row.syncing;
  assert.equal(row.messages.at(-1).content, "QQ 同步回复"); assert.equal(row.readOnly, true);
  assert.equal(f.calls.filter(c => c.path === "/api/conversations/switch" || c.path === "/api/run" || c.method === "PATCH").length, 0);
  await f.chat.load(agent, true);
  assert.equal(row.readOnly, false); assert.equal(row.key, `web:default:${agent}`);
});

test("legacy history is reused when Main Chat has no active session; no device migration", async t => {
  const f = await fixture(t), row = f.chat.row("main-elaina");
  f.sessions.set("legacy", { id: "legacy", key: "web:orb:old-device:main-elaina", agentName: row.agent, channel: "web", messages: [] });
  await f.chat.load(row.agent);
  assert.equal(row.sessionId, "legacy");
  await f.chat.load(row.agent, true);
  assert.equal(row.key, "web:default:main-elaina");
  assert.equal(f.sessions.get("legacy").key, "web:orb:old-device:main-elaina");
});

test("fresh orb follows Aemeath appearance; manual selection keeps its palette; Dashboard persona changes resync", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-orb-persona-"));
  const screen = new EventEmitter();
  let appearance = { persona: "aemeath", theme: "anime-snowfleece" };
  const controller = new OrbController({ screen, dataDir: dir, agents, deviceId: "test", getAppearance: () => appearance,
    getAvatar: agent => `data:image/png;base64,${agent}`, getConfig: () => ({ url: "http://127.0.0.1:1" }) });
  t.after(() => { controller.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(controller.agent, "main-aemeath"); assert.ok(controller.snapshot().agents.every(a => a.avatar));
  controller.agent = "main-elaina"; assert.equal(controller.snapshot().appearance.theme, "anime-wisteria");
  appearance = { persona: "elaina", theme: "anime-sky" }; controller.syncAppearance(appearance);
  appearance = { persona: "aemeath", theme: "anime-snowfleece" }; controller.syncAppearance(appearance);
  assert.equal(controller.agent, "main-aemeath");
  assert.ok(!JSON.stringify(controller.snapshot()).includes("token"));
});

test("existing APIs and Main defaults; shared Main Chat keys remain persona-specific, no hidden model overrides", async t => {
  const f = await fixture(t);
  await f.chat.send("main-elaina", "hello");
  await f.chat.send("main-elaina", "continue");
  await f.chat.send("main-aemeath", "hello other");
  const runs = f.calls.filter(c => c.path === "/api/run");
  assert.equal(runs.length, 3);
  assert.equal(runs[0].body.session.id, runs[1].body.session.id);
  assert.notEqual(runs[0].body.session.id, runs[2].body.session.id);
  assert.notEqual(runs[0].body.session.key, runs[2].body.session.key);
  assert.equal(runs[0].body.session.key, "web:default:main-elaina");
  assert.deepEqual(Object.keys(runs[0].body).sort(), ["agent", "input", "runId", "session"]);
  assert.ok(runs.every(r => r.authorization === "Bearer private-fixture-token"));
  assert.ok(!JSON.stringify(f.chat.snapshot("main-elaina")).includes("private-fixture-token"));
  assert.equal(f.chat.snapshot("main-elaina").messages.length, 4);
  assert.equal(f.chat.snapshot("main-aemeath").messages.length, 2);
  await assert.rejects(f.chat.send("browser_controller", "no"), /Main/);
  await assert.rejects(f.chat.send("main-elaina", "x".repeat(24001)), /24000/);
  assert.equal(f.calls.filter(c => c.path === "/api/run").length, 3);
});

test("double submission blocked; exact owned abort only, hidden shell does not own HTTP lifetime", async t => {
  let pending, started; const ready = new Promise(r => started = r);
  const f = await fixture(t, (req, res) => {
    if (req.url === "/api/run") { pending = res; started(); return true; }
    if (req.url.endsWith("/abort")) { json(res, { ok: true }); json(pending, { aborted: true }, 499); return true; }
  });
  const promise = f.chat.send("main-elaina", "one task");
  await ready;
  assert.doesNotThrow(() => f.chat.snapshot("main-elaina"));
  await assert.rejects(f.chat.send("main-elaina", "duplicate"), /正在处理/);
  assert.equal(await f.chat.stop("main-aemeath"), false);
  const runId = f.chat.row("main-elaina").runId;
  await f.chat.stop("main-elaina"); await promise;
  assert.equal(f.calls.filter(c => c.path.endsWith("/abort"))[0].path, `/api/runs/${runId}/abort`);
  assert.equal(f.chat.row("main-elaina").phase, "cancelled");
  assert.equal(f.chat.snapshot("main-elaina").replyReadyAt, 0);
  assert.equal(f.calls.filter(c => c.path === "/api/run").length, 1);
});

test("reply timestamp is persona-bound, survives rereads, and resets for fresh/selected sessions", async t => {
  const f = await fixture(t);
  await f.chat.send("main-elaina", "hello");
  const first = f.chat.snapshot("main-elaina"), original = first.sessionId;
  assert.ok(first.replyReadyAt > 0);
  assert.equal(f.chat.snapshot("main-aemeath").replyReadyAt, 0);
  await f.chat.load("main-elaina");
  assert.equal(f.chat.snapshot("main-elaina").replyReadyAt, first.replyReadyAt, "opening view again cannot restart the expression");
  await f.chat.load("main-elaina", true);
  assert.equal(f.chat.snapshot("main-elaina").phase, "idle");
  assert.equal(f.chat.snapshot("main-elaina").replyReadyAt, 0);
  await f.chat.send("main-elaina", "second session");
  assert.ok(f.chat.snapshot("main-elaina").replyReadyAt > 0);
  await f.chat.select("main-elaina", original);
  assert.equal(f.chat.snapshot("main-elaina").replyReadyAt, 0);
  assert.equal(f.chat.snapshot("main-elaina").phase, "idle");
});

test("ask isolation and late answers; unresolved asks do not auto-approve", async t => {
  let finish, started; const ready = new Promise(r => started = r);
  const f = await fixture(t, (req, res) => { if (req.url === "/api/run") { finish = () => json(res, { answer: "done" }); started(); return true; } });
  const running = f.chat.send("main-elaina", "ask task"); await ready;
  const row = f.chat.row("main-elaina");
  const ask = { id: "ask-one", channel: "web", sessionKey: row.key, question: "Proceed?", options: [{ label: "No", value: "no" }], expiresAt: new Date(Date.now() + 60000).toISOString() };
  f.chat.consume({ __harbour: "ask", kind: "new", ask: { ...ask, sessionKey: "qq:foreign" } });
  assert.equal(row.asks.length, 0);
  f.chat.consume({ __harbour: "ask", kind: "new", ask });
  assert.equal(row.phase, "waiting"); assert.equal(row.asks.length, 1);
  await assert.rejects(f.chat.answer("main-aemeath", "ask-one", "yes"), /失效/);
  assert.equal(f.calls.filter(c => c.path.includes("/answer")).length, 0);
  await f.chat.answer("main-elaina", "ask-one", "no");
  assert.equal(row.asks.length, 0);
  await assert.rejects(f.chat.answer("main-elaina", "ask-one", "yes"), /失效/);
  finish(); await running;
});

test("shared-key concurrent sessions cannot lend the orb each other's confirmation cards", async t => {
  const f = await fixture(t);
  await f.chat.load("main-elaina", true);
  const row = f.chat.row("main-elaina"); row.localRunId = row.runId = "local-run"; row.localStartedAt = Date.now();
  f.chat.consume(activity(row, { runId: row.localRunId }));
  const ask = { id: "ask-shared", channel: "web", sessionKey: row.key, question: "confirm", createdAt: new Date(row.localStartedAt).toISOString(), expiresAt: new Date(Date.now()+60000).toISOString() };
  f.chat.consume({ __harbour: "ask", kind: "new", ask }); assert.equal(row.asks.length, 1);
  f.chat.consume(activity(row, { runId: "another-main-run", sessionId: "another-main-session" }));
  await assert.rejects(f.chat.answer(row.agent, ask.id, "yes"), /归属不明确/);
  f.chat.consume({ __harbour: "ask", kind: "new", ask: { ...ask, id: "ambiguous-new" } });
  assert.equal(row.asks.length, 1); assert.equal(f.calls.filter(c => c.path.includes("/answer")).length, 0);
});

test("network/redirect failure does not retry or leak token; interrupted send requires inspection", async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === "/api/run") { res.writeHead(302, { Location: "https://must-not-follow.invalid" }); res.end('{}'); return true; }
  });
  await assert.rejects(f.chat.send("main-elaina", "one"), /302/);
  assert.equal(f.chat.row("main-elaina").phase, "uncertain");
  await assert.rejects(f.chat.send("main-elaina", "retry"), /核对/);
  assert.equal(f.calls.filter(c => c.path === "/api/run").length, 1);
  await f.chat.load("main-elaina", true);
  assert.equal(f.chat.row("main-elaina").phase, "idle");
});

test("real chat projection binds failure to its run/persona, retains late evidence, and resets on new session", async t => {
  let pending, started; const ready = new Promise(resolve => started = resolve);
  const f = await fixture(t, (req, res) => { if (req.url === "/api/run") { pending = res; started(); return true; } });
  const promise = f.chat.send("main-elaina", "isolated task"); await ready;
  const row = f.chat.row("main-elaina"), event = { runId: row.runId, traceId: "child-loop", parentTraceId: "main-loop", agent: "trajectory-checker", msg: "loop:end", status: "failed", time: 1000 };
  f.chat.consume(event);
  assert.equal(f.chat.snapshot(row.agent).failure.scope, "subagent");
  assert.equal(f.chat.snapshot("main-aemeath").failure, null);
  json(pending, { answer: "已经返回，请查看本轮失败项。" }); await promise;
  assert.equal(f.chat.snapshot(row.agent).phase, "complete"); assert.ok(f.chat.snapshot(row.agent).failure);
  f.chat.consume({ ...event, __harbour: "channel-activity", agent: row.agent, sessionId: row.sessionId, phase: "error", time: 1100 });
  assert.equal(f.chat.snapshot(row.agent).failure.scope, "task", "late WS failure remains visible after HTTP reply");
  assert.equal(f.calls.filter(call => call.path === "/api/run").length, 1);
  await f.chat.load(row.agent, true); f.chat.consume(event);
  assert.equal(f.chat.snapshot(row.agent).failure, null);
  assert.equal(f.chat.snapshot(row.agent).replyReadyAt, 0);
});

test("confirmed failure face never unlocks an uncertain request or automatically retries it", async t => {
  let pending, started; const ready = new Promise(resolve => started = resolve);
  const f = await fixture(t, (req, res) => { if (req.url === "/api/run") { pending = res; started(); return true; } });
  const promise = f.chat.send("main-aemeath", "isolated failure"); await ready;
  const row = f.chat.row("main-aemeath");
  f.chat.consume({ __harbour: "channel-activity", runId: row.runId, sessionId: row.sessionId, agent: row.agent, phase: "error" });
  json(pending, { error: "fixture task failed" }, 500); await assert.rejects(promise, /HTTP 500/);
  assert.equal(f.chat.snapshot(row.agent).failure.scope, "task"); assert.equal(row.phase, "uncertain");
  await assert.rejects(f.chat.send(row.agent, "retry"), /核对/);
  assert.equal(f.calls.filter(call => call.path === "/api/run").length, 1);
});

test("foreign sessions and disabled history are rejected before any run", async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url.startsWith("/api/conversations?")) { json(res, { enabled: true, activeId: "foreign" }); return true; }
    if (req.url === "/api/conversations/foreign?view=chat") { json(res, { session: { id: "foreign", key: "qq:other", agentName: "main-elaina", channel: "qq" } }); return true; }
  });
  await assert.rejects(f.chat.send("main-elaina", "hello"), /归属/);
  assert.equal(f.calls.some(c => c.path === "/api/run"), false);
  const disabled = await fixture(t, (_req, res) => { json(res, { enabled: false, sessions: [] }); return true; });
  await assert.rejects(disabled.chat.send("main-elaina", "hello"), /开启.*会话记忆/);
  assert.equal(disabled.calls.some(c => c.method === "POST"), false);
});

test("bounded timeout and disposal do not retry", async t => {
  const f = await fixture(t, (req) => req.url === "/api/run", { timeoutMs: 30 });
  await assert.rejects(f.chat.send("main-elaina", "hello"), /超时/);
  assert.equal(f.calls.filter(c => c.path === "/api/run").length, 1);
  f.chat.dispose(); await assert.rejects(f.chat.request("/api/asks"), /退出/);
});

test("native IPC requires exact owned frame; visibility preference stores no chat or credentials", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-orb-test-"));
  const screen = new EventEmitter(); screen.getPrimaryDisplay = () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } });
  screen.getDisplayNearestPoint = screen.getPrimaryDisplay;
  const controller = new OrbController({ screen, dataDir: dir, getConfig: () => ({ url: "http://127.0.0.1:1", token: "secret" }), agents,
    deviceId: "device", getAppearance: () => ({}), openConversation: () => {}, openDashboard: () => {} });
  const frame = { url: controller.expectedUrl }, sender = { mainFrame: frame, getURL: () => frame.url, isLoadingMainFrame: () => false, send() {} };
  controller.win = { webContents: sender, isDestroyed: () => false, setBounds() {}, hide() {}, destroy() {} };
  const event = { sender, senderFrame: frame };
  t.after(() => { controller.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await controller.action(event, { action: "state" })).agent, "main-elaina");
  for (const bad of [{ sender: { ...sender }, senderFrame: frame }, { sender, senderFrame: { ...frame } }]) {
    await assert.rejects(controller.action(bad, { action: "send", text: "not allowed" }), /专属窗口/);
  }
  frame.url = "https://untrusted.invalid";
  await assert.rejects(controller.action(event, { action: "state" }), /专属窗口/);
  frame.url = controller.expectedUrl;
  await assert.rejects(controller.action(event, { action: "fetch", url: "http://evil" }), /不支持/);
  await controller.setEnabled(false);
  const saved = JSON.parse(fs.readFileSync(controller.statePath));
  assert.equal(saved.enabled, false);
  assert.ok(!JSON.stringify(saved).includes("secret")); assert.equal(saved.messages, undefined);
});

test("image projection: Markdown, ordinary links, bare Chinese paths, order, deduplication and literal code", () => {
  const references = [];
  const message = projectMessage({ role: "assistant", content: '前文 **看这里**\n![第一张](/uploads/a.png)\n中间\n[第二张](</uploads/第二 张.webp>)\n尾声：/uploads/c.gif。\n![重复](/uploads/a.png)\n`/uploads/code.png`\n```md\n![示例](/uploads/example.png)\n```',
    attachments: [{ kind: "image", name: "a", url: "/uploads/a.png" }, { kind: "file", name: "doc", url: "/uploads/a.pdf" }] }, "http://localhost:7788", url => { references.push(url); return url; });
  assert.deepEqual(references, ["/uploads/a.png", "/uploads/%E7%AC%AC%E4%BA%8C%20%E5%BC%A0.webp", "/uploads/c.gif"]);
  assert.equal(message.parts.filter(p => p.type === "image").length, 3);
  assert.ok(message.parts.filter(p => p.type === "text").map(p => p.text).join("").includes("/uploads/code.png"));
  assert.ok(message.parts.at(-1).text.includes("![示例](/uploads/example.png)"));
  assert.equal(message.attachments.length, 1);
  assert.equal(message.parts[2].text, "\n中间\n");
});

test("image targets stay on controlled upload/proxy routes, including remote backend base paths", () => {
  const server = "https://harbour.example/harbour";
  for (const raw of ["file:///secret.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "//foreign/x.png", "/api/secrets.png",
    "/uploads/../secret.png", "/uploads/%2e%2e/secret.png", "/uploads/a%2fb.png", "/uploads/%252e%252e/x.png", "/uploads/a\\b.png",
    "https://harbour.example/harbour/uploads/a/../secret.png", "https://harbour.example/harbour/api/secret.png",
    "https://name:password@foreign.example/a.png", "/uploads/x.svg"]) assert.equal(imageTarget(raw, server, true), null, raw);
  assert.equal(imageTarget("https://harbour.example/harbour/uploads/a.png?token=do-not-copy#x", server).path, "/uploads/a.png");
  assert.equal(imageTarget("/uploads/中文.png", server).path, "/uploads/%E4%B8%AD%E6%96%87.png");
  assert.match(imageTarget("https://cdn.example/image?id=one", server, true).path, /^\/api\/img-proxy\?url=/);
  assert.equal(imageTarget("https://cdn.example/article", server), null);
  assert.equal(rasterMime(png), "image/png"); assert.equal(rasterMime(Buffer.from("<svg/>")), null);
});

test("expired images remain placeholders and do not acquire download handles", () => {
  const message = projectMessage({ role: "assistant", content: "![旧图](/uploads/old.png)",
    attachments: [{ url: "/uploads/old.png", kind: "image", expired: true }] }, "http://localhost", () => assert.fail("must not issue expired image"));
  assert.deepEqual(message.parts, [{ type: "image", name: "旧图", expired: true }]);
});

test("live/history image handles match; bytes carry header auth, no token or arbitrary URL reaches renderer", async t => {
  const answer = "完成了。\n![成图](/uploads/reply.png)\n[重复](/uploads/reply.png)";
  const f = await fixture(t, (req, res) => {
    if (req.url === "/api/run") { json(res, { answer }); return true; }
    if (req.url === "/uploads/reply.png") { res.writeHead(200, { "Content-Type": "image/png" }); res.end(png); return true; }
  });
  await f.chat.send("main-aemeath", "hello");
  const reply = f.chat.snapshot("main-aemeath").messages.at(-1), id = reply.parts.find(p => p.type === "image").id;
  assert.equal(f.calls.some(c => c.path.startsWith("/uploads/")), false, "projection alone does not eagerly download history");
  await assert.rejects(f.chat.image("main-elaina", id), /当前会话/);
  await assert.rejects(f.chat.image("main-aemeath", "/uploads/other.png"), /当前会话/);
  const values = await Promise.all([f.chat.image("main-aemeath", id), f.chat.image("main-aemeath", id)]);
  assert.equal(values[0].mime, "image/png"); assert.deepEqual(values[0].bytes, png);
  assert.equal(f.calls.filter(c => c.path === "/uploads/reply.png").length, 1, "same in-flight image coalesces");
  assert.equal(f.calls.at(-1).authorization, "Bearer private-fixture-token");
  assert.ok(!JSON.stringify(values).includes("private-fixture-token"));
  const row = f.chat.row("main-aemeath");
  f.sessions.get(row.sessionId).messages = [{ role: "user", content: "hello" }, { role: "assistant", content: answer }];
  await f.chat.load(row.agent);
  assert.deepEqual(f.chat.snapshot(row.agent).messages.at(-1), reply, "reopening renders the exact same projection");
  await f.chat.load(row.agent, true);
  await assert.rejects(f.chat.image(row.agent, id), /当前会话/);
  assert.equal(f.calls.filter(c => c.path === "/api/run").length, 1);
});

test("late image responses cannot cross a switched session or changed backend", async t => {
  let finishImage, started; const ready = new Promise(resolve => started = resolve);
  const f = await fixture(t, (req, res) => {
    if (req.url === "/api/run") { json(res, { answer: "![成图](/uploads/late.png)" }); return true; }
    if (req.url === "/uploads/late.png") { finishImage = () => { res.writeHead(200, { "Content-Type": "image/png" }); res.end(png); }; started(); return true; }
  });
  await f.chat.send("main-elaina", "hello");
  const id = f.chat.snapshot("main-elaina").messages.at(-1).parts[0].id;
  const pending = f.chat.image("main-elaina", id); await ready;
  await f.chat.load("main-elaina", true); finishImage();
  await assert.rejects(pending, /会话已切换/);
  await f.chat.send("main-elaina", "next");
  const next = f.chat.snapshot("main-elaina").messages.at(-1).parts[0].id;
  f.config.url += "/other-server";
  await assert.rejects(f.chat.image("main-elaina", next), /当前会话/);
});

test("image failures are bounded, never follow redirects or retry, and preserve the original response", async t => {
  const cases = {
    missing: [404, "text/plain", "not here"], auth: [401, "text/plain", "private-fixture-token"],
    redirect: [302, "image/png", ""], svg: [200, "image/svg+xml", "<svg/>"] ,
    fake: [200, "image/png", "<html>private-fixture-token</html>"], large: [200, "image/png", ""],
  };
  for (const [name, [status, type, body]] of Object.entries(cases)) {
    const f = await fixture(t, (req, res) => {
      if (req.url === "/api/run") { json(res, { answer: "![成图](/uploads/bad.png)" }); return true; }
      if (req.url === "/uploads/bad.png") {
        res.writeHead(status, { "Content-Type": type, ...(name === "large" ? { "Content-Length": 20 * 1024 * 1024 } : {}),
          ...(name === "redirect" ? { Location: "https://must-not-follow.invalid" } : {}) }); res.end(body); return true;
      }
    });
    await f.chat.send("main-elaina", "hello");
    const reply = f.chat.snapshot("main-elaina").messages.at(-1);
    await assert.rejects(f.chat.image("main-elaina", reply.parts[0].id), error => !error.message.includes("private-fixture-token"), name);
    assert.deepEqual(f.chat.snapshot("main-elaina").messages.at(-1), reply);
    assert.equal(f.chat.row("main-elaina").phase, "complete");
    assert.equal(f.calls.length, 5, "shared list, legacy explorer fallback, new, run, image; no retry");
  }
});
