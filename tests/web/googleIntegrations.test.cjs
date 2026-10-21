// VM-only Settings integration checks: no Google account, browser profile or private local state.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const project = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(project, 'web/google-integrations.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const status = (changes = {}) => ({
  calendar: { configured: true, connected: true, missing: [], redirectUri: 'http://localhost:7788/api/calendar/oauth/callback' },
  gmail: { configured: true, connected: false, missing: [], redirectUri: 'http://localhost:7788/api/gmail/oauth/callback' },
  maps: { configured: true, dailyRequestLimit: 100, requestsToday: 3, remaining: 97 },
  ...changes,
});
function events() {
  const listeners = new Map();
  return {
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    emit(type, event = {}) { for (const fn of listeners.get(type) || []) fn(event); },
    listenerCount() { return [...listeners.values()].reduce((sum, values) => sum + values.size, 0); },
  };
}
function mockRoot() {
  const root = { ...events(), innerHTML: '', isConnected: true, focused: '', contains(node) { return node.root === root; } };
  root.querySelector = selector => {
    const attr = selector.replace(/^\[|\]$/g, '');
    const tag = root.innerHTML.match(new RegExp(`<[^>]*\\s${attr}(?=[\\s=>])[^>]*>`))?.[0];
    if (!tag) return null;
    return { root, disabled: /\sdisabled(?:[\s>])/.test(tag), hasAttribute: value => value === attr,
      focus() { root.focused = attr; }, closest(selectors) { return selectors.includes(`[${attr}]`) ? this : null; } };
  };
  root.click = attr => { const target = root.querySelector(`[${attr}]`); assert.ok(target, `missing ${attr}`); root.emit('click', { target }); };
  return root;
}
function fixture(handler, hidden = false) {
  const root = mockRoot(), calls = [], opened = [];
  const document = { ...events(), hidden };
  const window = { ...events(), open: (...args) => { opened.push(args); return null; } };
  const context = vm.createContext({ window, document, URL, AbortController, console,
    setInterval() { assert.fail('Google Settings must not poll'); }, setTimeout() { assert.fail('Google Settings must not poll'); } });
  vm.runInContext(source, context);
  const api = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (handler) return handler(url, options, calls.length);
    return status();
  };
  const cleanup = window.HarbourGoogleIntegrations.mount(root, { api });
  return { root, calls, opened, document, window, cleanup };
}
const posts = f => f.calls.filter(call => call.method === 'POST');

test('Settings uses one metadata read and exposes Calendar, readonly Gmail and locally counted Maps', async () => {
  const f = fixture(); await tick();
  assert.deepEqual(f.calls.map(call => call.url), ['/api/google/status']);
  assert.match(f.root.innerHTML, /href="#calendar"/);
  for (const text of ['Calendar', 'Gmail', 'Maps', 'gmail.readonly', '不发送', 'Places API (New)', 'Routes API', '不是美元费用', 'GOOGLE_MAPS_API_KEY']) assert.ok(f.root.innerHTML.includes(text), text);
  assert.match(f.root.innerHTML, /<dd>3<\/dd>/); assert.match(f.root.innerHTML, /<dd>97<\/dd>/);
  assert.doesNotMatch(f.root.innerHTML, /<input|<textarea|<iframe/);
  assert.equal(posts(f).length, 0); f.cleanup();
});

test('missing configuration disables Gmail, escapes text and never renders secret properties or provider errors', async () => {
  const f = fixture(() => status({
    credentialError: 'SECRET_IN_ERROR',
    gmail: { configured: false, connected: false, missing: ['GOOGLE_CALENDAR_CLIENT_SECRET', '<script>bad</script>'], redirectUri: '<img src=x onerror=alert(1)>', clientSecret: 'SECRET_PROPERTY', connectionError: 'SECRET_PROVIDER_ERROR' },
  })); await tick();
  assert.equal(f.root.querySelector('[data-google-connect]').disabled, true);
  assert.match(f.root.innerHTML, /GOOGLE_CALENDAR_CLIENT_SECRET/);
  assert.match(f.root.innerHTML, /&lt;img src=x/);
  assert.doesNotMatch(f.root.innerHTML, /SECRET_IN_ERROR|SECRET_PROPERTY|SECRET_PROVIDER_ERROR|<img|<script/);
  f.root.click('data-google-connect'); await tick(); assert.equal(posts(f).length, 0); f.cleanup();
});

test('Maps quota and local ledger errors remain distinct from configuration and never display secrets', async () => {
  const limited = fixture(() => status({ maps: { configured: true, requestsToday: 10, dailyRequestLimit: 10, remaining: 0 } })); await tick();
  assert.match(limited.root.innerHTML, /本机请求上限已用完/); assert.match(limited.root.innerHTML, /UTC 日界/); limited.cleanup();
  const failed = fixture(() => status({ maps: { configured: true, error: 'SECRET_LEDGER_CONTENT', remaining: 0 } })); await tick();
  assert.match(failed.root.innerHTML, /用量记录异常/); assert.doesNotMatch(failed.root.innerHTML, /SECRET_LEDGER_CONTENT/); failed.cleanup();
});

