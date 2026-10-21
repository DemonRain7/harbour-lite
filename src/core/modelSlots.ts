import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { Env } from "../config/env";
import { normalizeReasoningEffort, type ReasoningEffort } from "../types";
import { inferModelCapabilities, type ModelCapability } from "./modelCapabilities";

/**
 * 模型槽注册表 —— 支持任意 N 个 claude-agent 端点槽（主 + 若干备/额外）。
 *
 * 设计（尊重 用户 的「密钥只存 .env、不另建密钥库」约束）：
 *  - 非密钥部分（model / baseURL / label / keyEnv 引用）落 data/models.json（本地状态，gitignore）。
 *  - 密钥值仍只存 .env，槽用 keyEnv 记录「该槽 key 存在哪个 .env 变量名」（如 ANTHROPIC_AUTH_TOKEN）。
 *  - backend 前缀：第 0 槽（主）恒为 "claude-agent"（策略表 DEFAULT_STRATEGY 的 primary 指它，不能变）；
 *    第 1 槽若 id=fallback 则 "claude-agent-fallback"（沿用历史全局 fallback 名）；其余 "claude-agent-<id>"。
 *  - 第 1 槽起全部挂到 Router 的 globalFallbacks（按顺序），实现跨端点容灾。
 *
 * 首次运行若无 data/models.json，则从现有 .env（主 ANTHROPIC_* + 备 ANTHROPIC_FALLBACK_*）**播种**并落盘，
 * 保证既有 Kimi 行为逐字节不变；之后一切以 data/models.json 为准，前端可增删改。
 * 槽的增删改 / key / url / model 变动都需**重启后端**才生效（backend 启动定死）。
 */

export interface SlotModel {
  /** Provider 实际接收的 model id。 */
  id: string;
  /** 可选展示名；空则直接显示 id。 */
  label?: string;
  /** 是否在 Main Chat 的模型列表中展示。默认 true。 */
  enabled: boolean;
  /** 最近一次目录刷新时是否仍由 Provider 返回。手工模型默认 true。 */
  available: boolean;
  /** configured=用户/迁移写入；discovered=Provider /models 自动发现。 */
  source: "configured" | "discovered";
  contextWindow?: number;
  /** 模型可安全依赖的输入能力；目录没返回时按明确型号保守推断。 */
  capabilities?: ModelCapability[];
  /** Provider 模型目录声明的默认推理力度（目前主要来自 Codex App Server）。 */
  defaultReasoningEffort?: ReasoningEffort;
  /** 该模型实际支持的推理力度与说明；前端据此动态生成 Effort 选择器。 */
  supportedReasoningEfforts?: Array<{ effort: ReasoningEffort; description?: string }>;
}

export interface ModelCatalogState {
  updatedAt?: string;
  source?: string;
  error?: string;
}

export interface ModelSlot {
  id: string;
  label: string;
  /** provider 模型 id（"default" 交给 backend 用 defaultModel）。 */
  model: string;
  baseURL: string;
  /** 该槽 key 所在的 .env 变量名（key 值只存 .env）。 */
  keyEnv: string;
  /** 认证风格：auth=Bearer(ANTHROPIC_AUTH_TOKEN 语义) / api=x-api-key。默认 auth（Kimi/多数兼容端点）。 */
  keyKind: "auth" | "api";
  /** 同一个 key/端点可调用的模型目录。model 字段只是其中的默认项。 */
  models: SlotModel[];
  /** 最近一次自动/手工目录刷新的状态。 */
  catalog?: ModelCatalogState;
}

function modelsFile(): string {
  return path.resolve(process.cwd(), "data", "models.json");
}

function normalizeSlotModel(o: unknown): SlotModel | null {
  if (typeof o === "string") {
    const id = o.trim();
    return id ? { id, enabled: true, available: true, source: "configured" } : null;
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const id = String(r.id ?? "").trim();
  if (!id) return null;
  const contextWindow = Number(r.contextWindow);
  const capabilities = Array.isArray(r.capabilities)
    ? [...new Set(r.capabilities.map(String).filter((value): value is ModelCapability => value === "vision"))]
    : inferModelCapabilities(id);
  const defaultReasoningEffort = normalizeReasoningEffort(r.defaultReasoningEffort);
  const supportedReasoningEfforts = Array.isArray(r.supportedReasoningEfforts)
    ? r.supportedReasoningEfforts.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const row = value as Record<string, unknown>;
        const effort = normalizeReasoningEffort(row.effort ?? row.reasoningEffort);
        if (!effort) return [];
        const description = String(row.description ?? "").trim();
        return [{ effort, ...(description ? { description } : {}) }];
      })
    : [];
  return {
    id,
    ...(String(r.label ?? "").trim() ? { label: String(r.label).trim() } : {}),
    enabled: r.enabled !== false,
    available: r.available !== false,
    source: r.source === "discovered" ? "discovered" : "configured",
    ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow: Math.floor(contextWindow) } : {}),
    ...(capabilities.length ? { capabilities } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(supportedReasoningEfforts.length ? { supportedReasoningEfforts } : {}),
  };
}

function normalize(o: unknown): ModelSlot | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const id = String(r.id ?? "").trim();
  const keyEnv = String(r.keyEnv ?? "").trim();
  if (!id || !keyEnv) return null;
  const model = String(r.model ?? "default").trim() || "default";
  const models = Array.isArray(r.models)
    ? r.models.map(normalizeSlotModel).filter((m): m is SlotModel => !!m)
    : [];
  if (model !== "default" && !models.some((m) => m.id === model)) {
    models.unshift({ id: model, enabled: true, available: true, source: "configured" });
  }
  return {
    id,
    label: String(r.label ?? id),
    model,
    baseURL: String(r.baseURL ?? ""),
    keyEnv,
    keyKind: r.keyKind === "api" ? "api" : "auth",
    models,
    ...(r.catalog && typeof r.catalog === "object" ? { catalog: r.catalog as ModelCatalogState } : {}),
  };
}

