import type { RunAgent, Task } from "../types";

/** Fresh background work carries identity separately from conversation history. */
export function runTaskAgent(runAgent: RunAgent, task: Task, signal?: AbortSignal): Promise<string> {
  return runAgent(task.agentName, task.input, task.taskType, task.attachments, task.sessionRef,
    undefined, undefined, signal, undefined, task.source ? { source: task.source } : undefined);
}