test('Gmail opens only verified OAuth URL and retains popup-block fallback', async () => {
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=public-client&scope=gmail.readonly';
  const f = fixture(request => request === '/api/gmail/connect' ? { url } : status()); await tick();
  f.root.click('data-google-connect'); await tick();
  assert.deepEqual(f.opened, [[url, '_blank', 'noopener,noreferrer']]);
  assert.match(f.root.innerHTML, /rel="noopener noreferrer"/); assert.match(f.root.innerHTML, /如果授权窗口未打开/);
  assert.equal(posts(f)[0].url, '/api/gmail/connect'); assert.ok(posts(f)[0].signal instanceof AbortSignal); f.cleanup();
});

test('OAuth rejects non-Google hosts, credentials, ports, arbitrary Google paths and executable schemes', async () => {
  for (const url of ['javascript:alert(1)', 'https://accounts.google.com.evil.test/o/oauth2/v2/auth', 'http://accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com:444/o/oauth2/v2/auth', 'https://user:password@accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com/signin', 'https://accounts.google.com/o/oauth2/v2/auth#fragment']) {
    const f = fixture(request => request === '/api/gmail/connect' ? { url } : status()); await tick();
    f.root.click('data-google-connect'); await tick();
    assert.equal(f.opened.length, 0, url); assert.match(f.root.innerHTML, /授权地址无效/); assert.doesNotMatch(f.root.innerHTML, /target="_blank"/); f.cleanup();
  }
});

test('disconnect requires explicit confirmation, is clearly local-only and deduplicates concurrent clicks', async () => {
  const pending = deferred(); let connected = true;
  const f = fixture(url => url === '/api/gmail/disconnect' ? pending.promise : status({ gmail: { configured: true, connected } })); await tick();
  f.root.click('data-google-disconnect');
  assert.match(f.root.innerHTML, /不撤销 Google 侧授权，不会因此断开日历/); assert.equal(posts(f).length, 0);
  assert.equal(f.root.focused, 'data-google-cancel');
  f.root.click('data-google-cancel'); assert.equal(posts(f).length, 0);
  f.root.click('data-google-disconnect'); f.root.click('data-google-confirm'); f.root.click('data-google-confirm');
  assert.equal(posts(f).length, 1); assert.equal(posts(f)[0].url, '/api/gmail/disconnect');
  connected = false; pending.resolve({ disconnected: true }); await tick();
  assert.match(f.root.innerHTML, /已在当前后端断开 Gmail/); assert.match(f.root.innerHTML, /Google 侧授权和日历连接保持不变/); assert.ok(f.root.querySelector('[data-google-connect]'));
  assert.equal(f.calls.filter(call => call.url === '/api/google/status').length, 2); f.cleanup();
});

test('failed disconnect is not retried automatically and failure does not expose upstream details', async () => {
  const f = fixture(url => {
    if (url === '/api/gmail/disconnect') throw new Error('SECRET_UPSTREAM_TOKEN');
    return status({ gmail: { configured: true, connected: true } });
  }); await tick();
  f.root.click('data-google-disconnect'); f.root.click('data-google-confirm'); await tick();
  assert.equal(posts(f).length, 1); assert.match(f.root.innerHTML, /结果尚未确认/); assert.doesNotMatch(f.root.innerHTML, /SECRET_UPSTREAM_TOKEN/); f.cleanup();
});

test('status failure has retry guidance and never mislabels unknown services as unconfigured', async () => {
  let fail = true;
  const f = fixture(() => { if (fail) throw Object.assign(new Error('sensitive backend error'), { status: 404 }); return status(); }); await tick();
  assert.match(f.root.innerHTML, /重启或更新 Harbour 后端/); assert.match(f.root.innerHTML, /状态未知/);
  assert.doesNotMatch(f.root.innerHTML, /sensitive backend error/);
  fail = false; f.root.click('data-google-refresh'); await tick(); assert.match(f.root.innerHTML, /已连接/); f.cleanup();
});

test('hidden Settings never fetches; visibility refresh ignores late aborted responses', async () => {
  const first = deferred(), second = deferred(); let reads = 0;
  const f = fixture(() => ++reads === 1 ? first.promise : second.promise, true);
  assert.equal(f.calls.length, 0);
  f.document.hidden = false; f.document.emit('visibilitychange'); assert.equal(f.calls.length, 1);
  f.document.hidden = true; f.document.emit('visibilitychange'); assert.equal(f.calls[0].signal.aborted, true);
  f.window.emit('focus'); assert.equal(f.calls.length, 1);
  f.document.hidden = false; f.document.emit('visibilitychange'); assert.equal(f.calls.length, 2);
  second.resolve(status({ maps: { configured: true, dailyRequestLimit: 100, requestsToday: 77, remaining: 23 } })); await tick();
  first.resolve(status()); await tick(); assert.match(f.root.innerHTML, /<dd>77<\/dd>/); assert.doesNotMatch(f.root.innerHTML, /<dd>3<\/dd>/); f.cleanup();
});

