import type { ToolDef } from "../../types";
import { memoryLog, memoryFileAt, GOVERNED_ROOTS } from "../../governance/gitStore";

/**
 * read_history —— 让 agent 自己查【受治理文件的版本历史】，并能读回任意旧版本。
 *
 * 【为什么需要】以前只有面板能看 assets/Memory 的 git 历史，agent 自己完全没有
 * 「这文件之前长什么样 / 是什么时候被谁改的」的视角——想复原只能靠人。
 * 有了它，她能自查「我的 SOUL.md 上周是什么样」「这条记忆是哪次改的」。
 *
 * 【只读】本工具【不做回滚】。回滚是不可逆的对外动作，仍然只走面板（人来点），
 * 与 SOUL 里「绝不替 用户 做不可逆动作而不先确认」一致。
 *
 * 【范围】仅 agents/、skills/ 与 assets/Memory/（GOVERNED_ROOTS），且路径经 relWithin 挡 `..`。
 * 版本管理直接用项目自己的 git 仓库，所以这里就是 git log / git show 的薄封装。
 */
export const readHistoryTool: ToolDef = {
  name: "read_history",
  description:
    "查看受治理文件的版本历史（git），可选地读回某个历史版本的全文。" +
    `范围：${GOVERNED_ROOTS.join(" / ")}。只读——回滚请让 用户 在面板上操作。`,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "仓库相对路径，如 agents/main-elaina/SOUL.md、skills/leader/SKILL.md 或 assets/Memory/concepts/index.md" +
          "（裸路径按 assets/Memory 解析）。",
      },
      commit: {
        type: "string",
        description: "可选：给了就返回该 commit 下这个文件的全文；不给只返回提交列表。",
      },
      limit: { type: "number", description: "返回多少条提交（默认 20）" },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const p = String(args.path ?? "").trim();
    if (!p) throw new Error("read_history: 缺少 path");
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);

    // relWithin 会在越界/含 `..` 时抛错，这里让它自然冒泡成工具错误。
    const commits = await memoryLog(p, limit);
    ctx.logger.info({ agent: ctx.agent?.name, path: p, commits: commits.length }, "read_history");

    const at = args.commit ? String(args.commit).trim() : "";
    if (!at) {
      return {
        path: p,
        commits,
        note: commits.length ? "要看某版全文，把该 hash 作为 commit 再调一次。" : "该路径没有 git 历史（可能从未提交过）。",
      };
    }
    const content = await memoryFileAt(p, at);
    return {
      path: p,
      commit: at,
      content,
      ...(content ? {} : { note: "该 commit 下没有这个文件（可能当时还不存在，或路径不同）。" }),
    };
  },
};
