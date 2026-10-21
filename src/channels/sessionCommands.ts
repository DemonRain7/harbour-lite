import type { SessionStore, SessionGoalStatus, ChatSession } from "../core/sessionStore";
import {
  normalizeAgentPermissionMode,
  normalizeReasoningEffort,
  type AgentPermissionMode,
  type ReasoningEffort,
  type SessionOrigin,
} from "../types";

/** QQ / Discord 共用的会话级模型目录项。 */
export interface SessionCommandModel {
  modelRef: string;
  label: string;
  supportedEfforts: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
}

export interface SessionCommandOptions {
  channel: string;
  agentName: string;
  origin?: SessionOrigin;
  /** 配置能力只给入口已经验证为 owner 的用户；不能信昵称或消息自述。 */
  isOwner?: boolean;
  models?: SessionCommandModel[];
  skills?: string[];
  defaultModelRef?: string;
  defaultPermissionMode?: AgentPermissionMode;
  defaultReasoningEffort?: ReasoningEffort;
  /** Trusted channel entry point binds identity, stops runs and schedules after delivery. */
  onGoalChanged?: (session: ChatSession, action: GoalCommandAction) => void;
}

export type GoalCommandAction = "show" | "start" | "complete" | "cancel" | "pause" | "resume" | "budget";

export type SessionCommand =
  | { kind: "new" }
  | { kind: "list" }
  | { kind: "switch"; arg: string }
  | { kind: "config" }
  | { kind: "model"; arg: string }
  | { kind: "effort"; arg: string }
  | { kind: "mode"; arg: string }
  | { kind: "skill"; arg: string }
  | { kind: "goal"; action: GoalCommandAction; arg: string }
  | { kind: "help" };

const NEW = new Set(["new", "newchat", "新会话", "新对话", "新开"]);
const LIST = new Set(["sessions", "list", "会话", "会话列表", "列表"]);
const SWITCH = new Set(["switch", "use", "切换", "切到"]);
const CONFIG = new Set(["config", "settings", "配置", "设置"]);
const MODEL = new Set(["model", "模型"]);
const EFFORT = new Set(["effort", "思考", "推理"]);
const MODE = new Set(["mode", "模式", "权限"]);
const SKILL = new Set(["skill", "技能"]);
const GOAL = new Set(["goal", "目标"]);
const HELP = new Set(["help", "命令", "帮助"]);
const FOLLOW = new Set(["follow", "reset", "clear", "default", "跟随", "默认", "清除"]);
const AUTO = new Set([...FOLLOW, "auto", "automatic", "自动"]);
const MODE_FOLLOW = new Set(["follow", "reset", "clear", "跟随", "默认", "清除"]);

function parseGoal(raw: string): SessionCommand {
  const clean = raw.trim();
  if (!clean) return { kind: "goal", action: "show", arg: "" };
  const [head = "", ...rest] = clean.split(/\s+/);
  const action = head.toLowerCase();
  const arg = rest.join(" ").trim();
  if (["show", "status", "查看", "状态"].includes(action)) return { kind: "goal", action: "show", arg };
  if (["start", "new", "开始", "新建"].includes(action)) return { kind: "goal", action: "start", arg };
  if (["complete", "done", "完成"].includes(action)) return { kind: "goal", action: "complete", arg };
  if (["cancel", "exit", "abort", "取消", "退出", "放弃"].includes(action)) return { kind: "goal", action: "cancel", arg };
  if (["resume", "continue", "恢复", "继续"].includes(action)) return { kind: "goal", action: "resume", arg };
  if (["pause", "stop", "暂停", "停止"].includes(action)) return { kind: "goal", action: "pause", arg };
  if (["budget", "预算"].includes(action)) return { kind: "goal", action: "budget", arg };
  return { kind: "goal", action: "start", arg: clean };
}

/** 解析一条消息是否是会话/配置命令；不是则返回 null（按普通对话处理）。 */
export function parseSessionCommand(text: string): SessionCommand | null {
  const t = (text ?? "").trim();
  const prefix = t[0];
  if (prefix !== "/" && prefix !== "!" && prefix !== "！") return null;
  const parts = t.slice(1).trim().split(/\s+/);
  const head = (parts.shift() ?? "").toLowerCase();
  const arg = parts.join(" ").trim();
  if (NEW.has(head)) return { kind: "new" };
  if (LIST.has(head)) return { kind: "list" };
  if (SWITCH.has(head)) return { kind: "switch", arg };
  if (CONFIG.has(head)) return { kind: "config" };
  if (MODEL.has(head)) return { kind: "model", arg };
  if (EFFORT.has(head)) return { kind: "effort", arg };
  if (MODE.has(head)) return { kind: "mode", arg };
  if (SKILL.has(head)) return { kind: "skill", arg };
  if (GOAL.has(head)) return parseGoal(arg);
  if (HELP.has(head)) return { kind: "help" };
  return null;
}

