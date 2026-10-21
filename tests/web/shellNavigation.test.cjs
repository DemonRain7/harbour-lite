const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('../../vendor/folia/node_modules/playwright');
const web = path.resolve(__dirname, '../../web');
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined) });
});
after(async () => { await browser?.close(); });

// Real HTML/CSS/scripts, isolated network and mock data: no running Harbour,
// browser profile, live conversation, calendar or desktop process is touched.
async function fixture(t, hash = 'calendar', viewport = { width: 1440, height: 960 }, options = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  context.setDefaultTimeout(8000);
  t.after(() => context.close());
  const calls = [], writes = [], errors = [], fontRequests = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== 'harbour-shell.test') return route.fulfill({ status: 204 });
    if (url.pathname.endsWith('.woff2')) {
      fontRequests.push(url.pathname);
      if (options.blockFonts) return route.abort();
    }
    if (url.pathname.startsWith('/api/')) {
      calls.push(url.pathname);
      if (request.method() !== 'GET') {
        writes.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({ status: 403, json: { error: 'Read-only UI fixture' } });
      }
      let value = {};
      switch (url.pathname) {
        case '/api/time-settings': value = { timeZone: 'America/New_York', revision: 1 }; break;
        case '/api/asks': value = { asks: [] }; break;
        case '/api/calendar/status': value = { connected: true, configured: true }; break;
        case '/api/calendar/calendars': value = { calendars: [{ id: 'primary', summary: '我的日程', primary: true, accessRole: 'owner', timeZone: 'America/New_York' }] }; break;
        case '/api/calendar/events': value = { events: [] }; break;
        case '/api/cron': value = { jobs: [] }; break;
        case '/api/agents': value = { agents: [{ name: 'main-elaina', description: 'Elaina', skills: [] }, { name: 'main-aemeath', description: 'Aemeath', skills: [] }] }; break;
        case '/api/state': value = { defaultAgent: 'main-elaina' }; break;
        case '/api/conversations/explorer': value = { enabled: true, sessions: [] }; break;
        case '/api/skills': value = { skills: [] }; break;
        case '/api/models': value = { models: [] }; break;
        case '/api/cowork/devices': value = { devices: [] }; break;
      }
      return route.fulfill({ json: value });
    }
    const file = path.resolve(web, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404 });
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream';
    return route.fulfill({ body: fs.readFileSync(file), contentType: mime });
  });
  await context.addInitScript(({ desktop }) => {
    window.WebSocket = class extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
      readyState = 0;
      constructor() { super(); setTimeout(() => { this.readyState = 1; this.onopen?.(new Event('open')); }, 0); }
      send() {}
      close() { this.readyState = 3; }
    };
    window.petCalls = [];
    window.harbourDesktop = {
      isElectron: desktop,
      petCatalog: [{ id: 'elaina', agentName: 'main-elaina', displayName: 'Elaina' }, { id: 'aemeath', agentName: 'main-aemeath', displayName: '爱弥斯' }],
      setCompanionAppearance: async () => {}, getCompanionState: async () => ({}),
      petVisible: async () => false,
      showPet: async id => window.petCalls.push(id),
    };
  }, { desktop: options.desktop !== false });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://harbour-shell.test/#${hash}`);
  await page.waitForFunction(() => document.querySelector('#content')?.textContent.trim() !== '加载中…' && document.querySelectorAll('#navPrimary a').length === 5);
  if (hash === 'calendar') await page.locator('[data-cal-grid] button').first().waitFor();
  t.after(() => { assert.deepEqual(errors, [], 'uncaught browser errors'); assert.deepEqual(writes, [], 'navigation must not write data'); });
  return { page, calls, fontRequests };
}

