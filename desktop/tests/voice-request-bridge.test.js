const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createVoiceRequestBridge, LIMITS } = require("../companion/voice-request-bridge");

async function fixture(t, handler, limits) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const expectedUrl = "file:///fixture/voice-call.html";
  const sender = { mainFrame: { url: expectedUrl }, isDestroyed: () => false, getURL: () => expectedUrl };
  const window = { webContents: sender, isDestroyed: () => false };
  const config = { url: `http://127.0.0.1:${server.address().port}`, token: "fixture-secret-not-for-renderer" };
  const bridge = createVoiceRequestBridge({ getWindow: () => window, getConfig: () => config, expectedUrl, limits });
  const event = { sender, senderFrame: sender.mainFrame };
  t.after(async () => { bridge.close(sender); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { bridge, event, sender, window, config, expectedUrl };
}
const json = (res, value) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
const input = (pathname, body = {}) => ({ pathname, body: JSON.stringify(body) });

test("voice choices use the same exact owned frame boundary and cancel on close", async () => {
  const expectedUrl = "file:///voice-call.html", calls = [];
  const sender = { mainFrame: { url: expectedUrl }, isDestroyed: () => false, getURL: () => expectedUrl };
  const win = { webContents: sender, isDestroyed: () => false };
  const bridge = createVoiceRequestBridge({ getWindow: () => win, expectedUrl, voiceChoice: input => { calls.push(input); return true; } });
  const event = { sender, senderFrame: sender.mainFrame };
  assert.equal(await bridge.choice(event, { action: "list" }), true);
  assert.throws(() => bridge.choice({ ...event, senderFrame: { url: expectedUrl } }, { action: "list" }), /主窗口/);
  sender.mainFrame.url = "https://evil.invalid";
  assert.throws(() => bridge.choice(event, { action: "preview" }), /主窗口/);
  assert.equal(calls.length, 1); bridge.close(sender); assert.equal(calls[1].action, "cancel");
});

test("exact owned call main frame and fixed POST targets; token remains only in transport", async t => {
  const calls = [];
  const f = await fixture(t, (req, res) => {
    let body = ""; req.on("data", chunk => { body += chunk; });
    req.on("end", () => { calls.push({ url: req.url, method: req.method, headers: req.headers, body });
      json(res, { ok: true, nested: { echo: req.headers.authorization } }); });
  });
  const response = await f.bridge.request(f.event, input("/api/upload", { dataBase64: "fixture" }));
  assert.equal(response.ok, true); assert.equal(response.nested.echo, "Bearer [redacted]");
  assert.equal(calls[0].method, "POST"); assert.equal(calls[0].headers.authorization, `Bearer ${f.config.token}`);
  assert.equal(calls[0].headers.origin, undefined); assert.equal(calls[0].url, "/api/upload");
  assert.equal(calls[0].body, '{"dataBase64":"fixture"}');
  assert.equal(JSON.stringify(response).includes(f.config.token), false);
  await f.bridge.request(f.event, input("/api/stt/transcribe"));
  const count = calls.length;
  for (const event of [ { ...f.event, senderFrame: { url: f.expectedUrl } },
    { ...f.event, sender: { ...f.sender } }, { ...f.event, senderFrame: undefined } ]) {
    await assert.rejects(f.bridge.request(event, input("/api/run")), /主窗口/);
  }
  f.sender.mainFrame.url = "https://evil.invalid/";
  await assert.rejects(f.bridge.request(f.event, input("/api/upload")), /主窗口/);
  f.sender.mainFrame.url = f.expectedUrl;
  f.sender.getURL = () => f.expectedUrl + "?changed";
  await assert.rejects(f.bridge.request(f.event, input("/api/upload")), /主窗口/);
  f.sender.getURL = () => f.expectedUrl;
  for (const pathname of ["https://evil.invalid/api/run", "//evil.invalid/api/upload", "/api/calendar/events",
    "/api/upload?x=1", "/api/../api/run", "/api/run/", "/api/runs/call-a-b%2f/abort"]) {
    await assert.rejects(f.bridge.request(f.event, input(pathname)), /接口/);
  }
  await assert.rejects(f.bridge.request(f.event, { ...input("/api/upload"), method: "GET" }), /参数/);
  await assert.rejects(f.bridge.request(f.event, { ...input("/api/upload"), headers: { Authorization: "override" } }), /参数/);
  await assert.rejects(f.bridge.request(f.event, input("/api/runs/call-a-b/abort")), /此语音窗口/);
  assert.equal(calls.length, count);
});

test("body and response bounds, JSON validation and redirects fail without retries", async t => {
  let calls = 0;
  const f = await fixture(t, (req, res) => {
    calls++;
    if (req.url === "/api/upload") { res.writeHead(302, { Location: f.config.url + "/api/run" }); res.end(); }
    else res.end('"' + "x".repeat(200) + '"');
  }, { uploadBytes: 200, bodyBytes: 80, responseBytes: 100 });
  await assert.rejects(f.bridge.request(f.event, input("/api/stt/transcribe", { x: "x".repeat(90) })), /请求体超过/);
  await assert.rejects(f.bridge.request(f.event, { pathname: "/api/upload", body: "invalid" }), /JSON/);
  await assert.rejects(f.bridge.request(f.event, { pathname: "/api/upload", body: "null" }), /对象/);
  assert.equal(calls, 0);
  await assert.rejects(f.bridge.request(f.event, input("/api/upload")), /HTTP 302/);
  assert.equal(calls, 1, "redirect was never followed");
  await assert.rejects(f.bridge.request(f.event, input("/api/stt/transcribe")), /响应超过/);
  assert.equal(calls, 2, "failed operations are never retried");
  f.config.url = "file:///bad";
  await assert.rejects(f.bridge.request(f.event, input("/api/upload")), /地址/);
  f.config.url = "http://user:secret@127.0.0.1/";
  await assert.rejects(f.bridge.request(f.event, input("/api/upload")), /地址/);
  assert.equal(LIMITS.uploadBytes > 25 * 1024 * 1024 * 4 / 3, true);
});

test("only the in-flight owned run can be stopped; closing cancels sockets without replay", async t => {
  let runResponse, sawRun;
  const started = new Promise(resolve => { sawRun = resolve; });
  const calls = [];
  const f = await fixture(t, (req, res) => {
    calls.push(req.url);
    if (req.url === "/api/run") { runResponse = res; sawRun(); }
    else { json(res, { aborted: true }); runResponse.writeHead(499); runResponse.end("{}"); }
  });
  const running = f.bridge.request(f.event, input("/api/run", { runId: "call-ab-cd" }));
  const rejected = assert.rejects(running, /HTTP 499/);
  await started;
  await assert.rejects(f.bridge.request(f.event, input("/api/run", { runId: "call-ef-gh" })), /已有运行/);
  await assert.rejects(f.bridge.request(f.event, input("/api/runs/call-ef-gh/abort")), /此语音窗口/);
  assert.deepEqual(await f.bridge.request(f.event, input("/api/runs/call-ab-cd/abort")), { aborted: true });
  await rejected;
  assert.deepEqual(calls, ["/api/run", "/api/runs/call-ab-cd/abort"]);
  const next = f.bridge.request(f.event, input("/api/run", { runId: "call-ef-gh" }));
  const stopped = assert.rejects(next, /已停止/);
  f.bridge.close(f.sender);
  await stopped;
  await assert.rejects(f.bridge.request(f.event, input("/api/runs/call-ef-gh/abort")), /此语音窗口/);
});

test("absolute deadline bounds stalled responses and does not retry", async t => {
  let calls = 0;
  const f = await fixture(t, () => { calls++; }, { timeoutMs: 50 });
  await assert.rejects(f.bridge.request(f.event, input("/api/stt/transcribe")), /超时/);
  assert.equal(calls, 1);
});

test("renderer upload/STT/run and stop fallback use only the bounded bridge", async () => {
  const elements = new Map(), windowListeners = {}, calls = [];
  const node = () => ({ textContent: "", hidden: false, value: "main-elaina", listeners: {},
    append() {}, appendChild() {}, remove() {}, setAttribute() {}, querySelector: () => ({ textContent: "", remove() {} }),
    addEventListener(name, callback) { this.listeners[name] = callback; } });
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); },
    createElement: node, body: { classList: { toggle() {} } } };
  let recorder, rejectRun, resolveStarted, cancelled = 0, stoppedTracks = 0;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  class Recorder {
    constructor() { recorder = this; this.mimeType = "audio/webm"; }
    start() {}
    stop() { this.done = this.onstop(); }
  }
  const desktop = {
    voiceRequest(pathname, body) {
      calls.push({ pathname, body: JSON.parse(body) });
      if (pathname === "/api/upload") return Promise.resolve({ attachment: { url: "/uploads/fixture.webm", kind: "audio" } });
      if (pathname === "/api/stt/transcribe") return Promise.resolve({ text: "fixture transcript", provider: "fixture" });
      if (pathname === "/api/run") { resolveStarted(); return new Promise((_resolve, reject) => { rejectRun = reject; }); }
      return Promise.reject(new Error("abort route unavailable"));
    },
    cancelVoiceRequests() { cancelled++; rejectRun?.(new Error("cancelled")); },
    getCompanionState: () => Promise.resolve({ connection: "open" }),
  };
  class Reader { readAsDataURL() { this.result = "data:audio/webm;base64,ZmFrZQ=="; this.onload(); } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../renderer/voice-call.js"), "utf8"), {
    document, window: { harbourDesktop: desktop, HarbourVoicePicker: class { sync() {} destroy() {} }, addEventListener: (name, fn) => { windowListeners[name] = fn; } },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { stoppedTracks++; } }] }) } },
    MediaRecorder: Recorder, FileReader: Reader, Blob, Date, Math, Promise,
  });
  await elements.get("record").listeners.click();
  await elements.get("record").listeners.click();
  await new Promise(setImmediate);
  assert.equal(calls.length, 3, elements.get("status").textContent);
  await started;
  assert.deepEqual(calls.map(call => call.pathname), ["/api/upload", "/api/stt/transcribe", "/api/run"]);
  assert.equal(calls[2].body.input, "fixture transcript");
  assert.equal(calls[2].body.session.key, "electron:call:main-elaina");
  assert.equal(stoppedTracks, 1);
  await elements.get("stop").listeners.click();
  await recorder.done;
  assert.equal(calls[3].pathname, `/api/runs/${calls[2].body.runId}/abort`);
  assert.equal(cancelled, 1, "failed abort route closes the original request rather than replaying it");
  assert.equal(calls.filter(call => call.pathname === "/api/run").length, 1);
  assert.match(elements.get("status").textContent, /已请求停止/);
  windowListeners.beforeunload();
  assert.equal(cancelled, 2, "closing also cancels upload/STT requests when no run is active");
});

