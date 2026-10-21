/* Presentation-only lifecycle. Never suspends transport, tasks or audio. */
(() => {
  let nativePaused = false, active = !document.hidden, revision = 0;
  const subscribers = new Set();
  const sync = () => {
    const next = !document.hidden && !nativePaused;
    document.documentElement.dataset.harbourVisualPaused = String(!next);
    if (next === active) return;
    active = next;
    for (const fn of subscribers) { try { fn(active); } catch (error) { console.error("Visual activity listener failed", error); } }
  };
  const subscribe = fn => { subscribers.add(fn); return () => subscribers.delete(fn); };
  // A single visibility-aware, non-overlapping scheduler for optional UI work.
  function poll(work, delay, { immediate = true, onError = () => {} } = {}) {
    let timer, stopped = false, running = false, rerun = false;
    const cancel = () => { clearTimeout(timer); timer = null; };
    const schedule = () => {
      cancel(); if (!stopped && active) timer = setTimeout(run, delay);
    };
    async function run() {
      cancel(); if (stopped || !active) return;
      if (running) { rerun = true; return; }
      running = true;
      try { await work(); } catch (error) { onError(error); }
      finally {
        running = false;
        if (rerun && !stopped && active) { rerun = false; void run(); }
        else { rerun = false; schedule(); }
      }
    }
    const unsubscribe = subscribe(visible => { cancel(); if (visible) void run(); });
    if (immediate) void run(); else schedule();
    return { refresh: run, dispose() { stopped = true; cancel(); unsubscribe(); } };
  }
  window.HarbourVisualActivity = { isActive: () => active, subscribe, poll };
  const style = document.createElement("style");
  style.textContent = 'html[data-harbour-visual-paused="true"] *,html[data-harbour-visual-paused="true"] *::before,html[data-harbour-visual-paused="true"] *::after{animation-play-state:paused!important}';
  document.head.appendChild(style);
  document.addEventListener("visibilitychange", sync);
  const bridge = window.harbourDesktop || window.harbourOrb;
  const unsubscribe = bridge?.onVisualPolicy?.(state => { ++revision; nativePaused = state?.paused === true; sync(); });
  const stamp = revision;
  bridge?.getVisualPolicy?.().then(state => {
    if (stamp === revision) { nativePaused = state?.paused === true; sync(); }
  }).catch(() => {}); // Old main process until the user next restarts the desktop.
  window.addEventListener("pagehide", event => { if (!event.persisted) unsubscribe?.(); });
  window.addEventListener("pageshow", sync);
  sync();
})();
