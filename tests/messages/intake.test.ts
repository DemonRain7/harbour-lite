import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { ActiveRunInputs, RunInputLease } from "../../src/core/runInputs";
import { MessageIntake } from "../../src/core/messageIntake";
import { OrderedIngress, handleIntakeCommand } from "../../src/channels/messageIntake";
import { TaskQueue } from "../../src/scheduler/queue";
import type { SessionRef, Task } from "../../src/types";
import { sendOutgoingSegments } from "../../src/channels/outgoing";
import { GoalScheduler } from "../../src/core/goalScheduler";
import { SessionStore } from "../../src/core/sessionStore";

const ref: SessionRef = { id: "cs-test", key: "qq:a:dm:rain", channel: "qq", actor: { role: "owner", id: "rain", platform: "qq" } };
const task = (id: string, input = id, sessionRef = ref): Task => ({ id, agentName: "main-test", input, sessionRef, meta: { target: "reply" } });
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function fixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "harbour-intake-"));
  const active = new ActiveRunInputs(); let at = 1000;
  const inbox = new MessageIntake(path.join(directory, "inbox"), active, path.join(directory, "settings.json"), () => at);
  t.after(async () => { inbox.close(); await rm(directory, { recursive: true, force: true }); });
  return { inbox, active, directory, advance(ms: number) { at += ms; } };
}

