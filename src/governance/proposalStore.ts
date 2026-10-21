import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { commitMemory, commitGovernedFile, ensureMemoryRepo } from "./gitStore";
import { validateGovernedGraph } from "../core/workflows/workflowGraph";

export type ProposalStatus = "pending" | "approved" | "rejected" | "applied";
export type ProposalTargetType = "memory" | "agent" | "skill" | "workflow" | "mcp";
export type ProposalOperation = "write" | "append";

export interface GovernanceProposal {
  id: string;
  targetType: ProposalTargetType;
  targetPath: string;
  operation: ProposalOperation;
  beforeContent: string;
  beforeHash: string;
  afterContent: string;
  reason: string;
  sourceAgent?: string;
  status: ProposalStatus;
  createdAt: string;
  reviewedAt?: string;
  appliedAt?: string;
  reviewer?: string;
  /** apply 后在 Memory 本地 git 仓的提交 sha（仅 memory 目标）。 */
  commit?: string;
}

export interface CreateProposalInput {
  targetType: ProposalTargetType;
  targetPath: string;
  operation: ProposalOperation;
  content: string;
  reason: string;
  sourceAgent?: string;
  /** 可视化编辑器提交时防止旧页面覆盖他处的新内容。 */
  expectedBeforeHash?: string;
}

const ROOT = process.cwd();
const MEMORY_ROOT = path.resolve(ROOT, "assets", "Memory");
const AGENTS_ROOT = path.resolve(ROOT, "agents");
const SKILLS_ROOT = path.resolve(ROOT, "skills");
const WORKFLOWS_ROOT = path.resolve(ROOT, "workflows");
const MCP_ROOT = path.resolve(ROOT, "mcp");
const STORE_DIR = path.join(MEMORY_ROOT, ".governance");
const STORE_FILE = path.join(STORE_DIR, "proposals.json");
const AUDIT_FILE = path.join(STORE_DIR, "audit.jsonl");
const MEMORY_ROOT_INDEX = path.join(MEMORY_ROOT, "index.md");
const MEMORY_RETIRED_LOG = path.join(MEMORY_ROOT, "log.md");
// 人格 / 主人档案 / 偏好 / 记忆 / 心跳。MASTER 与 PREFERENCE 以前漏了，导致
// main-* 的主人档案和内容边界在面板上根本改不了（读得到也提交不了）。
const AGENT_ALLOWED_FILES = new Set([
  "CLAUDE.md", "SOUL.md", "PUBLIC.md", "MASTER.md", "PREFERENCE.md", "MEMORY.md", "HEARTBEAT.md",
]);
const AGENT_ALLOWED_INDEXES = new Set(["tools/index.md", "skills/index.md", "workflows/index.md", "subagents/index.md", "mcp/index.md"]);
export async function listProposals(): Promise<GovernanceProposal[]> {
  return readStore();
}

/**
 * 建提案 → 自动通过 → 立即落盘，一步到位。
 *
 * 【为什么要有这条路】agent 自己发起的写入（如 create_skill 脚手架新技能）本来是
 * 直接 fs.writeFile 的：能用，但【零留痕】——事后想知道「这技能哪来的、之前长什么样、
 * 怎么退回去」查无可查。走这条路后，proposals.json + audit.jsonl 里会有完整记录
 * （谁发起、什么理由、前后全文），配合仓库的 git 历史即可复原任意版本。
 *
 * 【为什么自动通过而不是等审批】这类是 agent 干活的正常产物，不该卡着她；
 * 需要人把关的是【改既有人格/边界】那类，那些仍走人工审批。
 * 换句话说：审批与否按「风险」分，留痕则【一律要有】。
 */
export async function createAndApplyProposal(
  input: CreateProposalInput & { reviewer?: string }
): Promise<GovernanceProposal> {
  const created = await createProposal(input);
  await approveProposal(created.id, input.reviewer ?? "auto");
  return applyProposal(created.id);
}

