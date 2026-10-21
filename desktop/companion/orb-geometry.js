"use strict";

const BALL = 68, PAD = 10, PANEL_WIDTH = 390, PANEL_HEIGHT = 442, GAP = 10;
const EDGES = ["left", "right", "top", "bottom"], TAB = 68, PEEK_LENGTH = 88, SNAP = BALL / 2 + PAD + 14;
const clamp = (n, min, max) => Math.round(Math.max(min, Math.min(n, Math.max(min, max))));
const RESIZE_EDGES = ["n", "s", "e", "w", "nw", "ne", "sw", "se"];
const RESIZE_MARGIN = 5, MIN_PANEL_WIDTH = 320, MIN_PANEL_HEIGHT = 360;

function panelSize(value) {
  if (!value || !Number.isFinite(value.width) || !Number.isFinite(value.height)
    || value.width <= 0 || value.height <= 0) return null;
  return { width: clamp(value.width, MIN_PANEL_WIDTH, 2560), height: clamp(value.height, MIN_PANEL_HEIGHT, 2160) };
}

// All geometry is in Electron DIP, including negative-origin secondary displays.
function placeOrb(anchor, work, expanded = false, dock = null, preferredSize = null, placement = null) {
  const size = panelSize(preferredSize);
  const edge = EDGES.includes(dock) ? dock : null, inset = BALL / 2 + PAD;
  const vertical = edge === "left" || edge === "right";
  // The head has room for its silhouette along the edge, but stays only half
  // exposed across it. Keep the perpendicular anchor unchanged so the opened
  // window still reaches the physical edge and the hover target never jumps.
  const along = PEEK_LENGTH / 2 + PAD;
  const ix = edge && !vertical ? along : inset, iy = vertical ? along : inset;
  const x = clamp(edge === "left" ? work.x + inset : edge === "right" ? work.x + work.width - inset : anchor.x,
    work.x + ix, work.x + work.width - ix);
  const y = clamp(edge === "top" ? work.y + inset : edge === "bottom" ? work.y + work.height - inset : anchor.y,
    work.y + iy, work.y + work.height - iy);
  // Paint extent and hit target are not the same thing. Side heads expose
  // 52 DIP of an 88 DIP sprite; leave 16 DIP inward for reveal, sway, the SVG
  // filter and shadow. The existing PAD protects the two along-edge ends.
  // Top/bottom each reserve 86 DIP. Keep the artwork's screen position when
  // widening a window (renderer right/bottom offsets are edge-relative).
  const depth = vertical ? TAB : 86;
  const tabBounds = edge && (vertical
    ? { x: edge === "left" ? work.x : work.x + work.width - depth, y: y - along, width: depth, height: PEEK_LENGTH + 2 * PAD }
    : { x: x - along, y: edge === "top" ? work.y : work.y + work.height - depth, width: PEEK_LENGTH + 2 * PAD, height: depth });
  const tabLocal = vertical ? { x: 0, y: PAD, width: depth, height: PEEK_LENGTH } : { x: PAD, y: 0, width: PEEK_LENGTH, height: depth };
  if (!expanded && edge) return {
    anchor: { x, y }, edge, dock: edge, expanded, bounds: tabBounds,
    ball: tabLocal, tab: tabLocal, panel: null,
  };
  const width = expanded ? Math.min((size?.width || PANEL_WIDTH) + 2 * PAD, work.width) : BALL + PAD * 2;
  const above = placement?.above ?? y - work.y > work.height / 2;
  const available = (above ? y - work.y : work.y + work.height - y) - BALL / 2 - PAD - GAP;
  // Keep the ball under the pointer when opening mid-screen. Only unusually short
  // displays may move it to make room for a usable composer.
  const panelHeight = size?.height || Math.min(PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, available));
  const height = expanded ? Math.min(panelHeight + GAP + BALL + 2 * PAD, work.height) : BALL + PAD * 2;
  const left = placement?.left ?? x - work.x > work.width / 2;
  const preferredX = expanded && left ? width - PAD - BALL : PAD;
  const by = expanded && above ? height - PAD - BALL : PAD;
  const bounds = { x: clamp(x - preferredX - BALL / 2, work.x, work.x + work.width - width),
    y: clamp(y - by - BALL / 2, work.y, work.y + work.height - height), width, height };
  const tab = edge && { ...tabLocal, x: tabBounds.x + tabLocal.x - bounds.x, y: tabBounds.y + tabLocal.y - bounds.y };
  return { anchor: { x, y: bounds.y + by + BALL / 2 }, edge, dock: null, expanded, bounds, tab, placement: { above, left },
    ball: { x: x - bounds.x - BALL / 2, y: by, width: BALL, height: BALL },
    panel: expanded ? { x: PAD, y: above ? PAD : PAD + BALL + GAP, width: width - 2 * PAD, height: height - BALL - GAP - 2 * PAD } : null };
}

