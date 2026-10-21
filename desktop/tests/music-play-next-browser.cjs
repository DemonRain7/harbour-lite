const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { chromium } = createRequire(path.resolve(__dirname, '../../vendor/folia/package.json'))('playwright');

// desktop/tests/music-play-next-browser.cjs
// Real Chromium layout and trusted input against an intercepted, offline fixture.
// No server, live player, accounts, audio, browser profile or visible native window.
const root = path.resolve(__dirname, '../..');
const readWeb = name => fs.readFileSync(path.join(root, 'web', name), 'utf8');
const css = ['themes.css', 'styles.css', 'music.css'].map(readWeb).join('\n');
const reports = path.join(root, 'assets/reports/folia/play-next');
const themes = [['premium', 'neutral', 'premium-champagne'], ['anime', 'elaina', 'anime-wisteria']];
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function fixture(browser, category, persona, theme, width) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 820 }, permissions: [], reducedMotion: 'reduce', serviceWorkers: 'block' });
  const errors = [], intercepted = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url === 'http://harbour-play-next.test/') return route.fulfill({ status: 200, contentType: 'text/html', body:
      '<!doctype html><html><head><meta charset="utf-8"><style>' + css + '</style></head>'
      + `<body data-panel="music" data-theme-cat="${category}" data-theme-persona="${persona}" data-persona="${persona}" data-theme="${theme}">`
      + '<div class="shell" style="height:100vh"><main id="content" class="content"></main></div></body></html>' });
    intercepted.push(url);
    // Keep original CSS, but prevent its optional Google Font import from networking.
    if (url.startsWith('https://fonts.googleapis.com/')) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://harbour-play-next.test/');
  await page.addScriptTag({ content: readWeb('music.js') });
  await page.evaluate(() => {
    window.__calls = [];
    window.setInterval = () => 0;
    window.clearInterval = () => {};
    const tracks = [
      { id: 'A', title: '正在播放 · 不会被打断', artist: 'Fixture Artist' },
      { id: 'B', title: 'An extraordinarily long English song title — Extended midnight orchestral edition', artist: 'A very long artist name and another very long collaborator' },
      { id: 'C', title: '这是一首特别特别长的中文歌曲标题用于验证下一首播放按钮不会遮挡歌曲名称', artist: '中文歌手与非常非常长的联合演奏者姓名' },
    ];
    window.__state = { provider: 'folia', connected: true, running: true, loaded: true, paused: false, currentTrackId: 'A',
      tracks, playbackMode: 'off', playbackModeAvailable: true, playNextAvailable: true };
    window.harbourDesktop = {
      coworkDeviceId: 'fixture', foliaOpen: async () => window.__state, foliaStatus: async () => window.__state,
      foliaResize() {}, foliaHide: async () => {},
      foliaCommand: async command => { window.__calls.push(command); return { accepted: true, ...window.__state }; },
    };
    const esc = text => String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    window.__dispose = window.HarbourMusicUI.mount(document.querySelector('#content'), {
      api: async () => ({ devices: [{ id: 'fixture', label: 'Offline layout fixture', music: window.__state }] }), esc,
    });
  });
  await page.waitForFunction(() => document.querySelector('#musicDevice').value === 'fixture');
  await page.locator('#musicControlToggle').click();
  await page.waitForFunction(() => document.querySelectorAll('.music-result-row').length === 3);
  // A constrained drawer models the actual right-hand panel independently of window size.
  await page.locator('#musicRemote').evaluate((element, width) => { element.style.flexBasis = `${width}px`; }, width);
  await settle(page);
  return { page, errors, intercepted, close: async () => { await page.evaluate(() => window.__dispose()); await context.close(); } };
}

