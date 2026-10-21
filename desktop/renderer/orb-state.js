/* Compact progress IPC never replaces the retained conversation. No server
 * history is removed; a new revision arrives in full when the panel opens. */
(function (root) {
  function merge(previous, next) {
    if (previous && next.stateRevision < previous.stateRevision) return null;
    const full = Array.isArray(next.chat.messages);
    const reuse = !full && previous?.historyReady && previous.agent === next.agent
      && previous.chat.sessionId === next.chat.sessionId
      && previous.chat.historyRevision === next.chat.historyRevision;
    return { ...next, historyReady: full || !!reuse, chat: { ...next.chat,
      messages: full ? next.chat.messages : reuse ? previous.chat.messages : [],
      summary: full ? next.chat.summary || "" : reuse ? previous.chat.summary : "" } };
  }
  root.OrbState = { merge };
  if (typeof module !== "undefined") module.exports = { merge };
})(typeof window !== "undefined" ? window : globalThis);
