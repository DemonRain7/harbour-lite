import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolContext } from "../../types";
import {
  createProposal,
  listProposals,
  type CreateProposalInput,
  type GovernanceProposal,
} from "../../governance/proposalStore";
import { resolveWrite } from "../permissions";
import { MEMORY_ROOT, memoryRelativeName, resolveInMemory } from "../memoryPaths";
import type { WorkflowExecutor, WorkflowInvocation } from "./registry";

interface MemoryCandidate {
  path: string;
  operation: "write" | "append";
  content: string;
  reason: string;
}

export interface MemoryIngestionWorkflowConfig {
  memoryRoot?: string;
  readFile?: (file: string) => Promise<string>;
  listProposals?: () => Promise<GovernanceProposal[]>;
  createProposal?: (input: CreateProposalInput) => Promise<GovernanceProposal>;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readIfExists(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function normalizedStoredPath(relative: string): string {
  return path.posix.join("assets", "Memory", relative.replace(/\\/g, "/"));
}

function parseCandidates(input: Record<string, unknown>): MemoryCandidate[] {
  if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
    throw new Error("memory-ingestion: input.candidates 必须是非空数组");
  }
  if (input.candidates.length > 32) throw new Error("memory-ingestion: 单批最多 32 个页面候选");
  let totalBytes = 0;
  return input.candidates.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`memory-ingestion: candidates[${index}] 必须是对象`);
    }
    const value = raw as Record<string, unknown>;
    const candidatePath = String(value.path ?? "").trim();
    const operation = String(value.operation ?? "write") as MemoryCandidate["operation"];
    const content = String(value.content ?? "");
    const reason = String(value.reason ?? `记忆摄入候选 ${candidatePath}`).trim();
    if (!candidatePath || !candidatePath.toLowerCase().endsWith(".md")) {
      throw new Error(`memory-ingestion: candidates[${index}].path 必须是 Memory 内的 .md 页面`);
    }
    if (operation !== "write" && operation !== "append") {
      throw new Error(`memory-ingestion: candidates[${index}].operation 仅支持 write/append`);
    }
    if (!content.trim()) throw new Error(`memory-ingestion: candidates[${index}].content 不能为空`);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > 512 * 1024) throw new Error(`memory-ingestion: candidates[${index}] 超过 512KB`);
    totalBytes += bytes;
    if (totalBytes > 2 * 1024 * 1024) throw new Error("memory-ingestion: 单批内容总量超过 2MB");
    return { path: candidatePath, operation, content, reason };
  });
}

/**
 * 固化 Memory 摄入的机械部分：校验路径 → 精确去重 → 幂等建 Proposal → 等人工审批。
 * “是否值得长期记住、属于 Entity/Concept/Journal、语义是否冲突”仍由 memory-keeper
 * 阅读薄索引与相关页面后判断，Workflow 不用字符串规则冒充语义判断。
 */
