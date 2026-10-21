const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const { chromium } = require('../../vendor/folia/node_modules/playwright');
const web = path.resolve(__dirname, '../../web');
const catalogueFile = path.join(web, 'town/models/local/manifest.json');
const imported = fs.existsSync(catalogueFile);
const maskModule = import(pathToFileURL(path.join(web, 'town/model-hosiery-data.js')));

test('hosiery mask follows only body leg vertices, not nearby hands, shoes or other materials', async () => {
  const { elainaLegMask, validHosiery } = await maskModule;
  const vertex = (y, bone) => ({ position: [0, y, 0], skinIndices: [bone], skinWeights: [1] });
  const source = { bones: [{ name: '左足', position: [0, 10, 0] }, { name: '左手首' }],
    vertices: [vertex(7, 0), vertex(6, 1), vertex(7, 0), vertex(9.8, 0), vertex(11, 0)],
    faces: [{ indices: [0, 1, 3] }, { indices: [2, 2, 2] }, { indices: [4, 4, 4] }],
    materials: [{ name: '身体', faceCount: 1 }, { name: '鞋子', faceCount: 1 }, { name: '身体', faceCount: 1 }] };
  const before = structuredClone(source), mask = elainaLegMask(source);
  assert.equal(mask[0], 255); assert.equal(mask[1], 0, 'lowered hands are not leg skin');
  assert.equal(mask[2], 0, 'shoes have leg weights but must keep their original color');
  assert.ok(mask[3] > 0 && mask[3] < 255); assert.equal(mask[4], 0);
  assert.deepEqual(source, before); assert.ok(validHosiery('white')); assert.ok(validHosiery('original'));
  for (const value of [undefined, 'black', {}, '__proto__']) assert.equal(validHosiery(value), false);
  assert.equal(elainaLegMask({ ...source, materials: [] }), null);
  assert.equal(elainaLegMask({ ...source, bones: [] }), null);
});

test('all three supplied Elaina outfits have a bounded, body-only mask without changing source data', { skip: !imported }, async () => {
  const { elainaLegMask } = await maskModule;
  const { MMDParser } = await import(pathToFileURL(path.join(web, 'town/lib/three/examples/jsm/libs/mmdparser.module.js')));
  const entry = JSON.parse(fs.readFileSync(catalogueFile)).residents['main-elaina'];
  for (const variant of entry.variants) {
    const bytes = fs.readFileSync(path.join(path.dirname(catalogueFile), 'main-elaina', variant.pmx));
    const source = new MMDParser.Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), true);
    const body = new Set(); let offset = 0;
    for (const material of source.materials) {
      if (material.name === '身体') for (const face of source.faces.slice(offset, offset + material.faceCount)) face.indices.forEach(i => body.add(i));
      offset += material.faceCount;
    }
    const snapshot = JSON.stringify(source), mask = elainaLegMask(source);
    assert.ok(mask instanceof Uint8Array, variant.id); assert.equal(mask.length, source.vertices.length);
    assert.ok(mask.byteLength < 150000); let covered = 0;
    mask.forEach((value, i) => {
      if (!value) return; covered++; assert.ok(body.has(i), `body only: ${variant.id}`);
      assert.ok(source.vertices[i].position[1] < 11.5, 'no hands, head or upper body');
    });
    assert.ok(covered > 1000); assert.equal(JSON.stringify(source), snapshot);
    console.log(`Elaina ${variant.id}: ${covered} leg vertices, ${mask.byteLength} mask bytes`);
  }
});