async function inspectLayout(page) {
  return page.evaluate(() => {
    const rect = element => {
      const value = element.getBoundingClientRect();
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
    };
    const panel = document.querySelector('#musicRemote'), results = document.querySelector('#musicResults');
    return {
      panel: rect(panel), panelOverflow: panel.scrollWidth - panel.clientWidth, resultsOverflow: results.scrollWidth - results.clientWidth,
      rows: [...document.querySelectorAll('.music-result-row')].map(row => {
        const play = row.querySelector('[data-track]'), next = row.querySelector('[data-play-next]'), title = play.querySelector('span');
        const box = rect(next), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return { id: play.dataset.track, row: rect(row), play: rect(play), next: box, title: rect(title),
          titleClipped: title.scrollWidth > title.clientWidth, titleOverflow: getComputedStyle(title).textOverflow,
          actionOverflow: next.scrollWidth - next.clientWidth, rowOverflow: row.scrollWidth - row.clientWidth,
          hitId: hit?.closest('[data-play-next]')?.dataset.playNext, disabled: next.disabled };
      }),
    };
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.HARBOUR_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--mute-audio', '--disable-background-networking', '--disable-component-update'] });
  const cases = [];
  try {
    fs.mkdirSync(reports, { recursive: true });
    for (const [category, persona, theme] of themes) for (const width of [340, 240]) {
      const f = await fixture(browser, category, persona, theme, width);
      try {
        const layout = await inspectLayout(f.page);
        assert.equal(Math.round(layout.panel.width), width);
        assert.ok(layout.panelOverflow <= 1, `${theme}/${width}: panel horizontal overflow`);
        assert.ok(layout.resultsOverflow <= 1, `${theme}/${width}: results horizontal overflow`);
        for (const row of layout.rows) {
          assert.ok(row.play.right <= row.next.left, `${theme}/${width}/${row.id}: actions overlap`);
          assert.ok(row.title.right <= row.next.left && row.title.width > 24, `${theme}/${width}/${row.id}: title occluded`);
          assert.ok(row.next.right <= layout.panel.right && row.rowOverflow <= 1 && row.actionOverflow <= 1, `${theme}/${width}/${row.id}: action overflow`);
          assert.equal(row.hitId, row.id, 'actual hit-testing belongs to the next action, never the play action');
          if (row.id !== 'A') { assert.equal(row.titleClipped, true); assert.equal(row.titleOverflow, 'ellipsis'); }
        }
        assert.equal(layout.rows[0].disabled, true);
        await f.page.evaluate(() => { window.__calls = []; });
        const pointer = layout.rows.find(row => row.id === 'B').next;
        await f.page.mouse.click(pointer.left + pointer.width / 2, pointer.top + pointer.height / 2);
        await settle(f.page);
        assert.deepEqual(await f.page.evaluate(() => window.__calls), [{ action: 'play_next', trackId: 'B' }]);
        assert.equal(await f.page.evaluate(() => window.__state.currentTrackId), 'A');

        await f.page.locator('[data-track="C"]').focus();
        await f.page.keyboard.press('Tab');
        assert.equal(await f.page.evaluate(() => document.activeElement.dataset.playNext), 'C');
        assert.equal(await f.page.evaluate(() => document.activeElement.matches(':focus-visible')), true);
        assert.equal(await f.page.evaluate(() => getComputedStyle(document.activeElement).outlineWidth), '2px');
        const screenshot = path.join(reports, `${theme}-${width}.png`);
        await f.page.locator('#musicRemote').screenshot({ path: screenshot, animations: 'disabled' });
        await f.page.keyboard.press('Enter'); await settle(f.page);
        assert.deepEqual(await f.page.evaluate(() => window.__calls), [{ action: 'play_next', trackId: 'B' }, { action: 'play_next', trackId: 'C' }]);
        assert.deepEqual(f.errors, []);
        assert.ok(f.intercepted.every(url => url.startsWith('https://fonts.googleapis.com/')), 'no external resource requests except intercepted optional font CSS');
        cases.push({ theme, width, screenshot, titleWidths: layout.rows.map(row => row.title.width) });
      } finally { await f.close(); }
    }
    console.log('MUSIC_PLAY_NEXT_BROWSER_OK ' + JSON.stringify(cases));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
