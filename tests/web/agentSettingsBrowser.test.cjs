// Real browser against isolated data: no production requests, model calls or disk proposals.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../../vendor/folia/node_modules/playwright');
const { createPreviewServer } = require('./collections.preview.cjs');

test('Agent settings: compact hierarchy, model labels, draft isolation and responsive themes', { timeout: 60000 }, async t => {
  const server = createPreviewServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  context.setDefaultTimeout(6000);
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 204 }));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#agents');
  await page.locator('[data-agent="main-winefox"]').click();
  await page.locator('#ac-maxSteps:enabled').waitFor();
  assert.equal(await page.locator('details[data-ac-group][open]').count(), 0, 'advanced controls start collapsed');
  assert.equal(await page.locator('[data-ac-field="reasoningEffort"]').isVisible(), true);
  assert.equal(await page.locator('[data-ac-field="model"]').isVisible(), false);
  assert.equal(await page.locator('[data-ac-field="contextBudget"] input').isVisible(), false, 'auto does not leave an empty disabled box');
  assert.equal(await page.locator('[data-ac-status]').isVisible(), false, 'no idle status boilerplate');
  const native = '[data-agent-default-model]';
  assert.equal(await page.locator(native + ' option[value=""]').innerText(), '跟随基础配置 · DeepSeek V4.1 Flash · DSH');
  const inspection = () => fetch(origin + '/__inspection').then(res => res.json());
  assert.deepEqual((await inspection()).writes, [], 'opening settings must not save anything');
  const output = path.resolve(__dirname, '../../assets/reports/agent-settings');
  fs.mkdirSync(output, { recursive: true });
  for (const [theme, cat, width, height] of [['anime-wisteria', 'anime', 1440, 1000], ['anime-wisteria', 'anime', 1100, 760], ['premium-tungsten', 'premium', 1440, 1000], ['anime-wisteria', 'anime', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(({ theme, cat }) => { document.body.dataset.theme = theme; document.body.dataset.themeCat = cat; }, { theme, cat });
    await page.locator('#agentDetailView').evaluate(el => { el.scrollTop = 0; });
    const measure = await page.evaluate(() => {
      const viewport = innerWidth;
      const nodes = [...document.querySelectorAll('#agentsDetail input:not([hidden]), #agentsDetail .hs-trigger, #agentsDetail .ac-toolbar')].filter(el => el.getBoundingClientRect().width > 0);
      return { width: document.documentElement.scrollWidth, viewport, bad: nodes.filter(el => { const b = el.getBoundingClientRect(); return b.left < 0 || b.right > viewport + 1; }).map(el => el.id || el.className) };
    });
    assert.ok(measure.width <= width + 1 && !measure.bad.length, JSON.stringify(measure));
    await page.screenshot({ path: path.join(output, `${theme}-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { document.body.dataset.theme = 'anime-wisteria'; document.body.dataset.themeCat = 'anime'; });
  await page.locator('#ac-maxSteps').fill('16');
  // Use the real enhanced menu; shortcut settings must not discard the unsaved form.
  const modelRow = page.locator('.mc-field').filter({ has: page.locator(native) });
  await modelRow.locator('.hs-trigger').click();
  await modelRow.getByRole('option', { name: 'DeepSeek V4.1 Flash · Claude SDK', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-agent-model-source]')?.textContent.includes('已单独指定'));
  assert.equal(await page.locator('#ac-maxSteps').inputValue(), '16');
  assert.equal(await page.locator('[data-ac-save]').isEnabled(), true);
  assert.equal((await inspection()).writes.length, 1, 'only the explicit quick setting has saved');
  // Details stay open after submission; untouched fields and persona body survive.
  await page.locator('[data-ac-group="identity"] > summary').click();
  await page.locator('#ac-description').fill('一份完整的能力简介。第二句仍然可见。');
  await page.locator('[data-ac-save]').click();
  await page.waitForFunction(() => document.querySelector('[data-ac-status]')?.textContent.includes('待审批提案'));
  assert.equal(await page.locator('[data-ac-group="identity"]').getAttribute('open'), '');
  const saved = (await inspection()).writes.find(item => item.path === '/api/agent-files/main-winefox');
  assert.ok(saved);
  assert.match(saved.body.content, /maxSteps: 16/);
  assert.match(saved.body.content, /contextBudget: auto/);
  assert.match(saved.body.content, /只作为界面测试，不执行任何任务。/);
  assert.doesNotMatch(saved.body.content, /model: preview\/sdk/, 'runtime choice is not copied into the manifest');
  await page.locator('[data-fa-tab="files"]').click();
  assert.equal(await page.locator('#faFiles').isVisible(), true);
  assert.equal(await page.locator('#faSettings').isVisible(), false);
  await page.locator('[data-fa-tab="settings"]').click();
  const contextRow = page.locator('[data-ac-field="contextBudget"]');
  await contextRow.locator('.hs-trigger').click();
  await contextRow.getByRole('option', { name: '手动 · 指定容量', exact: true }).click();
  assert.equal(await contextRow.locator('input').isVisible(), true);
  await contextRow.locator('input').fill('12000');
  await contextRow.locator('.hs-trigger').click();
  await contextRow.getByRole('option', { name: '自动 · 跟随模型', exact: true }).click();
  assert.equal(await contextRow.locator('input').isVisible(), false);
  assert.equal(await page.locator('[data-ac-save]').isDisabled(), true, 'returning to automatic creates no phantom change');
  assert.deepEqual(errors, []);
  assert.equal((await inspection()).requests.some(item => /\/api\/(run|ai-edit)(?:\/|$)/.test(item.path)), false);
  console.log('Agent settings screenshots: ' + output);
});
