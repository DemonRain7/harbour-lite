import assert from "node:assert/strict";
import { test } from "node:test";
import pino from "pino";
import type { Agent, ToolContext } from "../../src/types";
import { createExecutionProgressStore } from "../../src/core/executionProgress";
import { updateProgressTool } from "../../src/core/tools/updateProgress";
import { submitPlanTool } from "../../src/core/tools/submitPlan";
import { LogBroadcaster } from "../../src/server/logBroadcaster";

function fixture() {
  const events: any[] = [];
  const logger = pino({ level: "info" }, { write: line => { events.push(JSON.parse(line)); } });
  const ctx = { agent: { name: "main-test", skills: [{ name: "research" }], workflows: [{ name: "example" }] } as Agent,
    logger, runState: new Map(), execution: { progress: createExecutionProgressStore("main-test") } } as ToolContext;
  const run = (args: Record<string, unknown>, c = ctx) => updateProgressTool.execute(args, c) as Promise<any>;
  return { events, ctx, run };
}

test("planner publishes a pending root plan; Main updates by exact id and step, not assignee", async () => {
  const f = fixture();
  const planner = { ...f.ctx, agent: { ...f.ctx.agent, name: "orchestrator" } };
  const receipt = await submitPlanTool.execute({ goal: "验证进度", steps: [{ title: "检查", agent: "worker" }, { title: "实现", agent: "worker" }] }, planner) as any;
  assert.ok(receipt.plan.id);
  const pending = f.ctx.execution!.progress!.plans.get(receipt.plan.id)!;
  assert.equal(pending.owner, "main-test");
  assert.deepEqual(pending.steps.map(s => s.status), ["pending", "pending"]);
  const updated = await f.run({ planId: receipt.plan.id, changes: [{ n: 1, status: "completed" }, { n: 2, status: "in_progress" }] });
  assert.equal(updated.completed, 1);
  assert.equal(updated.progress, undefined, "routine status deltas must not echo the full plan into model context");
  assert.ok(JSON.stringify(updated).length < 320);
  await submitPlanTool.onReplay!(receipt, {}, planner);
  assert.equal(f.ctx.execution!.progress!.plans.get(receipt.plan.id)!.revision, 2, "planner replay cannot erase execution progress");
  await assert.rejects(f.run({ planId: receipt.plan.id, changes: [{ n: 2, status: "completed" }] }, planner), /只能更新/);
});

test("local scopes are independent, require mounted capabilities, and never grant access", async () => {
  const f = fixture();
  const global = await f.run({ title: "完成研究", steps: ["调查", "交付"] });
  for (const [scope, source] of [["skill", "research"], ["workflow", "example"]]) {
    const local = await f.run({ scope, source, title: "局部步骤", steps: ["检查", "验证"] });
    await f.run({ planId: local.planId, changes: [{ n: 1, status: "completed" }] });
  }
  assert.equal(f.ctx.execution!.progress!.plans.get(global.planId)!.steps[0]!.status, "pending");
  await assert.rejects(f.run({ scope: "skill", source: "not-mounted", title: "x", steps: ["y"] }), /已挂载/);
  await assert.rejects(f.run({ scope: "root", title: "x", steps: ["y"] }), /未知/);
  await assert.rejects(f.run({ source: "example", title: "x", steps: ["y"] }), /总任务/);
  assert.equal(updateProgressTool.readOnly, true);
});

test("invalid delta is atomic; bounds prevent unbounded plan/token growth", async () => {
  const f = fixture();
  const plan = await f.run({ title: "x", steps: ["a", "b"] });
  const before = JSON.stringify(f.ctx.execution!.progress!.plans.get(plan.planId));
  for (const changes of [[{ n: 1, status: "completed" }, { n: 99, status: "completed" }], [{ n: 1, status: "completed" }, { n: 1, status: "blocked" }], [{ n: 2, status: "guess" }]]) {
    await assert.rejects(f.run({ planId: plan.planId, changes }), /未知步骤/);
    assert.equal(JSON.stringify(f.ctx.execution!.progress!.plans.get(plan.planId)), before);
  }
  await assert.rejects(f.run({ planId: "other-run", changes: [{ n: 1, status: "completed" }] }), /本轮未找到/);
  await assert.rejects(f.run({ title: "x", steps: Array(21).fill("a") }), /1–20/);
  await assert.rejects(f.run({ title: "x".repeat(161), steps: ["a"] }), /160/);
  await assert.rejects(f.run({ planId: plan.planId, title: "override", changes: [] }), /不得覆盖/);
});

test("confirmed replay reconstructs delta states idempotently in a new runtime store", async () => {
  const f = fixture(), next = fixture();
  const created = await f.run({ title: "checkpoint", steps: ["one", "two"] });
  const changed = await f.run({ planId: created.planId, changes: [{ n: 1, status: "completed" }, { n: 2, status: "blocked" }] });
  await updateProgressTool.onReplay!(created, {}, next.ctx);
  await updateProgressTool.onReplay!(changed, {}, next.ctx);
  await updateProgressTool.onReplay!(created, {}, next.ctx);
  await updateProgressTool.onReplay!(changed, {}, next.ctx);
  assert.deepEqual(next.ctx.execution!.progress!.plans.get(created.planId), f.ctx.execution!.progress!.plans.get(created.planId));
  assert.equal(next.events.length, 2);
  assert.equal(f.events.at(-1).msg, "progress:updated");
});

test("long-run trace and reconnect retain current Todo, parallel loop identities and outcomes", () => {
  const broadcaster = new LogBroadcaster(8);
  broadcaster.beginRunTrace("r");
  broadcaster.pushEvent({ __harbour: "channel-activity", phase: "running", runId: "r" });
  const write = (event: object) => broadcaster.write(JSON.stringify({ runId: "r", agent: "main-test", ...event }));
  write({ msg: "loop:start", traceId: "root", time: 1 });
  write({ msg: "loop:start", traceId: "child-1", parentTraceId: "root", agent: "worker", time: 2 });
  write({ msg: "loop:start", traceId: "child-2", parentTraceId: "root", agent: "worker", time: 3 });
  write({ msg: "progress:updated", progress: { id: "p", revision: 1, steps: [] }, time: 4 });
  write({ msg: "progress:updated", progress: { id: "p", revision: 2, steps: [] }, time: 5 });
  for (let i = 0; i < 460; i++) write({ msg: "loop:thinking", preview: `log ${i}`, time: i + 10 });
  write({ msg: "loop:end", traceId: "child-1", parentTraceId: "root", agent: "worker", status: "failed", time: 500 });
  const sent: any[] = [];
  broadcaster.addClient({ send: (line: string) => sent.push(JSON.parse(line)), on() {} } as never);
  assert.ok(sent.some(e => e.progress?.revision === 2 && e.runId === "r"));
  assert.ok(sent.some(e => e.traceId === "child-2" && e.parentTraceId === "root"));
  const trace = broadcaster.finishRunTrace("r");
  assert.equal(trace.length, 400);
  assert.equal(trace.filter(e => e.msg === "progress:updated").length, 1);
  assert.equal(trace.at(-1)!.status, "failed");
  assert.ok(trace.some(e => e.traceId === "root" && e.msg === "loop:start"));
});
