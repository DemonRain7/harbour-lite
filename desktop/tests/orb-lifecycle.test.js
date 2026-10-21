"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { OrbController } = require("../companion/orb-controller");
const { expression } = require("../renderer/orb-expression");
// Native lifecycle fixtures are independent of all live windows, profiles and APIs.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-orb-lifecycle-"));
  const windows = [], visibility = [];
  let load = async () => {};
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.bounds = options; this.top = options.alwaysOnTop;
      this.webContents = Object.assign(new EventEmitter(), {
        isDestroyed: () => this.destroyed, isLoadingMainFrame: () => false,
        setWindowOpenHandler() {}, send() {},
      });
      windows.push(this);
    }
    loadFile() { return load(); }
    setMenu() {} setMenuBarVisibility() {}
    isDestroyed() { return !!this.destroyed; }
    isVisible() { return !!this.visible; }
    isMinimized() { return !!this.minimized; }
    setBounds(bounds) { this.bounds = bounds; }
    setIgnoreMouseEvents(value) { this.ignored = value; }
    setAlwaysOnTop(value) { this.top = value; }
    restore() { this.minimized = false; }
    showInactive() { this.visible = true; this.shows = (this.shows || 0) + 1; }
    moveTop() { this.raises = (this.raises || 0) + 1; }
    hide() { this.visible = false; }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const screen = Object.assign(new EventEmitter(), {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  });
  const options = { BrowserWindow: Window, screen, Menu: {}, dataDir: dir,
    agents: [{ agentName: "main-elaina", displayName: "Elaina" }], deviceId: "fixture",
    getConfig: () => ({ url: "http://127.0.0.1:1" }), getAppearance: () => ({}),
    onVisibility: value => visibility.push(value) };
  const c = new OrbController(options);
  t.after(() => { c.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { c, windows, visibility, options, load: fn => { load = fn; } };
}

test("panel resizing persists once, restores after relaunch and never restarts the active conversation", async t => {
  const { c, options } = fixture(t); c.hidden = true; c.anchor = { x: 250, y: 170 };
  c.chat.load = async () => c.chat.snapshot(c.agent); c.chat.refreshAsks = async () => {};
  let cursor = { x: 600, y: 600 }; c.screen.getCursorScreenPoint = () => cursor;
  await c.start(); await c.expand(true, false);
  const row = c.chat.row(c.agent); row.runId = "keep-this-run"; row.sessionId = "keep-this-session";
  const original = { ...c.layout.panel }, savedBefore = fs.readFileSync(c.statePath, "utf8"), pushes = [];
  c.win.webContents.send = (...args) => pushes.push(args[0]);
  c.startResize("se"); pushes.length = 0;
  cursor = { x: 780, y: 720 }; c.moveResize();
  assert.equal(c.pinned, true); assert.equal(c.resize.moved, true);
  assert.deepEqual(pushes, ["orb:layout"], "pointer moves do not resend chat history");
  assert.equal(fs.readFileSync(c.statePath, "utf8"), savedBefore, "no disk writes per pointer move");
  assert.equal(c.layout.panel.width, original.width + 180); assert.equal(c.layout.panel.height, original.height + 120);
  c.publish(); c.reflow(); // regular progress and layout refresh cannot reset size
  const chosen = { ...c.panelSize }; c.endResize();
  assert.deepEqual(JSON.parse(fs.readFileSync(c.statePath)).panelSize, chosen);
  assert.equal(row.runId, "keep-this-run"); assert.equal(row.sessionId, "keep-this-session");
  await c.expand(false); await c.expand(true, true);
  assert.equal(c.layout.panel.width, chosen.width); assert.equal(c.layout.panel.height, chosen.height);
  await c.setEnabled(false); await c.setEnabled(true); await c.expand(true, true);
  assert.deepEqual(c.panelSize, chosen);
  const next = new OrbController({ ...options, hidden: true }); t.after(() => next.dispose());
  next.chat.load = async () => next.chat.snapshot(next.agent); next.chat.refreshAsks = async () => {};
  await next.start(); await next.expand(true, true);
  assert.deepEqual(next.panelSize, chosen); assert.equal(next.layout.panel.width, chosen.width); assert.equal(next.layout.panel.height, chosen.height);
});

test("temporary small-display fitting does not overwrite the preferred chat size", async t => {
  const { c } = fixture(t); c.hidden = true;
  c.chat.load = async () => c.chat.snapshot(c.agent); c.chat.refreshAsks = async () => {};
  let area = { x: -1000, y: -100, width: 1000, height: 900 };
  c.screen.getDisplayNearestPoint = () => ({ workArea: area });
  c.panelSize = { width: 760, height: 650 }; c.anchor = { x: -750, y: 50 };
  await c.start(); await c.expand(true, true);
  area = { x: 0, y: 0, width: 360, height: 440 }; c.onDisplayChange();
  assert.equal(c.layout.panel.width, 340); assert.equal(c.layout.panel.height, 342);
  assert.deepEqual(c.panelSize, { width: 760, height: 650 });
  assert.deepEqual(JSON.parse(fs.readFileSync(c.statePath)).panelSize, c.panelSize);
  area = { x: 0, y: 0, width: 1000, height: 900 }; c.onDisplayChange();
  assert.equal(c.layout.panel.width, 760); assert.equal(c.layout.panel.height, 650);
});

test("resize cancellation, interrupted gestures and reset preserve a valid saved preference", async t => {
  const { c } = fixture(t); c.hidden = true; c.anchor = { x: 250, y: 150 };
  c.chat.load = async () => c.chat.snapshot(c.agent); c.chat.refreshAsks = async () => {};
  let cursor = { x: 600, y: 600 }; c.screen.getCursorScreenPoint = () => cursor;
  await c.start(); await c.expand(true, true);
  const initial = { ...c.layout.bounds };
  c.startResize("se"); cursor = { x: 680, y: 650 }; c.moveResize();
  c.setAlwaysOnTop(false); // An unrelated preference save must not commit an unfinished gesture.
  assert.equal(JSON.parse(fs.readFileSync(c.statePath)).panelSize, null);
  c.endResize(true);
  assert.equal(c.panelSize, null); assert.deepEqual(c.layout.bounds, initial);
  c.startResize("e"); c.endResize(); assert.equal(c.panelSize, null, "click without drag leaves the default adaptive size");
  c.startResize("e"); cursor.x += 90; c.moveResize(); c.win.emit("blur");
  assert.equal(c.resize, null); assert.deepEqual(JSON.parse(fs.readFileSync(c.statePath)).panelSize, c.panelSize);
  const width = c.panelSize.width;
  c.startResize("e"); cursor.x += 40; c.moveResize(); await c.setEnabled(false);
  assert.equal(c.resize, null); assert.equal(c.panelSize.width, width + 40);
  c.resetPanelSize(); assert.equal(c.panelSize, null); assert.equal(JSON.parse(fs.readFileSync(c.statePath)).panelSize, null);
});

test("resize IPC uses exact window ownership, valid directions and native cursor coordinates", async t => {
  const { c } = fixture(t); c.hidden = true; c.anchor = { x: 240, y: 160 };
  c.chat.load = async () => c.chat.snapshot(c.agent); c.chat.refreshAsks = async () => {};
  await c.start();
  const sender = c.win.webContents, frame = { url: c.expectedUrl }; sender.mainFrame = frame; sender.getURL = () => c.expectedUrl;
  const event = { sender, senderFrame: frame };
  await assert.rejects(c.action(event, { action: "resize-start", edge: "se" }), /展开/);
  await c.expand(true, true);
  for (const action of ["resize-start", "resize-move", "resize-end", "resize-cancel", "resize-step"])
    await assert.rejects(c.action({ sender, senderFrame: { ...frame } }, { action, edge: "se" }), /专属窗口/);
  await assert.rejects(c.action(event, { action: "resize-start", edge: "other" }), /边界/);
  await assert.rejects(c.action(event, { action: "resize-step", edge: "se", dx: 9999, dy: 0 }), /步长/);
  const width = c.layout.panel.width;
  await c.action(event, { action: "resize-start", edge: "e" });
  await c.action(event, { action: "resize-move", width: 9000, x: 5000, dx: 3000 });
  await c.action(event, { action: "resize-end" }); assert.equal(c.panelSize, null);
  await c.action(event, { action: "resize-step", edge: "se", dx: 10, dy: 0 });
  assert.equal(c.layout.panel.width, width + 10);
});

test("music IPC is exact-window, visible-only, separate from chat and duplicate guarded", async t => {
  const { c } = fixture(t); c.hidden = true;
  c.chat.load = async () => c.chat.snapshot(c.agent);
  const calls = [], pushed = []; let reads = 0, complete;
  c.music = { getState: () => { reads++; return { provider: "folia", running: true, loaded: true, currentTrackId: "x", tracks: [{ id: "x", title: "x" }], providerCapabilities: ["pause"] }; },
    execute: cmd => { calls.push(cmd); return new Promise(resolve => { complete = resolve; }); }, openFolia: async () => calls.push("folia") };
  await c.setEnabled(true);
  const sender = c.win.webContents, frame = { url: c.expectedUrl }; sender.mainFrame = frame; sender.getURL = () => c.expectedUrl;
  const event = { sender, senderFrame: frame }; sender.send = (...args) => pushed.push(args);
  c.publishMusic(); assert.equal(reads, 0); assert.deepEqual(calls, []);
  await c.expand(true, true); pushed.length = 0;
  await c.action(event, { action: "music-watch", value: true }); assert.equal(reads, 1);
  c.publishMusic(); assert.deepEqual(pushed.map(p => p[0]), ["orb:music"]);
  for (const action of ["music-watch", "music-command", "open-folia"]) await assert.rejects(c.action({ sender, senderFrame: { ...frame } }, { action }), /专属窗口/);
  const pending = c.action(event, { action: "music-command", command: { action: "pause", provider: "folia", player: "qqmusic" } });
  await assert.rejects(c.action(event, { action: "open-folia" }), /上一项/); assert.deepEqual(calls, [{ action: "pause" }]);
  complete(); await pending; assert.equal(c.musicBusy, false);
  c.music.execute = async () => { throw new Error("播放器失败，不重试"); };
  await assert.rejects(c.action(event, { action: "music-command", command: { action: "pause", provider: "folia" } }), /播放器失败/); assert.equal(c.musicBusy, false);
  await c.action(event, { action: "open-folia" }); assert.equal(calls.at(-1), "folia");
  await c.action(event, { action: "music-watch", value: false }); reads = 0; pushed.length = 0;
  c.publishMusic(); assert.equal(reads, 0); assert.equal(pushed.length, 0);
  await c.action(event, { action: "music-watch", value: true }); await c.expand(false); reads = 0; c.publishMusic(); assert.equal(reads, 0);
  assert.equal(c.chat.row(c.agent).runId, null);
});

test("optional lyrics survive collapse/relaunch but stop all music traffic when disabled or hidden", async t => {
  const { c, options } = fixture(t); c.hidden = true;
  c.chat.load = async () => c.chat.snapshot(c.agent); c.chat.refreshAsks = async () => {};
  let reads = 0;
  c.music = { getState: () => { reads++; return { provider: "folia", running: true, loaded: true, currentTrackId: "x",
    tracks: [{ id: "x", title: "Now playing" }, { id: "y", title: "Not sent while collapsed" }] }; } };
  await c.start(); const pushed = []; c.win.webContents.send = (...args) => pushed.push(args);
  c.setLyricOverlay(true); assert.ok(c.layout.lyric); assert.equal(c.expanded, false);
  assert.equal(JSON.parse(fs.readFileSync(c.statePath)).lyricOverlay, true);
  pushed.length = 0; c.publishMusic();
  assert.deepEqual(pushed.map(p => p[0]), ["orb:music"]); assert.equal(pushed[0][1].tracks.length, 1);
  await c.expand(true, true);
  const before = c.layout.panel.width;
  c.startResize("e"); c.moveResize({ x: -20, y: 0 }); c.endResize();
  assert.equal(c.layout.panel.width, before - 20); assert.ok(c.layout.lyric);
  const size = { ...c.panelSize };
  await c.expand(false); assert.ok(c.layout.lyric);
  await c.setEnabled(false); reads = 0; pushed.length = 0; c.publishMusic();
  assert.equal(reads, 0); assert.equal(pushed.length, 0); assert.equal(c.layout.lyric, null);
  const next = new OrbController({ ...options, music: c.music, hidden: true }); t.after(() => next.dispose());
  await next.start(); assert.equal(next.lyricOverlay, true); assert.ok(next.layout.lyric);
  assert.deepEqual(next.panelSize, size, "lyric geometry does not overwrite resized chat preferences");
  next.setLyricOverlay(false); assert.equal(next.layout.lyric, null); reads = 0; next.publishMusic(); assert.equal(reads, 0);
});

test("status navigation uses only the trusted exact task and leaves the orb chat untouched", async t => {
  const { c } = fixture(t); c.hidden = true;
  await c.setEnabled(true);
  const sender = c.win.webContents, frame = { url: c.expectedUrl };
  sender.mainFrame = frame; sender.getURL = () => c.expectedUrl;
  const event = { sender, senderFrame: frame }, opened = [];
  c.openConversation = async target => opened.push(target);
  c.openMusic = async () => opened.push("music");
  const chat = c.chat.row(c.agent); chat.sessionId = "original-orb";
  c.consume({ __harbour: "channel-activity", agent: c.agent, runId: "other-run", phase: "complete", sessionId: "qq-session", sessionKey: "qq:owner", replyRevision: 1, readReplyRevision: 0 });
  await assert.rejects(c.action(event, { action: "open-task", runId: "stale-run" }), /状态已更新/);
  await assert.rejects(c.action({ sender, senderFrame: { ...frame } }, { action: "open-task", runId: "other-run" }), /专属窗口/);
  await c.action(event, { action: "open-task", runId: "other-run", sessionId: "malicious-override", url: "https://invalid" });
  assert.deepEqual(opened, [{ sessionId: "qq-session", agentName: c.agent }]);
  assert.equal(chat.sessionId, "original-orb"); assert.equal(chat.runId, null); assert.deepEqual(chat.asks, []);
  assert.equal(c.snapshot().signals.task.runId, "other-run", "opening is not evidence the reply was viewed");
  c.consume({ __harbour: "session-read", id: "qq-session", replyRevision: 1, readReplyRevision: 1 });
  assert.equal(c.snapshot().signals.task, null);
  await c.action(event, { action: "open-music" }); assert.equal(opened.at(-1), "music");
  const signals = c.signals; c.dispose(); assert.equal(signals.listenerCount("change"), 0);
});

test("cross-channel signals never fetch history; already-read own replies do not relight", async t => {
  const { c } = fixture(t); c.hidden = true; let calls = 0;
  c.chat.request = async () => { calls++; throw new Error("unexpected request"); };
  const activity = { __harbour: "channel-activity", agent: c.agent, runId: "outside", phase: "running", sessionId: "outside-session", sessionKey: "qq:owner" };
  c.consume(activity); c.consume({ ...activity, phase: "complete" });
  assert.equal(calls, 0); assert.equal(c.snapshot().signals.notification, "reply");
  await c.setEnabled(true); c.expanded = true;
  const row = c.chat.row(c.agent); row.sessionId = "own-session"; row.phase = "complete";
  row.messages = [{ role: "assistant", content: "done" }];
  c.consume({ ...activity, runId: "own-run", sessionId: row.sessionId, phase: "complete" });
  c.chat.changed(row);
  assert.equal(c.signals.tasks.has("own-run"), true, "loading into an expanded panel is not a receipt");
  const view = c.chat.snapshot(c.agent);
  await c.read({ agent: c.agent, sessionId: row.sessionId, historyRevision: view.historyRevision, replyRevision: view.replyRevision, noticeKey: view.noticeKey });
  assert.equal(c.signals.tasks.has("own-run"), false);
  assert.equal(c.signals.tasks.has("outside"), true, "own panel doesn't acknowledge a QQ reply");
  assert.equal(calls, 0);
});

test("tray/settings show recovers a hidden, minimized, docked, click-through window", async t => {
  const { c, windows } = fixture(t);
  await c.setEnabled(true);
  const win = c.win;
  c.dock = "right"; c.reflow(); assert.equal(win.bounds.width, 68);
  await c.setEnabled(false);
  win.minimized = true; win.ignored = c.ignoring = true;
  await c.setEnabled(true);
  assert.equal(c.win, win); assert.equal(windows.length, 1);
  assert.equal(win.visible, true); assert.equal(win.minimized, false);
  assert.equal(c.dock, null); assert.ok(win.bounds.width > 68);
  assert.equal(win.ignored, false); assert.equal(c.ignoring, false);
  assert.ok(win.raises >= 2);
  for (let i = 0; i < 4; i++) { await c.setEnabled(false); await c.setEnabled(true); }
  assert.equal(windows.length, 1); assert.equal(win.visible, true);
});

test("ball toggles use current native state, close pinned/hover panels, and never stop the chat", async t => {
  const { c } = fixture(t); c.hidden = true;
  c.chat.load = async agent => c.chat.snapshot(agent);
  await c.setEnabled(true);
  const frame = { url: c.expectedUrl }, sender = c.win.webContents;
  sender.mainFrame = frame; sender.getURL = () => c.expectedUrl;
  const event = { sender, senderFrame: frame }, row = c.chat.row(c.agent);
  row.runId = "fixture-active-run"; row.messages = [{ role: "user", content: "keep my conversation" }];
  const first = await c.action(event, { action: "toggle" });
  assert.equal(first.expanded, true); assert.equal(first.pinned, true);
  const second = await c.action(event, { action: "toggle" });
  assert.equal(second.expanded, false); assert.equal(second.pinned, false);
  assert.equal(c.enabled, true, "collapse keeps the ball available");
  await c.expand(true, false);
  assert.equal((await c.action(event, { action: "toggle" })).expanded, false, "hover preview closes too");
  const rapid = await Promise.all(Array.from({ length: 4 }, () => c.action(event, { action: "toggle" })));
  assert.deepEqual(rapid.map(s => s.expanded), [true, false, true, false]);
  assert.equal(row.runId, "fixture-active-run"); assert.equal(row.messages[0].content, "keep my conversation");
  await assert.rejects(c.action({ sender, senderFrame: { ...frame } }, { action: "toggle" }), /专属窗口/);
  await c.setEnabled(false);
  assert.equal((await c.action(event, { action: "toggle" })).expanded, false, "late click cannot reopen a hidden assistant");
});

test("orb starts with Harbour by default, including old hidden preferences", async t => {
  const { c, options } = fixture(t);
  assert.equal(c.autoStart, true); assert.equal(c.enabled, false);
  await c.start(); assert.equal(c.win.visible, true);
  await c.setEnabled(false);
  const next = new OrbController(options);
  t.after(() => next.dispose());
  assert.equal(next.enabled, false); assert.equal(next.autoStart, true);
  await next.start(); assert.equal(next.win.visible, true, "temporary hide does not disable next launch");
  fs.writeFileSync(c.statePath, JSON.stringify({ version: 1, enabled: false, alwaysOnTop: false }));
  const legacy = new OrbController(options);
  t.after(() => legacy.dispose());
  await legacy.start(); assert.equal(legacy.win.visible, true); assert.equal(legacy.alwaysOnTop, false);
});

test("startup opt-out persists independently of visibility and can be reversed", async t => {
  const { c, options } = fixture(t);
  await c.start(); c.setAutoStart(false);
  assert.equal(c.enabled, true, "startup preference does not hide the current window");
  assert.throws(() => c.setAutoStart("true"), /布尔/);
  const next = new OrbController(options);
  t.after(() => next.dispose());
  await next.start(); assert.equal(next.win, null); assert.equal(next.autoStart, false);
  await next.setEnabled(true); assert.equal(next.autoStart, false, "manual show does not override explicit startup preference");
  next.setAutoStart(true);
  const last = new OrbController(options);
  t.after(() => last.dispose());
  await last.start(); assert.equal(last.win.visible, true);
});

test("edge preference survives startup; explicit tray recovery reveals the full ball", async t => {
  const { c, options } = fixture(t);
  await c.start(); c.dock = "bottom"; c.reflow(); c.save();
  const next = new OrbController(options); t.after(() => next.dispose());
  await next.start();
  assert.equal(next.dock, "bottom"); assert.equal(next.layout.bounds.height, 86);
  assert.equal(next.expanded, false); assert.equal(next.pinned, false);
  await next.setEnabled(true); assert.equal(next.dock, null); assert.equal(next.layout.bounds.height, 88);
});

test("native hover, delayed retraction, pin and context-menu retain the original task", async t => {
  const { c } = fixture(t); c.hidden = true;
  let loads = 0, cursor = { x: -1000, y: -1000 };
  c.screen.getCursorScreenPoint = () => cursor;
  c.chat.load = async () => { loads++; }; c.chat.refreshAsks = async () => {};
  await c.start(); c.dock = "right"; c.reflow(); c.save();
  const row = c.chat.row(c.agent); row.runId = "preserved-run";
  c.samplePointer(0); c.samplePointer(200);
  cursor = { x: 995, y: c.anchor.y }; c.samplePointer(300); c.samplePointer(600);
  assert.equal(c.expanded, true); assert.equal(c.pinned, false); assert.equal(loads, 1);
  c.samplePointer(900); c.samplePointer(2000); assert.equal(c.expanded, true, "old tab position stays inside preview");
  cursor = { x: -1000, y: -1000 }; c.menuOpen = true; c.samplePointer(3000); c.samplePointer(4000);
  assert.equal(c.expanded, true);
  c.menuOpen = false; c.samplePointer(5000); c.samplePointer(5700);
  assert.equal(c.expanded, false); assert.equal(c.retracting, true); assert.equal(c.layout.expanded, true);
  await new Promise(resolve => setTimeout(resolve, 210));
  assert.equal(c.retracting, false); assert.equal(c.layout.dock, "right");
  await c.expand(true, true); c.samplePointer(6000); c.samplePointer(9000);
  assert.equal(c.expanded, true); assert.equal(row.runId, "preserved-run");
  assert.equal(JSON.parse(fs.readFileSync(c.statePath, "utf8")).dock, "right");
});

test("reopen, drag, display changes, hiding and dispose cancel pending retraction", async t => {
  const { c } = fixture(t); c.hidden = true;
  c.chat.load = async () => {}; c.chat.refreshAsks = async () => {};
  await c.start();
  for (const action of [() => c.expand(true, true), () => c.startDrag(), () => c.screen.emit("display-metrics-changed"),
    () => c.setEnabled(false)]) {
    c.dock = "top"; await c.expand(true, false); await c.expand(false, false);
    assert.equal(c.retracting, true);
    await action(); assert.equal(c.retracting, false); assert.equal(c.retractTimer, null);
    c.drag = null;
  }
  await c.setEnabled(true); c.dock = "left"; await c.expand(true, false); await c.expand(false, false);
  c.dispose(); assert.equal(c.retractTimer, null);
  await new Promise(resolve => setTimeout(resolve, 210));
  assert.equal(c.win, null);
});

test("return during auto-retract reverses the fade; explicit close cannot bounce open", async t => {
  const { c } = fixture(t); c.hidden = true;
  let cursor = { x: 5, y: 400 };
  c.screen.getCursorScreenPoint = () => cursor;
  c.chat.load = async () => {}; c.chat.refreshAsks = async () => {};
  await c.start(); c.dock = "left"; c.anchor.y = 400; await c.expand(true, false);
  cursor = { x: -1000, y: -1000 }; c.samplePointer(0); c.samplePointer(710);
  assert.equal(c.retracting, true);
  cursor = { x: 5, y: 400 }; c.samplePointer(730);
  assert.equal(c.retracting, false); assert.equal(c.expanded, true); assert.equal(c.pinned, false);
  await c.expand(false, false); c.samplePointer(800);
  assert.equal(c.expanded, false); assert.equal(c.retracting, true);
  await new Promise(resolve => setTimeout(resolve, 210));
  c.samplePointer(2000); assert.equal(c.expanded, false);
});

test("display removal reclamps and preserves a dock, explicit undock moves it into the work area", async t => {
  const { c } = fixture(t);
  await c.start(); c.dock = "right"; c.anchor = { x: 995, y: 650 }; c.reflow();
  c.screen.getDisplayNearestPoint = () => ({ workArea: { x: -360, y: -100, width: 360, height: 460 } });
  c.screen.emit("display-removed");
  assert.equal(c.dock, "right"); assert.equal(c.layout.bounds.x + c.layout.bounds.width, 0);
  assert.ok(c.layout.bounds.y + c.layout.bounds.height <= 360);
  const docked = { ...c.anchor }; c.undock();
  assert.equal(c.dock, null); assert.equal(c.anchor.x, docked.x - 72);
  assert.equal(JSON.parse(fs.readFileSync(c.statePath, "utf8")).dock, null);
});

test("failed startup preference save keeps the last confirmed value", t => {
  const { c } = fixture(t);
  const failure = new Error("fixture disk unavailable");
  c.save = () => { throw failure; };
  assert.throws(() => c.setAutoStart(false), error => error === failure);
  assert.equal(c.autoStart, true);
  assert.equal(c.snapshot().autoStart, true);
});

test("startup preference IPC requires a trusted main frame and a boolean", () => {
  const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8"), handlers = new Map(), changes = [];
  const controller = { enabled: false, autoStart: true, setAutoStart(value) { changes.push(value); return { autoStart: value }; } };
  vm.runInNewContext(source.slice(source.indexOf('ipcMain.handle("desktop:orb-status"'), source.indexOf('ipcMain.on("desktop:startup-context"')), {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, orbController: () => controller,
    trustedDesktopSender: event => event.trusted,
  });
  const mainFrame = {}, event = { trusted: true, sender: { mainFrame }, senderFrame: mainFrame };
  const status = handlers.get("desktop:orb-status"), set = handlers.get("desktop:orb-autostart");
  assert.equal(status(event).autoStart, true); assert.equal(status(event).enabled, false);
  for (const value of [undefined, "false", 0, {}]) assert.throws(() => set(event, value), /invalid desktop window/);
  for (const untrusted of [{ ...event, trusted: false }, { ...event, senderFrame: {} }]) {
    assert.throws(() => set(untrusted, false), /invalid desktop window/);
    assert.throws(() => status(untrusted), /invalid desktop window/);
  }
  assert.deepEqual(changes, []);
  assert.equal(set(event, false).autoStart, false); assert.deepEqual(changes, [false]);
});

test("progress IPC is history-free; expand, new replies and renderer reload hydrate exact history", async t => {
  const { c } = fixture(t); c.hidden = true;
  c.chat.load = async () => c.chat.snapshot(c.agent); c.chat.refreshAsks = async () => {};
  await c.start();
  const row = c.chat.row(c.agent); row.sessionId = "long-session"; row.runId = "running-task";
  row.messages = Array.from({ length: 120 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `${i}:` + "fixture ".repeat(512) }));
  const sent = [];
  c.win.webContents.send = (channel, value) => { if (channel === "orb:state") sent.push(value); };
  c.chat.changed(row);
  assert.equal(sent.at(-1).chat.messages, undefined, "collapsed ball does not transfer history");
  await c.expand(true, true);
  assert.equal(sent.at(-1).chat.messages.length, 120);
  const fullBytes = Buffer.byteLength(JSON.stringify(sent.at(-1)));
  sent.length = 0;
  for (let i = 0; i < 60; i++) { row.detail = `tool ${i}`; c.chat.changed(row); }
  assert.equal(sent.length, 60, "progress is still delivered");
  assert.ok(sent.every(value => value.chat.messages === undefined && value.chat.summary === undefined));
  const progressBytes = sent.reduce((total, value) => total + Buffer.byteLength(JSON.stringify(value)), 0);
  assert.ok(progressBytes < fullBytes * 60 * .02, "long-chat IPC is reduced by at least 98% in this fixture");
  t.diagnostic(JSON.stringify({ messages: 120, updates: 60, legacyBytes: fullBytes * 60, progressBytes }));
  row.messages.push({ role: "assistant", content: "final reply" }); c.chat.changed(row);
  assert.equal(sent.at(-1).chat.messages.length, 121, "final answer is delivered in full");
  c.win.webContents.emit("did-stop-loading");
  assert.equal(sent.at(-1).chat.messages.length, 121, "reloaded renderer cannot inherit old transport cache");
  await c.setEnabled(false); sent.length = 0;
  row.detail = "still working"; c.chat.changed(row);
  assert.equal(sent.length, 0, "hidden windows receive no redundant state IPC");
  assert.equal(row.runId, "running-task", "hiding never stops execution");
  await c.setEnabled(true); await c.expand(true, true);
  assert.equal(sent.at(-1).chat.messages.at(-1).content, "final reply");
});

