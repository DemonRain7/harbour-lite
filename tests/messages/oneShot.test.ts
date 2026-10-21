import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseIntakeInput, handleIntakeCommand, OrderedIngress } from "../../src/channels/messageIntake";
import { MessageIntake } from "../../src/core/messageIntake";
import { ActiveRunInputs } from "../../src/core/runInputs";
import type { SessionRef, Task } from "../../src/types";

const ref: SessionRef = { id: "cs-once", key: "qq:fixture:dm:owner", channel: "qq", actor: { role: "owner", platform: "qq", id: "owner" } };
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
async function fixture(t: any) {
  const root = await mkdtemp(path.join(os.tmpdir(), "harbour-one-shot-"));
  const active = new ActiveRunInputs();
  const intake = new MessageIntake(path.join(root, "inbox"), active, path.join(root, "settings.json"), () => 1000);
  intake.configure({ textDelayMs: 5000 });
  t.after(async () => { intake.close(); assert.ok(path.basename(root).startsWith("harbour-one-shot-")); await rm(root, { recursive: true, force: true }); });
  function send(id: string, raw: string, images = false) {
    const parsed = parseIntakeInput(raw, true, images);
    assert.equal(parsed.command, undefined);
    return intake.enqueue({ id, agentName: "main-test", input: parsed.input, sessionRef: ref,
      ...(images ? { attachments: [{ kind: "image", url: "/uploads/fixture.png" }] } : {}) }, "qq",
    { mode: parsed.mode, isolated: !!parsed.mode, messageId: id });
  }
  return { root, active, intake, send };
}

test("one-shot grammar preserves multiline bodies and attachments, does not execute nested/quoted commands", () => {
  assert.deepEqual(parseIntakeInput("  /QuEuE\n第一项  保留空格\n第二项", true), { input: "第一项  保留空格\n第二项", mode: "queue" });
  assert.deepEqual(parseIntakeInput("/steer /stop", true), { input: "/stop", mode: "steer" });
  assert.deepEqual(parseIntakeInput("/queue", true, true), { input: "", mode: "queue" });
  for (const text of ["/queue", "/steer  \n", "/collect", "/pending resume", "/stop"]) {
    assert.equal(parseIntakeInput(text, true).command, text);
  }
  for (const text of ["解释 /queue 用法", "`/queue task`", "> /queue task", "```\n/steer task\n```", "/queueing hi"]) {
    assert.deepEqual(parseIntakeInput(text, true), { input: text });
  }
  assert.equal(parseIntakeInput("/steer do this", false, true).command, "/steer do this");
});

test("bare modes persist; one-shot modes never change defaults or absorb neighboring messages", async t => {
  const { intake, send } = await fixture(t);
  intake.collect(ref, "main-test", true);
  handleIntakeCommand("/queue", intake, ref, "main-test", () => assert.fail("not stop"));
  assert.equal(intake.mode(ref, "main-test"), "queue");
  const a = send("a", "ordinary before");
  const b = send("b", "/queue isolated in same mode");
  const c = send("c", "ordinary after");
  const d = send("d", "/steer add now");
  const e = send("e", "/queue", true);
  assert.equal(new Set([a.id, b.id, c.id, d.id, e.id]).size, 5);
  assert.equal(intake.mode(ref, "main-test"), "queue");
  assert.equal(b.dueAt - b.createdAt, 5000, "one-shot does not bypass merge delay/collection");
  assert.equal(e.dueAt - e.createdAt, 8000);
  assert.equal(e.messages[0]!.attachments?.length, 1);
  assert.equal(send("d", "/steer add now").id, d.id, "same delivery ID is idempotent");
  assert.throws(() => send("d", "/queue add now"), /不同投递方式/);
  assert.throws(() => handleIntakeCommand("/queue not lost", intake, ref, "main-test", () => {}), /收件箱/);
  assert.match(handleIntakeCommand("/steer malicious", intake, { ...ref, actor: { ...ref.actor!, role: "other" } }, "main-test", () => {}), /主人/);
  assert.equal(intake.mode(ref, "main-test"), "queue");
  assert.match(handleIntakeCommand("/pending", intake, ref, "main-test", () => {}), /补充（仅本条）/);
});

