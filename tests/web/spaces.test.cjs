const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('../../vendor/folia/node_modules/playwright');
const web = path.resolve(__dirname, '../../web');
let browser;
before(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined) }); });
after(async () => { await browser?.close(); });
const file = (c, name, mime) => ({ id: c.repeat(64) + path.extname(name), name, mime, size: 1024 });
async function fixture(t, hash = 'spaces') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, reducedMotion: 'reduce' }); t.after(() => context.close());
  context.setDefaultTimeout(7000);
  const entries = [
    { id: 'a'.repeat(32), title: '海风停在信里', kind: 'comic', files: [{...file('1', 'panel-01.svg', 'image/svg+xml'), caption: '纸船向远处漂去。'}, file('2', 'panel-02.svg', 'image/svg+xml')], status: 'completed' },
    { id: 'b'.repeat(32), title: '夏日来信', kind: 'image', files: [file('3', 'summer.svg', 'image/svg+xml')], status: 'completed' },
    { id: 'c'.repeat(32), title: '关于小镇的十个想法', kind: 'document', files: [file('4', 'town.md', 'text/markdown')], status: 'completed' },
    { id: 'd'.repeat(32), title: 'Harbour 创作手册', kind: 'document', files: [file('5', 'guide.pdf', 'application/pdf')], status: 'completed' },
  ].map(e => ({ ...e, createdAt: '2026-09-29T09:00:00Z', updatedAt: '2026-09-29T09:00:00Z', favorite: false, revision: 1, collectionId: null }));
  const packages = [
    ['skill', 'writing-companion', '写作伙伴，捕捉故事里的细微情绪。'], ['skill', 'calendar-helper', '理解安排，留出从容生活的时间。'],
    ['workflow', 'image-library', '从创作到交付，让每一件作品都有归处。'], ['workflow', 'memory-ingestion', '将有价值的片段整理为长期记忆。'],
    ['mcp', 'browser-tools', '连接浏览器与外部世界。'], ['mcp', 'local-files', '受控地读取本地工作资料。'],
  ].map(([kind, name, description], i) => ({ kind, name, description, valid: true, mountedBy: i % 2 ? [] : ['main-elaina'], files: [{ path: `skills/${name}/SKILL.md`, relativePath: 'SKILL.md' }] }));
  const collections = [], writes = [], remote = [], errors = [];
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.hostname !== 'harbour-studio.test') { remote.push(req.url()); return route.fulfill({ status: 204 }); }
    if (url.pathname.startsWith('/api/')) {
      if (req.method() !== 'GET') writes.push(url.pathname);
      let value = {};
      if (url.pathname === '/api/spaces') {
        const q = url.searchParams.get('q') || '', kind = url.searchParams.get('kind'), folder = url.searchParams.get('collection');
        const list = entries.filter(e => e.title.includes(q) && (!kind || e.kind === kind) && (!folder || e.collectionId === folder) && (!url.searchParams.get('favorite') || e.favorite));
        value = { entries: list.map(({ files, ...e }) => ({ ...e, cover: files[0], fileCount: files.length })), total: list.length, hasMore: false, counts: { all: entries.length, comic: 1, image: 1, document: 2, file: 0, favorite: entries.filter(e => e.favorite).length }, collections: collections.map(c => ({ ...c, count: entries.filter(e => e.collectionId === c.id).length })) };
      } else if (url.pathname.startsWith('/api/spaces/entries/')) {
        value = entries.find(e => url.pathname.endsWith(e.id));
        if (req.method() === 'PATCH') { Object.assign(value, req.postDataJSON()); value.revision++; }
      } else if (url.pathname === '/api/spaces/collections') { value = { id: 'folder-1', name: req.postDataJSON().name }; collections.push(value); }
      else if (url.pathname === '/api/spaces/refresh') value = { imported: 0, unavailable: 0 };
      else if (url.pathname === '/api/spaces/import') { const body = req.postDataJSON(); value = { id: 'e'.repeat(32), title: body.name, files: [file('6', body.name, 'text/plain')], kind: 'document', createdAt: new Date().toISOString(), revision: 1, favorite: false, collectionId: body.collectionId }; entries.push(value); }
      else if (url.pathname.startsWith('/api/spaces/files/')) {
        if (url.searchParams.has('text')) value = { text: '# 小镇\n\n慢一点，也没关系。\n\n![不要联网](https://untrusted.test/private.png)\n<script>window.executed=true</script>' };
        else return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><defs><linearGradient id="a" x2=".9" y2="1"><stop stop-color="#b7becf"/><stop offset="1" stop-color="#e8c1bb"/></linearGradient></defs><rect width="600" height="800" fill="url(#a)"/><circle cx="430" cy="180" r="80" fill="#fff6df"/><path d="M0 570Q180 330 360 560T650 500V800H0" fill="#748784"/><path d="M0 660Q230 450 440 650T640 570V800H0" fill="#465666"/><text x="45" y="720" font-family="serif" font-size="32" fill="white">A summer in Harbour</text></svg>` });
      } else if (url.pathname === '/api/capabilities') value = { packages, counts: { skill: 2, workflow: 2, mcp: 2 } };
      else if (url.pathname.startsWith('/api/workflow-graphs/')) value = { revision: 1, document: { positions: {}, notes: {}, settings: {} }, definition: { title: '创作与归档', description: '确定性步骤与创作判断各司其职。', nodes: [
        { id: 'create', title: '创作', summary: '理解要求', detail: '创作判断交给 Agent', kind: 'agent', phase: 'executor', x: 30, y: 50 },
        { id: 'save', title: '保存', summary: '保存已交付文件', detail: '原文件持久化，不重复生成', kind: 'code', phase: 'after', x: 350, y: 50 },
      ], edges: [{ from: 'create', to: 'save', label: '交付' }], settings: [] } };
      else if (url.pathname === '/api/capabilities/file') value = { content: '---\nname: writing-companion\ndescription: Write with care.\n---\n\n# Writing companion\n\nWrite with care.', path: url.searchParams.get('path') };
      else if (url.pathname === '/api/time-settings') value = { timeZone: 'America/New_York', revision: 1 };
      else if (url.pathname === '/api/asks') value = { asks: [] };
      else if (url.pathname === '/api/agents') value = { agents: [] };
      else if (url.pathname === '/api/conversations/explorer') value = { enabled: true, sessions: [] };
      else if (url.pathname === '/api/cowork/devices') value = { devices: [] };
      return route.fulfill({ json: value });
    }
    const target = path.resolve(web, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!target.startsWith(web + path.sep) || !fs.existsSync(target)) return route.fulfill({ status: 404 });
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.webp': 'image/webp', '.png': 'image/png' }[path.extname(target)] || 'application/octet-stream';
    return route.fulfill({ contentType: mime, body: fs.readFileSync(target) });
  });
  await context.addInitScript(() => { window.WebSocket = class extends EventTarget { static OPEN = 1; readyState = 1; send() {} close() {} }; });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://harbour-studio.test/#${hash}`); await page.locator('.studio-shell').waitFor();
  t.after(() => assert.deepEqual(errors, []));
  return { page, entries, collections, writes, remote };
}
test('space is primary; comic reads in order; metadata, search, folders, upload and safe Markdown work', async t => {
  const { page, entries, remote } = await fixture(t);
  assert.equal(await page.locator('#navPrimary [href="#spaces"]').count(), 1);
  await page.locator('[data-space-open]').first().waitFor(); assert.equal(await page.locator('.space-card').count(), 4);
  await page.locator('[data-space-open]').first().click(); await page.locator('.space-reader').waitFor();
  assert.equal(await page.locator('.space-reader-page').count(), 2);
  assert.match(await page.locator('.space-reader-page').first().innerText(), /panel-01/);
  const frame = await page.locator('.space-image-frame').first().evaluate(el => {
    const r = el.getBoundingClientRect(); return { width: r.width, height: r.height, fit: getComputedStyle(el.querySelector('img')).objectFit };
  });
  assert.ok(Math.abs(frame.width - frame.height) < 1, 'comic uses the square frame shared by photos');
  assert.equal(frame.fit, 'contain', 'old portrait originals must not be cropped');
  assert.equal(await page.locator('.space-reader-page').first().locator(':scope > .space-page-caption').innerText(), '纸船向远处漂去。');
  await page.locator('[data-reader-star]').click(); await page.waitForFunction(() => document.querySelector('[data-reader-star]').getAttribute('aria-pressed') === 'true');
  await page.keyboard.press('Escape'); assert.equal(await page.locator('.space-reader').count(), 0);
  await page.getByRole('button', { name: '打开 夏日来信', exact: true }).click(); await page.locator('.space-reader').waitFor();
  const photo = await page.locator('.space-image-frame').boundingBox();
  assert.ok(Math.abs(photo.width - photo.height) < 1);
  assert.ok(Math.abs(photo.width - frame.width) < 1, 'same-width image and comic presentation');
  await page.keyboard.press('Escape');
  await page.locator('[data-space-new-folder]').click(); await page.locator('.studio-dialog input').fill('夏日故事'); await page.locator('.studio-dialog [type=submit]').click(); await page.locator('.studio-dialog').waitFor({ state: 'detached' });
  await page.locator('[data-space-kind="all"]').click(); await page.locator('[data-space-search]').fill('小镇'); await page.waitForFunction(() => document.querySelectorAll('.space-card').length === 1);
  await page.locator('[data-space-open]').click(); await page.locator('.space-text-preview h2').waitFor();
  assert.equal(await page.locator('.space-text-preview img, .space-text-preview script').count(), 0);
  assert.equal(await page.evaluate(() => window.executed), undefined); assert.equal(remote.filter(x => x.includes('untrusted.test')).length, 0);
  await page.locator('[data-reader-collection]').selectOption('folder-1'); await page.waitForFunction(() => document.querySelector('[data-reader-collection]').value === 'folder-1');
  await page.locator('[data-reader-rename]').click(); await page.locator('.studio-dialog input').fill('小镇笔记'); await page.locator('.studio-dialog [type=submit]').click(); await page.locator('.studio-dialog').waitFor({ state: 'detached' });
  assert.equal(await page.locator('[data-reader-title]').innerText(), '小镇笔记'); await page.keyboard.press('Escape');
  await page.locator('[data-space-search]').fill(''); await page.waitForFunction(() => document.querySelectorAll('.space-card').length === 4);
  await page.locator('[data-space-files]').setInputFiles({ name: 'letter.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.waitForFunction(() => document.querySelector('[data-space-status]').textContent.includes('已保存 1'));
  assert.equal(entries.length, 5);
});
test('comic zoom uses original pages, pans, keeps focus and returns to the same reading position', async t => {
  const { page, writes } = await fixture(t);
  await page.getByRole('button', { name: '打开 海风停在信里', exact: true }).click();
  const second = page.locator('[data-space-zoom="1"]');
  await second.waitFor();
  await second.click();
  const viewer = page.locator('.space-reader > .media-viewer');
  await viewer.waitFor();
  const scroll = await page.locator('.space-reader-scroll').evaluate(el => el.scrollTop);
  assert.ok(scroll > 0, 'second page was reached through the scroll reader');
  assert.equal(await page.locator('.media-viewer-counter').innerText(), '2 / 2');
  assert.equal(await page.locator('.media-viewer-image').getAttribute('src'), `http://harbour-studio.test/api/spaces/files/${'2'.repeat(64)}.svg`);
  assert.equal(await page.locator('.space-reader-scroll').evaluate(el => el.inert), true);
  await page.getByRole('button', { name: '放大图片', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '适应窗口', exact: true }).innerText(), '125%');
  const stage = await page.locator('.media-viewer-stage').boundingBox();
  const x = stage.x + stage.width / 2, y = stage.y + stage.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 80, y + 40, { steps: 4 }); await page.mouse.up();
  assert.match(await page.locator('.media-viewer-image').getAttribute('style'), /translate3d\(80px, 40px, 0px\) scale\(1\.25\)/);
  await page.mouse.wheel(0, -120);
  await page.waitForFunction(() => document.querySelector('.media-viewer-zoom').textContent === '144%');
  await page.getByRole('button', { name: '适应窗口', exact: true }).click();
  assert.match(await page.locator('.media-viewer-image').getAttribute('style'), /translate3d\(0px, 0px, 0px\) scale\(1\)/);
  await page.locator('.media-viewer-stage').dblclick();
  assert.equal(await page.getByRole('button', { name: '适应窗口', exact: true }).innerText(), '200%');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('.media-viewer-counter').innerText(), '1 / 2');
  assert.equal(await page.getByRole('button', { name: '上一个图片或视频' }).isEnabled(), false);
  assert.equal(await page.getByRole('button', { name: '适应窗口', exact: true }).innerText(), '100%');
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('.media-viewer-counter').innerText(), '2 / 2', 'no wrap past the last comic page');
  await page.keyboard.press('Escape');
  assert.equal(await viewer.count(), 0);
  assert.equal(await page.locator('.space-reader[open]').count(), 1, 'Escape closes only the zoom layer');
  assert.equal(await page.locator('.space-reader-scroll').evaluate(el => el.inert), false);
  assert.equal(await page.locator('.space-reader-scroll').evaluate(el => el.scrollTop), scroll);
  assert.equal(await second.evaluate(el => document.activeElement === el), true);
  assert.equal(await page.locator('body').evaluate(el => el.classList.contains('media-viewer-open')), false);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.space-reader').count(), 0);
  assert.deepEqual(writes, [], 'zoom, page navigation and close never modify a work or invoke generation');
});