test("preload exposes the bridge only to call main frame; renderer has no fetch/token path", () => {
  const source = fs.readFileSync(path.join(__dirname, "../preload.js"), "utf8");
  const values = (surface, isMainFrame) => {
    let exposed;
    const ipc = { on() {}, send() {}, invoke: (...args) => Promise.resolve(args) };
    vm.runInNewContext(source, { require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_key, value) => { exposed = value; } } }),
      process: { argv: [`--harbour-surface=${surface}`], isMainFrame }, window: { addEventListener() {} }, localStorage: { getItem() {}, setItem() {} } });
    return exposed;
  };
  assert.equal(typeof values("call", true).voiceRequest, "function");
  assert.equal(typeof values("call", true).cancelVoiceRequests, "function");
  assert.equal(values("dashboard", true).voiceRequest, undefined);
  assert.equal(values("call", false).voiceRequest, undefined);
  const renderer = fs.readFileSync(path.join(__dirname, "../renderer/voice-call.js"), "utf8");
  assert.doesNotMatch(renderer, /\bfetch\(|localStorage|authorization|serverUrl/);
  assert.match(renderer, /desktop\.voiceRequest\(pathname/);
  assert.match(renderer, /desktop\.cancelVoiceRequests/);
  assert.match(renderer, /\/api\/runs\/\$\{encodeURIComponent\(runId\)\}\/abort/);
});