test("same-millisecond one-shot admission retains FIFO, mode, and collection across restart", async t => {
  const { intake, root, send } = await fixture(t);
  intake.collect(ref, "main-test", true);
  const expected: string[] = [];
  for (let i = 0; i < 12; i++) expected.push(send(`m${i}`, `${i % 2 ? '/queue' : '/steer'} text-${i}`).id);
  intake.close();
  const restored = new MessageIntake(path.join(root, "inbox"), new ActiveRunInputs(), path.join(root, "settings.json"));
  t.after(() => restored.close());
  const saved = restored.list(ref.id!);
  assert.deepEqual(saved.map(r => r.id), expected);
  assert.ok(saved.every(r => r.hold && r.isolated && r.messages.length === 1));
  assert.deepEqual(saved.map(r => r.mode), Array.from({ length: 12 }, (_, i) => i % 2 ? "queue" : "steer"));
  const runs: string[] = [];
  restored.setRoute("qq", async () => {});
  restored.setDispatch(async task => { runs.push(task.id); restored.executed(task.meta?.intakeId, "ok"); await task.reply!("ok"); });
  await restored.pump(); assert.equal(runs.length, 0);
  restored.collect(ref, "main-test", false);
  for (let i = 0; i < 12; i++) { await restored.pump(); await tick(); }
  assert.deepEqual(runs, expected);
  assert.equal(restored.mode(ref, "main-test"), "steer");
});

test("one-shot queue never steers an active run; one-shot steer uses the same native lease", async t => {
  const { intake, active, send } = await fixture(t);
  let native = 0;
  const lease = active.register(ref, "main-test", "active", async () => {});
  lease.bindNative(async () => { native++; return "accepted"; });
  t.after(() => active.release(ref, lease));
  const first = send("steer", "/steer supplement");
  intake.collect(ref, "main-test", false); await intake.pump(); await tick();
  assert.equal(native, 1); assert.equal(intake.list(ref.id!)[0]!.state, "accepted");
  const queued = send("queue", "/queue next job");
  intake.collect(ref, "main-test", false); await intake.pump(); await tick();
  assert.equal(native, 1); assert.equal(intake.list(ref.id!).find(r => r.id === queued.id)!.state, "waiting");
  assert.notEqual(first.id, queued.id); assert.equal(intake.mode(ref, "main-test"), "steer");
  const late = send("steer-after-queue", "/steer one more supplement to the current task");
  intake.collect(ref, "main-test", false); await intake.pump(); await tick();
  assert.equal(native, 2, "a task explicitly queued for later cannot block a supplement to the current run");
  assert.equal(intake.list(ref.id!).find(r => r.id === late.id)!.state, "accepted");
  assert.equal(intake.list(ref.id!).find(r => r.id === queued.id)!.state, "waiting");
});

test("legacy records remain before sequenced records after clock rollback", async t => {
  const { intake, root, send } = await fixture(t);
  intake.collect(ref, "main-test", true);
  const expected = Array.from({ length: 4 }, (_, i) => send(`legacy-${i}`, `/queue item-${i}`));
  intake.close();
  for (let i = 0; i < 2; i++) {
    const record = expected[i]!;
    delete record.sequence;
    record.createdAt = 5000 + i;
    await writeFile(path.join(root, "inbox", `${record.id}.json`), JSON.stringify(record));
  }
  const restored = new MessageIntake(path.join(root, "inbox"), new ActiveRunInputs(), path.join(root, "settings.json"));
  t.after(() => restored.close());
  assert.deepEqual(restored.list(ref.id!).map(record => record.id), expected.map(record => record.id));
});

test("one-shot parsing happens before channel speech preparation, which stays serialized", async () => {
  const index = await readFile("src/index.ts", "utf8");
  assert.equal(index.split('parseIntakeInput(msg.text, actor.role === "owner", !!msg.attachments?.length)').length - 1, 2);
  assert.equal(index.split('prepareIncomingSpeech({ ...msg, text: intakeInput.input }').length - 1, 2);
  assert.equal(index.split('mode: intakeInput.mode, isolated: !!intakeInput.mode').length - 1, 2);
  const ordered = new OrderedIngress(); const values: string[] = []; let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const prepare = (raw: string, wait = false) => {
    const parsed = parseIntakeInput(raw, true);
    return ordered.run("same-session", async () => { if (wait) await gate; values.push(parsed.input); });
  };
  const a = prepare("/queue image task", true), b = prepare("/steer text task");
  release(); await Promise.all([a, b]); assert.deepEqual(values, ["image task", "text task"]);
});
