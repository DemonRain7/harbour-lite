import type { ReasoningEffort } from "../../types";
import { EFFORT_BUDGET } from "../modelConfigStore";
import { isOfficialDeepSeekAnthropicEndpoint } from "./deepseekCache";

/** Shared by Web/Electron and QQ/Discord. Do not advertise native max for unknown gateways. */
export function claudeSdkEffortOptions(baseURL: string): Array<{ effort: ReasoningEffort; description: string }> {
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

/** DeepSeek ignores thinking.budget_tokens; max must also reach Claude Code's native effort. */
export function claudeSdkEffortEnv(baseURL: string, thinkingBudget?: number): Record<string, string> {
  return isOfficialDeepSeekAnthropicEndpoint(baseURL)
    && Number.isFinite(thinkingBudget) && thinkingBudget! >= EFFORT_BUDGET.max
    ? { CLAUDE_CODE_EFFORT_LEVEL: "max" }
    : {};
}
