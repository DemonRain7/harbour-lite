import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import pino from "pino";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Agent, CompletionRequest, Message } from "../../src/types";
import { ClaudeAgentSdkBackend } from "../../src/core/backends/claudeAgentSdk";
import { RunInputLease, NativeInputDeliveryError } from "../../src/core/runInputs";
import { Router } from "../../src/core/router";

const logger = pino({ level: "silent" });
type Sdk = Awaited<ReturnType<NonNullable<ConstructorParameters<typeof ClaudeAgentSdkBackend>[0]["loadSdk"]>>>;
const agent: Agent = { name: "main-fixture", systemPrompt: "test", taskType: "test", tools: [], contextBudget: "auto" };
const assistant = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }],
  stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } } });
const done = (result = "NEW_DONE") => ({ type: "result", subtype: "success", result, usage: { input_tokens: 10, output_tokens: 2 } });
const echo = (message: SDKUserMessage) => ({ ...message, isReplay: true, session_id: "session-fixture" });
const tick = () => new Promise<void>(r => setImmediate(r));

function fixture(scenario: (input: AsyncIterator<SDKUserMessage>, req: CompletionRequest, lease: RunInputLease) => AsyncGenerator<unknown>) {
  const accepted: Message[] = [], states: string[] = [], usage: unknown[] = [];
  const lease = new RunInputLease("run", "scope", async m => { await tick(); accepted.push(m); }, () => {});
  let calls = 0, closed = 0;
  const req: CompletionRequest = { modelRef: "claude-agent/fixture", model: "fixture", messages: [{ role: "user", content: "ORIGINAL" }],
    maxTurns: 6, onUsage: u => usage.push(u), toolContext: { agent, logger, execution: { runInputs: lease, inputBoundary: lease } } };
  const sdk = { query(args: any) {
    calls++; assert.equal(typeof args.prompt, "object");
    assert.equal(args.options.extraArgs["replay-user-messages"], null);
    const input = args.prompt[Symbol.asyncIterator]() as AsyncIterator<SDKUserMessage>;
    const q = scenario(input, req, lease);
    return Object.assign(q, { close() { closed++; void input.return?.(); } });
  } } as unknown as Sdk;
  const backend = new ClaudeAgentSdkBackend({ apiKey: "fixture", authToken: "", baseURL: "https://fixture.invalid",
    defaultModel: "fixture", fallbackModel: "", logger, uploadDir: os.tmpdir(), loadSdk: async () => sdk });
  Object.defineProperty(backend, "buildEnv", { value: () => ({}) });
  const offer = (id = "follow", attachments?: Message["attachments"]) => lease.offer({ id, text: `NEW_${id}`, attachments,
    record: async state => { states.push(`${id}:${state}`); } });
  return { backend, req, lease, accepted, states, usage, offer, get calls() { return calls; }, get closed() { return closed; } };
}

test("SDK native next input shares query; exact replay receipt, no hook prompt or extra completion", { timeout: 5000 }, async () => {
  const f = fixture(async function* (input, req) {
    const first = (await input.next()).value!; yield echo(first);
    f.offer(); const next = (await input.next()).value!;
    assert.equal(next.priority, "next"); assert.equal(next.message.content, "NEW_follow");
    yield echo({ ...next, uuid: first.uuid }); // old/foreign replay cannot accept the supplement
    assert.deepEqual(f.accepted, []);
    yield echo(next); yield echo(next); // duplicate receipt cannot duplicate history or charges
    yield assistant("NEW_DONE"); yield done();
  });
  const result = await f.backend.complete(f.req);
  assert.equal(result.message.content, "NEW_DONE"); assert.equal(f.calls, 1); assert.equal(f.closed, 1);
  assert.deepEqual(f.accepted.map(m => m.content), ["NEW_follow"]);
  assert.deepEqual(f.states, ["follow:sending", "follow:accepted"]);
  assert.equal(f.usage.length, 1); assert.equal(result.usage!.promptTokens, 10);
  assert.equal(f.req.messages.length, 2);
  await f.lease.finish();
});

test("SDK input during final text waits for native second result, counts per-turn usage once", { timeout: 5000 }, async () => {
  const f = fixture(async function* (input) {
    yield echo((await input.next()).value!);
    f.offer(); const next = (await input.next()).value!;
    yield assistant("OLD_DONE"); yield done("OLD_DONE");
    yield echo(next); yield assistant("NEW_DONE"); yield done();
  });
  const result = await f.backend.complete(f.req);
  assert.equal(result.message.content, "NEW_DONE"); assert.equal(f.calls, 1);
  assert.equal(result.usage!.promptTokens, 20); assert.equal(result.usage!.completionTokens, 4);
  assert.equal(f.usage.length, 2); assert.equal(f.accepted.length, 1);
  await f.lease.finish();
});

