import { promises as fs } from "node:fs";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { SaveTextSpill } from "@deepseek-ai/dsh-spill";
import type { ToolContext, ToolDef } from "../../types";
import { resolveRead } from "../permissions";
import { DSH_DEFAULT_SPILL_INLINE_TOKENS } from "../dshLimits";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_FACT_BYTES = 8_192;
const VERBATIM_TOOLS = new Set(["read_file", "read_skill", "read_workflow", "read_mcp"]);
const importEsm = new Function("name", "return import(name)") as <T>(name: string) => Promise<T>;
const writes = new Map<string, Promise<unknown>>();

async function serialWrite<T>(directory: string, write: () => Promise<T>): Promise<T> {
  const next = (writes.get(directory) ?? Promise.resolve()).catch(() => {}).then(write);
  writes.set(directory, next);
  try { return await next; }
  finally { if (writes.get(directory) === next) writes.delete(directory); }
}

// Keep control/settlement fields separate from bulk bodies. This is extraction,
// not an LLM summary or a claim that a tool's reported outcome was verified.
const FACT_KEYS = new Set([
  "status", "ok", "success", "executed", "error", "errorCode", "reason", "reasonCode", "exitCode",
  "jobId", "taskRef", "draftId", "inputRef", "operationId", "callId", "workflow", "action",
  "chargeState", "visibleSpentAnlas", "maxTotalAnlas", "costAnlas", "cost", "spent", "budget",
  "nextAction", "nextActions", "retrySafety", "recoverable", "terminal", "completed", "total",
  "submitted", "verified", "unknownSideEffects", "needsInput", "path", "file", "files", "artifacts",
  "url", "urls", "deliveryUrls", "deliveryArtifacts", "warnings", "outputTruncated", "truncated",
]);
const NESTED_KEYS = new Set(["result", "data", "receipt", "summary", "job", "task", "execution", "recovery"]);

/** Undefined means control facts cannot be safely kept small: keep the original result. */
export function spillFacts(text: string): string | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return ""; }
  const walk = (row: unknown, depth: number): Record<string, unknown> => {
    if (typeof row === "string" && depth < 4) {
      try { row = JSON.parse(row); } catch { return {}; }
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) return {};
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(row)) {
      if (FACT_KEYS.has(key)) out[key] = item;
      else if (NESTED_KEYS.has(key) && depth < 4) {
        const nested = walk(item, depth + 1);
        if (Object.keys(nested).length) out[key] = nested;
      }
    }
    return out;
  };
  const facts = walk(value, 0);
  if (!Object.keys(facts).length) return "";
  const encoded = JSON.stringify(facts);
  return Buffer.byteLength(encoded) <= MAX_FACT_BYTES ? encoded : undefined;
}

/** Reject redirected directories; only the runtime chooses this root, never a model argument. */
async function privateDirectory(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fs.mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe spill directory");
  }
}

