import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageIntake, PendingInputConflict } from "../../src/core/messageIntake";
import { ActiveRunInputs } from "../../src/core/runInputs";
import type { SessionRef, Task } from "../../src/types";

const ref: SessionRef = { id: "edit-session", key: "web:edit", channel: "web", actor: { role: "owner", id: "rain", platform: "web" } };
const agent = "main-test";
const task = (id: string, input = id): Task => ({ id, input, agentName: agent, sessionRef: ref });
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-pending-edit-"));
  const active = new ActiveRunInputs();
  const inbox = new MessageIntake(path.join(directory, "inbox"), active, path.join(directory, "settings.json"), () => 1000);
  t.after(() => { inbox.close(); assert.equal(path.dirname(directory), os.tmpdir()); fs.rmSync(directory, { recursive: true, force: true }); });
  return { inbox, active, directory };
}
test("withdraw persists a tombstone with text/images, exact retry is idempotent, old POST cannot resurrect it", async t => {
  const { inbox, active, directory } = fixture(t), release = active.reserve(ref.id!);
  let settled = 0, calls = 0;
  const original = { ...task("original", "Look at the square image"), onSettled: () => settled++, attachments: [{ kind: "image" as const, url: "/uploads/test.png", name: "test.png" }] };
  const record = inbox.enqueue(original, "web", { immediate: true, mode: "queue", messageId: "stable-original" });
  await inbox.pump();
  const revision = inbox.pendingControls(ref, agent, record.id).revision;
  assert.equal(inbox.pendingControls(ref, agent, record.id).canWithdraw, true);
  const observed: string[] = []; const off = inbox.onChange(() => { observed.push(inbox.list(ref.id!)[0]!.state); });
  const withdrawn = inbox.changePending(ref, agent, record.id, "withdraw", revision);
  off(); assert.deepEqual(observed, ["withdrawn"], "subscribers see the committed replacement, not the old pending record");
  assert.equal(withdrawn.state, "withdrawn"); assert.equal(withdrawn.archived, true);
  assert.equal(withdrawn.messages[0]!.input, original.input); assert.deepEqual(withdrawn.messages[0]!.attachments, original.attachments);
  assert.deepEqual(inbox.changePending(ref, agent, record.id, "withdraw", revision), withdrawn); assert.equal(settled, 1);
  assert.equal(inbox.enqueue(original, "web", { mode: "queue", messageId: "stable-original" }).state, "withdrawn");
  assert.deepEqual(inbox.list(ref.id!, true), []); release(); inbox.close();
  const restored = new MessageIntake(path.join(directory, "inbox"), new ActiveRunInputs(), path.join(directory, "settings.json"));
  t.after(() => restored.close()); restored.setRoute("web", async () => {});
  restored.setDispatch(async next => { calls++; restored.executed(next.meta?.intakeId, "done"); await next.reply!("done"); });
  assert.equal(restored.changePending(ref, agent, record.id, "withdraw", revision).state, "withdrawn");
  await restored.pump(); assert.equal(calls, 0);
  restored.enqueue({ ...task("edited", "Revised image request"), attachments: original.attachments }, "web", { mode: "queue", immediate: true, messageId: "new-edit-id" });
  await restored.pump(); await tick(); assert.equal(calls, 1);
});
test("queue to steer changes only this input, keeps original POST dedup and uses the existing root", async t => {
  const { inbox, active } = fixture(t), accepted: string[] = [];
  const lease = active.register(ref, agent, "root", async m => { accepted.push(m.content); });
  lease.bindNative(async () => "accepted");
  inbox.setMode(ref, agent, "queue");
  const record = inbox.enqueue(task("one", "Updated requirement"), "web", { mode: "queue", immediate: true, messageId: "one-key" });
  await inbox.pump(); const controls = inbox.pendingControls(ref, agent, record.id);
  assert.equal(controls.canSteer, true); inbox.changePending(ref, agent, record.id, "steer", controls.revision);
  assert.equal(inbox.mode(ref, agent), "queue");
  assert.equal(inbox.enqueue(task("one", "Updated requirement"), "web", { mode: "queue", messageId: "one-key" }).id, record.id);
  await inbox.pump(); await tick();
  assert.deepEqual(accepted, ["Updated requirement"]);
  assert.equal(inbox.changePending(ref, agent, record.id, "steer", controls.revision).state, "accepted");
  assert.equal(inbox.pendingControls(ref, agent, record.id).canWithdraw, false);
  assert.throws(() => inbox.changePending(ref, agent, record.id, "withdraw", inbox.list(ref.id!)[0]!.revision!), PendingInputConflict);
  await active.release(ref, lease);
});
test("CAS is not a timestamp: same-millisecond batch growth/mode change and foreign scopes are rejected", t => {
  const { inbox } = fixture(t);
  const original = inbox.enqueue(task("first"), "web", { mode: "queue" });
  inbox.enqueue(task("second"), "web", { mode: "queue" });
  assert.equal(inbox.list(ref.id!)[0]!.messages.length, 2);
  assert.throws(() => inbox.changePending(ref, agent, original.id, "withdraw", original.revision!), PendingInputConflict);
  const revision = inbox.pendingControls(ref, agent, original.id).revision;
  for (const other of [{ ...ref, id: "elsewhere" }, { ...ref, actor: { ...ref.actor!, id: "other" } }]) {
    assert.equal(inbox.pendingControls(other, agent, original.id).canWithdraw, false);
    assert.throws(() => inbox.changePending(other, agent, original.id, "withdraw", revision), PendingInputConflict);
  }
  assert.throws(() => inbox.changePending(ref, "other-agent", original.id, "withdraw", revision), PendingInputConflict);
  inbox.changePending(ref, agent, original.id, "steer", revision);
  assert.throws(() => inbox.changePending(ref, agent, original.id, "withdraw", revision), PendingInputConflict);
});
test("an input still owned by a native lease cannot be withdrawn, even after unavailable restored waiting", async t => {
  const { inbox, active } = fixture(t);
  const lease = active.register(ref, agent, "root", async () => assert.fail("not accepted"));
  const releaseHold = lease.holdNativeDelivery(); lease.bindNative(async () => "unavailable");
  const record = inbox.enqueue(task("supplement"), "web", { immediate: true }); await inbox.pump();
  assert.equal(inbox.list(ref.id!)[0]!.state, "waiting");
  assert.equal(inbox.pendingControls(ref, agent, record.id).canWithdraw, false);
  releaseHold(); await lease.settleNative();
  const waiting = inbox.list(ref.id!)[0]!; assert.equal(waiting.state, "waiting");
  assert.equal(inbox.pendingControls(ref, agent, record.id).canWithdraw, false, "offered-set removal is NOT proof the lease released it");
  assert.throws(() => inbox.changePending(ref, agent, record.id, "withdraw", waiting.revision!), PendingInputConflict);
  await active.release(ref, lease);
  const ready = inbox.pendingControls(ref, agent, record.id); assert.equal(ready.canWithdraw, true);
  inbox.changePending(ref, agent, record.id, "withdraw", ready.revision); await inbox.pump();
  assert.deepEqual(inbox.list(ref.id!, true), []);
});
test("running, sending, unknown and completed records are never retractable", async t => {
  for (const response of ["accepted", "unknown"] as const) {
    const { inbox, active } = fixture(t); let complete!: (result: typeof response) => void;
    const lease = active.register(ref, agent, "root", async () => {});
    lease.bindNative(() => new Promise(resolve => { complete = resolve; }));
    const record = inbox.enqueue(task(response), "web", { immediate: true }); await inbox.pump(); await tick();
    let current = inbox.list(ref.id!)[0]!; assert.equal(current.state, "sending");
    assert.throws(() => inbox.changePending(ref, agent, record.id, "withdraw", current.revision!), PendingInputConflict);
    complete(response); await lease.settleNative(); current = inbox.list(ref.id!)[0]!;
    assert.throws(() => inbox.changePending(ref, agent, record.id, "withdraw", current.revision!), PendingInputConflict);
    await active.release(ref, lease);
  }
  const { inbox } = fixture(t); let finish!: () => void;
  inbox.setRoute("web", async () => {}); inbox.setDispatch(() => new Promise<void>(resolve => { finish = resolve; }));
  const record = inbox.enqueue(task("running"), "web", { immediate: true }); await inbox.pump();
  assert.throws(() => inbox.changePending(ref, agent, record.id, "withdraw", inbox.list(ref.id!)[0]!.revision!), PendingInputConflict);
  inbox.executed(record.id, "saved answer"); finish(); await tick();
  assert.equal(inbox.pendingControls(ref, agent, record.id).canWithdraw, false);
});
test("paused work can be withdrawn without resuming anything; failed persistence leaves the queue intact", t => {
  const { inbox } = fixture(t); const record = inbox.enqueue(task("paused"), "web", { mode: "queue" }); inbox.pause(ref, agent);
  const controls = inbox.pendingControls(ref, agent, record.id);
  assert.equal(controls.canWithdraw, true); assert.equal(controls.canSteer, false);
  assert.throws(() => inbox.changePending(ref, agent, record.id, "steer", controls.revision), PendingInputConflict);
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error("fixture disk failure"); };
    assert.throws(() => inbox.changePending(ref, agent, record.id, "withdraw", controls.revision), /fixture disk failure/);
  } finally { fs.renameSync = rename; }
  assert.equal(inbox.list(ref.id!)[0]!.state, "paused");
  assert.equal(inbox.pendingControls(ref, agent, record.id).revision, controls.revision);
  inbox.changePending(ref, agent, record.id, "withdraw", controls.revision);
});
