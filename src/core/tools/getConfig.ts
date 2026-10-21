import type { ToolDef } from "../../types";
import type { ConfigStore } from "../configStore";

/**
 * get_config(key) —— 按需读一个用户预存的配置字段（如 SSH 主机 / 部署路径等备忘值）。
 *
 * 值只在【被调用时】返回，不预载进 system prompt——避免把可能敏感的字段常驻上下文。
 * 受 agent.tools 白名单约束：要用得先在对应 agent 的 tools 里声明 get_config。
 *
 * 工厂函数：闭包捕获 configStore（热生效——Settings 里改了值，下次调用即读到新值）。
 */
export function createGetConfigTool(store: ConfigStore): ToolDef {
  return {
    name: "get_config",
    description:
      "按 key 读取一个用户在 Settings 里预存的配置字段（如 ssh_host、deploy_path 等备忘值）。值按需返回、不常驻上下文。参数：key（字段名）。",
    parameters: {
      type: "object",
      properties: { key: { type: "string", description: "配置字段名，如 ssh_host" } },
      required: ["key"],
    },
    async execute(args, ctx) {
      const key = String(args.key ?? "").trim();
      if (!key) throw new Error("get_config 需要 key 参数");
      const value = store.get(key);
      ctx.logger.info({ key, found: value !== undefined, by: ctx.agent.name }, "get_config");
      return value === undefined ? { key, found: false } : { key, found: true, value };
    },
  };
}