test("SDK steer reconciles per-turn output after deduplicated provider frames", { timeout: 5000 }, async () => {
  const frame = (id: string, text: string, output: number) => {
    const value = assistant(text);
    return { ...value, message: { ...value.message, id, usage: { input_tokens: 10, output_tokens: output } } };
  };
  const f = fixture(async function* (input) {
    yield echo((await input.next()).value!);
    f.offer(); const next = (await input.next()).value!;
    yield frame("provider-first", "OLD", 0); yield frame("provider-first", "OLD", 1);
    yield done("OLD"); // 10 input / 2 output for this native turn
    yield echo(next);
    yield frame("provider-second", "NEW", 0); yield frame("provider-second", "NEW", 1);
    yield done("NEW");
  });
  const result = await f.backend.complete(f.req);
  assert.equal(result.message.content, "NEW");
  assert.deepEqual(result.usage, { promptTokens: 20, completionTokens: 4, cachedTokens: 0, cacheCreationTokens: 0 });
  assert.equal(f.usage.length, 6, "each turn: input snapshot, output delta, final output residual");
  await f.lease.finish();
});

test("SDK final seals admission before message preparation: late text queues, never query/resume simulation", { timeout: 5000 }, async () => {
  const f = fixture(async function* (input) {
    yield echo((await input.next()).value!); yield assistant("ORIGINAL_DONE");
    // record() awaits; closing may race the sender after it persists 'sending'.
    f.offer(); yield done("ORIGINAL_DONE");
  });
  assert.equal((await f.backend.complete(f.req)).message.content, "ORIGINAL_DONE");
  assert.deepEqual(await f.lease.drainAtBoundary(), []);
  await f.lease.finish(); assert.equal(f.calls, 1); assert.equal(f.accepted.length, 0);
  assert.ok(f.states.includes("follow:waiting")); assert.ok(!f.states.includes("follow:unknown"));
});

test("SDK still accepts further supplements while consuming input after a superseded result", { timeout: 5000 }, async () => {
  const f = fixture(async function* (input) {
    yield echo((await input.next()).value!); f.offer("first"); const first = (await input.next()).value!;
    yield assistant("STALE"); yield done("STALE"); yield echo(first);
    await tick(); f.offer("second"); const second = (await input.next()).value!;
    yield echo(second); yield assistant("BOTH_DONE"); yield done("BOTH_DONE");
  });
  assert.equal((await f.backend.complete(f.req)).message.content, "BOTH_DONE");
  await f.lease.finish(); assert.equal(f.calls, 1);
  assert.deepEqual(f.accepted.map(m => m.content), ["NEW_first", "NEW_second"]);
});

test("SDK submitted input with lost receipt is unknown and forbids router fallback", { timeout: 5000 }, async () => {
  const f = fixture(async function* (input) {
    yield echo((await input.next()).value!); f.offer(); await input.next();
    throw new Error("lost native pipe");
  });
  let fallbackCalls = 0;
  const router = new Router({ "claude-agent": f.backend, fallback: { name: "fallback", async complete() {
    fallbackCalls++; return { message: { role: "assistant", content: "wrong" } }; } } }, logger,
    { globalFallbacks: ["fallback/model"] });
  await assert.rejects(router.complete(f.req), NativeInputDeliveryError);
  await f.lease.finish(); assert.equal(fallbackCalls, 0); assert.equal(f.calls, 1);
  assert.deepEqual(f.states, ["follow:sending", "follow:unknown"]); assert.equal(f.accepted.length, 0);
});

test("SDK abort settles unacknowledged native input instead of hanging or resending", { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const f = fixture(async function* (input) {
    yield echo((await input.next()).value!); f.offer(); await input.next(); controller.abort();
    throw new Error("run aborted");
  });
  f.req.signal = controller.signal;
  await assert.rejects(f.backend.complete(f.req), /run aborted/);
  await f.lease.finish(); assert.equal(f.closed, 1); assert.equal(f.accepted.length, 0);
  assert.ok(f.states.includes("follow:unknown"));
});

