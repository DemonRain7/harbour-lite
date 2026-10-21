const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Execute the real adapter entry, replacing only its two external graphics imports. This
// exercises create() and the manifest boundary; testing the profile JSON alone missed the
// flat-actions merge regression because DEFAULT_ACTIONS used the same procedural names.
const source = fs.readFileSync(path.join(__dirname, "../companion/live2d-adapter-entry.js"), "utf8")
  .replace(/^import .*;\r?\n/gm, "");
const flush = () => new Promise(setImmediate);

async function fixture(options = {}) {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const hooks = new Map();
  const parameters = new Map();
  const calls = [];
  let application;
  let releaseExpression = null;
  const model = {
    anchor: { set() {} }, scale: { set() {} }, position: { set() {} },
    getLocalBounds: () => ({ x: 0, y: 0, width: 150, height: 188 }),
    getBounds: () => ({ x: 0, y: 0, width: 150, height: 188 }),
    internalModel: {
      coreModel: {
        setParameterValueById: (id, value) => parameters.set(id, value),
        addParameterValueById: (id, value) => parameters.set(id, (parameters.get(id) || 0) + value),
        getParameterValueById: (id) => parameters.get(id) || 0,
      },
      focusController: { focus() {} },
      on: (event, callback) => hooks.set(event, callback),
      off: (event) => hooks.delete(event),
    },
    async motion(group, index) { calls.push(["motion", group, index]); },
    async expression(name) {
      calls.push(["expression", name]);
      if (name === options.delayedExpression) await new Promise((resolve) => { releaseExpression = resolve; });
    },
    hitTest: () => [], focus() {}, destroy() { calls.push(["destroy"]); },
  };
  const window = {
    devicePixelRatio: 1,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
  };
  const sandbox = {
    window, console, performance: { now: () => now },
    clearTimeout: (id) => timers.delete(id),
    fetch: async () => ({ ok: true, json: async () => ({ FileReferences: { Motions: {
      Gesture: [{ Name: "wave", File: "wave.motion3.json" }],
    } } }) }),
    Live2DModel: { from: async () => model },
    PIXI: { Application: class {
      constructor() {
        application = this;
        this.ticker = { maxFPS: 0, started: true, stop() { this.started = false; }, start() { this.started = true; } };
        this.stage = { addChild() {} };
        this.renderer = { resize() {} };
      }
      render() {} destroy() { this.ticker.stop(); }
    } },
  };
  vm.runInNewContext(source, sandbox);
  const adapter = await window.HarbourCubismAdapter.create({
    canvas: { clientWidth: 150, clientHeight: 188, getBoundingClientRect: () => ({ left: 0, top: 0, width: 150, height: 188 }) },
    modelUrl: "https://fixture.test/model.json",
    actions: options.actions || {}, interactions: options.interactions || {},
  });
  return {
    adapter, calls, timers, application,
    releaseExpression: () => releaseExpression?.(),
    frame(elapsed) {
      now += elapsed;
      parameters.clear();
      parameters.set("ParamEyeLOpen", 1); parameters.set("ParamEyeROpen", 1);
      hooks.get("beforeModelUpdate")?.();
      return adapter.diagnostics();
    },
    async fireTimer(id = timers.keys().next().value) {
      const timer = timers.get(id); timers.delete(id); await timer?.callback();
    },
  };
}

test("create consumes the flat action map, including native expressions and profile-only actions", async () => {
  const f = await fixture({ actions: {
    idle: { expression: "neutral", procedural: "idle" },
    study: { expression: "reading", procedural: "study" },
    customGreeting: { motion: ["Gesture", "wave"], expression: "smile", procedural: "greet" },
  } });
  await f.adapter.setState("idle");
  await f.adapter.setState("working", { action: "study", mood: "focused" });
  assert.ok(f.calls.some(([kind, name]) => kind === "expression" && name === "neutral"));
  assert.ok(f.calls.some(([kind, name]) => kind === "expression" && name === "reading"));
  assert.equal(f.adapter.diagnostics().gesture, "study");
  await f.adapter.setState("incoming", { action: "customGreeting" });
  assert.ok(f.calls.some(([kind, group, index]) => kind === "motion" && group === "Gesture" && index === 0));
  assert.ok(f.calls.some(([kind, name]) => kind === "expression" && name === "smile"));
  f.adapter.destroy();
});

test("specific state precedes mood; equivalent telemetry preserves the motion phase", async () => {
  const f = await fixture({ actions: { thinking: { expression: "thoughtful", procedural: "thinking" } } });
  await f.adapter.setState("thinking", { mood: "focused" });
  assert.equal(f.adapter.diagnostics().gesture, "thinking");
  const first = f.frame(2000).proceduralOffsets;
  await f.adapter.setState("thinking", { mood: "curious" });
  const after = f.frame(0).proceduralOffsets;
  assert.equal(after.eyeX, first.eyeX, "a mood-only update must not restart the thinking glance");
  assert.equal(f.calls.filter(([kind]) => kind === "expression").length, 1);
  await f.adapter.setState("working", { action: "scry", mood: "focused" });
  assert.equal(f.adapter.diagnostics().gesture, "scry");
  await f.adapter.setState("unknown", { mood: "shy" });
  assert.equal(f.adapter.diagnostics().gesture, "shy", "mood remains a fallback for unknown states");
  f.adapter.destroy();
});

