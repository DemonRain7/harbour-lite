/**
 * build-indexes —— 重生成索引（TS 版，无 Python 依赖）。`npm run index` 触发。
 *
 *  1) assets/Memory/ 下每个【子目录】的 index.md（从各页 frontmatter.description 汇总，渐进披露）；
 *     根 index.md 是固定全局分类入口、不动。
 *  2) 每个 agent 的 tools / skills / workflows / subagents / mcp 索引正文（frontmatter 白名单不动）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { exampleTools } from "../src/core/tools/examples";
import { createViewImageTool } from "../src/core/tools/viewImage";
import { spawnSubagentTool } from "../src/core/tools/spawnSubagent";
import { readSkillTool } from "../src/core/tools/readSkill";
import { readWorkflowTool } from "../src/core/tools/readWorkflow";
import { createRunWorkflowTool } from "../src/core/tools/runWorkflow";
import { WorkflowRegistry } from "../src/core/workflows/registry";
import { messageAgentTool } from "../src/core/tools/messageAgent";
import { createSkillTool } from "../src/core/tools/createSkill";
// browser 工具是「按 env 配置产出」的工厂（隔离 Chrome 的路径/端口来自 .env），
// 这里只为拿 name/description 生成索引，用默认 env 造一份即可。
import { createBrowserHarnessTools, resolveBrowserHarnessConfig } from "../src/core/tools/browserHarness";
import { createOpenCliTools, resolveOpenCliConfig } from "../src/core/tools/openCli";
import { createOpenCliBrowserTools, resolveOpenCliBrowserConfig } from "../src/core/tools/openCliBrowser";
import { loadEnv } from "../src/config/env";
import { desktopTools } from "../src/core/tools/desktop";
import { dreamTool } from "../src/core/tools/dream";
import { loadMcpServers, scanSkills, scanSubagents, scanWorkflows } from "../src/config/loadAgents";
import { bashTool } from "../src/core/tools/bash";
import { readHistoryTool } from "../src/core/tools/readHistory";
import { memoryReadTool } from "../src/core/tools/memoryRead";
import { askUserTool } from "../src/core/tools/askUser";
import { submitPlanTool } from "../src/core/tools/submitPlan";
import { updateProgressTool } from "../src/core/tools/updateProgress";
import { ttsTool } from "../src/core/tools/tts";
import { companionMusicTool } from "../src/core/tools/companionMusic";
import { createCronManageTool } from "../src/core/tools/cronManage";
import { createCalendarTools } from "../src/core/tools/calendar";
import { createGmailTools } from "../src/core/tools/gmail";
import { createMapsTools } from "../src/core/tools/maps";
import { createMcpTools } from "../src/core/tools/mcp";
import { createNovelAiCharacterTool } from "../src/core/tools/novelAiCharacter";
import { novelAiComposeTool } from "../src/core/tools/novelAiCompose";
import { createListAgentsTool } from "../src/core/tools/listAgents";
import { createNewsTools, resolveNewsConfig } from "../src/core/tools/dailyNews";
import { rebuildMemoryIndexes } from "../src/memory/rebuildIndexes";
import {
  defaultNovelAiCharacterLibraryDir,
  rebuildNovelAiCharacterIndex,
} from "../src/core/novelAiCharacterLibrary";

const ROOT = process.cwd();
const MEMORY = path.join(ROOT, "assets", "Memory");
const AGENTS = path.join(ROOT, "agents");
const BUILD_ENV = loadEnv();

// 与 runtime.ts 的工具注册保持一致：新增工具时两处同步，否则 index 会把它标成「未注册」。
const TOOL_DESC: Record<string, string> = {};
const INDEX_WORKFLOW_REGISTRY = new WorkflowRegistry();
for (const t of [
  ...exampleTools,
  createViewImageTool(),
  spawnSubagentTool,
  readSkillTool,
  readWorkflowTool,
  createRunWorkflowTool(INDEX_WORKFLOW_REGISTRY),
  messageAgentTool,
  createSkillTool,
  ...createOpenCliTools(resolveOpenCliConfig(BUILD_ENV)),
  ...createOpenCliBrowserTools(resolveOpenCliBrowserConfig(BUILD_ENV)),
  ...createBrowserHarnessTools(resolveBrowserHarnessConfig(BUILD_ENV)),
  ...createNewsTools(resolveNewsConfig(BUILD_ENV)),
  ...desktopTools,
  dreamTool,
  bashTool,
  readHistoryTool,
  memoryReadTool,
  askUserTool,
  submitPlanTool,
  updateProgressTool,
  ttsTool,
  companionMusicTool,
  createCronManageTool(),
  ...createCalendarTools(),
  ...createGmailTools(),
  ...createMapsTools(),
  ...createMcpTools(),
  createNovelAiCharacterTool(),
  novelAiComposeTool,
  createListAgentsTool(() => []),
]) {
  TOOL_DESC[t.name] = t.description;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function buildAgentToolIndexes(): Promise<void> {
  if (!(await exists(AGENTS))) return;
  const dirs = (await fs.readdir(AGENTS, { withFileTypes: true })).filter((e) => e.isDirectory());
  for (const d of dirs) {
    const tp = path.join(AGENTS, d.name, "tools", "index.md");
    if (!(await exists(tp))) continue;
    const parsed = matter(await fs.readFile(tp, "utf8"));
    const tools: string[] = (parsed.data as { tools?: string[] }).tools ?? [];
    const body = [
      `# TOOL 白名单 —— ${d.name}`,
      "",
      "> frontmatter `tools` 是白名单；正文由 `npm run index` 从工具注册表回填。",
      "",
    ];
    if (tools.length) for (const t of tools) body.push(`- \`${t}\` — ${TOOL_DESC[t] ?? "（未注册工具）"}`);
    else body.push("- （无）");
    await fs.writeFile(tp, matter.stringify(`\n${body.join("\n")}\n`, parsed.data), "utf8");
    console.log("tools index:", path.relative(ROOT, tp));
  }
}

/** agent/skills/index.md frontmatter 是挂载白名单；正文从根 skills/ 真身生成。 */
async function buildAgentSkillIndexes(): Promise<void> {
  if (!(await exists(AGENTS))) return;
  const dirs = (await fs.readdir(AGENTS, { withFileTypes: true })).filter((e) => e.isDirectory());
  for (const d of dirs) {
    const agentDir = path.join(AGENTS, d.name);
    const indexPath = path.join(agentDir, "skills", "index.md");
    if (!(await exists(indexPath))) continue;
    const parsed = matter(await fs.readFile(indexPath, "utf8"));
    const mounted = Array.isArray(parsed.data.skills) ? parsed.data.skills.map(String) : [];
    const skills = await scanSkills(mounted);
    const body = [
      `# SKILL 清单 —— ${d.name}`,
      "",
      "> frontmatter `skills` 是挂载白名单；真身统一位于项目根 `skills/<name>/`。",
      "> 正文由 `npm run index` 回填；模型按需自主加载，用户无需点名。",
      "",
    ];
    if (skills.length) for (const skill of skills) body.push(`- \`${skill.name}\` — ${skill.description}`);
    else body.push("- （无）");
    await fs.writeFile(indexPath, matter.stringify(`\n${body.join("\n")}\n`, parsed.data), "utf8");
    console.log("skills index:", path.relative(ROOT, indexPath));
  }
}

