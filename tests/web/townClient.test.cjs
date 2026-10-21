const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../../web/town/client.js'), 'utf8');
const library = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

async function fixture() {
  const { TownChat, sessionKey } = await library;
  const calls = [], sessions = new Map(); let next = 0;
  const api = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, options, body });
    if (url.startsWith('/api/conversations?')) {
      const key = new URL(url, 'http://local').searchParams.get('key');
      return { enabled: true, activeId: [...sessions.values()].find(s => s.key === key)?.id || null };
    }
    if (url === '/api/conversations/new') { const session = { ...body, id: `session-${++next}`, messages: [] }; sessions.set(session.id, session); return { session }; }
    if (url.startsWith('/api/conversations/')) return { session: sessions.get(url.split('/').at(-1)) };
    if (url === '/api/run') return { answer: '你好。', session: { id: body.session.id } };
    if (url.endsWith('/abort')) return { stopping: true };
    throw new Error(`Unexpected ${url}`);
  };
  return { client: new TownChat(api, () => 'town-run-0001'), api, calls, sessions, sessionKey };
}
test('opening either resident reads history, never creates a session or calls a model', async () => {
  const { client, calls } = await fixture();
  await client.history('main-elaina'); await client.history('main-aemeath');
  assert.equal(calls.length, 2); assert.ok(calls.every(c => !c.options.method));
});
test('two residents use original Main names, isolated persistent web keys, unchanged model/mode defaults', async () => {
  const { client, calls } = await fixture();
  for (const id of ['main-elaina', 'main-aemeath', 'main-elaina']) await client.send(id, '你好');
  const runs = calls.filter(c => c.url === '/api/run').map(c => c.body);
  assert.deepEqual(runs.map(r => r.agent), ['main-elaina', 'main-aemeath', 'main-elaina']);
  assert.equal(runs[0].session.id, runs[2].session.id); assert.notEqual(runs[0].session.id, runs[1].session.id);
  assert.equal(runs[0].session.key, 'web:town:main-elaina');
  assert.ok(runs.every(r => !('model' in r) && !('permissionMode' in r) && !('system' in r)));
});
test('invalid resident and empty/oversized messages do not dispatch', async () => {
  const { client, calls } = await fixture();
  await assert.rejects(client.send('browser_controller', 'hello'));
  await assert.rejects(client.send('main-elaina', ' '));
  await assert.rejects(client.send('main-elaina', 'x'.repeat(8001)));
  assert.equal(calls.length, 0);
});
test('model-only visitor cannot create a session, read history or dispatch to another Main', async () => {
  const { client, calls, sessionKey } = await fixture();
  const { canChat, residentFor } = await library;
  assert.equal(residentFor('chisa').name, '千咲'); assert.equal(canChat('chisa'), false);
  assert.throws(() => sessionKey('chisa'), /尚未配置/);
  await assert.rejects(client.history('chisa'), /尚未配置/);
  await assert.rejects(client.send('chisa', 'hello'), /尚未配置/);
  client.sessions.set('chisa', { id: 'forged', agentName: 'main-elaina' });
  await assert.rejects(client.ensureSession('chisa'), /尚未配置/);
  assert.equal(client.busy, false); assert.equal(calls.length, 0);
});
test('mismatched persisted session fails closed before model call', async () => {
  const { TownChat } = await library;
  const client = new TownChat(async url => url.includes('?') ? { activeId: 'wrong' }
    : { session: { id: 'wrong', key: 'qq:private', channel: 'qq', agentName: 'main-elaina' } });
  await assert.rejects(client.send('main-elaina', 'hi'), /归属不匹配/);
});
test('in-flight messages cannot double-send, stop addresses only that run and waits for settlement', async () => {
  const { client, api, calls } = await fixture(); let finish;
  client.api = (url, options) => url === '/api/run' ? new Promise(resolve => { finish = resolve; }) : api(url, options);
  const pending = client.send('main-elaina', 'hello');
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(client.send('main-aemeath', 'other'), /上一条/);
  await client.stop(); assert.equal(client.busy, true);
  assert.equal(calls.at(-1).url, '/api/runs/town-run-0001/abort');
  finish({ answer: 'stopped' }); await pending; assert.equal(client.busy, false);
});
test('stop during session preparation never starts the model', async () => {
  const { client, api, calls } = await fixture(); let release;
  client.api = (url, options) => url.includes('?') ? new Promise(resolve => { release = resolve; }) : api(url, options);
  const pending = client.send('main-elaina', 'hello');
  await client.stop(); release({ enabled: true });
  await assert.rejects(pending, /尚未交给模型/);
  assert.equal(calls.filter(c => c.url === '/api/run').length, 0);
});
test('unknown network outcome is not retried', async () => {
  const { client, api } = await fixture(); let attempts = 0;
  client.api = (url, options) => { if (url === '/api/run') { attempts++; throw new Error('network lost'); } return api(url, options); };
  await assert.rejects(client.send('main-elaina', 'hello'), /network lost/);
  assert.equal(attempts, 1); assert.equal(client.busy, false);
});
test('display strips only generated user scene header, never assistant text', async () => {
  const { displayMessage } = await library;
  const content = '【Harbour 小镇 · 虚拟场景：站前】\n你好';
  assert.equal(displayMessage({ role: 'user', content }), '你好');
  assert.equal(displayMessage({ role: 'assistant', content }), content);
});

test('recent local activity joins only the explicit chat turn, without impersonating dialogue or tools', async () => {
  const { client, calls } = await fixture(), { displayMessage } = await library;
  await client.send('main-elaina', '刚才好玩吗？', '穗波市', '刚才猜拳：用户出布，你出石头，用户赢');
  const run = calls.find(c => c.url === '/api/run').body;
  assert.match(run.input, /动作预设，不是你此前说过的话/);
  assert.match(run.input, /用户出布，你出石头/);
  assert.equal(displayMessage({ role: 'user', content: run.input }), '刚才好玩吗？');
  assert.equal(run.agent, 'main-elaina'); assert.equal(run.system, undefined);
  await client.send('main-aemeath', '你好', '樱花车站');
  assert.doesNotMatch(calls.filter(c => c.url === '/api/run').at(-1).body.input, /猜拳/);
});
test('API preserves existing token header, never puts credentials in URL, and reports 401', async t => {
  const { request } = await library;
  const previousFetch = global.fetch, previousStorage = Object.getOwnPropertyDescriptor(global, 'localStorage');
  t.after(() => { global.fetch = previousFetch; if (previousStorage) Object.defineProperty(global, 'localStorage', previousStorage); else delete global.localStorage; });
  Object.defineProperty(global, 'localStorage', { configurable: true, value: { getItem: () => 'fixture-token' } });
  let sent;
  global.fetch = async (url, options) => { sent = { url, options }; return { ok: true, json: async () => ({ ok: true }) }; };
  await request('/api/conversations?key=web%3Atown%3Amain-elaina');
  assert.equal(sent.options.headers['x-harbour-token'], 'fixture-token'); assert.ok(!sent.url.includes('fixture-token'));
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'denied' }) });
  await assert.rejects(request('/api/asks'), /登录/);
});
