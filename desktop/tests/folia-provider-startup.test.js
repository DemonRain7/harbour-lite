"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");

// The actual hosted entry with synthetic provider functions: no online requests.
const source = fs.readFileSync(path.resolve(__dirname, "../../vendor/folia/electron/main.cjs"), "utf8");
test("provider imports stay off the desktop main thread and start after player load", () => {
  assert.doesNotMatch(source, /require\('@neteasecloudmusicapienhanced/);
  assert.match(source, /require\('\.\/providerWorkerHost\.cjs'\)/);
  const startup = source.slice(source.indexOf("const hostedReady ="), source.indexOf("const hostedReady =") + 9500);
  assert.ok(startup.indexOf("createWindow({ showImmediately:") < startup.indexOf("void startQqApi()"));
  assert.match(startup, /once\('did-finish-load'/); assert.doesNotMatch(startup, /await startQqApi\(/);
  assert.match(source, /clearTimeout\(providerStartupTimer\)/);
});
test("disposing during QQ provider startup closes the late server and never publishes running", async () => {
  let resolveStart, closes = 0; const states = [];
  const context = { hostedDisposed: false, qqApiHandle: null, path, app: { getPath: () => "fixture" }, qqAuthSessionRepository: {},
    updateQqApiStatus: s => states.push(s), getFreePort: async () => 1234,
    host: { dataDir: 'fixture' },
    startProviderWorker: () => ({ ready: new Promise(r => resolveStart = r), close: async () => { closes++; } }),
    console: { log() {}, error() {}, warn() {} },
    isQqApiModuleNotFound: () => false, serializeError: e => e.message };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf("async function startQqApiRuntime()"), source.indexOf("function isElectronDevRuntime()")), context);
  const running = context.startQqApiRuntime(); await new Promise(r => setImmediate(r));
  context.hostedDisposed = true; resolveStart({ port: 1234 }); await running;
  assert.equal(closes, 1); assert.equal(context.qqApiHandle, null); assert.equal(states.some(s => s.status === "running"), false);
  await context.startQqApiRuntime(); assert.equal(states.length, 1);
});
test("early QQ port reads await one shared startup; late/offline reads do not start anything", async () => {
  let resolveStart, starts = 0, portReader;
  const context = { host: { offline: false }, hostedDisposed: false, qqApiStartPromise: null, qqApiStatus: { status: "starting", port: null },
    startQqApiRuntime: () => { starts++; return new Promise(r => resolveStart = r); },
    ipcMain: { handle: (_channel, handler) => { portReader = handler; } } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf("function startQqApi()"), source.indexOf("// Runs @yakult")), context);
  vm.runInContext(source.slice(source.indexOf("ipcMain.handle('get-qq-port'"), source.indexOf("ipcMain.handle('get-qq-api-status'")), context);
  let settled = false;
  const port = portReader().then(v => { settled = true; return v; });
  const duplicate = context.startQqApi(); await new Promise(r => setImmediate(r));
  assert.equal(starts, 1); assert.equal(settled, false);
  context.qqApiStatus = { status: "running", port: 32100 }; resolveStart();
  assert.equal(await port, 32100); await duplicate; await context.startQqApi(); assert.equal(starts, 1);
  context.host.offline = true; context.qqApiStatus = { status: "starting", port: null };
  assert.equal(await portReader(), null); assert.equal(starts, 1);
});
