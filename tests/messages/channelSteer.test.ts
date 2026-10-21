import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { parseIntakeInput } from "../../src/channels/messageIntake";
import { MessageIntake } from "../../src/core/messageIntake";
import { ActiveRunInputs, type RunInput, type RunInputLease, type SteerResult } from "../../src/core/runInputs";
import { TaskQueue } from "../../src/scheduler/queue";
import type { SessionRef, Task } from "../../src/types";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), "channel lifecycle did not reach the expected state");
}
interface Turn {
  task: Task;
  lease: RunInputLease;
  accepted: string[];
  sent: string[];
  finish: ReturnType<typeof gate>;
  delivery: ReturnType<typeof gate>;
  detached: boolean;
}

/** Both the original request and supplements use the channel inbox -> TaskQueue path. */
async function channel(t: TestContext, platform = "qq") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "harbour-channel-steer-"));
  const ref: SessionRef = { id: "cs-channel-fixture", key: `${platform}:fixture:dm:owner`, channel: platform,
    actor: { role: "owner", id: "fixture-owner", platform } };
  const active = new ActiveRunInputs();
  let at = 1000, sequence = 0;
  const inbox = new MessageIntake(path.join(directory, "inbox"), active, path.join(directory, "settings.json"), () => at);
  const turns: Turn[] = [], replies: Array<{ runId: string; input: string; accepted: string[] }> = [];
  const gates: Array<ReturnType<typeof gate>> = [];
  const hold = () => { const value = gate(); gates.push(value); return value; };
  let sender = async (_input: RunInput, _turn: Turn): Promise<SteerResult> => "accepted";
  const queue = new TaskQueue(2, async task => {
    const accepted: string[] = [];
    const lease = active.register(task.sessionRef!, task.agentName, task.id, async message => { accepted.push(message.content); });
    const turn: Turn = { task, lease, accepted, sent: [], finish: hold(), delivery: hold(), detached: false };
    // A real backend supplies the native transport; the fixture only controls its receipt.
    lease.bindNative(async input => { turn.sent.push(input.text); return sender(input, turn); }, { nativeOnly: true });
    turns.push(turn);
    try {
      await turn.finish.promise;
      await active.release(task.sessionRef!, lease);
      await inbox.releaseRun(task.id, true);
      turn.detached = true;
      // Keep the interval between runtime release and channel delivery observable.
      await turn.delivery.promise;
      const output = JSON.stringify({ runId: task.id, input: task.input, accepted });
      inbox.executed(task.meta?.intakeId, output);
      await task.reply!(output);
    } finally { await active.release(task.sessionRef!, lease); }
  }, pino({ level: "silent" }));
  inbox.setRoute(platform, async (_, output) => { replies.push(JSON.parse(output)); });
  inbox.setDispatch(task => queue.submit(task));
  t.after(async () => {
    inbox.close();
    for (const value of gates) value.resolve();
    await queue.drain();
    const target = await realpath(directory);
    assert.equal(path.dirname(target).toLowerCase(), (await realpath(os.tmpdir())).toLowerCase());
    assert.match(path.basename(target), /^harbour-channel-steer-/);
    await rm(target, { recursive: true, force: true });
  });
  return { ref, inbox, active, queue, turns, replies, hold,
    setSender(value: typeof sender) { sender = value; },
    advance(ms: number) { at += ms; },
    send(raw: string, options: { immediate?: boolean; ref?: SessionRef } = {}) {
      const parsed = parseIntakeInput(raw, true);
      assert.equal(parsed.command, undefined);
      return inbox.enqueue({ id: `fixture-${++sequence}`, agentName: "main-fixture", input: parsed.input,
        sessionRef: options.ref ?? ref }, platform, { immediate: options.immediate ?? true,
        mode: parsed.mode, isolated: !!parsed.mode });
    },
    record(id: string, session = ref) { return inbox.list(session.id!).find(record => record.id === id)!; },
    async complete(turn: Turn) {
      turn.finish.resolve(); turn.delivery.resolve();
      await until(() => inbox.list(turn.task.sessionRef!.id!).find(record => record.id === turn.task.id)?.delivery === "delivered");
    },
  };
}

for (const platform of ["qq", "discord"]) {
  test(`${platform}: inbox-started root receives a debounced supplement in the same run, delivered once`, async t => {
    const h = await channel(t, platform);
    const root = h.send("original question"); await h.inbox.pump();
    assert.equal(h.turns.length, 1); assert.equal(h.record(root.id).state, "running");
    const follow = h.send("additional question", { immediate: false });
    h.advance(4000); h.send("one more detail", { immediate: false });
    h.advance(4999); await h.inbox.pump(); assert.equal(h.turns[0]!.sent.length, 0);
    h.advance(1); await h.inbox.pump(); await h.turns[0]!.lease.settleNative();
    assert.equal(h.record(follow.id).state, "accepted");
    assert.equal(h.record(follow.id).runId, root.id);
    assert.equal(h.turns[0]!.sent.length, 1);
    assert.match(h.turns[0]!.accepted[0]!, /additional question[\s\S]*one more detail/);
    await h.inbox.pump(); await h.turns[0]!.lease.settleNative();
    assert.equal(h.turns[0]!.sent.length, 1, "polling cannot duplicate native input");
    await h.complete(h.turns[0]!); await h.inbox.pump();
    assert.equal(h.turns.length, 1); assert.equal(h.replies.length, 1);
    assert.equal(h.replies[0]!.input, "original question");
    assert.equal(h.replies[0]!.accepted.length, 1);
    assert.equal(h.record(follow.id).state, "completed");
    assert.equal(h.record(follow.id).delivery, "delivered");
  });
}

