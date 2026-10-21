"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { RemoteTtsClient } = require("../companion/remote-tts-client");

test("closing one pet cancels its status/synthesis, without cancelling another pet or a settings probe", async t => {
  const signals = [], resolveResponse = [];
  t.mock.method(globalThis, "fetch", (_url, { signal }) => {
    signals.push(signal);
    return new Promise((resolve, reject) => {
      resolveResponse.push(resolve);
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });
  const client = new RemoteTtsClient({ baseUrl: "http://fixture.invalid" });
  const jobs = [client.status("elaina:status-1"), client.synthesize("elaina:speech-1", {}),
    client.status("aemeath:status-1"), client.synthesize("aemeath:speech-1", {}), client.status()];
  const settled = Promise.allSettled(jobs);
  assert.equal(client.cancelPrefix("elaina:"), 2);
  assert.deepEqual(signals.map(signal => signal.aborted), [true, true, false, false, false]);
  client.cancelAll();
  // Unowned settings status retains its existing independent timeout/cancellation behavior.
  resolveResponse[4](new Response(JSON.stringify({ configured: true })));
  await settled;
  assert.equal(client.abortControllers.size, 0);
});

test("late completion of a closed pet request cannot deregister a reopened pet's request", async t => {
  const signals = [];
  t.mock.method(globalThis, "fetch", (_url, { signal }) => {
    signals.push(signal);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  });
  const client = new RemoteTtsClient({ baseUrl: "http://fixture.invalid" });
  for (const kind of ["status", "synthesize"]) {
    const id = `elaina:${kind}`;
    const original = client[kind](id, {}).catch(() => null);
    client.cancelPrefix("elaina:");
    const reopened = client[kind](id, {}).catch(() => null);
    await original; // Its finally runs after the new controller has been registered.
    assert.equal(client.abortControllers.has(id), true);
    assert.equal(client.cancelPrefix("elaina:"), 1);
    await reopened;
  }
  assert.equal(signals.every(signal => signal.aborted), true);
  assert.equal(client.abortControllers.size, 0);
});
