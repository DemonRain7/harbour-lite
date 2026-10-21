"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { OrbSignals, musicSignal } = require("../companion/orb-signals");
const { status } = require("../renderer/orb-status");
const agents = ["main-elaina", "main-aemeath"];
const store = () => new OrbSignals({ agents });
const event = (patch = {}) => ({ __harbour: "channel-activity", agent: agents[0], runId: "fixture-run", phase: "running",
  sessionId: "fixture-session", sessionKey: "web:main", task: "整理资料", source: { platform: "web", locationName: "Main Chat" }, ...patch });
const music = { provider: "folia", loaded: true, connected: true, running: true, paused: false, currentTrackId: "b",
  tracks: [{ id: "a", title: "未播放的歌" }, { id: "b", title: "不散的夏之灯", artist: "歌手", path: "private.mp3" }] };
const ask = (id, patch = {}) => ({ __harbour: "ask", kind: "new", ask: {
  id, agent: agents[0], sessionKey: "web:main", expiresAt: new Date(Date.now() + 60_000).toISOString(), ...patch } });

test("cross-channel task status is persona-bound, child trace stays on its root run", () => {
  const s = store();
  s.consume(event());
  s.consume(event({ agent: agents[1], runId: "aemeath-run", source: { platform: "qq", locationName: "主人私聊" } }));
  assert.equal(s.snapshot(agents[0]).task.source, "Web · Main Chat");
  assert.equal(s.snapshot(agents[1]).task.source, "QQ · 主人私聊");
  s.consume({ runId: "fixture-run", agent: "researcher", msg: "loop:tool-calls", calls: ["web_search"], time: 10 });
  assert.match(s.snapshot(agents[0]).task.detail, /researcher.*web_search/);
  const before = s.snapshot(agents[0]);
  s.consume({ runId: "fixture-run", sessionId: "different", msg: "loop:thinking", time: 11 });
  s.consume({ runId: "fixture-run", msg: "loop:thinking", time: 9 });
  s.consume(event({ agent: agents[1], runId: "fixture-run" }));
  s.consume(event({ companionId: "aemeath" }));
  s.consume(event({ agent: "browser_controller", runId: "unmounted" }));
  assert.deepEqual(s.snapshot(agents[0]), before);
  assert.equal(s.tasks.size, 2);
});

test("two concurrent tasks keep running when one returns; only exact opened notification clears", () => {
  const s = store(); s.consume(event()); s.consume(event({ runId: "second", source: { platform: "web", locationName: "小镇" } }));
  assert.equal(s.snapshot(agents[0]).task.count, 2);
  s.consume(event({ phase: "complete" }));
  assert.equal(s.snapshot(agents[0]).task.runId, "second");
  assert.equal(s.snapshot(agents[0]).task.kind, "working");
  assert.equal(s.snapshot(agents[0]).notification, "reply");
  s.acknowledge(agents[1], "fixture-run"); assert.equal(s.tasks.size, 2);
  s.acknowledge(agents[0], "second"); assert.equal(s.tasks.size, 2, "viewing an active run cannot dismiss it");
  s.acknowledge(agents[0], "fixture-run"); assert.equal(s.snapshot(agents[0]).notification, "none");
  s.consume(event({ phase: "running" })); s.consume(event({ phase: "complete" }));
  assert.equal(s.tasks.size, 1, "replay does not resurrect read notifications");
  s.consume(event({ runId: "second", phase: "cancelled" })); assert.equal(s.snapshot(agents[0]).task, null);
});

test("disconnection and missing active snapshot never invent a success", () => {
  const s = store(); s.consume(event());
  assert.equal(s.snapshot(agents[0], "closed").task.kind, "unknown");
  assert.equal(s.snapshot(agents[0], "closed").notification, "none");
  s.consume({ __harbour: "activity-snapshot", activeRunIds: [] });
  assert.equal(s.snapshot(agents[0]).task.kind, "unknown");
  assert.equal(s.snapshot(agents[0]).notification, "none");
  s.consume(event({ phase: "error", detail: "执行失败" }));
  s.consume(event({ phase: "complete" }));
  assert.equal(s.snapshot(agents[0]).task.kind, "failed", "duplicate terminal cannot erase a confirmed failure");
});

test("concurrent asks, subagent asks, resolution and expired asks are display-only", () => {
  const s = store(); s.consume(event());
  s.consume(ask("first")); s.consume(ask("second", { agent: "browser_controller" }));
  assert.equal(s.snapshot(agents[0]).task.kind, "waiting");
  s.consume({ ...ask("first"), kind: "resolved" });
  assert.equal(s.snapshot(agents[0]).task.kind, "waiting");
  s.consume({ ...ask("second"), kind: "resolved" });
  assert.equal(s.snapshot(agents[0]).task.kind, "working");
  s.consume(ask("lost-resolution"));
  s.consume({ __harbour: "activity-snapshot", activeRunIds: ["fixture-run"] });
  assert.equal(s.snapshot(agents[0]).task.kind, "working", "reconnect cannot certify that an old ask is still unanswered");
  s.consume(ask("expired", { expiresAt: new Date(0).toISOString() }));
  s.consume(ask("foreign", { agent: agents[1] }));
  s.consume({ ...ask("not-new"), kind: "other" });
  assert.equal(s.snapshot(agents[0]).task.kind, "working");
  s.consume(event({ runId: "ambiguous", sessionId: "other-session" }));
  s.consume(ask("ambiguous-ask"));
  assert.equal(s.snapshot(agents[0]).task.kind, "working", "legacy source key cannot pick between simultaneous runs");
});

