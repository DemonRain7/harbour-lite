import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import {
  AGENT_PERMISSION_MODES,
  REASONING_EFFORTS,
  type Agent,
  type AgentMcpServer,
  type AgentSkill,
  type AgentSubagent,
  type AgentWorkflow,
  type Governance,
  type HeartbeatTask,
} from "../types";
import type { Logger } from "pino";

/**
 * 扫 agents/ 目录，把每个 agent 解析成一个 Agent。
 *
 * 两种形态（同时支持，文件夹优先）：
 *  1) 文件夹型（推荐，OpenClaw 风）：agents/<name>/
 *       CLAUDE.md(清单: frontmatter 配置+governance + 正文角色)
 *       SOUL.md / PUBLIC.md / HEARTBEAT.md / MEMORY.md / tools|skills|subagents|mcp/index.md
 *     装载器把这些按固定顺序装配成 systemPrompt（每次运行都被读取）。
 *  2) 扁平型（兼容旧版）：agents/<name>.md（frontmatter + 正文=systemPrompt）。
 *
 * 设计哲学不变：加一个 agent = 丢一个文件夹/文件，不改核心代码。
 */

const MEMORY_ROOT = path.resolve(process.cwd(), "assets", "Memory");
const SKILLS_ROOT = path.resolve(process.cwd(), "skills");
const MCP_ROOT = path.resolve(process.cwd(), "mcp");
const WORKFLOWS_ROOT = path.resolve(process.cwd(), "workflows");

const PermissionsSchema = z
  .object({
    readPaths: z.array(z.string()).optional(),
    writePaths: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
    mcp: z.array(z.string()).optional(),
    readOnly: z.boolean().optional(),
  })
  .optional();

const GovernanceSchema = z
  .object({
    temperature: z.number().optional(),
    allowedModels: z.array(z.string()).optional(),
    maxTokensPerRun: z.number().int().positive().optional(),
    tokenBudgetMode: z.enum(["hard", "converge"]).optional(),
    hardMaxTokensPerRun: z.number().int().positive().optional(),
    permissions: PermissionsSchema,
  })
  .superRefine((value, ctx) => {
    if (value?.tokenBudgetMode === "converge" && value.hardMaxTokensPerRun !== undefined &&
        value.maxTokensPerRun !== undefined && value.hardMaxTokensPerRun <= value.maxTokensPerRun) {
      ctx.addIssue({
        code: "custom",
        path: ["hardMaxTokensPerRun"],
        message: "converge 模式的 hardMaxTokensPerRun 必须大于 maxTokensPerRun",
      });
    }
  })
  .optional();

/** 文件夹型 agent 的 CLAUDE.md frontmatter。 */
export const ManifestSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  model: z.string().optional(),
  taskType: z.string().default("research"),
  contextBudget: z.union([z.number().int().positive(), z.literal("auto")]).optional(),
  maxSteps: z.number().int().positive().optional(),
  permissionMode: z.enum(AGENT_PERMISSION_MODES).default("dontAsk"),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  routerOverrides: z.record(z.string(), z.string()).optional(),
  fallbacks: z.array(z.string()).optional(),
  readsGlobalMemory: z.boolean().optional().default(false),
  governance: GovernanceSchema,
});

/** 扁平型旧 .md 的 frontmatter（兼容）。 */
const FlatSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  model: z.string().optional(),
  taskType: z.string().default("research"),
  tools: z.array(z.string()).default([]),
  contextBudget: z.union([z.number().int().positive(), z.literal("auto")]).optional(),
  maxSteps: z.number().int().positive().optional(),
  permissionMode: z.enum(AGENT_PERMISSION_MODES).default("dontAsk"),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  routerOverrides: z.record(z.string(), z.string()).optional(),
  fallbacks: z.array(z.string()).optional(),
});

const ToolsIndexSchema = z.object({ tools: z.array(z.string()).default([]) });
const SkillsIndexSchema = z.object({ skills: z.array(z.string()).default([]) });
const WorkflowsIndexSchema = z.object({ workflows: z.array(z.string()).default([]) });
const SubagentsIndexSchema = z.object({ subagents: z.array(z.string()).default([]) });

