/* The desktop's opening is presentation only. No session writes, tool calls or
   polling live here. Real data loads and the first authenticated WS snapshot
   separately acknowledge readiness; page load / WS open alone are insufficient. */
(() => {
  const desktop = window.harbourDesktop;
  if (!desktop?.startup || typeof desktop.startupReady !== "function") return;
  const required = new Set(["ui", "models", "sessions", "live"]), ready = new Set();
  let sent = false, scheduled = false, entered = false, authFailed = false;
  const unsubscribe = desktop.onStartupEntered?.(() => { entered = true; });
  window.addEventListener('pagehide', () => unsubscribe?.(), { once: true });
  function report() {
    if (sent || scheduled || authFailed || [...required].some(key => !ready.has(key))) return;
    scheduled = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      scheduled = false;
      if (sent || authFailed || [...required].some(key => !ready.has(key))) return;
      const workbench = document.querySelector('.chat-workbench');
      const input = document.getElementById('chatInput');
      if (!workbench || !input || document.body.dataset.panel !== 'chat') return;
      const rect = workbench.getBoundingClientRect(), style = getComputedStyle(workbench);
      if (rect.width <= 0 || rect.height <= 0) return;
      sent = true;
      desktop.startupReady({
        target: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, radius: parseFloat(style.borderTopLeftRadius) || 0 },
        palette: { background: getComputedStyle(document.body).backgroundColor, surface: style.backgroundColor, border: style.borderTopColor },
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      });
    }));
  }
  window.HarbourStartupGate = {
    mark: key => { if (required.has(key)) ready.add(key); report(); },
    disconnected: () => {
      ready.delete('live');
      if (!entered) { sent = false; desktop.startupStatus?.('network'); }
    },
    failed: reason => {
      if (entered) return;
      if (reason === 'auth') authFailed = true;
      sent = false;
      desktop.startupStatus?.(authFailed ? 'auth' : reason);
    },
  };
})();