test('five primary destinations, explicit secondary disclosure and no sticky expansion after reload', async t => {
  const { page } = await fixture(t);
  await page.evaluate(() => localStorage.setItem('harbour-nav-more', 'open'));
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#navPrimary a').length === 5);
  assert.equal(await page.evaluate(() => localStorage.getItem('harbour-nav-more')), null, 'legacy open preference is retired');
  assert.deepEqual(await page.locator('#navPrimary a').allTextContents(), ['Main Chat', '空间', 'Town', 'Calendar', 'Folia']);
  assert.equal(await page.locator('#navMore').getAttribute('open'), null);
  assert.equal(await page.locator('#navSecondary a').count(), 10);
  assert.equal(await page.locator('.topbar .brand').innerText(), 'Harbour');
  assert.equal(await page.locator('#topStatus, #pillWs, #pillMock, #pillUptime, #pillRun, .brand-sub, .brand-avatar').count(), 0);
  assert.equal(await page.locator('.topbar #desktopPetQuick').count(), 0);
  await page.locator('#navToggle').click();
  assert.equal(await page.locator('#navToggle').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('#navSecondary a').first().isVisible(), false);
  await page.locator('#navMore summary').waitFor({ state: 'visible' });
  await page.locator('#navMore summary').hover(); // Keep the pointer inside the hover-dismiss drawer.
  await page.locator('#navMore summary').focus();
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#navMore summary')), true, await page.locator('#sidebar').evaluate(el => JSON.stringify({ rect: el.getBoundingClientRect().toJSON(), visible: getComputedStyle(el).visibility, shell: el.parentElement.className, focused: document.activeElement.outerHTML.slice(0, 180) })));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#navMore').open);
  await page.locator('#navSecondary a').first().waitFor({ state: 'visible' });
  assert.equal(await page.locator('#navSecondary a').first().isVisible(), true);
  await page.locator('#desktopPetQuick').click();
  await page.waitForFunction(() => window.petCalls.length === 1);
  assert.deepEqual(await page.evaluate(() => window.petCalls), ['elaina']);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#navPrimary a').length === 5);
  assert.equal(await page.locator('#navMore').getAttribute('open'), null, 'reload always starts collapsed');
  await page.locator('#navToggle').click();
  await page.locator('#navMore summary').hover();
  await page.locator('#navMore summary').focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#navMore').open);
  await page.locator('#navMore summary').click();
  await page.waitForFunction(() => !document.querySelector('#navMore').open);
  assert.equal(await page.evaluate(() => localStorage.getItem('harbour-nav-more')), null, 'manual toggles are not persisted');
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#navPrimary a').length === 5);
  assert.equal(await page.locator('#navMore').getAttribute('open'), null);
});

test('secondary deep links indicate the active destination without forcing disclosure', async t => {
  const { page, calls } = await fixture(t, 'cron');
  assert.equal(await page.locator('#navMore').getAttribute('open'), null);
  assert.equal(await page.locator('#navMore').evaluate(el => el.classList.contains('has-current')), true);
  assert.equal(await page.locator('#sidebar [aria-current=page]').getAttribute('href'), '#cron');
  await page.locator('#navToggle').click();
  await page.locator('#navMore summary').click();
  assert.equal(await page.locator('#navSecondary a[href="#cron"]').isVisible(), true);
  await page.locator('#navMore summary').click();
  await page.evaluate(() => setActiveNav('cron'));
  assert.equal(await page.locator('#navMore').getAttribute('open'), null, 'active state updates respect manual collapse');
  await page.locator('#navPrimary a[href="#chat"]').click();
  await page.waitForFunction(() => document.querySelector('#chatInput') && document.body.dataset.panel === 'chat');
  assert.equal(await page.locator('#sidebar [aria-current=page]').getAttribute('href'), '#chat');
  assert.equal(await page.locator('#navToggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#navMore').evaluate(el => el.classList.contains('has-current')), false);
  // The removed status strip must not leave a background /api/state poll.
  await page.waitForTimeout(4300);
  assert.equal(calls.filter(call => call === '/api/state').length, 1, 'only initial chat persona lookup, no status polling');
});

