const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openTownMenu, visitTownResident } = require('./town-ui.cjs');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const { chromium } = require('../../vendor/folia/node_modules/playwright');
const root = path.resolve(__dirname, '../..'), web = path.join(root, 'web');
const settings = import(pathToFileURL(path.join(web, 'town/graphics-settings.js')));

test('quality and frame rate migrate independently; native quality respects GPU capabilities', async () => {
  const { readGraphicsSettings, resolveQuality } = await settings;
  const storage = values => ({ getItem: key => values[key] ?? null });
  assert.deepEqual(readGraphicsSettings(storage({})), { qualityName: 'medium', frameRate: 30 });
  assert.deepEqual(readGraphicsSettings(storage({ 'harbour-town-quality': 'high' })), { qualityName: 'high', frameRate: 60 });
  for (const name of ['low', 'medium', 'high', 'ultra']) {
    assert.deepEqual(readGraphicsSettings(storage({ 'harbour-town-quality': name, 'harbour-town-fps': '120' })), { qualityName: name, frameRate: 120 });
  }
  assert.equal(readGraphicsSettings(storage({ 'harbour-town-fps': '9999' })).frameRate, 30);
  assert.equal(resolveQuality('high', 2).pixelRatio, 1.5);
  const ultra = resolveQuality('ultra', 2, { maxSamples: 8, maxTextureSize: 8192, getMaxAnisotropy: () => 16 });
  assert.equal(ultra.pixelRatio, 2); assert.equal(ultra.shadowMap, 4096); assert.equal(ultra.msaa, 4); assert.equal(ultra.anisotropy, 16); assert.equal(ultra.sourceTextures, true);
  assert.equal(resolveQuality('ultra', 2, { maxSamples: 2, maxTextureSize: 2048 }).shadowMap, 2048);
  assert.equal(resolveQuality('ultra', NaN).pixelRatio, 1);
});

test('frame limiter supports 120 on 120/144/165 Hz without frame-rate-dependent movement', async () => {
  const { createFrameGate } = await settings;
  for (const refresh of [60, 120, 144, 165]) for (const target of [30, 60, 120]) {
    const gate = createFrameGate(target); let rendered = 0, seconds = 0;
    for (let frame = 0; frame < refresh * 10; frame++) {
      const dt = gate.tick(frame * 1000 / refresh);
      if (dt !== null) { rendered++; seconds += dt; }
    }
    assert.ok(Math.abs(rendered - Math.min(refresh, target) * 10) <= 1, `${refresh}/${target}: ${rendered}`);
    assert.ok(Math.abs(seconds - 10) < .04, `${refresh}/${target}: elapsed ${seconds}`);
    assert.equal(gate.setRate(120), 120); assert.equal(gate.tick(20000), 1 / 120, 'reset cannot accumulate background time');
    gate.reset(); assert.equal(gate.tick(100000), 1 / 120);
  }
});