test("burst text + image keeps order, resets debounce, one execution and one reply", async t => {
  const { inbox, advance } = await fixture(t); const dispatched: Task[] = []; const replies: string[] = [];
  inbox.setRoute("qq", async (_, output) => { replies.push(output); });
  inbox.setDispatch(async value => { dispatched.push(value); inbox.executed(value.meta?.intakeId, "result"); await value.reply!("result"); });
  const first = inbox.enqueue(task("1", "比较构图"), "qq"); advance(1000);
  inbox.enqueue({ ...task("2", "图一"), attachments: [{ kind: "image", url: "/uploads/a.png", name: "一.png" }] }, "qq");
  advance(2000); inbox.enqueue(task("3", "主要看颜色"), "qq");
  await inbox.pump(); assert.equal(dispatched.length, 0);
  advance(8001); await inbox.pump(); await tick();
  assert.equal(dispatched.length, 1); assert.match(dispatched[0]!.input, /比较构图[\s\S]*一.png[\s\S]*主要看颜色/);
  assert.equal(dispatched[0]!.attachments!.length, 1); assert.deepEqual(replies, ["result"]);
  assert.equal(inbox.list(ref.id!)[0]!.id, first.id);
});
test("dedup, caller isolation, explicit collect and durable pending restart", async t => {
  const { inbox, directory, advance } = await fixture(t);
  inbox.collect(ref, "main-test", true);
  inbox.enqueue(task("1"), "qq", { messageId: "platform-1" });
  inbox.enqueue(task("2", "1"), "qq", { messageId: "platform-1" });
  assert.equal(inbox.list(ref.id!)[0]!.messages.length, 1);
  advance(60000); inbox.close();
  const restored = new MessageIntake(path.join(directory, "inbox"), new ActiveRunInputs(), path.join(directory, "settings.json"));
  t.after(() => restored.close()); let count = 0;
  restored.setRoute("qq", async () => {}); restored.setDispatch(async value => { count++; restored.executed(value.meta?.intakeId, "ok"); await value.reply!("ok"); });
  await restored.pump(); assert.equal(count, 0);
  restored.collect(ref, "main-test", false); await restored.pump(); await tick(); assert.equal(count, 1);
});
test("native acceptance is not a second run; late input safely queues after seal", async t => {
  const { inbox, active } = await fixture(t); const accepted: string[] = []; let sends = 0;
  const lease = active.register(ref, "main-test", "root-run", async value => { accepted.push(value.content); });
  lease.bindNative(async () => { sends++; return "accepted"; });
  inbox.enqueue(task("follow-up", "补充一点"), "qq", { immediate: true }); await inbox.pump(); await tick();
  assert.equal(sends, 1); assert.deepEqual(accepted, ["补充一点"]);
  assert.equal(inbox.list(ref.id!)[0]!.state, "accepted");
  lease.seal(); inbox.enqueue(task("late", "晚到"), "qq", { immediate: true }); await inbox.pump();
  assert.equal(inbox.list(ref.id!).at(-1)!.state, "waiting");
  await active.release(ref, lease); await inbox.releaseRun("root-run", true);
});
test("unknown native receipt never falls back/replays; foreign actor cannot steer", async t => {
  const { inbox, active } = await fixture(t); let sends = 0;
  const lease = active.register(ref, "main-test", "run", async () => { assert.fail("no confirmed acceptance"); });
  lease.bindNative(async () => { sends++; return "unknown"; });
  assert.equal(active.offer({ ...ref, actor: { role: "other", id: "attacker", platform: "qq" } }, "main-test",
    { id: "foreign", text: "bad", record: async () => {} }), false);
  inbox.enqueue(task("1"), "qq", { immediate: true }); await inbox.pump(); await tick();
  await inbox.pump(); assert.equal(sends, 1); assert.equal(inbox.list(ref.id!)[0]!.state, "unknown");
  assert.deepEqual(await lease.drainAtBoundary(), []); await active.release(ref, lease);
});
test("legacy non-native boundary receives text, not image placeholders; pending images queue", async () => {
  const accepted: string[] = []; const states: string[] = [];
  const lease = new RunInputLease("run", "scope", async value => { accepted.push(value.content); }, () => {});
  lease.offer({ id: "text", text: "新条件", record: async state => { states.push(state); } });
  lease.offer({ id: "image", text: "看这张", attachments: [{ kind: "image", url: "/uploads/a.png" }], record: async state => { states.push(`image:${state}`); } });
  assert.equal(accepted.length, 0); assert.equal((await lease.drainAtBoundary()).length, 1);
  await lease.finish(); assert.deepEqual(accepted, ["新条件"]); assert.ok(states.includes("image:waiting"));
});
test("finished output survives failed transport without running again", async t => {
  const { inbox, directory } = await fixture(t); let calls = 0;
  inbox.setRoute("qq", async () => { throw new Error("timeout after send"); });
  inbox.setDispatch(async value => { calls++; inbox.executed(value.meta?.intakeId, "saved result"); await value.reply!("saved result"); });
  inbox.enqueue(task("1"), "qq", { immediate: true }); await inbox.pump(); await tick();
  assert.equal(inbox.list(ref.id!)[0]!.delivery, "unknown"); inbox.close();
  const restored = new MessageIntake(path.join(directory, "inbox"), new ActiveRunInputs(), path.join(directory, "settings.json"));
  t.after(() => restored.close()); restored.setRoute("qq", async () => {}); restored.setDispatch(async () => { calls++; });
  await restored.pump(); assert.equal(calls, 1); assert.equal(restored.list(ref.id!)[0]!.output, "saved result");
});
test("stop holds pending; new explicit message works, resume cannot replay unknown", async t => {
  const { inbox } = await fixture(t);
  inbox.enqueue(task("one"), "qq"); inbox.pause(ref, "main-test");
  assert.equal(inbox.list(ref.id!)[0]!.state, "paused");
  inbox.enqueue(task("two", "继续"), "qq", { immediate: true });
  let calls = 0; inbox.setRoute("qq", async () => {});
  inbox.setDispatch(async value => { calls++; inbox.executed(value.meta?.intakeId, "ok"); await value.reply!("ok"); });
  await inbox.pump(); await tick(); assert.equal(calls, 1);
  assert.equal(inbox.list(ref.id!)[0]!.state, "paused");
});
test("preparation FIFO, failure unblocks, same-session waiting does not starve others", async () => {
  const ordered = new OrderedIngress(); const order: string[] = [];
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const a = ordered.run("a", async () => { await gate; order.push("a"); });
  const b = ordered.run("a", async () => { order.push("b"); });
  await ordered.run("other", async () => { order.push("other"); }); release(); await Promise.all([a, b]);
  assert.deepEqual(order, ["other", "a", "b"]);
  const work: string[] = []; let unlock!: () => void;
  const queued = new TaskQueue(2, async t => { work.push(t.id); if (t.id === "a") await new Promise<void>(r => { unlock = r; }); }, pino({ level: "silent" }));
  const pa = queued.submit(task("a")); const pb = queued.submit(task("b"));
  await queued.submit(task("other", "other", { ...ref, id: "other" }));
  assert.deepEqual(work, ["a", "other"]); unlock(); await Promise.all([pa, pb]); assert.equal(work.at(-1), "b");
});
test("control identity, capacity and settings validation", async t => {
  const { inbox } = await fixture(t);
  assert.match(handleIntakeCommand("/steer", inbox, { ...ref, actor: { role: "other", id: "no", platform: "qq" } }, "main-test", () => {}), /主人/);
  inbox.configure({ maxPendingPerSession: 1 }); inbox.enqueue(task("1"), "qq");
  assert.throws(() => inbox.enqueue(task("2"), "qq"), /容量/);
  assert.throws(() => inbox.configure({ textDelayMs: -1 }), /范围/);
});

