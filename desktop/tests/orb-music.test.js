"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { musicView, musicCommand } = require("../companion/orb-music");
const raw = { provider: "folia", connected: true, running: true, loaded: true, paused: false, volume: 70,
  currentTrackId: "local:D:/private/summer.wav", durationMs: 180000, positionMs: 43000,
  tracks: [{ id: "local:D:/private/summer.wav", title: "夏之灯", artist: "Harbour", url: "secret", token: "secret" }, { id: "online:qq:2", title: "风" }],
  providerCapabilities: ["play", "resume", "pause", "previous", "next", "seek", "set_volume", "set_playback_mode"],
  playbackModeAvailable: true, playbackMode: "all", auth: "secret", renderer: { phase: "ready" } };

test("music view is bounded, path-free metadata, not credentials or media", () => {
  const view = musicView(raw);
  assert.equal(view.tracks[0].title, "夏之灯");
  assert.equal(view.currentTrackId, view.tracks[0].id); assert.match(view.currentTrackId, /^[a-f0-9]{24}$/);
  assert.doesNotMatch(JSON.stringify(view), /private|secret|token|auth|D:/);
  assert.ok(view.controls.includes("seek")); assert.equal(view.playbackMode, "all");
  assert.equal(musicView({ ...raw, tracks: Array.from({ length: 5000 }, (_, i) => ({ id: String(i) })) }).tracks.length, 200);
  const large = musicView({ ...raw, currentTrackId: "4000", tracks: Array.from({ length: 5000 }, (_, i) => ({ id: String(i), title: `Track ${i}` })) });
  assert.equal(large.loaded, true); assert.equal(large.tracks[0].title, "Track 4000"); assert.equal(large.tracks.length, 200);
  assert.equal(musicView({ ...raw, durationMs: Infinity, volume: NaN }).durationMs, 0);
});
test("failed/unavailable Folia cannot be started by a transport button", () => {
  for (const patch of [{ connected: false }, { providerAvailable: false }, { available: false }]) {
    assert.deepEqual(musicView({ ...raw, ...patch }).controls, []);
    assert.throws(() => musicCommand({ action: "resume", provider: "folia" }, { ...raw, ...patch }), /暂不支持/);
  }
  const empty = musicView({ ...raw, tracks: [], loaded: false });
  assert.equal(empty.loaded, false); assert.equal(empty.controls.includes("resume"), true);
});
test("cold Folia exposes only resume, leaving queue restoration to its single owner", () => {
  for (const patch of [{ running: false }, { renderer: { phase: "starting" } }]) {
    const cold = { ...raw, ...patch, loaded: false, tracks: [], playbackModeAvailable: false };
    assert.deepEqual(musicView(cold).controls, ["resume"]);
    assert.deepEqual(musicCommand({ action: "resume", provider: "folia", trackId: "ignored" }, cold), { action: "resume" });
    assert.throws(() => musicCommand({ action: "next", provider: "folia" }, cold), /暂不支持/);
  }
});
test("only current queue handles select a track, extra renderer arguments are stripped", () => {
  const view = musicView(raw);
  assert.deepEqual(musicCommand({ action: "play", provider: "folia", trackId: view.tracks[1].id, player: "other", path: "evil", url: "evil" }, raw), { action: "play", trackId: raw.tracks[1].id });
  for (const trackId of ["https://evil/audio", raw.currentTrackId, "", "unlisted"]) assert.throws(() => musicCommand({ action: "play", provider: "folia", trackId }, raw), /不在当前队列/);
  assert.throws(() => musicCommand({ action: "close", provider: "folia" }, raw), /暂不支持/);
});
test("provider changes and seek-on-another-song are rejected instead of retargeted", () => {
  const view = musicView(raw);
  assert.throws(() => musicCommand({ action: "pause", provider: "local" }, raw), /来源已切换/);
  assert.throws(() => musicCommand({ action: "seek", provider: "folia", trackId: view.tracks[1].id, positionMs: 10 }, raw), /歌曲已切换/);
  assert.deepEqual(musicCommand({ action: "seek", provider: "folia", trackId: view.currentTrackId, positionMs: 0 }, raw), { action: "seek", positionMs: 0 });
  for (const positionMs of [-1, Infinity, NaN, "1", 180001]) assert.throws(() => musicCommand({ action: "seek", provider: "folia", trackId: view.currentTrackId, positionMs }, raw), /超出歌曲范围/);
});
test("volume/mode bounds and provider capability gating", () => {
  for (const volume of [-1, 101, NaN, "10", Infinity]) assert.throws(() => musicCommand({ action: "set_volume", provider: "folia", volume }, raw), /音量/);
  for (const volume of [0, 100]) assert.equal(musicCommand({ action: "set_volume", provider: "folia", volume }, raw).volume, volume);
  for (const playbackMode of ["off", "all", "one", "shuffle"]) assert.equal(musicCommand({ action: "set_playback_mode", provider: "folia", playbackMode }, raw).playbackMode, playbackMode);
  assert.throws(() => musicCommand({ action: "set_playback_mode", provider: "folia", playbackMode: "invalid" }, raw), /无效/);
  assert.throws(() => musicCommand({ action: "set_playback_mode", provider: "folia", playbackMode: "shuffle" }, { ...raw, playbackModeAvailable: false }), /暂不支持/);
  const qq = musicView({ ...raw, provider: "qqmusic", providerCapabilities: ["pause", "resume", "next", "previous"] });
  assert.deepEqual(qq.controls, ["pause", "resume", "previous", "next"]);
});
