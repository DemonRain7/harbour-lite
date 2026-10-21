import type { Task } from "../types";
import type { Logger } from "pino";

/**
 * 任务队列 + 固定大小 worker 池。
 * 并发数 = concurrency：同时最多有这么多个 worker 在跑 agentLoop，
 * 因此多个 agent 能真并发（不同 agent / 不同模型同时跑）。
 *
 * 先用内存队列；以后要换持久化（Redis/DB）只要替换这层、保持 enqueue/drain 接口。
 */
export class TaskQueue {
  private q: Task[] = [];
  private active = 0;
  private busySessions = new Set<string>();
  private completions = new Map<Task, { resolve: () => void; reject: (error: unknown) => void }>();
  private idleWaiters: Array<() => void> = [];

  constructor(
    private concurrency: number,
    private handler: (task: Task) => Promise<void>,
    private logger: Logger
  ) {}

  enqueue(task: Task): void {
    this.q.push(task);
    this.logger.debug({ id: task.id, agent: task.agentName, queued: this.q.length }, "queue:enqueue");
    this.pump();
  }
  submit(task: Task): Promise<void> {
    return new Promise((resolve, reject) => { this.completions.set(task, { resolve, reject }); this.enqueue(task); });
  }

  /** 拉起空闲 worker 直到打满并发或队列空。 */
  private pump(): void {
    while (this.active < this.concurrency && this.q.length > 0) {
      const index = this.q.findIndex(task => !task.sessionRef?.id || !this.busySessions.has(task.sessionRef.id));
      if (index < 0) break;
      const task = this.q.splice(index, 1)[0]!;
      const sessionId = task.sessionRef?.id;
      if (sessionId) this.busySessions.add(sessionId);
      this.active += 1;
      this.logger.debug({ id: task.id, agent: task.agentName, active: this.active }, "queue:start");
      void this.handler(task)
        .then(() => this.completions.get(task)?.resolve())
        .catch((e) => {
          this.completions.get(task)?.reject(e);
          this.logger.error({ id: task.id, agent: task.agentName, err: (e as Error).message }, "queue:task-error");
        })
        .finally(() => {
          this.active -= 1;
          this.completions.delete(task);
          if (sessionId) this.busySessions.delete(sessionId);
          this.pump();
          if (this.q.length === 0 && this.active === 0) {
            for (const w of this.idleWaiters.splice(0)) w();
          }
        });
    }
  }

  /** 等到队列清空且所有 worker 空闲（demo / 优雅退出用）。 */
  async drain(): Promise<void> {
    if (this.q.length === 0 && this.active === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  stats(): { queued: number; active: number } {
    return { queued: this.q.length, active: this.active };
  }
}
