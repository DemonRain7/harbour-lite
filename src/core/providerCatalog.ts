import type { ModelSlot } from "./modelSlots";

export type ModelRuntimeId = "claude-agent-sdk" | "codex-app-server" | "dsh-harness";
export type ModelTransportId = "anthropic-messages" | "codex-app-server";
export type ModelAuthMode = "env-bearer" | "env-x-api-key" | "chatgpt-oauth";

export interface ModelConnectionPresentation {
  providerId: string;
  providerLabel: string;
  providerShortLabel: string;
  providerIcon: string;
  providerWebsite?: string;
  providerAccent: string;
  runtimeId: ModelRuntimeId;
  runtimeLabel: string;
  transportId: ModelTransportId;
  transportLabel: string;
  /** 只用于解释语义；Codex App Server 不是可编辑的 /responses URL。 */
  apiFamily: "anthropic" | "responses";
  authMode: ModelAuthMode;
  authLabel: string;
  editable: boolean;
}

interface ProviderDefinition {
  id: string;
  label: string;
  shortLabel: string;
  icon: string;
  accent: string;
  website?: string;
  hosts?: string[];
}

const PROVIDERS: ProviderDefinition[] = [
  { id: "deepseek", label: "DeepSeek", shortLabel: "DS", icon: "/assets/providers/deepseek.svg", accent: "#4f7cff", website: "https://www.deepseek.com/", hosts: ["api.deepseek.com"] },
  { id: "kimi-code", label: "Kimi Code", shortLabel: "KIMI", icon: "/assets/providers/kimi.svg", accent: "#6f63e8", website: "https://www.kimi.com/code", hosts: ["api.kimi.com"] },
  { id: "moonshot", label: "Moonshot AI", shortLabel: "MOON", icon: "/assets/providers/moonshot.svg", accent: "#8b5cf6", website: "https://platform.moonshot.cn/", hosts: ["api.moonshot.cn"] },
  { id: "openai", label: "OpenAI", shortLabel: "OA", icon: "/assets/providers/openai.svg", accent: "#10a37f", website: "https://openai.com/", hosts: ["api.openai.com"] },
  { id: "anthropic", label: "Anthropic", shortLabel: "AN", icon: "/assets/providers/anthropic.svg", accent: "#d97745", website: "https://www.anthropic.com/", hosts: ["api.anthropic.com"] },
  { id: "openrouter", label: "OpenRouter", shortLabel: "OR", icon: "/assets/providers/openrouter.svg", accent: "#6b7280", website: "https://openrouter.ai/", hosts: ["openrouter.ai"] },
  { id: "custom", label: "Custom Endpoint", shortLabel: "API", icon: "/assets/providers/custom.svg", accent: "#8b8190" },
];

function hostname(baseURL: string): string {
  try { return new URL(baseURL).hostname.toLowerCase(); } catch { return ""; }
}

function providerFor(
  slot: Pick<ModelSlot, "id" | "baseURL" | "model">,
  kind: "claude-agent" | "codex-harness" | "dsh-harness"
): ProviderDefinition {
  if (kind === "codex-harness") return PROVIDERS.find((provider) => provider.id === "openai")!;
  const host = hostname(slot.baseURL);
  const matched = PROVIDERS.find((provider) => provider.hosts?.some((candidate) => host === candidate || host.endsWith(`.${candidate}`)));
  if (matched) return matched;
  const hint = `${slot.id} ${slot.model}`.toLowerCase();
  if (hint.includes("deepseek")) return PROVIDERS.find((provider) => provider.id === "deepseek")!;
  if (hint.includes("kimi") || hint.includes("moonshot")) return PROVIDERS.find((provider) => provider.id === "moonshot")!;
  if (hint.includes("claude")) return PROVIDERS.find((provider) => provider.id === "anthropic")!;
  if (/\b(gpt|o[1-9]|codex)\b/u.test(hint)) return PROVIDERS.find((provider) => provider.id === "openai")!;
  return PROVIDERS.find((provider) => provider.id === "custom")!;
}

/** Runtime、网络协议与认证三层只读说明；不改变任何真实路由或持久化配置。 */
export function modelConnectionPresentation(
  slot: Pick<ModelSlot, "id" | "baseURL" | "model" | "keyKind">,
  kind: "claude-agent" | "codex-harness" | "dsh-harness"
): ModelConnectionPresentation {
  const provider = providerFor(slot, kind);
  if (kind === "codex-harness") {
    return {
      providerId: provider.id,
      providerLabel: provider.label,
      providerShortLabel: provider.shortLabel,
      providerIcon: provider.icon,
      providerWebsite: provider.website,
      providerAccent: provider.accent,
      runtimeId: "codex-app-server",
      runtimeLabel: "Codex Harness",
      transportId: "codex-app-server",
      transportLabel: "App Server · Responses 语义",
      apiFamily: "responses",
      authMode: "chatgpt-oauth",
      authLabel: "ChatGPT OAuth",
      editable: false,
    };
  }
  const apiKey = kind === "dsh-harness" || slot.keyKind === "api";
  return {
    providerId: provider.id,
    providerLabel: provider.label,
    providerShortLabel: provider.shortLabel,
    providerIcon: provider.icon,
    providerWebsite: provider.website,
    providerAccent: provider.accent,
    runtimeId: kind === "dsh-harness" ? "dsh-harness" : "claude-agent-sdk",
    runtimeLabel: kind === "dsh-harness" ? "DSH" : "Claude SDK",
    transportId: "anthropic-messages",
    transportLabel: "Anthropic Messages",
    apiFamily: "anthropic",
    authMode: apiKey ? "env-x-api-key" : "env-bearer",
    authLabel: apiKey ? "x-api-key · .env" : "Bearer · .env",
    editable: kind !== "dsh-harness",
  };
}

export function providerCatalog(): Omit<ProviderDefinition, "hosts">[] {
  return PROVIDERS.map(({ hosts: _hosts, ...provider }) => provider);
}