/** 槽里当前启用且可用的模型；目录为空时退回默认 model，兼容旧配置。 */
export function enabledModelsForSlot(slot: ModelSlot): SlotModel[] {
  const active = slot.models.filter((m) => m.enabled && m.available);
  if (active.length) return active;
  return slot.model && slot.model !== "default"
    ? [{ id: slot.model, enabled: true, available: true, source: "configured" }]
    : [];
}

/** 确保默认/手填模型存在于目录中。 */
export function ensureModelInSlot(slot: ModelSlot, modelId: string): ModelSlot {
  const id = modelId.trim();
  if (!id || id === "default" || slot.models.some((m) => m.id === id)) return slot;
  return { ...slot, models: [{ id, enabled: true, available: true, source: "configured" }, ...slot.models] };
}

/** 槽 → backend 前缀。第 0 槽恒 "claude-agent"；id=fallback 的第 1 槽 → "claude-agent-fallback"；其余 → "claude-agent-<id>"。 */
export function backendKeyFor(slot: ModelSlot, index: number): string {
  if (index === 0) return "claude-agent";
  if (index === 1 && slot.id === "fallback") return "claude-agent-fallback";
  return `claude-agent-${slot.id}`;
}

/**
 * 槽位稳定 backend 前缀：不随主/备排序改变，用于 chat 选择、逐模型配置与 metrics 归因。
 * claude-agent/default 仍作为“当前主 API”的兼容别名；真正记账统一落到本前缀。
 */
export function stableBackendKeyFor(slot: ModelSlot): string {
  return `model-slot-${slot.id.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;
}

/** 读取 data/models.json（不存在 → 空数组）。 */
export async function readModelSlots(): Promise<ModelSlot[]> {
  try {
    const arr = JSON.parse(await fs.readFile(modelsFile(), "utf8"));
    return Array.isArray(arr) ? arr.map(normalize).filter((s): s is ModelSlot => !!s) : [];
  } catch {
    return [];
  }
}

/** 写 data/models.json。 */
export async function saveModelSlots(slots: ModelSlot[]): Promise<void> {
  await fs.mkdir(path.dirname(modelsFile()), { recursive: true });
  await fs.writeFile(modelsFile(), JSON.stringify(slots, null, 2), "utf8");
}

/** 启动装载：优先 data/models.json；无则从 .env 播种（主 + 备）并落盘。 */
export async function loadModelSlots(env: Env, logger: Logger): Promise<ModelSlot[]> {
  const existing = await readModelSlots();
  if (existing.length) {
    logger.info({ count: existing.length }, "modelSlots 从 data/models.json 加载");
    return existing;
  }
  // 播种前断言：baseURL 必须落在白名单 host 内。新机器若 .env 漏配 ANTHROPIC_BASE_URL，
  // env.ts 会读到系统级的值（可能是公司网关），一旦播种就被固化进 data/models.json。
  const assertHost = (url: string, which: string) => {
    if (!url) return;
    const allowed = env.MODEL_HOST_ALLOWLIST.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
    if (!allowed.length) return;
    let host = "";
    try { host = new URL(url).hostname.toLowerCase(); } catch { throw new Error(`${which} 不是合法 URL: ${url}`); }
    if (!allowed.some((a) => host === a || host.endsWith(`.${a}`))) {
      throw new Error(
        `${which} 的 host「${host}」不在 MODEL_HOST_ALLOWLIST（${allowed.join(", ")}）内。` +
        `多半是 .env 漏配、回退到了机器级环境变量。请检查 .env。`
      );
    }
  };
  assertHost(env.ANTHROPIC_BASE_URL, "ANTHROPIC_BASE_URL");
  assertHost(env.ANTHROPIC_FALLBACK_BASE_URL, "ANTHROPIC_FALLBACK_BASE_URL");

  const seeded: ModelSlot[] = [];
  if (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY) {
    const useAuth = !!env.ANTHROPIC_AUTH_TOKEN;
    seeded.push({
      id: "main",
      label: "主后端",
      model: env.CLAUDE_AGENT_MODEL,
      baseURL: env.ANTHROPIC_BASE_URL,
      keyEnv: useAuth ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY",
      keyKind: useAuth ? "auth" : "api",
      models: [{ id: env.CLAUDE_AGENT_MODEL, enabled: true, available: true, source: "configured" }],
    });
  }
  if (env.ANTHROPIC_FALLBACK_AUTH_TOKEN || env.ANTHROPIC_FALLBACK_API_KEY) {
    const useAuth = !!env.ANTHROPIC_FALLBACK_AUTH_TOKEN;
    seeded.push({
      id: "fallback",
      label: "备用后端",
      model: env.ANTHROPIC_FALLBACK_MODEL || env.CLAUDE_AGENT_MODEL,
      baseURL: env.ANTHROPIC_FALLBACK_BASE_URL,
      keyEnv: useAuth ? "ANTHROPIC_FALLBACK_AUTH_TOKEN" : "ANTHROPIC_FALLBACK_API_KEY",
      keyKind: useAuth ? "auth" : "api",
      models: [{ id: env.ANTHROPIC_FALLBACK_MODEL || env.CLAUDE_AGENT_MODEL, enabled: true, available: true, source: "configured" }],
    });
  }
  if (seeded.length) {
    await saveModelSlots(seeded).catch((e) => logger.warn({ err: (e as Error).message }, "modelSlots 播种落盘失败（忽略）"));
    logger.info({ count: seeded.length }, "modelSlots 按 .env 播种并落盘 data/models.json");
  }
  return seeded;
}
