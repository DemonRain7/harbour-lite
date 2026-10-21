/* Pure UI projection. The same labels drive icons, accessible names and the
 * expanded companion lines; no text parsing, invented percentage or model. */
((root) => {
  function status(state = {}, expression = {}) {
    const chat = state.chat || {}, shared = state.signals || {};
    const connected = state.connection === "open";
    const ownBusy = !!(chat.runId || chat.preparing);
    const ownKind = !connected && ownBusy ? "unknown" : chat.asks?.length || chat.phase === "waiting" ? "waiting"
      : expression.mood === "failed" ? "failed" : chat.phase === "uncertain" ? "unknown"
      : ownBusy && connected ? "working" : ownBusy ? "unknown" : "idle";
    const own = ownKind === "idle" ? null : { kind: ownKind, label: ownKind === "unknown" ? "任务状态待核对" : expression.label || "正在处理",
      title: "当前对话", detail: chat.detail || expression.label || "", source: "悬浮助手", count: ownBusy ? 1 : 0,
      canOpen: true, own: true, runId: chat.runId || "" };
    const rank = row => ({ waiting: 0, failed: 1, working: 2, unknown: 3, reply: 4, idle: 5 }[row?.kind] ?? 6);
    const external = shared.task;
    if (own && external?.count > 1) own.count = external.count;
    const task = rank(own) <= rank(external) ? own : external || null;
    const busy = connected && (ownBusy || external?.kind === "working" || external?.kind === "waiting");
    const kind = task?.kind || (connected ? "idle" : "offline");
    // Reading dismisses attention, not the failure/checkpoint itself. Active
    // work and unanswered confirmations must remain visible regardless of read state.
    const attentionOwn = !ownBusy && chat.notificationRead ? null : own;
    const attention = rank(attentionOwn) <= rank(external) ? attentionOwn : external;
    const alert = attention?.kind === "waiting" ? "waiting" : attention?.kind === "failed" || shared.notification === "failed" ? "failed"
      : state.unread || shared.notification === "reply" ? "reply" : attention?.kind === "unknown" ? "unknown" : "none";
    const music = shared.music || null;
    return { kind, task, busy, alert, music, musicState: music ? music.paused ? "paused" : "playing" : "none" };
  }
  if (typeof module === "object" && module.exports) module.exports = { status };
  else root.orbStatus = status;
})(typeof window === "object" ? window : globalThis);
