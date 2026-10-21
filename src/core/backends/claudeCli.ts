import { execFile } from "node:child_process";
import type { Backend, CompletionRequest, CompletionResult, Message } from "../../types";
import type { Logger } from "pino";

/**
 * claude-cli 订阅后端 —— subprocess 调用本机已登录的 `claude` CLI。
 * 默认关闭（ENABLE_CLAUDE_CLI=false）。关闭时直接抛清晰错误，绝不静默回退。
 *
 * ⚠️ 留给未来的 用户，两个必须知道的限制：
 *
 *  1) 合规风险：用 Pro/Max 订阅的 OAuth 去驱动第三方/自建工具，目前 Anthropic
 *     官方文档明确列为「违反消费者 ToS」，有过实际封禁/失效先例。本后端不碰
 *     任何 API key，认证完全依赖本机 `claude` CLI 已登录的订阅 OAuth。
 *     开启 ENABLE_CLAUDE_CLI 即自负风险。
 *
 *  2) 能力限制：CLI 的 `-p --output-format json` 只给「一进一出」的 result 文本，
 *     拿不到干净的结构化 tool_calls。因此它无法被本系统编排工具——只适合纯
 *     推理/总结型 agent（一句话进、一段话出）。若给一个声明了 tools 的 agent
 *     路由到 claude-cli/*，router 会打警告（见 router.ts 的保护逻辑）。
 *
 * 实现：`claude -p "<prompt>" --output-format json --model <model>`，解析 stdout
 * JSON 拿 `result` 字段作为最终答案。
 */
export class ClaudeCliBackend implements Backend {
  readonly name = "claude-cli";

  constructor(
    private opts: { enabled: boolean; bin: string; logger: Logger }
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!this.opts.enabled) {
      throw new Error(
        "claude-cli 后端已禁用（ENABLE_CLAUDE_CLI=false）。如需启用请阅读 claudeCli.ts 顶部的合规与能力风险后再开启，绝不静默回退到其它后端。"
      );
    }

    // CLI 是一进一出，把 system + 历史压平成单个 prompt。tools 一律忽略。
    const prompt = flattenToPrompt(req.messages);
    const args = ["-p", prompt, "--output-format", "json", "--model", req.model];

    // 与 claudeAgentSdk.buildEnv() 同款隔离：剔除继承来的 anthropic 认证变量。
    // 本机可能在系统级设了别的网关（公司网关）的 ANTHROPIC_BASE_URL/API_KEY——不剔的话，
    // 一旦项目 .env 少写一行空值，这里就会拿【别处的 key】去打【我们的 endpoint】。
    const childEnv: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "ANTHROPIC_API_KEY" || k === "ANTHROPIC_AUTH_TOKEN" || k === "ANTHROPIC_BASE_URL") continue;
      if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE") || k.startsWith("CLAUDE_AGENT_SDK")) continue;
      childEnv[k] = v;
    }

    if (req.signal?.aborted) throw new Error("run aborted");
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        this.opts.bin,
        args,
        // 透传 signal：点「停止」→ Node 用 SIGTERM 杀掉 claude 子进程。CLI 是一进一出、
        // agentLoop 的每步守卫够不着，不传 signal 就会留一个跑到底的孤儿子进程（踩红线）。
        { maxBuffer: 1024 * 1024 * 16, env: childEnv, ...(req.signal ? { signal: req.signal } : {}) },
        (err, out, errOut) => {
          if (err) {
            reject(new Error(`claude CLI 调用失败: ${err.message}${errOut ? `\n${errOut}` : ""}`));
            return;
          }
          resolve(out);
        }
      );
    });

    let result: string;
    try {
      const parsed = JSON.parse(stdout) as { result?: string };
      result = parsed.result ?? "";
    } catch {
      // 万一不是 JSON（CLI 版本差异），退而把整段 stdout 当结果。
      result = stdout.trim();
    }

    const message: Message = { role: "assistant", content: result };
    return { message };
  }
}

function flattenToPrompt(messages: Message[]): string {
  return messages
    .map((m) => {
      switch (m.role) {
        case "system":
          return `[系统]\n${m.content}`;
        case "user":
          return `[用户]\n${m.content}`;
        case "assistant":
          return `[助手]\n${m.content}`;
        case "tool":
          return `[工具结果:${m.name ?? ""}]\n${m.content}`;
      }
    })
    .join("\n\n");
}