/** 根 mcp/<name>/MCP.md：外部 MCP server 的唯一真身。 */
export const McpDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  command: z.string().min(1).optional(),
  transport: z.enum(["stdio", "http"]).optional(),
  url: z.string().url().optional(),
  readOnly: z.boolean().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  allow: z.array(z.string()).optional(),
}).superRefine((server, ctx) => {
  if (server.transport !== "http") {
    if (!server.command || server.url) ctx.addIssue({ code: "custom", message: "stdio MCP 必须提供 command，不能配置 url" });
    return;
  }
  // First managed transport is deliberately keyless/read-only. Credentialed or
  // mutating servers require a separate reviewed integration, not hidden env inheritance.
  let validUrl = false;
  try {
    const url = new URL(server.url ?? "");
    validUrl = url.protocol === "https:" && !url.username && !url.password && !url.hash &&
      ![...url.searchParams.keys()].some(key => /key|token|secret|login|auth/i.test(key));
  } catch { /* validation below */ }
  if (!validUrl || server.command || server.args || server.env || server.readOnly !== true ||
      !server.allow?.length || server.allow.some(name => !/^[a-zA-Z0-9_-]{1,100}$/.test(name))) {
    ctx.addIssue({ code: "custom", message: "HTTP MCP 仅接受无凭据的 HTTPS URL、readOnly:true 和非空精确 allow 白名单" });
  }
});
/** agent/mcp/index.md 只列挂载名，不重复 server 配置。 */
const McpIndexSchema = z.object({ servers: z.array(z.string()).default([]) });
const WorkflowDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().min(1).max(1024),
  executor: z.string().min(1).max(120),
  version: z.number().int().positive().default(1),
});
const HeartbeatSchema = z.object({
  tasks: z
    .array(
      z.object({
        cron: z.string().optional(),
        every: z.string().optional(),
        timeZone: z.string().optional(),
        input: z.string(),
        taskType: z.string().optional(),
      })
    )
    .default([]),
});

export async function loadAgents(agentsDir: string, logger?: Logger, isDelegationEnabled: (name: string) => boolean = () => true): Promise<Agent[]> {
  const dir = path.resolve(process.cwd(), agentsDir);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`无法读取 agents 目录 ${dir}: ${(e as Error).message}`);
  }

  const agents: Agent[] = [];
  for (const entry of entries) {
    try {
      if (entry.isDirectory()) {
        const agent = await loadFolderAgent(path.join(dir, entry.name), entry.name, logger, isDelegationEnabled);
        if (agent) agents.push(agent);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const agent = await loadFlatAgent(path.join(dir, entry.name), entry.name, logger);
        if (agent) agents.push(agent);
      }
    } catch (e) {
      logger?.error({ entry: entry.name, err: (e as Error).message }, "agent 装载失败，已跳过");
    }
  }

  logger?.info({ count: agents.length, agents: agents.map((a) => a.name) }, "已装载 agents");
  return agents;
}

/* ── 全局技能注册表 ───────────────────────────────────────────────
 * Skill 真身只允许位于项目根 skills/<id>/SKILL.md；每个 agent 的
 * skills/index.md frontmatter.skills 是挂载白名单，正文只是生成快照。
 * 不再扫描 agent 私有技能，也不存在同名覆盖，路径与权限只有一套。
 */
export interface SkillValidationResult {
  valid: boolean;
  name?: string;
  description?: string;
  errors: string[];
}

