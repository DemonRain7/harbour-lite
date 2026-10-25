import type { ReasoningEffort } from "../../types";
import { isNativeAnthropicEndpoint } from "../anthropicModels";
import { EFFORT_BUDGET } from "../modelConfigStore";
import { isOfficialDeepSeekAnthropicEndpoint } from "./deepseekCache";

/** Shared by Web/Electron and QQ/Discord. Do not advertise native max for unknown gateways. */
export function claudeSdkEffortOptions(baseURL: string): Array<{ effort: ReasoningEffort; description: string }> {
  if (isNativeAnthropicEndpoint(baseURL)) return ["low", "medium", "high", "xhigh", "max"].map(effort => ({
    effort: effort as ReasoningEffort, description: `Claude 原生 effort：${effort}`,
  }));
  const options: Array<{ effort: ReasoningEffort; description: string }> = [
    { effort: "off", description: "尽量关闭或减少扩展思考" },
    { effort: "low", description: "约 2K thinking token" },
    { effort: "medium", description: "约 8K thinking token" },
    { effort: "high", description: "约 16K thinking token" },
  ];
  if (isOfficialDeepSeekAnthropicEndpoint(baseURL)) {
    options.push({ effort: "max", description: "DeepSeek 原生最大思考强度" });
  }
  return options;
}

/** Translate Harbour's discrete budgets to native Claude effort levels. */
export function nativeClaudeEffort(thinkingBudget: number): "low" | "medium" | "high" | "xhigh" | "max" {
  if (thinkingBudget >= EFFORT_BUDGET.max) return "max";
  if (thinkingBudget >= EFFORT_BUDGET.xhigh) return "xhigh";
  if (thinkingBudget >= EFFORT_BUDGET.high) return "high";
  if (thinkingBudget >= EFFORT_BUDGET.medium) return "medium";
  return "low";
}

/** DeepSeek max needs the SDK native effort in addition to its compatibility budget. */
export function claudeSdkEffortEnv(baseURL: string, thinkingBudget?: number): Record<string, string> {
  return isOfficialDeepSeekAnthropicEndpoint(baseURL)
    && Number.isFinite(thinkingBudget) && thinkingBudget! >= EFFORT_BUDGET.max
    ? { CLAUDE_CODE_EFFORT_LEVEL: "max" }
    : {};
}
