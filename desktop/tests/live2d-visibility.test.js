const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function fixture({ hidden = false, delayed = false } = {}) {
  const listeners = new Set();
  const calls = [];
  const adapter = { pause: () => calls.push("pause"), resume: () => calls.push("resume"), destroy: () => calls.push("destroy") };
  let resolve;
  const pending = delayed ? new Promise(done => { resolve = done; }) : Promise.resolve(adapter);
  const document = { hidden, scripts: [{ src: "https://fixture.test/core.js", dataset: { loaded: "true" } }],
    addEventListener: (type, fn) => { assert.equal(type, "visibilitychange"); listeners.add(fn); },
    removeEventListener: (type, fn) => { assert.equal(type, "visibilitychange"); listeners.delete(fn); } };
  const window = { Live2DCubismCore: {}, HarbourCubismAdapter: { create: () => pending } };
  let visualActive = true;
  const visualListeners = new Set();
  window.HarbourVisualActivity = { isActive: () => visualActive,
    subscribe: fn => { visualListeners.add(fn); return () => visualListeners.delete(fn); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../web/live2d-host.js"), "utf8"), { window, document, URL });
  const hostPromise = window.HarbourLive2D.createHost({ canvas: {}, assetBase: "https://fixture.test/",
    manifest: { visual: { live2d: { enabled: true, runtime: "core.js", model: "model.json" } } } });
  return { hostPromise, calls, listeners, visualListeners, finish: () => resolve?.(adapter),
    quiet(value) { visualActive = !value; for (const fn of visualListeners) fn(visualActive); },
    hide(value) { document.hidden = value; for (const fn of listeners) fn(); } };
}

test("visible/hidden/resume pauses graphics only and respects explicit pause", async () => {
  const f = await fixture(); const host = await f.hostPromise;
  assert.equal(host.ready, true); assert.deepEqual(f.calls, ["resume"]);
  f.hide(true); assert.equal(f.calls.at(-1), "pause");
  host.resume(); assert.equal(f.calls.at(-1), "pause", "manual resume cannot animate a hidden model");
  f.hide(false); assert.equal(f.calls.at(-1), "resume");
  host.pause(); f.hide(true); f.hide(false);
  assert.equal(f.calls.at(-1), "pause", "visibility cannot undo manual pause");
  host.resume(); assert.equal(f.calls.at(-1), "resume");
  host.destroy(); const count = f.calls.length;
  assert.equal(f.listeners.size, 0);
  f.hide(true); f.hide(false); host.resume();
  assert.equal(f.calls.length, count, "destroyed host cannot restart");
});

test("game quiet stops the visible Live2D ticker and restores exactly once without reloading", async () => {
  const f = await fixture(); const host = await f.hostPromise;
  f.quiet(true); f.quiet(true); host.resume();
  assert.deepEqual(f.calls, ["resume", "pause"]);
  f.quiet(false); f.quiet(false); host.resume();
  assert.deepEqual(f.calls, ["resume", "pause", "resume"]);
  host.destroy(); assert.equal(f.visualListeners.size, 0);
});

test("a model finishing its asynchronous load while hidden starts paused", async () => {
  const f = await fixture({ delayed: true });
  f.hide(true); f.finish(); const host = await f.hostPromise;
  assert.deepEqual(f.calls, ["pause"]);
  f.hide(false); assert.equal(f.calls.at(-1), "resume"); host.destroy();
});

test("native pet window allows visibility events, unlike the audio-only player", () => {
  const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const pet = source.slice(source.indexOf("async function createPetWindow("), source.indexOf("// Electron 的 width/height"));
  assert.match(pet, /backgroundThrottling: true/);
});
