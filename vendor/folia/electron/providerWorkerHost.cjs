const path = require('node:path');
const { Worker } = require('node:worker_threads');

// electron/providerWorkerHost.cjs
// Provider imports and HTTP handlers must never occupy Harbour's desktop event loop.
function startProviderWorker({ provider, port, dataDir, authSessionRepository, onFailure,
  WorkerClass = Worker, startupTimeoutMs = 80000, stopTimeoutMs = 1500 } = {}) {
  if (!['netease', 'qq', 'kugou'].includes(provider)) throw new Error('Unknown Folia provider');
  let sessions = [], authLoadFailed = false;
  if (provider === 'qq') {
    try { sessions = authSessionRepository.load(); }
    catch { authLoadFailed = true; }
  }
  const worker = new WorkerClass(path.join(__dirname, 'providerWorker.cjs'), {
    workerData: { provider, port, dataDir, sessions, authLoadFailed },
    // A private environment also stops the provider from changing Harbour's PORT/NODE_ENV.
    env: { ...process.env, ENABLE_GENERAL_UNBLOCK: 'false', QQ_DISABLE_UPDATE_CHECK: 'true',
      AUTO_OPEN_EXPLORER: 'false', QQ_AUTH_SESSION_PATH: '', QQ_SESSION_SECRET: '' },
    stdout: true, stderr: true,
  });
  // Upstream request logs can contain cookies. Consume them without forwarding private data.
  worker.stdout?.resume(); worker.stderr?.resume();
  let stopped = false, settled = false, exited = false, stopPromise = null;
  let sequence = 0;
  const pending = new Map();
  const rejectRequests = error => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  let resolveReady, rejectReady, resolveExit;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const exit = new Promise(resolve => { resolveExit = resolve; });
  const fail = error => {
    rejectRequests(error);
    if (!settled) { settled = true; clearTimeout(timer); rejectReady(error); }
    else if (!stopped) onFailure?.(error);
  };
  const timer = setTimeout(() => {
    fail(new Error(`${provider} service startup timed out`));
    void close();
  }, startupTimeoutMs);
  timer.unref?.();
  worker.on('message', message => {
    if (message?.type === 'auth-save' && provider === 'qq') {
      // Only the worker waits; safeStorage and the existing encrypted repository stay here.
      const signal = message.signal instanceof SharedArrayBuffer && message.signal.byteLength === 4
        ? new Int32Array(message.signal) : null;
      if (!signal) return;
      let status = -1;
      try {
        if (!exited && Array.isArray(message.sessions)) {
          authSessionRepository.save(message.sessions); status = 1;
        }
      } catch { /* Preserve the provider's existing in-memory fallback on a locked keychain. */ }
      Atomics.store(signal, 0, status); Atomics.notify(signal, 0);
    } else if (message?.type === 'ready' && !settled && !stopped) {
      settled = true; clearTimeout(timer); resolveReady({ port: message.port });
    } else if (message?.type === 'failure' && !stopped) {
      const error = new Error(`${provider} service failed to start`);
      error.code = message.code === 'MODULE_NOT_FOUND' ? 'MODULE_NOT_FOUND' : 'PROVIDER_START_FAILED';
      fail(error); void close();
    } else if (message?.type === 'closed') {
      void worker.terminate();
    } else if (message?.type === 'result') {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.ok) request.resolve(message.result);
      else request.reject(message.error || new Error('Music provider request failed'));
    }
  });
  worker.on('error', () => { fail(new Error(`${provider} worker failed`)); void close(); });
  worker.on('exit', () => {
    exited = true;
    if (!stopped) fail(new Error(`${provider} worker exited`));
    clearTimeout(timer); resolveExit();
  });
  // Dispose even during import/network startup. A late READY cannot resurrect an unloaded player.
  function close() {
    if (stopPromise) return stopPromise;
    stopped = true; clearTimeout(timer);
    rejectRequests(new Error(`${provider} service closed; request result unknown`));
    if (!settled) { settled = true; rejectReady(new Error(`${provider} startup cancelled`)); }
    stopPromise = (async () => {
      if (exited) return;
      const deadline = setTimeout(() => { void worker.terminate(); }, stopTimeoutMs);
      try { worker.postMessage({ type: 'stop' }); await exit; }
      finally { clearTimeout(deadline); }
    })();
    return stopPromise;
  }
  async function request(operation, params) {
    if (provider !== 'kugou') throw new Error('This provider uses its loopback HTTP API');
    await ready;
    if (stopped || exited) throw new Error('Music provider is closed');
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id); reject(new Error('Music provider request timed out; result unknown'));
      }, 60000);
      pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ type: 'request', id, operation, params }); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  return { ready, close, request };
}

module.exports = { startProviderWorker };
