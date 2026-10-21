import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { complete, type CompletionInput } from '../src/providers.js';

test('real HTTP adapter requests: OpenAI tools, Anthropic blocks, no redirect or error retry', async (t) => {
  const requests: { path: string; body: any; headers: http.IncomingHttpHeaders }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: req.url!, body, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    if (body.model === 'redirect') {
      res.writeHead(302, { location: '/redirected' });
      res.end();
      return;
    }
    if (body.model === 'error') {
      res.writeHead(401);
      res.end(JSON.stringify({ secret: 'do-not-expose' }));
      return;
    }
    if (req.url === '/v1/messages')
      res.end(
        JSON.stringify({
          content: [{ type: 'text', text: 'anthropic answer' }],
          stop_reason: 'end_turn',
        }),
      );
    else
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call1',
                    type: 'function',
                    function: { name: 'read_skill', arguments: '{"name":"clear-writing"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const input: CompletionInput = {
    model: {
      id: 'm',
      label: 'Mock',
      provider: 'openai-compatible',
      baseUrl: `${base}/v1`,
      model: 'mock',
      maxOutputTokens: 512,
    },
    apiKey: 'test-key',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    allowSkills: true,
    signal: new AbortController().signal,
  };
  const first = await complete(input);
  assert.equal(first.calls[0]?.name, 'read_skill');
  assert.equal(requests[0]?.path, '/v1/chat/completions');
  assert.equal(requests[0]?.headers.authorization, 'Bearer test-key');
  assert.equal(requests[0]?.body.tools[0].function.name, 'read_skill');
  const second = await complete({
    ...input,
    model: { ...input.model, provider: 'anthropic', baseUrl: base },
    messages: [
      ...input.messages,
      { role: 'assistant', content: '', calls: first.calls },
      { role: 'tool', content: 'skill body', callId: 'call1' },
    ],
  });
  assert.equal(second.content, 'anthropic answer');
  assert.equal(requests[1]?.path, '/v1/messages');
  assert.equal(requests[1]?.headers['x-api-key'], 'test-key');
  assert.equal(requests[1]?.body.messages[2].content[0].type, 'tool_result');
  await assert.rejects(
    complete({ ...input, model: { ...input.model, model: 'error' } }),
    /HTTP 401/,
  );
  await assert.rejects(
    complete({ ...input, model: { ...input.model, model: 'redirect' } }),
    /无法连接模型/,
  );
  assert.equal(requests.length, 4);
});
