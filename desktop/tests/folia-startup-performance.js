"use strict";
// Isolated cold/warm startup: real provider packages with offline registration, no owner account.
const { app, protocol } = require("electron");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Worker } = require('node:worker_threads');
const { performance, monitorEventLoopDelay } = require("node:perf_hooks");
const assert = require("node:assert/strict");
const { FoliaController } = require("../folia/controller");
const { SCHEMES } = require("../folia/host");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-folia-startup-"));
const providers = process.argv.includes('--providers');
const legacy = process.argv.includes('--legacy-providers');
const imports = [];
if (process.argv.includes('--profile')) {
  const Module = require('node:module'), original = Module._load;
  Module._load = function (id, ...args) {
    const start = performance.now();
    try { return original.call(this, id, ...args); }
    finally { const ms = performance.now() - start; if (ms > 10) imports.push({ id, ms: Math.round(ms) }); }
  };
}
// Never let an upstream dotenv import see Harbour credentials.
process.chdir(dir);
app.setPath("userData", dir); protocol.registerSchemesAsPrivileged(SCHEMES);
app.on("window-all-closed", () => {});
const net = require('node:net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof options === 'object' ? options.host : typeof args[1] === 'string' ? args[1] : '';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Startup test forbids outbound sockets');
  return connect.apply(this, args);
};
if (providers) {
  const providerHost = require('../../vendor/folia/electron/providerWorkerHost.cjs');
  const start = providerHost.startProviderWorker;
  class OfflineWorker extends Worker {
    constructor(entry, options) {
      super(path.join(__dirname, 'fixtures/folia-provider-offline.cjs'), {
        ...options, workerData: { ...options.workerData, entry },
      });
    }
  }
  providerHost.startProviderWorker = options => start({ ...options, WorkerClass: OfflineWorker });
  if (legacy) {
    // Reproduce the old import-on-desktop-thread path in a separate test process for comparison.
    const { createRequire } = require('node:module');
    const load = createRequire(path.resolve(__dirname, '../../vendor/folia/package.json'));
    load('dotenv').config = () => ({ parsed: {} });
    const startup = load('./electron/neteaseApiStartup.cjs');
    startup.resolveXeapiPublicKey = async () => ({ publicKey: { sk: 'fixture' }, refreshed: false });
    startup.refreshAnonymousToken = async () => true;
    process.env.TMP = process.env.TEMP = process.env.TMPDIR = dir;
    providerHost.startProviderWorker = options => {
      let handle;
      const ready = (async () => {
        if (options.provider === 'netease') handle = await load('./electron/neteaseRuntime.cjs')
          .startNeteaseRuntime({ port: options.port, shouldStop: () => false });
        else if (options.provider === 'qq') handle = await load('./electron/qqApiStartup.cjs').startQqApi({ hosted: true, port: options.port,
          stateFilePath: path.join(dir, 'qq-device.json'), authSessionRepository: options.authSessionRepository });
        else { const api = load('kugoumusicapi'); handle = { close() {}, request: (operation, params) => api[operation](params) }; }
        return { port: options.port };
      })();
      return { ready, close: async () => { await ready; await handle?.close(); },
        request: async (operation, params) => { await ready; return handle.request(operation, params); } };
    };
  }
}
const deadline = setTimeout(() => app.exit(1), 60000);
app.whenReady().then(async () => {
  const histogram = monitorEventLoopDelay({ resolution: 10 }); histogram.enable();
  await new Promise(resolve => setTimeout(resolve, 30));
  // Chromium network is blocked too; this measures loading/listeners, not live provider access.
  require('electron').session.fromPartition('persist:harbour-folia').webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) });
  });
  const controller = new FoliaController({ dataDir: path.join(dir, "folia"), offline: !providers });
  const start = performance.now(); await controller.ensure();
  const coldMs = performance.now() - start;
  const contents = controller.runtime.getMainWindow().webContents;
  if (providers) {
    const until = Date.now() + 15000;
    let running = false;
    while (!running && Date.now() < until) {
      running = await contents.executeJavaScript(`Promise.all([window.electron.getQqApiStatus(), window.electron.getNeteaseApiStatus()])
        .then(states => states.every(state => state.status === 'running'))`);
      if (!running) await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(running, true, 'both real providers must be included in the measured startup');
  }
  const servicesMs = performance.now() - start;
  const warm = performance.now(); await controller.ensure();
  const warmMs = performance.now() - warm;
  await new Promise(resolve => setTimeout(resolve, 400)); histogram.disable();
  const longTasks = await contents.executeJavaScript(`new Promise(resolve => {
    const tasks = [];
    const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(e => Math.round(e.duration))));
    observer.observe({ type: 'longtask', buffered: true });
    setTimeout(() => { observer.disconnect(); resolve(tasks); }, 50);
  })`);
  const result = { coldMs: Math.round(coldMs), warmMs: Math.round(warmMs),
    servicesMs: Math.round(servicesMs), providerMode: providers ? legacy ? 'legacy-main-thread' : 'worker' : 'disabled',
    mainLoopMaxMs: Math.round(histogram.max / 1e6),
    rendererLongTaskMaxMs: Math.max(0, ...longTasks),
    neteaseModulesLoaded: Object.keys(require.cache).filter(p => p.includes("neteasecloudmusicapienhanced")).length,
    providerModulesLoaded: Object.keys(require.cache).filter(p => /node_modules.*(neteasecloudmusicapienhanced|qq-music-api|kugoumusicapi)/.test(p)).length,
    sameRenderer: controller.runtime.getMainWindow().webContents === contents, online: false };
  console.log("FOLIA_STARTUP " + JSON.stringify(result));
  if (imports.length) console.log('FOLIA_IMPORTS ' + JSON.stringify(imports.sort((a, b) => b.ms - a.ms).slice(0, 15)));
  if (!legacy) assert.equal(result.neteaseModulesLoaded, 0, "player must not load provider packages on the desktop thread");
  if (providers && !legacy) assert.equal(result.providerModulesLoaded, 0, 'all three provider dependency graphs stay off-thread');
  assert.equal(result.sameRenderer, true, "warm open must reuse the player");
  if (providers && !legacy) assert.ok(result.mainLoopMaxMs < 300, 'online startup must not freeze the desktop thread');
  await controller.close(); clearTimeout(deadline); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
