// Harbour's per-request allowance, not the provider/model's native ceiling.
export const DSH_DEFAULT_OUTPUT_TOKENS = 65_536;
export const DSH_MAX_OUTPUT_TOKENS = 65_536;
export const DSH_DEFAULT_SPILL_INLINE_TOKENS = 8_192;

export function dshOutputTokens(configured = DSH_DEFAULT_OUTPUT_TOKENS): number {
  return Number.isFinite(configured)
    ? Math.max(1, Math.min(Math.floor(configured), DSH_MAX_OUTPUT_TOKENS))
    : DSH_DEFAULT_OUTPUT_TOKENS;
}
