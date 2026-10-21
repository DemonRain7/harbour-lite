import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolDef } from "../../types";
import { delegationPaused } from "../agentDelegationStore";

/**
 * message_agent(to, content) —— agent 间【异步】消息投递。
 *
 * 区别于 spawn_subagent（同步父子：阻塞等子 agent 返回）：message_agent 把消息
 * 投进目标 agent 的 inbox（agents/<to>/inbox/<id>.json，含 from/to/content/
 * createdAt/status），**立即返回不阻塞**；若注入了 runAgent，则在后台跑目标 agent
 * 处理这条消息、把结果回写 inbox（status: unread → processing → done/error）。
 *
 * 典型场景：main 把巡检结果异步丢给 memory-keeper 归档，自己继续干别的、不等它。
 * inbox 文件是运行时状态（已 gitignore），可经 /api/inbox 查看。
 */

const AGENTS_ROOT = path.resolve(process.cwd(), "agents");

export type InboxStatus = "unread" | "processing" | "done" | "error";

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  createdAt: string;
  status: InboxStatus;
  processedAt?: string;
  reply?: string;
  error?: string;
}

function inboxDir(agent: string, agentsRoot = AGENTS_ROOT): string {
  const safe = String(agent).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error("message_agent: 非法目标 agent 名");
  const root = path.resolve(agentsRoot);
  const dir = path.resolve(root, safe, "inbox");
  if (!dir.startsWith(root + path.sep)) throw new Error("message_agent: 目标路径越界");
  return dir;
}

async function updateStatus(file: string, status: InboxStatus, extra?: Partial<InboxMessage>): Promise<void> {
  try {
    const cur = JSON.parse(await fs.readFile(file, "utf8")) as InboxMessage;
    Object.assign(cur, { status, processedAt: new Date().toISOString() }, extra ?? {});
    await fs.writeFile(file, JSON.stringify(cur, null, 2), "utf8");
  } catch {
    /* inbox 文件被删/损坏：忽略，不拖垮后台处理 */
  }
}

/** 列出某 agent 的 inbox（按 createdAt 倒序）。 */
export async function listInbox(agent: string): Promise<InboxMessage[]> {
  const dir = inboxDir(agent);
  try {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    const out: InboxMessage[] = [];
    for (const f of files) {
      try {
        out.push(JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as InboxMessage);
      } catch {
        /* skip broken */
      }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  } catch {
    return [];
  }
}

export function createMessageAgentTool(isDelegationEnabled: (name: string) => boolean = () => true, agentsRoot = AGENTS_ROOT): ToolDef {
return {
  name: "message_agent",
  description:
    "给另一个 agent 异步投递一条消息（写入其 inbox 并立即返回，不阻塞）。区别于 spawn_subagent 的同步等待——适合「把结果丢给某 agent 归档/跟进，自己继续干」。",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "目标 agent 名（agents/ 下的某个）" },
      content: { type: "string", description: "投递给目标 agent 的消息内容" },
    },
    required: ["to", "content"],
  },
  async execute(args, ctx) {
    const to = String(args.to ?? "").trim();
    const content = String(args.content ?? "");
    if (!to || !content) throw new Error("message_agent: to/content 必填");
    if (to === ctx.agent.name) throw new Error("message_agent: 不能给自己发消息");
    if (!isDelegationEnabled(to)) return { ...delegationPaused(to), to, delivered: false };

    const msg: InboxMessage = {
      id: `msg-${randomUUID().slice(0, 8)}`,
      from: ctx.agent.name,
      to,
      content,
      createdAt: new Date().toISOString(),
      status: "unread",
    };
    const dir = inboxDir(to, agentsRoot);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${msg.id}.json`);
    await fs.writeFile(file, JSON.stringify(msg, null, 2), "utf8");
    ctx.logger.info({ from: msg.from, to, id: msg.id }, "message_agent:deliver");

    // 异步处理（不 await）：后台跑目标 agent，结果回写 inbox。发起方立即拿到回执继续。
    const runAgent = ctx.runAgent;
    if (runAgent) {
      void (async () => {
        await updateStatus(file, "processing");
        try {
          const reply = await runAgent(to, `[inbox · 来自 ${msg.from}]\n${content}`);
          await updateStatus(file, "done", { reply });
          ctx.logger.info({ to, id: msg.id }, "message_agent:processed");
        } catch (e) {
          await updateStatus(file, "error", { error: (e as Error).message });
          ctx.logger.warn({ to, id: msg.id, err: (e as Error).message }, "message_agent:process-error");
        }
      })();
    }

    return {
      delivered: msg.id,
      to,
      status: "unread",
      async: !!runAgent,
      inbox: path.relative(process.cwd(), file).replace(/\\/g, "/"),
      note: runAgent ? "目标 agent 已在后台异步处理，结果将回写 inbox" : "已投递到 inbox（无 runAgent，等目标 agent 自行处理）",
    };
  },
};
}

export const messageAgentTool = createMessageAgentTool();
