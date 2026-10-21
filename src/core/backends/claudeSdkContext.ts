import type { CompletionRequest } from "../../types";

/**
 * Adapt trusted Harbour capacity to Claude Code's native window controls. The
 * installed SDK strips [1m] before the provider request (including custom IDs).
 * Without that native hint, an unknown 1M model is silently treated as 200K.
 * Do not disable SDK compaction: it owns tool turns that Harbour cannot trim.
 *
 * Verified against SDK 0.3.191 / CLI 2.1.191 by sdkWindowProbe.mjs. The native
 * window env is clamped to 100K..1M. Its percentage is applied after up to 20K
 * output allowance, with an additional 13K safety ceiling. Smaller-output
 * models can have a different native trigger; Harbour's own preflight still
 * uses the exact configured ratio. This is not a tokenizer or SDK fork.
 */
export function claudeSdkContextOptions(model: string, policy?: CompletionRequest["contextPolicy"]) {
  if (!policy || ![policy.contextWindow, policy.contextLimit, policy.compactAtTokens]
    .every(value => Number.isInteger(value) && value > 0)) {
    return { model, env: {} as Record<string, string> };
  }
  const window = Math.max(100_000, Math.min(1_000_000, policy.contextWindow));
  const inputBasis = window - 20_000;
  const trigger = Math.max(1, Math.min(policy.compactAtTokens, policy.contextLimit, inputBasis - 13_000));
  // Quarter-token slack only avoids a floating-point floor landing one token
  // below the intended integer; it cannot move the threshold by a whole token.
  const percent = Math.min(100, (trigger + .25) / inputBasis * 100);
  return {
    model: policy.contextWindow > 200_000 && !/\[[12]m\]/i.test(model) ? `${model}[1m]` : model,
    env: {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window),
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(percent),
    } as Record<string, string>,
  };
}
