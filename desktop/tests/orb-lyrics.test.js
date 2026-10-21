"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { placeOrb, hitOrb, hitTrigger } = require("../companion/orb-geometry");
const { placeLyrics, lyricView } = require("../companion/orb-lyrics");
const clock = require("../renderer/orb-lyric-clock");

test("real common publisher updates the orb on every Folia sample without leaking lyrics to server or pets", () => {
  const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const fn = source.slice(source.indexOf("function publishMusicState("), source.indexOf("function qqMusicStateForBridge("));
  const companionState = { setMusic: value => { companionState.music = value; } }, sent = [], projected = [], signals = [];
  const context = { companionState, orbSignals: { setMusic: value => signals.push(value) },
    orb: { publishMusic: () => projected.push(companionState.music) }, remoteBridge: { updateMusicState: value => sent.push(value) } };
  vm.runInNewContext(`${fn}; this.publish = publishMusicState`, context);
  for (const positionMs of [0, 1000, 3000]) context.publish({ provider: "folia", loaded: positionMs > 0, positionMs, lyrics: { text: "private lyric sample" } });
  assert.equal(projected.length, 3); assert.equal(projected[2].positionMs, 3000);
  assert.equal(signals.length, 3); assert.doesNotMatch(JSON.stringify([sent, companionState.music]), /private lyric|lyrics/);
});

test("lyric projection is bounded, track-bound, read-only and cannot carry provider credentials or file identities", () => {
  const source = { trackId: "local:D:/private.wav", status: "ready", clockMs: -100, secret: "credential", lines: Array.from({ length: 1000 }, (_, index) => ({ index,
    startMs: index * 1000, endMs: (index + 1) * 1000, text: "x".repeat(1000), translation: "<img onerror=evil>", words: ["large data"] })) };
  const raw = { provider: "folia", currentTrackId: source.trackId, lyrics: source };
  const view = lyricView(raw, true);
  assert.equal(view.lines.length, 6); assert.equal(view.lines[0].text.length, 500); assert.equal(view.clockMs, -100);
  assert.doesNotMatch(JSON.stringify(view), /private.wav|credential|words/);
  assert.deepEqual(lyricView({ ...raw, currentTrackId: "new-song" }, true).lines, []);
  assert.deepEqual(lyricView(raw, false).lines, []);
  assert.equal(lyricView({ ...raw, provider: "qqmusic" }, true).status, "unsupported");
  assert.equal(lyricView({ ...raw, lyrics: { ...source, lines: [{ index: 0, startMs: NaN, endMs: Infinity }] } }, true).status, "empty");
});

test("bounded audio interpolation handles offsets, pause, buffer, seek, gaps, speed and stale samples", () => {
  const state = { loaded: true, paused: false, clockRunning: true, playbackRate: 1, positionMs: 10000, durationMs: 40000, sampledAt: 100000,
    lyrics: { status: "ready", clockMs: 8000, lines: [
      { index: 1, text: "前句", startMs: 4000, endMs: 8500 }, { index: 2, text: "下一句", startMs: 9000, endMs: 11000 }] } };
  assert.equal(clock.read(state, 100200).current.text, "前句");
  assert.equal(clock.read(state, 100750).current, null); assert.equal(clock.read(state, 100750).next.text, "下一句");
  assert.equal(clock.read(state, 101000).current.text, "下一句"); assert.equal(clock.read(state, 101000).positionMs, 11000);
  assert.equal(clock.read({ ...state, paused: true }, 101000).current.text, "前句");
  assert.equal(clock.read({ ...state, clockRunning: false }, 101000).positionMs, 10000);
  assert.equal(clock.read({ ...state, playbackRate: 2 }, 100600).current.text, "下一句");
  assert.equal(clock.read(state, 199999).positionMs, 11500); assert.equal(clock.read(state, 199999).stale, true);
  assert.equal(clock.read({ ...state, sampledAt: 200000, positionMs: 4000, lyrics: { ...state.lyrics, clockMs: 2000 } }, 200010).current, null);
});

test("lyrics fit every edge, expand and resize without moving/cropping the avatar or covering chat", () => {
  const global = (layout, key) => { const r = layout[key]; return r && { ...r, x: r.x + layout.bounds.x, y: r.y + layout.bounds.y }; };
  for (const work of [{ x: 0, y: 0, width: 1200, height: 900 }, { x: -900, y: -100, width: 900, height: 780 }, { x: 0, y: 0, width: 360, height: 440 }]) {
    for (const edge of [null, "left", "right", "top", "bottom"]) for (const expanded of [false, true]) {
      const base = placeOrb({ x: work.x + work.width * .75, y: work.y + work.height * .7 }, work, expanded, edge, { width: 600, height: 450 });
      const result = placeLyrics(base, work, true), card = global(result, "lyric");
      assert.ok(card); assert.deepEqual(global(result, "ball"), global(base, "ball")); assert.deepEqual(global(result, "panel"), global(base, "panel"));
      assert.deepEqual(global(result, "tab"), global(base, "tab")); assert.deepEqual(result.anchor, base.anchor);
      assert.ok(result.bounds.x >= work.x && result.bounds.y >= work.y);
      assert.ok(result.bounds.x + result.bounds.width <= work.x + work.width);
      assert.ok(result.bounds.y + result.bounds.height <= work.y + work.height);
      const panel = global(result, "panel");
      if (panel) assert.ok(card.x + card.width <= panel.x || card.x >= panel.x + panel.width || card.y + card.height <= panel.y || card.y >= panel.y + panel.height);
      const point = { x: card.x + card.width / 2, y: card.y + card.height / 2 };
      assert.equal(hitOrb(point, result), true); assert.equal(hitTrigger(point, result), false, "lyrics never trigger hover expansion");
      assert.deepEqual(placeLyrics(base, work, false).bounds, base.bounds);
    }
  }
});
