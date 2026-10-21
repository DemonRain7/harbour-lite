import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { normalizeAgentPermissionMode, type AgentPermissionMode } from "../types";

/**
 * per-agent 默认权限模式热覆盖。
 * CLAUDE.md 的 permissionMode 是项目默认；这里保存 dashboard 对当前 Harbour 实例的覆盖。
 */
export class AgentModeStore {
  private map = new Map<string, AgentPermissionMode>();
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private logger: Logger,
    private file: string
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const obj = JSON.parse(raw) as Record<string, unknown>;
      for (const [agent, value] of Object.entries(obj)) {
        const mode = normalizeAgentPermissionMode(value);
        if (agent && mode) this.map.set(agent, mode);
      }
      this.logger.info({ count: this.map.size }, "agentModes 已加载（per-agent 默认 Mode）");
    } catch {
      /* 无文件：使用 agent manifest 默认 */
    }
  }

  get(agent: string): AgentPermissionMode | undefined {
    return this.map.get(agent);
  }

  all(): Record<string, AgentPermissionMode> {
    return Object.fromEntries(this.map.entries());
  }

  set(agent: string, mode: AgentPermissionMode | null): void {
    if (mode) this.map.set(agent, mode);
    else this.map.delete(agent);
    this.persist();
    this.logger.info({ agent, permissionMode: mode ?? "manifest" }, "agentModes:set");
  }

  private persist(): void {
    const data = JSON.stringify(this.all(), null, 2);
    this.writeChain = this.writeChain
      .then(() => fs.mkdir(path.dirname(this.file), { recursive: true }))
      .then(() => fs.writeFile(this.file, data, "utf8"))
      .catch((e) => this.logger.warn({ err: (e as Error).message, file: this.file }, "agentModes: 写盘失败（已忽略）"));
  }
}
