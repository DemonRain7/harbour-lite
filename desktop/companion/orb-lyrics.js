"use strict";

// Only display-ready, track-bound lyric text crosses into the orb renderer.
function lyricView(raw, loaded) {
  const source = raw.lyrics;
  if (raw.provider !== "folia" || !source) return { status: "unsupported", lines: [], clockMs: 0 };
  if (!loaded || source.trackId !== raw.currentTrackId) return { status: "empty", lines: [], clockMs: 0 };
  const text = value => typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, 500) : "";
  const lines = (Array.isArray(source.lines) ? source.lines : []).slice(0, 6)
    .filter(line => Number.isInteger(line?.index) && line.index >= 0 && Number.isFinite(line.startMs) && Number.isFinite(line.endMs) && line.endMs >= line.startMs)
    .map(line => ({ index: line.index, startMs: line.startMs, endMs: line.endMs, text: text(line.text), translation: text(line.translation) }));
  return { status: source.status === "switching" ? "switching" : source.status === "ready" && lines.length ? "ready" : "empty",
    lines, clockMs: Number.isFinite(source.clockMs) ? source.clockMs : 0 };
}

// Extend the paint surface, never move the avatar/chat or overwrite their saved
// dimensions. The portrait retains its full native paint margin on every edge.
function placeLyrics(base, work, visible) {
  if (!visible) return { ...base, lyric: null };
  const b = base.bounds, orb = base.ball, gap = 10, height = 68;
  const avatar = { x: b.x + orb.x, y: b.y + orb.y, width: orb.width, height: orb.height };
  let width = Math.min(258, work.width - 16), x, y;
  if (base.dock === "top" || base.dock === "bottom") {
    x = Math.max(work.x + 8, Math.min(avatar.x + avatar.width / 2 - width / 2, work.x + work.width - width - 8));
    y = base.dock === "top" ? b.y + b.height + 4 : b.y - height - 4;
  } else {
    const obstacle = base.dock ? b : avatar;
    const leftSpace = obstacle.x - work.x - gap - 8, rightSpace = work.x + work.width - obstacle.x - obstacle.width - gap - 8;
    const left = leftSpace > rightSpace;
    width = Math.min(width, left ? leftSpace : rightSpace);
    if (width < 140) return { ...base, lyric: null }; // extremely narrow display
    x = left ? obstacle.x - gap - width : obstacle.x + obstacle.width + gap;
    y = avatar.y + (avatar.height - height) / 2;
  }
  y = Math.round(Math.max(work.y + 8, Math.min(y, work.y + work.height - height - 8)));
  const card = { x: Math.round(x), y, width: Math.floor(width), height };
  const bounds = { x: Math.min(b.x, card.x - 6), y: Math.min(b.y, card.y - 6),
    width: 0, height: 0 };
  bounds.width = Math.max(b.x + b.width, card.x + card.width + 6) - bounds.x;
  bounds.height = Math.max(b.y + b.height, card.y + card.height + 6) - bounds.y;
  const shift = r => r && { ...r, x: r.x + b.x - bounds.x, y: r.y + b.y - bounds.y };
  return { ...base, bounds, ball: shift(base.ball), tab: shift(base.tab), panel: shift(base.panel),
    lyric: { ...card, x: card.x - bounds.x, y: card.y - bounds.y } };
}

module.exports = { lyricView, placeLyrics };
