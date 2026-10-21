import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { ModelSchema, AgentSchema } from '../src/schema.js';

test('ships only neutral templates and scoped original skills', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const agents = await f.store.agents();
  assert.deepEqual(agents.map((a) => a.id).sort(), ['assistant', 'planner']);
  assert.deepEqual((await f.store.skills()).map((s) => s.id).sort(), [
    'clear-writing',
    'task-planning',
  ]);
  assert.match(await f.store.skill(agents[0]!, 'clear-writing'), /clear-writing/);
  await assert.rejects(f.store.skill(agents[0]!, 'task-planning'));
  await assert.rejects(f.store.skill(agents[0]!, 'clear-writing', '../SKILL.md'));
  await assert.rejects(f.store.skill(agents[0]!, 'clear-writing', '/etc/passwd'));
  await assert.rejects(f.store.skill({ ...agents[0]!, tools: [] }, 'clear-writing'));
});
test('model keys remain in ignored environment, edits leave built-in agent unchanged', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const model = ModelSchema.parse({
    id: 'test-model',
    label: 'Test',
    provider: 'openai-compatible',
    baseUrl: 'https://example.com/v1',
    model: 'unit-model',
  });
  await f.store.saveModel(model, 'unit-test-secret');
  assert.equal(await f.store.secret(model.id), 'unit-test-secret');
  await f.store.saveModel({ ...model, label: 'Edited' }, '');
  assert.equal(await f.store.secret(model.id), 'unit-test-secret');
  assert.ok(
    !(await fs.readFile(path.join(f.store.data, 'models.json'), 'utf8')).includes(
      'unit-test-secret',
    ),
  );
  await assert.rejects(f.store.saveModel(model, 'bad\nkey'));
  const before = await fs.readFile(path.join(f.root, 'agents/assistant/CLAUDE.md'), 'utf8');
  const agent = (await f.store.agents()).find((a) => a.id === 'assistant')!;
  await f.store.saveAgent({ ...agent, name: '自定义', model: model.id });
  assert.equal((await f.store.agents()).find((a) => a.id === agent.id)?.name, '自定义');
  assert.equal(await fs.readFile(path.join(f.root, 'agents/assistant/CLAUDE.md'), 'utf8'), before);
});
test('rejects credential URLs, unsafe agent IDs and unknown configuration', () => {
  const model = {
    id: 'm',
    label: 'm',
    provider: 'openai-compatible',
    baseUrl: 'https://example.com/v1',
    model: 'm',
  };
  for (const baseUrl of [
    'http://example.com/v1',
    'https://user:pass@example.com',
    'https://example.com?key=bad',
    'file:///tmp/a',
  ])
    assert.equal(ModelSchema.safeParse({ ...model, baseUrl }).success, false);
  assert.equal(
    ModelSchema.safeParse({ ...model, baseUrl: 'http://127.0.0.1:9999/v1' }).success,
    true,
  );
  assert.equal(
    AgentSchema.safeParse({ id: '../../escape', name: 'bad', prompt: 'bad' }).success,
    false,
  );
  assert.equal(
    AgentSchema.safeParse({ id: 'ok', name: 'ok', prompt: 'ok', tools: ['shell'] }).success,
    false,
  );
});
