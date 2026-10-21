import { promises as fs } from "node:fs";
import path from "node:path";

interface BindingFile {
  version: 1;
  accounts: Record<string, { ownerOpenids: string[]; updatedAt: string }>;
}

const EMPTY: BindingFile = { version: 1, accounts: {} };

/**
 * QQ Open Platform 的 OpenID 是不透明标识，原则上必须原样比较。腾讯当前下发的
 * 32 位十六进制 OpenID 偶尔会在不同入口出现大小写差异；只对这一种明确格式做
 * 大小写归一，其它未来格式仍保持原样，避免误合并两个身份。
 */
export function normalizeQQOpenid(value: unknown): string {
  const clean = String(value ?? "").trim();
  return /^[0-9a-f]{32}$/i.test(clean) ? clean.toUpperCase() : clean;
}

/** 持久化的是 QQ Open Platform openid，不是 QQ 号、密码或配对码。 */
export class QQBindingStore {
  private data: BindingFile = structuredClone(EMPTY);
  private loaded = false;
  /** 多 Bot 并行 start 时，后来的调用必须等待同一份磁盘读取，不能看到临时 EMPTY。 */
  private loadPromise?: Promise<void>;
  /** 同一共享 store 的覆盖写严格串行，避免两个 Bot 同时 /bind 时 tmp 文件和内存快照互踩。 */
  private writeTail: Promise<void> = Promise.resolve();

  constructor(readonly file: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    const loading = (async () => {
      try {
        const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<BindingFile>;
        if (parsed.version === 1 && parsed.accounts && typeof parsed.accounts === "object") {
          this.data = { version: 1, accounts: parsed.accounts };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      this.loaded = true;
    })();
    this.loadPromise = loading;
    try {
      await loading;
    } finally {
      if (this.loadPromise === loading) this.loadPromise = undefined;
    }
  }

  owners(accountKey: string): Set<string> {
    const values = this.data.accounts[accountKey]?.ownerOpenids ?? [];
    return new Set(values.map(normalizeQQOpenid).filter(Boolean));
  }

  async addOwner(accountKey: string, openid: string): Promise<boolean> {
    const clean = normalizeQQOpenid(openid);
    if (!clean) throw new Error("QQ owner openid 不能为空");
    let changed = false;
    const write = this.writeTail.then(async () => {
      await this.load();
      const owners = this.owners(accountKey);
      if (owners.has(clean)) return;
      owners.add(clean);
      this.data.accounts[accountKey] = {
        ownerOpenids: [...owners].sort(),
        updatedAt: new Date().toISOString(),
      };
      await this.save();
      changed = true;
    });
    // 失败不能永久毒死后续队列；当前调用仍 await 原 promise 并得到真实错误。
    this.writeTail = write.catch(() => {});
    await write;
    return changed;
  }

  private async save(): Promise<void> {
    const absolute = path.resolve(this.file);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const temporary = `${absolute}.tmp-${process.pid}`;
    await fs.writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    await fs.rename(temporary, absolute);
  }
}

/** 一个绑定文件在单进程内只对应一个 store；多 QQ Bot 由 accountKey 分区。 */
const sharedStores = new Map<string, QQBindingStore>();

export function sharedQQBindingStore(file: string): QQBindingStore {
  const absolute = path.resolve(file);
  const existing = sharedStores.get(absolute);
  if (existing) return existing;
  const store = new QQBindingStore(absolute);
  sharedStores.set(absolute, store);
  return store;
}
