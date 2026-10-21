import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

/** Hot delegation availability, separate from mounts, personas and run permissions. */
export class AgentDelegationStore {
  private disabled = new Set<string>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private logger: Logger, private file: string) {}

  async load(): Promise<void> {
    let raw: string;
    try { raw = await fs.readFile(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("agentDelegation 配置必须是对象");
    const next = new Set<string>();
    for (const [name, enabled] of Object.entries(data)) {
      if (!isDelegationConfigurable(name) || typeof enabled !== "boolean") throw new Error(`agentDelegation 配置无效: ${name}`);
      if (!enabled) next.add(name);
    }
    this.disabled = next;
    this.logger.info({ disabled: [...next] }, "agentDelegation:loaded");
  }

  isEnabled(name: string): boolean { return !this.disabled.has(name); }

  all(): Record<string, boolean> { return Object.fromEntries([...this.disabled].sort().map(name => [name, false])); }

  setEnabled(name: string, enabled: boolean): Promise<void> {
    const change = this.writes.then(async () => {
      if (!isDelegationConfigurable(name) || typeof enabled !== "boolean") throw new Error("无效的 Agent 委派设置");
      const next = new Set(this.disabled);
      if (enabled) next.delete(name); else next.add(name);
      const data = Object.fromEntries([...next].sort().map(id => [id, false]));
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        await fs.rename(temp, this.file);
      } finally {
        await fs.unlink(temp).catch(() => {});
      }
      // Failed writes must not report or expose an unpersisted setting.
      this.disabled = next;
      this.logger.info({ agent: name, enabled }, "agentDelegation:set");
    });
    this.writes = change.catch(() => {});
    return change;
  }
}

export function isDelegationConfigurable(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(name) && name !== "main" && !name.startsWith("main-");
}

export function delegationPaused(name: string) {
  return {
    agent: name, refused: true, status: "refused", code: "AGENT_DELEGATION_PAUSED",
    controllerInvoked: false, retrySafety: "safe",
    reason: `「${name}」已暂停接受 Agent 委派，本次未启动。可在 AGENTS → 运行配置重新启用；不要反复重试。`,
  };
}
