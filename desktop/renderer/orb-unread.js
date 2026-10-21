/* A visible reply is a read receipt; opening/loading a panel is not. No clocks,
 * focus changes, credentials, model calls or optimistic badge clearing here. */
window.OrbUnread = class OrbUnread {
  constructor({ panel, stream, getState, invoke, obscured = () => false }) {
    Object.assign(this, { panel, stream, getState, invoke, obscured });
    this.events = new AbortController(); this.done = new Set(); this.failedAt = new Map();
    this.schedule = () => { if (!this.disposed && !this.frame) this.frame = requestAnimationFrame(() => this.check()); };
    const signal = this.events.signal;
    for (const type of ["scroll", "load"]) stream.addEventListener(type, this.schedule, { passive: true, capture: true, signal });
    panel.addEventListener("pointerenter", this.schedule, { signal });
    for (const type of ["focus", "resize"]) window.addEventListener(type, this.schedule, { signal });
    document.addEventListener("visibilitychange", this.schedule, { signal });
    this.mutations = new MutationObserver(this.schedule);
    this.mutations.observe(panel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "inert", "open"] });
    this.resize = window.ResizeObserver ? new ResizeObserver(this.schedule) : null;
    this.resize?.observe(stream);
    this.unsubscribe = window.HarbourVisualActivity?.subscribe(this.schedule);
  }
  async check() {
    this.frame = 0;
    const state = this.getState(), chat = state?.chat;
    if (this.disposed || this.pending || !state?.enabled || !state.expanded || !state.historyReady
      || !chat?.sessionId || chat.loading || chat.runId || chat.preparing || chat.notificationRead
      || chat.lastMessageRole !== "assistant" || document.hidden || this.panel.hidden || this.panel.inert
      || !this.stream.isConnected || this.obscured() || window.HarbourVisualActivity?.isActive() === false
      || !document.hasFocus() && !this.panel.matches(":hover")) return;
    const replies = this.stream.querySelectorAll(".turn.assistant"), latest = replies[replies.length - 1];
    if (!latest || !this.stream.getClientRects().length) return;
    const viewport = this.stream.getBoundingClientRect(), box = latest.getBoundingClientRect();
    const top = Math.max(0, viewport.top), bottom = Math.min(window.innerHeight, viewport.bottom);
    if (bottom <= top || box.height <= 0 || box.bottom <= top || box.top >= bottom) return;
    const input = { agent: state.agent, sessionId: chat.sessionId, replyRevision: chat.replyRevision,
      historyRevision: chat.historyRevision, noticeKey: chat.noticeKey };
    const key = JSON.stringify(input);
    if (this.done.has(key) || Date.now() - (this.failedAt.get(key) || 0) < 10000) return;
    this.pending = true;
    try {
      if (await this.invoke("read", input) === true) {
        this.done.add(key); this.failedAt.delete(key);
        if (this.done.size > 128) this.done.delete(this.done.values().next().value);
      }
    } catch {
      this.failedAt.set(key, Date.now());
      if (this.failedAt.size > 128) this.failedAt.delete(this.failedAt.keys().next().value);
    } finally {
      this.pending = false;
      // Only recheck a view that changed during IPC, never spin on a rejected receipt.
      if (this.getState() !== state) this.schedule();
    }
  }
  dispose() {
    this.disposed = true; this.events.abort(); this.mutations.disconnect(); this.resize?.disconnect(); this.unsubscribe?.();
    if (this.frame) cancelAnimationFrame(this.frame);
  }
};