/** 按 agentskills.io/specification 校验单个技能包的必需元数据与目录名。 */
export async function validateSkillPackage(skillDir: string): Promise<SkillValidationResult> {
  const directoryName = path.basename(skillDir);
  const raw = await readFileSafe(path.join(skillDir, "SKILL.md"));
  if (!raw) return { valid: false, errors: ["缺少 SKILL.md"] };

  let data: Record<string, unknown>;
  try {
    data = matter(raw).data as Record<string, unknown>;
  } catch (e) {
    return { valid: false, errors: [`YAML frontmatter 无法解析：${(e as Error).message}`] };
  }

  const errors: string[] = [];
  const allowedFields = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
  const unknownFields = Object.keys(data).filter((key) => !allowedFields.has(key));
  if (unknownFields.length) errors.push(`不支持的 frontmatter 字段：${unknownFields.join(", ")}`);
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (!name) errors.push("缺少 name");
  else {
    if (name.length > 64) errors.push("name 超过 64 字符");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) errors.push("name 必须是小写 kebab-case");
    if (name !== directoryName) errors.push(`name「${name}」与目录名「${directoryName}」不一致`);
  }
  if (!description) errors.push("缺少 description");
  else if (description.length > 1024) errors.push("description 超过 1024 字符");
  if (data.compatibility !== undefined) {
    if (typeof data.compatibility !== "string") errors.push("compatibility 必须是字符串");
    else if (data.compatibility.length > 500) errors.push("compatibility 超过 500 字符");
  }
  if (data.metadata !== undefined) {
    const metadata = data.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) errors.push("metadata 必须是字符串键值映射");
    else if (Object.values(metadata as Record<string, unknown>).some((v) => typeof v !== "string")) {
      errors.push("metadata 的所有值都必须是字符串");
    }
  }
  if (data["allowed-tools"] !== undefined && typeof data["allowed-tools"] !== "string") {
    errors.push("allowed-tools 必须是空格分隔的字符串");
  }
  return { valid: errors.length === 0, name: name || undefined, description: description || undefined, errors };
}

async function scanSkillRoot(
  base: string,
  allow?: Set<string>,
  logger?: Logger
): Promise<AgentSkill[]> {
  let entries;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: AgentSkill[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (allow && !allow.has(e.name)) continue;
    const directory = path.join(base, e.name);
    const checked = await validateSkillPackage(directory);
    if (!checked.valid) {
      logger?.error({ skill: directory, errors: checked.errors }, "Agent Skill 不符合规范，已跳过");
      continue;
    }
    out.push({ name: checked.name!, description: checked.description!, directory, source: "global" });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** 按 agent/skills/index.md 的名字挂载根 skills/ 中的真身。 */
export async function scanSkills(skillIds: string[] = [], logger?: Logger): Promise<AgentSkill[]> {
  const wanted = new Set(skillIds);
  const skills = await scanSkillRoot(SKILLS_ROOT, wanted, logger);
  const found = new Set(skills.map((s) => s.name));
  for (const id of wanted) {
    if (!found.has(id)) logger?.error({ skill: id }, "Agent Skill 已挂载但根 skills/ 中不存在或不合法");
  }
  return skills;
}

/** 装进 system 的能力目录只含元数据，Skill 正文仍由 read_skill 按需加载。 */
async function buildSkillsSection(skills: AgentSkill[]): Promise<string> {
  return skills.map((s) => `- \`${s.name}\` — ${s.description}`).join("\n");
}

/** 按 agent/workflows/index.md 的名字解析根 workflows/<name>/WORKFLOW.md 真身。 */
export async function scanWorkflows(
  workflowIds: string[] = [],
  logger?: Logger
): Promise<AgentWorkflow[]> {
  const workflows: AgentWorkflow[] = [];
  for (const id of [...new Set(workflowIds.map(String))]) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      logger?.error({ workflow: id }, "Workflow 挂载名非法，已跳过");
      continue;
    }
    const directory = path.join(WORKFLOWS_ROOT, id);
    const file = path.join(directory, "WORKFLOW.md");
    const raw = await readFileSafe(file);
    if (!raw) {
      logger?.error({ workflow: id, file }, "Workflow 已挂载但根 workflows/ 中没有真身");
      continue;
    }
    const checked = WorkflowDefinitionSchema.safeParse(matter(raw).data);
    if (!checked.success || checked.data.name !== id) {
      logger?.error(
        { workflow: id, file, issues: checked.success ? [`name 必须等于目录名 ${id}`] : checked.error.issues },
        "Workflow 定义非法，已跳过"
      );
      continue;
    }
    workflows.push({
      name: id,
      description: checked.data.description.trim(),
      executor: checked.data.executor.trim(),
      directory,
      version: checked.data.version,
    });
  }
  return workflows;
}

