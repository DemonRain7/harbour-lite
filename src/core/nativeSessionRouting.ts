import type { ChatSession, RunCheckpoint } from "./sessionStore";
import type { NativeSessionContext } from "./nativeSession";
import type { RunExecutionContext, RunSource } from "../types";

/** Runtime switch, not an Agent prompt or a model-controlled capability. */
export function nativeResumeEnabled(supported: boolean, setting = process.env.HARBOUR_NATIVE_RESUME): boolean {
  return supported && !/^(?:0|false|off)$/i.test(setting ?? "");
}

/** Shared execution evidence is not permission to resume the caller's conversation.
 * spawn_subagent must explicitly bind a saved task to THIS dispatch. One-shot
 * executors keep checkpoint/Cowork/cancellation, but never the parent's draft/ID. */
export function bindDelegatedSession(
  execution: RunExecutionContext, agent: string, taskRef: string | undefined,
  attemptId: string, nativeSupported: boolean,
): RunExecutionContext {
  const tasks = execution.delegationTasks;
  const native = execution.nativeSession;
  const ownsTask = !!taskRef && taskRef === tasks?.taskRef && !!tasks.eligibleAgents?.includes(agent)
    && agent !== "browser_controller";
  return {
    ...execution,
    delegationTasks: ownsTask ? tasks : undefined,
    nativeSession: ownsTask && nativeSupported && native && !native.active
      && native.scope === `${tasks!.scope}\0task:${taskRef}`
      ? { ...native, attemptId, active: false, incrementalMessages: undefined, prepareSeed: undefined, observedContext: undefined }
      : undefined,
  };
}

export function mainNativeSession(options: {
  rootDir: string; session: ChatSession; source: RunSource; agent: string;
  attemptId: string; input: string; checkpoint?: RunCheckpoint;
  resuming: boolean; deviceId?: string; cwd?: string;
}): NativeSessionContext {
  const { session, source, checkpoint } = options;
  const previous = [...session.messages].reverse().find((message) => message.role === "assistant");
  return {
    rootDir: options.rootDir,
    // One active binding per conversation/actor/agent/device, not per selected model.
    scope: JSON.stringify([session.id, source.channel, source.key, source.actor?.platform,
      source.actor?.id, options.agent, options.deviceId ?? "server", options.cwd ?? ""]),
    attemptId: options.attemptId,
    previousAttemptId: previous?.runRecord?.attemptId,
    continuity: true,
    resumingCheckpoint: options.resuming,
    recoveryOnly: options.resuming && /^(?:请\s*)?(?:继续|从断点继续|接着做|resume|continue)[\s。.!！]*$/iu.test(options.input.trim()),
    incrementalInput: `${options.input}${checkpoint && options.resuming ? nativeCheckpointNote(checkpoint, session) : ""}`,
  };
}

/** Native history supplies prior dialogue; the original task also covers a crash
 * before the provider durably accepted its user message (not a full-history replay). */
export function nativeCheckpointNote(checkpoint: RunCheckpoint, session?: ChatSession): string {
  const unfinished = checkpoint.tools.filter((call) => call.status !== "completed");
  const facts = unfinished.slice(-8).map((call) => ({
    tool: call.tool, agent: call.agent, status: call.status,
    ...(call.remote ? { operation: call.remote } : {}),
    ...(call.recovery ? { saved: call.recovery } : {}),
    ...(call.rejection ? { outcome: call.rejection.outcome, code: call.rejection.code } : {}),
  }));
  // A local attempt ID is not an acknowledgment that its input reached the
  // provider. Preserve every distinct follow-up recorded for this checkpoint,
  // including a correction whose query failed before writing a native user item.
  const amendments: string[] = [];
  const messages = session?.messages ?? [];
  for (let index = 0; index < messages.length - 1; index++) {
    const user = messages[index]!;
    const reply = messages[index + 1]!;
    if (user.role !== "user" || reply.role !== "assistant" || reply.runRecord?.checkpointId !== checkpoint.id) continue;
    const input = user.content.trim();
    if (input && input !== checkpoint.originalInput.trim() && !/^(?:请\s*)?(?:继续|从断点继续|resume|continue)[\s。.!！]*$/iu.test(input) && !amendments.includes(input)) amendments.push(input);
  }
  return `\n\n[Harbour 原生续接·执行核对]\n本次未完成的原始请求：\n${checkpoint.originalInput}\n${JSON.stringify({
    checkpointId: checkpoint.id,
    completed: checkpoint.tools.length - unfinished.length,
    unfinished: unfinished.length,
    ...(amendments.length ? { recordedAmendments: amendments } : {}),
    latestUnfinished: facts,
  })}\n沿用已保存的原生对话，不从头规划。工具中断不等于未执行；已保存的草稿、Job/operation 是执行事实，先查原状态再续跑，禁止重复提交未知写操作。向用户交付结果或具体阻塞，不写内部备忘。`;
}
