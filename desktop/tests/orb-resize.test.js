"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { placeOrb, panelSize, resizePanel, RESIZE_EDGES, hitOrb } = require("../companion/orb-geometry");
const absolute = g => ({ x: g.bounds.x + g.panel.x, y: g.bounds.y + g.panel.y, width: g.panel.width, height: g.panel.height });

test("panel preferences validate legacy/malformed state and preserve DIP dimensions", () => {
  for (const bad of [undefined, null, [], {}, { width: "500", height: 600 }, { width: NaN, height: 600 }, { width: 500, height: -1 }])
    assert.equal(panelSize(bad), null);
  assert.deepEqual(panelSize({ width: 480.2, height: 600.7 }), { width: 480, height: 601 });
  assert.deepEqual(panelSize({ width: 1, height: 1 }), { width: 320, height: 360 });
  assert.deepEqual(panelSize({ width: 90000, height: 90000 }), { width: 2560, height: 2160 });
});

test("all four edges and four corners keep the opposite borders fixed in either opening direction", () => {
  const work = { x: -1920, y: -200, width: 1920, height: 1200 };
  for (const anchor of [{ x: -1600, y: 0 }, { x: -320, y: 700 }]) for (const edge of RESIZE_EDGES) {
    const initial = placeOrb(anchor, work, true, null, { width: 420, height: 440 });
    const a = absolute(initial), delta = { x: edge.includes("w") ? -65 : 65, y: edge.includes("n") ? -45 : 45 };
    const next = resizePanel(initial, work, edge, delta);
    const resized = placeOrb(next.anchor, work, true, null, next.size, next.placement), b = absolute(resized);
    assert.equal(b.width, a.width + (/[ew]/.test(edge) ? 65 : 0), edge);
    assert.equal(b.height, a.height + (/[ns]/.test(edge) ? 45 : 0), edge);
    if (!edge.includes("w")) assert.equal(b.x, a.x, edge);
    if (!edge.includes("e")) assert.equal(b.x + b.width, a.x + a.width, edge);
    if (!edge.includes("n")) assert.equal(b.y, a.y, edge);
    if (!edge.includes("s")) assert.equal(b.y + b.height, a.y + a.height, edge);
  }
});

test("work-area fitting, minimum sizes, negative displays and orientation remain stable", () => {
  for (const work of [{ x: 0, y: 0, width: 1280, height: 900 }, { x: -720, y: -1100, width: 720, height: 1100 }, { x: 0, y: 0, width: 360, height: 440 }]) {
    for (const dock of [null, "left", "right", "top", "bottom"]) for (const edge of RESIZE_EDGES) for (const d of [-9999, 9999]) {
      const g = placeOrb({ x: work.x + work.width / 2, y: work.y + work.height / 2 }, work, true, dock, { width: 640, height: 700 });
      const r = resizePanel(g, work, edge, { x: d, y: d });
      const next = placeOrb(r.anchor, work, true, null, r.size, r.placement);
      assert.ok(next.bounds.x >= work.x && next.bounds.y >= work.y);
      assert.ok(next.bounds.x + next.bounds.width <= work.x + work.width);
      assert.ok(next.bounds.y + next.bounds.height <= work.y + work.height);
      assert.ok(next.panel.width >= Math.min(320, work.width - 20));
      assert.ok(next.panel.height >= Math.min(360, work.height - 98));
      assert.deepEqual(next.placement, g.placement, "no midpoint flip while dragging");
    }
  }
});

test("resizing never changes collapsed art size and only its border captures extra clicks", () => {
  const area = { x: 0, y: 0, width: 1280, height: 900 }, anchor = { x: 300, y: 200 };
  for (const dock of [null, "left", "right", "top", "bottom"])
    assert.deepEqual(placeOrb(anchor, area, false, dock, { width: 900, height: 700 }), placeOrb(anchor, area, false, dock));
  const g = placeOrb(anchor, area, true), p = absolute(g);
  assert.equal(hitOrb({ x: p.x - 4, y: p.y + 60 }, g), true);
  assert.equal(hitOrb({ x: p.x - 8, y: p.y + 60 }, g), false);
  assert.equal(resizePanel(g, area, "wrong", { x: 5, y: 5 }), null);
  assert.equal(resizePanel(g, area, "se", { x: Infinity, y: 5 }), null);
});