function buildWorkflowsSection(workflows: AgentWorkflow[]): string {
  return workflows.map((workflow) => `- \`${workflow.name}\` — ${workflow.description}`).join("\n");
}

/**
 * 解析 agent/subagents/index.md 中的挂载名，只读取目标 CLAUDE.md frontmatter 的
 * name + description。完整目标 prompt 要等真正 spawn 后才由目标 Agent 自己装载。
 */
export async function scanSubagents(
  agentIds: string[] = [],
  agentsRoot = path.resolve(process.cwd(), "agents"),
  logger?: Logger,
  callerName?: string,
): Promise<AgentSubagent[]> {
  const out: AgentSubagent[] = [];
  for (const id of [...new Set(agentIds.map(String))]) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || id.startsWith("main-") || id === callerName) {
      logger?.error({ caller: callerName, subagent: id }, "subagents/index.md 含非法、自派或入口 persona，已跳过");
      continue;
    }
    const folderFile = path.join(agentsRoot, id, "CLAUDE.md");
    const flatFile = path.join(agentsRoot, `${id}.md`);
    const folderRaw = await readFileSafe(folderFile);
    const flatRaw = folderRaw ? "" : await readFileSafe(flatFile);
    const raw = folderRaw || flatRaw;
    if (!raw) {
      logger?.error({ caller: callerName, subagent: id }, "Subagent 已挂载但 agents/ 中不存在");
      continue;
    }
    const parsed = matter(raw);
    const checked = folderRaw ? ManifestSchema.safeParse(parsed.data) : FlatSchema.safeParse(parsed.data);
    if (!checked.success) {
      logger?.error({ caller: callerName, subagent: id, issues: checked.error.issues }, "挂载的 Subagent manifest 非法");
      continue;
    }
    const actualName = checked.data.name ?? id;
    if (actualName !== id) {
      logger?.error({ caller: callerName, subagent: id, actualName }, "Subagent 挂载名与 manifest name 不一致");
      continue;
    }
    out.push({
      name: id,
      description: checked.data.description?.trim() || `专精 Agent：${id}`,
    });
  }
  return out;
}

function buildSubagentsSection(subagents: AgentSubagent[]): string {
  return subagents.map((agent) => `- \`${agent.name}\` — ${agent.description}`).join("\n");
}

/** 按 agent/mcp/index.md 的名字解析根 mcp/<name>/MCP.md 真身。 */
export async function loadMcpServers(serverIds: string[] = [], logger?: Logger): Promise<AgentMcpServer[]> {
  const servers: AgentMcpServer[] = [];
  for (const id of [...new Set(serverIds)]) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      logger?.error({ mcp: id }, "MCP 挂载名非法，已跳过");
      continue;
    }
    const file = path.join(MCP_ROOT, id, "MCP.md");
    const raw = await readFileSafe(file);
    if (!raw) {
      logger?.error({ mcp: id, file }, "MCP 已挂载但根 mcp/ 中没有真身");
      continue;
    }
    const parsed = matter(raw);
    const checked = McpDefinitionSchema.safeParse(parsed.data);
    if (!checked.success || checked.data.name !== id) {
      logger?.error(
        { mcp: id, file, issues: checked.success ? [`name 必须等于目录名 ${id}`] : checked.error.issues },
        "MCP 定义非法，已跳过"
      );
      continue;
    }
    servers.push({
      ...checked.data,
      description: checked.data.description?.trim() || parsed.content.trim().split("\n").find((line) => line.trim() && !line.startsWith("#"))?.trim(),
    });
  }
  return servers;
}

function buildMcpSection(servers: AgentMcpServer[]): string {
  return servers.map((s) => `- \`${s.name}\` — ${s.description || "外部 MCP server"}`).join("\n");
}

/* ── 文件夹型 ──────────────────────────────────────────────────── */

