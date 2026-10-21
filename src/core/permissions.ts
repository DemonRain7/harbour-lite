import path from "node:path";
import type { Agent, ToolContext } from "../types";

/**
 * Sandbox / 权限 —— 每个 agent 的 governance.permissions 执行点。
 *
 *   permissions:
 *     readPaths:  []   # 允许读的路径根（缺省=不限制；空数组=一律拒绝）
 *     writePaths: []   # 允许写的路径根
 *     tools:      []   # 允许调用的工具名（缺省/空=不额外限制）
 *     mcp:        []   # 允许使用的 MCP server 名
 *
 * 语义：**只有显式声明的那一类才会被限制**。未声明 readPaths → 读不受限；
 * 声明了 readPaths:[] → 任何读都被拒。路径全程 normalize+resolve，`../` 无法绕过。
 *
 * 越权一律抛 PermissionError；在 agentLoop 的容错执行里会被转成结构化错误回灌给
 * 模型并落进 session trace（不崩 loop）。
 */

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

const CWD = process.cwd();

/** 把允许列表里的每条规整成一个绝对「根目录」。返回 null = 未声明（不限制）。 */
function normalizeRoots(list: string[] | undefined): string[] | null {
  if (list === undefined) return null;
  return list.map((entry) =>
    path.resolve(
      CWD,
      String(entry)
        .replace(/\\/g, "/")
        .replace(/\/+\*+$/, "") // 去掉结尾的 /** 或 /*
        .replace(/\/+$/, "")
    )
  );
}

function withinAny(abs: string, roots: string[]): boolean {
  return roots.some((root) => abs === root || abs.startsWith(root + path.sep));
}

function rels(roots: string[]): string {
  return roots.map((r) => path.relative(CWD, r) || ".").join(", ") || "(空)";
}

/** 校验一次路径访问；放行返回规整后的绝对路径，越权抛 PermissionError。 */
export function checkPath(agent: Agent, kind: "read" | "write", p: string): string {
  const abs = path.resolve(CWD, String(p ?? ""));
  const perms = agent.governance?.permissions;
  const roots = normalizeRoots(kind === "read" ? perms?.readPaths : perms?.writePaths);
  if (roots === null) return abs; // 该类未声明限制 → 放行
  if (!withinAny(abs, roots)) {
    throw new PermissionError(
      `权限拒绝：agent「${agent.name}」无权${kind === "read" ? "读" : "写"}「${p}」（允许根：${rels(roots)}）`
    );
  }
  return abs;
}

/** 校验工具调用权限（permissions.tools / permissions.readOnly）。 */
export function checkTool(agent: Agent, toolName: string, toolReadOnly = false): void {
  const allow = agent.governance?.permissions?.tools;
  if (allow && allow.length > 0 && !allow.includes(toolName)) {
    throw new PermissionError(
      `权限拒绝：agent「${agent.name}」无权调用工具「${toolName}」（允许：${allow.join(", ")}）`
    );
  }
  if (agent.governance?.permissions?.readOnly === true && !toolReadOnly) {
    throw new PermissionError(`权限拒绝：agent「${agent.name}」处于只读模式，不能调用工具「${toolName}」`);
  }
}

/** 校验 MCP 使用权限（permissions.mcp 非空时生效）。 */
export function checkMcp(agent: Agent, mcpName: string): void {
  const allow = agent.governance?.permissions?.mcp;
  if (allow && allow.length > 0 && !allow.includes(mcpName)) {
    throw new PermissionError(
      `权限拒绝：agent「${agent.name}」无权使用 MCP「${mcpName}」（允许：${allow.join(", ")}）`
    );
  }
}

/* ── 给文件类工具用的便捷校验器（直接传 ToolContext）──────────────── */
export function resolveRead(ctx: ToolContext, p: string): string {
  return checkPath(ctx.agent, "read", p);
}
export function resolveWrite(ctx: ToolContext, p: string): string {
  return checkPath(ctx.agent, "write", p);
}

/** 暴露给模型前先按 permissions.tools 收窄工具清单（两条后端路径都生效）。 */
export function filterAllowedTools<T extends { name: string; readOnly?: boolean }>(agent: Agent, tools: T[]): T[] {
  const allow = agent.governance?.permissions?.tools;
  const readOnly = agent.governance?.permissions?.readOnly === true;
  return tools.filter((t) => {
    if (allow && allow.length > 0 && !allow.includes(t.name)) return false;
    // 只读 agent 采取 fail-closed：新工具若忘记显式标注 readOnly，默认不发放。
    if (readOnly && t.readOnly !== true) return false;
    return true;
  });
}
