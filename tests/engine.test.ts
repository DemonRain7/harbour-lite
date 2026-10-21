import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Engine } from '../src/engine.js';
import { fixture, waitFor } from './helpers.js';
import type { Complete } from '../src/providers.js';

test('offline demo genuinely goes through lazy skill tool and persists completion', async (t) => {
  const f = await fixture();
  const engine = new Engine(f.store);
  t.after(async () => {
    await engine.close();
    await f.cleanup();
  });
  const session = await engine.createSession('assistant');
  const request = { content: '请读取技能', requestId: randomUUID() };
  const run = await engine.start(session.id, request);
  await waitFor(async () => (await f.store.readRun(run.id))?.status === 'completed');
  const saved = await f.store.session(session.id);
  assert.equal(saved.messages.length, 2);
  assert.equal(saved.pendingRun, undefined);
  assert.ok((await engine.run(run.id))?.trace);
  assert.match(saved.messages[1]!.content, /技能读取成功/);
  assert.equal((await engine.start(session.id, request)).id, run.id);
  assert.equal((await f.store.session(session.id)).messages.length, 2);
  await assert.rejects(engine.start(session.id, { ...request, content: 'different' }), /请求标识/);
});
test('different sessions run concurrently, cancellation and same-session conflict are isolated', async (t) => {
  const f = await fixture();
  let calls = 0;
  const provider: Complete = async (input) => {
    calls++;
    await new Promise((_resolve, reject) =>
      input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }),
    );
    throw new Error();
  };
  const engine = new Engine(f.store, provider);
  t.after(async () => {
    await engine.close();
    await f.cleanup();
  });
  const a = await engine.createSession('assistant'),
    b = await engine.createSession('planner');
  const [r1, r2] = await Promise.all([
    engine.start(a.id, { content: 'A', requestId: randomUUID() }),
    engine.start(b.id, { content: 'B', requestId: randomUUID() }),
  ]);
  await waitFor(async () => calls === 2);
  await assert.rejects(
    engine.start(a.id, { content: 'again', requestId: randomUUID() }),
    /仍有任务/,
  );
  await assert.rejects(engine.remove(a.id), /停止/);
  engine.stop(r1.id);
  await waitFor(async () => (await f.store.readRun(r1.id))?.status === 'cancelled');
  assert.equal((await engine.run(r2.id))?.status, 'running');
  assert.equal((await f.store.session(a.id)).pendingRun, undefined);
  assert.equal((await f.store.session(b.id)).pendingRun, r2.id);
});
test('step budget, unknown tool and provider errors never execute outside grants or retry', async (t) => {
  const f = await fixture();
  let calls = 0;
  const agent = (await f.store.agents())[0]!;
  await f.store.saveAgent({ ...agent, maxSteps: 2 });
  const engine = new Engine(f.store, async () => {
    calls++;
    return {
      content: '',
      calls: [{ id: `call${calls}`, name: 'shell', arguments: { command: 'danger' } }],
    };
  });
  t.after(async () => {
    await engine.close();
    await f.cleanup();
  });
  const session = await engine.createSession(agent.id);
  const run = await engine.start(session.id, { content: 'test', requestId: randomUUID() });
  await waitFor(async () => (await f.store.readRun(run.id))?.status === 'error');
  assert.equal(calls, 2);
  assert.match(String((await engine.run(run.id))?.error), /回合上限/);
});
test('restart marks unfinished receipt interrupted without replay and retains idempotency', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const id = randomUUID(),
    runId = randomUUID();
  await f.store.saveSession({
    id,
    agentId: 'assistant',
    modelId: 'demo',
    title: 'Test',
    messages: [],
    updatedAt: new Date().toISOString(),
    pendingRun: runId,
  });
  await f.store.writeRun({
    id: runId,
    sessionId: id,
    status: 'running',
    fingerprint: 'abc',
    trace: [{ kind: 'model' }],
  });
  await f.store.init();
  assert.equal((await f.store.readRun(runId))?.status, 'interrupted');
  assert.equal((await f.store.readRun(runId))?.fingerprint, 'abc');
  assert.equal((await f.store.session(id)).pendingRun, undefined);
});
