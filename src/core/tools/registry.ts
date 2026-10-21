import type { ToolContext, ToolDef } from "../../types";
import { checkTool, PermissionError } from "../permissions";
import { executeCheckpointedTool } from "../checkpoint";
import { wrapCoworkTool } from "../cowork/toolRouting";
import { recordSuccessfulToolFileChanges } from "../fileChanges";
import { executeWithToolDeadline, resolveToolTimeoutMs } from "../toolTimeout";

/**
 * 工具注册表 + execute 分发。
 * agent 配置里只写工具名（字符串），运行时由这里按名解析成真正的 ToolDef。
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register(tool: ToolDef): void {
    this.tools.set(tool.name, wrapCoworkTool(tool));
  }

  registerAll(tools: ToolDef[]): void {
    for (const t of tools) this.register(t);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  /** 列出所有已注册工具（前端展示用）。 */
  list(): Array<{ name: string; description: string }> {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description }));
  }

  /** 把 agent 声明的工具名解析成 ToolDef[]；未知名打掉（不静默塞 undefined）。 */
  resolveTools(names: string[]): ToolDef[] {
    const out: ToolDef[] = [];
    for (const n of names) {
      const t = this.tools.get(n);
      if (t) out.push(t);
    }
    return out;
  }

  /** 真正执行一个工具调用。先过 sandbox 工具权限校验，越权抛 PermissionError。 */
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
    opts: { timeoutMs?: number } = {}
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`未知工具: ${name}`);
    // actor 是入口层可信身份。non-owner 的公开模式原则上根本看不到工具；这里再拦一次，
    // 防未来 backend/恢复/直调路径误把某个工具名送进来。
    if (ctx.source?.actor?.role === "other") {
      throw new PermissionError(`权限拒绝：外部用户会话不能调用 Harbour 工具「${name}」`);
    }
    checkTool(ctx.agent, name, tool.readOnly === true); // sandbox：工具白名单 + 只读模式（未标注默认拒绝）
    const execute = async () => {
      const timeoutMs = resolveToolTimeoutMs(tool, args, ctx, opts.timeoutMs);
      const result = await executeWithToolDeadline(ctx, timeoutMs,
        `工具 ${tool.name} 执行超过 ${timeoutMs}ms`, (callContext) => tool.execute(args, callContext));
      recordSuccessfulToolFileChanges(tool.name, args, result, ctx);
      return result;
    };
    return tool.checkpoint === false
      ? execute()
      : executeCheckpointedTool(tool, args, ctx, execute);
  }
}
