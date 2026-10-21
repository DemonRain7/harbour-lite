import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { fixture, waitFor } from './helpers.js';

test('HTTP end-to-end: auth, same-origin, redacted keys, chat, custom appearance and deletion', async (t) => {
  const f = await fixture();
  const token = 'unit-test-local-access-token';
  const app = await createApp({ root: f.root, token });
  await assert.rejects(createApp({ root: f.root, token }), /另一个进程/);
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    await f.cleanup();
  });
  const address = app.server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const request = (
    url: string,
    method = 'GET',
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(`${base}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  assert.equal((await fetch(`${base}/api/bootstrap`)).status, 401);
  assert.equal(
    (await request('/api/bootstrap', 'GET', undefined, { origin: 'https://untrusted.example' }))
      .status,
    403,
  );
  const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = http.get(
      `${base}/api/bootstrap`,
      { headers: { host: 'untrusted.example', authorization: `Bearer ${token}` } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    req.on('error', reject);
  });
  assert.equal(wrongHost, 403);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  const model = {
    id: 'mock',
    label: 'Mock',
    provider: 'openai-compatible',
    baseUrl: 'https://example.com/v1',
    model: 'mock',
  };
  assert.equal(
    (await request('/api/models', 'PUT', { model, apiKey: 'unit-secret-not-returned' })).status,
    200,
  );
  const bootstrap = await (await request('/api/bootstrap')).text();
  assert.ok(!bootstrap.includes('unit-secret-not-returned'));
  assert.ok(bootstrap.includes('hasKey'));
  assert.ok(!bootstrap.includes(f.root));
  const session = await (await request('/api/sessions', 'POST', { agentId: 'assistant' })).json();
  const run = await (
    await request(`/api/sessions/${session.id}/messages`, 'POST', {
      content: '你好',
      requestId: randomUUID(),
    })
  ).json();
  await waitFor(
    async () => (await (await request(`/api/runs/${run.id}`)).json()).status === 'completed',
  );
  assert.equal((await (await request(`/api/sessions/${session.id}`)).json()).messages.length, 2);
  const png = await sharp({ create: { width: 24, height: 24, channels: 4, background: '#c7e8d4' } })
    .png()
    .toBuffer();
  const uploaded = await (
    await request('/api/appearance/image', 'POST', {
      image: `data:image/png;base64,${png.toString('base64')}`,
    })
  ).json();
  assert.match(uploaded.image, /^[a-f0-9]{64}\.webp$/);
  assert.equal(
    (
      await request('/api/appearance', 'PUT', {
        enabled: true,
        title: '我的工作台',
        subtitle: '测试',
        image: uploaded.image,
      })
    ).status,
    200,
  );
  const image = await request(`/api/appearance/image/${uploaded.image}`);
  assert.equal(image.headers.get('content-type'), 'image/webp');
  assert.equal((await fetch(`${base}/api/appearance/image/${uploaded.image}`)).status, 401);
  assert.equal(
    (await request('/api/appearance/image', 'POST', { image: 'data:image/png;base64,AAAA' }))
      .status,
    400,
  );
  assert.equal(
    (
      await request('/api/appearance', 'PUT', {
        enabled: true,
        title: 'Bad',
        subtitle: '',
        image: '../.env',
      })
    ).status,
    400,
  );
  assert.equal((await request(`/.env`)).status, 404);
  assert.equal((await request(`/api/sessions/${session.id}`, 'DELETE')).status, 200);
  assert.equal((await request(`/api/runs/${run.id}`)).status, 404);
  assert.equal((await (await request('/api/sessions')).json()).length, 0);
});
test('refuses unauthenticated non-loopback deployment', async () => {
  await assert.rejects(createApp({ root: '.', host: '0.0.0.0' }), /24 字符/);
});
