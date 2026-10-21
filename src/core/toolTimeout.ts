import type { ToolContext, ToolDef } from "../types";

/** All backends must apply the same trusted per-call timeout before executing a tool. */
export function resolveToolTimeoutMs(tool: ToolDef, args: Record<string, unknown>, ctx: ToolContext, fallback: number): number;
export function resolveToolTimeoutMs(tool: ToolDef, args: Record<string, unknown>, ctx: ToolContext, fallback?: number): number | undefined;
export function resolveToolTimeoutMs(tool: ToolDef, args: Record<string, unknown>, ctx: ToolContext, fallback?: number): number | undefined {
  const ms = tool.timeoutMsFor?.(args, ctx) ?? tool.timeoutMs ?? fallback;
  if (ms !== undefined && (!Number.isFinite(ms) || ms <= 0 || ms > 2_147_483_647)) {
    throw new Error(`Invalid timeout policy for tool ${tool.name}`);
  }
  return ms;
}

/**
 * A deadline must cancel this invocation, not only stop awaiting it. Composite
 * tools use the derived signal between subcommands; the run/other tools retain
 * their parent signal. Cancellation does not prove an external write was safe.
 */
export function executeWithToolDeadline<T>(
  ctx: ToolContext,
  timeoutMs: number | undefined,
  message: string,
  run: (ctx: ToolContext) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const parents = [...new Set([ctx.signal, parentSignal].filter((signal): signal is AbortSignal => !!signal))];
  const stopped = parents.find((signal) => signal.aborted);
  if (stopped) return Promise.reject(stopped.reason ?? new Error("run aborted"));
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)) {
    return Promise.reject(new Error("Invalid tool deadline"));
  }

  const controller = new AbortController();
  // Some tools initialize this map lazily. A detached map would lose once keys
  // and other evidence on the following invocation of the same tool.
  ctx.runState ??= new Map();
  const derived = { ...ctx, signal: controller.signal };
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      for (const signal of parents) signal.removeEventListener("abort", abortFromParent);
    };
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      finish();
    };
    const cancel = (reason: unknown) => settle(() => {
      controller.abort(reason);
      reject(reason);
    });
    const abortFromParent = () => {
      const parent = parents.find((signal) => signal.aborted);
      cancel(parent?.reason ?? new Error("run aborted"));
    };
    for (const signal of parents) signal.addEventListener("abort", abortFromParent, { once: true });
    if (timeoutMs !== undefined) timer = setTimeout(() => cancel(new Error(message)), timeoutMs);

    // Recheck immediately before startup: the parent may stop while this call
    // is queued as a microtask. Always observe the underlying rejection even
    // if the caller has already received its timeout.
    Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return run(derived);
    }).then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}
