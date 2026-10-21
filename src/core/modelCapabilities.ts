/** 模型能力只描述 Harbour 能安全依赖的输入类型；未知模型一律保守判定。 */
export type ModelCapability = "vision";

export interface CapabilityModelLike {
  id: string;
  enabled?: boolean;
  available?: boolean;
  capabilities?: ModelCapability[];
}

export interface CapabilitySlotLike {
  backendKey: string;
  models: CapabilityModelLike[];
}

/**
 * 目录接口通常只返回 model id、不返回能力。这里仅识别名字明确或官方命名稳定的视觉模型；
 * 模糊型号不猜，避免把图片静默交给纯文本模型后产生幻觉。
 */
export function inferModelCapabilities(modelId: string): ModelCapability[] {
  const id = String(modelId || "").toLowerCase();
  if (!id) return [];
  const explicitVision = /(?:^|[-_.])(?:vision|vl|omni)(?:[-_.]|$)/i.test(id);
  const modernClaude = /^claude-(?:3(?:[-_.]|$)|(?:sonnet|opus|haiku)-4(?:[-_.]|$))/i.test(id);
  const openAiMultimodal = /^(?:gpt-4o|gpt-4\.1|gpt-5)(?:[-_.]|$)/i.test(id);
  const geminiMultimodal = /^gemini-(?:1\.5|2|3)(?:[-_.]|$)/i.test(id);
  // Official V4.1 Flash supports native images; do not infer vision for V4 Pro.
  const deepseekMultimodal = /^deepseek-flash(?:\[1m\])?$/.test(id);
  return explicitVision || modernClaude || openAiMultimodal || geminiMultimodal || deepseekMultimodal ? ["vision"] : [];
}

export function modelSupportsVision(modelId: string, capabilities?: readonly string[]): boolean {
  return capabilities?.includes("vision") === true || inferModelCapabilities(modelId).includes("vision");
}

export function modelIdFromRef(modelRef: string): string {
  const slash = String(modelRef || "").indexOf("/");
  return slash >= 0 ? modelRef.slice(slash + 1) : modelRef;
}

export function modelRefSupportsVision(modelRef: string, slots: readonly CapabilitySlotLike[]): boolean {
  const slash = modelRef.indexOf("/");
  const backendKey = slash >= 0 ? modelRef.slice(0, slash) : "";
  const modelId = modelIdFromRef(modelRef);
  const entry = slots.find((slot) => slot.backendKey === backendKey)?.models.find((model) => model.id === modelId);
  return modelSupportsVision(modelId, entry?.capabilities);
}

/**
 * 图片任务优先留在当前连接，避免无谓跨 key/provider；当前连接没有视觉模型才找其它槽。
 * Codex 是显式旁路：普通请求不进入它，选择 Codex 时也不替用户换型号或连接。
 * 返回 undefined 表示 Harbour 没有可确认的视觉模型，调用方必须 fail closed。
 */
export function resolveVisionModelRef(
  requestedModelRef: string,
  slots: readonly CapabilitySlotLike[]
): string | undefined {
  const slash = requestedModelRef.indexOf("/");
  const requestedBackend = slash >= 0 ? requestedModelRef.slice(0, slash) : "";
  if (requestedBackend === "codex-app-server" || requestedBackend === "dsh-harness") {
    const modelId = modelIdFromRef(requestedModelRef);
    const entry = slots.find((slot) => slot.backendKey === requestedBackend)?.models.find((model) => model.id === modelId);
    if (entry?.enabled === false || entry?.available === false) return undefined;
    // Codex model/list 明确声明的输入能力优先于名称推断；空数组不能因 GPT 前缀变成支持视觉。
    const supportsVision = entry?.capabilities !== undefined
      ? entry.capabilities.includes("vision")
      : modelSupportsVision(modelId);
    return supportsVision ? requestedModelRef : undefined;
  }
  if (modelRefSupportsVision(requestedModelRef, slots)) return requestedModelRef;
  const eligibleSlots = slots.filter((slot) => slot.backendKey !== "codex-app-server" && slot.backendKey !== "dsh-harness");
  const ordered = [
    ...eligibleSlots.filter((slot) => slot.backendKey === requestedBackend),
    ...eligibleSlots.filter((slot) => slot.backendKey !== requestedBackend),
  ];
  for (const slot of ordered) {
    const model = slot.models.find((entry) =>
      entry.enabled !== false && entry.available !== false && modelSupportsVision(entry.id, entry.capabilities)
    );
    if (model) return `${slot.backendKey}/${model.id}`;
  }
  return undefined;
}
