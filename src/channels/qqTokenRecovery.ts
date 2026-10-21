import type { Logger } from "pino";

interface RequestOptions {
  timeoutMs?: number;
  redactBodyKeys?: string[];
  uploadRequest?: boolean;
}

/** Public primitives exposed by the official QQ SDK (not private cache fields). */
export interface QQSdkTransport {
  tokenManager: {
    getAccessToken(appId: string, clientSecret: string): Promise<string>;
    clearCache(appId: string): void;
  };
  apiClient: {
    request<T = unknown>(token: string, method: string, path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  };
}

const installed = new WeakSet<object>();
const deliveryPath = /^\/v2\/(?:users|groups)\/[^/?#]+\/(files|messages)$/;

/** Only the SDK's parsed QQ rejection counts; proxy/timeout/free-text errors do not. */
function isTokenRejected(error: unknown, requestPath: string): boolean {
  if (!(error instanceof Error) || error.name !== "ApiError") return false;
  const api = error as Error & { httpStatus?: number; path?: string; bizMessage?: string };
  return [400, 401, 403].includes(api.httpStatus ?? 0)
    && api.path === requestPath
    && typeof api.bizMessage === "string"
    && api.bizMessage.replace(/\s/g, "").toLowerCase() === "accesstoken无效或过期";
}

/** Do not put target IDs, request bodies, tokens, URLs or raw platform errors in recovery logs. */
export function qqApiFailureDetails(error: unknown): { httpStatus?: number; bizCode?: number } {
  if (!error || typeof error !== "object") return {};
  const api = error as { httpStatus?: unknown; bizCode?: unknown };
  return {
    ...(Number.isInteger(api.httpStatus) ? { httpStatus: api.httpStatus as number } : {}),
    ...(Number.isInteger(api.bizCode) ? { bizCode: api.bizCode as number } : {}),
  };
}

/**
 * Recover one explicitly rejected HTTP request, never a whole sendImage/sendText.
 * Keeping the SDK body intact preserves msg_id/msg_seq and avoids re-uploading a
 * file whose upload already succeeded. Each bot retains its own token cache.
 */
export function installQQTokenRecovery(
  bot: QQSdkTransport, credentials: { appId: string; appSecret: string }, logger: Logger,
): void {
  if (typeof bot.apiClient?.request !== "function" || typeof bot.tokenManager?.getAccessToken !== "function"
    || typeof bot.tokenManager?.clearCache !== "function") {
    throw new Error("QQ SDK 缺少安全令牌恢复接口，请检查官方 SDK 兼容性");
  }
  const { apiClient, tokenManager } = bot;
  if (installed.has(apiClient)) return;
  const request = apiClient.request.bind(apiClient);
  const appId = credentials.appId.trim();
  if (!appId) throw new Error("QQ APP_ID 不能为空");
  installed.add(apiClient);
  let refreshing: Promise<string> | undefined;
  const refresh = (rejectedToken: string): Promise<string> => {
    if (refreshing) return refreshing;
    const pending = (async () => {
      // Another request/Gateway reconnect may already have replaced this token.
      const current = await tokenManager.getAccessToken(appId, credentials.appSecret);
      if (current !== rejectedToken) return current;
      tokenManager.clearCache(appId);
      return tokenManager.getAccessToken(appId, credentials.appSecret);
    })();
    refreshing = pending;
    void pending.then(() => { refreshing = undefined; }, () => { refreshing = undefined; });
    return pending;
  };

  // SDK 1.0.4's upload retry captures a stale token and reuses the SAME body.
  // Reuse that logical request's outcome, so its outer loop cannot multiply our
  // auth retry or replay an unknown write. New sends get new bodies; WeakMap
  // does not retain media/history after the SDK releases a completed operation.
  const attempts = new WeakMap<object, Map<string, Promise<unknown>>>();
  apiClient.request = function<T = unknown>(token: string, method: string, path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    const matched = method === "POST" && deliveryPath.exec(path);
    if (!matched || !body || typeof body !== "object" || Array.isArray(body)) {
      return request<T>(token, method, path, body, options);
    }
    let operations = attempts.get(body);
    if (!operations) { operations = new Map(); attempts.set(body, operations); }
    const key = `${method} ${path}`;
    const previous = operations.get(key);
    if (previous) return previous as Promise<T>;
    const pending = (async () => {
      try {
        return await request<T>(token, method, path, body, options);
      } catch (error) {
        if (!isTokenRejected(error, path)) throw error;
        logger.warn({ operation: matched[1], ...qqApiFailureDetails(error) }, "QQ 令牌被明确拒绝，刷新后重试当前请求一次");
        const replacement = await refresh(token);
        if (replacement === token) throw error;
        // No recursive recovery: a second failure is final, regardless
        // of whether it is auth, quota, network or an unknown delivery outcome.
        const result = await request<T>(replacement, method, path, body, options);
        logger.info({ operation: matched[1] }, "QQ 当前请求已通过令牌恢复");
        return result;
      }
    })();
    operations.set(key, pending);
    return pending;
  };
}
