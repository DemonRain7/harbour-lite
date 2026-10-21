import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { createApp } from '../src/server.js';
import { fixture, project } from '../tests/helpers.js';

const browserPath =
  process.env.CHROMIUM_PATH ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].find(existsSync);
if (!browserPath)
  throw new Error(
    'Set CHROMIUM_PATH to a Chromium browser executable. Tests launch their own headless profile.',
  );
const f = await fixture();
let modelRequests = 0;
const mock = http.createServer(async (request, response) => {
  for await (const _ of request) {
  }
  modelRequests++;
  response.setHeader('content-type', 'application/json');
  response.end(
    JSON.stringify({
      choices: [{ message: { content: '这是本机模拟模型回复。' }, finish_reason: 'stop' }],
    }),
  );
});
await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
const mockBase = `http://127.0.0.1:${(mock.address() as { port: number }).port}/v1`;
const app = await createApp({ root: f.root });
await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
const screenshots = path.join(project, '.local', 'qa');
await fs.mkdir(screenshots, { recursive: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto(base);
  await page.locator('#splash').waitFor({ state: 'hidden' });
  await page.locator('#agent-select option[value="assistant"]').waitFor({ state: 'attached' });
  await page.screenshot({ path: path.join(screenshots, 'workbench.png') });
  await page.locator('#open-settings').click();
  for (const [name, value] of Object.entries({
    id: 'local-test',
    label: '本机测试模型',
    baseUrl: mockBase,
    model: 'mock-model',
    apiKey: 'local-test-key',
  }))
    await page.locator(`#model-form input[name="${name}"]`).fill(value);
  await page.locator('#model-form button[type="submit"]').click();
  await page.locator('#model-form .form-status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(modelRequests, 0, 'Saving a model must never make a paid request');
  await page.locator('[data-close]').click();
  await page.locator('#model-select').selectOption('local-test');
  await page.locator('#message').fill('你好');
  await page.locator('#send').click();
  await page.getByText('这是本机模拟模型回复。', { exact: true }).waitFor({ timeout: 10000 });
  assert.equal(modelRequests, 1);
  await page.locator('.session-row').hover();
  await page.locator('.session-delete').click();
  await page.locator('#confirm-delete').click();
  await page.locator('.session-row').waitFor({ state: 'detached' });
  await page.locator('#model-select').selectOption('demo');
  await page.locator('#message').fill('请读取已挂载的技能');
  await page.locator('#send').click();
  await page.getByText('技能读取成功。', { exact: false }).waitFor({ timeout: 10000 });
  assert.equal(await page.locator('.message').count(), 2);
  await page.locator('#run-details summary').click();
  await page.getByText('已读取 clear-writing', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(screenshots, 'chat.png') });
  await page.locator('#open-agents').click();
  await page.locator('#agent-form input[name="name"]').fill('我的助手');
  await page.locator('#agent-form button[type="submit"]').click();
  await page.locator('#agent-form .form-status').filter({ hasText: '已保存' }).waitFor();
  await page.locator('#agent-list button').filter({ hasText: '我的助手' }).waitFor();
  await page.locator('[data-tab="appearance"]').click();
  await page.locator('#appearance-form input[name="title"]').fill('今天，从一个好想法开始。');
  await page.locator('#appearance-form button[type="submit"]').click();
  await page.locator('#appearance-form .form-status').filter({ hasText: '已保存' }).waitFor();
  await page.screenshot({ path: path.join(screenshots, 'appearance.png') });
  const picture = await sharp({
    create: { width: 16, height: 16, channels: 4, background: '#c7e8d4' },
  })
    .png()
    .toBuffer();
  await page
    .locator('#image-upload')
    .setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: picture });
  await page.locator('#appearance-image').waitFor({ state: 'visible' });
  await page.locator('#appearance-form button[type="submit"]').click();
  await page.locator('#appearance-form .form-status').filter({ hasText: '已保存' }).waitFor();
  await page.locator('[data-close]').click();
  await page.locator('#preview-splash').click();
  await page.getByText('今天，从一个好想法开始。', { exact: true }).last().waitFor();
  await page.locator('#skip-splash').click();
  await page.locator('.session-row').hover();
  await page.locator('.session-delete').click();
  await page.locator('#confirm-delete').click();
  await page.locator('.session-row').waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.screenshot({ path: path.join(screenshots, 'mobile.png') });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  await page.locator('#toggle-sidebar').click();
  await page.locator('#open-settings').click();
  await page.locator('#settings-dialog').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(screenshots, 'mobile-settings.png') });
  assert.equal(
    await page
      .locator('#settings-dialog')
      .evaluate((element) => element.scrollWidth > element.clientWidth),
    false,
  );
  assert.equal(failures.length, 0, failures.join('\n'));
  console.log(
    'UI passed: offline chat, real skill read, Agent override, appearance save/preview, session deletion, mobile layout, no page errors.',
  );
} finally {
  await browser.close();
  await app.close();
  mock.closeAllConnections();
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  await f.cleanup();
}