export async function createProposal(input: CreateProposalInput): Promise<GovernanceProposal> {
  const target = resolveGovernedPath(input.targetType, input.targetPath);
  const beforeContent = await readTextIfExists(target.abs);
  if (input.expectedBeforeHash !== undefined && hash(beforeContent) !== input.expectedBeforeHash) {
    throw new Error("目标文件已变化，请刷新后重新提交");
  }
  const afterContent =
    input.operation === "append" ? `${beforeContent}${input.content}` : input.content;
  if (input.targetType === "workflow") await validateGovernedGraph(target.rel, afterContent);

  const proposal: GovernanceProposal = {
    id: `gp-${randomUUID().slice(0, 8)}`,
    targetType: input.targetType,
    targetPath: target.rel,
    operation: input.operation,
    beforeContent,
    beforeHash: hash(beforeContent),
    afterContent,
    reason: input.reason,
    sourceAgent: input.sourceAgent,
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  const proposals = await readStore();
  proposals.unshift(proposal);
  await writeStore(proposals);
  await audit("create", proposal);
  return proposal;
}

export async function approveProposal(id: string, reviewer = "用户"): Promise<GovernanceProposal> {
  return updateProposal(id, (proposal) => {
    if (proposal.status !== "pending") throw new Error(`proposal ${id} 不是 pending，不能 approve`);
    proposal.status = "approved";
    proposal.reviewedAt = new Date().toISOString();
    proposal.reviewer = reviewer;
  }, "approve");
}

export async function rejectProposal(id: string, reviewer = "用户"): Promise<GovernanceProposal> {
  return updateProposal(id, (proposal) => {
    if (proposal.status !== "pending" && proposal.status !== "approved") {
      throw new Error(`proposal ${id} 已是 ${proposal.status}，不能 reject`);
    }
    proposal.status = "rejected";
    proposal.reviewedAt = new Date().toISOString();
    proposal.reviewer = reviewer;
  }, "reject");
}

export async function applyProposal(id: string): Promise<GovernanceProposal> {
  const proposals = await readStore();
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal) throw new Error(`未知 proposal: ${id}`);
  if (proposal.status !== "approved") throw new Error(`proposal ${id} 必须先 approve 才能 apply`);

  const target = resolveGovernedPath(proposal.targetType, proposal.targetPath);
  const current = await readTextIfExists(target.abs);
  if (hash(current) !== proposal.beforeHash) {
    throw new Error(`proposal ${id} 目标文件已变化，请重新生成 proposal`);
  }
  if (proposal.targetType === "workflow") await validateGovernedGraph(target.rel, proposal.afterContent);

  // memory 目标：确保目录存在（不再 init 嵌套仓，直接走主仓 git）。
  if (proposal.targetType === "memory") {
    try {
      await ensureMemoryRepo();
    } catch {
      /* git 不可用：忽略，apply 仍继续 */
    }
  }
  await fs.mkdir(path.dirname(target.abs), { recursive: true });
  await fs.writeFile(target.abs, proposal.afterContent, "utf8");
  proposal.status = "applied";
  proposal.appliedAt = new Date().toISOString();
  // 版本治理：落盘后【为这个文件本身】提交一版（message 带 proposal id/reason）。
  //
  // 以前这里被 `targetType === "memory"` 包着，于是 agent 目标【从不提交】——
  // 后果：新建的技能/改过的 SOUL.md 只进 proposals.json，git 里没有任何版本，
  // read_history 查它返回 0 条、面板也回滚不了，「留痕可复原」对 agents/ 只兑现了一半。
  // 现在 Memory / Agent / Skill / Workflow / MCP 目标一视同仁；只 add/commit 该文件。
  try {
    const sha = await commitGovernedFile(
      target.rel,
      `apply ${proposal.targetPath} — ${proposal.reason} [${proposal.id}]`
    );
    if (sha) proposal.commit = sha;
  } catch {
    /* git 不可用：apply 仍成功，只是没版本提交 */
  }
  await writeStore(proposals);
  await audit("apply", proposal);
  return proposal;
}

