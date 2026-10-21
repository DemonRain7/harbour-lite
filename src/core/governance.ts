import type { Agent } from "../types";

/**
 * Governance —— 每个 agent 的治理策略执行点（无状态纯函数，读 agent.governance）。
 *
 * 来自 agent 文件夹 CLAUDE.md 的 frontmatter.governance：
 *   { temperature, allowedModels[], maxTokensPerRun, permissions }
 *
 * 在 agentLoop 里：
 *  - checkModel：router 选出的 modelRef 不在 allowedModels（非空）里就报错。
 *  - governanceTemperature：透传给后端（openrouter 生效；claude-agent SDK 暂不支持，会被忽略）。
 *  - governanceMaxTokens：loop 内累计 token 估算超限即收尾。
 */

/** 校验模型白名单；越界抛清晰错误。 */
export function checkModel(agent: Agent, modelRef: string): void {
  const allowed = agent.governance?.allowedModels;
  if (allowed && allowed.length > 0 && !allowed.includes(modelRef)) {
    throw new Error(
      `governance: agent「${agent.name}」不允许使用模型 ${modelRef}（白名单: ${allowed.join(", ")}）`
    );
  }
}

export function governanceTemperature(agent: Agent): number | undefined {
  return agent.governance?.temperature;
}

export function governanceMaxTokens(agent: Agent): number | undefined {
  return agent.governance?.maxTokensPerRun;
}

export interface GovernanceTokenBudget {
  mode: "hard" | "converge";
  softTokens?: number;
  hardTokens?: number;
}

export interface TokenUsageBuckets {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
}

function usageToken(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value ?? 0)) : 0;
}

/**
 * 软收敛线衡量本轮真正新增的工作量。缓存命中仍完整进入 Metrics/成本与硬保险丝，
 * 但不能仅因重复读取同一段已缓存上下文就向模型插入“赶快收尾”的控制消息。
 */
export function convergenceUsageTokens(usage: TokenUsageBuckets | undefined): number {
  if (!usage) return 0;
  return usageToken(usage.promptTokens) + usageToken(usage.completionTokens) +
    usageToken(usage.cacheCreationTokens);
}

/** 硬保险丝与账本使用完整供应商用量，包括缓存命中。 */
export function totalUsageTokens(usage: TokenUsageBuckets | undefined): number {
  return convergenceUsageTokens(usage) + usageToken(usage?.cachedTokens);
}

/**
 * 普通 Agent 保持旧语义：maxTokensPerRun 是硬上限。浏览器这类长事务可显式选择
 * converge，把同一个数字改成软收敛线；只有显式配置 hardMaxTokensPerRun 时才再加
 * token 硬保险丝，避免把缓存命中量很大的浏览器任务意外截断。
 */
export function governanceTokenBudget(agent: Agent): GovernanceTokenBudget | undefined {
  const budget = agent.governance?.maxTokensPerRun;
  if (budget === undefined) return undefined;
  const mode = agent.governance?.tokenBudgetMode ?? "hard";
  if (mode === "hard") return { mode, hardTokens: budget };
  const configuredHard = agent.governance?.hardMaxTokensPerRun;
  return {
    mode,
    softTokens: budget,
    ...(configuredHard === undefined ? {} : { hardTokens: configuredHard }),
  };
}
