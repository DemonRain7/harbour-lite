import path from "node:path";

export const MEMORY_ROOT = path.resolve(process.cwd(), "assets", "Memory");

/** 把输入路径收敛到 Memory 根内，并拒绝系统派生/治理文件。 */
export function resolveInMemory(rel: string, root = MEMORY_ROOT): string {
  const cleaned = String(rel)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^assets\/Memory\/?/i, "")
    .replace(/^\.\/+/, "");
  const target = path.resolve(root, cleaned);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`记忆写操作越界：只能写 assets/Memory/ 内，拒绝「${rel}」`);
  }
  const normalized = path.normalize(target).toLowerCase();
  const governanceRoot = path.normalize(path.join(root, ".governance")).toLowerCase();
  if (normalized === path.normalize(path.join(root, "index.md")).toLowerCase()) {
    throw new Error(
      "assets/Memory/index.md 是固定的全局分类入口，不接受记忆写入提案；请修改知识页，应用后由 Governance 自动重建各子目录 index.md。",
    );
  }
  if (normalized === path.normalize(path.join(root, "log.md")).toLowerCase()) {
    throw new Error(
      "assets/Memory/log.md 已退役；操作留痕由 Governance Audit、Proposal 与 Git 自动维护，不再创建 Markdown 副本。",
    );
  }
  if (normalized === governanceRoot || normalized.startsWith(governanceRoot + path.sep.toLowerCase())) {
    throw new Error("assets/Memory/.governance 是系统审计存档，不能作为记忆候选修改");
  }
  return target;
}

export function memoryRelativeName(target: string, root = MEMORY_ROOT): string {
  return path.relative(root, target).replace(/\\/g, "/");
}
