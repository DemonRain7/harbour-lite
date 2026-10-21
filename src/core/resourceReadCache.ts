import type { ToolContext } from "../types";

const KEY = "resource-reads:v1";

/** Only delivery hints, never business state. A batch retains its generation's
 * Set: compaction during an async read cannot repopulate the new generation. */
export function resourceReadCache(ctx: Pick<ToolContext, "runState">): Set<string> | undefined {
  if (!ctx.runState) return;
  let seen = ctx.runState.get(KEY) as Set<string> | undefined;
  if (!seen) { seen = new Set(); ctx.runState.set(KEY, seen); }
  return seen;
}

export function invalidateResourceReads(ctx: Pick<ToolContext, "runState" | "logger"> | undefined, reason: string): void {
  const seen = ctx?.runState?.get(KEY) as Set<string> | undefined;
  if (!seen) return;
  ctx!.runState!.delete(KEY);
  ctx!.logger.info({ reason, resources: seen.size }, "context:resource-reads-invalidated");
}
