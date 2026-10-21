"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { EDGES, SNAP, placeOrb, dockAt, hitOrb, hitTrigger, withinOrb } = require("../companion/orb-geometry");
const { OrbHover, REVEAL_MS, RETRACT_MS, REARM_MS } = require("../companion/orb-hover");
const { frame, paint } = require("../renderer/orb-peek-frames");
const center = (g, box) => ({ x: g.bounds.x + box.x + box.width / 2, y: g.bounds.y + box.y + box.height / 2 });

test("source frames follow the real atlas gutter, with matching blink and undistorted contain-fit", () => {
  for (const edge of EDGES) {
    const open = frame("aemeath-peek-v5.png", edge, 1254, 1254);
    const blink = frame("aemeath-peek-blink-v5.png", edge, 1254, 1254);
    assert.deepEqual(open, blink);
    assert.ok(open.x >= 0 && open.y >= 0 && open.x + open.width <= 1254 && open.y + open.height <= 1254);
    const fitted = paint("aemeath-peek-v5.png", edge, 1254, 1254, 88);
    const [x, y] = fitted.style.backgroundSize.split(" ").map(parseFloat);
    assert.equal(x, y, "uniform scaling, never stretch a face to fill a cell");
    assert.match(fitted.style.clipPath, /^inset/);
  }
  assert.equal(frame("aemeath-peek-v5.png", "left", 1254, 1254).height, 642);
  assert.equal(frame("aemeath-peek-v5.png", "top", 1254, 1254).y, 642);
  assert.equal(frame("elaina-peek-v3.png", "left", 1254, 1254).height, 627);
  assert.equal(frame("unknown.png", "none", 0, 0), null);
});

test("four edges snap when the visible orb approaches; taskbar overshoot also docks", () => {
  const area = { x: -1600, y: -900, width: 1600, height: 860 };
  for (const [edge, point] of [
    ["left", { x: -1600 + 44, y: -500 }], ["right", { x: -44, y: -500 }],
    ["top", { x: -800, y: -900 + 44 }], ["bottom", { x: -800, y: -40 - 44 }],
    ["bottom", { x: -800, y: 34 }],
  ]) assert.equal(dockAt(point, area), edge);
  assert.equal(dockAt({ x: area.x + SNAP + 1, y: -500 }, area), null);
  assert.equal(dockAt({ x: -800, y: -500 }, area), null);
});

test("corners choose one nearest edge without flip-flopping or occupying OS corners", () => {
  const work = { x: 0, y: 0, width: 1920, height: 1040 };
  for (const [point, edge] of [[{ x: 0, y: 0 }, "left"], [{ x: 1920, y: 0 }, "right"],
    [{ x: 0, y: 1040 }, "left"], [{ x: 1920, y: 1040 }, "right"]]) {
    assert.equal(dockAt(point, work), edge);
    const g = placeOrb(point, work, false, edge);
    assert.equal(hitOrb(point, g), false, "leave the exact OS hot corner alone");
  }
  assert.equal(dockAt({ x: 17, y: 15 }, work, "left"), "left");
  assert.equal(dockAt({ x: 17, y: 15 }, work, "top"), "top");
  assert.equal(dockAt({ x: 35, y: 15 }, work, "left"), "top");
});

test("all edge tabs stay reachable on negative, offset, short and portrait work areas", () => {
  for (const work of [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: -1600, y: -120, width: 1600, height: 900 },
    { x: 48, y: 32, width: 720, height: 1100 }, { x: -360, y: 20, width: 360, height: 440 }]) {
    for (const edge of EDGES) for (const anchor of [{ x: -9999, y: -9999 }, { x: 9999, y: 9999 },
      { x: work.x + work.width / 2, y: work.y + work.height / 2 }]) {
      const rest = placeOrb(anchor, work, false, edge), open = placeOrb(rest.anchor, work, true, edge);
      assert.equal(rest.edge, edge); assert.equal(rest.dock, edge);
      assert.equal(open.edge, edge); assert.equal(open.dock, null);
      for (const g of [rest, open]) {
        assert.ok(g.bounds.x >= work.x && g.bounds.y >= work.y);
        assert.ok(g.bounds.x + g.bounds.width <= work.x + work.width);
        assert.ok(g.bounds.y + g.bounds.height <= work.y + work.height);
        const t = center(g, g.tab);
        assert.ok(g.tab.x >= 0 && g.tab.y >= 0);
        assert.ok(g.tab.x + g.tab.width <= g.bounds.width && g.tab.y + g.tab.height <= g.bounds.height,
          "the complete peeking silhouette fits inside the native window");
        assert.ok(t.x >= g.bounds.x && t.x <= g.bounds.x + g.bounds.width);
        assert.ok(t.y >= g.bounds.y && t.y <= g.bounds.y + g.bounds.height);
        assert.equal(hitTrigger(t, g), true);
        assert.equal(hitOrb(t, g), true);
        assert.equal(withinOrb(t, g), true);
      }
      assert.deepEqual(center(open, open.tab), center(rest, rest.tab), "reveal leaves a stable handle under the cursor");
    }
  }
});

