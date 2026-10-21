const { startProviderWorker } = require('./providerWorkerHost.cjs');
const { OPERATION_MODULES } = require('./kugouApiBridge.cjs');

// electron/kugouWorkerApi.cjs
// Keep cookies/sanitization in the existing bridge; move only package loading and IO off-thread.
function createKugouWorkerApi({ dataDir, offline = false, startWorker = startProviderWorker } = {}) {
  let runtime = null, disposed = false;
  let api;
  const methods = Object.fromEntries([...new Set(Object.values(OPERATION_MODULES).flat())].map(operation => [operation,
    async params => {
      if (disposed || offline) throw new Error('KuGou service is closed or offline');
      if (!runtime) runtime = startWorker({ provider: 'kugou', dataDir });
      // No retry here: operations can include playlist/account mutations.
      return runtime.request(operation, params);
    },
  ]));
  return {
    load() {
      if (offline) throw new Error('KuGou service is offline');
      // Availability checks must not parse the entire provider/server just to inspect an account.
      require.resolve('kugoumusicapi');
      // Preserve the existing candidate fallback when a pinned package lacks an older alias.
      api ||= Object.fromEntries(Object.entries(methods).filter(([operation]) => {
        try { require.resolve(`kugoumusicapi/module/${operation}`); return true; }
        catch (error) { if (error.code === 'MODULE_NOT_FOUND') return false; throw error; }
      }));
      return api;
    },
    close() { disposed = true; return runtime?.close(); },
  };
}

module.exports = { createKugouWorkerApi };