test("settings saves startup independently of visibility and restores the checkbox on failure", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../renderer/companion-settings.js"), "utf8"), elements = new Map(), changes = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { dataset: {}, checked: true, disabled: true, hidden: true,
      events: {}, addEventListener(type, handler) { this.events[type] = handler; } });
    return elements.get(id);
  };
  let statusReads = 0, fail = false;
  vm.runInNewContext(source, {
    document: { getElementById: element, querySelectorAll: () => [] },
    window: { harbourDesktop: {
      orbStatus: async () => { statusReads++; return { enabled: false, autoStart: true }; },
      setOrbAutoStart: async value => { if (fail) throw new Error("fixture save failure"); changes.push(value); return { autoStart: value }; },
      setOrbEnabled: async () => assert.fail("auto-start must not toggle current visibility"),
      getCompanionState: async () => ({ appearance: {} }), getCompanionCharacter: async () => ({}),
    } },
  });
  await new Promise(resolve => setImmediate(resolve));
  const checkbox = element("orbAutoStart"), notice = element("orbNotice");
  assert.equal(checkbox.checked, true); assert.equal(checkbox.disabled, false);
  assert.equal(element("orbToggle").dataset.enabled, "false");
  checkbox.checked = false; await checkbox.events.change();
  assert.equal(checkbox.checked, false); assert.deepEqual(changes, [false]);
  assert.equal(statusReads, 1, "a confirmed save does not depend on a second status request");
  fail = true; checkbox.checked = true; await checkbox.events.change();
  assert.equal(checkbox.checked, false); assert.equal(checkbox.disabled, false);
  assert.equal(notice.hidden, false); assert.match(notice.textContent, /未保存/);
  assert.equal(element("orbToggle").dataset.enabled, "false");
});

