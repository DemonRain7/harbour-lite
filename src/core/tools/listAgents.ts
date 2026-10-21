import type { Agent, ToolDef } from "../../types";

/**
 * list_agents —— 列出当前已装载的所有 agent（职责 + Tool/Skill/Workflow/MCP 能力摘要）。
 *
 * 主要给 orchestrator 用：它要根据用户意图编排 workflow，就得先知道「有哪些 agent 可派」。
 * 用工具动态发现，而不是把花名册写死进 prompt——这样「加 agent = 丢一个文件夹」时，
 * orchestrator 无需改任何提示词就能看到新成员（保持核心零改动的设计哲学）。
 *
 * 工厂函数：闭包捕获 runtime 的 agentMap 取数器（reload 后自动跟新，因为闭包引用的是
 * 外层 let 绑定而非快照）。
 */
export function createListAgentsTool(getAgents: () => Agent[]): ToolDef {
  return {
    name: "list_agents",
    description:
      "列出当前中台可派遣的专精 agent，以及各自已挂载的 Tool、Skill、Workflow、MCP 能力目录。能力同时返回薄描述，供 orchestrator 选人；MCP 另返回允许工具名。无参数。",
    readOnly: true,
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      // 【只列可派的】过滤掉入口 persona（main-*）与调用者自己。
      // 不过滤会出事：orchestrator 看到 main-elaina 在花名册里，就把它写进 plan 的「派谁」
      // （实测 plan 第 1 步真的是 main-elaina），主 agent 照 plan 执行 = 自己派自己，
      // 无限递归。旧的 30s 保险丝还能很快掐掉，改成 10 分钟后每层都能跑满，代价极大。
      const all = getAgents();
      const agents = all
        .filter((a) => !/^main-/.test(a.name) && a.name !== ctx.agent.name)
        .map((a) => ({
          name: a.name,
          description: a.description ?? "",
          taskType: a.taskType,
          tools: a.tools ?? [],
          skills: (a.skills ?? []).map((s) => ({ name: s.name, description: s.description })),
          workflows: (a.workflows ?? []).map((workflow) => ({
            name: workflow.name,
            description: workflow.description,
            version: workflow.version,
          })),
          mcp: (a.mcpServers ?? []).map((s) => ({
            name: s.name,
            description: s.description ?? "",
            tools: s.allow ?? [],
          })),
        }));
      ctx.logger.info({ count: agents.length, hidden: all.length - agents.length, by: ctx.agent.name }, "list_agents");
      return {
        agents,
        note: "只列出可被派遣的专精 agent。入口 persona（main-*）与你自己不在其中；需要 Main 亲自执行的步骤写 self。能力目录用于规划，最终调用仍由 Main 或执行 agent 完成。",
      };
    },
  };
}
