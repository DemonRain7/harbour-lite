import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

export interface MemoryIndexRebuildResult {
  /** 本轮扫描到、应存在的全部子目录索引（相对 Memory 根）。 */
  generated: string[];
  /** 内容确实变化、已写盘的子目录索引。 */
  changed: string[];
}

const DIR_INTRO: Record<string, string> = {
  concepts: "概念 / 方法论 / 思维习惯：抽象、可迁移的「知道 / 判断」类知识。",
  entities: "人 / 项目 / 工具 / 模块：具体的人事物，就近挂靠所属项目。",
  journals: "仅保存有长期时间线意义的事件、决策与里程碑，含 dream-YYYY-MM-DD 自省日记；不记录摄入过程或临时运行状态。",
  outputs: "查询产出：有长期价值的综述 / 对比 / 报告。",
};

// 按相对路径命名，避免其它主题下的 prompts/resources 目录被误贴上宝库标签。
const CURATED_DIRS: Record<string, { title: string; description: string }> = {
  treasury: { title: "宝库", description: "用户 喜欢或认为有价值、希望保存起来的东西。" },
  "treasury/prompts": { title: "提示词与模板", description: "可复用的 Prompt、创作简报与模板；保留原文，使用时再读取。" },
  "treasury/inspiration": { title: "灵感与作品", description: "喜欢的作品、设计参考与值得留存的点子。" },
  "treasury/resources": { title: "资料与工具", description: "值得保存的文章、教程、网站、工具与素材线索。" },
};

/**
 * 重建 assets/Memory 下每个子目录的 index.md。
 *
 * 根 index.md 是稳定的全局分类入口，故本函数从结构上永远不读写它。子目录索引是
 * 派生物：页面 proposal 一旦 apply，Governance 可直接调用本函数让导航与磁盘事实同步。
 */
export async function rebuildMemoryIndexes(
  memoryRoot = path.resolve(process.cwd(), "assets", "Memory")
): Promise<MemoryIndexRebuildResult> {
  const generated: string[] = [];
  const changed: string[] = [];

  async function walk(dir: string, isRoot: boolean): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const subdirs = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();

    for (const subdir of subdirs) await walk(path.join(dir, subdir), false);
    if (isRoot) return;

    const pages: Array<{ file: string; desc: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "index.md") continue;
      const raw = await fs.readFile(path.join(dir, entry.name), "utf8");
      const data = matter(raw).data as { description?: string };
      pages.push({ file: entry.name.replace(/\.md$/, ""), desc: data.description ?? "" });
    }
    pages.sort((a, b) => a.file.localeCompare(b.file));

    const name = path.basename(dir);
    const directory = path.relative(memoryRoot, dir).replace(/\\/g, "/");
    const curated = CURATED_DIRS[directory];
    const lines = curated
      ? ["---", `title: ${curated.title}`, `description: ${curated.description}`, "---", "", `# ${curated.title}`, "", `> ${curated.description}`, ""]
      : [`# ${name}`, ""];
    if (!curated && DIR_INTRO[name]) lines.push(`> ${DIR_INTRO[name]}`, "");
    lines.push("> 本目录索引（`npm run index` 自动生成 · 只列当前目录的页面与直接子目录）。", "");
    if (subdirs.length) {
      lines.push("## 子目录");
      for (const subdir of subdirs) {
        const child = CURATED_DIRS[`${directory}/${subdir}`];
        lines.push(`- [${child?.title ?? `${subdir}/`}](${subdir}/index.md)${child ? ` — ${child.description}` : ""}`);
      }
      lines.push("");
    }
    lines.push("## 页面");
    if (pages.length) {
      for (const page of pages) lines.push(`- [[${page.file}]]${page.desc ? ` — ${page.desc}` : ""}`);
    } else {
      lines.push("- （空）");
    }
    lines.push("");

    const indexPath = path.join(dir, "index.md");
    const next = lines.join("\n");
    let current = "";
    try {
      current = await fs.readFile(indexPath, "utf8");
    } catch {
      /* 新目录还没有派生索引。 */
    }
    const rel = path.relative(memoryRoot, indexPath).replace(/\\/g, "/");
    generated.push(rel);
    if (current !== next) {
      await fs.writeFile(indexPath, next, "utf8");
      changed.push(rel);
    }
  }

  try {
    await walk(memoryRoot, true);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { generated, changed };
    throw error;
  }
  return { generated, changed };
}
