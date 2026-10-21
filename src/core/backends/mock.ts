import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Backend, CompletionRequest, CompletionResult, Message, ToolCall } from "../../types";
import type { Logger } from "pino";

/**
 * Mock 后端 —— 一个「剧本化」的假 LLM，只为离线 demo 服务（无需任何 key）。
 *
 * 它不是真模型，而是一段脚本：通过观察对话里已有的 tool 结果，决定下一步
 * 该调哪个工具、还是该收尾。这样不接真模型也能逐轮看懂 agentLoop。
 *
 * 两条剧本（按 agent 拿到的工具集自动区分）：
 *  - 带 list_files/read_file 的 agent（如 trajectory-checker）：
 *      list_files → 逐个 read_file → 统计缺字段的记录数并收尾。
 *  - 不带工具的 agent：直接一句话收尾。
 *
 * MOCK_LLM=true 或 demo 入口会让 router 把所有补全都转到这里。
 */
export class MockBackend implements Backend {
  readonly name = "mock";
  constructor(private logger: Logger) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const toolNames = (req.tools ?? []).map((t) => t.name);
    const canListFiles = toolNames.includes("list_files");
    this.logger.debug({ model: req.model, tools: toolNames }, "mock:complete");

    // —— 剧本 A：无工具的纯推理/总结 agent —— 一进一出。
    if (!canListFiles) {
      const lastUser = lastUserText(req.messages);
      return final(
        `[mock:${req.model}] 收到任务「${truncate(lastUser, 60)}」。这是 mock 返回的占位答案——接上真模型后这里会是真实输出。`
      );
    }

    // —— 剧本 B：trajectory-checker 统计缺字段的记录数 ——
    const toolMsgs = req.messages.filter((m) => m.role === "tool");
    const listMsg = toolMsgs.find((m) => m.name === "list_files");

    // step 1：还没列目录 → 先 list_files。
    if (!listMsg) {
      const dir = extractDir(lastUserText(req.messages));
      return toolCall("list_files", { dir });
    }

    const listed = parseJson<{ dir: string; files: string[] }>(listMsg.content);
    const dir = listed?.dir ?? "mockdata/trajectories";
    const files = listed?.files ?? [];

    // step 2：逐个 read_file（每轮读一个，方便看清 loop 一轮一轮跑）。
    const readMsgs = toolMsgs.filter((m) => m.name === "read_file");
    const readBasenames = new Set(
      readMsgs
        .map((m) => parseJson<{ path: string }>(m.content)?.path)
        .filter((p): p is string => !!p)
        .map((p) => path.basename(p))
    );
    const nextFile = files.find((f) => !readBasenames.has(path.basename(f)));
    if (nextFile) {
      return toolCall("read_file", { path: joinPosix(dir, nextFile) });
    }

    // step 3：都读完了 → 统计缺 "reward" 字段的记录数并收尾。
    const field = "reward";
    let total = 0;
    let missing = 0;
    for (const m of readMsgs) {
      const file = parseJson<{ path: string; content: string }>(m.content);
      const records = parseJson<Array<Record<string, unknown>>>(file?.content ?? "");
      if (!Array.isArray(records)) continue;
      for (const r of records) {
        total += 1;
        if (r[field] === undefined) missing += 1;
      }
    }
    return final(`统计完成：目录 ${dir} 下共 ${total} 条记录，其中 ${missing} 条缺少 "${field}" 字段。`);
  }
}

/* ── 辅助 ───────────────────────────────────────────────────────── */

function final(content: string): CompletionResult {
  return { message: { role: "assistant", content } };
}

function toolCall(name: string, args: Record<string, unknown>): CompletionResult {
  const call: ToolCall = { id: `call_${randomUUID().slice(0, 8)}`, name, arguments: args };
  return { message: { role: "assistant", content: "", toolCalls: [call] } };
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") return m.content;
  }
  return "";
}

function extractDir(userText: string): string {
  // 从用户输入里抓一个看起来像路径的 token（含 mockdata 优先），否则用默认。
  const m = userText.match(/([A-Za-z0-9_.\-/\\]*mockdata[A-Za-z0-9_.\-/\\]*)/);
  return m?.[1] ?? "mockdata/trajectories";
}

function joinPosix(dir: string, file: string): string {
  return `${dir.replace(/\/+$/, "")}/${file}`;
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
