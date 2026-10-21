// electron/providerAuthBridge.cjs
// QQ's repository contract is synchronous. Wait on this worker, never on the UI thread.
function createProviderAuthBridge({ parentPort, sessions, authLoadFailed, timeoutMs = 5000 }) {
  return {
    kind: 'electron-safe-storage',
    load() {
      if (authLoadFailed) throw new Error('Encrypted QQ sessions unavailable');
      return sessions;
    },
    save(nextSessions) {
      const signal = new Int32Array(new SharedArrayBuffer(4));
      parentPort.postMessage({ type: 'auth-save', sessions: nextSessions, signal: signal.buffer });
      Atomics.wait(signal, 0, 0, timeoutMs);
      if (Atomics.load(signal, 0) !== 1) throw new Error('Encrypted QQ session save failed');
    },
  };
}

module.exports = { createProviderAuthBridge };