test("always-on-top is independent of pin, persists, and survives window recreation", async t => {
  const { c, options } = fixture(t);
  await c.setEnabled(true); c.pinned = true;
  c.setAlwaysOnTop(false);
  assert.equal(c.win.top, false); assert.equal(c.pinned, true);
  assert.equal(c.snapshot().alwaysOnTop, false);
  assert.throws(() => c.setAlwaysOnTop("true"), /布尔/);
  await c.setEnabled(false); await c.setEnabled(true);
  assert.equal(c.win.top, false);
  c.win.destroy(); await c.setEnabled(true);
  assert.equal(c.win.options.alwaysOnTop, false);
  const restored = new OrbController(options);
  assert.equal(restored.alwaysOnTop, false); restored.dispose();
  c.setAlwaysOnTop(true); assert.equal(c.win.top, true);
});

test("failed or interrupted window load is discarded and a later show retries only the view", async t => {
  const { c, load, windows, visibility } = fixture(t);
  load(() => { throw new Error("load fixture failed"); });
  await assert.rejects(c.setEnabled(true), /load fixture failed/);
  assert.equal(c.enabled, false); assert.equal(c.win, null); assert.equal(c.loading, null);
  assert.equal(windows[0].destroyed, true); assert.equal(visibility.at(-1), false);
  load(async () => {}); await c.setEnabled(true);
  assert.equal(windows.length, 2); assert.equal(c.win.visible, true);
});