test("slow attachment admission prevents early flush, and dashboard stop covers preparation", async t => {
  const { inbox, advance } = await fixture(t); let count = 0;
  inbox.setRoute("qq", async () => {});
  inbox.setDispatch(async value => { count++; inbox.executed(value.meta?.intakeId, "ok"); await value.reply!("ok"); });
  const preparing = inbox.beginPreparation(ref.key);
  inbox.enqueue(task("text-before-image"), "qq"); advance(30001);
  await inbox.pump(); assert.equal(count, 0);
  inbox.pause(ref, "main-test"); assert.equal(preparing.wasStopped(), true);
  inbox.enqueue(task("late-image"), "qq", { paused: preparing.wasStopped() }); preparing.release();
  await inbox.pump(); assert.equal(count, 0);
  inbox.resume(ref, "main-test"); await inbox.pump(); await tick(); await inbox.pump(); await tick();
  assert.equal(count, 2);
});

test("segment resend skips confirmed media; acknowledgement is archival, not invented success", async t => {
  const { inbox } = await fixture(t); const calls: string[] = []; let fail = true;
  const output = "first ![one](/uploads/one.png)\nsecond ![two](/uploads/two.png)";
  inbox.setRoute("qq", (value, text) => sendOutgoingSegments(text, async segment => {
    calls.push(segment); if (segment.includes("second") && fail) throw new Error("ack lost");
  }, inbox.segmentHooks(value.meta?.intakeId)));
  inbox.setDispatch(async value => { inbox.executed(value.meta?.intakeId, output); await value.reply!(output); });
  const record = inbox.enqueue(task("segments"), "qq", { immediate: true }); await inbox.pump(); await tick();
  await assert.rejects(inbox.resend(ref, "main-test", record.id), /可能已经送达/);
  fail = false; await inbox.resend(ref, "main-test", record.id, true);
  assert.deepEqual(calls, ["first", "second", "second"]);
  const bad = inbox.enqueue(task("unhandled"), "unconnected", { immediate: true });
  inbox.pause(ref, "main-test"); inbox.acknowledge(ref, "main-test", bad.id);
  const archived = inbox.list(ref.id!).find(r => r.id === bad.id)!;
  assert.equal(archived.archived, true); assert.equal(archived.state, "paused"); assert.equal(archived.delivery, undefined);
  assert.equal(handleIntakeCommand('/pending', inbox, ref, 'main-test', () => {}), '没有待处理消息。');
});

test("corrupt receipt pauses automation without deleting originals or taking down the server", async t => {
  const { inbox, directory } = await fixture(t);
  inbox.close();
  const file = path.join(directory, 'inbox', 'aabbccdd-0011.json');
  await writeFile(file, '{interrupted-write');
  const restored = new MessageIntake(path.join(directory, 'inbox'), new ActiveRunInputs(), path.join(directory, 'settings.json'));
  t.after(() => restored.close());
  assert.match(restored.recoveryError!, /无法读取/);
  assert.equal(restored.blocksAutomatic(ref.id!, ref.key), true);
  assert.throws(() => restored.enqueue(task('new'), 'qq'), /自动投递已暂停/);
  await restored.pump();
  assert.equal(await readFile(file, 'utf8'), '{interrupted-write');
});

test("pending user input wins over GOAL, including arrival at the final dispatch boundary", async t => {
  const { directory } = await fixture(t);
  const logger = pino({ level: 'silent' });
  const store = new SessionStore(logger, path.join(directory, 'sessions'), 'main-test'); await store.init();
  const session = store.create('web:input-goal', { channel: 'web', agentName: 'main-test' });
  const goal = store.startGoal(session, 'Fixture only', { autoContinue: true, nextStep: { action: 'Next bounded step' } });
  store.bindGoalSource(session, goal.id, { channel: 'web', key: session.key, actor: { role: 'owner', platform: 'web', id: 'fixture' } });
  let pending = true, runs = 0, startEvents = 0;
  const scheduler = new GoalScheduler(store, { sessions: () => [session], logger, hasPendingInput: () => pending,
    run: async (current, goalId, revision, runId) => {
      runs++; store.beginGoalRun(current, { goalId, runId, automatic: true, scheduleRevision: revision });
      store.setGoalStatus(current, 'cancelled'); return 'done';
    } });
  t.after(async () => { scheduler.stop(); await store.flush(); });
  scheduler.subscribe(event => { if (event.type === 'goal:start' && ++startEvents === 1) pending = true; });
  scheduler.start(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(runs, 0); assert.equal(startEvents, 0, 'collecting input prevents even scheduling');
  pending = false; scheduler.nudge(session.id);
  for (let i = 0; i < 100 && startEvents === 0; i++) await tick();
  assert.equal(startEvents, 1); await tick(); assert.equal(runs, 0, 'input arriving in awaited start listener invalidates the ticket');
  pending = false; scheduler.nudge(session.id);
  for (let i = 0; i < 100 && runs === 0; i++) await tick();
  assert.equal(runs, 1); assert.equal(startEvents, 2);
});
