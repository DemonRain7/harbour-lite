/** Whole queued run deadline, shared with channel typing and interruption receipts. */
export const QUEUE_RUN_TIMEOUT_MINUTES = 50;
export const QUEUE_RUN_TIMEOUT_MS = QUEUE_RUN_TIMEOUT_MINUTES * 60_000;
export const QUEUE_RUN_TIMEOUT_REASON = "queue task timeout";
export const QUEUE_RUN_TIMEOUT_DESCRIPTION = `渠道任务超过 ${QUEUE_RUN_TIMEOUT_MINUTES} 分钟，已自动停止`;

/** In-memory capability: only a trusted execution boundary may extend its own queue wait. */
export interface QueueTaskDeadline {
  /** Extend from now, never shorten the current deadline or revive a settled run. */
  ensureRemaining(ms: number): boolean;
  dispose(): void;
  readonly remainingMs: number;
  /** Total allowed time from the queue worker's start, including any granted extension. */
  readonly timeoutMs: number;
  readonly timeoutMinutes: number;
  readonly description: string;
}

const queueDeadlines = new WeakMap<AbortSignal, QueueTaskDeadline>();
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function getQueueTaskDeadline(signal?: AbortSignal): QueueTaskDeadline | undefined {
  return signal ? queueDeadlines.get(signal) : undefined;
}

function timeoutDescription(ms: number): string {
  const seconds = Math.ceil(ms / 1_000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `渠道任务超过 ${minutes} 分钟${remainder ? ` ${remainder} 秒` : ""}，已自动停止`;
}

/** Keep ordinary runs at 50 minutes; extensions require the live run's trusted capability. */
export function createQueueTaskDeadline(controller: AbortController, onTimeout: () => void): QueueTaskDeadline {
  if (queueDeadlines.has(controller.signal)) throw new Error("queue task deadline already registered");
  const startedAt = Date.now();
  let expiresAt = startedAt + QUEUE_RUN_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  let disposed = controller.signal.aborted;
  const deadline: QueueTaskDeadline = {
    ensureRemaining(ms) {
      if (disposed || controller.signal.aborted || Date.now() >= expiresAt || !Number.isFinite(ms) || ms <= 0 || ms > MAX_TIMER_DELAY_MS) return false;
      const candidate = Date.now() + Math.ceil(ms);
      if (candidate <= expiresAt) return false;
      expiresAt = candidate;
      arm();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      controller.signal.removeEventListener("abort", onAbort);
      if (queueDeadlines.get(controller.signal) === deadline) queueDeadlines.delete(controller.signal);
    },
    get remainingMs() { return disposed ? 0 : Math.max(0, expiresAt - Date.now()); },
    get timeoutMs() { return expiresAt - startedAt; },
    get timeoutMinutes() { return (expiresAt - startedAt) / 60_000; },
    get description() { return timeoutDescription(expiresAt - startedAt); },
  };
  const onAbort = () => deadline.dispose();
  function arm() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (disposed || controller.signal.aborted) return;
      const reason = Object.assign(new Error(deadline.description), {
        code: QUEUE_RUN_TIMEOUT_REASON,
        timeoutMs: deadline.timeoutMs,
      });
      deadline.dispose();
      try { onTimeout(); } finally { controller.abort(reason); }
    }, Math.max(1, expiresAt - Date.now()));
  }
  if (!disposed) {
    queueDeadlines.set(controller.signal, deadline);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    arm();
  }
  return deadline;
}

/** Abort through the existing signal so runtime can persist Trace/checkpoint before settling. */
export function armQueueTaskTimeout(controller: AbortController, onTimeout: () => void): NodeJS.Timeout {
  return setTimeout(() => {
    onTimeout();
    controller.abort(new Error(QUEUE_RUN_TIMEOUT_REASON));
  }, QUEUE_RUN_TIMEOUT_MS);
}