test("latest show/hide intention wins while first page is loading", async t => {
  const { c, load, windows } = fixture(t);
  let release;
  load(() => new Promise(resolve => { release = resolve; }));
  const first = c.setEnabled(true);
  await Promise.resolve(); await c.setEnabled(false);
  release(); await first;
  assert.equal(c.enabled, false); assert.equal(c.win.shows, undefined);
  await c.setEnabled(true); assert.equal(windows.length, 1); assert.equal(c.win.shows, 1);
});

test("show-hide-show during load creates one view and shows it exactly once", async t => {
  const { c, load, windows } = fixture(t);
  let release;
  load(() => new Promise(resolve => { release = resolve; }));
  const first = c.setEnabled(true); await Promise.resolve();
  await c.setEnabled(false); const last = c.setEnabled(true);
  release(); await Promise.all([first, last]);
  assert.equal(windows.length, 1); assert.equal(c.win.shows, 1); assert.equal(c.enabled, true);
});

test("renderer crash can reopen without replacing the original Main session or run", async t => {
  const { c, windows } = fixture(t);
  await c.setEnabled(true); const old = c.win;
  const row = c.chat.row("main-elaina"); row.sessionId = "same-session"; row.runId = "same-run";
  old.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(c.enabled, false); assert.equal(old.visible, false);
  await c.setEnabled(true);
  assert.equal(windows.length, 2); assert.equal(old.destroyed, true);
  assert.equal(c.chat.row("main-elaina"), row); assert.equal(row.runId, "same-run");
  assert.equal(row.sessionId, "same-session"); assert.equal(c.win.visible, true);
  old.emit("closed"); assert.equal(c.win, windows[1], "late old-window event cannot clear the new view");
});

