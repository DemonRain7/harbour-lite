"use strict";

// Only the backend's saved-session estimate / native observation is context.
// Billing totals and tool/trace counts must never fill this ring.
function sessionContext(value) {
  const tokens = value?.contextTokens, limit = value?.contextLimit > 0 ? value.contextLimit : value?.contextWindow;
  if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(limit) || limit <= 0) return null;
  const compactAt = Number.isFinite(value.compactAtTokens) && value.compactAtTokens > 0 ? value.compactAtTokens : null;
  return { ratio: Math.max(0, Math.min(1, tokens / limit)),
    tone: tokens >= limit ? "full" : compactAt && tokens >= compactAt ? "compact" : tokens / limit >= .65 ? "warm" : "normal",
    source: value.contextTokenSource === "native-observed" ? "native" : "estimate",
    modelRef: typeof value.contextModelRef === "string" ? value.contextModelRef : "" };
}

module.exports = { sessionContext };