test("wrong IDs and intake handoffs never become task links or lingering notifications", () => {
  const s = store();
  for (const runId of [null, {}, "../other", "x".repeat(161)]) s.consume(event({ runId }));
  assert.equal(s.tasks.size, 0);
  s.consume(event({ sessionId: "https://example.test", task: "x".repeat(500) }));
  assert.equal(s.snapshot(agents[0]).task.canOpen, false);
  assert.equal(s.snapshot(agents[0]).task.title.length, 160);
  s.consume(event({ phase: "complete", intakeHandoff: true }));
  assert.equal(s.snapshot(agents[0]).task, null);
});

test("music reflects only confirmed selected track and ignores playback ticks", () => {
  const s = store(); let updates = 0; s.on("change", () => updates++);
  s.setMusic(music); assert.deepEqual(s.snapshot(agents[0]).music, {
    provider: "folia", title: "不散的夏之灯", artist: "歌手", paused: false });
  for (let i = 0; i < 20; i++) s.setMusic({ ...music, positionMs: i * 1000, volume: i });
  assert.equal(updates, 1, "position updates do not repaint or resend music queue");
  assert.doesNotMatch(JSON.stringify(s.snapshot(agents[0])), /未播放|private|positionMs|volume/);
  s.setMusic({ ...music, paused: true }); assert.equal(updates, 2);
  s.setMusic({ ...music, running: false }); assert.equal(s.snapshot(agents[0]).music, null);
  for (const value of [null, {}, { ...music, loaded: false }, { ...music, connected: false },
    { ...music, providerAvailable: false }, { ...music, currentTrackId: "missing" }, { loaded: true, tracks: [{ title: "not loaded" }] }]) {
    assert.equal(musicSignal(value), null);
  }
});

test("reading one confirmed orb session cannot clear another channel or active task", () => {
  const s = store(); s.consume(event({ phase: "complete" }));
  s.consume(event({ runId: "qq", sessionId: "qq-session", phase: "error" }));
  s.consume(event({ runId: "running" }));
  s.acknowledgeSession(agents[0], "fixture-session");
  assert.equal(s.tasks.has("fixture-run"), false); assert.equal(s.tasks.has("qq"), true); assert.equal(s.tasks.has("running"), true);
});

test("state storage is bounded even if many transient tasks arrive", () => {
  const s = store();
  s.consume(event());
  for (let i = 0; i < 600; i++) s.consume(event({ runId: `terminal-${i}`, phase: "complete" }));
  assert.ok(s.tasks.size <= 128); assert.ok(s.finished.size <= 512);
  assert.equal(s.tasks.has("fixture-run"), true, "terminal history is evicted before an active run");
});

test("projection keeps music and work independent, never animates offline work", () => {
  const s = store(); s.consume(event()); s.setMusic(music);
  const online = { connection: "open", signals: s.snapshot(agents[0]) };
  assert.deepEqual([status(online).kind, status(online).busy, status(online).musicState], ["working", true, "playing"]);
  s.consume(event({ phase: "complete" }));
  assert.equal(status({ ...online, signals: s.snapshot(agents[0]) }).alert, "reply");
  assert.equal(status({ ...online, chat: { phase: "waiting", asks: [{}], runId: "own" } }).alert, "waiting");
  const offline = status({ connection: "closed", chat: { phase: "waiting", runId: "own" }, signals: s.snapshot(agents[0], "closed") });
  assert.equal(offline.kind, "unknown"); assert.equal(offline.busy, false); assert.equal(offline.musicState, "playing");
  assert.equal(status({ connection: "open", chat: { loading: true } }).busy, false, "loading history is not execution");
  assert.equal(status({ connection: "open", chat: { phase: "cancelled" } }).alert, "none");
  assert.equal(status({ connection: "open" }).kind, "idle");
  assert.equal(status({ connection: "open", unread: true }).alert, "reply");
});

test("clear failure wins over an unread dot without suppressing concurrent motion", () => {
  const view = status({ connection: "open", unread: true, chat: { runId: "own" } }, { mood: "failed", label: "子任务失败" });
  assert.equal(view.kind, "failed"); assert.equal(view.alert, "failed"); assert.equal(view.busy, true);
});

test("orb music shortcut opens the selected provider without switching it or starting playback", async () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  assert.match(main, /openMusic: \(\) => executeMusicCommand\(\{ action: "open" \}\)/);
  const start = main.indexOf("async function executeMusicCommand(");
  const code = main.slice(start, main.indexOf("\nfunction ", start));
  for (const provider of ["folia", "qqmusic", "local"]) {
    const calls = [];
    const run = vm.runInNewContext(`(${code})`, { currentMusicProvider: () => provider,
      setMusicProvider: () => { throw new Error("must not switch player"); },
      folia: { command: command => calls.push(command.action) },
      qqMusicBridge: { execute: action => { calls.push(action); return {}; } },
      createAuxiliaryWindow: (kind, options) => { calls.push(`${kind}:${options.show}`); return { isDestroyed: () => false }; },
      publishMusicState() {}, qqMusicStateForBridge: state => state });
    await run({ action: "open" });
    assert.deepEqual(calls, provider === "local" ? ["music:true"] : ["open"]);
  }
});