test('theme typography, compact sidebar, mobile layout and readable expanded entries', async t => {
  const { page, fontRequests } = await fixture(t);
  const screenshots = process.env.HARBOUR_SHELL_PREVIEW_DIR || path.join(os.tmpdir(), 'harbour-shell-preview');
  fs.mkdirSync(screenshots, { recursive: true });
  for (const [category, persona, variant] of [['premium', 'neutral', 'premium-champagne'], ['anime', 'elaina', 'anime-wisteria'], ['anime', 'aemeath', 'anime-snowfleece']]) {
    await page.evaluate(([cat, per, theme]) => applyTheme(cat, per, theme), [category, persona, variant]);
    const loaded = await page.locator('.brand-name').evaluate(async el => {
      const style = getComputedStyle(el);
      const fonts = await document.fonts.load(`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`, el.textContent);
      return fonts.map(font => ({ family: font.family, status: font.status }));
    });
    assert.equal(loaded.length, 1, 'wordmark uses a real local font even when all external fonts are blocked');
    assert.equal(loaded[0].status, 'loaded');
    assert.equal(loaded[0].family, category === 'anime' ? 'Harbour Hand' : 'Harbour Editorial');
    for (const width of [1440, 960, 820, 761, 760, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('#navToggle').hover(); // Cancel the normal pointer-leave close timer.
      await page.locator('#navToggle').focus();
      if (await page.locator('#navToggle').getAttribute('aria-expanded') !== 'true') await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('#sidebar').getBoundingClientRect().left >= 0);
      await page.locator('#navMore').evaluate(el => { el.open = false; });
      const metrics = await page.evaluate(() => {
        const brand = document.querySelector('.brand-name'), nav = document.querySelector('#sidebar'), bar = document.querySelector('.topbar');
        const rect = nav.getBoundingClientRect();
        const wordmark = brand.parentElement.getBoundingClientRect(), text = brand.getBoundingClientRect(), header = bar.getBoundingClientRect();
        const identity = document.querySelector('.topbar-identity').getBoundingClientRect(), themes = document.querySelector('.topbar-theme').getBoundingClientRect();
        return { font: getComputedStyle(brand).fontFamily, expectedFont: getComputedStyle(brand).getPropertyValue('--brand-font').trim(), brandWidth: text.width,
          textFits: text.left >= wordmark.left && text.right <= wordmark.right && text.top >= header.top && text.bottom <= header.bottom,
          identityFits: identity.left >= 0 && identity.right <= themes.left && identity.top >= header.top && identity.bottom <= header.bottom,
          height: header.height, animation: getComputedStyle(brand).animationName,
          overflow: bar.scrollWidth - bar.clientWidth, left: rect.left, right: rect.right, bottom: rect.bottom, windowWidth: innerWidth, windowHeight: innerHeight };
      });
      assert.equal(metrics.font.replace(/['"]/g, ''), metrics.expectedFont.replace(/['"]/g, ''));
      assert.ok(metrics.brandWidth > 50, 'brand remains visible');
      assert.ok(metrics.textFits, `wordmark fits the existing header at ${width}: ${JSON.stringify(metrics)}`);
      assert.ok(metrics.identityFits, `identity cluster never overlaps theme controls at ${width}: ${JSON.stringify(metrics)}`);
      assert.equal(metrics.height, 58, 'branding must not make the header taller');
      assert.equal(metrics.animation, 'none', 'wordmark is static, not a render loop');
      assert.ok(metrics.overflow <= 1, `header overflow at ${width}: ${metrics.overflow}`);
      // Responsive header must not "fit" by clipping the theme popup inside a scroller.
      const picker = page.locator('.topbar-theme [data-hs-for="themeVariant"] .hs-trigger');
      await picker.click();
      await page.waitForFunction(() => {
        const menu = document.querySelector('#themeVariant-menu');
        return menu && getComputedStyle(menu).visibility === 'visible';
      });
      const popup = await page.locator('#themeVariant-menu').evaluate(menu => {
        const r = menu.getBoundingClientRect(), option = menu.querySelector('.hs-option'), opt = option.getBoundingClientRect();
        return { left: r.left, right: r.right, height: r.height, inView: r.left >= 0 && r.right <= innerWidth,
          hit: option.contains(document.elementFromPoint(opt.x + opt.width / 2, opt.y + opt.height / 2)) };
      });
      assert.ok(popup.inView && popup.height > 70 && popup.hit, `theme picker remains usable at ${width}: ${JSON.stringify(popup)}`);
      await page.keyboard.press('Escape');
      const icon = await page.locator('#navPrimary svg').first().evaluate(el => ({ width: el.getBoundingClientRect().width, stroke: getComputedStyle(el).stroke, display: getComputedStyle(el.parentElement).display }));
      assert.equal(icon.width, 20, JSON.stringify(icon));
      assert.notEqual(icon.stroke, 'none');
      assert.notEqual(icon.display, 'none');
      if (width === 1440 || width === 390) await page.screenshot({ path: path.join(screenshots, `${category}-${persona}-${width}.png`), animations: 'disabled' });
      if (width === 1440) {
        await page.mouse.move(420, 90);
        await page.waitForFunction(() => document.querySelector('#navToggle').getAttribute('aria-expanded') === 'false');
        await page.evaluate(() => document.activeElement.blur());
        await page.locator('.topbar').screenshot({ path: path.join(screenshots, `wordmark-${category}-${persona}.png`), animations: 'disabled' });
        await page.screenshot({ path: path.join(screenshots, `identity-${category}-${persona}.png`), clip: { x: 0, y: 0, width: 320, height: 58 }, animations: 'disabled' });
      }
      assert.ok(metrics.right <= metrics.windowWidth && metrics.left >= 0 && metrics.bottom <= metrics.windowHeight, `drawer stays on screen: ${JSON.stringify(metrics)}`);
      assert.ok(await page.locator('#sidebar').evaluate(el => el.offsetHeight < 400), 'collapsed navigation fits its four destinations, without a tall empty panel');
    }
  }
  assert.deepEqual([...new Set(fontRequests)].sort(), ['/fonts/wordmark/caveat-harbour.woff2', '/fonts/wordmark/cormorant-garamond-italic-harbour.woff2']);
  assert.equal(await page.locator('.brand-flourish').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('.brand-flourish').getAttribute('focusable'), 'false');
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('#navToggle').hover();
  if (await page.locator('#navToggle').getAttribute('aria-expanded') !== 'true') await page.locator('#navToggle').click();
  await page.locator('#navMore').evaluate(el => { el.open = true; });
  await page.locator('#navSecondary a[href="#settings"]').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#navSecondary a[href="#settings"]').isVisible(), true);
  await page.screenshot({ path: path.join(screenshots, 'expanded.png'), animations: 'disabled' });
});

test('font failure preserves readable text, stable wordmark size and navigation', async t => {
  const { page } = await fixture(t, 'calendar', { width: 390, height: 900 }, { blockFonts: true });
  for (const [category, persona, variant] of [['premium', 'neutral', 'premium-champagne'], ['anime', 'elaina', 'anime-wisteria']]) {
    await page.evaluate(([cat, per, theme]) => applyTheme(cat, per, theme), [category, persona, variant]);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('.brand-name').innerText(), 'Harbour');
    const bounds = await page.locator('.brand').evaluate(el => {
      const text = el.querySelector('.brand-name').getBoundingClientRect(), rect = el.getBoundingClientRect();
      return { width: rect.width, textWidth: text.width, font: getComputedStyle(el.querySelector('.brand-name')).fontFamily,
        textFits: text.right <= rect.right, headerOverflow: el.parentElement.scrollWidth - el.parentElement.clientWidth };
    });
    assert.equal(bounds.width, 100);
    assert.ok(bounds.textFits, JSON.stringify(bounds));
    assert.ok(bounds.headerOverflow <= 1);
  }
  await page.locator('#navToggle').click();
  assert.equal(await page.locator('#navToggle').getAttribute('aria-expanded'), 'true');
});

test('quiet identity and drawer have no refresh action or empty footer', async t => {
  const { page } = await fixture(t);
  assert.equal(await page.locator('.topbar-identity > *').count(), 3);
  assert.equal(await page.locator('#desktopRefreshQuick, .topbar-utility, .nav-utilities').count(), 0);
  await page.locator('#navToggle').click();
  assert.equal(await page.locator('#navMore').getAttribute('open'), null);
  const button = page.locator('#navToggle');
  const box = await button.boundingBox();
  assert.equal(box.width, 36);
  assert.equal(box.height, 36);
  assert.ok(await button.getAttribute('aria-label'));
  assert.equal(await button.locator('svg').getAttribute('aria-hidden'), 'true');
  assert.equal(await button.locator('svg').getAttribute('focusable'), 'false');
  const icon = await button.locator('svg').evaluate(el => ({ fill: getComputedStyle(el).fill, stroke: getComputedStyle(el).strokeWidth }));
  assert.equal(icon.fill, 'none', 'icons share an unfilled stroke treatment');
  assert.equal(icon.stroke, '1.6px');
  await page.keyboard.press('Tab');
  await button.focus();
  assert.equal(await button.evaluate(el => getComputedStyle(el).outlineStyle), 'solid', 'keyboard focus remains visible');
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(await page.locator('#desktopRefreshQuick, .nav-utilities').count(), 0);
  assert.equal(await page.locator('#navToggle').isVisible(), true);
});

test('web header does not leave an empty desktop refresh slot', async t => {
  const { page } = await fixture(t, 'calendar', { width: 1440, height: 900 }, { desktop: false });
  assert.equal(await page.locator('#desktopRefreshQuick, .nav-utilities').count(), 0, 'web drawer has no empty desktop utility footer');
  assert.equal(await page.locator('.topbar-utility').count(), 0);
  assert.equal(await page.locator('#navToggle').isVisible(), true);
});

async function routed(page, panel) {
  await page.waitForFunction(panel => document.body.dataset.panel === panel && !routePending && !pageHistoryBusy, panel);
}

test('history arrows and Alt shortcuts traverse real page history, including after refresh', async t => {
  const { page } = await fixture(t);
  await routed(page, 'calendar');
  assert.equal(await page.locator('#navBack').isDisabled(), true);
  assert.equal(await page.locator('#navForward').isDisabled(), true);
  await page.evaluate(() => { location.hash = 'cron'; });
  await routed(page, 'cron');
  assert.equal(await page.locator('#navBack').isEnabled(), true);
  assert.equal(await page.locator('#navForward').isDisabled(), true);
  await page.locator('#navBack').click();
  await routed(page, 'calendar');
  assert.equal(await page.locator('#navBack').isDisabled(), true);
  assert.equal(await page.locator('#navForward').isEnabled(), true);
  await page.reload();
  await routed(page, 'calendar');
  assert.equal(await page.locator('#navForward').isEnabled(), true, 'native forward history survives refresh');
  await page.locator('#navForward').click();
  await routed(page, 'cron');
  await page.keyboard.press('Alt+ArrowLeft');
  await routed(page, 'calendar');
  await page.keyboard.press('Alt+ArrowRight');
  await routed(page, 'cron');
  assert.equal(await page.locator('#navForward').isDisabled(), true);
});

test('back then a new destination discards only the forward branch', async t => {
  const { page } = await fixture(t);
  await page.evaluate(() => { location.hash = 'cron'; }); await routed(page, 'cron');
  await page.evaluate(() => { location.hash = 'chat'; }); await routed(page, 'chat');
  await page.locator('#navBack').click(); await routed(page, 'cron');
  assert.equal(await page.locator('#navForward').isEnabled(), true);
  await page.evaluate(() => { location.hash = 'history'; }); await routed(page, 'history');
  assert.equal(await page.locator('#navForward').isDisabled(), true);
  await page.locator('#navBack').click(); await routed(page, 'cron');
  await page.locator('#navForward').click(); await routed(page, 'history');
  assert.equal(await page.locator('#navMore').getAttribute('open'), null, 'history never forces more features open');
});

test('cancelled arrow/native back preserves editor and history; discard resumes navigation', async t => {
  const { page } = await fixture(t);
  await page.evaluate(() => { location.hash = 'cron'; }); await routed(page, 'cron');
  await page.evaluate(() => {
    window.historyDraftDirty = true;
    const draft = document.createElement('input'); draft.id = 'historyDraft'; draft.value = '不要丢掉我的草稿';
    document.querySelector('#content').append(draft);
    window.HarbourUnsavedChanges.register('navigation-test', {
      label: '测试文档', isActive: () => !!document.querySelector('#historyDraft'),
      isDirty: () => window.historyDraftDirty,
      discard: () => { window.historyDraftDirty = false; },
    });
  });
  const snapshot = () => page.evaluate(() => ({ current: navigation.currentEntry.key, entries: navigation.entries().map(e => ({ key: e.key, url: e.url })) }));
  const before = await snapshot();
  await page.locator('#navBack').click();
  await page.locator('.harbour-dialog-cancel').click();
  await routed(page, 'cron');
  assert.deepEqual(await snapshot(), before, 'cancelled arrow does not move the history cursor');
  await page.evaluate(() => history.back());
  await page.locator('.harbour-dialog-cancel').click();
  await routed(page, 'cron');
  assert.deepEqual(await snapshot(), before, 'cancelled native back restores the entry, never overwrites its predecessor');
  assert.equal(await page.locator('#historyDraft').inputValue(), '不要丢掉我的草稿');
  await page.locator('#navBack').click();
  await page.locator('.harbour-dialog-discard').click();
  await routed(page, 'calendar');
  assert.equal(await page.locator('#navForward').isEnabled(), true);
  await page.locator('#navForward').click(); await routed(page, 'cron');
});

test('in-app arrows cannot leave the dashboard path or authentication query', async t => {
  const { page } = await fixture(t);
  await routed(page, 'calendar');
  for (const other of ['/other-app#calendar', '/?context=another#calendar', '/#unknown-page']) {
    await page.evaluate(other => {
      history.replaceState(null, '', other);
      history.pushState(null, '', '/#calendar');
      syncPageHistory();
    }, other);
    assert.equal(await page.locator('#navBack').isDisabled(), true);
    const before = page.url();
    await page.keyboard.press('Alt+ArrowLeft');
    assert.equal(page.url(), before);
  }
});

test('wordmark assets are small WOFF2 subsets with their redistribution notices', () => {
  let bytes = 0;
  for (const name of ['caveat-harbour.woff2', 'cormorant-garamond-italic-harbour.woff2']) {
    const data = fs.readFileSync(path.join(web, 'fonts/wordmark', name));
    assert.equal(data.subarray(0, 4).toString(), 'wOF2');
    bytes += data.length;
  }
  assert.ok(bytes < 12 * 1024, `branding font payload is ${bytes} bytes`);
  for (const name of ['Caveat-OFL.txt', 'CormorantGaramond-OFL.txt']) {
    assert.match(fs.readFileSync(path.join(web, 'fonts/wordmark', name), 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/);
  }
});
