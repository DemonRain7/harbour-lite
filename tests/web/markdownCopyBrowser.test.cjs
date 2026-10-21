// Hidden, local-only UI fixture. Both clipboard APIs are mocked: never writes
// the user's clipboard, opens a visible window or calls a Harbour/model API.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { chromium } = require('../../vendor/folia/node_modules/playwright');
try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
const root = path.resolve(__dirname, '../..');
const app = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
const renderSource = app.slice(app.indexOf('function renderMarkdownLite('), app.indexOf('// 全屏 modal'));
const sandbox = { esc: value => String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char])) };
vm.createContext(sandbox);
vm.runInContext(renderSource, sandbox);
const body = [
  '请在本机实际试玩并评估 Fog Scout 像素地下城，产出可用于完善游戏和填写 README 的具体反馈。',
  '', '【环境】',
  '- 试玩地址：http://127.0.0.1:5173/#/m/discovery',
  '- 项目目录：D:\\CODE\\codes\\Course_AI_Game\\motivation-atlas',
  '', '【续接任务】',
  '  保留缩进、空行与中文。不重复已有操作。',
  '<script>window.untrustedExecuted = true</script>',
  '& < > " ` 文本原样复制',
].join('\n');
const markdown = '## 交接 Prompt（复制发那边）\n```text\n' + body + '\n```\n## 第二块\n~~~json\n{"only":"second"}\n~~~';
const profileBase = path.join(root, 'data/runtime/test-fixtures/markdown-copy');

test('Prompt copy: exact content, isolated blocks, keyboard, fallback, themes and safe HTML', { timeout: 45000 }, async t => {
  fs.mkdirSync(profileBase, { recursive: true });
  const profile = fs.mkdtempSync(path.join(profileBase, 'profile-'));
  const browser = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined),
    args: ['--disable-gpu', '--disable-background-networking'],
    env: { ...process.env, TEMP: profile, TMP: profile, TMPDIR: profile },
    viewport: { width: 1180, height: 760 }, reducedMotion: 'reduce',
  });
  t.after(async () => {
    await browser.close();
    assert.ok(path.resolve(profile).startsWith(profileBase + path.sep));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await browser.route('**/*', route => route.abort());
  const page = browser.pages()[0], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setContent('<!doctype html><html lang="zh"><body data-theme="anime-wisteria" data-theme-cat="anime"><main class="preview"><div class="md-body" id="message"></div><input id="focus-fixture" value="keep selection"></main></body></html>');
  for (const file of ['themes.css', 'styles.css']) await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'web', file), 'utf8') });
  await page.addStyleTag({ content: 'html,body{overflow:auto;height:auto;min-height:100%}.preview{position:relative;max-width:1000px;margin:36px auto;padding:30px;background:var(--panel);border:1px solid var(--border);border-radius:18px}#focus-fixture{margin-top:20px}@media(max-width:600px){.preview{margin:12px;padding:16px}}' });
  await page.locator('#message').evaluate((el, html) => { el.innerHTML = html; }, sandbox.renderMarkdownLite(markdown));
  await page.evaluate(() => {
    window.copyWrites = []; window.legacyWrites = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copyWrites.push(text); } } });
    document.execCommand = () => { throw new Error('Unexpected clipboard fallback'); };
    window.alert = window.confirm = () => { throw new Error('Copy must not display a popup'); };
  });
  await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'web/markdown-copy.js'), 'utf8') });
  const buttons = page.locator('[data-code-copy]');
  assert.equal(await buttons.count(), 2);
  assert.deepEqual(await page.evaluate(() => window.copyWrites), [], 'no automatic clipboard activity');
  assert.equal(await page.evaluate(() => window.untrustedExecuted), undefined);
  assert.equal(await page.locator('pre code').first().textContent(), body);
  await buttons.first().click();
  await page.waitForFunction(() => document.querySelector('[data-code-copy]').dataset.copyState === 'copied');
  assert.deepEqual(await page.evaluate(() => window.copyWrites), [body]);
  assert.equal(await buttons.first().innerText(), '已复制');
  assert.equal(await buttons.nth(1).innerText(), '复制');
  await buttons.nth(1).focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.copyWrites), [body, '{"only":"second"}']);

  // No native clipboard in a LAN HTTP page: use the user-triggered legacy path,
  // restore focus/selection, and copy only that block. Still fully stubbed here.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    document.execCommand = action => { window.legacyWrites.push({ action, text: document.activeElement.value }); return true; };
    const input = document.getElementById('focus-fixture'); input.focus(); input.setSelectionRange(2, 6);
    document.querySelector('[data-code-copy]').click();
  });
  assert.deepEqual(await page.evaluate(() => ({ writes: window.legacyWrites, focus: document.activeElement.id, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd })),
    { writes: [{ action: 'copy', text: body }], focus: 'focus-fixture', start: 2, end: 6 });
  assert.equal(await page.locator('textarea').count(), 0);

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
  });
  await buttons.first().click();
  await page.waitForFunction(() => document.querySelector('[data-code-copy]').dataset.copyState === 'error');
  assert.equal(await buttons.first().innerText(), '重试');
  assert.equal(await page.evaluate(() => window.legacyWrites.length), 1, 'denied writes do not silently bypass permission');
  await page.waitForFunction(() => !document.querySelector('[data-code-copy]').dataset.copyState);

  const output = path.join(root, 'data/runtime/test-fixtures/markdown-copy-previews');
  fs.mkdirSync(output, { recursive: true });
  for (const [theme, category, width] of [['anime-wisteria', 'anime', 1180], ['premium-tungsten', 'premium', 1180], ['anime-wisteria', 'anime', 390]]) {
    await page.setViewportSize({ width, height: 760 });
    await page.evaluate(({ theme, category }) => { document.body.dataset.theme = theme; document.body.dataset.themeCat = category; }, { theme, category });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal page overflow');
    assert.equal(await buttons.first().isVisible(), true);
    const bounds = await buttons.first().boundingBox();
    assert.ok(bounds.width >= 70 && bounds.height >= 30 && bounds.x + bounds.width <= width, 'copy target stays readable and inside the block');
    await page.screenshot({ path: path.join(output, `${theme}-${width}.png`), fullPage: true });
  }

  // Dynamically streamed/unclosed blocks and long fences stay copyable. Hostile
  // language labels are not interpolated into attributes or executable markup.
  const additional = sandbox.renderMarkdownLite('````text\nfirst\n```\nlast\n````\n```<img src=x onerror=alert(1)>\n  unfinished\n');
  await page.locator('#message').evaluate((el, html) => { el.innerHTML = html; }, additional);
  assert.equal(await page.locator('pre code').first().textContent(), 'first\n```\nlast');
  assert.equal(await page.locator('pre code').nth(1).textContent(), '  unfinished\n');
  assert.equal(await page.locator('#message img').count(), 0);
  assert.equal(await buttons.count(), 2);
  assert.deepEqual(errors, []);
  console.log('Isolated copy previews: ' + output);
});
