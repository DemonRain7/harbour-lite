/* Read-only interpolation between Folia's real audio samples. Never invent
 * ongoing playback after a lost heartbeat, pause, buffer or provider change. */
((root, factory) => {
  const clock = factory();
  if (typeof module === "object" && module.exports) module.exports = clock;
  else root.OrbLyricClock = clock;
})(typeof window === "undefined" ? globalThis : window, () => ({
  read(state, now = Date.now()) {
    const s = state || {}, age = Math.max(0, now - (s.sampledAt || now));
    const delta = s.loaded && !s.paused && s.clockRunning ? Math.min(1500, age) * (s.playbackRate || 1) : 0;
    const positionMs = Math.min(s.durationMs || 0, (s.positionMs || 0) + delta);
    const time = (s.lyrics?.clockMs || 0) + delta, lines = s.lyrics?.lines || [];
    const active = lines.findLastIndex(line => line.startMs <= time && time <= line.endMs);
    const upcoming = lines.findIndex(line => line.startMs > time);
    const current = active >= 0 ? lines[active] : null;
    const previous = active > 0 ? lines[active - 1] : upcoming > 0 ? lines[upcoming - 1] : null;
    const next = active >= 0 ? lines[active + 1] : upcoming >= 0 ? lines[upcoming] : null;
    const status = !s.loaded ? "idle" : s.lyrics?.status || "unsupported";
    const message = { idle: "选一首歌，让歌词陪你", unsupported: s.provider === "folia" ? "请更新 Folia 以同步歌词" : "此来源暂不提供歌词",
      empty: "暂无歌词 · 可在 Folia 中匹配", switching: "正在切换歌曲…", ready: next ? "间奏 · 听一会儿" : "尾声 · 余音未散" }[status];
    return { positionMs, current, previous, next, message, stale: !!s.clockRunning && age > 3000 };
  },
}));
