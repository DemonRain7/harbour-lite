// Opt-in, read-only check against a running backend. No job is executed or edited.
// node tests/web/cronLive.cjs --live
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('../../vendor/folia/node_modules/playwright');

async function main() {
  if (!process.argv.includes('--live')) throw new Error('Use --live for read-only backend/UI verification.');
  const base = process.env.HARBOUR_URL || 'http://localhost:7788';
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined) });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    if (process.env.HARBOUR_TOKEN) await context.addInitScript(token => localStorage.setItem('harbour-token', token), process.env.HARBOUR_TOKEN);
    const blockedWrites = [];
    await context.route('**/api/**', route => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
        blockedWrites.push(new URL(route.request().url()).pathname); return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/#cron`);
    await page.locator('.cron-task').first().waitFor({ timeout: 20000 });
    const pricing = page.locator('.cron-task').filter({ hasText: '刷新模型目录与计费表' });
    assert.equal(await pricing.count(), 1);
    const id = await pricing.getAttribute('data-task');
    const before = await page.evaluate(async id => {
      const { jobs } = await api('/api/cron'); const job = jobs.find(j => j.id === id);
      return { lastRunId: job.lastRunId, lastStatus: job.lastStatus, lastResult: job.lastResult };
    }, id);
    const output = path.join(os.tmpdir(), 'harbour-cron-preview'); fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'cron-live.png'), animations: 'disabled' });
    await pricing.locator('.cron-task-title button').click();
    await page.locator('.cron-run-content .cron-result').waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.cron-run-content .cron-result').textContent(), before.lastResult);
    await page.screenshot({ path: path.join(output, 'cron-live-history.png'), animations: 'disabled' });
    await page.locator('[data-tab=config]').click();
    assert.match(await page.locator('.cron-config-grid').first().textContent(), /pricing-refresh/);
    await page.locator('[data-edit]').click();
    await page.locator('#cronModal').waitFor();
    assert.equal(await page.locator('#cronInput').isVisible(), false, 'system task does not show irrelevant model input');
    await page.screenshot({ path: path.join(output, 'cron-live-editor.png'), animations: 'disabled' });
    await page.locator('#cronModalCancel').click();
    const after = await page.evaluate(async id => {
      const { jobs } = await api('/api/cron'); const job = jobs.find(j => j.id === id);
      return { lastRunId: job.lastRunId, lastStatus: job.lastStatus, lastResult: job.lastResult };
    }, id);
    assert.deepEqual(after, before, 'read-only inspection did not run or mutate the task');
    await page.evaluate(() => { location.hash = '#heartbeat'; });
    await page.locator('.cron-page').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.cron-detail-overlay').count(), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(blockedWrites, []);
    console.log(JSON.stringify({ success: true, jobId: id, status: before.lastStatus, runId: before.lastRunId, result: before.lastResult, screenshots: output }));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
