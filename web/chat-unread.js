/* Read receipts are UI metadata only. Never send prose, create runs or use activity timestamps. */
window.HarbourChatUnread = (() => {
  const known = new Map(), pending = new Map(), failedAt = new Map(), views = new Set();
  const valid = value => Number.isSafeInteger(value) && value >= 0;
  function observe(session) {
    if (!session?.id || !valid(session.replyRevision) || !valid(session.readReplyRevision)) return;
    const previous = known.get(session.id);
    known.set(session.id, {
      replyRevision: Math.max(previous?.replyRevision || 0, session.replyRevision),
      readReplyRevision: Math.max(previous?.readReplyRevision || 0, Math.min(session.readReplyRevision, session.replyRevision)),
    });
  }
  function hasUnread(session) {
    if (!session?.id) return false;
    observe(session);
    const value = known.get(session.id);
    return !!value && value.replyRevision > value.readReplyRevision;
  }
  function mount(stream, { api, current, onChange }) {
    const events = new AbortController();
    let frame = 0, disposed = false;
    async function check() {
      frame = 0;
      if (disposed || !stream.isConnected || document.hidden || !document.hasFocus()) return;
      const snapshot = current();
      if (!snapshot?.id || !snapshot.key || !valid(snapshot.replyRevision)) return;
      observe(snapshot);
      if (!snapshot.replyRevision || snapshot.replyRevision <= (known.get(snapshot.id)?.readReplyRevision || 0)
        || pending.has(snapshot.id) || Date.now() - (failedAt.get(snapshot.id) || 0) < 10000) return;
      const replies = stream.querySelectorAll('.chat-msg.assistant:not(.pending)');
      const latest = replies[replies.length - 1];
      if (!latest || !stream.getClientRects().length) return;
      const viewport = stream.getBoundingClientRect(), reply = latest.getBoundingClientRect();
      const top = Math.max(0, viewport.top), bottom = Math.min(window.innerHeight, viewport.bottom);
      // Merely selecting a session, a hidden window, or reading earlier messages is not a receipt.
      if (bottom <= top || reply.height <= 0 || reply.bottom <= top || reply.top >= bottom) return;
      const { id, key, replyRevision } = snapshot;
      pending.set(id, replyRevision);
      try {
        const result = await api(`/api/conversations/${encodeURIComponent(id)}/read`, {
          method: 'POST', body: JSON.stringify({ key, replyRevision }),
        });
        if (result?.id !== id || !valid(result.replyRevision) || !valid(result.readReplyRevision)
          || result.readReplyRevision < replyRevision || result.readReplyRevision > result.replyRevision) throw new Error('Invalid read receipt');
        observe(result); failedAt.delete(id);
        for (const view of views) view.onChange();
      } catch { failedAt.set(id, Date.now()); /* Keep the green dot; never optimistically consume a reply. */ }
      finally { pending.delete(id); }
      // A new view/reply may have arrived while the old view's acknowledgement was in flight.
      for (const view of views) view.schedule();
    }
    function schedule() { if (!disposed && !frame) frame = requestAnimationFrame(check); }
    const view = { schedule, onChange };
    views.add(view);
    stream.addEventListener('scroll', schedule, { passive: true, signal: events.signal });
    for (const type of ['load', 'toggle']) stream.addEventListener(type, schedule, { capture: true, signal: events.signal });
    window.addEventListener('focus', schedule, { signal: events.signal });
    window.addEventListener('resize', schedule, { passive: true, signal: events.signal });
    document.addEventListener('visibilitychange', schedule, { signal: events.signal });
    const mutations = new MutationObserver(schedule);
    mutations.observe(stream, { childList: true, subtree: true, characterData: true });
    const resize = window.ResizeObserver ? new ResizeObserver(schedule) : null;
    resize?.observe(stream);
    schedule();
    return () => { disposed = true; views.delete(view); events.abort(); mutations.disconnect(); resize?.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }
  return { observe, hasUnread, mount };
})();
