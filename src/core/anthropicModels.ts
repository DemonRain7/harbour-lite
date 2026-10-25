/** Public edition: Console API keys only; no claude.ai subscription login. */
export const ANTHROPIC_API_HOST = "api.anthropic.com";

/** Empty base URL uses the SDK's official default endpoint. */
export function isNativeAnthropicEndpoint(baseURL: string | undefined): boolean {
  if (!baseURL?.trim()) return true;
  try {
    const url = new URL(baseURL);
    return url.protocol === "https:" && url.hostname.toLowerCase() === ANTHROPIC_API_HOST;
  } catch { return false; }
}
