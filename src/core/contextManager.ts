import type { Agent, Message } from "../types";
import type { Logger } from "pino";
import { estimateMessageTokens, estimateMessagesTokens } from "./tokenEstimate";
import { ContextWindowExceededError } from "./contextOverflow";

/**
 * Context Manager —— 这是自建中台最大的理由：严控喂给模型的 context。
 *
 * 默认绝不把全量历史灌给模型。build() 在每一轮补全前，按以下规则裁出实际
 * 要发的 messages：
 *
 *  1) Token 预算：每个 agent 有 contextBudget（硬上限）。用跨模型的中英混合启发式估算，
 *     不绑定某个供应商 tokenizer（同一 session 可以切模型）。
 *  2) 永远保留：system + 「当前任务锚点」= 最后一条 user 消息及其之后的所有
 *     assistant/tool（即本轮正在处理的工具调用与结果）。这部分不裁。
 *  3) 连续时间序尾窗：预算还有余量时，从最近往前收更早的历史，保持原顺序、绝不
 *     重排——稳定前缀才能命中 prompt cache（重排会让前缀每轮变、必 miss）。超预算
 *     就丢更早的、保留连续近端窗口。正常靠压缩（阈值 < 预算）先重置，这里几乎不裁。
 *  4) retrieve()：留好按需检索（向量/wiki）的扩展点——以后把外部知识注入
 *     这里。现在只是占位，返回空。
 *
 * 每轮在日志里打印「注入了多少 token / 裁掉了多少」，方便调。
 */

export interface BuildStats {
  injectedTokens: number;
  trimmedTokens: number;
  keptMessages: number;
  droppedMessages: number;
}

export interface BuildResult {
  messages: Message[];
  stats: BuildStats;
}

export interface RetrievedDoc {
  text: string;
  score: number;
  source?: string;
}

export class ContextManager {
  constructor(private logger: Logger) {}

  /**
   * 扩展点：按需检索（向量库 / wiki）。
   * TODO: 接入真实检索后，在 build() 里把 retrieve(当前任务) 的结果作为额外
   * system/context 注入（同样受预算约束）。现在返回空，不实现检索。
   */
  async retrieve(_query: string): Promise<RetrievedDoc[]> {
    return [];
  }

  build(agent: Agent, messages: Message[], reservedTokens = 0): BuildResult {
    if (typeof agent.contextBudget !== "number" || !Number.isFinite(agent.contextBudget) || agent.contextBudget <= 0) {
      throw new Error("ContextManager requires a resolved positive numeric context budget");
    }
    const contextLimit = Math.floor(agent.contextBudget);
    const budget = Math.max(0, contextLimit - Math.max(0, reservedTokens));
    const totalTokens = estimateMessagesTokens(messages);

    // 拆出 system（恒保留）。
    const system = messages[0]?.role === "system" ? messages[0] : null;
    const body = system ? messages.slice(1) : messages;

    // 当前任务锚点：最后一条 user 消息的下标。
    let anchor = -1;
    for (let i = body.length - 1; i >= 0; i--) {
      if (body[i]!.role === "user") {
        anchor = i;
        break;
      }
    }
    const current = anchor >= 0 ? body.slice(anchor) : body; // 恒保留
    const earlier = anchor >= 0 ? body.slice(0, anchor) : [];

    let used = (system ? estimateMessageTokens(system) : 0) + estimateMessagesTokens(current);
    if (used > budget) {
      // Never truncate the current task/tool chain or send an already oversized request.
      throw new ContextWindowExceededError("当前任务、工具结果或固定工具定义已超过上下文预算；已停止继续调用模型，保留已有工具执行记录。请缩小输入或从断点继续。");
    }

    // 连续时间序尾窗：从最近往前收更早历史，尽量多塞但【保持原顺序、绝不重排】。
    // 稳定前缀是命中 prompt cache 的命门——按相关性重排会让前缀每轮都变、必然 miss，
    // 反而把便宜的缓存 token（~17% 价）换成全价重算。正常情况下压缩阈值 < contextBudget，
    // 会先压缩重置、这里几乎不裁；仅作硬上限兜底（丢更早的、保留连续近端窗口）。
    const keptEarlier: Message[] = [];
    for (let i = earlier.length - 1; i >= 0; i--) {
      const t = estimateMessageTokens(earlier[i]!);
      if (used + t > budget) break;
      used += t;
      keptEarlier.unshift(earlier[i]!);
    }

    let result: Message[] = [...(system ? [system] : []), ...keptEarlier, ...current];

    // 修复孤儿 tool 消息：window 开头若是 tool（其 assistant tool_call 被裁了），
    // OpenAI 会报错。把开头连续的 tool 消息丢掉。
    // TODO: 更严格的做法是把 assistant(tool_calls) 与其 tool 结果作为原子组一起取舍。
    const sysCount = system ? 1 : 0;
    while (result[sysCount] && result[sysCount]!.role === "tool") {
      result.splice(sysCount, 1);
    }

    const injectedTokens = estimateMessagesTokens(result);
    const stats: BuildStats = {
      injectedTokens,
      trimmedTokens: Math.max(0, totalTokens - injectedTokens),
      keptMessages: result.length,
      droppedMessages: messages.length - result.length,
    };

    this.logger.debug(
      {
        agent: agent.name,
        budget,
        injectedTokens: stats.injectedTokens,
        trimmedTokens: stats.trimmedTokens,
        kept: stats.keptMessages,
        dropped: stats.droppedMessages,
      },
      "context:build"
    );

    return { messages: result, stats };
  }
}
