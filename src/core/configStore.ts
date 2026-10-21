import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

/**
 * 用户自定义配置字段（备忘 + agent 经 get_config 按需读）。
 *
 * 纯字符串 KV，落 data/config.json。定位是 用户 自己的「可增删改的配置备忘」——如 SSH 主机、
 * 部署路径等。两用：① Settings 面板里当备忘查看/编辑；② agent 经受白名单约束的 get_config(key)
 * 工具按需读取（值只在被调用时返回、不预载进 system prompt）。
 *
 * 仿 modelConfigStore 的读写落盘范式（内存 Map + 写链，热生效）。
 */
export class ConfigStore {
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
      for (const [k, v] of Object.entries(obj)) {
        if (k && typeof v === "string") this.map.set(k, v);
      }
      this.logger.info({ count: this.map.size }, "configStore 已加载（用户配置字段）");
    } catch {
      /* 无文件：空起步 */
    }
  }

  /** 全部字段（Settings 面板展示 + 编辑）。 */
  all(): Record<string, string> {
    return Object.fromEntries(this.map.entries());
  }

  get(key: string): string | undefined {
    return this.map.get(key);
  }

  set(key: string, value: string): void {
    this.map.set(key, value);
    this.persist();
    this.logger.info({ key }, "configStore:set");
  }

  delete(key: string): boolean {
    const ok = this.map.delete(key);
    if (ok) {
      this.persist();
      this.logger.info({ key }, "configStore:delete");
    }
    return ok;
  }

  private persist(): void {
    const data = JSON.stringify(this.all(), null, 2);
    this.writeChain = this.writeChain
      .then(() => fs.mkdir(path.dirname(this.file), { recursive: true }))
      .then(() => fs.writeFile(this.file, data, "utf8"))
      .catch((e) => this.logger.warn({ err: (e as Error).message, file: this.file }, "configStore: 写盘失败（已忽略）"));
  }
}
