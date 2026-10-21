const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { chromium } = require('../../vendor/folia/node_modules/playwright');
const web = path.resolve(__dirname, '../../web');

test('MMD alpha: soft overlays blend, cutouts reach the shader, real eyes/hair retain alpha', { timeout: 120000 }, async t => {
  // Isolated local renderer, no backend, user browser, API or model calls.
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://local').pathname;
    if (pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<style>body{margin:0}</style><script type="importmap">{"imports":{"three":"/town/lib/three/build/three.module.js"}}</script>'); return;
    }
    const file = path.resolve(web, `.${decodeURIComponent(pathname)}`);
    if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  const errors = [], outbound = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error' && /THREE|WebGL|shader/i.test(msg.text())) errors.push(msg.text()); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  page.on('request', req => {
    const url = new URL(req.url());
    if (url.origin !== origin && !req.url().startsWith('data:image/png;base64,')) outbound.push(req.url());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const pixels = await page.evaluate(async () => {
    const THREE = await import('three');
    const { MMDLoader } = await import('/town/lib/three/examples/jsm/loaders/MMDLoader.js');
    const { configureModelMaterial } = await import('/town/model-rendering.js');
    // Build the actual pinned MMDToonMaterial without private-class exports.
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new MMDLoader().meshBuilder.materialBuilder.build({ metadata: { format: 'pmx', materialCount: 1, morphCount: 0 }, morphs: [], textures: [],
      materials: [{ name: 'alpha-fixture', diffuse: [1, 1, 1, 1], ambient: [0, 0, 0], specular: [0, 0, 0], shininess: 1,
        flag: 1, textureIndex: -1, envTextureIndex: -1, toonIndex: -1, toonFlag: 1, edgeSize: 0, edgeColor: [0, 0, 0, 0] }] }, geometry)[0];
    const unusedToon = material.gradientMap; material.gradientMap = null;
    const map = new THREE.DataTexture(new Uint8Array([255,255,255,0, 255,255,255,64, 255,255,255,128, 255,255,255,255]), 4, 1);
    map.needsUpdate = true; map.transparent = true; material.map = map;
    const renderer = new THREE.WebGLRenderer(); renderer.setSize(64, 16); renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#0044cc'); scene.add(new THREE.AmbientLight(0xffffff, Math.PI));
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 10); camera.position.z = 2;
    scene.add(new THREE.Mesh(geometry, material));
    const target = new THREE.WebGLRenderTarget(64, 16);
    const render = () => {
      renderer.setRenderTarget(target); renderer.render(scene, camera);
      return [8,24,40,56].map(x => { const pixel = new Uint8Array(4); renderer.readRenderTargetPixels(target, x, 8, 1, 1, pixel); return [...pixel]; });
    };
    try {
      configureModelMaterial(material);
      const blended = { pixels: render(), transparent: material.transparent, depthWrite: material.depthWrite, cutoff: material.uniforms.alphaTest.value };
      map.transparent = false; configureModelMaterial(material);
      const cutout = { pixels: render(), transparent: material.transparent, depthWrite: material.depthWrite, cutoff: material.uniforms.alphaTest.value };
      material.opacity = .5; configureModelMaterial(material);
      return { blended, cutout, scalarAlpha: material.transparent && !material.depthWrite };
    } finally { material.dispose(); unusedToon.dispose(); map.dispose(); geometry.dispose(); target.dispose(); renderer.dispose(); renderer.forceContextLoss(); }
  });
  assert.equal(pixels.blended.transparent, true); assert.equal(pixels.blended.depthWrite, false);
  assert.equal(pixels.blended.cutoff, 1 / 255); assert.equal(pixels.cutout.cutoff, .45);
  assert.equal(pixels.cutout.transparent, false); assert.equal(pixels.cutout.depthWrite, true); assert.equal(pixels.scalarAlpha, true);
  const red = pixels.blended.pixels.map(p => p[0]);
  assert.equal(red[0], 0, 'alpha=0 must reveal the background, not an opaque white layer');
  assert.ok(red[1] > 0 && red[1] < red[2] && red[2] < red[3], JSON.stringify(pixels));
  assert.deepEqual(pixels.cutout.pixels[0], pixels.cutout.pixels[1], 'alpha=.25 must be discarded at cutoff=.45');
  assert.equal(pixels.cutout.pixels[2][0], pixels.cutout.pixels[3][0], 'opaque pass keeps pixels above cutoff');

  const hasLocalModels = fs.existsSync(path.join(web, 'town/models/local/manifest.json'));
  if (hasLocalModels) {
    const output = process.env.TOWN_SCREENSHOT_DIR || path.join(os.tmpdir(), 'harbour-town-alpha'); fs.mkdirSync(output, { recursive: true });
    const catalogue = JSON.parse(fs.readFileSync(path.join(web, 'town/models/local/manifest.json'))).residents;
    for (const id of ['main-aemeath', ...(catalogue.chisa ? ['chisa'] : [])]) {
    const materials = await page.evaluate(async id => {
      const THREE = await import('three');
      const { loadAvatar, residentCatalogue, disposeAvatar } = await import('/town/model-residents.js');
      const signal = new AbortController().signal, catalog = await residentCatalogue(signal);
      const mesh = await loadAvatar(id, catalog[id].variants.find(v => v.id === catalog[id].defaultVariant), signal);
      const scene = new THREE.Scene(); scene.background = new THREE.Color('#747e8c'); scene.add(mesh);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x777788, 2));
      const light = new THREE.DirectionalLight(0xffffff, 2); light.position.set(-1, 3, 4); scene.add(light);
      const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.setSize(900, 900); document.body.append(renderer.domElement);
      const camera = new THREE.PerspectiveCamera(28, 1, .01, 100);
      const render = angle => { camera.position.set(Math.sin(angle) * 1.15, 1.53, Math.cos(angle) * 1.15); camera.lookAt(0, 1.44, 0); renderer.render(scene, camera); };
      render(0);
      window.alphaPreview = { render, mesh, dispose() { disposeAvatar(mesh); renderer.domElement.remove(); renderer.dispose(); renderer.forceContextLoss(); } };
      return mesh.material.map(m => ({ name: m.name, opacity: m.opacity, mapAlpha: m.map?.transparent === true,
        transparent: m.transparent, depthWrite: m.depthWrite, cutoff: m.alphaTest, shaderCutoff: m.uniforms.alphaTest.value, visible: m.visible }));
    }, id);
    for (const m of materials.filter(m => m.visible !== false)) {
      if (m.mapAlpha || m.opacity < 1) { assert.equal(m.transparent, true, m.name); assert.equal(m.depthWrite, false, m.name); }
      assert.equal(m.shaderCutoff, m.cutoff, m.name);
    }
    if (id === 'main-aemeath') {
    for (const name of ['MI_Eyehi2', 'MI_Eye hi', '后发+2', '后发+', '前发+']) {
      const m = materials.find(m => m.name === name); assert.ok(m, name);
      assert.equal(m.transparent, true, `${name}: texture/scalar alpha must blend`);
      assert.equal(m.depthWrite, false, `${name}: overlay must not occlude underlying eyes/hair`);
      assert.equal(m.shaderCutoff, m.cutoff);
    }
    for (const name of ['MI_Eye', 'face', '后发', '前发']) {
      const m = materials.find(m => m.name === name);
      assert.equal(m.transparent, false, `${name}: solid base stays opaque`); assert.equal(m.depthWrite, true);
    }
    assert.equal(materials.find(m => m.name === 'MI_Eye hi+').visible, false, 'author-disabled extra highlight stays hidden');
    } else {
      for (const name of ['EYE', 'MI_Bangs', 'MI_Hair']) assert.equal(materials.find(m => m.name === name)?.visible, true, name);
      assert.equal(materials.find(m => m.name === 'EYE2red blue').visible, false, 'alternate author-disabled iris stays hidden');
    }
    for (const [name, angle] of [['front', 0], ['side', .65], ['back', Math.PI]]) {
      await page.evaluate(angle => alphaPreview.render(angle), angle);
      await page.screenshot({ path: path.join(output, `${id === 'main-aemeath' ? 'aemeath' : id}-alpha-${name}.png`) });
    }
    await page.evaluate(() => alphaPreview.dispose());
    console.log(`Actual ${id} alpha materials:`, JSON.stringify(materials.filter(m => /Eye|EYE|Hair|Bangs|发/.test(m.name))));
    }
    console.log('Alpha closeups:', output);
  }
  assert.deepEqual(errors, []); assert.deepEqual(outbound, []);
});