test("tray commands explicitly show/hide; show never toggles an already enabled orb off", async () => {
  const calls = [], src = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const controller = { enabled: true, alwaysOnTop: true, setEnabled: async value => calls.push(value), setAlwaysOnTop: value => calls.push(value) };
  const tray = { isDestroyed: () => false, setToolTip() {}, setContextMenu(menu) { this.menu = menu; } };
  const code = src.slice(src.indexOf("function createTray()"), src.indexOf("\nfunction runDesktopAction"));
  vm.runInNewContext(code + "; createTray();", { tray, orb: controller, orbController: () => controller,
    cfg: { pets: [] }, Menu: { buildFromTemplate: value => value }, petAlwaysOnTop: () => true,
    visualPolicy: { mode: "auto", setMode() {} },
    closeAllPetWindows() {}, runDesktopAction: (_label, fn) => fn(), serviceActionState: "idle" });
  await tray.menu.find(item => item.label === "显示悬浮助手").click();
  await tray.menu.find(item => item.label === "隐藏悬浮助手（任务继续）").click();
  await tray.menu.find(item => item.label === "显示悬浮助手").click();
  assert.deepEqual(calls, [true, false, true]);
  assert.equal(tray.menu.find(item => item.label === "悬浮助手置顶").checked, true);
});

