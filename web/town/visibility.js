// Rendering/loading visibility is separate from a pending Main conversation.
// Native views use their host signal (their owning shell may itself be hidden).
export function createTownVisibility({ signal, document, native = false }) {
  let hostVisible = !native;
  const listeners = new Set(), waiting = new Set();
  const hidden = () => !hostVisible || (!native && document.hidden);
  let wasHidden = hidden();
  function notify() {
    const value = hidden();
    if (!value) { for (const waiter of waiting) waiter.resolve(); waiting.clear(); }
    if (wasHidden === value) return;
    wasHidden = value;
    for (const listener of listeners) listener();
  }
  document.addEventListener('visibilitychange', notify, { signal });
  signal.addEventListener('abort', () => {
    for (const waiter of waiting) waiter.reject(signal.reason);
    waiting.clear(); listeners.clear();
  }, { once: true });
  return {
    hidden,
    setVisible(value) { hostVisible = !!value; notify(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async whenVisible() {
      signal.throwIfAborted();
      // Recheck after waking: a quick tab switch must not release a build chunk
      // into the background. No polling timers or extra network requests.
      while (hidden()) {
        await new Promise((resolve, reject) => waiting.add({ resolve, reject }));
        signal.throwIfAborted();
      }
    },
  };
}