/** 由 Discord 原生斜杠命令构造同一语义命令。 */
export function commandFromSlash(
  name: string,
  values?: string | Record<string, string>
): SessionCommand | null {
  const head = (name ?? "").toLowerCase();
  const args = typeof values === "string" ? { target: values } : (values ?? {});
  if (NEW.has(head)) return { kind: "new" };
  if (LIST.has(head)) return { kind: "list" };
  if (SWITCH.has(head)) return { kind: "switch", arg: (args.target ?? "").trim() };
  if (CONFIG.has(head)) return { kind: "config" };
  if (MODEL.has(head)) return { kind: "model", arg: (args.value ?? "").trim() };
  if (EFFORT.has(head)) return { kind: "effort", arg: (args.value ?? "").trim() };
  if (MODE.has(head)) return { kind: "mode", arg: (args.value ?? "").trim() };
  if (SKILL.has(head)) return { kind: "skill", arg: (args.value ?? "").trim() };
  if (GOAL.has(head)) {
    const action = (args.action || "show") as GoalCommandAction;
    return { kind: "goal", action, arg: (args.text ?? "").trim() };
  }
  if (HELP.has(head)) return { kind: "help" };
  return null;
}

function shortId(id: string): string {
  return id.replace(/^cs-/, "");
}

function resolveTarget<T extends { id: string }>(list: T[], arg: string): T | undefined {
  const clean = arg.replace(/^#/, "").trim();
  if (/^\d+$/.test(clean)) return list[Number(clean) - 1];
  return list.find((s) => shortId(s.id) === clean || s.id === clean || shortId(s.id).startsWith(clean));
}

function normalizedChoice(raw: string): string {
  return raw.normalize("NFKC").trim().toLowerCase();
}

function isAuto(raw: string): boolean {
  return AUTO.has(normalizedChoice(raw));
}

function resolveModel(models: SessionCommandModel[], raw: string): SessionCommandModel | "ambiguous" | undefined {
  const clean = raw.trim();
  if (/^\d+$/.test(clean)) return models[Number(clean) - 1];
  const exact = models.find((model) => model.modelRef.toLowerCase() === clean.toLowerCase());
  if (exact) return exact;
  const matches = models.filter((model) =>
    model.label.toLowerCase() === clean.toLowerCase() ||
    model.modelRef.split("/").at(-1)?.toLowerCase() === clean.toLowerCase()
  );
  return matches.length === 1 ? matches[0] : matches.length > 1 ? "ambiguous" : undefined;
}

function resolveSkill(skills: string[], raw: string): string | "ambiguous" | undefined {
  const clean = raw.trim().toLowerCase();
  if (/^\d+$/.test(clean)) return skills[Number(clean) - 1];
  const exact = skills.find((skill) => skill.toLowerCase() === clean);
  if (exact) return exact;
  const matches = skills.filter((skill) => skill.toLowerCase().startsWith(clean));
  return matches.length === 1 ? matches[0] : matches.length > 1 ? "ambiguous" : undefined;
}

function modeFromInput(raw: string): AgentPermissionMode | undefined {
  const clean = normalizedChoice(raw).replace(/[\s_-]+/g, "");
  const aliases: Record<string, AgentPermissionMode> = {
    default: "default",
    ask: "default",
    acceptedits: "acceptEdits",
    bypasspermissions: "bypassPermissions",
    bypass: "bypassPermissions",
    plan: "plan",
    dontask: "dontAsk",
    auto: "auto",
  };
  return aliases[clean] ?? normalizeAgentPermissionMode(raw.trim());
}

function modelLines(models: SessionCommandModel[]): string {
  if (!models.length) return "（当前没有可选模型）";
  return models.slice(0, 25).map((model, index) => `${index + 1}. ${model.label}　${model.modelRef}`).join("\n");
}

function skillLines(skills: string[]): string {
  return skills.length ? skills.map((skill, index) => `${index + 1}. ${skill}`).join("\n") : "（当前 Agent 没有挂载 Skill）";
}

function effectiveModel(opts: SessionCommandOptions, modelRef?: string): SessionCommandModel | undefined {
  const ref = modelRef || opts.defaultModelRef;
  return opts.models?.find((model) => model.modelRef === ref);
}

function effectiveEffort(opts: SessionCommandOptions, session: { reasoningEffort?: ReasoningEffort; modelRef?: string }): ReasoningEffort | undefined {
  return session.reasoningEffort ?? effectiveModel(opts, session.modelRef)?.defaultEffort ?? opts.defaultReasoningEffort;
}

function goalStatusLabel(status: SessionGoalStatus): string {
  return ({ active: "进行中", blocked: "等待中", paused: "已暂停", completed: "已完成", cancelled: "已退出" } as const)[status];
}

function ownerOnly(opts: SessionCommandOptions): string | null {
  return opts.isOwner ? null : "🔒 只有已绑定的主人能查看或修改模型、Effort、Mode、Skill 与 GOAL；当前身份不会获得这些配置权限。";
}

function helpText(): string {
  return [
    "🧭 会话命令（Discord 可直接用原生 `/`；QQ 发送同名文本命令）：",
    "· /new　新会话　　/sessions　会话列表　　/switch <序号>",
    "· /config　查看当前会话配置",
    "· /model [序号/模型/auto]　选择模型或跟随 Agent",
    "· /effort [档位/auto]　off/none/minimal/low/medium/high/xhigh/max/ultra",
    "· /mode [模式/follow]　default/acceptEdits/dontAsk/plan/auto/bypassPermissions",
    "· /skill [序号/名称/auto]　钉住 Skill 或恢复自动路由",
    "· /goal [目标]　开始；/goal pause|resume|complete|cancel [说明]　管理目标",
    "· /goal budget <总轮数> [总Token/none]　暂停后调整预算（不会自动恢复）",
    "· /steer 正文 / /queue 正文　仅这条补充或排队；裸命令切换会话默认（QQ/Discord 文本入口）",
    "· /收集 / /发完　收齐一组图文；/pending 查看待办；/stop 停止",
    "配置只作用于当前 Bot + 当前频道/私聊 + 当前会话；/new 会得到一套新的默认配置。",
  ].join("\n");
}

/** 执行会话/配置命令，返回要回发给用户的文本。 */
export function handleSessionCommand(
  store: SessionStore,
  key: string,
  opts: SessionCommandOptions,
  cmd: SessionCommand
): string {
  switch (cmd.kind) {
    case "new": {
      const s = store.create(key, { channel: opts.channel, agentName: opts.agentName, origin: opts.origin });
      return `🆕 已开启新会话 #${shortId(s.id)}。之前的对话已存档，可用 /sessions 查看、/switch 切回。`;
    }
    case "list": {
      const list = store.listForKey(key);
      const activeId = store.activeId(key);
      if (!list.length) return "（本频道还没有会话。直接说话即可开始；之后可 /new 开新会话。）";
      const lines = list.map((s, i) => {
        const mark = s.id === activeId ? "▶" : "·";
        const meta = `${s.messages.length} 条${s.compactions ? ` · 压缩x${s.compactions}` : ""}`;
        return `${mark} ${i + 1}. ${s.title}　〔#${shortId(s.id)} · ${meta}〕`;
      });
      return `🗂 本频道会话（▶=当前）：\n${lines.join("\n")}\n\n切换：/switch <序号或#id>　新开：/new`;
    }
    case "switch": {
      const list = store.listForKey(key);
      if (!cmd.arg) return "用法：/switch <序号或 #id>。先用 /sessions 看列表。";
      const target = resolveTarget(list, cmd.arg);
      if (!target) return `没找到会话「${cmd.arg}」。用 /sessions 看当前列表。`;
      store.switchActive(key, target.id);
      return `✅ 已切到会话 #${shortId(target.id)}「${target.title}」（${target.messages.length} 条历史，我会接着这段记忆聊）。`;
    }
    case "help":
      return helpText();
  }

  const denied = ownerOnly(opts);
  if (denied) return denied;
  const session = store.resolveActive(key, { channel: opts.channel, agentName: opts.agentName, origin: opts.origin });
  const models = opts.models ?? [];
  const skills = opts.skills ?? [];

  switch (cmd.kind) {
    case "config": {
      const goal = session.goal;
      return [
        `⚙️ 当前会话 #${shortId(session.id)}`,
        `· Model：${effectiveModel(opts, session.modelRef)?.label || session.modelRef || `跟随 Agent（${opts.defaultModelRef || "自动路由"}）`}`,
        `· Effort：${effectiveEffort(opts, session) || "模型默认"}${session.reasoningEffort ? "（会话覆盖）" : "（跟随默认）"}`,
        `· Mode：${session.permissionMode || opts.defaultPermissionMode || "default"}${session.permissionMode ? "（会话覆盖）" : "（跟随 Agent）"}`,
        `· Skill：${session.pinnedSkill || "自动语义路由"}`,
        `· GOAL：${goal ? `${goalStatusLabel(goal.status)} · ${goal.objective}` : "未开启"}`,
        "修改：/model · /effort · /mode · /skill · /goal（不带参数可看可选项）",
      ].join("\n");
    }
    case "model": {
      if (!cmd.arg) {
        return `🤖 当前：${session.modelRef || `跟随 Agent（${opts.defaultModelRef || "自动路由"}）`}\n${modelLines(models)}\n\n设置：/model <序号或 modelRef>　恢复：/model auto`;
      }
      if (isAuto(cmd.arg)) {
        store.setModel(session.id, undefined);
        store.setReasoningEffort(session.id, undefined);
        return `✅ Model 已恢复跟随 Agent：${opts.defaultModelRef || "自动路由"}；不兼容的 Effort 覆盖也已清除。`;
      }
      const selected = resolveModel(models, cmd.arg);
      if (selected === "ambiguous") return `模型名「${cmd.arg}」不唯一，请用 /model 的序号或完整 modelRef。`;
      if (!selected) return `没找到可用模型「${cmd.arg}」。发送 /model 查看列表。`;
      store.setModel(session.id, selected.modelRef);
      if (session.reasoningEffort && !selected.supportedEfforts.includes(session.reasoningEffort)) {
        store.setReasoningEffort(session.id, undefined);
      }
      return `✅ 当前会话 Model → ${selected.label}\n${selected.modelRef}${session.reasoningEffort ? `\nEffort 保持 ${session.reasoningEffort}` : "\nEffort 跟随该模型/Agent 默认"}`;
    }
    case "effort": {
      const model = effectiveModel(opts, session.modelRef);
      const options = model?.supportedEfforts ?? [];
      if (!cmd.arg) {
        return `🧠 当前 Effort：${effectiveEffort(opts, session) || "模型默认"}\n当前模型：${model?.label || session.modelRef || opts.defaultModelRef || "自动"}\n可选：${options.join(" / ") || "请先选择一个可识别模型"}\n设置：/effort <档位>　恢复：/effort auto`;
      }
      if (isAuto(cmd.arg)) {
        store.setReasoningEffort(session.id, undefined);
        return `✅ Effort 已恢复默认：${model?.defaultEffort || opts.defaultReasoningEffort || "由模型决定"}。`;
      }
      const effort = normalizeReasoningEffort(normalizedChoice(cmd.arg));
      if (!effort) return `未知 Effort「${cmd.arg}」。可选：off / none / minimal / low / medium / high / xhigh / max / ultra。`;
      if (!model || !options.includes(effort)) {
        return `${model?.label || "当前模型"} 不支持 Effort=${effort}。可选：${options.join(" / ") || "无可用目录信息"}`;
      }
      store.setReasoningEffort(session.id, effort);
      return `✅ 当前会话 Effort → ${effort}（Model：${model.label}）`;
    }
    case "mode": {
      if (!cmd.arg) {
        return `🛡️ 当前 Mode：${session.permissionMode || opts.defaultPermissionMode || "default"}\n可选：default / acceptEdits / dontAsk / plan / auto / bypassPermissions\n设置：/mode <模式>　恢复跟随 Agent：/mode follow`;
      }
      if (MODE_FOLLOW.has(normalizedChoice(cmd.arg))) {
        store.setPermissionMode(session.id, undefined);
        return `✅ Mode 已恢复跟随 Agent：${opts.defaultPermissionMode || "default"}。`;
      }
      const mode = modeFromInput(cmd.arg);
      if (!mode) return `未知 Mode「${cmd.arg}」。发送 /mode 查看可选项。`;
      store.setPermissionMode(session.id, mode);
      return `✅ 当前会话 Mode → ${mode}${mode === "plan" ? "（只规划/只读）" : ""}`;
    }
    case "skill": {
      if (!cmd.arg) {
        return `🧩 当前 Skill：${session.pinnedSkill || "自动语义路由"}\n${skillLines(skills)}\n\n设置：/skill <序号或名称>　恢复：/skill auto`;
      }
      if (isAuto(cmd.arg)) {
        store.setPinnedSkill(session.id, undefined);
        return "✅ Skill 已恢复自动语义路由；Main 会按任务需要自主选择。";
      }
      const selected = resolveSkill(skills, cmd.arg);
      if (selected === "ambiguous") return `Skill「${cmd.arg}」匹配到多个名称，请用 /skill 的序号或完整名称。`;
      if (!selected) return `当前 Agent 没有挂载 Skill「${cmd.arg}」。发送 /skill 查看列表。`;
      store.setPinnedSkill(session.id, selected);
      return `✅ 当前会话已钉住 Skill → ${selected}\n后续每轮都会优先加载它；/skill auto 可恢复自动选择。`;
    }
    case "goal": {
      const goal = session.goal;
      if (cmd.action === "show") {
        return goal
          ? `🎯 GOAL：${goalStatusLabel(goal.status)}\n${goal.objective}${goal.progress ? `\n进度：${goal.progress}` : ""}\n轮次：${goal.usage.roundsStarted}/${goal.budget.maxRounds} · Token：${goal.usage.totalTokens}${goal.budget.maxTokens === null ? "" : `/${goal.budget.maxTokens}`}${goal.nextStep ? `\n下一步：${goal.nextStep.action}` : ""}${goal.waiting ? `\n等待：${goal.waiting.reason}` : ""}`
          : "🎯 当前会话没有 GOAL。用 /goal <目标内容> 或 /goal start <目标内容> 开始。";
      }
      try {
        if (cmd.action === "start") {
          if (!cmd.arg) return "用法：/goal <目标内容>，或 /goal start <目标内容>。";
          const created = store.startGoal(session, cmd.arg, { autoContinue: true, nextStep: { action: cmd.arg } });
          opts.onGoalChanged?.(session, cmd.action);
          return `🎯 已开启 GOAL：${created.objective}\n服务端按明确下一步自动推进，默认最多 ${created.budget.maxRounds} 轮（包含首轮）。/goal pause 暂停并保留断点；/goal resume 恢复；/goal complete 手动验收。`;
        }
        if (!goal) return "当前会话没有 GOAL；先用 /goal <目标内容> 开始。";
        if (cmd.action === "budget") {
          const [rounds, tokens, extra] = cmd.arg.split(/\s+/);
          if (!/^\d+$/.test(rounds || "") || extra || (tokens && !/^(?:\d+|none)$/i.test(tokens))) return "用法：/goal budget <总轮数> [总Token/none]；这是累计总额，不是本轮额度。";
          if (goal.status !== "paused" && goal.status !== "blocked") return "请先 /goal pause，等待本轮停止后调整预算。";
          store.configureGoal(session, goal.id, { budget: { maxRounds: Number(rounds),
            ...(tokens ? { maxTokens: tokens.toLowerCase() === "none" ? null : Number(tokens) } : {}) } });
          opts.onGoalChanged?.(session, cmd.action);
          return "✅ GOAL 总预算已更新。需要继续时请发送 /goal resume。";
        }
        if (cmd.action === "complete") store.setGoalStatus(session, "completed", cmd.arg);
        else if (cmd.action === "cancel") store.setGoalStatus(session, "cancelled", cmd.arg);
        else if (cmd.action === "pause") store.pauseGoal(session, goal.id, { kind: "user", reason: cmd.arg || "你已暂停目标。" });
        else if (cmd.action === "resume") {
          if (!["paused", "blocked", "active"].includes(goal.status)) {
            return "只有进行中/等待中/已暂停的 GOAL 可以恢复；已完成或已退出的目标请重新 /goal <目标内容>。";
          }
          store.resumeGoal(session, goal.id);
          if (cmd.arg) store.configureGoal(session, goal.id, { progress: cmd.arg });
        }
        opts.onGoalChanged?.(session, cmd.action);
        return `✅ GOAL 已${cmd.action === "complete" ? "完成" : cmd.action === "cancel" ? "退出" : cmd.action === "pause" ? "暂停" : "恢复"}：${session.goal?.objective}`;
      } catch (error) {
        return `无法修改 GOAL：${(error as Error).message}`;
      }
    }
    default:
      return helpText();
  }
}
