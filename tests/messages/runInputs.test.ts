import { test } from "node:test";
import assert from "node:assert/strict";
import { RunInputLease, type RunInput, type SteerResult } from "../../src/core/runInputs";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const records: string[] = [];
  const accepted: string[] = [];
  const lease = new RunInputLease("fixture-run", "fixture-scope", async (message, id) => {
    accepted.push(id);
    assert.equal(message.content, id);
  }, () => {});
  const input = (id: string, afterRecord?: RunInput["record"]): RunInput => ({ id, text: id,
    record: async (state, runId) => {
      assert.equal(runId, "fixture-run");
      records.push(`${id}:${state}`);
      await afterRecord?.(state, runId);
    },
  });
  return { lease, input, records, accepted };
}

test("nested native delivery holds keep pending input visible and release FIFO exactly once", async () => {
  const { lease, input, records, accepted } = fixture();
  const sent: string[] = [];
  const releaseOuter = lease.holdNativeDelivery();
  lease.bindNative(async value => { sent.push(value.id); return "accepted"; }, { nativeOnly: true });
  assert.equal(lease.offer(input("first")), true);
  const releaseInner = lease.holdNativeDelivery();
  assert.equal(lease.offer(input("second")), true);
  assert.equal(lease.offer(input("second")), false);
  assert.equal(lease.revision, 2);
  assert.equal(lease.hasPending, true);
  await lease.settleNative();
  assert.deepEqual(records, [], "held inputs remain known-unsent, not sending or accepted");
  releaseOuter(); releaseOuter();
  await lease.settleNative();
  assert.deepEqual(sent, [], "an idempotent outer release cannot drop the inner hold");
  assert.equal(lease.hasPending, true);
  releaseInner(); releaseInner();
  await lease.settleNative();
  assert.deepEqual(sent, ["first", "second"]);
  assert.deepEqual(accepted, sent);
  assert.deepEqual(records, ["first:sending", "first:accepted", "second:sending", "second:accepted"]);
  assert.equal(lease.hasPending, false);
  assert.equal(lease.revision, 2, "releasing a hold is not a new user input");
  await lease.finish();
});

test("a hold acquired during durable sending record prevents native submission", async () => {
  const { lease, input, records, accepted } = fixture();
  const entered = deferred<void>();
  const persisted = deferred<void>();
  let firstWrite = true, sends = 0;
  lease.bindNative(async () => { sends++; return "accepted"; });
  lease.offer(input("supplement", async state => {
    if (state !== "sending" || !firstWrite) return;
    firstWrite = false;
    entered.resolve();
    await persisted.promise;
  }));
  await entered.promise;
  const release = lease.holdNativeDelivery();
  persisted.resolve();
  await lease.settleNative();
  assert.equal(sends, 0);
  assert.deepEqual(accepted, []);
  assert.deepEqual(records, ["supplement:sending", "supplement:waiting"]);
  assert.equal(lease.hasPending, true);
  release();
  await lease.settleNative();
  assert.equal(sends, 1);
  assert.deepEqual(accepted, ["supplement"]);
  assert.deepEqual(records, ["supplement:sending", "supplement:waiting", "supplement:sending", "supplement:accepted"]);
  await lease.finish();
});

test("native hold does not wait for an in-flight ACK and still gates the next input", async () => {
  const { lease, input, records, accepted } = fixture();
  const submitted = deferred<void>();
  const receipt = deferred<SteerResult>();
  const sent: string[] = [];
  lease.bindNative(async value => {
    sent.push(value.id);
    if (value.id === "first") { submitted.resolve(); return receipt.promise; }
    return "accepted";
  });
  lease.offer(input("first"));
  await submitted.promise;
  const release = lease.holdNativeDelivery();
  assert.equal(typeof release, "function", "hold acquisition is synchronous even without a native ACK");
  lease.offer(input("second"));
  receipt.resolve("accepted");
  await lease.settleNative();
  assert.deepEqual(sent, ["first"]);
  assert.deepEqual(accepted, ["first"], "already-submitted input is acknowledged, not retracted");
  assert.equal(lease.hasPending, true);
  assert.deepEqual(records, ["first:sending", "first:accepted"]);
  assert.equal(release(), undefined, "release is synchronous and never waits for transport settlement");
  await lease.settleNative();
  assert.deepEqual(sent, ["first", "second"]);
  await lease.finish();
});

test("release before an unknown ACK never replays input or sends the next supplement", async () => {
  const { lease, input, records, accepted } = fixture();
  const submitted = deferred<void>();
  const receipt = deferred<SteerResult>();
  const sent: string[] = [];
  lease.bindNative(async value => { sent.push(value.id); submitted.resolve(); return receipt.promise; });
  lease.offer(input("first"));
  await submitted.promise;
  const release = lease.holdNativeDelivery();
  lease.offer(input("second"));
  assert.equal(release(), undefined, "releasing must not wait for an unknown provider receipt");
  release();
  assert.deepEqual(sent, ["first"]);
  receipt.resolve("unknown");
  await lease.settleNative();
  assert.deepEqual(sent, ["first"]);
  assert.deepEqual(accepted, []);
  assert.equal(lease.hasPending, true);
  await lease.finish();
  assert.deepEqual(records, ["first:sending", "first:unknown", "second:unknown"]);
});

test("sealing and finishing while held preserve known-unsent input for the next run", async () => {
  const { lease, input, records, accepted } = fixture();
  const release = lease.holdNativeDelivery();
  let sends = 0;
  lease.offer(input("queued"));
  lease.bindNative(async () => { sends++; return "accepted"; }, { nativeOnly: true });
  await lease.finish();
  assert.deepEqual(records, ["queued:waiting"]);
  assert.deepEqual(accepted, []);
  release(); release();
  await lease.settleNative();
  assert.equal(sends, 0, "a late release cannot reopen a sealed lease");
  assert.equal(lease.offer(input("late")), false);
});

test("held delivery uses the latest sender and preserves native-unavailable FIFO", async () => {
  const { lease, input, records, accepted } = fixture();
  const release = lease.holdNativeDelivery();
  lease.bindNative(async () => { assert.fail("detached sender cannot receive the held input"); });
  lease.offer(input("image")); lease.offer(input("text"));
  const sent: string[] = [];
  lease.bindNative(async value => { sent.push(value.id); return "unavailable"; }, { nativeOnly: true });
  await lease.settleNative();
  assert.deepEqual(sent, []);
  release();
  await lease.settleNative();
  assert.deepEqual(sent, ["image"]);
  assert.deepEqual(accepted, []);
  assert.deepEqual(records, ["image:sending", "image:waiting"]);
  assert.deepEqual(await lease.drainAtBoundary(), [], "native-only input cannot bypass FIFO through a legacy drain");
  await lease.finish();
  assert.deepEqual(records, ["image:sending", "image:waiting", "image:waiting", "text:waiting"]);
});