test("preview travel gaps don't collapse, but transparent margins don't capture clicks", () => {
  for (const edge of EDGES) {
    const g = placeOrb({ x: 640, y: 450 }, { x: 0, y: 0, width: 1280, height: 900 }, true, edge);
    const p = g.panel, b = g.ball;
    // Side heads now extend along the edge past the ball: test the real clear
    // travel gap, not the intentional stable peeking-head hit target.
    const before = edge === "top" ? g.tab.y + g.tab.height : b.y + b.height;
    const after = edge === "bottom" ? g.tab.y : b.y;
    const gap = { x: g.bounds.x + b.x + (edge === "left" ? b.width - 8 : edge === "right" ? 8 : b.width / 2),
      y: g.bounds.y + (b.y < p.y ? (before + p.y) / 2 : (p.y + p.height + after) / 2) };
    // The five-DIP resize border is intentionally interactive; the rest of
    // the transparent travel gap remains a hover-only grace area.
    const resizeBorder = gap.y >= g.bounds.y + p.y - 5 && gap.y <= g.bounds.y + p.y + p.height + 5;
    assert.equal(hitOrb(gap, g), resizeBorder);
    assert.equal(hitOrb({ x: g.bounds.x + g.bounds.width - 1, y: g.bounds.y + p.y + p.height / 2 }, g), false);
    assert.equal(withinOrb(gap, g), true);
    assert.equal(withinOrb({ x: g.bounds.x - 10, y: g.bounds.y - 10 }, g), false);
  }
});

test("all heads reserve paint clearance without covering the expanded chat", () => {
  const work = { x: 0, y: 0, width: 1280, height: 900 };
  const rest = placeOrb({ x: 640, y: 0 }, work, false, "top");
  const open = placeOrb(rest.anchor, work, true, "top");
  assert.equal(rest.bounds.height, 86);
  assert.equal(rest.tab.height, rest.bounds.height);
  assert.deepEqual(center(rest, rest.tab), center(open, open.tab), "hover target stays in place when revealing");
  assert.ok(open.tab.y + open.tab.height < open.panel.y, "the retained transparent handle cannot intercept chat clicks");
  assert.equal(placeOrb(rest.anchor, work, false, "bottom").bounds.height, 86);
  for (const edge of ["left", "right"]) {
    const g = placeOrb(rest.anchor, work, false, edge);
    assert.equal(g.bounds.width, 68);
    assert.ok(g.tab.y >= 10 && g.bounds.height - g.tab.y - g.tab.height >= 10,
      "painting has room above and below the unchanged hit target");
  }
  const bottom = placeOrb(rest.anchor, work, true, "bottom");
  assert.ok(bottom.tab.y >= bottom.panel.y + bottom.panel.height,
    "the bottom handle cannot intercept chat clicks");
});

const step = (h, now, changes = {}) => h.step({ now, inside: true, trigger: true, expanded: false, pinned: false, held: false, ...changes });
test("native hover opens only after dwell and closes only after a real delayed departure", () => {
  const h = new OrbHover();
  assert.equal(step(h, 0), null);
  assert.equal(step(h, REVEAL_MS - 1), null);
  assert.equal(step(h, REVEAL_MS), "open");
  assert.equal(step(h, 500, { expanded: true }), null);
  const outside = { inside: false, trigger: false, expanded: true };
  assert.equal(step(h, 1000, outside), null);
  assert.equal(step(h, 1000 + RETRACT_MS - 1, outside), null);
  assert.equal(step(h, 1700, { expanded: true }), null, "returning during grace cancels close");
  assert.equal(step(h, 2000, outside), null);
  assert.equal(step(h, 2000 + RETRACT_MS, outside), "close");
});

test("manual close/drop can't bounce open; brief leave/resize cannot rearm", () => {
  const h = new OrbHover(); h.reset(true);
  assert.equal(step(h, 0), null); assert.equal(step(h, 3000), null);
  const outside = { inside: false, trigger: false };
  step(h, 3100, outside); step(h, 3200);
  assert.equal(step(h, 4000), null);
  step(h, 4100, outside); step(h, 4100 + REARM_MS, outside);
  step(h, 4400); assert.equal(step(h, 4400 + REVEAL_MS), "open");
});

test("pin, file/menu interaction and drag suppress auto-hide without leaking a close timer", () => {
  for (const reason of [{ pinned: true }, { held: true }]) {
    const h = new OrbHover(), outside = { inside: false, trigger: false, expanded: true };
    step(h, 0, outside);
    assert.equal(step(h, 2000, { ...outside, ...reason }), null);
    assert.equal(step(h, 8000, { ...outside, ...reason }), null);
    assert.equal(step(h, 9000, outside), null);
    assert.equal(step(h, 9000 + RETRACT_MS, outside), "close");
  }
  const h = new OrbHover(); step(h, 0);
  assert.equal(step(h, 2000, { held: true }), null);
  assert.equal(step(h, 2100), null); assert.equal(step(h, 2100 + REVEAL_MS), "open");
});
