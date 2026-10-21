/* The same deterministic expression projection is used by the view and offline tests.
 * These are UI states, not model emotions, percentages or proof of business success. */
((root) => {
  // v2 redraws thinking IN the same registered atlas; no independently zoomed
  // portrait. Position, hairstyle and palette stay stable across every mood.
  const positions = { idle: "0% 0%", thinking: "50% 0%", waiting: "100% 0%", complete: "0% 100%", failed: "50% 100%" };
  function expression(state = {}, now = Date.now()) {
    const chat = state.chat || {};
    const busy = !!(chat.runId || chat.preparing || chat.loading), failure = chat.failure;
    const transientFailure = failure?.scope === "subagent" || (busy && failure?.scope === "workflow");
    const failureUntil = Number.isFinite(failure?.at) ? failure.at + 5000 : 0;
    let mood = "idle", label = "在你身边", resetAt = 0;
    if (chat.phase === "cancelled") label = "已停止";
    else if (chat.phase === "stopping") { mood = "thinking"; label = "正在停止"; }
    else if (chat.asks?.length || chat.phase === "waiting") { mood = "waiting"; label = "等你确认"; }
    else if (failure && (!transientFailure || now < failureUntil)) {
      mood = "failed"; label = failure.label;
      if (transientFailure) resetAt = failureUntil;
    }
    else if (chat.phase === "uncertain") label = "结果待核对";
    else if (state.connection !== "open") label = "连接未就绪";
    else if (busy) { mood = "thinking"; label = chat.phase === "stopping" ? "正在停止" : "正在处理"; }
    // A child failure is not proof the whole task failed. Keep a factual hint,
    // not a permanent sad face or a claim that a later reply fixed the child.
    else if (failure?.scope === "subagent") label = "子任务曾失败，请查看回复";
    else if (chat.phase === "complete" && Number.isFinite(chat.replyReadyAt) && chat.replyReadyAt > 0
      && now >= chat.replyReadyAt && now < chat.replyReadyAt + 8000) {
      mood = "complete"; label = "回复已就绪"; resetAt = chat.replyReadyAt + 8000;
    }
    return { mood, label, position: positions[mood], resetAt };
  }
  if (typeof module === "object" && module.exports) module.exports = { expression };
  else root.orbExpression = expression;
})(typeof window === "object" ? window : globalThis);