test('single-image zoom fits small viewports and releases keyboard handling on close', async t => {
  const { page, writes } = await fixture(t);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开 夏日来信', exact: true }).click();
  await page.locator('[data-space-zoom="0"]').click();
  await page.locator('.media-viewer').waitFor();
  assert.equal(await page.locator('.media-viewer-next').isVisible(), false);
  assert.equal(await page.locator('.media-viewer-prev').isVisible(), false);
  const bounds = await page.locator('.media-viewer-card').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391);
  assert.equal(await page.locator('.media-viewer-image').evaluate(el => getComputedStyle(el).objectFit), 'contain');
  await page.getByRole('button', { name: '关闭媒体预览' }).press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-media-viewer-action')), 'zoom-out', 'Tab wraps inside the topmost viewer');
  await page.getByRole('button', { name: '关闭媒体预览' }).click();
  await page.getByRole('button', { name: '返回空间' }).click();
  await page.locator('[data-space-search]').fill('夏日');
  assert.equal(await page.locator('.media-viewer').count(), 0);
  assert.deepEqual(writes, []);
});

test('gallery remains clean across themes and widths; reader has its own scroll', async t => {
  const { page } = await fixture(t); await page.locator('.space-card').first().waitFor();
  const output = path.join(os.tmpdir(), 'harbour-studio-preview'); fs.mkdirSync(output, { recursive: true });
  for (const theme of [['premium', 'neutral', 'premium-champagne'], ['anime', 'elaina', 'anime-wisteria']]) {
    await page.evaluate(v => applyTheme(...v), theme);
    for (const width of [1440, 900, 390]) {
      await page.setViewportSize({ width, height: 980 });
      const size = await page.locator('#content').evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
      assert.ok(size.scroll <= size.client + 1, `overflow ${width}: ${JSON.stringify(size)}`);
      await page.screenshot({ path: path.join(output, `spaces-${theme[0]}-${width}.png`) });
    }
  }
  await page.setViewportSize({ width: 1440, height: 980 }); await page.locator('[data-space-open]').first().click();
  await page.locator('.space-reader').waitFor();
  const bounds = await page.locator('.space-reader').boundingBox(); assert.ok(bounds.y >= -1 && bounds.y < 100 && bounds.x >= -1, JSON.stringify(bounds));
  assert.equal(await page.locator('.space-reader').evaluate(el => getComputedStyle(el).opacity), '1');
  const scroll = await page.locator('.space-reader-scroll').evaluate(el => el.scrollHeight > el.clientHeight); assert.equal(scroll, true);
  await page.screenshot({ path: path.join(output, 'comic-reader.png') });
});
test('capability catalog filters, enters details, protects edit drafts and returns to browsing', async t => {
  const { page, writes } = await fixture(t, 'capabilities');
  assert.equal(await page.locator('[data-capability]').count(), 6); assert.equal(await page.locator('#capDetailView').isVisible(), false);
  await page.locator('[data-cap-kind="skill"]').click(); assert.equal(await page.locator('[data-capability]').count(), 2);
  await page.locator('#capMountFilter').selectOption('yes'); assert.equal(await page.locator('[data-capability]').count(), 1);
  await page.locator('[data-capability]').first().click(); await page.locator('#capEdit').waitFor();
  assert.equal(await page.locator('#capPageHeading').isVisible(), false, 'catalog heading does not crowd detail');
  assert.equal(await page.locator('.cap-detail.agents-detail').count(), 0, 'detail is not wrapped in a second card');
  await page.locator('#capViewerRender .cap-frontmatter').waitFor();
  assert.equal(await page.locator('.cap-frontmatter').getAttribute('open'), null);
  const editBox = await page.locator('#capEdit').boundingBox(); assert.ok(editBox.height <= 38, 'edit uses the compact toolbar scale');
  await page.locator('#capDocToggle [data-doc-view="raw"]').click();
  assert.match(await page.locator('#capViewerBody').textContent(), /^---\nname:/);
  await page.locator('#capDocToggle [data-doc-view="render"]').click();
  await page.locator('#capEdit').click();
  assert.match(await page.locator('#capEditorText').inputValue(), /^---\nname:/, 'editing keeps full frontmatter');
  await page.locator('#capEditCancel').click();
  await page.locator('#capEdit').click(); await page.locator('#capEditor textarea').fill('unsaved draft');
  await page.locator('#capBack').click();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await page.locator('#capEditor textarea').inputValue(), 'unsaved draft');
  await page.locator('#capBack').click(); await page.getByRole('button', { name: /放弃/ }).click();
  await page.locator('#capCatalog').waitFor();
  await page.locator('[data-cap-kind="mcp"]').click(); await page.locator('#capMountFilter').selectOption(''); assert.equal(await page.locator('[data-capability]').count(), 2);
  await page.locator('[data-cap-kind=""]').click();
  const output = path.join(os.tmpdir(), 'harbour-studio-preview'); fs.mkdirSync(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'capabilities.png') });
  await page.locator('[data-cap-kind="workflow"]').click(); await page.locator('[data-capability]').first().click();
  await page.locator('.wf-node').first().waitFor(); assert.equal(await page.locator('.wf-node').count(), 2);
  await page.locator('[data-wf="focus"]').click(); assert.equal(await page.locator('.wf-expanded').count(), 1);
  await page.locator('[data-workflow-tab="files"]').click(); assert.equal(await page.locator('.wf-expanded').count(), 0);
  await page.locator('#capEdit').waitFor(); await page.locator('#capBack').click();
  assert.deepEqual(writes, [], 'no governance or mount mutation merely from browsing/discard');
});
