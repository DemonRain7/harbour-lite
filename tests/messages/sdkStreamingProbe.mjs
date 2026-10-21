// Production Harbour backend + real installed SDK + loopback-only model fixture.
// node --import tsx tests/messages/sdkStreamingProbe.mjs [--during-answer] [--split-usage]
// No provider credits or production sessions.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentSdkBackend } from '../../src/core/backends/claudeAgentSdk.ts';
import { RunInputLease } from '../../src/core/runInputs.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'harbour-sdk-stream-probe-'));
const model = 'harbour-stream-fixture', controller = new AbortController();
const duringAnswer = process.argv.includes('--during-answer');
const splitUsage = process.argv.includes('--split-usage');
let calls = 0, queryCalls = 0, failure, q;
const accepted = [], states = [], usages = [];
const lease = new RunInputLease('probe-run', 'probe-scope', async m => { accepted.push(m.content); }, () => {});
function offer() { assert.equal(lease.offer({ id: 'probe-follow', text: 'NEW_REQUIREMENT', record: async state => { states.push(state); } }), true); }
const events = [], requests = [];
function reply(res, body, isTool, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit('message_start', { message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0,
      ...(splitUsage ? { cache_read_input_tokens: 25, cache_creation_input_tokens: 5 } : {}) } } });
  if (splitUsage) {
    emit('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
    emit('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Offline fixture reasoning.' } });
    emit('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'fixture-signature' } });
    emit('content_block_stop', { index: 0 });
  }
  const index = splitUsage ? 1 : 0;
  emit('content_block_start', { index, content_block: isTool
    ? { type: 'tool_use', id: 'hold_1', name: 'mcp__harbour_tools__hold', input: {} } : { type: 'text', text: '' } });
  emit('content_block_delta', { index, delta: isTool
    ? { type: 'input_json_delta', partial_json: '{}' } : { type: 'text_delta', text } });
  emit('content_block_stop', { index });
  emit('message_delta', { delta: { stop_reason: isTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
  emit('message_stop', {}); res.end();
}
const server = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (req.url.startsWith('/v1/messages/count_tokens')) return res.end('{"input_tokens":100}');
    assert.ok(req.url.startsWith('/v1/messages')); assert.equal(body.model, model);
    const content = JSON.stringify(body.messages); requests.push({ follow: content.includes('NEW_REQUIREMENT'), tool: content.includes('HOLD_DONE') });
    assert.ok(requests.length <= 4);
    if (duringAnswer && requests.length === 1) {
      offer();
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    reply(res, body, !duringAnswer && requests.length === 1, content.includes('NEW_REQUIREMENT') ? 'NEW_DONE' : 'OLD_DONE');
  } catch (error) { failure = error; res.writeHead(500); res.end('{}'); controller.abort(); }
});
server.on('connect', (_, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const safeEnv = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
const env = { ...safeEnv, TEMP: root, TMP: root, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: root,
  ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'fixture-not-a-real-key', HTTP_PROXY: base, HTTPS_PROXY: base, ALL_PROXY: base,
  NO_PROXY: '127.0.0.1,localhost', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1' };
const timer = setTimeout(() => { controller.abort(); q?.close(); }, 45000);
try {
  const logger = pino({ level: 'silent' });
  const backend = new ClaudeAgentSdkBackend({ apiKey: 'fixture-not-a-key', authToken: '', baseURL: base,
    defaultModel: model, fallbackModel: '', uploadDir: root, logger,
    loadSdk: async () => ({ ...sdk, query(args) {
      queryCalls++;
      q = sdk.query({ ...args, options: { ...args.options, env, cwd: root } });
      const observed = (async function* () { for await (const event of q) {
        events.push({ type: event.type, subtype: event.subtype, replay: event.isReplay, result: event.result,
          ...(splitUsage ? { id: event.message?.id, blocks: event.message?.content?.map?.(b => b.type),
            usage: event.type === 'result' ? structuredClone(event.usage) : structuredClone(event.message?.usage) } : {}) });
        yield event;
      } })();
      observed.close = () => q.close(); return observed;
    } }) });
  Object.defineProperty(backend, 'buildEnv', { value: () => env });
  const agent = { name: 'native-steer-probe', taskType: 'test', contextBudget: 'auto', tools: ['hold'], permissionMode: 'dontAsk',
    governance: { permissions: { readOnly: true, tools: ['hold'] } } };
  const output = await backend.complete({ modelRef: `claude-agent/${model}`, model, maxTurns: 6, permissionMode: 'dontAsk', signal: controller.signal,
    messages: [{ role: 'system', content: 'Local protocol fixture only.' }, { role: 'user', content: 'ORIGINAL_REQUIREMENT' }],
    toolContext: { agent, logger, signal: controller.signal, execution: { runInputs: lease, inputBoundary: lease } },
    onUsage: usage => usages.push(usage),
    tools: [{ name: 'hold', description: 'Read-only test hold', parameters: { type: 'object', properties: {} }, readOnly: true, execute: async () => {
      calls++; assert.equal(calls, 1); offer();
      await new Promise(resolve => setTimeout(resolve, 1000)); return 'HOLD_DONE';
    } }] });
  await lease.finish();
  if (failure) throw failure;
  assert.equal(calls, duringAnswer ? 0 : 1); assert.ok(events.some(e => e.result === 'NEW_DONE'));
  assert.equal(queryCalls, 1); assert.equal(output.message.content, 'NEW_DONE');
  assert.deepEqual(accepted, ['NEW_REQUIREMENT']); assert.deepEqual(states, ['sending', 'accepted']);
  assert.equal(requests.length, 2); assert.equal(output.usage.promptTokens, 200); assert.equal(output.usage.completionTokens, 20);
  assert.equal(usages.reduce((sum, u) => sum + u.promptTokens, 0), 200);
  if (splitUsage) {
    assert.equal(output.usage.cachedTokens, 50);
    assert.equal(output.usage.cacheCreationTokens, 10);
    const assistantFrames = events.filter(e => e.type === 'assistant' && !e.replay);
    assert.equal(assistantFrames.length, 4, 'two provider responses each split into two SDK frames');
    assert.equal(new Set(assistantFrames.map(e => e.id)).size, 2);
    const terminalUsage = events.filter(e => e.type === 'result').map(e => e.usage);
    assert.equal(terminalUsage.reduce((n, u) => n + u.input_tokens, 0), 200, 'SDK terminal usage does not double shared provider IDs');
    assert.equal(terminalUsage.reduce((n, u) => n + u.output_tokens, 0), 20);
    assert.equal(terminalUsage.reduce((n, u) => n + u.cache_read_input_tokens, 0), 50);
    assert.equal(terminalUsage.reduce((n, u) => n + u.cache_creation_input_tokens, 0), 10);
  }
  assert.equal(events.filter(e => e.type === 'result').length, duringAnswer ? 2 : 1);
  if (!duringAnswer) assert.deepEqual(requests[1], { follow: true, tool: true });
  console.log(JSON.stringify({ result: 'PASS', duringAnswer, splitUsage, queryCalls, calls, states, requests, events }, null, 2));
} finally {
  clearTimeout(timer); controller.abort(); q?.close(); await lease.finish();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const target = await realpath(root); assert.equal(path.dirname(target).toLowerCase(), (await realpath(os.tmpdir())).toLowerCase());
  assert.match(path.basename(target), /^harbour-sdk-stream-probe-/);
  await rm(target, { recursive: true, maxRetries: 5, retryDelay: 100 });
}
