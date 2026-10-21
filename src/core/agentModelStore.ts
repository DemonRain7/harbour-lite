import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

/**
 * Agent / Settings 面板共用的 per-agent 默认模型覆盖。
 * Agent CLAUDE.md 的 model 仍是项目默认；这里保存当前 Harbour 实例的热覆盖。
 */
export class AgentModelStore {
  private map = new Map<string, string>();
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private logger: Logger,
    private file: string
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const obj = JSON.parse(raw) as Record<string, unknown>;
      for (const [agent, ref] of Object.entries(obj)) {
        if (agent && typeof ref === "string" && ref.includes("/")) this.map.set(agent, ref);
      }
      this.logger.info({ count: this.map.size }, "agentModels 已加载（per-agent 默认模型）");
    } catch {
      /* 无文件：使用 agent manifest 默认 */
    }
  }

  get(agent: string): string | undefined {
    return this.map.get(agent);
  }

  all(): Record<string, string> {
    return Object.fromEntries(this.map.entries());
  }

  set(agent: string, modelRef: string | null): void {
    if (modelRef) this.map.set(agent, modelRef);
    else this.map.delete(agent);
    this.persist();
    this.logger.info({ agent, modelRef: modelRef ?? "manifest" }, "agentModels:set");
  }

  private persist(): void {
    const data = JSON.stringify(this.all(), null, 2);
    this.writeChain = this.writeChain
      .then(() => fs.mkdir(path.dirname(this.file), { recursive: true }))
      .then(() => fs.writeFile(this.file, data, "utf8"))
      .catch((e) => this.logger.warn({ err: (e as Error).message, file: this.file }, "agentModels: 写盘失败（已忽略）"));
  }
}
