const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { parentPort, workerData } = require('node:worker_threads');
const { createProviderAuthBridge } = require('./providerAuthBridge.cjs');

// electron/providerWorker.cjs
// Pure Node worker: no Electron/UI, no second player, no Harbour model or backend.
let stopping = false, handle = null;
async function stop() {
  stopping = true;
  const current = handle; handle = null;
  try { await current?.close(); }
  finally { parentPort.postMessage({ type: 'closed' }); }
}
parentPort.on('message', async message => {
  if (message?.type === 'stop') { void stop(); return; }
  if (message?.type !== 'request' || stopping) return;
  try {
    if (!handle?.request) throw new Error('Provider does not accept this request');
    const result = await handle.request(message.operation, message.params);
    if (!stopping) parentPort.postMessage({ type: 'result', id: message.id, ok: true, result });
  } catch (error) {
    if (stopping) return;
    // Preserve provider status/body semantics, without forwarding transport config or headers.
    const reply = error instanceof Error ? new Error(error.message)
      : { status: error?.status, body: error?.body };
    try { parentPort.postMessage({ type: 'result', id: message.id, ok: false, error: reply }); }
    catch { parentPort.postMessage({ type: 'result', id: message.id, ok: false, error: new Error('Music provider request failed') }); }
  }
});

async function start() {
  const { provider, port, dataDir } = workerData;
  // Host configuration is already supplied via env. Providers must not load Harbour's .env.
  // Providers have different nested dotenv versions. Guard each import, not only the root copy.
  const load = Module._load;
  Module._load = function (id, ...args) {
    const loaded = load.call(this, id, ...args);
    return id === 'dotenv' ? { ...loaded, config: () => ({ parsed: {} }), configDotenv: () => ({ parsed: {} }) } : loaded;
  };
  if (provider === 'qq') {
    const { startQqApi } = require('./qqApiStartup.cjs');
    handle = await startQqApi({ hosted: true, port,
      stateFilePath: path.join(dataDir, 'qq-auth-state', 'qq-device.json'),
      authSessionRepository: createProviderAuthBridge({ parentPort, ...workerData }),
    });
  } else if (provider === 'netease') {
    // NCM stores anonymous runtime files in os.tmpdir(); scope these to this Folia profile.
    const cache = path.join(dataDir, 'netease-runtime');
    await fs.promises.mkdir(cache, { recursive: true });
    process.env.TMP = process.env.TEMP = process.env.TMPDIR = cache;
    const { startNeteaseRuntime } = require('./neteaseRuntime.cjs');
    handle = await startNeteaseRuntime({ port, shouldStop: () => stopping });
  } else if (provider === 'kugou') {
    process.env.platform = 'lite';
    const { OPERATION_MODULES } = require('./kugouApiBridge.cjs');
    const allowed = new Set(Object.values(OPERATION_MODULES).flat());
    const api = require('kugoumusicapi');
    handle = { close() {}, request(operation, params) {
      if (!allowed.has(operation) || typeof api[operation] !== 'function') throw new Error('Unsupported KuGou operation');
      return api[operation](params);
    } };
  } else throw new Error('Unknown provider');
  if (stopping) return stop();
  parentPort.postMessage({ type: 'ready', port });
}
start().catch(error => {
  if (!stopping) parentPort.postMessage({ type: 'failure', code: error.code });
  void stop();
});
