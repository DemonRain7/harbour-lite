"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs"), path = require("node:path");
const { createServiceActions, wireManagedServiceRestart } = require("../companion/service-actions");

function fixture(overrides = {}) {
  const messages = [], states = [];
  let time = 0;
  const app = new EventEmitter(); app.relaunch = () => messages.push("relaunch");
  const actions = createServiceActions({ app, confirm: async () => true, quitGuard: { requestQuit: async () => false },
    onState: state => states.push(state), notify: (kind, text) => messages.push({ kind, text }),
    now: () => time, sleep: async ms => { time += ms; }, timeoutMs: 1500, ...overrides });
  return { actions, messages, states, app };
}
test("backend restart waits for a different ready instance, not old HTTP 200", async () => {
  const requests = []; let reads = 0;
  const f = fixture({ request: async (url, body) => {
    requests.push({ url, body }); if (body) return { accepted: true };
    return ++reads < 3 ? { restartSupported: true, instanceId: "old", phase: "ready" }
      : { restartSupported: true, instanceId: "new", phase: "ready", pid: 42 };
  } });
  const a = f.actions.restartBackend(), b = f.actions.restartBackend(); assert.equal(a, b); await a;
  assert.equal(requests.filter(r => r.body).length, 1);
  assert.equal(reads, 3); assert.equal(f.messages[0].kind, "success");
  assert.deepEqual(f.states, ["restarting", "idle"]);
});
test("uncertain POST is never replayed; explicit HTTP refusal fails immediately", async () => {
  let writes = 0, reads = 0;
  const f = fixture({ request: async (_url, body) => {
    if (body) { writes++; throw new Error("socket closed"); }
    return { restartSupported: true, instanceId: ++reads > 1 ? "new" : "old", phase: "ready" };
  } });
  await f.actions.restartBackend(); assert.equal(writes, 1); assert.equal(f.messages[0].kind, "success");
  const denied = fixture({ request: async (_url, body) => {
    if (body) throw Object.assign(new Error("任务进行中"), { status: 409 });
    return { restartSupported: true, instanceId: "old" };
  } });
  await denied.actions.restartBackend(); assert.match(denied.messages[0].text, /任务进行中/);
});
test("cancellation sends no restart, and unchanged service times out without repeated writes", async () => {
  let writes = 0;
  const request = async (_url, body) => { if (body) writes++; return { restartSupported: true, instanceId: "old", phase: "ready" }; };
  const cancelled = fixture({ request, confirm: async () => false }); await cancelled.actions.restartBackend(); assert.equal(writes, 0);
  const stale = fixture({ request }); await stale.actions.restartBackend(); assert.equal(writes, 1);
  assert.match(stale.messages[0].text, /未能确认/); assert.equal(stale.messages[0].kind, "error");
});

test("old backend and external supervisor give actionable messages without a POST", async () => {
  for (const result of [Object.assign(new Error("Unknown API"), { status: 404 }), { restartSupported: false, restartReason: "请使用原 systemd 服务管理器" }]) {
    const f = fixture({ request: async (_url, body) => {
      assert.equal(body, undefined);
      if (result instanceof Error) throw result;
      return result;
    } });
    await f.actions.restartBackend();
    assert.match(f.messages[0].text, /旧版后端|systemd/);
  }
});
test("client relaunch only occurs at committed quit; cancelled draft leaves no future relaunch", async () => {
  const cancelled = fixture(); await cancelled.actions.restartClient(); cancelled.app.emit("will-quit"); assert.deepEqual(cancelled.messages, []);
  const f = fixture();
  const actions = createServiceActions({ app: f.app, confirm: async () => true, request() {}, onState() {}, notify() {},
    quitGuard: { requestQuit: async () => { f.app.emit("will-quit"); return true; } } });
  await actions.restartClient(); assert.deepEqual(f.messages, ["relaunch"]);
});
test("managed service restarts only after matching commit and successful owned child exit", () => {
  const child = new EventEmitter(), replies = []; child.connected = true; child.send = m => replies.push(m);
  let restarted = 0;
  wireManagedServiceRestart(child, { isCurrent: () => true, isQuitting: () => false, onRestart: () => restarted++ });
  child.emit("message", { type: "harbour:restart-prepare", nonce: "one" });
  child.emit("message", { type: "harbour:restart-commit", nonce: "wrong" });
  assert.equal(replies.length, 1); assert.equal(restarted, 0);
  child.emit("message", { type: "harbour:restart-commit", nonce: "one" });
  child.emit("exit", 0); assert.equal(restarted, 1);
  for (const mode of ["cancel", "quit", "stale", "crash"]) {
    const c = new EventEmitter(); c.connected = true; c.send = () => {};
    wireManagedServiceRestart(c, { isCurrent: () => mode !== "stale", isQuitting: () => mode === "quit", onRestart: () => assert.fail(mode) });
    c.emit("message", { type: "harbour:restart-prepare", nonce: "one" });
    c.emit("message", { type: "harbour:restart-commit", nonce: "one" });
    if (mode === "cancel") c.emit("message", { type: "harbour:restart-cancel", nonce: "one" });
    c.emit("exit", mode === "crash" ? 1 : 0);
  }
});
test("tray exposes separate backend/client actions and source startup bypasses stale dist", () => {
  const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  assert.match(source, /label:.*重启后端服务/); assert.match(source, /label:.*重启 Harbour 客户端/);
  assert.match(source, /serviceActions\.restartBackend\(\)/); assert.match(source, /serviceActions\.restartClient\(\)/);
  assert.ok(source.indexOf('if (fs.existsSync(path.join(cwd, "src", "index.ts")))') < source.indexOf('else if (fs.existsSync(builtEntry))'));
});
