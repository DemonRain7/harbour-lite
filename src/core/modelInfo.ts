import type { Env } from "../config/env";

/**
 * 模型窗口与 Harbour 上下文策略的共同解析入口。
 * 精确连接目录优先；内置型号/家族值只在目录缺少窗口时兜底，不代表端点承诺。
 */
export function contextWindowForModel(model: string): number {
  const m = (model || "").toLowerCase();
  // Exact known model fallback; live connection metadata always wins below.
  // https://developers.openai.com/api/docs/models/gpt-6-astra
  if (/^gpt-6-astra(?:$|-)/.test(m)) return 1_050_000;
  // DeepSeek V4.1 Flash uses the unversioned official API name.
  if (/^deepseek-flash(?:\[1m\])?$/.test(m)) return 1_000_000;
  if (m.includes("deepseek-v4")) return 1000000;
  if (m.includes("kimi") || m.includes("moonshot") || m.includes("k2")) return 262144; // Kimi K2 系列 256K
  if (m.includes("claude") || m.includes("sonnet") || m.includes("opus") || m.includes("haiku")) return 200000; // Claude 200K
  if (m.includes("minimax")) return 1000000;
  if (m.includes("gemini")) return 1000000;
  if (m.includes("gpt") || m.includes("o1") || m.includes("o3")) return 128000;
  return 200000; // 兜底
}

/** Structural type also accepts the old { modelRef, model } callers. */
export interface ContextModelSlot {
  modelRef: string;
  model: string;
  backendKey?: string;
  index?: number;
  id?: string;
  kind?: string;
  models?: ReadonlyArray<{ id: string; contextWindow?: number }>;
}

function slotForRef(modelRef: string, slots: readonly ContextModelSlot[] = []): ContextModelSlot | undefined {
  const backend = modelRef.split("/")[0];
  const exact = slots.find((slot) => slot.backendKey === backend || slot.modelRef === modelRef);
  if (exact) return exact;
  // Positional compatibility aliases refer to the current connection, not stale .env defaults.
  const ordinary = slots.filter((slot) => slot.kind !== "codex-harness");
  if (backend === "claude-agent") return ordinary.find((slot) => slot.index === 0) ?? ordinary[0];
  if (backend === "claude-agent-fallback") return ordinary.find((slot) => slot.index === 1 && slot.id === "fallback");
  if (backend?.startsWith("claude-agent-")) return ordinary.find((slot) => `claude-agent-${slot.id}` === backend);
  return undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
}

/**
 * 把 router 的 modelRef（如 "claude-agent/default"）解析成【实际下发给端点】的模型名。
 * default 来自当前连接；显式型号不能被连接默认值覆盖。仅旧式无目录调用才回退 .env。
 */
export function actualModelName(
  modelRef: string,
  env: Env,
  slots?: readonly ContextModelSlot[]
): string {
  // 任意 N 槽启用后，claude-agent/default 的真实模型由当前第 0 槽决定，不能再只看
  // ANTHROPIC_* 旧变量。否则 Settings 把 DeepSeek 切成主 API 后，context window 仍会被
  // 当作 Kimi 256K，压缩触发线与界面都会算错。
  const slot = slotForRef(modelRef, slots);
  const requested = modelRef.includes("/") ? modelRef.slice(modelRef.indexOf("/") + 1) : modelRef;
  if (slot) return requested && requested !== "default" ? requested : slot.model;
  if (modelRef.startsWith("claude-agent-fallback")) return env.ANTHROPIC_FALLBACK_MODEL || env.CLAUDE_AGENT_MODEL;
  if (modelRef.startsWith("claude-agent")) return env.CLAUDE_AGENT_MODEL;
  return modelRef.includes("/") ? modelRef.slice(modelRef.indexOf("/") + 1) : modelRef;
}

/** 便捷：给定 router modelRef + env，直接得实际模型的 context window。 */
export function contextWindowForRef(
  modelRef: string,
  env: Env,
  slots?: readonly ContextModelSlot[]
): number {
  return modelContextInfo(modelRef, env, slots).contextWindow;
}

/** One resolver for the picker, session display and runtime preflight. Never borrow another slot's limits. */
export function modelContextInfo(modelRef: string, env: Env, slots?: readonly ContextModelSlot[]) {
  const slot = slotForRef(modelRef, slots);
  const model = actualModelName(modelRef, env, slots);
  const catalogWindow = positiveInt(slot?.models?.find((entry) => entry.id === model)?.contextWindow);
  return {
    contextModelRef: slot?.backendKey ? `${slot.backendKey}/${model}` : modelRef,
    contextWindow: catalogWindow ?? contextWindowForModel(model),
    contextWindowSource: catalogWindow ? "catalog" as const : "fallback" as const,
  };
}

/** Model capacity != Harbour's input budget != compaction trigger. Switching does not change agent policy. */
export function modelContextPolicy(
  modelRef: string,
  env: Env,
  slots: readonly ContextModelSlot[] | undefined,
  agentBudget: number | "auto",
  compactTokens?: number | null,
) {
  const info = modelContextInfo(modelRef, env, slots);
  const configuredContextBudget = positiveInt(agentBudget) ?? null;
  const contextBudgetMode = configuredContextBudget === null ? "auto" as const : "manual" as const;
  const contextBudget = configuredContextBudget ?? info.contextWindow;
  // Cross-provider safety allowance, not an exact tokenizer/output-max guarantee.
  const reservedOutputTokens = Math.min(info.contextWindow - 1, Math.ceil(info.contextWindow * 0.05));
  const contextLimit = Math.max(1, Math.min(contextBudget, info.contextWindow - reservedOutputTokens));
  const modelOverride = positiveInt(compactTokens);
  const environmentOverride = positiveInt(env.SESSION_COMPACT_TOKENS);
  const compactSource = modelOverride ? "model" as const : environmentOverride ? "environment" as const : "window-ratio" as const;
  const compactRequestedTokens = modelOverride ?? environmentOverride ?? Math.floor(Math.min(contextBudget, info.contextWindow) * 0.8);
  const compactAtTokens = Math.max(1, Math.min(compactRequestedTokens, Math.floor(contextLimit * 0.95)));
  return { ...info, contextBudget, contextLimit, compactAtTokens, contextBudgetMode,
    configuredContextBudget, reservedOutputTokens, compactSource, compactRequestedTokens,
    compactClamped: compactAtTokens !== compactRequestedTokens };
}
