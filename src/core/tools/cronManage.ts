import type { ToolDef } from "../../types";
import type { CronController } from "../../scheduler/cron";
import { listCronDeliveryTargets, parseCronManagementInput, type CronManagementContext } from "../../scheduler/cronManagement";
import { isInteractiveOwner } from "../identity";

export interface CronManageOptions {
  controller: () => CronController | undefined;
  context: () => CronManagementContext;
}

/** Only an interactive owner may manage jobs or grant authority; automatic runs cannot self-authorize. */
export function createCronManageTool(options?: CronManageOptions): ToolDef {
  return {
    name: "cron_manage",
    description: "管理持久定时任务与 QQ/Discord 结果投递。新建默认暂停，明确启用用 update；不直接改 cron.json。主人委托需可信身份的自动任务时设置 executionIdentity=owner，授权绑定本机任务配置；省略默认 system，不从投递目标提权。deliverySessionId=current 绑定当前渠道，null 仅存 Harbour；其它目标先 targets。投递失败不重跑，run_once 仅用于明确要求的新执行。",
    readOnly: false,
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["list", "get", "targets", "create", "update", "delete", "run_once"] },
        id: { type: "string", description: "list/create 返回的作业 ID；get/update/delete/run_once 必填。" },
        job: {
          type: "object", additionalProperties: false,
          properties: {
            name: { type: "string" }, agent: { type: "string" }, input: { type: "string" },
            schedule: { type: "string", description: "Cron 表达式，例如 0 9 * * *。" },
            timeZone: { type: "string", description: "IANA 时区；省略使用 Harbour 当前时区。" },
            sessionMode: { type: "string", enum: ["fresh", "continue"] },
            executionIdentity: { type: "string", enum: ["system", "owner"], description: "owner=主人授权执行本任务（仍受 Agent/预算约束）；system=撤销授权。修改受托任务内容/Agent/排程/目标时需同时传 owner 重新确认；update 省略不新增授权。" },
            enabled: { type: "boolean", description: "仅 update；create 始终暂停。" },
            deliverySessionId: { type: ["string", "null"], description: "current 或 targets 返回的 sessionId；null 禁用投递；update 省略保留。" },
          },
        },
      }, required: ["action"],
    },
    async execute(args, ctx) {
      if (!isInteractiveOwner(ctx.source) || ctx.taskType === "heartbeat" || ctx.taskType === "cron") throw new Error("只有已验证的主人交互会话可以管理定时任务；自动任务不能自行创建或扩权。");
      const cron = options?.controller();
      if (!cron || !options) throw new Error("当前运行未连接定时调度器；请在 Harbour 服务中操作。");
      const action = args.action;
      if (!["list", "get", "targets", "create", "update", "delete", "run_once"].includes(String(action))) throw new Error("未知定时任务操作");
      if (ctx.permissionMode === "plan" && !["list", "get", "targets"].includes(String(action))) throw new Error("plan 模式不能修改或运行定时任务");
      if (Object.keys(args).some(key => !["action", "id", "job"].includes(key))) throw new Error("未知定时任务参数");
      if (action === "create" && args.id !== undefined) throw new Error("create 不接受已有作业 ID；修改已有作业请用 update");
      if (!["create", "update"].includes(String(action)) && args.job !== undefined) throw new Error("本操作不接受 job 参数");
      if (action === "targets") return { targets: listCronDeliveryTargets(options.context()) };
      if (action === "list") return { jobs: cron.list().map(({ input, lastResult, ...job }) => ({ ...job, inputPreview: input.slice(0, 180), hasResult: lastResult !== undefined })) };
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (action !== "create" && !id) throw new Error("缺少作业 ID，请先 list");
      if (action === "get") {
        const job = cron.list().find(job => job.id === id);
        if (!job) throw new Error("定时任务不存在");
        return { job };
      }
      if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error("操作已停止");
      if (action === "delete") { await cron.remove(id); return { removed: id }; }
      if (action === "run_once") return { queued: true, job: cron.runOnce(id) };
      if (!args.job || typeof args.job !== "object" || Array.isArray(args.job)) throw new Error("create/update 需要 job 对象");
      const body = { ...(args.job as Record<string, unknown>) };
      if (body.deliverySessionId === "current") {
        const context = options.context();
        const session = ctx.source?.sessionId ? context.sessions?.get(ctx.source.sessionId) : undefined;
        if (!session || session.key !== ctx.source?.key || session.channel !== ctx.source?.channel) {
          throw new Error("当前运行没有匹配的可信渠道会话，请先 targets 选择投递目标");
        }
        body.deliverySessionId = session.id;
      }
      const context = options.context();
      return { job: action === "create"
        ? await cron.add(parseCronManagementInput(body, context, true), ctx.source)
        : await cron.update(id, parseCronManagementInput(body, context, false), ctx.source) };
    },
  };
}
