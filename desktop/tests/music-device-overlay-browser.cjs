const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { chromium } = createRequire(path.resolve(__dirname, '../../vendor/folia/package.json'))('playwright');

// Dedicated headless Chromium with an intercepted fixture origin, never a live
// browser/profile/server, Folia runtime, audio device or visible native window.
// Unlike JSDOM this executes the original select instance .value descriptor.
const root = path.resolve(__dirname, '../..');
const readWeb = name => fs.readFileSync(path.join(root, 'web', name), 'utf8');
const source = readWeb('app.js');
const sharedSelect = source.slice(source.indexOf('/* ── Harbour Select'), source.indexOf('function authToken()'));
assert.ok(sharedSelect.includes('Object.defineProperty(select, "value"'), 'fixture must exercise the real select value proxy');
const css = ['themes.css', 'styles.css', 'music.css'].map(readWeb).join('\n');
const reports = path.join(root, 'assets/reports/folia/device-menu');
const screenshots = process.argv.includes('--screenshots');
const themes = [
  ['premium', 'neutral', 'premium-champagne'], ['premium', 'neutral', 'premium-tungsten'],
  ['anime', 'elaina', 'anime-wisteria'], ['anime', 'elaina', 'anime-sky'],
  ['anime', 'aemeath', 'anime-snowfleece'], ['anime', 'aemeath', 'anime-stardust'], ['anime', 'aemeath', 'anime-neon'],
];
const trigger = '[data-hs-for="musicDevice"] .hs-trigger';
const wrap = '[data-hs-for="musicDevice"]';
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function fixture(browser, { native = true, twoDevices = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: [], reducedMotion: 'reduce' });
  const external = [], errors = [];
  await context.route('**/*', route => {
    if (route.request().url() === 'http://harbour-device-menu.test/') return route.fulfill({ status: 200, contentType: 'text/html', body:
      '<!doctype html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body data-panel="music" data-theme-cat="anime" data-persona="elaina" data-theme="anime-wisteria">'
      + '<header id="fixtureOutside" style="height:58px;padding:12px"><button id="fixtureBefore" type="button">Isolated music menu fixture</button></header><div class="shell"><aside id="sidebar" class="sidebar"></aside><main id="content" class="content"></main></div></body></html>' });
    external.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://harbour-device-menu.test/');
  await page.addScriptTag({ content: sharedSelect });
  await page.addScriptTag({ content: readWeb('music.js') });
  await page.evaluate(({ native, twoDevices }) => {
    window.__calls = { resize: [], hide: 0, open: 0, commands: [], close: 0, changes: 0 };
    window.__requests = []; window.__polls = [];
    window.setInterval = callback => { window.__polls.push(callback); return window.__polls.length; };
    window.clearInterval = () => {};
    window.__state = { provider: 'folia', mode: 'embedded', connected: true, running: true, tracks: [], paused: true };
    window.__devices = [{ id: 'local', label: 'Desktop device', music: window.__state }, ...(twoDevices ? [{ id: 'remote', label: '客厅设备', music: window.__state }] : [])];
    window.harbourDesktop = {
      coworkDeviceId: 'local', foliaOpen: async () => { window.__calls.open++; return window.__state; }, foliaStatus: async () => window.__state,
      foliaResize: (bounds, visible) => window.__calls.resize.push({ bounds, visible }), foliaHide: async () => { window.__calls.hide++; },
      foliaDeviceMenu: native ? request => new Promise((resolve, reject) => window.__requests.push({ request, resolve, reject })) : undefined,
      foliaCloseDeviceMenu: () => { window.__calls.close++; },
      foliaCommand: async request => { window.__calls.commands.push(request); return {}; },
    };
    const esc = text => String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    window.__dispose = window.HarbourMusicUI.mount(document.querySelector('#content'), {
      api: async (url, options) => {
        if (url.startsWith('/api/music/devices')) return { devices: window.__devices };
        window.__calls.commands.push({ url, options }); return { result: { tracks: [] } };
      }, esc,
    });
    initHarbourSelects();
    document.querySelector('#musicDevice').addEventListener('change', () => window.__calls.changes++);
  }, { native, twoDevices });
  await page.waitForFunction(() => document.querySelector('#musicDevice').value === 'local' && document.querySelector('#musicMode').textContent === '此页播放');
  await settle(page);
  return { page, errors, external, close: async () => { await page.evaluate(() => window.__dispose()); await context.close(); } };
}

const snapshot = page => page.evaluate(() => {
  const select = document.querySelector('#musicDevice'), container = select.closest('.harbour-select'), menu = container.querySelector('.hs-menu');
  const r = document.querySelector('#musicStage').getBoundingClientRect();
  return { value: select.value, stage: { x: r.x, y: r.y, width: r.width, height: r.height }, expanded: container.querySelector('.hs-trigger').getAttribute('aria-expanded'),
    display: getComputedStyle(menu).display, inset: document.querySelector('#content').style.getPropertyValue('--music-device-menu-inset'),
    margin: getComputedStyle(document.querySelector('#musicBody')).marginTop, calls: JSON.parse(JSON.stringify(window.__calls)),
    focused: document.activeElement.matches('[data-hs-for="musicDevice"] .hs-trigger') };
});
const openNative = async page => {
  const before = await page.evaluate(() => window.__requests.length);
  await page.locator(trigger).click();
  await page.waitForFunction(count => window.__requests.length === count + 1, before);
  return before;
};
const reply = async (page, index, value) => { await page.evaluate(({ index, value }) => window.__requests[index].resolve(value), { index, value }); await settle(page); };

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.HARBOUR_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--mute-audio', '--disable-background-networking', '--disable-component-update'] });
  try {
    let f = await fixture(browser);
    try {
      const { page } = f, baseline = await snapshot(page);
      assert.equal(await page.evaluate(() => typeof Object.getOwnPropertyDescriptor(document.querySelector('#musicDevice'), 'value').set), 'function');
      let index = await openNative(page), opened = await snapshot(page);
      assert.equal(opened.expanded, 'true'); assert.equal(opened.display, 'none'); assert.deepEqual(opened.stage, baseline.stage);
      assert.deepEqual(opened.calls.resize, baseline.calls.resize); assert.equal(opened.calls.hide, baseline.calls.hide); assert.equal(opened.calls.open, 0);
      assert.equal(opened.inset, ''); assert.equal(opened.margin, '0px');
      const request = await page.evaluate(index => window.__requests[index].request, index);
      assert.deepEqual(request.items.map(item => item.value), ['local', 'remote']); assert.equal(request.items[0].selected, true);
      assert.equal(request.items[0].label, 'Desktop device'); assert.ok(request.anchor.width > 0 && request.anchor.height > 0);
      await page.evaluate(async () => { for (const poll of window.__polls) await poll(); }); await settle(page);
      assert.equal((await snapshot(page)).expanded, 'true', 'unchanged real refresh retains native menu');
      await reply(page, index, { value: 'local' });
      const same = await snapshot(page); assert.equal(same.value, 'local'); assert.equal(same.calls.changes, 0); assert.equal(same.focused, true);
      assert.deepEqual(same.stage, baseline.stage); assert.deepEqual(same.calls.resize, baseline.calls.resize); assert.equal(same.calls.hide, 0); assert.deepEqual(same.calls.commands, []);

      index = await openNative(page); await reply(page, index, { value: 'remote' });
      const changed = await snapshot(page); assert.equal(changed.value, 'remote'); assert.equal(changed.calls.changes, 1);
      assert.equal(await page.evaluate(() => localStorage.getItem('harbour-music-device')), 'remote');
      assert.equal(changed.expanded, 'false'); assert.equal(changed.focused, true); assert.equal(changed.calls.hide, 1);
      assert.deepEqual(changed.calls.commands, [], 'changing control target never starts playback');
      assert.deepEqual(f.errors, []);
      console.log('MUSIC_DEVICE_BROWSER_VALUE_OK: unmodified Chromium select descriptor; remote change once and same-device no-op');
    } finally { await f.close(); }

    f = await fixture(browser);
    try {
      const { page } = f, baseline = await snapshot(page);
      const stale = await openNative(page);
      await page.locator(trigger).click();
      const current = await openNative(page);
      await reply(page, stale, { value: 'remote' });
      assert.equal((await snapshot(page)).value, 'local'); assert.equal((await snapshot(page)).expanded, 'true');
      await reply(page, current, { dismiss: 'escape' }); assert.equal((await snapshot(page)).focused, true);
      const tabbed = await openNative(page); await reply(page, tabbed, { dismiss: 'tab' });
      assert.equal(await page.evaluate(() => document.activeElement.matches('[data-music="embedded"]')), true, 'Tab advances to the next visible header action');
      const backTabbed = await openNative(page); await reply(page, backTabbed, { dismiss: 'shift-tab' });
      assert.equal(await page.evaluate(() => document.activeElement.id), 'fixtureBefore', 'Shift-Tab returns to the preceding visible action');
      await page.locator(trigger).focus();
      const keyboardIndex = await page.evaluate(() => window.__requests.length);
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await settle(page);
      assert.equal((await snapshot(page)).focused, true, 'pending native menu never focuses invisible DOM options');
      await reply(page, keyboardIndex, { dismiss: 'escape' });
      const disabled = await openNative(page);
      await page.evaluate(() => { document.querySelector('#musicDevice').options[2].disabled = true; }); await settle(page);
      assert.equal((await snapshot(page)).expanded, 'false'); await reply(page, disabled, { value: 'remote' }); assert.equal((await snapshot(page)).value, 'local');
      await page.evaluate(() => { document.querySelector('#musicDevice').options[2].disabled = false; }); await settle(page);
      const outside = await openNative(page); await page.locator('#fixtureOutside').click();
      assert.equal((await snapshot(page)).expanded, 'false'); await reply(page, outside, { value: 'remote' }); assert.equal((await snapshot(page)).value, 'local');
      const resized = await openNative(page); await page.setViewportSize({ width: 1200, height: 900 }); await settle(page);
      assert.equal((await snapshot(page)).expanded, 'false'); await reply(page, resized, { value: 'remote' }); assert.equal((await snapshot(page)).value, 'local');
      const unmounted = await openNative(page);
      await page.evaluate(() => { window.__dispose(); document.querySelector('#content').replaceChildren(); });
      await reply(page, unmounted, { value: 'remote' });
      assert.equal(await page.evaluate(() => localStorage.getItem('harbour-music-device')), null);
      assert.equal(await page.evaluate(() => window.__calls.changes), 0);
      assert.deepEqual(await page.evaluate(() => window.__calls.commands), baseline.calls.commands); assert.deepEqual(f.errors, []);
      console.log('MUSIC_DEVICE_BROWSER_RACE_OK: late replies, rapid reopen, disabled option, outside, resize, unmount');
    } finally { await f.close(); }

    f = await fixture(browser, { native: false, twoDevices: false });
    try {
      const { page } = f;
      for (const [category, persona, theme] of themes) {
        await page.evaluate(({ category, persona, theme }) => { document.body.dataset.themeCat = category; document.body.dataset.persona = persona; document.body.dataset.theme = theme; }, { category, persona, theme });
        for (const width of [520, 860, 1400]) {
          await page.setViewportSize({ width, height: 900 }); await settle(page);
          const before = await snapshot(page);
          await page.locator(trigger).click();
          await page.waitForFunction(() => document.querySelector('[data-hs-for="musicDevice"] .hs-menu').style.visibility === 'visible');
          const dimensions = await page.evaluate(() => {
            const menu = document.querySelector('[data-hs-for="musicDevice"] .hs-menu'), r = menu.getBoundingClientRect();
            return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
              viewportWidth: innerWidth, viewportHeight: innerHeight, scroll: menu.scrollHeight - menu.clientHeight,
              count: menu.querySelectorAll('.hs-option').length,
              onTop: menu.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
          });
          assert.ok(dimensions.width <= 273 && dimensions.width >= 260 && dimensions.height < 150, JSON.stringify({ theme, width, dimensions }));
          assert.ok(dimensions.x >= 0 && dimensions.right <= width && dimensions.bottom <= 900 && dimensions.onTop, JSON.stringify({ theme, width, dimensions }));
          assert.equal(dimensions.scroll, 0); assert.equal(dimensions.count, 1);
          assert.deepEqual((await snapshot(page)).stage, before.stage, `${theme}/${width}: DOM fallback floats without layout changes`);
          if (screenshots && width === 1400 && theme === 'anime-wisteria') {
            fs.mkdirSync(reports, { recursive: true });
            await page.screenshot({ path: path.join(reports, 'headless-dom-menu-wisteria.png') });
          }
          await page.locator(`${wrap} .hs-option`).click(); assert.equal((await snapshot(page)).calls.changes, 0);
        }
      }
      assert.deepEqual(f.errors, []);
      console.log('MUSIC_DEVICE_BROWSER_LAYOUT_OK: real CSS; compact DOM fallback across 7 themes × 3 widths, no stage reflow');
    } finally { await f.close(); }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