/** agent/workflows/index.md frontmatter 是固定 Workflow 挂载白名单。 */
async function buildAgentWorkflowIndexes(): Promise<void> {
  if (!(await exists(AGENTS))) return;
  const dirs = (await fs.readdir(AGENTS, { withFileTypes: true })).filter((e) => e.isDirectory());
  for (const d of dirs) {
    const indexPath = path.join(AGENTS, d.name, "workflows", "index.md");
    if (!(await exists(indexPath))) continue;
    const parsed = matter(await fs.readFile(indexPath, "utf8"));
    const mounted = Array.isArray(parsed.data.workflows) ? parsed.data.workflows.map(String) : [];
    const workflows = await scanWorkflows(mounted);
    const body = [
      `# WORKFLOW 挂载 —— ${d.name}`,
      "",
      "> frontmatter `workflows` 是挂载白名单；真身统一位于项目根 `workflows/<name>/WORKFLOW.md`。",
      "> 正文由 `npm run index` 回填；完整契约按需使用 `read_workflow` 懒加载。",
      "",
    ];
    if (workflows.length) {
      for (const workflow of workflows) body.push(`- \`${workflow.name}\` — ${workflow.description}`);
    } else body.push("- （无）");
    await fs.writeFile(indexPath, matter.stringify(`\n${body.join("\n")}\n`, parsed.data), "utf8");
    console.log("workflows index:", path.relative(ROOT, indexPath));
  }
}

