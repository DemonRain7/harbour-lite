"use strict";
const assert = require("node:assert/strict");
const { musicView, musicCommand } = require("../companion/orb-music");

// Exercise the orb's exact validation/projection against real offline Folia audio.
// Imported WAV fixtures only; no accounts, model calls or user's player/profile.
module.exports = async function checkOrbMusic(controller) {
  const read = async () => ({ ...controller.status(), ...await controller.command({ action: "status" }) });
  // status intentionally returns main's cached transport state. queue queries the renderer.
  const fresh = async () => ({ ...await read(), ...await controller.command({ action: "queue" }) });
  const send = async (action, extra = {}) => {
    const raw = await fresh(), view = musicView(raw);
    return controller.command(musicCommand({ action, provider: "folia", trackId: view.currentTrackId, ...extra }, raw));
  };
  await send("pause");
  assert.equal((await fresh()).paused, true);
  const lyricDeadline = Date.now() + 8000;
  while ((await fresh()).lyrics?.status !== "ready" && Date.now() < lyricDeadline) await new Promise(r => setTimeout(r, 100));
  assert.equal((await fresh()).lyrics?.status, "ready", "real local LRC travels through the Folia bridge");
  await send("seek", { positionMs: 1500 });
  const lyricState = await fresh(), lyricView = musicView(lyricState);
  const lyricClock = require("../renderer/orb-lyric-clock").read(lyricView);
  assert.equal(lyricState.lyrics.trackId, lyricState.currentTrackId);
  assert.equal(lyricClock.current?.text, "Music stays with you", "same parsed lyric and seek position as Folia");
  assert.equal(lyricView.clockRunning, false, "paused audio never extrapolates");
  await send("set_volume", { volume: 25 }); assert.equal((await fresh()).volume, 25);
  await send("set_volume", { volume: 0 }); assert.equal((await fresh()).volume, 0);
  await send("seek", { positionMs: 1000 }); assert.ok(Math.abs((await fresh()).positionMs - 1000) < 200);
  for (const playbackMode of ["all", "one", "shuffle", "off"]) {
    await send("set_playback_mode", { playbackMode }); assert.equal((await fresh()).playbackMode, playbackMode);
  }
  await send("resume");
  const deadline = Date.now() + 5000;
  let state;
  do { await new Promise(r => setTimeout(r, 100)); state = await fresh(); } while (state.positionMs < 1200 && Date.now() < deadline);
  assert.equal(state.paused, false); assert.ok(state.positionMs >= 1200, "real audio clock advances through orb controls");
  await send("play"); assert.equal((await fresh()).loaded, true, "opaque queue handle selects a real track");
  const beforeHide = (await fresh()).positionMs;
  controller.hide(); await new Promise(r => setTimeout(r, 1300));
  assert.ok(controller.status().positionMs > beforeHide, "hidden Folia continues pushing the real clock without status refresh");
  assert.equal(controller.status().lyrics.status, "ready", "hidden Folia retains the live lyric stream");
  await send("pause");
  console.log("FOLIA_ORB_MUSIC_OK: real bridge/audio/LRC, track-bound lyrics + seek, path-free queue selection, play/pause/resume/seek/volume and all four modes");
};