test('both actual maps: native HiDPI output, source textures, 120 setting and live FPS changes', {
  timeout: 240000, skip: !fs.existsSync(path.join(web, 'town/models/local/manifest.json')),
}, async t => {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    const file = path.resolve(web, '.' + name);
    if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
    res.setHeader('Content-Type', ({ '.js': 'application/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 800, height: 500 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(120000);
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', req => requests.push(req.url()));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/') || url.hostname !== '127.0.0.1') { errors.push(`Unexpected request ${url.pathname}`); return route.abort(); }
    return route.continue();
  });
  await page.addInitScript(() => {
    if (!localStorage.getItem('harbour-town-quality')) localStorage.setItem('harbour-town-quality', 'ultra');
    if (!localStorage.getItem('harbour-town-fps')) localStorage.setItem('harbour-town-fps', '120');
  });
  const ready = async () => {
    await page.waitForFunction(() => window.HarbourTown?.status().frames > 1 || document.querySelector('.loading button'), null, { timeout: 150000 });
    assert.equal(await page.evaluate(() => HarbourTown.status().ready), true, await page.locator('#loading').innerText());
  };
  const output = process.env.TOWN_GRAPHICS_SCREENSHOT_DIR || path.join(os.tmpdir(), 'harbour-town-graphics'); fs.mkdirSync(output, { recursive: true });
  for (const map of ['station', 'suibo']) {
    await page.goto(`http://127.0.0.1:${server.address().port}/town/index.html?map=${map}`); await ready();
    const status = await page.evaluate(() => HarbourTown.status());
    assert.equal(status.quality, 'ultra'); assert.equal(status.graphics.targetFps, 120);
    assert.equal(status.graphics.pixelRatio, 2); assert.equal(status.graphics.bufferWidth, 1600); assert.equal(status.graphics.bufferHeight, 1000);
    assert.equal(status.graphics.sceneWidth, 1600); assert.equal(status.graphics.sceneHeight, 1000);
    if (map === 'suibo') assert.equal(status.graphics.temporalAA, false, 'no static-world TAA smearing animated characters in native quality');
    assert.equal(status.graphics.shadowMap, 4096); assert.equal(status.graphics.msaa, 4);
    assert.ok(status.models.every(m => m.type === 'mmd' && m.textures.mode === 'source' && m.textures.fallback === 0), JSON.stringify(status.models.map(m => m.textures)));
    assert.equal(status.models.find(m => m.id === 'main-elaina').textures.maxSide, 4096);
    const before = requests.length, frames = status.frames, resizes = status.graphics.resizeCount;
    await openTownMenu(page);
    for (const fps of [30, 60, 120]) {
      await page.getByLabel('帧率上限').selectOption(String(fps));
      assert.equal(await page.evaluate(() => HarbourTown.status().graphics.targetFps), fps);
    }
    assert.equal(requests.length, before, 'FPS changes do not reload/download models or call APIs');
    assert.ok(await page.evaluate(n => HarbourTown.status().frames >= n, frames));
    assert.equal(await page.evaluate(() => HarbourTown.status().graphics.resizeCount), resizes);
    await visitTownResident(page, 'main-elaina');
    await page.waitForFunction(() => HarbourTown.status().models.find(m => m.id === 'main-elaina').behavior.mode === 'greet');
    await page.screenshot({ path: path.join(output, `${map}-native.png`) });
    console.log(map, JSON.stringify({ graphics: status.graphics, textures: status.models.map(m => ({ id: m.id, ...m.textures })) }));
    // Same CSS size, different monitor DPI. Intermediate and final buffers agree.
    await page.evaluate(() => { Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1.75 }); dispatchEvent(new Event('resize')); });
    await page.waitForFunction(() => HarbourTown.status().graphics.pixelRatio === 1.75);
    const resized = await page.evaluate(() => HarbourTown.status().graphics);
    assert.equal(resized.bufferWidth, 1400); assert.equal(resized.sceneWidth, 1400);
    assert.equal(resized.bufferHeight, 875); assert.equal(resized.sceneHeight, 875);
  }
  assert.ok(requests.some(url => /\/source-[a-f0-9]+\.png$/.test(url)), 'uses actual source assets');
  // Quality reload keeps the independently chosen frame rate and view; no reset to 30.
  const pose = await page.evaluate(() => HarbourTown.status().position);
  await openTownMenu(page);
  await Promise.all([page.waitForEvent('load'), page.getByLabel('画质', { exact: true }).selectOption('high')]); await ready();
  assert.equal(await page.evaluate(() => HarbourTown.status().graphics.targetFps), 120);
  assert.equal(await page.evaluate(() => HarbourTown.status().graphics.pixelRatio), 1.5);
  assert.ok(await page.evaluate(p => Math.hypot(HarbourTown.status().position[0] - p[0], HarbourTown.status().position[2] - p[2]) < .3, pose));
  assert.deepEqual(errors, []); console.log('Native quality screenshots:', output);
});
