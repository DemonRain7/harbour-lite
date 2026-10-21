import type { ToolDef } from "../../types";
import { ASK_TIMEOUT, ASK_MAX_WAIT_MS } from "../askUser";

/**
 * ask_user —— agent 在完成预检与暂定计划后，把本任务全部澄清点一次性问完。
 * 对标 Claude Code 的 AskUserQuestion：不是"危险命令确认"的附属品，而是一个
 * 随时能调的通用工具 —— 需求有歧义、方案有分叉、要他拍板时就调。
 *
 * 【两种形态，按渠道分】
 *   · web 面板：真弹窗，选项按钮 + 「其它」自由输入。工具在这里【阻塞】等答复。
 *   · Discord / 企业微信等：没有弹窗可用，工具【不阻塞】，直接回一句「把问题写进你的
 *     回复里去问」。agent 照常叙述，用户 下一条消息就是答案 —— 这是 用户 的明确要求
 *     （2026-07-21：「discord 那边就是正常叙述」）。
 *
 * 【为什么不在 Discord 上做按钮】做过一版按钮，用户 要的是正常对话感：
 * 聊天框里蹦出一排组件反而割裂。web 面板是"操作台"，弹窗合适；聊天渠道就该像聊天。
 */

const MAX_OPTIONS = 5;
const MAX_QUESTIONS = 8;
const RUN_STATE_KEY = "ask_user:clarification-batch-used";

interface NormalizedOption {
  value: string;
  label: string;
  hint?: string;
}

interface NormalizedQuestion {
  id: string;
  question: string;
  detail?: string;
  options: NormalizedOption[];
  recommended?: string;
}

function normalizeOptions(raw: unknown, questionId: string): NormalizedOption[] {
  const rawList: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.values(raw as Record<string, unknown>)
      : [];
  const options = rawList
    .map((o): NormalizedOption | null => {
      if (typeof o === "string" || typeof o === "number") {
        const s = String(o).trim();
        return s ? { value: s, label: s } : null;
      }
      if (o && typeof o === "object") {
        const v = o as Record<string, unknown>;
        const label = String(v.label ?? v.text ?? v.name ?? v.title ?? v.option ?? v.value ?? "").trim();
        const value = String(v.value ?? v.id ?? v.key ?? label).trim();
        const hint = v.hint ?? v.description ?? v.desc;
        return label ? { value: value || label, label, ...(hint ? { hint: String(hint) } : {}) } : null;
      }
      return null;
    })
    .filter((o): o is NormalizedOption => o !== null);

  if (options.length === 0) {
    throw new Error(
      `ask_user: 问题 ${questionId} 没解析到有效选项。options 请传字符串数组` +
        '（如 ["火锅","寿司"]）或 {"label":"火锅","value":"hotpot"} 对象数组。'
    );
  }
  if (options.length > MAX_OPTIONS) {
    throw new Error(`ask_user: 问题 ${questionId} 有 ${options.length} 个选项，最多 ${MAX_OPTIONS} 个；请合并近似选项。`);
  }
  return options;
}

function normalizeQuestions(args: Record<string, unknown>): { questions: NormalizedQuestion[]; legacy: boolean } {
  const legacy = !Array.isArray(args.questions);
  const rawQuestions: unknown[] = legacy ? [args] : args.questions as unknown[];
  if (rawQuestions.length === 0) throw new Error("ask_user: questions 不能为空");
  if (rawQuestions.length > MAX_QUESTIONS) {
    throw new Error(
      `ask_user: 一批最多 ${MAX_QUESTIONS} 个问题，当前 ${rawQuestions.length} 个。` +
        "请先自行调查、采用可逆默认值并合并相关问题；不要拆成多轮打扰用户。"
    );
  }

  const usedIds = new Set<string>();
  return {
    legacy,
    questions: rawQuestions.map((raw, index) => {
      if (!raw || typeof raw !== "object") throw new Error(`ask_user: questions[${index}] 必须是对象`);
      const item = raw as Record<string, unknown>;
      const question = String(item.question ?? "").trim();
      if (!question) throw new Error(`ask_user: questions[${index}].question 不能为空`);
      const baseId = String(item.id ?? `q${index + 1}`).trim() || `q${index + 1}`;
      let id = baseId;
      let suffix = 2;
      while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
      usedIds.add(id);
      const detail = item.detail ? String(item.detail).trim() : undefined;
      const recommended = item.recommended ? String(item.recommended).trim() : undefined;
      return {
        id,
        question,
        ...(detail ? { detail } : {}),
        options: normalizeOptions(item.options, id),
        ...(recommended ? { recommended } : {}),
      };
    }),
  };
}