async function loadFolderAgent(agentDir: string, dirName: string, logger?: Logger, isDelegationEnabled: (name: string) => boolean = () => true): Promise<Agent | null> {
  const manifestPath = path.join(agentDir, "CLAUDE.md");
  const manifestRaw = await readFileSafe(manifestPath);
  if (!manifestRaw) {
    // 没有 CLAUDE.md 的目录不是 agent（可能是 mockdata 等），静默跳过。
    return null;
  }
  const parsed = matter(manifestRaw);
  const fm = ManifestSchema.safeParse(parsed.data);
  if (!fm.success) {
    logger?.error({ dir: dirName, issues: fm.error.issues }, "agent CLAUDE.md 配置非法，已跳过");
    return null;
  }
  const cfg = fm.data;
  const name = cfg.name ?? dirName;

  // 各 bootstrap 文件（缺失即空）。人格 / 主人 / 偏好 / 记忆都放 agent 自己文件夹下。
  const soul = await readSection(path.join(agentDir, "SOUL.md"));
  // PUBLIC.md 是 non-owner 的独立、完整 prompt；绝不从私密 systemPrompt 做字符串删改，
  // 否则 SOUL/CLAUDE 里散落的主人关系仍可能漏出去。
  const publicSystemPrompt = await readSection(path.join(agentDir, "PUBLIC.md"));
  const master = await readSection(path.join(agentDir, "MASTER.md"));
  const preference = await readSection(path.join(agentDir, "PREFERENCE.md"));
  const memory = await readSection(path.join(agentDir, "MEMORY.md"));
  const manifestBodyRaw = parsed.content.trim();
  const toolsRaw = await readFileSafe(path.join(agentDir, "tools", "index.md"));
  // Agent 侧 index 只保存挂载名；Skill/Workflow/MCP 真身分别统一在项目根目录。
  const skillsRaw = await readFileSafe(path.join(agentDir, "skills", "index.md"));
  const skillIndex = skillsRaw ? SkillsIndexSchema.safeParse(matter(skillsRaw).data) : null;
  if (skillIndex && !skillIndex.success) logger?.error({ agent: name, issues: skillIndex.error.issues }, "skills/index.md 非法");
  const skills = await scanSkills(skillIndex?.success ? skillIndex.data.skills : [], logger);
  const skillsBody = await buildSkillsSection(skills);
  const workflowsRaw = await readFileSafe(path.join(agentDir, "workflows", "index.md"));
  const workflowIndex = workflowsRaw ? WorkflowsIndexSchema.safeParse(matter(workflowsRaw).data) : null;
  if (workflowIndex && !workflowIndex.success) {
    logger?.error({ agent: name, issues: workflowIndex.error.issues }, "workflows/index.md 非法");
  }
  const workflows = await scanWorkflows(workflowIndex?.success ? workflowIndex.data.workflows : [], logger);
  const workflowsBody = buildWorkflowsSection(workflows);
  const subagentsRaw = await readFileSafe(path.join(agentDir, "subagents", "index.md"));
  const subagentIndex = subagentsRaw ? SubagentsIndexSchema.safeParse(matter(subagentsRaw).data) : null;
  if (subagentIndex && !subagentIndex.success) {
    logger?.error({ agent: name, issues: subagentIndex.error.issues }, "subagents/index.md 非法");
  }
  const subagents = (await scanSubagents(
    subagentIndex?.success ? subagentIndex.data.subagents : [],
    path.dirname(agentDir),
    logger,
    name,
  )).filter(agent => isDelegationEnabled(agent.name));
  const subagentsBody = buildSubagentsSection(subagents);
  const mcpRaw = await readFileSafe(path.join(agentDir, "mcp", "index.md"));
  const mcpIndex = mcpRaw ? McpIndexSchema.safeParse(matter(mcpRaw).data) : null;
  if (mcpIndex && !mcpIndex.success) logger?.error({ agent: name, issues: mcpIndex.error.issues }, "mcp/index.md 非法");
  const mcpServers = await loadMcpServers(mcpIndex?.success ? mcpIndex.data.servers : [], logger);
  const mcpBody = buildMcpSection(mcpServers);
  const heartbeatRaw = await readFileSafe(path.join(agentDir, "HEARTBEAT.md"));
  const toolsBody = toolsRaw ? matter(toolsRaw).content.trim() : "";

  // 工具白名单：从 tools/index.md 的 frontmatter.tools 取。
  const tools = toolsRaw ? ToolsIndexSchema.safeParse(matter(toolsRaw).data).data?.tools ?? [] : [];

  // HEARTBEAT 定时任务：从 HEARTBEAT.md 的 frontmatter.tasks 取。
  const heartbeats: HeartbeatTask[] = heartbeatRaw
    ? (HeartbeatSchema.safeParse(matter(heartbeatRaw).data).data?.tasks ?? [])
    : [];

  // 全局共享记忆库根索引（仅 readsGlobalMemory 的 agent 装载，当前只有 main）。
  // 注：主人档案 MASTER / 偏好 PREFERENCE 已改放各 agent 文件夹，经 CLAUDE.md 的 @ 引用装载。
  let globalIndex = "";
  if (cfg.readsGlobalMemory) {
    globalIndex = await readSection(path.join(MEMORY_ROOT, "index.md"));
    if (!globalIndex) {
      logger?.warn({ agent: name }, "readsGlobalMemory=true 但 assets/Memory/index.md 为空/缺失（属正常）");
    }
  }

  // CLAUDE.md 用 `@文件.md` 引用人格 / 主人 / 偏好 / 记忆片段；装载器原地展开，
  // 并记录被引用过的文件名，避免它们又被重复单独装配（见 assembleSystemPrompt）。
  const { resolved: manifestBody, referenced } = resolveRefs(manifestBodyRaw, {
    "SOUL.md": soul,
    "MASTER.md": master,
    "PREFERENCE.md": preference,
    "MEMORY.md": memory,
  });

  const systemPrompt = assembleSystemPrompt({
    soul,
    master,
    preference,
    globalIndex,
    manifestBody,
    toolsBody,
    skillsBody,
    workflowsBody,
    subagentsBody,
    mcpBody,
    heartbeatBody: heartbeatRaw ? matter(heartbeatRaw).content.trim() : "",
    memory,
    referenced,
  });

  return {
    name,
    description: cfg.description,
    systemPrompt,
    ...(publicSystemPrompt ? { publicSystemPrompt } : {}),
    model: cfg.model,
    taskType: cfg.taskType,
    tools,
    contextBudget: cfg.contextBudget ?? "auto",
    maxSteps: cfg.maxSteps,
    permissionMode: cfg.permissionMode,
    reasoningEffort: cfg.reasoningEffort,
    routerOverrides: cfg.routerOverrides,
    fallbacks: cfg.fallbacks,
    governance: cfg.governance as Governance | undefined,
    mcpServers,
    readsGlobalMemory: cfg.readsGlobalMemory,
    agentDir,
    skills,
    ...(workflowsRaw ? { workflows } : {}),
    ...(subagentsRaw ? { subagents } : {}),
    heartbeats,
  };
}