test('real MMD renderer: reversible white hosiery, all outfits, walking, no extra draw/texture/network', { skip: !imported, timeout: 180000 }, async t => {
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://local').pathname;
    if (name === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<style>body{margin:0}</style><script type="importmap">{"imports":{"three":"/town/lib/three/build/three.module.js"}}</script>'); return; }
    const file = path.resolve(web, `.${decodeURIComponent(name)}`);
    if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : 'application/octet-stream'); fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 850, height: 1050 } });
  const errors = [], requests = [], outbound = [], origin = `http://127.0.0.1:${server.address().port}`;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error' && /THREE|WebGL|shader/i.test(msg.text())) errors.push(msg.text()); });
  page.on('request', req => { requests.push(req.url()); if (!req.url().startsWith(origin + '/') && !/^(blob:|data:)/.test(req.url())) outbound.push(req.url()); });
  await page.route('**/api/**', route => { errors.push('Unexpected API request'); return route.abort(); });
  await page.goto(origin);
  const output = process.env.TOWN_SCREENSHOT_DIR || path.join(os.tmpdir(), 'harbour-town-hosiery'); fs.mkdirSync(output, { recursive: true });
  const variants = JSON.parse(fs.readFileSync(catalogueFile)).residents['main-elaina'].variants;
  for (const variant of variants) {
    await page.evaluate(async variant => {
      const THREE = await import('three');
      const { loadAvatar, disposeAvatar } = await import('/town/model-residents.js');
      const { setAvatarHosiery } = await import('/town/model-hosiery.js');
      const { createAvatarMotion } = await import('/town/resident-motion.js');
      const { loadMotionClips } = await import('/town/motion-clips.js');
      const signal = new AbortController().signal;
      const mesh = await loadAvatar('main-elaina', variant, signal);
      const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.setSize(850, 1050); document.body.append(renderer.domElement);
      const scene = new THREE.Scene(); scene.background = new THREE.Color('#d9dee5');
      const root = new THREE.Group(); root.add(mesh); scene.add(root);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x7c738b, 1.5));
      const light = new THREE.DirectionalLight(0xfff1de, 1.5); light.position.set(-2, 3, 4); scene.add(light);
      const camera = new THREE.PerspectiveCamera(32, 850 / 1050, .01, 100); camera.position.set(.2, 1.05, 3.8); camera.lookAt(0, .93, 0);
      const ctx = { player: { position: camera.position }, camera, frameId: 0 };
      const resident = { id: 'main-elaina', motion: { x: 0, z: 0, ground: 0, yaw: 0, mode: 'idle', speed: 0, motionTime: .16, distance: 0 } };
      const update = createAvatarMotion(mesh, ctx, resident, await loadMotionClips(signal));
      const pose = mode => {
        resident.motion.mode = mode; resident.motion.speed = mode === 'walk' ? .6 : 0;
        for (let i = 0; i < 50; i++) {
          ctx.frameId++; resident.motion.phase = i / 30;
          resident.motion.distance += resident.motion.speed / 30; resident.motion.z += resident.motion.speed / 30;
          root.position.z = resident.motion.z;
          camera.position.z = resident.motion.z + 3.8; camera.lookAt(0, .93, resident.motion.z);
          update(1 / 30, ctx.frameId / 30);
        }
      };
      pose('idle');
      const target = new THREE.WebGLRenderTarget(425, 525);
      const pixels = () => { renderer.setRenderTarget(target); renderer.render(scene, camera); const bytes = new Uint8Array(425 * 525 * 4); renderer.readRenderTargetPixels(target, 0, 0, 425, 525, bytes); return bytes; };
      window.hosieryPreview = {
        render(value, walking = false) { setAvatarHosiery(mesh, value); if (walking) pose('walk'); renderer.setRenderTarget(null); renderer.render(scene, camera); },
        check() {
          const alphaBefore = mesh.material.map(m => [m.opacity, m.transparent, m.depthWrite, m.alphaTest]);
          setAvatarHosiery(mesh, 'original'); const before = pixels(), calls = renderer.info.render.calls, textures = renderer.info.memory.textures;
          setAvatarHosiery(mesh, 'white'); const after = pixels();
          let changed = 0, upperChanged = 0; for (let i = 0; i < before.length; i += 4) {
            if (Math.max(...[0, 1, 2].map(c => Math.abs(before[i + c] - after[i + c]))) < 2) continue;
            changed++; if (Math.floor(i / 4 / 425) > 525 * .65) upperChanged++;
          }
          for (let i = 0; i < 40; i++) setAvatarHosiery(mesh, i % 2 ? 'white' : 'original');
          setAvatarHosiery(mesh, 'original'); const restored = pixels();
          return { changed, upperChanged, restored: restored.every((value, i) => value === before[i]), callsBefore: calls, callsAfter: renderer.info.render.calls,
            texturesBefore: textures, texturesAfter: renderer.info.memory.textures, maskBytes: mesh.userData.townHosiery.maskBytes,
            alphaPreserved: JSON.stringify(alphaBefore) === JSON.stringify(mesh.material.map(m => [m.opacity, m.transparent, m.depthWrite, m.alphaTest])) };
        },
        dispose() { disposeAvatar(mesh); target.dispose(); renderer.domElement.remove(); renderer.dispose(); renderer.forceContextLoss(); },
      };
    }, variant);
    const count = requests.length, stats = await page.evaluate(() => hosieryPreview.check());
    assert.ok(stats.changed > 100, JSON.stringify(stats)); assert.equal(stats.upperChanged, 0, 'face, hair and upper body stay original');
    assert.equal(stats.restored, true, 'original appearance must be pixel-identical after toggling back');
    assert.equal(stats.callsAfter, stats.callsBefore); assert.equal(stats.texturesAfter, stats.texturesBefore);
    assert.equal(stats.alphaPreserved, true); assert.equal(requests.length, count);
    for (const value of ['original', 'white']) {
      await page.evaluate(value => hosieryPreview.render(value), value);
      await page.screenshot({ path: path.join(output, `elaina-${variant.id}-${value}.png`) });
    }
    await page.evaluate(() => hosieryPreview.render('white', true));
    await page.screenshot({ path: path.join(output, `elaina-${variant.id}-white-walk.png`) });
    await page.evaluate(() => hosieryPreview.dispose());
    console.log(variant.id, stats);
  }
  assert.deepEqual(errors, []); assert.deepEqual(outbound, []);
  console.log('Private appearance previews:', output);
});
