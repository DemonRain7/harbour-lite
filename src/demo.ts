import { randomUUID } from "node:crypto";
import { loadEnv } from "./config/env";
import { makeLogger } from "./core/logger";
import { createRuntime } from "./runtime";
import { TaskQueue } from "./scheduler/queue";
import type { Task } from "./types";

/**
 * 离线 demo（`npm run dev` / `npm run demo`）。
 * 强制 MOCK_LLM——不接任何真模型也能逐轮看懂 loop。
 *
 * Demo 1：trajectory-checker 单 agent，跑「统计目录里缺 reward 字段的记录数」，
 *         控制台逐轮打印：调了什么工具、回灌了什么、第几轮收尾。
 * Demo 2：两个 agent（不同模型）经 worker 池真并发。
 */
async function main(): Promise<void> {
  // 强制离线：放在 loadEnv 之前，让 env 直接读到 mock 开启。
  process.env.MOCK_LLM = "true";
  const env = loadEnv();
  const logger = makeLogger(env.LOG_LEVEL);

  const runtime = await createRuntime(env, logger, { forceMock: true });

  banner(logger, "Demo 1 ── trajectory-checker 单 agent loop（逐轮打印）");
  const answer = await runtime.runAgent(
    "trajectory-checker",
    "统计目录 mockdata/trajectories 下缺少 reward 字段的记录数。"
  );
  logger.info({ answer }, "Demo 1 完成 ✓");

  banner(logger, "Demo 2 ── 两个 agent / 不同模型 / worker 池并发");
  const queue = new TaskQueue(
    env.WORKER_CONCURRENCY,
    async (task: Task) => {
      const out = await runtime.runAgent(task.agentName, task.input, task.taskType);
      logger.info({ agent: task.agentName, answer: out }, "并发任务完成 ✓");
    },
    logger
  );

  // trajectory-checker（critical/opus，带工具，多轮）+ memory-keeper（记忆库看门人，单轮）
  queue.enqueue(mkTask("trajectory-checker", "再统计一次 mockdata/trajectories 下缺 reward 字段的记录数。"));
  queue.enqueue(mkTask("memory-keeper", "用一句话总结：什么是 agent 中台的 context budget？"));

  await queue.drain();
  logger.info("Demo 2 完成 ✓（两个 agent 已并发跑完）");

  banner(logger, "全部 demo 跑完。把 MOCK_LLM 关掉、填上 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN 即可接真模型。");
  process.exit(0);
}

function mkTask(agentName: string, input: string): Task {
  return { id: randomUUID().slice(0, 8), agentName, input };
}

function banner(logger: ReturnType<typeof makeLogger>, text: string): void {
  logger.info("──────────────────────────────────────────────");
  logger.info(text);
  logger.info("──────────────────────────────────────────────");
}

main().catch((e) => {
  console.error("demo 失败:", e);
  process.exit(1);
});
