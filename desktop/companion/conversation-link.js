// One user navigation intent, not an execution queue. The last click wins while
// a Dashboard is loading. No URL, session key, prompt or tool call crosses here.
function conversationTarget(value) {
  const safe = (text) => typeof text === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(text);
  return safe(value?.sessionId) && safe(value?.agentName)
    ? { sessionId: value.sessionId, agentName: value.agentName } : null;
}

class ConversationLink {
  pending = null;
  renderer = null;
  enqueue(value) {
    const target = conversationTarget(value);
    if (!target) return false;
    this.pending = target;
    return true;
  }
  ready(renderer) { this.renderer = renderer; this.flush(); }
  loading(renderer) { if (this.renderer === renderer) this.renderer = null; }
  flush() {
    if (!this.pending || !this.renderer || this.renderer.isDestroyed() || this.renderer.isLoadingMainFrame()) return;
    this.renderer.send("desktop:open-conversation", this.pending);
    this.pending = null;
  }
}

module.exports = { conversationTarget, ConversationLink };