test("drag release resets immediately instead of blending a stale movement pose", async () => {
  const f = await fixture();
  await f.adapter.setState("dragging", { action: "dragging" });
  assert.ok(Math.abs(f.frame(450).proceduralOffsets.angleZ) > .1);
  await f.adapter.resetPose();
  await f.adapter.setState("idle", { action: "idle" });
  const result = f.frame(120);
  for (const axis of ["angleX", "angleY", "angleZ", "bodyX", "bodyY"]) {
    assert.equal(result.proceduralOffsets[axis] || 0, 0, `${axis} must be clear on native drag release`);
  }
  f.adapter.destroy();
});

test("activities render distinct bounded poses, preserve speech lips, and keep tap cadence", async () => {
  const f = await fixture();
  const poses = {};
  for (const [state, action] of [["working", "study"], ["thinking", "think"], ["working", "scry"],
    ["working", "verify"], ["waiting", "question"], ["complete", "celebrate"], ["failed", "worry"], ["listening", "listening"]]) {
    await f.adapter.setState(state, { action });
    f.frame(2500);
    const result = f.frame(250);
    poses[action] = result.proceduralOffsets;
    for (const axis of ["angleX", "angleY", "angleZ"]) assert.ok(Math.abs(result.proceduralOffsets[axis] || 0) <= 2.6);
    assert.equal(result.rendering.maxFPS, 30);
  }
  assert.ok(poses.study.eyeY < -.25 && poses.think.eyeY > .2, "reading looks down; thinking looks up");
  assert.ok(poses.scry.eyeX < -.3, "search looks decisively to the side");
  assert.ok(poses.question.browLY > .15, "waiting raises the brows toward the user");
  assert.ok(poses.celebrate.mouthForm > .3 && poses.worry.mouthForm < -.3, "terminal states retain distinct expressions");
  f.adapter.setMouthOpen(.65);
  assert.equal(f.frame(30).face.mouthOpen, .65);
  await f.adapter.interact();
  const wink = f.frame(210);
  assert.equal(wink.gesture, "tap");
  assert.equal(wink.face.eyeLOpen, 0);
  assert.equal(wink.face.eyeROpen, 1);
  assert.equal(wink.proceduralOffsets.angleY, undefined, "tap still avoids the fragile neck deformer");
  await f.adapter.setState("working", { action: "scribe" });
  assert.equal(f.adapter.diagnostics().gesture, "tap", "task events do not swallow a user reaction");
  await f.fireTimer();
  await flush();
  assert.equal(f.adapter.diagnostics().gesture, "scribe", "interaction restores the newest task");
  f.adapter.destroy();
});

test("idle scheduling pauses without leaks and cannot resurrect after destruction during a fetch", async () => {
  const f = await fixture({ actions: { idleVariation: { expression: "slow", procedural: "happy" } },
    interactions: { idleActions: ["idleVariation"] }, delayedExpression: "slow" });
  assert.equal(f.timers.size, 1);
  f.adapter.pause();
  assert.equal(f.timers.size, 0);
  assert.equal(f.application.ticker.started, false);
  f.adapter.resume();
  assert.equal(f.timers.size, 1);
  const pending = f.fireTimer();
  await flush();
  assert.ok(f.calls.some(([kind, name]) => kind === "expression" && name === "slow"));
  f.adapter.destroy();
  f.releaseExpression();
  await pending;
  assert.equal(f.timers.size, 0, "awaited idle work must not create a post-destroy timer");
  f.adapter.resume();
  await f.adapter.setState("working");
  assert.equal(f.application.ticker.started, false);
});

test("a destroyed adapter cannot issue a queued expression after awaiting an older request", async () => {
  const f = await fixture({ actions: { first: { expression: "slow", procedural: "study" },
    next: { expression: "must-not-run", procedural: "scry" } }, delayedExpression: "slow" });
  const first = f.adapter.setState("working", { action: "first" });
  await flush();
  const next = f.adapter.setState("working", { action: "next" });
  f.adapter.destroy(); f.releaseExpression();
  await Promise.all([first, next]);
  assert.equal(f.calls.some(([kind, name]) => kind === "expression" && name === "must-not-run"), false);
});

test("finite idle cup/glance actions restore neutral and never displace real task states", async () => {
  for (const name of ["drinkTea", "lookAround"]) {
    const f = await fixture({ actions: { idle: { expression: "neutral", procedural: "idle" },
      [name]: { expression: "idle-prop", procedural: name } }, interactions: { idleActions: [name] } });
    await f.adapter.setState("idle");
    await f.fireTimer();
    assert.equal(f.adapter.diagnostics().gesture, name);
    assert.equal(f.adapter.diagnostics().expression.applied, "idle-prop");
    f.frame(4000);
    await flush();
    assert.equal(f.adapter.diagnostics().gesture, "idle");
    assert.equal(f.adapter.diagnostics().expression.applied, "neutral");
    for (const state of ["working", "waiting", "speaking"]) {
      await f.adapter.setState(state);
      const before = f.adapter.diagnostics().gesture;
      await f.fireTimer();
      assert.equal(f.adapter.diagnostics().gesture, before);
    }
    f.adapter.destroy();
  }
});
