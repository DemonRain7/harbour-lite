const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), os = require('node:os');
const { chromium } = require('../../vendor/folia/node_modules/playwright');
const root = path.resolve(__dirname, '../..'), web = path.join(root, 'web');

// Only observe the isolated renderer. This never attaches to the user's browser,
// backend, bots or LLM. Driver/process RSS is deliberately not called VRAM usage.
function observeGL() {
  const contexts = [];
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...args) {
    const gl = original.apply(this, args);
    if (args[0] !== 'webgl2' || !gl || contexts.some(c => c.gl === gl)) return gl;
    const resources = {};
    for (const kind of ['Texture', 'Buffer', 'Renderbuffer', 'Framebuffer', 'Program']) {
      const live = resources[kind] = new Set(), create = gl[`create${kind}`].bind(gl), remove = gl[`delete${kind}`].bind(gl);
      gl[`create${kind}`] = (...values) => { const result = create(...values); live.add(result); return result; };
      gl[`delete${kind}`] = result => { live.delete(result); return remove(result); };
    }
    contexts.push({ gl, resources }); return gl;
  };
  window.townGL = () => contexts.map(({ resources }) => Object.fromEntries(Object.entries(resources).map(([key, values]) => [key, values.size])));
}

test('Suibo lighting, foreground/background buffers and teardown in isolated real WebGL', {
  timeout: 240000, skip: !fs.existsSync(path.join(web, 'town/maps/suibo/source/src/core/env.js')),
}, async t => {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://local').pathname), file = path.resolve(web, '.' + name);
    if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
    res.setHeader('Content-Type', ({ '.js': 'application/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream');
    if (name === '/town/scene.js') return res.end(fs.readFileSync(file, 'utf8').replace('const scene = new THREE.Scene();', 'const scene = new THREE.Scene(); window.townSceneForAudit = scene;'));
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
  const errors = [], requests = []; page.on('pageerror', e => errors.push(e.message));
  page.on('request', request => requests.push(request.url()));
  page.on('console', msg => { if (msg.type() === 'error' && /shader|WebGL|GL_INVALID/i.test(msg.text())) errors.push(msg.text()); });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1' || url.pathname.startsWith('/api/')) { errors.push(`Unexpected request ${url.pathname}`); return route.abort(); }
    return route.continue();
  });
  await page.addInitScript(observeGL);
  await page.addInitScript(() => { localStorage.setItem('harbour-town-quality', 'high'); localStorage.setItem('harbour-town-fps', '60'); });
  await page.goto(`http://127.0.0.1:${server.address().port}/town/index.html?map=suibo`);
  await page.waitForFunction(() => window.HarbourTown?.status().frames > 4, null, { timeout: 150000 });
  const cdp = await page.context().newCDPSession(page);
  const report = { viewport: { width: 1000, height: 650 }, quality: 'high' };
  const capture = async name => {
    await cdp.send('HeapProfiler.collectGarbage');
    report[name] = { ...await page.evaluate(() => {
      const geometries = new Map();
      townSceneForAudit.traverse(o => {
        const g = o.geometry; if (!g || geometries.has(g)) return;
        const bytes = Object.values(g.attributes).reduce((n, a) => n + (a.array || a.data?.array).byteLength, g.index?.array.byteLength || 0);
        geometries.set(g, { name: o.name, bytes, vertices: g.attributes.position?.count, indexed: !!g.index, indexing: g.userData.townIndexing });
      });
      return { status: HarbourTown.status(), gl: townGL(), geometryBytes: [...geometries.values()].reduce((n, g) => n + g.bytes, 0),
        indexedSavings: [...geometries.values()].reduce((n, g) => n + (g.indexing ? g.indexing.sourceBytes - g.indexing.indexedBytes : 0), 0),
        largestGeometries: [...geometries.values()].sort((a,b) => b.bytes - a.bytes).slice(0, 15) };
    }), heap: await cdp.send('Runtime.getHeapUsage') };
  };
  await capture('active');
  const output = process.env.TOWN_PERF_OUTPUT || path.join(os.tmpdir(), 'harbour-town-suibo-performance');
  fs.mkdirSync(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'night-cafe.png') });
  // Fixed camera for inspection; residents still animate, so not a pixel baseline.
  await page.evaluate(async () => {
    await HarbourTown.restore({ pose: { position: [35.1, .35, 55.1], yaw: Math.PI, pitch: -.07, timeOfDay: 1 }, hoverLook: false });
  });
  await page.waitForFunction(() => HarbourTown.status().frames > 8);
  await page.screenshot({ path: path.join(output, 'night-resident.png') });
  const modelsLoaded = requests.filter(url => /\/(models|motions)\//.test(url)).length;
  await page.evaluate(() => HarbourTown.setVisible(false));
  await capture('hidden');
  const frame = report.hidden.status.frames;
  await page.waitForTimeout(120);
  assert.equal(await page.evaluate(() => HarbourTown.status().frames), frame, 'hidden scene stops rendering');
  await page.evaluate(() => HarbourTown.setVisible(true));
  await page.waitForFunction(n => HarbourTown.status().frames > n + 2, frame);
  await capture('resumed');
  assert.equal(report.resumed.status.timeOfDay, 1);
  assert.equal(report.resumed.status.quality, 'high');
  assert.equal(report.resumed.status.graphics.targetFps, 60);
  assert.ok(report.resumed.status.models.every(model => model.type === 'mmd'));
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => HarbourTown.setVisible(false));
    const n = await page.evaluate(() => HarbourTown.status().frames);
    await page.evaluate(() => HarbourTown.setVisible(true));
    await page.waitForFunction(value => HarbourTown.status().frames > value + 1, n);
  }
  await capture('cycled');
  assert.equal(requests.filter(url => /\/(models|motions)\//.test(url)).length, modelsLoaded, 'returning to Town does not reload models or motions');
  await page.evaluate(() => HarbourTown.destroy());
  await capture('destroyed');
  fs.writeFileSync(path.join(output, 'resources.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Suibo resource report:', output, JSON.stringify(Object.fromEntries(Object.entries(report).filter(([,v]) => v.gl).map(([key, v]) => [key, { gl: v.gl, heap: v.heap, resources: v.status.graphics?.resources }]))));
  assert.deepEqual(errors, []);
  if (!process.env.TOWN_PERF_BASELINE) {
    assert.equal(report.active.status.lighting.cafeResidents, true);
    assert.equal(report.active.status.lighting.pointLights, 14, 'no inert padded lights or extra café shadow lights');
    assert.ok(report.active.indexedSavings > 350 * 1048576, 'actual full map static-data savings, not a synthetic microbenchmark');
    assert.ok(report.active.geometryBytes < 450 * 1048576);
    assert.equal(report.cycled.geometryBytes, report.active.geometryBytes, 'resume does not rebuild/duplicate geometry');
    assert.equal(report.hidden.status.graphics.resources.buffersSuspended, true);
    assert.equal(report.resumed.status.graphics.resources.buffersSuspended, false);
    assert.ok(report.hidden.gl[0].Renderbuffer < report.active.gl[0].Renderbuffer);
    assert.ok(report.hidden.gl[0].Texture < report.active.gl[0].Texture);
    assert.deepEqual(report.cycled.gl, report.resumed.gl, 'repeated hiding does not accumulate GPU resources');
    assert.equal(report.destroyed.gl[0].Renderbuffer, 0);
    assert.equal(report.destroyed.gl[0].Framebuffer, 0);
    assert.equal(report.destroyed.gl[0].Buffer, 0, 'old indexed attributes and per-instance buffers are released too');
  }
});