test('returning to visible Settings refreshes once without polling', async () => {
  const pending = deferred(); let reads = 0;
  const f = fixture(() => ++reads === 1 ? status() : pending.promise); await tick();
  f.window.emit('focus'); f.window.emit('focus'); assert.equal(f.calls.length, 2);
  pending.resolve(status()); await tick(); f.cleanup();
  f.window.emit('focus'); assert.equal(f.calls.length, 2);
  assert.equal(f.window.listenerCount() + f.document.listenerCount() + f.root.listenerCount(), 0);
});

test('leaving Settings aborts reads and does not overwrite the next settings section', async () => {
  const pending = deferred(), f = fixture(() => pending.promise);
  f.cleanup(); f.cleanup(); f.root.innerHTML = '<p>new settings content</p>';
  pending.resolve(status()); await tick();
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.root.innerHTML, '<p>new settings content</p>');
});

test('leaving Settings during connect never opens a late authorization window', async () => {
  const pending = deferred(); const f = fixture(url => url === '/api/gmail/connect' ? pending.promise : status()); await tick();
  f.root.click('data-google-connect'); f.cleanup(); f.root.innerHTML = '<p>another page</p>';
  pending.resolve({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=late' }); await tick();
  assert.equal(posts(f)[0].signal.aborted, true); assert.equal(f.opened.length, 0); assert.equal(f.root.innerHTML, '<p>another page</p>');
});

test('host loads module before app, mounts only in Google Settings and disposes on both navigation boundaries', () => {
  const app = fs.readFileSync(path.join(project, 'web/app.js'), 'utf8'), html = fs.readFileSync(path.join(project, 'web/index.html'), 'utf8');
  assert.ok(html.indexOf('/google-integrations.js') < html.indexOf('/app.js'));
  assert.match(html, /\/google-integrations\.css/);
  assert.match(app, /settingsNavItem\("google", "G", "Google 集成"\)/);
  assert.match(app, /settingsSection === "google"\) disposeGoogleSettings = window\.HarbourGoogleIntegrations\.mount\(pane, \{ api \}\)/);
  assert.match(app, /function renderSettingsPane\(s\) \{\s*disposeGoogleSettings\?\.\(\); disposeGoogleSettings = null/);
  const route = app.slice(app.indexOf('async function route()'), app.indexOf('let desktopConversationPending'));
  assert.match(route, /disposeGoogleSettings\?\.\(\); disposeGoogleSettings = null/);
});

test('optional isolated headless fixture checks desktop/mobile premium and anime layout', { skip: process.env.GOOGLE_UI_REVIEW !== '1' }, async () => {
  const { chromium } = require('../../vendor/folia/node_modules/playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined) });
  try {
    const output = path.join(project, 'tmp/google-settings-ui'); fs.mkdirSync(output, { recursive: true });
    const themes = fs.readFileSync(path.join(project, 'web/themes.css'), 'utf8').replace(/@import[^;]+;/g, '');
    const styles = fs.readFileSync(path.join(project, 'web/styles.css'), 'utf8');
    const googleStyles = fs.readFileSync(path.join(project, 'web/google-integrations.css'), 'utf8');
    for (const [category, theme] of [['premium', 'premium-champagne'], ['anime', 'anime-wisteria']]) {
      for (const width of [1360, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 1100 } });
        await context.route('**/*', route => route.abort());
        try {
          const page = await context.newPage();
          await page.setContent(`<html><body data-theme-cat="${category}" data-theme="${theme}" data-panel="settings"><main style="max-width:1100px;margin:auto;padding:16px"><section class="settings-pane" id="root"></section></main></body></html>`);
          await page.addStyleTag({ content: `${themes}\n${styles}\n${googleStyles}\nhtml,body { overflow:auto;height:auto; }` });
          await page.addScriptTag({ content: source });
          await page.evaluate(data => {
            window.calls = []; window.opened = [];
            window.open = (...args) => { window.opened.push(args); return null; };
            window.cleanup = window.HarbourGoogleIntegrations.mount(document.getElementById('root'), { api: async (url, options) => {
              window.calls.push({ url, method: options?.method || 'GET' });
              return url === '/api/gmail/connect' ? { url: 'https://accounts.google.com/o/oauth2/v2/auth?fixture=1' } : data;
            } });
          }, status());
          await page.waitForFunction(() => document.querySelector('[data-google-connect]')?.disabled === false);
          assert.equal(await page.locator('.google-card').count(), 3);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${category} ${width} must not overflow`);
          await page.locator('[data-google-connect]').click();
          await page.waitForSelector('.google-auth-link');
          assert.equal(await page.evaluate(() => window.opened.length), 1);
          await page.locator('[data-google-card="gmail"] summary').click();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'expanded OAuth setup must not overflow');
          await page.screenshot({ path: path.join(output, `${category}-${width}.png`), fullPage: true });
          await page.evaluate(() => window.cleanup());
        } finally { await context.close(); }
      }
    }
  } finally { await browser.close(); }
});