function resolveGovernedPath(type: ProposalTargetType, inputPath: string): { abs: string; rel: string } {
  const cleaned = inputPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\/+/, "");
  if (type === "memory") {
    const rel = cleaned.replace(/^assets\/Memory\/?/i, "");
    const abs = path.resolve(MEMORY_ROOT, rel);
    if (abs !== MEMORY_ROOT && !abs.startsWith(MEMORY_ROOT + path.sep)) {
      throw new Error(`governance: memory 路径越界: ${inputPath}`);
    }
    // 治理存档【不能由被治理流程自己改写】：proposals.json / audit.jsonl 就在
    // assets/Memory/.governance/ 下，属于合法的 memory 路径。若放行，任何能发 memory
    // 提案的路径都能篡改提案记录与审计日志本身——审计轨迹一旦可被被审计对象改写就失去意义。
    const normalizedAbs = path.normalize(abs).toLowerCase();
    const normalizedStore = path.normalize(STORE_DIR).toLowerCase();
    if (normalizedAbs === normalizedStore || normalizedAbs.startsWith(normalizedStore + path.sep.toLowerCase())) {
      throw new Error(`governance: 不允许通过提案改写治理存档本身: ${inputPath}`);
    }
    if (path.normalize(abs).toLowerCase() === path.normalize(MEMORY_ROOT_INDEX).toLowerCase()) {
      throw new Error(
        "governance: assets/Memory/index.md 是固定的全局分类入口，不接受 Memory proposal；请修改知识页，应用后由系统重建各子目录 index.md"
      );
    }
    if (path.normalize(abs).toLowerCase() === path.normalize(MEMORY_RETIRED_LOG).toLowerCase()) {
      throw new Error(
        "governance: assets/Memory/log.md 已退役；操作审计由 .governance/audit.jsonl、Proposal 与 Git 自动维护"
      );
    }
    return { abs, rel: path.join("assets", "Memory", path.relative(MEMORY_ROOT, abs)).replace(/\\/g, "/") };
  }

  if (type === "skill") {
    const rel = cleaned.replace(/^skills\/?/i, "");
    const parts = rel.split("/").filter(Boolean);
    if (parts.length < 2 || parts.some((p) => p === "." || p === ".." || p.startsWith("."))) {
      throw new Error(`governance: skill 路径必须形如 skills/<name>/<file>: ${inputPath}`);
    }
    const skillName = parts[0]!;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
      throw new Error(`governance: skill 名非法: ${skillName}`);
    }
    const abs = path.resolve(SKILLS_ROOT, rel);
    const skillRoot = path.resolve(SKILLS_ROOT, skillName);
    if (!abs.startsWith(skillRoot + path.sep)) {
      throw new Error(`governance: skill 路径越界: ${inputPath}`);
    }
    return { abs, rel: path.join("skills", rel).replace(/\\/g, "/") };
  }

  if (type === "workflow") {
    const rel = cleaned.replace(/^workflows\/?/i, "");
    const parts = rel.split("/").filter(Boolean);
    if (parts.length < 2 || parts.some((p) => p === "." || p === ".." || p.startsWith("."))) {
      throw new Error(`governance: workflow 路径必须形如 workflows/<name>/<file>: ${inputPath}`);
    }
    const workflowName = parts[0]!;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(workflowName)) {
      throw new Error(`governance: workflow 名非法: ${workflowName}`);
    }
    const abs = path.resolve(WORKFLOWS_ROOT, rel);
    const workflowRoot = path.resolve(WORKFLOWS_ROOT, workflowName);
    if (!abs.startsWith(workflowRoot + path.sep)) {
      throw new Error(`governance: workflow 路径越界: ${inputPath}`);
    }
    return { abs, rel: path.join("workflows", rel).replace(/\\/g, "/") };
  }

  if (type === "mcp") {
    const rel = cleaned.replace(/^mcp\/?/i, "");
    const parts = rel.split("/").filter(Boolean);
    if (parts.length < 2 || parts.some((p) => p === "." || p === ".." || p.startsWith("."))) {
      throw new Error(`governance: MCP 路径必须形如 mcp/<name>/<file>: ${inputPath}`);
    }
    const serverName = parts[0]!;
    if (!/^[a-zA-Z0-9_-]+$/.test(serverName)) {
      throw new Error(`governance: MCP 名非法: ${serverName}`);
    }
    const abs = path.resolve(MCP_ROOT, rel);
    const serverRoot = path.resolve(MCP_ROOT, serverName);
    if (!abs.startsWith(serverRoot + path.sep)) {
      throw new Error(`governance: MCP 路径越界: ${inputPath}`);
    }
    return { abs, rel: path.join("mcp", rel).replace(/\\/g, "/") };
  }

  const rel = cleaned.replace(/^agents\/?/i, "");
  const parts = rel.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`governance: agent 路径必须形如 agents/<name>/CLAUDE.md`);
  const agentName = parts[0]!;
  const inner = parts.slice(1).join("/");
  // 先挡 `..`：下面 isAllowedSkillFile 带通配，单靠正则不足以保证不越界。
  if (parts.some((p) => p === "." || p === "..")) {
    throw new Error(`governance: agent 路径含非法段: ${inputPath}`);
  }
  if (!AGENT_ALLOWED_FILES.has(inner) && !AGENT_ALLOWED_INDEXES.has(inner)) {
    throw new Error(`governance: 不允许修改 agent 文件: ${inner}`);
  }
  const abs = path.resolve(AGENTS_ROOT, agentName, inner);
  if (!abs.startsWith(AGENTS_ROOT + path.sep)) {
    throw new Error(`governance: agent 路径越界: ${inputPath}`);
  }
  return { abs, rel: path.join("agents", agentName, inner).replace(/\\/g, "/") };
}

async function updateProposal(
  id: string,
  mutate: (proposal: GovernanceProposal) => void,
  event: string
): Promise<GovernanceProposal> {
  const proposals = await readStore();
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal) throw new Error(`未知 proposal: ${id}`);
  mutate(proposal);
  await writeStore(proposals);
  await audit(event, proposal);
  return proposal;
}

async function readStore(): Promise<GovernanceProposal[]> {
  try {
    const raw = await fs.readFile(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw) as GovernanceProposal[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeStore(proposals: GovernanceProposal[]): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true });
  await fs.writeFile(STORE_FILE, JSON.stringify(proposals, null, 2), "utf8");
}

async function audit(event: string, proposal: GovernanceProposal): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true });
  const line = JSON.stringify({
    event,
    id: proposal.id,
    targetPath: proposal.targetPath,
    status: proposal.status,
    at: new Date().toISOString(),
  });
  await fs.appendFile(AUDIT_FILE, `${line}\n`, "utf8");
}

async function readTextIfExists(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