/**
 * 展开 CLAUDE.md 里的 `@文件.md` 引用（仅人格 / 主人 / 偏好 / 记忆片段），
 * 返回展开后的正文 + 被引用过的文件名集合。非人格片段（如文档里写的
 * `@tools/index.md`）不在白名单内，原样保留。
 */
function resolveRefs(
  body: string,
  files: Record<string, string>
): { resolved: string; referenced: Set<string> } {
  const referenced = new Set<string>();
  const resolved = body.replace(/@([A-Za-z0-9_./-]+\.md)/g, (whole, name: string) => {
    if (name in files) {
      referenced.add(name);
      return files[name] || `（${name} 暂空）`;
    }
    return whole;
  });
  return { resolved, referenced };
}

/**
 * 把各段装配成 systemPrompt（每次运行都被读取的「宪法」）。
 * 人格 / 主人 / 偏好 / 记忆若已被 CLAUDE.md 的 `@` 就地展开（在 referenced 里），
 * 就不再单独装配，避免重复（main 走这条路，由 CLAUDE.md 自己编排顺序）。
 * 未被引用的（如子 agent 的 SOUL/MEMORY）按固定顺序补上，兼容旧写法。
 */
function assembleSystemPrompt(p: {
  soul: string;
  master: string;
  preference: string;
  globalIndex: string;
  manifestBody: string;
  toolsBody: string;
  skillsBody: string;
  workflowsBody: string;
  subagentsBody: string;
  mcpBody: string;
  heartbeatBody: string;
  memory: string;
  referenced: Set<string>;
}): string {
  const parts: string[] = [];
  const inlined = (f: string) => p.referenced.has(f);
  /**
   * 给一段正文加章节标题；若正文自己第一行就是同名 H1 就不再加 —— 否则同一个标题会
   * 出现两遍（assets/Memory/index.md 正文自带「# 全局记忆 · 根索引」，装配器又包一层，
   * 实测装出来是重复的）。白占 token，还让模型以为是两段不同内容。
   */
  const section = (title: string, body: string): string =>
    body.trimStart().split("\n", 1)[0]?.trim() === `# ${title}` ? body : `# ${title}\n${body}`;

  if (p.soul && !inlined("SOUL.md")) parts.push(p.soul);
  if (p.master && !inlined("MASTER.md")) parts.push(section("主人档案（MASTER）", p.master));
  if (p.preference && !inlined("PREFERENCE.md")) parts.push(section("主人偏好（PREFERENCE）", p.preference));
  if (p.manifestBody) parts.push(p.manifestBody);
  if (p.memory && !inlined("MEMORY.md")) parts.push(section("我的记忆（MEMORY）", p.memory));
  if (p.globalIndex) parts.push(section("全局记忆 · 根索引", p.globalIndex));
  if (p.toolsBody) parts.push(section("可用工具（TOOL 白名单）", p.toolsBody));
  if (p.skillsBody) {
    parts.push(section(
      "可用技能（按 description 语义自动匹配；用户无需点名；命中后用 read_skill 懒加载）",
      p.skillsBody
    ));
  }
  if (p.workflowsBody) {
    parts.push(section(
      "可用 Workflow（固定 DAG/状态机；命中后用 read_workflow 读契约，再用 run_workflow 执行）",
      p.workflowsBody
    ));
  }
  if (p.subagentsBody) {
    parts.push(section(
      "可用专精 Agent（按 description 语义选择；用 spawn_subagent 一次性交接完整目标）",
      p.subagentsBody
    ));
  }
  if (p.mcpBody) parts.push(section("可用 MCP", p.mcpBody));
  if (p.heartbeatBody) parts.push(section("定时任务（HEARTBEAT）", p.heartbeatBody));
  return parts.join("\n\n---\n\n");
}

