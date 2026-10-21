// Opt-in, real backend/model smoke. No mutations requested from the agents.
// Run: node tests/web/townLive.cjs --live
const assert = require('node:assert/strict');
const { openTownMenu, visitTownResident } = require('./town-ui.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('../../vendor/folia/node_modules/playwright');
async function main() {
  const modelPreview = process.argv.includes('--models-only');
  if (!process.argv.includes('--live') && !modelPreview) throw new Error('Use --live for real Main calls, or --models-only for local rendering without LLM calls.');
  const base = process.env.HARBOUR_URL || 'http://localhost:7788';
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined) });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    // Optional CI/local secret only enters same-origin storage, never screenshots/logs/URLs.
    if (process.env.HARBOUR_TOKEN) await context.addInitScript(token => localStorage.setItem('harbour-token', token), process.env.HARBOUR_TOKEN);
    const page = await context.newPage(); const errors = [], runs = [];
    page.on('request', r => { if (new URL(r.url()).pathname === '/api/run') runs.push(r.url()); });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/#town`);
    await page.locator('.town-frame').waitFor({ timeout: 25000 });
    const frame = page.frames().find(f => f.url().includes('/town/index.html'));
    await frame.waitForFunction(() => window.HarbourTown?.status().ready, { timeout: 150000 });
    const output = process.env.TOWN_SCREENSHOT_DIR || path.join(os.tmpdir(), 'harbour-town-preview'); fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'town-harbour-live.png') });
    for (const id of ['main-elaina', 'main-aemeath', ...(modelPreview ? ['chisa'] : [])]) {
      await visitTownResident(frame, '' + id + '');
      if (modelPreview) {
        const count = await frame.evaluate(() => HarbourTown.status().frames);
        await frame.waitForFunction(n => HarbourTown.status().frames > n + 1, count);
        const model = await frame.evaluate(id => HarbourTown.status().models.find(m => m.id === id), id);
        assert.equal(model.type, 'mmd'); assert.equal(model.activeMorphs, 4);
        await page.screenshot({ path: path.join(output, `town-${id}-installed.png`) });
        console.log(JSON.stringify({ agent: id, variant: model.variant, bones: model.bones, activeMorphs: model.activeMorphs }));
        continue;
      }
      await frame.locator('#interact').waitFor({ state: 'visible' }); await frame.locator('#interact').click();
      await frame.locator('[data-social="chat"]').click();
      await frame.locator('#send').waitFor();
      await frame.waitForFunction(() => !document.getElementById('send').disabled);
      await frame.locator('#message').fill('这是 Harbour 小镇接入测试。请只用一句话向刚来到樱花车站的我打招呼；不要调用工具、创建任务或修改任何文件。');
      const response = page.waitForResponse(r => r.url() === `${base}/api/run` && r.request().method() === 'POST', { timeout: 180000 });
      await frame.locator('#send').click();
      const receipt = await response; const data = await receipt.json();
      assert.equal(receipt.ok(), true, JSON.stringify({ status: receipt.status(), error: data.error }));
      assert.equal(data.agent, id); assert.ok(data.answer);
      await frame.waitForFunction(() => !HarbourTown.status().busy);
      console.log(JSON.stringify({ agent: id, runId: data.runId, sessionId: data.session?.id, answer: data.answer, durationMs: data.durationMs }));
      await page.screenshot({ path: path.join(output, `town-${id}-live.png`) });
      await frame.locator('#chat-close').click();
    }
    // Sidebar navigation retains the same renderer/world without drawing offscreen.
    await page.evaluate(() => { window.retainedTown = document.querySelector('.town-frame').contentWindow.HarbourTown; });
    await page.evaluate(() => { location.hash = '#calendar'; });
    await page.locator('.town-frame').waitFor({ state: 'hidden', timeout: 10000 });
    assert.equal(await frame.evaluate(() => HarbourTown.status().destroyed), false);
    const frames = await frame.evaluate(() => HarbourTown.status().frames);
    await page.waitForTimeout(200);
    assert.equal(await frame.evaluate(() => HarbourTown.status().frames), frames);
    await page.evaluate(() => { location.hash = '#town'; });
    await page.locator('.town-frame').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => retainedTown === document.querySelector('.town-frame').contentWindow.HarbourTown), true);
    await frame.waitForFunction(n => HarbourTown.status().frames > n, frames);
    assert.deepEqual(errors, []);
    if (modelPreview) assert.equal(runs.length, 0, 'render-only validation never starts Main');
    console.log((modelPreview ? 'Installed local models verified, no LLM calls. ' : 'Live town integration passed. ') + 'Screenshots: ' + output);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
