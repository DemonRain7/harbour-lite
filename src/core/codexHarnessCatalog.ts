import type { Logger } from "pino";
import type { RuntimeModelSlot } from "../runtime";
import type { CodexHarnessProbe, CodexModelRow } from "./backends/codexAppServer";
import type { SlotModel } from "./modelSlots";
import type { RuntimeCatalogRefreshResult } from "./workflows/pricingRefresh";
import type { CodexRuntimeUpdate } from "./codexRuntime";

const SLOT_ID = "codex-harness";
const BACKEND_KEY = "codex-app-server";
const CATALOG_SOURCE = "codex-app-server:model/list";

export interface CodexHarnessCatalogConfig {
  enabled: boolean;
  isMock(): boolean;
  probe(): Promise<CodexHarnessProbe>;
  updateRuntime?(): Promise<CodexRuntimeUpdate>;
  runtimeState?(): CodexRuntimeUpdate;
  slots: RuntimeModelSlot[];
  canonicalBackendPrefixes: Record<string, string>;
  canonicalDefaultModels: Record<string, string>;
  configuredModels: string[];
  selectedModel: string;
  contextWindow: number;
  logger?: Logger;
  onUpdated?(): void;
}

export type CodexHarnessCatalogState = CodexHarnessProbe & { enabled: boolean; updatedAt?: string; component?: CodexRuntimeUpdate };

function copyRow(row: CodexModelRow): CodexModelRow {
  return {
    ...row,
    ...(row.inputModalities ? { inputModalities: [...row.inputModalities] } : {}),
    ...(row.supportedReasoningEfforts
      ? { supportedReasoningEfforts: row.supportedReasoningEfforts.map((option) => ({ ...option })) }
      : {}),
  };
}

/**
 * Codex OAuth 的运行时虚拟目录：不持久化、不改连接、不改变已选默认模型。
 * 对外发布的状态、槽与数组保持身份，后续刷新只原地更新它们。
 */
