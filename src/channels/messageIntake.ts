import type { SessionRef } from "../types";
import type { MessageIntake } from "../core/messageIntake";
import type { MessageMode } from "../core/runInputs";

/** Serial preparation only, not model execution. A slow image/ASR must not let later text overtake it. */
export class OrderedIngress {
  private tails = new Map<string, Promise<unknown>>();
  private counts = new Map<string, number>();
  run<T>(scope: string, prepare: () => Promise<T>): Promise<T> {
    const count = this.counts.get(scope) ?? 0;
    if (count >= 128 || this.tails.size >= 1000 && !this.tails.has(scope)) return Promise.reject(new Error("入站消息过多，请稍后再发；已接收消息仍会依序处理"));
    this.counts.set(scope, count + 1);
    const run = (this.tails.get(scope) ?? Promise.resolve()).then(prepare);
    const tail = run.catch(() => undefined).finally(() => {
      const remaining = (this.counts.get(scope) ?? 1) - 1;
      if (remaining) this.counts.set(scope, remaining); else this.counts.delete(scope);
      if (this.tails.get(scope) === tail) this.tails.delete(scope);
    });
    this.tails.set(scope, tail); return run;
  }
}

export function intakeCommand(text: string): boolean {
  return /^\/(?:收集|发完|collect|send|steer|queue|stop|停止|pending|收件箱)(?:\s|$)/i.test(text.trim());
}

/** Parse once, before ASR/attachment preparation. The body is never parsed as another command. */
export function parseIntakeInput(text: string, owner: boolean, hasAttachments = false): {
  input: string; mode?: MessageMode; command?: string;
} {
  if (!intakeCommand(text)) return { input: text };
  const match = /^\/(steer|queue)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (owner && match && (match[2]?.trim() || hasAttachments)) {
    return { input: (match[2] ?? "").trim(), mode: match[1]!.toLowerCase() as MessageMode };
  }
  // Non-owners still reach the existing identity guard, not the message/steer path.
  return { input: text, command: text };
}

export function handleIntakeCommand(text: string, intake: MessageIntake, ref: SessionRef, agent: string, stop: () => void): string {
  if (ref.actor?.role !== "owner") return "只有已验证主人能修改消息模式或控制任务。";
  if (parseIntakeInput(text, true).mode) throw new Error("带正文的 /steer、/queue 必须走收件箱；未切换会话模式或丢弃正文。");
  const [name, arg] = text.trim().slice(1).split(/\s+/);
  switch (name?.toLowerCase()) {
    case "收集": case "collect": intake.collect(ref, agent, true); return "开始收集图文。发完后发送 /发完；期间不会因停顿自动开跑。";
    case "发完": case "send": intake.collect(ref, agent, false); return "已提交收集的消息，会按当前模式处理。";
    case "steer": case "queue": intake.setMode(ref, agent, name.toLowerCase() as "steer" | "queue"); return name.toLowerCase() === "steer"
      ? "本会话：补充当前任务；不能安全接收时排队。" : "本会话：排队处理，不改变正在运行的任务。";
    case "stop": case "停止": intake.pause(ref, agent); stop(); return "已请求停止当前任务；未处理消息保留并暂停。用 /pending 查看，/pending resume 恢复已知未执行的消息。";
    case "pending": case "收件箱":
      if (arg === "resume") { intake.resume(ref, agent); return "已恢复尚未执行的待办。"; }
      const pending = intake.list(ref.id!, true);
      const labels = { collecting: "收集中", waiting: "等待处理", sending: "正在投递", accepted: "已送达当前运行", running: "处理中", paused: "已暂停", unknown: "待核对", completed: "已处理", withdrawn: "已撤回" };
      return pending.length ? pending.map(r => `${r.id.slice(0, 8)} · ${r.messages.length} 条 · ${r.mode === "queue" ? "排队" : "补充"}${r.isolated ? "（仅本条）" : ""} · ${labels[r.state]}${r.delivery === "unknown" ? " · 发送回执未知" : ""}${r.error ? ` · ${r.error}` : ""}`).join("\n") : "没有待处理消息。";
    default: return "消息命令：/收集、/发完、/pending、/pending resume、/stop；/steer 或 /queue 切换会话模式，后接正文则仅对这一条生效。";
  }
}