/* ── 扁平型（兼容旧 .md）──────────────────────────────────────────── */

async function loadFlatAgent(file: string, fileName: string, logger?: Logger): Promise<Agent | null> {
  const raw = await fs.readFile(file, "utf8");
  const { data, content } = matter(raw);
  const parsed = FlatSchema.safeParse(data);
  if (!parsed.success) {
    logger?.error({ file: fileName, issues: parsed.error.issues }, "agent 配置非法，已跳过");
    return null;
  }
  const fm = parsed.data;
  const systemPrompt = content.trim();
  if (!systemPrompt) {
    logger?.warn({ file: fileName }, "agent 没有 systemPrompt（正文为空），已跳过");
    return null;
  }
  return {
    name: fm.name ?? path.basename(fileName, ".md"),
    description: fm.description,
    systemPrompt,
    model: fm.model,
    taskType: fm.taskType,
    tools: fm.tools,
    contextBudget: fm.contextBudget ?? "auto",
    maxSteps: fm.maxSteps,
    permissionMode: fm.permissionMode,
    reasoningEffort: fm.reasoningEffort,
    routerOverrides: fm.routerOverrides,
    fallbacks: fm.fallbacks,
  };
}

/* ── 小工具 ───────────────────────────────────────────────────── */

async function readFileSafe(p: string): Promise<string> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return "";
  }
}

/** 读文件并去掉 frontmatter，返回正文 trim（无 frontmatter 则返回全文）。 */
async function readSection(p: string): Promise<string> {
  const raw = await readFileSafe(p);
  if (!raw) return "";
  return matter(raw).content.trim();
}
