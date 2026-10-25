const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const app = fs.readFileSync(path.join(__dirname, '../../web/app.js'), 'utf8');
const source = app.match(/^async function submitRecoverableChatRun\([^\n]*\) \{[\s\S]*?^}/m)[0];
const body = { runId: 'run-fixture-1', session: { id: 'session-A' }, input: 'Complete all rounds' };
const status = (state, fields = {}) => ({ runId: body.runId, sessionId: body.session.id, status: state, ...fields });
function fixture(script) {
  const calls = [], notices = [];
  const context = vm.createContext({ AbortSignal, setTimeout: (fn) => setTimeout(fn, 0), clearTimeout,
    api: async (url, options) => {
      calls.push({ url, options });
      assert.ok(script.length, 'unexpected request');
      const value = script.shift(); if (value instanceof Error) throw value;
      return typeof value === 'function' ? value() : value;
    } });
  vm.runInContext(source, context);
  return { calls, notices, run: signal => context.submitRecoverableChatRun(body, signal, text => notices.push(text)) };
}
test('async acceptance, temporary loss and final retrieval send exactly one POST', async () => {
  const f = fixture([{ accepted: true }, status('running'), new TypeError('network gone'),
    status('running'), status('settled', { answer: 'round 1 + 2 + 3' })]);
  assert.equal((await f.run()).answer, 'round 1 + 2 + 3');
  assert.equal(f.calls.filter(c => c.options.method === 'POST').length, 1);
  assert.equal(f.calls[0].options.headers.Prefer, 'respond-async');
  assert.ok(f.calls.slice(1).every(c => c.url === '/api/runs/run-fixture-1?sessionId=session-A'));
  assert.ok(f.notices.some(s => s.includes('暂时断开')));
});
test('lost POST acknowledgement is reconciled read-only; settled work is never resubmitted', async () => {
  const f = fixture([new TypeError('headers timeout'), status('settled', { answer: 'already done' })]);
  assert.equal((await f.run()).answer, 'already done'); assert.equal(f.calls.length, 2);
});
test('unknown run, mismatched receipt, server failure and cancellation are not automatic retries', async () => {
  for (const value of [Object.assign(new Error('unknown'), { status: 404 }), Object.assign(new Error('auth expired'), { status: 401 }),
    status('settled', { runId: 'other-run', answer: 'wrong' }), status('settled', { sessionId: 'other-session', answer: 'wrong' }),
    status('failed', { error: 'tool outcome unknown' })]) {
    const f = fixture([{ accepted: true }, value]); await assert.rejects(f.run()); assert.equal(f.calls.length, 2);
  }
  const controller = new AbortController();
  const f = fixture([{ accepted: true }, () => { controller.abort(new Error('user stopped')); return status('running'); }]);
  await assert.rejects(f.run(controller.signal), /user stopped/); assert.equal(f.calls.length, 2);
});
test('legacy synchronous response still works without polling', async () => {
  const f = fixture([{ answer: 'legacy reply' }]); assert.equal((await f.run()).answer, 'legacy reply'); assert.equal(f.calls.length, 1);
});

test('Main Chat STOP failure preserves the handle and offers a retry instead of claiming stopped', async () => {
  const stopSource = ['requestChatStop', 'stopLocalChatRun'].map(name => app.match(new RegExp(`^async function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^}`, 'm'))[0]).join('\n');
  const calls = [], notices = [];
  const chat = { running: true, activeRunId: body.runId, sessionId: body.session.id, messages: [{ pending: true, runStartedAt: 1 }], trace: [],
    abort: { abort() { assert.fail('failed STOP must not disconnect the observation loop'); } } };
  const context = vm.createContext({ state: { chat }, AbortSignal, Date, $: () => null, window: {},
    stopVisualTimer() {}, visualPoll: () => 123, updatePendingDuration() {}, updatePendingTrace() {}, updatePendingActivity() {}, setChatSendMode() {},
    toast: text => notices.push(text), api: async (url, options) => { calls.push({ url, ...options }); throw new TypeError('network gone'); } });
  vm.runInContext(stopSource, context);
  await context.requestChatStop();
  assert.equal(chat.stopping, false); assert.equal(chat.activeRunId, body.runId);
  assert.equal(chat.messages[0].runEndedAt, undefined); assert.match(notices[0], /停止请求未送达/);
  assert.equal(JSON.parse(calls[0].body).sessionId, body.session.id);
  context.api = async (url, options) => { calls.push({ url, ...options }); return { status: 'stopping', runId: body.runId, sessionId: body.session.id }; };
  await context.requestChatStop(); assert.equal(calls.length, 2); assert.equal(chat.stopping, true);
});
