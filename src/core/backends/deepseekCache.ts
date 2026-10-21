import { createHash } from "node:crypto";

/** DeepSeek 官方 Anthropic 兼容端点。第三方兼容网关不要套用这条 provider 专属策略。 */
export function isOfficialDeepSeekAnthropicEndpoint(baseURL: string): boolean {
  try {
    const u = new URL(baseURL);
    return u.protocol === "https:" && u.hostname.toLowerCase() === "api.deepseek.com";
  } catch {
    return false;
  }
}

/**
 * Claude Agent SDK 会把每次 query 的 session UUID 映射到 Anthropic 请求的
 * metadata.user_id；不显式传 sessionId 时，每轮都会生成一个新的 UUID。
 *
 * DeepSeek 的 KV Cache 又按 user_id 隔离，于是默认 SDK 行为会让相同 prompt 的
 * 两次请求落进两个互不可见的缓存空间。这里为【同一个 DeepSeek 端点】生成稳定 UUID：
 * - persistSession:false，故它不会接管 Harbour 自己的会话历史；
 * - UUID 只充当稳定 cache namespace，不包含 key，也不会把密钥写进磁盘/日志；
 * - 不对 Kimi / Anthropic / 其它兼容端点启用，避免改变它们的 session 语义。
 */
export function deepSeekCacheSessionId(baseURL: string): string | undefined {
  if (!isOfficialDeepSeekAnthropicEndpoint(baseURL)) return undefined;

  const u = new URL(baseURL);
  const path = u.pathname.replace(/\/+$/, "") || "/";
  const namespace = `harbour:deepseek-kv-cache:v1:${u.origin.toLowerCase()}${path}`;
  const bytes = createHash("sha256").update(namespace).digest().subarray(0, 16);

  // RFC 4122 variant + v4 layout。内容是确定性的，但 Claude SDK 只要求合法 UUID；
  // 使用 v4 layout 可兼容其当前参数校验，同时相同 namespace 永远得到同一个值。
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
