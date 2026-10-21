"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), { createRequire } = require("node:module");
const { JSDOM } = createRequire(path.resolve(__dirname, "../../vendor/folia/package.json"))("jsdom");
const source = fs.readFileSync(path.resolve(__dirname, "../renderer/orb-unread.js"), "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const dom = new JSDOM('<section id="panel"><div id="stream"><article class="turn assistant">reply</article></div></section>',
    { url: "https://fixture.invalid", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window, panel = w.document.getElementById("panel"), stream = w.document.getElementById("stream");
  const frames = new Map(), calls = []; let sequence = 0, hidden = false, focused = true, hover = false, active = true, covered = false;
  let bounds = { top: 120, bottom: 200, height: 80 }, now = Date.now();
  let state = { agent: "main-elaina", enabled: true, expanded: true, historyReady: true,
    chat: { sessionId: "session-a", replyRevision: 1, readReplyRevision: 0, historyRevision: 1, lastMessageRole: "assistant", noticeKey: "notice-a", phase: "idle" } };
  Object.defineProperty(w.document, "hidden", { get: () => hidden }); w.document.hasFocus = () => focused;
  panel.matches = selector => selector === ":hover" && hover;
  stream.getClientRects = () => [{}]; stream.getBoundingClientRect = () => ({ top: 60, bottom: 500 });
  stream.querySelector("article").getBoundingClientRect = () => bounds;
  w.requestAnimationFrame = fn => { frames.set(++sequence, fn); return sequence; }; w.cancelAnimationFrame = id => frames.delete(id);
  w.Date.now = () => now;
  w.HarbourVisualActivity = { isActive: () => active, subscribe: fn => { w.wakeVisuals = fn; return () => {}; } };
  w.eval(source);
  const reader = new w.OrbUnread({ panel, stream, getState: () => state, obscured: () => covered,
    invoke: (action, input) => new Promise((resolve, reject) => calls.push({ action, input: JSON.parse(JSON.stringify(input)), resolve, reject })) });
  t.after(() => { reader.dispose(); w.close(); });
  return { w, reader, calls, panel, stream, get state() { return state; },
    patch(patch, chat) { state = { ...state, ...patch, chat: { ...state.chat, ...chat } }; reader.schedule(); },
    setHidden(v) { hidden = v; }, setFocus(v) { focused = v; }, setHover(v) { hover = v; }, setActive(v) { active = v; }, setCovered(v) { covered = v; },
    setBounds(v) { bounds = v; }, advance(ms) { now += ms; },
    async tick() { await settle(); const batch = [...frames.values()]; frames.clear(); for (const fn of batch) fn(); await settle(); },
  };
}

test("latest rendered reply sends one revision-bound receipt, including restored idle and failure histories", async t => {
  const f = fixture(t); f.patch({}, { phase: "idle", failure: { scope: "task", label: "failed" } });
  await f.tick();
  assert.deepEqual(f.calls[0].input, { agent: "main-elaina", sessionId: "session-a", replyRevision: 1, historyRevision: 1, noticeKey: "notice-a" });
  assert.equal(f.calls[0].action, "read"); assert.equal(f.reader.done.size, 0, "no optimistic acknowledgement");
  for (let i = 0; i < 20; i++) f.stream.dispatchEvent(new f.w.Event("scroll"));
  await f.tick(); assert.equal(f.calls.length, 1);
  f.calls[0].resolve(true); await f.tick();
  f.reader.schedule(); await f.tick(); assert.equal(f.calls.length, 1);
});

for (const mode of ["hidden", "collapsed", "disabled", "unfocused", "quiet", "scrolled-up", "loading", "history-missing", "running", "preparing", "panel-hidden", "retracting", "overlay", "last-user", "offpage", "already-read"]) {
  test(`${mode} does not silently consume an orb notification`, async t => {
    const f = fixture(t);
    if (mode === "hidden") f.setHidden(true);
    if (mode === "collapsed") f.patch({ expanded: false });
    if (mode === "disabled") f.patch({ enabled: false });
    if (mode === "unfocused") f.setFocus(false);
    if (mode === "quiet") f.setActive(false);
    if (mode === "scrolled-up") f.setBounds({ top: 800, bottom: 900, height: 100 });
    if (mode === "loading") f.patch({}, { loading: true });
    if (mode === "history-missing") f.patch({ historyReady: false });
    if (mode === "running") f.patch({}, { runId: "active" });
    if (mode === "preparing") f.patch({}, { preparing: true });
    if (mode === "panel-hidden") f.panel.hidden = true;
    if (mode === "retracting") f.panel.inert = true;
    if (mode === "overlay") f.setCovered(true);
    if (mode === "last-user") f.patch({}, { lastMessageRole: "user" });
    if (mode === "offpage") f.stream.remove();
    if (mode === "already-read") f.patch({}, { notificationRead: true });
    f.reader.schedule(); await f.tick(); assert.equal(f.calls.length, 0);
  });
}

test("hover preview counts as viewing without forcing native focus; scrolling to latest retries visibility", async t => {
  const f = fixture(t); f.setFocus(false); f.setBounds({ top: 800, bottom: 900, height: 100 });
  f.setHover(true); f.panel.dispatchEvent(new f.w.Event("pointerenter")); await f.tick(); assert.equal(f.calls.length, 0);
  f.setBounds({ top: 100, bottom: 300, height: 200 }); f.stream.dispatchEvent(new f.w.Event("scroll"));
  await f.tick(); assert.equal(f.calls.length, 1);
  assert.equal(f.w.document.hasFocus(), false, "receipt never steals focus");
});

test("a newer reply arriving during receipt IPC is checked separately, not consumed with the old revision", async t => {
  const f = fixture(t); f.reader.schedule(); await f.tick();
  f.patch({}, { replyRevision: 2, historyRevision: 2, noticeKey: "notice-b" }); await f.tick();
  assert.equal(f.calls.length, 1);
  f.calls[0].resolve(true); await f.tick();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].input.replyRevision, 2);
});

test("read failure retains notification, backs off, and retries only on a new view event; disposal cancels observers", async t => {
  const f = fixture(t); f.reader.schedule(); await f.tick();
  f.calls[0].reject(new Error("offline")); await f.tick();
  f.reader.schedule(); await f.tick(); assert.equal(f.calls.length, 1); assert.equal(f.reader.done.size, 0);
  f.advance(10001); await f.tick(); assert.equal(f.calls.length, 1, "no polling");
  f.stream.dispatchEvent(new f.w.Event("scroll")); await f.tick(); assert.equal(f.calls.length, 2);
  f.calls[1].resolve(false); await f.tick(); assert.equal(f.reader.done.size, 0);
  f.reader.dispose(); f.w.dispatchEvent(new f.w.Event("focus")); await f.tick(); assert.equal(f.calls.length, 2);
});
