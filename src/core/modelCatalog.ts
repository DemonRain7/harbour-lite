import type { Logger } from "pino";
import { contextWindowForModel } from "./modelInfo";
import type { ModelSlot, SlotModel } from "./modelSlots";
import { inferModelCapabilities } from "./modelCapabilities";

export interface CatalogRefreshResult {
  ok: boolean;
  slot: ModelSlot;
  added: number;
  models: string[];
  skipped?: boolean;
  error?: string;
}

/**
 * 目录发现只走 Provider 的确定性 /models 接口，不经过 LLM。
 * 已知 Anthropic 兼容入口会转换到同厂的 OpenAI models 入口；没有可靠目录接口的端点
 * 返回 null，保留用户手工配置，绝不猜 URL 把 key 发往别处。
 */
function catalogUrl(slot: ModelSlot): string | null {
  let u: URL;
  try { u = new URL(slot.baseURL); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (host === "api.deepseek.com") return `${u.origin}/v1/models`;
  if (host === "api.moonshot.cn") return `${u.origin}/v1/models`;
  if (host === "openrouter.ai") return `${u.origin}/api/v1/models`;
  // Kimi Code 会员端点只有 kimi-for-coding 虚拟模型，不能拿具体型号目录替换它。
  if (host === "api.kimi.com") return null;
  // 对明确的 OpenAI /v1 或 /api/v1 base 才按标准拼接；Anthropic/其它路径不猜。
  const p = u.pathname.replace(/\/+$/, "");
  if (p.endsWith("/v1") || p.endsWith("/api/v1")) return `${u.origin}${p}/models`;
  return null;
}

export async function refreshModelCatalogForSlot(
  slot: ModelSlot,
  key: string,
  logger?: Logger
): Promise<CatalogRefreshResult> {
  const url = catalogUrl(slot);
  const at = new Date().toISOString();
  if (!url) {
    return { ok: true, skipped: true, slot, added: 0, models: slot.models.map((m) => m.id) };
  }
  if (!key) {
    const error = "模型槽尚未配置 key";
    return { ok: false, slot: { ...slot, catalog: { ...slot.catalog, updatedAt: at, source: url, error } }, added: 0, models: [], error };
  }

  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    if (slot.keyKind === "api") headers["x-api-key"] = key;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`模型目录返回 HTTP ${res.status}`);
    const json = await res.json() as { data?: Array<{ id?: unknown }> };
    const ids = [...new Set((json.data ?? []).map((m) => String(m.id ?? "").trim()).filter(Boolean))].sort();
    if (!ids.length) throw new Error("模型目录返回空列表");

    const old = new Map(slot.models.map((m) => [m.id, m]));
    const discovered = new Set(ids);
    const next: SlotModel[] = [];
    // Provider 当前返回的模型排在前面；保留用户之前的 enabled/label 选择。
    for (const id of ids) {
      const prev = old.get(id);
      next.push({
        id,
        ...(prev?.label ? { label: prev.label } : {}),
        enabled: prev?.enabled !== false,
        available: true,
        source: prev?.source ?? "discovered",
        contextWindow: prev?.contextWindow ?? contextWindowForModel(id),
        capabilities: prev?.capabilities ?? inferModelCapabilities(id),
      });
    }
    // 已配置但上游不再返回的模型不删除：标 unavailable，让 UI 明示下线且保留历史含义。
    for (const prev of slot.models) {
      if (!discovered.has(prev.id)) next.push({ ...prev, available: false });
    }
    const added = ids.filter((id) => !old.has(id)).length;
    const updated: ModelSlot = { ...slot, models: next, catalog: { updatedAt: at, source: url } };
    logger?.info({ slot: slot.id, url, count: ids.length, added }, "modelCatalog:refresh");
    return { ok: true, slot: updated, added, models: ids };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger?.warn({ slot: slot.id, url, err: error }, "modelCatalog:refresh-failed（保留旧目录）");
    return {
      ok: false,
      slot: { ...slot, catalog: { ...slot.catalog, updatedAt: at, source: url, error } },
      added: 0,
      models: slot.models.map((m) => m.id),
      error,
    };
  }
}

/** 刷新全部槽；单槽失败不影响其它槽，始终返回更新后的完整数组。 */
export async function refreshAllModelCatalogs(
  slots: ModelSlot[],
  keyOf: (slot: ModelSlot) => string,
  logger?: Logger
): Promise<{ slots: ModelSlot[]; ok: number; failed: number; skipped: number; added: number }> {
  const results = await Promise.all(slots.map((s) => refreshModelCatalogForSlot(s, keyOf(s), logger)));
  return {
    slots: results.map((r) => r.slot),
    ok: results.filter((r) => r.ok && !r.skipped).length,
    failed: results.filter((r) => !r.ok).length,
    skipped: results.filter((r) => r.skipped).length,
    added: results.reduce((n, r) => n + r.added, 0),
  };
}