export function createMemoryIngestionWorkflowExecutor(
  config: MemoryIngestionWorkflowConfig = {},
): WorkflowExecutor {
  const memoryRoot = path.resolve(config.memoryRoot ?? MEMORY_ROOT);
  const readFile = config.readFile ?? readIfExists;
  const getProposals = config.listProposals ?? listProposals;
  const addProposal = config.createProposal ?? createProposal;
  let tail: Promise<unknown> = Promise.resolve();

  const submit = async (input: Record<string, unknown>, ctx: ToolContext) => {
    const candidates = parseCandidates(input);
    const seen = new Set<string>();
    const prepared = [] as Array<{
      candidate: MemoryCandidate;
      target: string;
      relative: string;
      storedPath: string;
      beforeContent: string;
      afterContent: string;
      beforeHash: string;
    }>;

    // 先完整预检，再创建任何 Proposal；参数错误不会留下半批数据。
    for (const candidate of candidates) {
      const target = resolveInMemory(candidate.path, memoryRoot);
      resolveWrite(ctx, target);
      const relative = memoryRelativeName(target, memoryRoot);
      const key = relative.toLocaleLowerCase("en-US");
      if (seen.has(key)) throw new Error(`memory-ingestion: 同一批不能重复修改 ${relative}`);
      seen.add(key);
      const beforeContent = await readFile(target);
      const afterContent = candidate.operation === "append"
        ? `${beforeContent}${candidate.content}`
        : candidate.content;
      prepared.push({
        candidate,
        target,
        relative,
        storedPath: normalizedStoredPath(relative),
        beforeContent,
        afterContent,
        beforeHash: hash(beforeContent),
      });
    }

    const existing = await getProposals();
    const proposed: Array<{ id: string; target: string; status: GovernanceProposal["status"]; reused: boolean }> = [];
    const skipped: Array<{ target: string; reason: string }> = [];
    const conflicts: Array<{ target: string; proposalId: string; status: GovernanceProposal["status"] }> = [];

    for (const item of prepared) {
      if (item.afterContent === item.beforeContent ||
          (item.candidate.operation === "append" && item.beforeContent.endsWith(item.candidate.content))) {
        skipped.push({ target: item.storedPath, reason: "目标已包含完全相同内容" });
        continue;
      }
      const active = existing.filter((proposal) =>
        proposal.targetType === "memory" &&
        proposal.targetPath.replace(/\\/g, "/").toLocaleLowerCase("en-US") === item.storedPath.toLocaleLowerCase("en-US") &&
        (proposal.status === "pending" || proposal.status === "approved"));
      const equivalent = active.find((proposal) =>
        proposal.beforeHash === item.beforeHash && proposal.afterContent === item.afterContent);
      if (equivalent) {
        proposed.push({ id: equivalent.id, target: equivalent.targetPath, status: equivalent.status, reused: true });
        continue;
      }
      if (active.length) {
        conflicts.push({ target: item.storedPath, proposalId: active[0]!.id, status: active[0]!.status });
        continue;
      }
      const proposal = await addProposal({
        targetType: "memory",
        targetPath: item.relative,
        operation: item.candidate.operation,
        content: item.candidate.content,
        reason: item.candidate.reason,
        sourceAgent: ctx.agent.name,
      });
      existing.unshift(proposal);
      proposed.push({ id: proposal.id, target: proposal.targetPath, status: proposal.status, reused: false });
    }

    const status = proposed.length
      ? "awaiting_approval"
      : conflicts.length
        ? "needs_input"
        : "no_changes";
    return {
      status,
      terminal: true,
      ingestionId: `mi-${hash(JSON.stringify(prepared.map((item) => [item.relative, item.afterContent]))).slice(0, 12)}`,
      proposed,
      skipped,
      conflicts,
      nextAction: proposed.length ? "review_governance" : conflicts.length ? "resolve_existing_proposal" : "none",
      note: "Workflow 不会自动 approve/apply；最终审批仍只由 用户 在 Governance 执行。",
    };
  };

  const status = async (input: Record<string, unknown>) => {
    const ids = Array.isArray(input.proposalIds)
      ? [...new Set(input.proposalIds.map(String).map((id) => id.trim()).filter(Boolean))]
      : [];
    if (!ids.length) throw new Error("memory-ingestion: status 需要 input.proposalIds");
    const proposals = await getProposals();
    const found = proposals.filter((proposal) => ids.includes(proposal.id));
    const byId = new Map(found.map((proposal) => [proposal.id, proposal]));
    return {
      status: ids.every((id) => byId.get(id)?.status === "applied") && byId.size === ids.length
        ? "completed"
        : found.some((proposal) => proposal.status === "rejected")
          ? "rejected"
          : "awaiting_approval",
      terminal: true,
      proposals: ids.map((id) => byId.has(id)
        ? { id, status: byId.get(id)!.status, target: byId.get(id)!.targetPath }
        : { id, status: "missing" }),
    };
  };

  const execute = (invocation: WorkflowInvocation, ctx: ToolContext): Promise<unknown> => {
    if (invocation.action === "status") return status(invocation.input);
    if (invocation.action !== "submit") {
      return Promise.reject(new Error(`memory-ingestion: 不支持 action=${invocation.action}（仅 submit/status）`));
    }
    // 序列化 Proposal 批次，防并发摄入在读同一 beforeHash 后制造重复提案。
    const current = tail.then(() => submit(invocation.input, ctx), () => submit(invocation.input, ctx));
    tail = current.then(() => undefined, () => undefined);
    return current;
  };

  return { id: "memory-ingestion", execute };
}