test("quiet orb retains exact conversation and latest music, then replays without task actions", async t => {
  const { c } = fixture(t); c.hidden = true;
  c.chat.load = async () => c.chat.snapshot(c.agent); c.chat.refreshAsks = async () => {};
  await c.start(); await c.expand(true, true); c.win.visible = true;
  const row = c.chat.row(c.agent); row.sessionId = 'kept-session'; row.runId = 'kept-run';
  const pushes = []; c.win.webContents.send = (topic, state) => pushes.push({ topic, state });
  c.syncHitTesting(); assert.ok(c.hitTimer);
  c.setVisualQuiet(true); assert.equal(c.hitTimer, null);
  for (let i = 0; i < 20; i++) { c.publish(); c.publishMusic(); }
  assert.equal(pushes.length, 0);
  assert.equal(row.sessionId, 'kept-session'); assert.equal(row.runId, 'kept-run');
  c.setVisualQuiet(false); assert.ok(c.hitTimer);
  assert.equal(pushes.filter(entry => entry.topic === 'orb:state').length, 1);
  assert.equal(pushes[0].state.chat.runId, 'kept-run');
});

test("expressions use existing structured state; uncertainty/cancellation are not success", () => {
  const state = { connection: "open", chat: { phase: "idle" } };
  assert.equal(expression(state).mood, "idle");
  for (const chat of [{ preparing: true }, { loading: true }, { runId: "r" }, { phase: "stopping", runId: "r" }]) {
    assert.equal(expression({ ...state, chat }).mood, "thinking");
  }
  assert.equal(expression({ ...state, chat: { runId: "r", asks: [{}] } }).mood, "waiting");
  assert.equal(expression({ ...state, chat: { phase: "complete", replyReadyAt: Date.now() } }).label, "回复已就绪");
  assert.equal(expression({ ...state, chat: { phase: "uncertain", runId: "r" } }).mood, "idle");
  assert.equal(expression({ ...state, chat: { phase: "cancelled" } }).mood, "idle");
  assert.equal(expression({ ...state, connection: "closed" }).mood, "idle");
});

