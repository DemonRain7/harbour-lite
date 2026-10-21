import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { normalizeReasoningEffort, type ReasoningEffort } from "../types";

/**
 * 每个模型（modelRef）的可调配置，前端 Settings 里逐模型设置、持久化到 data/modelConfig.json。
 *  - effort：思考力度档位。Codex 使用模型目录给出的原生档位；Claude SDK 映射为 token 预算。
 *            null = 不做逐模型覆盖，运行时走 Agent 清单；清单未设时 main-* high、其余 medium。
 *  - compactTokens：该模型完整请求估算的压缩触发线。null = 自动80%，显式Agent预算与输入余量仍生效。
 *
 * 只存「被显式改过」的模型；未配置的取默认（effort:null, compactTokens:null）。
 */
export type Effort = ReasoningEffort;

export interface ModelConfig {
  effort: Effort | null;
  compactTokens: number | null;
}

/**
 * effort 档位 → 稳定的离散预算。Claude SDK 直接使用预算；Codex Harness 再无损映射回
 * 原生档位。`off` 与 Codex 的 `none` 都是 0，但 UI 会按后端只展示其中一个。
 */
export const EFFORT_BUDGET: Record<Effort, number> = {
  off: 0,
  none: 0,
  minimal: 512,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  xhigh: 32_768,
  max: 65_536,
  ultra: 131_072,
};

/**
 * Harbour 的统一 Agent 默认值。Main 负责长程对话、委派与最终验收，默认 high；其余
 * 专精/后台 Agent 默认 medium。按命名约定判断，未来新增 main-* 无需再改核心代码。
 */
export function defaultReasoningEffortForAgent(agentName: string): ReasoningEffort {
  return /^main(?:-|$)/i.test(String(agentName || "").trim()) ? "high" : "medium";
}

const DEFAULT_CONFIG: ModelConfig = { effort: null, compactTokens: null };

export class ModelConfigStore {
  private map = new Map<string, ModelConfig>();
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private logger: Logger,
    private file: string
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const obj = JSON.parse(raw) as Record<string, Partial<ModelConfig>>;
      for (const [ref, cfg] of Object.entries(obj)) {
        if (ref && cfg && typeof cfg === "object") this.map.set(ref, normalize(cfg));
      }
      this.logger.info({ count: this.map.size }, "modelConfig 已加载（逐模型 effort / compact 配置）");
    } catch {
      /* 无文件：按空起步 */
    }
  }

  get(modelRef: string): ModelConfig {
    return this.map.get(modelRef) ?? { ...DEFAULT_CONFIG };
  }

  /** 全部已配置项（前端展示用）。 */
  all(): Record<string, ModelConfig> {
    return Object.fromEntries(this.map.entries());
  }

  set(modelRef: string, patch: Partial<ModelConfig>): ModelConfig {
    const cur = this.get(modelRef);
    const next = normalize({ ...cur, ...patch });
    this.map.set(modelRef, next);
    this.persist();
    this.logger.info({ modelRef, ...next }, "modelConfig:set");
    return next;
  }

  private persist(): void {
    const data = JSON.stringify(this.all(), null, 2);
    this.writeChain = this.writeChain
      .then(() => fs.mkdir(path.dirname(this.file), { recursive: true }))
      .then(() => fs.writeFile(this.file, data, "utf8"))
      .catch((e) => this.logger.warn({ err: (e as Error).message, file: this.file }, "modelConfig: 写盘失败（已忽略）"));
  }
}

function normalize(c: Partial<ModelConfig>): ModelConfig {
  const effort = normalizeReasoningEffort(c.effort) ?? null;
  const compactTokens =
    typeof c.compactTokens === "number" && Number.isFinite(c.compactTokens) && c.compactTokens > 0
      ? Math.floor(c.compactTokens)
      : null;
  return { effort, compactTokens };
}