export const askUserTool: ToolDef = {
  name: "ask_user",
  description:
    "普通需求澄清的单次闸门：先完成可做的调查、思考和暂定计划，再用 questions 一次提交" +
    "本任务全部关键问题并等 用户 全部回答。不要想到一个问一个，也不要回答后再次确认。" +
    "每次运行只允许一批普通澄清；不可逆动作的安全确认由具体执行工具另行处理。" +
    "Web 会逐题展示，全部答完才恢复；其它渠道应在一条回复里列完全部问题。",
  // 等人可能等满 3 分钟，外层保险丝要放宽，否则工具会先被判超时。
  timeoutMs: ASK_MAX_WAIT_MS + 30_000,
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      planSummary: {
        type: "string",
        description: "调用前已经完成的调查和暂定计划摘要；用于审计提问发生在预检之后",
      },
      questions: {
        type: "array",
        description:
          `当前任务全部需要用户决定的问题，1~${MAX_QUESTIONS} 个；必须一次传完，不得分多次调用。`,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "稳定短标识，用来把答案对应回计划分支，如 output_scope" },
            question: { type: "string", description: "一个会实质改变方案的问题" },
            detail: { type: "string", description: "为什么需要用户决定（可选）" },
            recommended: { type: "string", description: "推荐选项的 value 或 label（可选）" },
            options: {
              type: "array",
              description: `候选答案，最多 ${MAX_OPTIONS} 个；可用字符串或 {label,value,hint} 对象。用户也能自由输入。`,
              items: {
                type: ["string", "object"],
                properties: {
                  label: { type: "string", description: "按钮上显示的字" },
                  value: { type: "string", description: "回给模型的值（缺省时用 label）" },
                  hint: { type: "string", description: "这个选项意味着什么（可选）" },
                },
              },
            },
          },
          required: ["question", "options"],
        },
      },
      // 旧调用形态保留兼容；新提示词与测试只允许模型使用 questions。
      question: { type: "string", description: "兼容旧调用的单个问题；新调用请使用 questions" },
      detail: { type: "string", description: "兼容旧调用的补充背景" },
      options: {
        type: "array",
        description: "兼容旧调用的候选答案；新调用请放到 questions[n].options",
        items: { type: ["string", "object"] },
      },
    },
  },
  async execute(args, ctx) {
    const { questions, legacy } = normalizeQuestions(args);
    const planSummary = String(args.planSummary ?? "").trim();
    if (!legacy && !planSummary) {
      throw new Error(
        "ask_user: 批量 questions 调用必须提供 planSummary，说明已完成的调查与暂定计划；" +
          "请先完成预检，不要边想边问。"
      );
    }
    if (ctx.runState?.get(RUN_STATE_KEY)) {
      return {
        asked: false,
        answered: false,
        reason: "clarification_batch_already_used",
        instruction:
          "本次运行已经使用过普通澄清闸门。不要继续零散提问，也不要绕过工具直接问；" +
          "采用已说明的安全默认值继续，或在无法安全继续时说明新发现的硬阻塞。",
      };
    }
    ctx.runState?.set(RUN_STATE_KEY, true);
    ctx.logger.info(
      { questionCount: questions.length, questionIds: questions.map((q) => q.id), legacy, hasPlanSummary: !!planSummary },
      "ask_user:batch"
    );

    // —— 无弹窗渠道：不阻塞，让 agent 自己把问题说出来 ——
    if (!ctx.askUser) {
      return {
        asked: false,
        mode: "narrate",
        instruction:
          "当前渠道没有弹窗。先用一小段话写明 planSummary 中已经完成的预检与暂定方案，" +
          "再在【同一条回复】里按编号列出下面全部问题和选项，然后结束本轮；" +
          "用户 下一条消息是这一整批的答案。不要拆开发送、不要再调用本工具。",
        ...(planSummary ? { planSummary } : {}),
        questions,
        ...(legacy && questions.length === 1 ? {
          question: questions[0]!.question,
          ...(questions[0]!.detail ? { detail: questions[0]!.detail } : {}),
          options: questions[0]!.options,
        } : {}),
      };
    }

    // 同一工具调用内并发挂起整批问题；前端逐题展示，全部 settle 后才把控制权还给模型。
    const answers = await Promise.all(questions.map(async (q) => {
      const answer = await ctx.askUser!({
        kind: "question",
        question: q.question,
        detail: q.detail,
        options: q.options,
        timeoutMs: ASK_MAX_WAIT_MS,
      });
      if (answer === ASK_TIMEOUT) return { id: q.id, answered: false, reason: "timeout" };
      const picked = q.options.find((o) => o.value === answer);
      return {
        id: q.id,
        answered: true,
        answer,
        ...(picked ? { label: picked.label } : { freeText: true }),
      };
    }));
    const response: Record<string, unknown> = {
      asked: true,
      answered: answers.every((a) => a.answered),
      answers,
    };
    // 旧版单题调用保留顶层 answer/label，避免既有模型链和测试突然失配。
    if (legacy && answers.length === 1) Object.assign(response, answers[0]);
    return response;
  },
};