test("reply expression expires after eight seconds without clearing waiting, unread or unknown outcomes", () => {
  const state = { connection: "open", unread: true, chat: { phase: "complete", replyReadyAt: 1000 } };
  assert.equal(expression(state, 1000).mood, "complete");
  assert.equal(expression(state, 8999).resetAt, 9000);
  assert.equal(expression(state, 9000).mood, "idle");
  assert.equal(expression(state, 9000).resetAt, 0);
  assert.equal(state.unread, true); assert.equal(state.chat.phase, "complete", "visual reset does not rewrite task result");
  assert.equal(expression({ ...state, chat: { phase: "complete" } }, 9000).mood, "idle", "unknown age cannot replay a celebration");
  for (const [phase, mood] of [["waiting", "waiting"], ["uncertain", "idle"], ["cancelled", "idle"]]) {
    assert.equal(expression({ ...state, chat: { ...state.chat, phase } }, 10000).mood, mood);
  }
  assert.equal(expression({ ...state, chat: { ...state.chat, runId: "next-task" } }, 3000).mood, "thinking");
  assert.equal(expression({ ...state, connection: "closed" }, 10000).mood, "idle");
  assert.equal(expression(state, 10000).mood, "idle", "reconnect/reopen does not restart the eight-second interval");
});

test("both portrait atlases have aligned 3x2 tiles and are included in desktop packaging", () => {
  const assets = path.resolve(__dirname, "../../web/assets/orb");
  const manifest = JSON.parse(fs.readFileSync(path.join(assets, "expressions-v1.json"), "utf8"));
  assert.equal(manifest.assets.length, 2); assert.equal(manifest.layout.tileOrder.length, 6);
  for (const asset of manifest.assets) {
    const bytes = fs.readFileSync(path.join(assets, asset.file));
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    assert.equal(bytes.readUInt32BE(16) / 3, bytes.readUInt32BE(20) / 2);
    assert.ok(fs.existsSync(path.resolve(assets, asset.reference)));
    assert.ok(asset.prompt.includes("3 columns by 2 rows"));
  }
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  const filters = config.build.extraResources.flatMap(row => row.filter || []);
  assert.ok(filters.includes("assets/orb/*-expressions-v1.png"));
  assert.ok(filters.includes("assets/aemeath-avatar.jpg"));
  assert.ok(filters.includes("assets/orb/*-thinking-v2.png"));
  const thinking = JSON.parse(fs.readFileSync(path.join(assets, "thinking-v2.json"), "utf8"));
  assert.equal(thinking.assets.length, 2);
  for (const asset of thinking.assets) {
    const bytes = fs.readFileSync(path.join(assets, asset.file));
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    assert.equal(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    assert.ok(fs.existsSync(path.resolve(assets, asset.reference)));
    assert.match(asset.prompt, /thoughtful expression/);
  }
});

test("both peeking atlases have four alpha poses, packaged with fixed local paths", () => {
  const assets = path.resolve(__dirname, "../../web/assets/orb");
  const manifest = JSON.parse(fs.readFileSync(path.join(assets, "peek-v1.json"), "utf8"));
  assert.deepEqual(manifest.layout.cells, ["left", "right", "top", "bottom"]);
  assert.equal(manifest.assets.length, 2);
  for (const asset of manifest.assets) {
    const bytes = fs.readFileSync(path.join(assets, asset.file));
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    assert.equal(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    assert.equal(bytes.readUInt32BE(16) % 2, 0, "exact 2x2 registration");
    assert.equal(bytes[25], 6, "RGBA, not a painted opaque backdrop");
    assert.ok(fs.existsSync(path.resolve(assets, asset.reference)));
    assert.match(asset.prompt, /HANGS DOWN/);
    assert.match(asset.prompt, /NOT a simple 180-degree rotated/);
  }
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  assert.ok(config.build.extraResources.some(row => row.filter?.includes("assets/orb/*-peek-v1.png")));
  const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  assert.match(main, /getPeekAtlas: agent =>/);
  assert.match(main, /"main-elaina": "elaina-peek-v3.png", "main-aemeath": "aemeath-peek-v5.png"/);
});

test("living v3 keeps both Main portraits registered and pairs the corrected Elaina peek frames", () => {
  const assets = path.resolve(__dirname, "../../web/assets/orb");
  const manifest = JSON.parse(fs.readFileSync(path.join(assets, "motion-v3.json"), "utf8"));
  assert.equal(manifest.assets.length, 4);
  assert.deepEqual(manifest.layout.portrait.cells, ["idle", "thinking", "waiting", "complete", "failed", "blink"]);
  for (const asset of manifest.assets) {
    assert.ok(fs.existsSync(path.join(assets, asset.reference)));
    assert.match(asset.prompt, /EDIT TARGET/);
  }
  for (const row of manifest.runtime) {
    const portrait = fs.readFileSync(path.join(assets, row.portrait));
    assert.equal(portrait.readUInt32BE(16) / 3, portrait.readUInt32BE(20) / 2);
    const open = fs.readFileSync(path.join(assets, row.open)), closed = fs.readFileSync(path.join(assets, row.closed));
    assert.equal(open[25], 6); assert.equal(closed[25], 6);
    assert.equal(open.readUInt32BE(16), closed.readUInt32BE(16));
    assert.equal(open.readUInt32BE(20), closed.readUInt32BE(20));
  }
  const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  assert.doesNotMatch(main, /getThinkingPortrait/);
  assert.match(main, /"main-elaina": "elaina-expressions-v2.png", "main-aemeath": "aemeath-expressions-v4.png"/);
  assert.equal(expression({ connection: "open", chat: { runId: "working" } }).position, "50% 0%");
  const filters = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8")).build.extraResources.flatMap(row => row.filter || []);
  for (const glob of ["assets/orb/*-expressions-v2.png", "assets/orb/*-peek-v3.png", "assets/orb/*-peek-blink-v3.png"]) assert.ok(filters.includes(glob));
});

test("peeking motion has registered open/closed local frames for each Main", () => {
  const assets = path.resolve(__dirname, "../../web/assets/orb");
  const manifest = JSON.parse(fs.readFileSync(path.join(assets, "peek-v2.json"), "utf8"));
  assert.deepEqual(manifest.layout.cells, ["left", "right", "top", "bottom"]);
  assert.equal(manifest.assets.length, 3);
  for (const asset of manifest.assets) {
    const bytes = fs.readFileSync(path.join(assets, asset.file));
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    assert.equal(bytes[25], 6, "real alpha sprites");
    assert.equal(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    assert.equal(bytes.readUInt32BE(16) % 2, 0);
    assert.ok(fs.existsSync(path.resolve(assets, asset.reference)));
    assert.match(asset.prompt, /EDIT TARGET/);
  }
  assert.deepEqual(manifest.runtime.map(row => row.agent), ["main-elaina", "main-aemeath"]);
  for (const row of manifest.runtime) {
    const open = fs.readFileSync(path.join(assets, row.open)), closed = fs.readFileSync(path.join(assets, row.closed));
    assert.equal(open.readUInt32BE(16), closed.readUInt32BE(16), "blink registration matches resting frame");
    assert.equal(open.readUInt32BE(20), closed.readUInt32BE(20));
  }
  assert.match(manifest.assets[0].prompt, /NO HANDS, NO FINGERS, NO ARMS/);
  const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  assert.match(main, /getPeekBlinkAtlas: agent =>/);
  assert.match(main, /"main-elaina": "elaina-peek-blink-v3.png", "main-aemeath": "aemeath-peek-blink-v5.png"/);
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  const filters = config.build.extraResources.flatMap(row => row.filter || []);
  assert.ok(filters.includes("assets/orb/*-peek-v2.png"));
  assert.ok(filters.includes("assets/orb/*-peek-blink-v2.png"));
});

test("Aemeath v4 preserves the supplied reference and ships a complete registered artwork family", () => {
  const assets = path.resolve(__dirname, "../../web/assets/orb");
  const manifest = JSON.parse(fs.readFileSync(path.join(assets, "aemeath-v4.json"), "utf8"));
  const hash = require("node:crypto").createHash("sha256")
    .update(fs.readFileSync(path.join(assets, manifest.reference.file))).digest("hex");
  assert.equal(hash, manifest.reference.sha256, "the user's source artwork is preserved unchanged");
  assert.deepEqual(manifest.layout.portrait.cells, ["idle", "thinking", "waiting", "complete", "failed", "blink"]);
  assert.deepEqual(manifest.layout.peek.cells, ["left", "right", "top", "bottom"]);
  assert.equal(manifest.assets.length, 4);
  const filters = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"))
    .build.extraResources.flatMap(row => row.filter || []);
  for (const asset of manifest.assets) {
    const bytes = fs.readFileSync(path.join(assets, asset.file));
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    assert.ok(filters.includes(`assets/orb/${asset.file}`), `packaged ${asset.file}`);
    assert.ok(asset.prompt.length > 200, "the actual generation prompt is recorded");
    for (const reference of asset.references) assert.ok(fs.existsSync(path.join(assets, reference)));
  }
  const png = field => fs.readFileSync(path.join(assets, manifest.runtime[field]));
  const avatar = png("avatar"), portrait = png("portrait"), open = png("open"), closed = png("closed");
  assert.equal(avatar.readUInt32BE(16), avatar.readUInt32BE(20));
  assert.equal(portrait.readUInt32BE(16) / 3, portrait.readUInt32BE(20) / 2);
  assert.equal(open[25], 6); assert.equal(closed[25], 6, "blink has genuine RGBA transparency");
  assert.equal(open.readUInt32BE(16), open.readUInt32BE(20));
  assert.equal(open.readUInt32BE(16) % 2, 0);
  assert.equal(open.readUInt32BE(16), closed.readUInt32BE(16));
  assert.equal(open.readUInt32BE(20), closed.readUInt32BE(20));
});

test("Aemeath retains the v4 avatar with repaired v5 peeks; Elaina artwork stays unchanged", () => {
  const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  assert.match(main, /"main-elaina": "elaina-avatar.png", "main-aemeath": "orb\/aemeath-avatar-v4.png"/);
  assert.match(main, /"main-elaina": "elaina-expressions-v2.png", "main-aemeath": "aemeath-expressions-v4.png"/);
  assert.match(main, /"main-elaina": "elaina-peek-v3.png", "main-aemeath": "aemeath-peek-v5.png"/);
  assert.match(main, /"main-elaina": "elaina-peek-blink-v3.png", "main-aemeath": "aemeath-peek-blink-v5.png"/);
});

test("repaired peek assets ship with paired explicit source rectangles and recorded edit prompts", () => {
  const assets = path.resolve(__dirname, "../../web/assets/orb");
  const manifest = JSON.parse(fs.readFileSync(path.join(assets, "peek-v5.json"), "utf8"));
  const { frame } = require("../renderer/orb-peek-frames");
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  const filters = config.build.extraResources.flatMap(row => row.filter || []);
  assert.equal(manifest.assets.length, 2);
  for (const asset of manifest.assets) {
    const bytes = fs.readFileSync(path.join(assets, asset.file));
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    assert.equal(bytes[25], 6, "RGBA alpha is retained");
    assert.equal(bytes.readUInt32BE(16), manifest.layout.width);
    assert.equal(bytes.readUInt32BE(20), manifest.layout.height);
    assert.ok(filters.includes(`assets/orb/${asset.file}`), `packaged ${asset.file}`);
    assert.ok(asset.prompt.length > 200);
    for (const reference of asset.references) assert.ok(fs.existsSync(path.join(assets, reference)));
    for (const edge of manifest.layout.cells) {
      assert.deepEqual(frame(asset.file, edge, manifest.layout.width, manifest.layout.height), manifest.layout.sourceRects[edge]);
    }
  }
  const html = fs.readFileSync(path.join(__dirname, "../renderer/orb.html"), "utf8");
  assert.ok(html.indexOf('src="orb-peek-frames.js"') >= 0);
  assert.ok(html.indexOf('src="orb-peek-frames.js"') < html.indexOf('src="orb.js"'));
  assert.ok(config.scripts["test:orb-clipping"].includes("orb-clipping-matrix.js"));
  assert.ok(config.scripts["test:orb"].includes("npm run test:orb-clipping"), "standard regressions cannot skip the hair-clipping matrix");
});
