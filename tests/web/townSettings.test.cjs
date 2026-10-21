const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('../../vendor/folia/node_modules/playwright');
const web = path.resolve(__dirname, '../../web');
const { openTownMenu } = require('./town-ui.cjs');
let server, browser, url;

// The shipping markup, CSS and panel controller, without a GPU, server or Main.
// Real scene / fullscreen / popout regression remains in townBrowser.test.cjs.
const markup = fs.readFileSync(path.join(web, 'town/index.html'), 'utf8').replace('<script type="module" src="./main.js"></script>', `<script type="module">
import { bindTownSettings } from './settings-panel.js';
window.events = []; window.life = new AbortController();
document.getElementById('loading').hidden = true;
window.settings = bindTownSettings({ signal: life.signal, onOpenChange(open) { events.push(open); } });
window.canvasClicks = 0; window.chatEscapes = 0;
document.getElementById('scene').addEventListener('click', () => canvasClicks++);
document.addEventListener('keydown', e => { if (e.key === 'Escape') chatEscapes++; });
</script>`);
before(async () => {
  server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://fixture').pathname;
    if (name === '/town/index.html') { res.setHeader('Content-Type', 'text/html'); return res.end(markup); }
    const file = path.resolve(web, '.' + decodeURIComponent(name));
    if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
    res.setHeader('Content-Type', ({ '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/town/index.html`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined) });
});
after(async () => { await browser?.close(); server?.closeAllConnections(); server?.close(); });
async function pageFor(t, viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport }); t.after(() => page.close());
  await page.goto(url); await page.waitForFunction(() => !!window.settings); return page;
}

test('one settings entry, labelled controls, overlay does not shift or resize the scene', async t => {
  const page = await pageFor(t);
  assert.equal(await page.locator('.town-header button:visible').count(), 1);
  assert.equal(await page.locator('#settings-panel').isHidden(), true);
  assert.equal(await page.locator('.residents,.scene-caption,.walk-hint,.nameplate,#nameplates').count(), 0, 'no persistent sidebar, footer, slogans or floating labels');
  for (const id of ['map', 'resident-list', 'model-options', 'model-credit', 'look-hint']) assert.equal(await page.locator(`#${id}`).isVisible(), false, id);
  const bounds = await page.locator('#scene').boundingBox();
  await page.getByRole('button', { name: '小镇菜单', exact: true }).click();
  assert.equal(await page.locator('#settings-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.getByRole('dialog', { name: '小镇' }).isVisible(), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-close');
  assert.equal(await page.getByRole('tab', { name: '居民' }).getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: '场景' }).click();
  assert.equal(await page.getByLabel('画质', { exact: true }).isVisible(), true);
  assert.equal(await page.getByLabel('帧率上限', { exact: true }).isVisible(), true);
  assert.deepEqual(await page.locator('#scene').boundingBox(), bounds);
  await page.locator('#settings-close').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-toggle');
  assert.deepEqual(await page.evaluate(() => events), [true, false]);
});

test('Escape dismisses only settings; clicking scene dismisses without locking on the same click', async t => {
  const page = await pageFor(t);
  await page.locator('#settings-toggle').click(); await page.keyboard.press('Escape');
  assert.equal(await page.locator('#settings-panel').isHidden(), true);
  assert.equal(await page.evaluate(() => chatEscapes), 0, 'do not close a conversation underneath');
  await page.locator('#settings-toggle').click();
  await page.locator('#scene').click({ position: { x: 650, y: 350 } });
  assert.equal(await page.locator('#settings-panel').isHidden(), true);
  assert.equal(await page.evaluate(() => canvasClicks), 0, 'dismissal is not pointer-lock permission');
  await page.locator('#scene').click({ position: { x: 650, y: 350 } });
  assert.equal(await page.evaluate(() => canvasClicks), 1);
  await page.locator('#settings-toggle').click();
  await page.locator('#scene').focus();
  assert.equal(await page.locator('#settings-panel').isHidden(), true, 'keyboard can leave this non-modal panel');
});

test('narrow and short windows keep the panel on screen and every option reachable', async t => {
  for (const viewport of [{ width: 390, height: 760 }, { width: 320, height: 480 }, { width: 740, height: 360 }]) {
    const page = await pageFor(t, viewport);
    await openTownMenu(page);
    const rect = await page.locator('#settings-panel').boundingBox();
    assert.ok(rect.x >= 0 && rect.x + rect.width <= viewport.width);
    assert.ok(rect.y >= 0 && rect.y + rect.height <= viewport.height);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#pause').click();
    const pause = await page.locator('#pause').boundingBox(), pane = await page.locator('#panel-scene').boundingBox();
    assert.ok(pause.y >= pane.y && pause.y + pause.height <= pane.y + pane.height, 'last action scrolls into panel viewport');
    assert.equal(await page.locator('#settings-close').isVisible(), true, 'close stays outside the scroll area');
    await page.getByRole('tab', { name: '帮助' }).click();
    await page.locator('.town-about summary').click();
    await page.locator('#model-credit').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#model-credit').isVisible(), true);
    await page.locator('#settings-close').click();
    assert.equal(await page.locator('#settings-panel').isHidden(), true);
  }
});

test('M opens the menu, tabs support arrows, editing text never toggles it, chat draft survives', async t => {
  const page = await pageFor(t);
  await page.locator('#scene').focus(); await page.keyboard.press('m');
  assert.equal(await page.locator('#settings-panel').isVisible(), true);
  await page.getByRole('tab', { name: '居民' }).focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: '场景' }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#panel-residents').isHidden(), true);
  await page.keyboard.press('End');
  assert.equal(await page.getByRole('tab', { name: '帮助' }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Home');
  assert.equal(await page.getByRole('tab', { name: '居民' }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('m');
  assert.equal(await page.locator('#settings-panel').isHidden(), true);
  await page.evaluate(() => { document.getElementById('chat').hidden = false; });
  await page.locator('#message').fill('my draft'); await page.keyboard.press('m');
  assert.equal(await page.locator('#settings-panel').isHidden(), true);
  const draft = await page.locator('#message').inputValue();
  await page.locator('#settings-toggle').click();
  assert.equal(await page.locator('#chat').isVisible(), false, 'only one panel occupies the scene');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#chat').isVisible(), true);
  assert.equal(await page.locator('#message').inputValue(), draft);
});

test('hidden page dismisses without stealing focus, teardown removes panel listeners', async t => {
  const page = await pageFor(t);
  await page.locator('#settings-toggle').click();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(await page.locator('#settings-panel').isHidden(), true);
  await page.evaluate(() => { delete document.hidden; life.abort(); });
  await page.locator('#settings-toggle').click();
  assert.deepEqual(await page.evaluate(() => events), [true, false]);
});
