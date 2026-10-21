const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { startProviderWorker } = require('../../vendor/folia/electron/providerWorkerHost.cjs');
const { createProviderAuthBridge } = require('../../vendor/folia/electron/providerAuthBridge.cjs');
const { createKugouWorkerApi } = require('../../vendor/folia/electron/kugouWorkerApi.cjs');

// desktop/tests/folia-provider-worker.test.js
class FakeWorker extends EventEmitter {
  static latest;
  constructor(file, options) { super(); this.options = options; this.messages = []; FakeWorker.latest = this; }
  postMessage(message) { this.messages.push(message); }
  async terminate() { this.terminated = true; this.emit('exit', 1); }
}
const repository = () => ({ load: () => [], save() {} });
const fixture = extra => startProviderWorker({ provider: 'qq', port: 23456, dataDir: 'fixture',
  authSessionRepository: repository(), WorkerClass: FakeWorker, stopTimeoutMs: 10, ...extra });

test('ready waits for a listening receipt, startup receives only its private environment', async () => {
  const before = process.env.NODE_ENV;
  const runtime = fixture(); const worker = FakeWorker.latest;
  let ready = false; runtime.ready.then(() => { ready = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(ready, false);
  worker.emit('message', { type: 'ready', port: 23456 }); assert.equal((await runtime.ready).port, 23456);
  assert.equal(process.env.NODE_ENV, before);
  assert.equal(worker.options.env.QQ_AUTH_SESSION_PATH, '');
  const stop = runtime.close(); worker.emit('message', { type: 'closed' }); await stop;
});
test('close during startup cancels readiness and terminates an unresponsive import', async () => {
  const runtime = fixture(); const worker = FakeWorker.latest;
  const rejected = assert.rejects(runtime.ready, /cancelled/);
  const stop = runtime.close(); assert.equal(runtime.close(), stop);
  worker.emit('message', { type: 'ready', port: 23456 });
  await rejected; await stop; assert.equal(worker.terminated, true);
});
test('startup deadline bounds a stuck service', async () => {
  const runtime = fixture({ startupTimeoutMs: 10 }); const worker = FakeWorker.latest;
  // Keep Node alive while this deliberately unref'ed production deadline is tested.
  const hold = setTimeout(() => {}, 1000);
  await assert.rejects(runtime.ready, /timed out/); await runtime.close(); clearTimeout(hold);
  assert.equal(worker.terminated, true);
});
test('failed imports report missing-package status without leaking third-party error text', async () => {
  const runtime = fixture(); const worker = FakeWorker.latest;
  worker.emit('message', { type: 'failure', code: 'MODULE_NOT_FOUND', message: 'secret-value' });
  await assert.rejects(runtime.ready, error => error.code === 'MODULE_NOT_FOUND' && !error.message.includes('secret'));
  await runtime.close();
});
test('unexpected exit after readiness reports failure, intentional close does not', async () => {
  const failures = []; const runtime = fixture({ onFailure: error => failures.push(error) });
  const worker = FakeWorker.latest;
  worker.emit('message', { type: 'ready', port: 23456 }); await runtime.ready;
  worker.emit('exit', 1); assert.equal(failures.length, 1); await runtime.close();
});
test('QQ session persistence stays in the encrypted host repository with an acknowledged save', async () => {
  let saved;
  const runtime = fixture({ authSessionRepository: { load: () => ['fake-session'], save: value => { saved = value; } } });
  const worker = FakeWorker.latest;
  assert.deepEqual(worker.options.workerData.sessions, ['fake-session']);
  worker.emit('message', { type: 'ready', port: 23456 }); await runtime.ready;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  worker.emit('message', { type: 'auth-save', sessions: ['updated-fake'], signal: signal.buffer });
  assert.equal(Atomics.load(signal, 0), 1); assert.deepEqual(saved, ['updated-fake']);
  await runtime.close();
});
test('locked keychain preserves load/save failure without leaking or claiming persistence', async () => {
  const runtime = fixture({ authSessionRepository: { load() { throw new Error('private'); }, save() { throw new Error('private'); } } });
  const worker = FakeWorker.latest; assert.equal(worker.options.workerData.authLoadFailed, true);
  assert.deepEqual(worker.options.workerData.sessions, []);
  worker.emit('message', { type: 'ready', port: 23456 }); await runtime.ready;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  worker.emit('message', { type: 'auth-save', sessions: ['fake'], signal: signal.buffer });
  assert.equal(Atomics.load(signal, 0), -1); await runtime.close();
});
test('worker repository rejects timeout/failure and returns only after acknowledged saves', () => {
  let ack = 1;
  const bridge = createProviderAuthBridge({ sessions: ['fake'], timeoutMs: 1,
    parentPort: { postMessage(message) { Atomics.store(new Int32Array(message.signal), 0, ack); } } });
  assert.deepEqual(bridge.load(), ['fake']); assert.equal(bridge.save([]), undefined);
  ack = -1; assert.throws(() => bridge.save([]), /save failed/);
  ack = 0; assert.throws(() => bridge.save([]), /save failed/);
  assert.throws(() => createProviderAuthBridge({ authLoadFailed: true }).load(), /unavailable/);
});
test('KuGou availability is cheap; requests share one worker and are never automatically replayed', async () => {
  let starts = 0, requests = 0, closes = 0;
  const host = createKugouWorkerApi({ dataDir: 'fixture', startWorker: () => {
    starts++;
    return { request: async () => { requests++; throw new Error('synthetic failure'); }, close: () => { closes++; } };
  } });
  const api = host.load(); assert.equal(starts, 0);
  assert.equal(api.arbitrary_operation, undefined);
  await assert.rejects(api.search({ keywords: 'fixture' }), /synthetic/);
  await assert.rejects(api.playlist_add({ name: 'fixture' }), /synthetic/);
  assert.equal(starts, 1); assert.equal(requests, 2);
  await host.close(); assert.equal(closes, 1);
  await assert.rejects(api.search({}), /closed/); assert.equal(requests, 2);
  const offline = createKugouWorkerApi({ offline: true, startWorker() { throw new Error('must not start'); } });
  assert.throws(() => offline.load(), /offline/); await offline.close();
});
test('KuGou RPC correlates parallel responses and rejects in-flight operations on close', async () => {
  const runtime = fixture({ provider: 'kugou' }); const worker = FakeWorker.latest;
  worker.emit('message', { type: 'ready' }); await runtime.ready;
  const first = runtime.request('search', { keywords: 'a' });
  const second = runtime.request('search', { keywords: 'b' });
  await new Promise(resolve => setImmediate(resolve));
  worker.emit('message', { type: 'result', id: worker.messages[1].id, ok: true, result: 'b' });
  worker.emit('message', { type: 'result', id: worker.messages[0].id, ok: true, result: 'a' });
  assert.equal(await first, 'a'); assert.equal(await second, 'b');
  const pending = runtime.request('playlist_add', {}); await new Promise(resolve => setImmediate(resolve));
  const rejected = assert.rejects(pending, /result unknown/);
  await runtime.close(); await rejected;
  await assert.rejects(runtime.request('search', {}), /closed/);
});

const freePort = () => new Promise(resolve => {
  const server = net.createServer(); server.listen(0, '127.0.0.1', () => {
    const port = server.address().port; server.close(() => resolve(port));
  });
});
class OfflineWorker extends Worker {
  constructor(entry, options) {
    super(path.join(__dirname, 'fixtures/folia-provider-offline.cjs'), {
      ...options, workerData: { ...options.workerData, entry },
    });
  }
}
test('real QQ/Netease services load off-thread, stay loopback-only, and release ports on unload', { timeout: 20000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-folia-providers-'));
  const histogram = monitorEventLoopDelay({ resolution: 10 }); histogram.enable();
  await new Promise(resolve => setTimeout(resolve, 30));
  const start = performance.now(); const runtimes = [];
  let authSaves = 0;
  const fakeAuth = { load: () => [{ fixture: 'not-a-session' }], save: sessions => {
    assert.deepEqual(sessions, []); authSaves++;
  } };
  try {
    const ports = await Promise.all([freePort(), freePort()]);
    for (const [index, provider] of ['netease', 'qq'].entries()) runtimes.push(startProviderWorker({
      provider, port: ports[index], dataDir, authSessionRepository: fakeAuth, WorkerClass: OfflineWorker,
    }));
    await Promise.all(runtimes.map(runtime => runtime.ready));
    assert.equal(authSaves, 1, 'real QQ worker must await its host persistence acknowledgement');
    const startupMs = Math.round(performance.now() - start);
    const responses = await Promise.all(ports.map(port => fetch(`http://127.0.0.1:${port}/`).then(response => response.status)));
    assert.ok(responses.every(status => status < 500));
    await new Promise(resolve => setTimeout(resolve, 30)); histogram.disable();
    const mainLoopMaxMs = Math.round(histogram.max / 1e6);
    assert.equal(Object.keys(require.cache).filter(file => /node_modules.*(neteasecloudmusicapienhanced|qq-music-api)/.test(file)).length, 0);
    // A generous guard catches moving the real 0.5s+ dependency graph back to the main thread.
    assert.ok(mainLoopMaxMs < 250, `Provider import blocked the host for ${mainLoopMaxMs}ms`);
    await Promise.all(runtimes.map(runtime => runtime.close()));
    for (const port of ports) await new Promise((resolve, reject) => {
      const server = net.createServer(); server.once('error', reject);
      server.listen(port, '127.0.0.1', () => server.close(resolve));
    });
    console.log('FOLIA_PROVIDER_STARTUP ' + JSON.stringify({ startupMs, mainLoopMaxMs, realPackages: true, internet: false }));
  } finally { histogram.disable(); await Promise.all(runtimes.map(runtime => runtime.close())); }
});
test('real KuGou import/request runs in a worker, preserves operation errors, and rejects unknown methods', { timeout: 10000 }, async () => {
  const runtime = startProviderWorker({ provider: 'kugou',
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-folia-kugou-')), WorkerClass: OfflineWorker });
  try {
    await runtime.ready;
    await assert.rejects(runtime.request('arbitrary_operation', {}), /Unsupported KuGou/);
    await assert.rejects(runtime.request('register_dev', { cookie: {} }), error => error.status === 502 && error.body.status === 0);
    assert.equal(Object.keys(require.cache).filter(file => /node_modules.*kugoumusicapi/.test(file)).length, 0);
  } finally { await runtime.close(); }
});