/** agent/subagents/index.md frontmatter 是固定专精 Agent 派发白名单。 */
async function buildAgentSubagentIndexes(): Promise<void> {
  if (!(await exists(AGENTS))) return;
  const dirs = (await fs.readdir(AGENTS, { withFileTypes: true })).filter((e) => e.isDirectory());
  for (const d of dirs) {
    const indexPath = path.join(AGENTS, d.name, "subagents", "index.md");
    if (!(await exists(indexPath))) continue;
    const parsed = matter(await fs.readFile(indexPath, "utf8"));
    const mounted = Array.isArray(parsed.data.subagents) ? parsed.data.subagents.map(String) : [];
    const subagents = await scanSubagents(mounted, AGENTS, undefined, d.name);
    const body = [
      `# SUBAGENT 白名单 —— ${d.name}`,
      "",
      "> frontmatter `subagents` 是可同步派发白名单；描述来自目标 Agent 的 `CLAUDE.md` frontmatter。",
      "> 正文由 `npm run index` 回填；目标 Agent 的完整 prompt 仅在真正派发后装载。",
      "",
    ];
    if (subagents.length) for (const agent of subagents) body.push(`- \`${agent.name}\` — ${agent.description}`);
    else body.push("- （无）");
    await fs.writeFile(indexPath, matter.stringify(`\n${body.join("\n")}\n`, parsed.data), "utf8");
    console.log("subagents index:", path.relative(ROOT, indexPath));
  }
}

/** agent/mcp/index.md frontmatter 是挂载白名单；正文从根 mcp/ 真身生成。 */
async function buildAgentMcpIndexes(): Promise<void> {
  if (!(await exists(AGENTS))) return;
  const dirs = (await fs.readdir(AGENTS, { withFileTypes: true })).filter((e) => e.isDirectory());
  for (const d of dirs) {
    const indexPath = path.join(AGENTS, d.name, "mcp", "index.md");
    if (!(await exists(indexPath))) continue;
    const parsed = matter(await fs.readFile(indexPath, "utf8"));
    const mounted = Array.isArray(parsed.data.servers) ? parsed.data.servers.map(String) : [];
    const servers = await loadMcpServers(mounted);
    const body = [
      `# MCP 挂载 —— ${d.name}`,
      "",
      "> frontmatter `servers` 是挂载白名单；真身统一位于项目根 `mcp/<name>/MCP.md`。",
      "> 正文由 `npm run index` 回填；具体工具 schema 由 MCP server 运行时提供。",
      "",
    ];
    if (servers.length) for (const server of servers) body.push(`- \`${server.name}\` — ${server.description || "外部 MCP server"}`);
    else body.push("- （无）");
    await fs.writeFile(indexPath, matter.stringify(`\n${body.join("\n")}\n`, parsed.data), "utf8");
    console.log("mcp index:", path.relative(ROOT, indexPath));
  }
}

async function main(): Promise<void> {
  const characterLibrary = defaultNovelAiCharacterLibraryDir();
  if (await exists(characterLibrary)) {
    const characterIndex = await rebuildNovelAiCharacterIndex(characterLibrary, { write: true });
    console.log("character index:", path.relative(ROOT, path.join(characterLibrary, "index.json")), `(${Object.keys(characterIndex.aliases).length} aliases)`);
  }
  if (await exists(MEMORY)) {
    const memoryIndexes = await rebuildMemoryIndexes(MEMORY);
    for (const rel of memoryIndexes.generated) console.log("memory index:", path.join("assets", "Memory", rel));
  } else console.log("assets/Memory 不存在，跳过记忆索引");
  await buildAgentToolIndexes();
  await buildAgentSkillIndexes();
  await buildAgentWorkflowIndexes();
  await buildAgentSubagentIndexes();
  await buildAgentMcpIndexes();
  console.log("✓ build-indexes 完成");
}

main().catch((e) => {
  console.error("build-indexes 失败:", e);
  process.exit(1);
});