// Resize the actual chat rectangle, not the transparent window or avatar.
// Keep the opposite border fixed and use native DIP cursor deltas exclusively.
function resizePanel(layout, work, edge, delta) {
  if (!layout?.panel || !RESIZE_EDGES.includes(edge) || !Number.isFinite(delta?.x) || !Number.isFinite(delta?.y)) return null;
  const { above, left } = layout.placement;
  const p = layout.panel, b = layout.bounds;
  let x = b.x + p.x, y = b.y + p.y, right = x + p.width, bottom = y + p.height;
  const minX = work.x + PAD, maxX = work.x + work.width - PAD;
  const minY = work.y + PAD + (above ? 0 : BALL + GAP);
  const maxY = work.y + work.height - PAD - (above ? BALL + GAP : 0);
  const minWidth = Math.min(MIN_PANEL_WIDTH, maxX - minX), minHeight = Math.min(MIN_PANEL_HEIGHT, maxY - minY);
  if (edge.includes("w")) x = clamp(x + delta.x, Math.max(minX, right - 2560), right - minWidth);
  if (edge.includes("e")) right = clamp(right + delta.x, x + minWidth, Math.min(maxX, x + 2560));
  if (edge.includes("n")) y = clamp(y + delta.y, Math.max(minY, bottom - 2160), bottom - minHeight);
  if (edge.includes("s")) bottom = clamp(bottom + delta.y, y + minHeight, Math.min(maxY, y + 2160));
  return { size: { width: right - x, height: bottom - y }, placement: { above, left },
    anchor: { x: left ? right - BALL / 2 : x + BALL / 2, y: above ? bottom + GAP + BALL / 2 : y - GAP - BALL / 2 } };
}

function dockAt(point, work, previous = null) {
  const distances = { left: Math.max(0, point.x - work.x), right: Math.max(0, work.x + work.width - point.x),
    top: Math.max(0, point.y - work.y), bottom: Math.max(0, work.y + work.height - point.y) };
  const closest = EDGES.reduce((a, b) => distances[a] <= distances[b] ? a : b);
  if (distances[closest] > SNAP) return null;
  // Keep corners stable. On a fresh diagonal drop left/right wins a tie,
  // leaving OS hot corners clear. Previous edges get an 8 DIP tie band.
  return EDGES.includes(previous) && distances[previous] <= Math.min(SNAP, distances[closest] + 8) ? previous : closest;
}

const inBox = (x, y, box, margin = 0) => !!box && x >= box.x - margin && x <= box.x + box.width + margin
  && y >= box.y - margin && y <= box.y + box.height + margin;
function hitTrigger(point, layout) {
  const x = point.x - layout.bounds.x, y = point.y - layout.bounds.y, b = layout.ball;
  if (inBox(x, y, layout.tab)) return true;
  return !layout.dock && Math.hypot(x - b.x - b.width / 2, y - b.y - b.height / 2) <= b.width / 2 + 3;
}
function hitOrb(point, layout) {
  return hitTrigger(point, layout) || inBox(point.x - layout.bounds.x, point.y - layout.bounds.y, layout.panel, RESIZE_MARGIN)
    || inBox(point.x - layout.bounds.x, point.y - layout.bounds.y, layout.lyric);
}
function withinOrb(point, layout) {
  if (hitOrb(point, layout)) return true;
  const x = point.x - layout.bounds.x, y = point.y - layout.bounds.y, b = layout.ball, p = layout.panel;
  if (!p) return false;
  // Keep the preview through tab → avatar → chat gaps. Clicks on those
  // transparent margins still pass through: this is only a hover grace area.
  const boxes = [b, p, layout.tab].filter(Boolean);
  const left = Math.min(...boxes.map(r => r.x)), top = Math.min(...boxes.map(r => r.y));
  return inBox(x, y, { x: left, y: top, width: Math.max(...boxes.map(r => r.x + r.width)) - left,
    height: Math.max(...boxes.map(r => r.y + r.height)) - top }, 4);
}

module.exports = { BALL, PAD, EDGES, TAB, PEEK_LENGTH, SNAP, RESIZE_EDGES, RESIZE_MARGIN, panelSize, resizePanel, placeOrb, dockAt, hitOrb, hitTrigger, withinOrb };
