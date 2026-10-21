const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const matter = require('gray-matter');
const { chromium } = require('../../vendor/folia/node_modules/playwright');
const web = path.resolve(__dirname, '../../web');
const memory = path.resolve(__dirname, '../../assets/Memory');

test('real Memory panel: Chinese folders, treasury chip, search and complete on-demand prompt', { timeout: 45000 }, async t => {
  const bodies = new Map();
  for (const file of ['treasury/index.md', 'treasury/prompts/index.md', 'treasury/resources/index.md', 'treasury/inspiration/index.md', 'treasury/prompts/sakura-station-threejs-prompt.md']) {
    bodies.set(file, fs.readFileSync(path.join(memory, file), 'utf8'));
  }
  bodies.set('entities/demo.md', '---\ntype: Entity\ntitle: 示例项目\n---\n# 示例项目');
  const pages = [...bodies].map(([file, raw]) => {
    const data = matter(raw).data;
    return { path: file, dir: path.posix.dirname(file), name: path.posix.basename(file), title: data.title,
      type: data.type || 'Treasure', description: data.description || '' };
  });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
  context.setDefaultTimeout(8000);
  const errors = [], writes = [], reads = [];
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== 'harbour-memory.test') return route.fulfill({ status: 204 });
    if (url.pathname.startsWith('/api/')) {
      if (request.method() !== 'GET') { writes.push(request.url()); return route.fulfill({ status: 403, json: { error: 'Read-only fixture' } }); }
      let data = {};
      switch (url.pathname) {
        case '/api/memory': data = { pages, total: pages.length, byType: { Treasure: 5, Entity: 1 } }; break;
        case '/api/memory/file': { const file = url.searchParams.get('path'); reads.push(file); data = { content: bodies.get(file) }; break; }
        case '/api/time-settings': data = { timeZone: 'America/New_York', revision: 1 }; break;
        case '/api/asks': data = { asks: [] }; break;
        case '/api/agents': data = { agents: [] }; break;
        case '/api/state': data = { defaultAgent: 'main-elaina' }; break;
      }
      return route.fulfill({ json: data });
    }
    const file = path.resolve(web, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404 });
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(file)] || 'application/octet-stream';
    return route.fulfill({ body: fs.readFileSync(file), contentType: mime });
  });
  await context.addInitScript(() => {
    window.WebSocket = class extends EventTarget { constructor() { super(); } send() {} close() {} };
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://harbour-memory.test/#memory');
  const picker = page.locator('[data-hs-for="memDirectory"]');
  await picker.locator('.hs-trigger').waitFor();
  assert.equal(reads.includes('treasury/prompts/sakura-station-threejs-prompt.md'), false, 'initial catalog must not load the prompt');
  await picker.locator('.hs-trigger').click();
  const menu = picker.getByRole('listbox');
  const menuSize = await menu.boundingBox();
  const triggerSize = await picker.locator('.hs-trigger').boundingBox();
  assert.ok(menuSize.width >= 450 && menuSize.width > triggerSize.width, 'directory menu must not collapse to trigger width');
  await picker.getByRole('option', { name: '宝库 / 提示词与模板 Memory / treasury / prompts', exact: true }).click();
  assert.equal(await page.locator('#memList .memory-card').count(), 2);
  await page.locator('#memFilter').fill('樱花');
  assert.equal(await page.locator('#memList .memory-card').count(), 1);
  await page.locator('#memList .memory-card').click();
  await page.locator('#memViewerRender .md-code').waitFor();
  assert.match(await page.locator('#memViewerRender .md-code').innerText(), /### 二十、完整风格关键词/);
  assert.doesNotMatch(await page.locator('#memViewerRender').innerText(), /original_sha256:/);
  assert.match(await page.locator('#memViewerTitle').innerText(), /三渲二樱花车站/);
  await page.locator('#memDocToggle [data-doc-view="raw"]').click();
  assert.match(await page.locator('#memViewerBody').innerText(), /original_sha256:/);
  await page.locator('#memDocToggle [data-doc-view="render"]').click();
  assert.equal(reads.filter(item => item === 'treasury/prompts/sakura-station-threejs-prompt.md').length, 1);
  await page.locator('#memBack').click();
  assert.equal(await page.locator('#memFilter').inputValue(), '樱花', 'returning preserves catalog filters');
  await page.locator('#memFilter').fill('');
  await picker.locator('.hs-trigger').click();
  await picker.getByRole('option', { name: '宝库 / 资料与工具 Memory / treasury / resources', exact: true }).click();
  assert.equal(await page.locator('#memList .memory-card').count(), 1);
  await page.locator('[data-mtype="Treasure"]').click();
  assert.equal(await page.locator('#memDirectory').inputValue(), '');
  assert.match(await picker.locator('.hs-trigger').innerText(), /全部目录/);
  assert.equal(await page.locator('#memList .memory-card').count(), 5);
  await picker.locator('.hs-trigger').click();
  await picker.getByRole('option', { name: '宝库 / 提示词与模板 Memory / treasury / prompts', exact: true }).click();
  const output = path.join(os.tmpdir(), 'harbour-memory-preview');
  fs.mkdirSync(output, { recursive: true });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 960 });
    const size = await picker.boundingBox();
    assert.ok(size && size.x >= 0 && size.x + size.width <= width, 'directory control stays in viewport');
    await picker.locator('.hs-trigger').click();
    const dropdown = await menu.boundingBox();
    assert.ok(dropdown && dropdown.x >= 0 && dropdown.x + dropdown.width <= width, 'expanded directory menu stays in viewport');
    assert.equal(await menu.evaluate(el => el.scrollWidth > el.clientWidth), false, 'paths wrap without horizontal overflow');
    const labels = await menu.locator('.hs-option-text').evaluateAll(nodes => nodes.map(el => ({
      overflow: el.scrollWidth > el.clientWidth, ellipsis: getComputedStyle(el).textOverflow === 'ellipsis',
    })));
    assert.ok(labels.every(label => !label.overflow && !label.ellipsis), 'directory names remain readable');
    await page.screenshot({ path: path.join(output, `treasury-${width}.png`), animations: 'disabled' });
    await picker.locator('.hs-trigger').press('Escape');
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, [], 'browsing collections must not launch a run or create a proposal');
});
