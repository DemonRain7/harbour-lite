/** 校验项目内全部 Agent Skills 包是否符合 https://agentskills.io/specification。 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { validateSkillPackage } from "../src/config/loadAgents";
import { loadSkillResourceIndex } from "../src/core/skillResourceIndex";

const ROOT = process.cwd();

async function directories(base: string): Promise<string[]> {
  try {
    return (await fs.readdir(base, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(base, entry.name));
  } catch {
    return [];
  }
}

async function skillDirectories(): Promise<string[]> {
  const candidates = await directories(path.join(ROOT, "skills"));
  const entries = await Promise.all(candidates.map(async dir => ({ dir, empty: (await fs.readdir(dir)).length === 0 })));
  return entries.filter(entry => !entry.empty).map(entry => entry.dir).sort();
}

async function missingRelativeLinks(skillDir: string, entry = "SKILL.md"): Promise<string[]> {
  const missing: string[] = [];
  const markdownFiles: string[] = [path.join(skillDir, entry)];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.endsWith(".md")) markdownFiles.push(child);
    }
  };
  const references = path.join(skillDir, "references");
  try { await fs.access(references); await walk(references); } catch { /* references/ 可选 */ }
  for (const file of markdownFiles) {
    const raw = (await fs.readFile(file, "utf8")).replace(/```[\s\S]*?```/g, "");
    const links = raw.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
    for (const match of links) {
      const target = match[1]?.split("#", 1)[0]?.trim();
      if (!target || /^(?:https?:|mailto:|#)/i.test(target)) continue;
      try { await fs.access(path.resolve(path.dirname(file), target)); }
      catch { missing.push(`${path.relative(skillDir, file)} → ${target}`); }
    }
  }
  return missing;
}

async function main(): Promise<void> {
  const dirs = await skillDirectories();
  const failures: string[] = [];
  for (const dir of dirs) {
    const rel = path.relative(ROOT, dir);
    const checked = await validateSkillPackage(dir);
    const missing = checked.valid ? await missingRelativeLinks(dir) : [];
    const catalogErrors: string[] = [];
    if (checked.valid) {
      try { await loadSkillResourceIndex(dir, { checkCoverage: true }); }
      catch (error) { catalogErrors.push(`资源索引：${error instanceof Error ? error.message : String(error)}`); }
    }
    if (!checked.valid || missing.length || catalogErrors.length) {
      failures.push(`${rel}: ${[...checked.errors, ...missing.map((p) => `链接目标不存在：${p}`), ...catalogErrors].join("；")}`);
      continue;
    }
    console.log(`ok  ${rel}`);
  }
  for (const directory of await directories(path.join(ROOT, "workflows"))) {
    try { await fs.access(path.join(directory, "WORKFLOW.md")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      failures.push(String(error)); continue;
    }
    try {
      await loadSkillResourceIndex(directory, { checkCoverage: true });
      const missing = await missingRelativeLinks(directory, "WORKFLOW.md");
      if (missing.length) failures.push(`${directory}: ${missing.join("; ")}`);
    } catch (error) { failures.push(String(error)); }
  }
  if (failures.length) {
    for (const failure of failures) console.error(`ERR ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${dirs.length} 个 Agent Skills 包通过规范校验`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