test("native pending supplement does not obtain a fresh hard budget after the first result", { timeout: 5000 }, async () => {
  const f = fixture(async function* (input) {
    yield echo((await input.next()).value!); f.offer(); await input.next();
    yield assistant("PARTIAL"); yield done("PARTIAL");
    assert.fail("must close this query at the existing hard budget");
  });
  f.req.tokenBudget = { mode: "hard", hardTokens: 12 };
  const output = await f.backend.complete(f.req); await f.lease.finish();
  assert.equal(output.incomplete, "budget"); assert.equal(f.calls, 1);
  assert.ok(f.states.includes("follow:unknown")); assert.equal(f.accepted.length, 0);
});

test("parallel SDK runs reject foreign replay receipts; stopping one does not stop the other", { timeout: 5000 }, async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  let foreign: SDKUserMessage;
  const a = fixture(async function* (input) {
    yield echo((await input.next()).value!); a.offer("a"); foreign = (await input.next()).value!;
    release(); throw new Error("A failed");
  });
  const b = fixture(async function* (input) {
    yield echo((await input.next()).value!); b.offer("b"); const own = (await input.next()).value!;
    await ready; yield echo(foreign); assert.equal(b.accepted.length, 0);
    yield echo(own); yield assistant("B_DONE"); yield done("B_DONE");
  });
  const [ra, rb] = await Promise.allSettled([a.backend.complete(a.req), b.backend.complete(b.req)]);
  assert.equal(ra.status, "rejected"); assert.equal(rb.status, "fulfilled");
  if (rb.status === "fulfilled") assert.equal(rb.value.message.content, "B_DONE");
  await a.lease.finish(); await b.lease.finish();
  assert.deepEqual(b.accepted.map(m => m.content), ["NEW_b"]); assert.equal(a.accepted.length, 0);
});

test("SDK text-only model queues images intact; native vision model receives verified pixels and grants", { timeout: 5000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harbour-input-image-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const image = path.join(root, "safe.png");
  await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+c7X8AAAAASUVORK5CYII=", "base64"));
  const attachments = [{ kind: "image" as const, url: "/uploads/safe.png", path: image, mime: "image/png" }];
  const f = fixture(async function* (input) {
    yield echo((await input.next()).value!); f.offer("picture", attachments);
    await tick(); yield assistant("ORIGINAL_DONE"); yield done("ORIGINAL_DONE");
  });
  await f.backend.complete(f.req); await f.lease.finish();
  assert.ok(f.states.includes("picture:waiting")); assert.equal(f.accepted.length, 0);
  const v = fixture(async function* (input, req) {
    yield echo((await input.next()).value!); v.offer("picture", attachments);
    const next = (await input.next()).value!;
    const blocks = next.message.content as any[];
    assert.equal(blocks.filter(b => b.type === "image").length, 1);
    assert.equal(blocks.find(b => b.type === "image").source.type, "base64");
    yield echo(next); yield assistant("SEEN"); yield done("SEEN");
  });
  v.req.supportsVision = true;
  Object.assign((v.backend as any).opts, { uploadDir: root });
  assert.equal((await v.backend.complete(v.req)).message.content, "SEEN"); await v.lease.finish();
  assert.equal(v.accepted.length, 1); assert.deepEqual(v.req.toolContext!.attachments, attachments);
});

test("native unavailable stays FIFO; removed yield-hint hook cannot return", { timeout: 5000 }, async () => {
  const source = await import("node:fs/promises").then(fs => fs.readFile("src/core/backends/claudeAgentSdk.ts", "utf8"));
  assert.doesNotMatch(source, /主会话有用户补充等待接收|请交还已保存的进度/);
  const f = fixture(async function* (input) {
    yield echo((await input.next()).value!); f.offer("image", [{ kind: "image", url: "/uploads/a.png" }]); f.offer("after");
    await tick(); yield done("ORIGINAL_DONE");
  });
  await f.backend.complete(f.req); await f.lease.finish();
  assert.equal(f.accepted.length, 0); assert.ok(f.states.includes("image:waiting")); assert.ok(f.states.includes("after:waiting"));
});

test("child with pending parent input retains one-shot SDK query, no native inbox", { timeout: 5000 }, async () => {
  const f = fixture(async function* () { assert.fail("root mailbox query must not be used"); });
  f.req.toolContext!.execution = { inputBoundary: { revision: 1, hasPending: true } };
  let calls = 0;
  Object.assign((f.backend as any).opts, { loadSdk: async () => ({ query(args: any) {
    calls++; assert.equal(typeof args.prompt, "string"); assert.equal(args.options.extraArgs, undefined);
    return (async function* () { yield assistant("CHILD_DONE"); yield done("CHILD_DONE"); })();
  } }) });
  assert.equal((await f.backend.complete(f.req)).message.content, "CHILD_DONE"); assert.equal(calls, 1);
});