/** Official plugins, restricted to recoverable Harbour text results. No native filesystem tool. */
export async function mountDshSpill(ctx: Context, options: {
  toolContext?: ToolContext;
  tools: ToolDef[];
  sessionId: string;
  root: string;
  maxInlineTokens?: number;
}): Promise<void> {
  const context = options.toolContext;
  const cap = options.maxInlineTokens ?? DSH_DEFAULT_SPILL_INLINE_TOKENS;
  const reader = options.tools.find(tool => tool.name === "read_file" && tool.readOnly);
  const properties = reader?.parameters.properties as Record<string, unknown> | undefined;
  // Do not turn a local-only path into a Cowork device path, grant a new tool,
  // or replace content when the current agent cannot recover it.
  if (!context || context.source?.actor?.role === "other" || context.execution?.cowork
    || !reader || !properties?.offset || !properties?.limit || !Number.isSafeInteger(cap) || cap <= 0) return;
  const root = path.resolve(options.root);
  try { resolveRead(context, root); } catch { return; }
  const [local, policy] = await Promise.all([
    importEsm<typeof import("@deepseek-ai/dsh-spill-local")>("@deepseek-ai/dsh-spill-local"),
    importEsm<typeof import("@deepseek-ai/dsh-spill-policy")>("@deepseek-ai/dsh-spill-policy"),
  ]);
  const saved = new Set<string>();
  class HarbourSpillStore extends local.LocalSpillStore {
    override async saveText(input: SaveTextSpill) {
      try {
        if (input.owner.sessionId !== options.sessionId || input.source.kind !== "tool") throw new Error("invalid spill owner");
        const source = input.source;
        const bytes = Buffer.byteLength(input.content);
        if (bytes > MAX_FILE_BYTES) throw new Error("spill result too large");
        const directory = local.sessionDir(root, input.owner.sessionId);
        return await serialWrite(directory, async () => {
          resolveRead(context!, directory);
          await privateDirectory(directory);
          // Retain references across runs/restarts; bound storage instead of deleting
          // files which an existing checkpoint may still need.
          const entries = await fs.readdir(directory, { withFileTypes: true });
          if (entries.length >= 256) throw new Error("spill session quota reached");
          let storedBytes = 0;
          for (const entry of entries) {
            if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("unexpected spill entry");
            storedBytes += (await fs.lstat(path.join(directory, entry.name))).size;
          }
          if (storedBytes + bytes > MAX_SESSION_BYTES) throw new Error("spill session quota reached");
          const ref = await super.saveText(input);
          // Confirm that the exact generated path is readable before shortening anything.
          const file = resolveRead(context!, ref.locator);
          const handle = await fs.open(file, "r");
          try { if ((await handle.stat()).size !== bytes) throw new Error("spill write incomplete"); }
          finally { await handle.close(); }
          saved.add(source.callId);
          context!.logger.info({ agent: context!.agent.name, tool: source.toolName, bytes }, "loop:dsh-spill");
          return { ...ref, retrievalHint: `Use Harbour read_file with path=${JSON.stringify(ref.locator)}, offset=0, limit=8000. Continue with nextOffset only if needed; do not repeat the producing tool.` };
        });
      } catch {
        // No payload, user path or host filesystem error in the plugin's warning.
        throw new Error("Harbour spill storage unavailable or bounded quota reached; keep original result");
      }
    }
  }
  // The official default also sweeps OTHER dsh-spill-* temp roots. Explicitly
  // disable that: Harbour must not delete other processes' artifacts or old references.
  await ctx.plugin(HarbourSpillStore, { root, cleanupPeriodDays: 0 });
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    if (decision.kind !== "accept" || result.isError || Object.hasOwn(decision, "value")) return decision;
    const content = decision.content ?? result.content;
    const text = content.map(block => block.type === "text" ? block.text : "").join("");
    // Our image handles stay in the existing native pixel lane; never replace
    // them with DSH read_image paths (that native tool is deliberately absent).
    // Capability contracts are lazily loaded once: do not mark a skill/schema
    // as loaded while silently replacing its instructions with a partial preview.
    if (VERBATIM_TOOLS.has(exec.name) || content.some(block => block.type !== "text") || spillFacts(text) === undefined)
      return { kind: "accept", value: result.value, ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}) };
    return decision;
  });
  await ctx.plugin(policy, { maxInlineTokens: cap });
  ctx.on("tools/post-execute", async (exec, result, next) => {
    saved.delete(exec.callId);
    const decision = await next();
    if (!saved.delete(exec.callId) || decision.kind !== "accept" || !decision.content) return decision;
    const text = result.content.map(block => block.type === "text" ? block.text : "").join("");
    const facts = spillFacts(text);
    if (!facts) return decision;
    return { ...decision, content: [{ type: "text", text: `[Harbour 保留的工具回执字段；仅为原工具报告，不是独立成功证明]\n${facts}\n\n` }, ...decision.content] };
  }, { prepend: true });
}
