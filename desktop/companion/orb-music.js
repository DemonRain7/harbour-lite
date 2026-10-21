"use strict";

const { createHash } = require("node:crypto");
const { lyricView } = require("./orb-lyrics");
const { canResume } = require("../../web/music-context");
const clean = (value, max = 180) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
const number = value => Number.isFinite(value) ? Math.max(0, value) : 0;
const providers = new Set(["folia", "local", "qqmusic"]);
const modes = new Set(["off", "all", "one", "shuffle"]);
// Local Folia identities can contain paths. Only opaque queue handles leave main.
const handle = (provider, id) => createHash("sha256").update(`${provider}\0${id}`).digest("hex").slice(0, 24);
function queue(raw) {
  const tracks = Array.isArray(raw?.tracks) ? raw.tracks.filter(t => typeof t?.id === "string" && t.id) : [];
  const rows = tracks.slice(0, 200);
  const current = tracks.find(t => t.id === raw?.currentTrackId);
  // A large local library must not turn a playing song into an empty player.
  if (current && !rows.some(t => t.id === current.id)) { rows.pop(); rows.unshift(current); }
  return rows;
}

function musicView(raw = {}, compact = false) {
  const provider = providers.has(raw.provider) ? raw.provider : "local";
  const tracks = compact ? (Array.isArray(raw.tracks) ? raw.tracks.filter(t => t?.id === raw.currentTrackId).slice(0, 1) : []) : queue(raw);
  const current = tracks.find(t => t.id === raw.currentTrackId);
  const ready = raw.connected !== false && raw.providerAvailable !== false && raw.available !== false
    && (provider !== "folia" || raw.running === true && raw.renderer?.phase !== "starting");
  const loaded = ready && raw.loaded === true && !!current;
  const caps = new Set(raw.providerCapabilities || []), controls = [];
  if (ready && provider !== "qqmusic" && tracks.length && caps.has("play")) controls.push("play");
  if (loaded) {
    for (const action of ["pause", "resume", "previous", "next", "set_volume"]) if (caps.has(action)) controls.push(action);
    if (caps.has("seek") && number(raw.durationMs) > 0) controls.push("seek");
  }
  if (!loaded && canResume(raw) && caps.has("resume")) controls.push("resume");
  if (ready && raw.playbackModeAvailable === true && caps.has("set_playback_mode")) controls.push("set_playback_mode");
  const reason = !ready ? provider === "folia"
    ? controls.includes("resume") ? "点击播放，继续上次的音乐。" : "打开 Folia，连接你的音乐。"
    : "当前播放器尚未连接，可打开 Folia 选歌。"
    : !current ? "去 Folia 选一首歌，回来也能继续听。" : "";
  return { provider, ready, loaded, paused: raw.paused !== false, reason, controls,
    currentTrackId: current ? handle(provider, current.id) : "",
    tracks: tracks.map(t => ({ id: handle(provider, t.id), title: clean(t.title) || "未命名曲目", artist: clean(t.artist, 120) })),
    queueLimited: tracks.length >= 200, volume: Math.min(100, number(raw.volume)),
    positionMs: Math.min(number(raw.positionMs), number(raw.durationMs)), durationMs: number(raw.durationMs),
    sampledAt: Number.isFinite(raw.sampledAt) ? raw.sampledAt : Date.now(),
    clockRunning: loaded && raw.paused === false && raw.clockRunning === true,
    playbackRate: Number.isFinite(raw.playbackRate) ? Math.min(4, Math.max(.25, raw.playbackRate)) : 1,
    lyrics: lyricView(raw, loaded),
    playbackMode: modes.has(raw.playbackMode) ? raw.playbackMode : "off" };
}

function musicCommand(input, raw) {
  const view = musicView(raw), action = input?.action;
  if (input?.provider !== view.provider) throw new Error("音乐来源已切换，请按最新状态操作");
  if (!view.controls.includes(action)) throw new Error("当前播放器暂不支持此操作，请打开 Folia 选歌或检查播放状态");
  if (action === "play") {
    const track = queue(raw).find(t => handle(view.provider, t.id) === input.trackId);
    if (!track) throw new Error("这首歌已不在当前队列，请重新选择");
    return { action, trackId: track.id };
  }
  if (action === "seek") {
    if (!input.trackId || input.trackId !== view.currentTrackId) throw new Error("歌曲已切换，请重新调整进度");
    if (!Number.isFinite(input.positionMs) || input.positionMs < 0 || input.positionMs > view.durationMs) throw new Error("播放进度超出歌曲范围");
    return { action, positionMs: input.positionMs };
  }
  if (action === "set_volume") {
    if (!Number.isFinite(input.volume) || input.volume < 0 || input.volume > 100) throw new Error("音量须为 0–100");
    return { action, volume: input.volume };
  }
  if (action === "set_playback_mode") {
    if (!modes.has(input.playbackMode)) throw new Error("无效的播放模式");
    return { action, playbackMode: input.playbackMode };
  }
  return { action }; // Never forward renderer-supplied player, URL, path or extra arguments.
}

module.exports = { musicView, musicCommand };