test("channel root and queued next task do not block steer; unacknowledged steer retains FIFO", async t => {
  const h = await channel(t), ack = h.hold();
  h.setSender(async input => { if (input.text === "first supplement") await ack.promise; return "accepted"; });
  h.send("original"); await h.inbox.pump();
  const queued = h.send("/queue next task"), first = h.send("/steer first supplement");
  await h.inbox.pump(); await until(() => h.record(first.id).state === "sending");
  const second = h.send("/steer second supplement"); await h.inbox.pump();
  assert.deepEqual(h.turns[0]!.sent, ["first supplement"]);
  assert.equal(h.record(queued.id).state, "waiting");
  ack.resolve(); await h.turns[0]!.lease.settleNative(); await h.inbox.pump(); await h.turns[0]!.lease.settleNative();
  assert.deepEqual(h.turns[0]!.accepted, ["first supplement", "second supplement"]);
  assert.equal(h.record(second.id).state, "accepted"); assert.equal(h.turns.length, 1);
  await h.complete(h.turns[0]!);
  await until(() => h.turns.length === 2);
  assert.equal(h.turns[1]!.task.id, queued.id); assert.equal(h.turns[1]!.task.input, "next task");
  await h.complete(h.turns[1]!); assert.equal(h.replies.length, 2);
});

test("late channel input queues after seal; runtime release before reply cannot start overlapping work", async t => {
  const h = await channel(t);
  h.send("original"); await h.inbox.pump(); const turn = h.turns[0]!;
  turn.lease.seal(); const late = h.send("late supplement"); await h.inbox.pump();
  assert.equal(h.record(late.id).state, "waiting"); assert.equal(turn.sent.length, 0);
  turn.finish.resolve(); await until(() => turn.detached);
  assert.equal(h.active.isBusy(h.ref.id!), false);
  await h.inbox.pump(); assert.equal(h.turns.length, 1, "inFlight holds through the original delivery");
  await h.complete(turn); await until(() => h.turns.length === 2);
  assert.equal(h.turns[1]!.task.id, late.id);
  await h.complete(h.turns[1]!); assert.equal(h.replies.length, 2);
});

for (const receipt of ["unavailable", "unknown"] as const) {
  test(`channel native ${receipt} receipt is not falsely accepted or blindly retried`, async t => {
    const h = await channel(t); h.setSender(async () => receipt);
    h.send("original"); await h.inbox.pump();
    const follow = h.send("supplement"); await h.inbox.pump(); await h.turns[0]!.lease.settleNative();
    assert.equal(h.record(follow.id).state, receipt === "unknown" ? "unknown" : "waiting");
    assert.equal(h.turns[0]!.sent.length, 1); assert.equal(h.turns[0]!.accepted.length, 0);
    await h.inbox.pump(); await h.turns[0]!.lease.settleNative();
    assert.equal(h.turns[0]!.sent.length, 1);
    await h.complete(h.turns[0]!);
    if (receipt === "unavailable") {
      await until(() => h.turns.length === 2);
      assert.equal(h.turns[1]!.task.id, follow.id); await h.complete(h.turns[1]!);
    } else {
      await h.inbox.pump(); assert.equal(h.turns.length, 1);
      assert.equal(h.record(follow.id).state, "unknown");
      assert.throws(() => h.inbox.resume(h.ref, "main-fixture"), /结果未知/);
    }
  });
}

test("concurrent channel roots receive only their own supplements", async t => {
  const h = await channel(t);
  const other = { ...h.ref, id: "cs-other", key: "qq:other:dm:owner" };
  const a = h.send("original A"), b = h.send("original B", { ref: other }); await h.inbox.pump();
  assert.equal(h.turns.length, 2);
  const fa = h.send("supplement A"), fb = h.send("supplement B", { ref: other }); await h.inbox.pump();
  await Promise.all(h.turns.map(turn => turn.lease.settleNative()));
  assert.equal(h.record(fa.id).runId, a.id); assert.equal(h.record(fb.id, other).runId, b.id);
  assert.deepEqual(h.turns.map(turn => turn.accepted), [["supplement A"], ["supplement B"]]);
  await Promise.all(h.turns.map(turn => h.complete(turn)));
  assert.equal(h.replies.length, 2);
});