export function createCodexHarnessCatalog(config: CodexHarnessCatalogConfig): {
  state: CodexHarnessCatalogState;
  refresh(options?: { updateRuntime?: boolean }): Promise<RuntimeCatalogRefreshResult>;
} {
  const selected = config.selectedModel.trim();
  const configured = [...new Set(config.configuredModels.map((model) => model.trim()).filter(Boolean))];
  if (selected && !configured.includes(selected)) configured.unshift(selected);
  const configuredSet = new Set(configured);
  const contextWindow = Number.isFinite(config.contextWindow) && config.contextWindow > 0
    ? Math.floor(config.contextWindow)
    : undefined;
  const findSlot = () => config.slots.find((slot) => slot.id === SLOT_ID && slot.kind === "codex-harness");
  const state: CodexHarnessCatalogState = {
    enabled: config.enabled,
    ready: false,
    models: [],
    ...(config.runtimeState ? { component: config.runtimeState() } : {}),
    ...(!config.enabled ? { error: "disabled" } : {}),
  };
  let inFlight: Promise<RuntimeCatalogRefreshResult> | undefined;

  const configuredEntry = (id: string): SlotModel => ({
    id,
    enabled: true,
    available: true,
    source: "configured",
    ...(contextWindow ? { contextWindow } : {}),
  });

  const applySlot = (models: SlotModel[], initialDefault: string): RuntimeModelSlot | undefined => {
    let slot = findSlot();
    if (!slot && !initialDefault) return undefined;
    if (!slot) {
      slot = {
        id: SLOT_ID,
        label: "OpenAI Codex · ChatGPT OAuth",
        model: initialDefault,
        baseURL: "local://codex-app-server",
        keyEnv: "CODEX_OAUTH",
        keyKind: "auth",
        models: [],
        index: config.slots.length,
        backendKey: BACKEND_KEY,
        modelRef: `${BACKEND_KEY}/${initialDefault}`,
        kind: "codex-harness",
      };
      config.slots.push(slot);
    }
    slot.models.splice(0, slot.models.length, ...models);
    // Router 保存了这两个 Record 的引用；不能用新对象替换它们。
    config.canonicalBackendPrefixes[BACKEND_KEY] = BACKEND_KEY;
    config.canonicalDefaultModels[BACKEND_KEY] = slot.model;
    return slot;
  };

  const seedConfigured = (): boolean => {
    if (!config.enabled) return false;
    const slot = findSlot();
    const models = slot ? [...slot.models] : [];
    const present = new Set(models.map((model) => model.id));
    for (const id of configured) {
      if (!present.has(id)) models.push(configuredEntry(id));
    }
    if (!slot && !models.length) return false;
    applySlot(models, selected || models[0]?.id || "");
    return !slot || models.length !== present.size;
  };

  const result = (extra: Omit<RuntimeCatalogRefreshResult, "id" | "total" | "updatedAt">): RuntimeCatalogRefreshResult => ({
    id: SLOT_ID,
    total: findSlot()?.models.length ?? 0,
    ...(state.updatedAt ? { updatedAt: state.updatedAt } : {}),
    ...(state.component ? { component: state.component } : {}),
    ...(state.component?.status === "failed" ? { warnings: [state.component.message || "Codex 组件更新失败，沿用原版本"] } : {}),
    ...extra,
  });

  const fail = (probe: CodexHarnessProbe): RuntimeCatalogRefreshResult => {
    const error = probe.error || "Codex OAuth/model/list 探测失败";
    state.ready = false;
    state.authType = probe.authType;
    state.planType = probe.planType;
    state.error = error;
    const slot = findSlot();
    if (slot) {
      slot.catalog ??= {};
      slot.catalog.source = CATALOG_SOURCE;
      slot.catalog.error = error;
      // updatedAt 只记录成功快照，不让失败尝试冒充最新的成功目录。
    }
    config.logger?.warn({ err: error }, "codexHarnessCatalog:refresh-failed（保留旧目录）");
    return result({ ok: false, added: 0, error });
  };

  const runRefresh = async (updateRuntime: boolean): Promise<RuntimeCatalogRefreshResult> => {
    if (!config.enabled) return result({ ok: true, skipped: true, added: 0 });
    if (config.isMock()) {
      const seeded = seedConfigured();
      if (!state.updatedAt) state.error = "mock mode 未探测本机 Codex OAuth";
      if (seeded) config.onUpdated?.();
      return result({ ok: true, skipped: true, added: 0 });
    }

    if (updateRuntime && config.updateRuntime) {
      try { state.component = await config.updateRuntime(); }
      catch { state.component = { status: "failed", version: config.runtimeState?.().version ?? "unknown", message: "Codex 组件更新失败，沿用原版本" }; }
    }
    let probe: CodexHarnessProbe;
    try {
      probe = await config.probe();
    } catch (error) {
      probe = { ready: false, models: [], error: error instanceof Error ? error.message : String(error) };
    }
    const rows = new Map<string, CodexModelRow>();
    for (const row of probe.models) {
      const model = row.model.trim();
      if (model && !row.hidden) rows.set(model, { ...copyRow(row), model });
    }
    if (!probe.ready || !rows.size) {
      const seeded = seedConfigured();
      const failure = fail(!probe.ready ? probe : { ...probe, ready: false, error: probe.error || "Codex 模型目录返回空列表" });
      if (seeded) config.onUpdated?.();
      return failure;
    }

    const previousSlot = findSlot();
    const previous = new Map(previousSlot?.models.map((model) => [model.id, model]) ?? []);
    for (const id of configured) {
      if (!previous.has(id)) previous.set(id, configuredEntry(id));
    }
    const models: SlotModel[] = [...rows.values()].map((row) => {
      const old = previous.get(row.model);
      const window = contextWindow ?? old?.contextWindow;
      return {
        id: row.model,
        label: row.displayName || row.model,
        enabled: old?.enabled !== false,
        available: true,
        source: old?.source ?? "discovered",
        ...(window ? { contextWindow: window } : {}),
        capabilities: row.inputModalities?.includes("image") ? ["vision"] : [],
        ...(row.defaultReasoningEffort ? { defaultReasoningEffort: row.defaultReasoningEffort } : {}),
        ...(row.supportedReasoningEfforts?.length
          ? { supportedReasoningEfforts: row.supportedReasoningEfforts.map((option) => ({ ...option })) }
          : {}),
      };
    });
    for (const old of previous.values()) {
      if (rows.has(old.id)) continue;
      models.push({
        ...old,
        // 明确配置的模型允许继续手动选；消失的 discovered 默认仍保留引用，不能伪装成新发现。
        available: configuredSet.has(old.id) ? true : old.source === "configured" ? old.available : false,
      });
    }
    const initialDefault = selected || (probe.defaultModel && rows.has(probe.defaultModel) ? probe.defaultModel : "") || rows.keys().next().value || "";
    const slot = applySlot(models, initialDefault)!;
    const updatedAt = new Date().toISOString();
    slot.catalog ??= {};
    slot.catalog.source = CATALOG_SOURCE;
    slot.catalog.updatedAt = updatedAt;
    delete slot.catalog.error;
    state.ready = true;
    state.authType = probe.authType;
    state.planType = probe.planType;
    state.defaultModel = probe.defaultModel;
    state.updatedAt = updatedAt;
    state.models.splice(0, state.models.length, ...rows.values());
    delete state.error;
    const added = [...rows.keys()].filter((id) => !previous.has(id)).length;
    config.onUpdated?.();
    config.logger?.info({ count: models.length, added }, "codexHarnessCatalog:refresh");
    return result({ ok: true, added });
  };

  return {
    state,
    refresh: (options) => {
      if (!inFlight) {
        inFlight = Promise.resolve().then(() => runRefresh(options?.updateRuntime === true)).finally(() => { inFlight = undefined; });
      }
      return inFlight;
    },
  };
}
