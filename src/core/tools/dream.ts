import type { ToolDef } from "../../types";
import { listSessions, readSession } from "../trace";
import { createProposal } from "../../governance/proposalStore";
import { formatZonedIso } from "../timeZone";

/**
 * dream / 自进化 —— 读 assets/sessions 近期 trace，汇总错误/纠正/工具使用，
 * 产出一份「dream 日记」草稿，并以 **governance proposal** 的形式提交到
 * assets/Memory/journals/dream-YYYY-MM-DD.md（不直接落盘改核心记忆，等 用户 审批）。
 *
 * 高价值学习应进一步拆成 concepts/entities 的独立 proposal——这里先沉淀日记，
 * 把「该不该写进记忆」的判断权留给审批。
 */

interface DreamStats {
  sessions: number;
  runs: number;
  toolCalls: number;
  toolErrors: number;
  permissionDenials: number;
  budgetStops: number;
  maxSteps: number;
  agents: Record<string, number>;
  notableErrors: string[];
}

function today(): string {
  return formatZonedIso(Date.now()).slice(0, 10);
}

async function gather(limit: number): Promise<DreamStats> {
  const ids = await listSessions(limit);
  const s: DreamStats = {
    sessions: ids.length,
    runs: 0,
    toolCalls: 0,
    toolErrors: 0,
    permissionDenials: 0,
    budgetStops: 0,
    maxSteps: 0,
    agents: {},
    notableErrors: [],
  };
  for (const id of ids) {
    const events = await readSession(id);
    for (const ev of events) {
      const type = String(ev.type ?? "");
      if (type === "start") {
        s.runs += 1;
        const a = String(ev.agent ?? "?");
        s.agents[a] = (s.agents[a] ?? 0) + 1;
      } else if (type === "tool-calls") {
        s.toolCalls += Array.isArray(ev.calls) ? ev.calls.length : 0;
      } else if (type === "tool-result") {
        const preview = String(ev.resultPreview ?? "");
        if (/error|拒绝|失败/i.test(preview)) {
          s.toolErrors += 1;
          if (/权限拒绝/.test(preview)) s.permissionDenials += 1;
          if (s.notableErrors.length < 12) s.notableErrors.push(`${ev.tool ?? "tool"}: ${preview.slice(0, 120)}`);
        }
      } else if (type === "budget-stop") {
        s.budgetStops += 1;
      } else if (type === "max-steps") {
        s.maxSteps += 1;
      }
    }
  }
  return s;
}

function journal(s: DreamStats): string {
  const d = today();
  const agentLines = Object.entries(s.agents)
    .sort((a, b) => b[1] - a[1])
    .map(([a, n]) => `- ${a}: ${n} 次`)
    .join("\n") || "- （无）";
  const errLines = s.notableErrors.length ? s.notableErrors.map((e) => `- ${e}`).join("\n") : "- （近期无明显错误）";
  const suggestions: string[] = [];
  if (s.permissionDenials > 0) suggestions.push(`出现 ${s.permissionDenials} 次权限拒绝：确认相关 agent 的 governance.permissions 是否需要放宽，或调整其行为别去碰越权路径。`);
  if (s.budgetStops > 0) suggestions.push(`有 ${s.budgetStops} 次因 token 预算提前收尾：考虑拆小任务或提高对应 agent 的 maxTokensPerRun。`);
  if (s.maxSteps > 0) suggestions.push(`有 ${s.maxSteps} 次触发 maxSteps 保险丝：可能 loop 卡住，检查工具是否返回了可推进的结果。`);
  if (s.toolErrors > s.toolCalls / 3 && s.toolCalls > 0) suggestions.push("工具错误率偏高：核对工具入参约定与 agent 的使用说明。");
  if (!suggestions.length) suggestions.push("近期运行平稳，无突出改进项；继续观察。");

  return `---
type: journal
title: Dream Journal ${d}
description: 自进化日记——${s.sessions} 个近期会话的反思汇总
date: ${d}
updated: ${d}
status: draft
tags: ["dream", "self-evolution"]
---

# Dream Journal · ${d}

> 由 dream 工具读取 \`assets/sessions/\` 近期 trace 自动汇总；本页以 governance proposal 形式提交，等待审批后才入库。

## 概览
- 分析会话数：**${s.sessions}**
- run 次数：${s.runs}
- 工具调用：${s.toolCalls} 次，其中报错 ${s.toolErrors} 次（权限拒绝 ${s.permissionDenials} 次）
- 预算提前收尾：${s.budgetStops} 次 · maxSteps 触发：${s.maxSteps} 次

## 各 agent 活跃度
${agentLines}

## 值得注意的错误 / 纠正
${errLines}

## 改进建议（高价值学习 → 建议拆成 concepts/entities 的独立 proposal）
${suggestions.map((x) => `- ${x}`).join("\n")}
`;
}

export const dreamTool: ToolDef = {
  name: "dream",
  description:
    "读取 assets/sessions 近期会话 trace，汇总错误/纠正/工具使用，产出一份 dream 日记，并以 governance proposal 形式提交到 assets/Memory/journals/dream-YYYY-MM-DD.md（不直接落盘，等审批）。",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "分析最近多少个会话（默认 20）" },
    },
    required: [],
  },
  async execute(args, ctx) {
    const limit = Number(args.limit ?? 20);
    const stats = await gather(Number.isFinite(limit) && limit > 0 ? limit : 20);
    const content = journal(stats);
    const targetPath = `journals/dream-${today()}.md`;
    const proposal = await createProposal({
      targetType: "memory",
      targetPath,
      operation: "write",
      content,
      reason: `dream 自进化日记（分析 ${stats.sessions} 个会话）`,
      sourceAgent: ctx.agent.name,
    });
    ctx.logger.info({ proposal: proposal.id, sessions: stats.sessions }, "dream:proposed");
    return {
      proposed: proposal.id,
      target: proposal.targetPath,
      status: proposal.status,
      analyzed: stats.sessions,
      note: "日记已作为 governance proposal 提交，去 Governance 面板审批后才会写入 Memory。",
    };
  },
};
