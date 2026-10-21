import type { ModelSlot } from "./modelSlots";
import type { RuntimeModelSlot } from "../runtime";
import { inferModelCapabilities } from "./modelCapabilities";

export const DSH_BACKEND = "dsh-harness";
export const DSH_VERSION = "0.2.0-rc.2";
export const DSH_EFFORTS = ["off", "low", "high", "max"] as const;

/** Credentials can only be reused for the same official host, never a custom gateway. */
export function dshSourceSlot(slots: readonly ModelSlot[]): ModelSlot | undefined {
  return slots.find(slot => {
    try {
      const url = new URL(slot.baseURL);
      return url.origin === "https://api.deepseek.com" && !url.username && !url.password
        && ["", "/", "/anthropic", "/anthropic/"].includes(url.pathname)
        && !url.search && !url.hash;
    } catch { return false; }
  });
}

/** Derived only; never saved to models.json or any fallback chain. */
export function dshVirtualSlot(source: ModelSlot, index: number): RuntimeModelSlot {
  const models = source.models.filter(m => /^deepseek-/i.test(m.id) && !/vision|\[/i.test(m.id)).map(m => ({
    ...m, label: `${m.label || m.id} · DSH`, capabilities: inferModelCapabilities(m.id),
    defaultReasoningEffort: "high" as const,
    supportedReasoningEfforts: DSH_EFFORTS.map(effort => ({ effort, description: `DSH 原生 ${effort}` })),
  }));
  const model = models.some(m => m.id === source.model) ? source.model : models[0]?.id ?? "deepseek-flash";
  return { ...source, id: "dsh-experiment", label: "DeepSeek · DSH", model, models,
    backendKey: DSH_BACKEND, modelRef: `${DSH_BACKEND}/${model}`, index, kind: "dsh-harness" };
}
