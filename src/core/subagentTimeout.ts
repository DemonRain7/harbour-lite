export const SUBAGENT_TIMEOUT_MS = 20 * 60_000;
export const COMIC_DIRECTOR_TIMEOUT_MS = 100 * 60_000;
export const OUTER_TIMEOUT_GRACE_MS = 30_000;

/** Exact configured identity, not task keywords or model-supplied duration. */
export function subagentTimeoutMs(agent: unknown): number {
  return ["comic_generator", "novelai_artist"].includes(String(agent ?? "").trim()) ? COMIC_DIRECTOR_TIMEOUT_MS : SUBAGENT_TIMEOUT_MS;
}

/** Abort the existing subtree first; its caller keeps a small receipt-settlement grace. */
export function runCancellableSubagent<T>(
  parentSignal: AbortSignal | undefined,
  start: (signal: AbortSignal) => Promise<T>,
  timeoutMs = SUBAGENT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) return Promise.reject(parentSignal.reason);
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Subagent 执行超过 ${timeoutMs / 60_000} 分钟，已取消`));
  }, timeoutMs);
  return Promise.resolve().then(() => {
    controller.signal.throwIfAborted();
    return start(controller.signal);
  }).catch((error) => {
    if (timedOut) throw new Error(`Subagent 执行超过 ${timeoutMs / 60_000} 分钟，已取消`, { cause: error });
    throw error;
  }).finally(() => {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  });
}
