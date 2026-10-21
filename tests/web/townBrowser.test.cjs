const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openTownMenu, visitTownResident, openTownChat, exerciseTownMovement, exerciseTownSocial } = require('./town-ui.cjs');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { chromium } = require('../../vendor/folia/node_modules/playwright');
const web = path.resolve(__dirname, '../../web');
const { townAudioFixture } = require('./town-audio-fixture.cjs');

test('real Three scene: residents, hover look, fullscreen, persistent routing, chat and disposal', { timeout: 240000 }, async t => {
  const host = `<!doctype html><link rel="stylesheet" href="/town-host.css"><style>html,body{margin:0;height:100%}#root{height:100%;display:flex}</style><main id="root"></main><script>window.entries=new Map();window.HarbourUnsavedChanges={register(id,e){entries.set(id,e);return()=>entries.delete(id)}};</script><script src="/town.js"></script><script>window.dispose=HarbourTownUI.mount(document.getElementById('root'));</script>`;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://local').pathname;
    if (pathname === '/town/audio/local/lingering-summer-light.m4a' && !fs.existsSync(path.join(web, pathname))) {
      res.setHeader('Content-Type', 'audio/wav'); res.end(townAudioFixture(8)); return;
    }
    if (pathname === '/host') { res.setHeader('Content-Type', 'text/html'); res.end(host); return; }
    const file = path.resolve(web, `.${decodeURIComponent(pathname)}`);
    if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const types = { '.js': 'application/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream'); fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ headless: true, args: ['--mute-audio'], executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const errors = [], outbound = [], runs = [], modelRequests = [];
  const sessions = new Map();
  let finishRun, historyGate;
  const arrivals = [];
  const waitRun = n => runs.length >= n ? Promise.resolve() : new Promise(resolve => { arrivals.push({ n, resolve }); });
  await context.route('**/api/**', async route => {
    const url = new URL(route.request().url()); const body = route.request().postDataJSON();
    if (url.pathname === '/api/conversations') { if (historyGate) await historyGate; return route.fulfill({ json: { enabled: true, activeId: [...sessions.values()].find(s => s.key === url.searchParams.get('key'))?.id || null } }); }
    if (url.pathname === '/api/conversations/new') { const session = { ...body, id: body.agentName + '-town', messages: [] }; sessions.set(session.id, session); return route.fulfill({ json: { session } }); }
    if (url.pathname.startsWith('/api/conversations/')) return route.fulfill({ json: { session: sessions.get(url.pathname.split('/').at(-1)) } });
    if (url.pathname === '/api/run') { runs.push(body); await new Promise(resolve => { finishRun = resolve; arrivals.filter(a => runs.length >= a.n).forEach(a => a.resolve()); }); return route.fulfill({ json: { answer: '风吹过车站的时候，慢慢聊也很好。\n<script>window.evil=1</script>' } }); }
    if (url.pathname.endsWith('/abort')) { finishRun?.(); return route.fulfill({ json: { stopping: true } }); }
    return route.fulfill({ json: { asks: [] } });
  });
  context.on('request', req => {
    // Authenticated local audio uses a blob URL; that is not an outbound request.
    if (new URL(req.url()).origin !== `http://127.0.0.1:${server.address().port}`) outbound.push(req.url());
    if (req.url().includes('/town/models/local/')) modelRequests.push(req.url());
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error' && /THREE|WebGL|shader/i.test(msg.text())) errors.push(msg.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/host`);
  const frame = page.frames().find(f => f.url().includes('/town/index'));
  assert.ok(frame);
  await frame.waitForFunction(() => window.HarbourTown?.status().ready || document.querySelector('.loading button'), null, { timeout: 150000 });
  assert.equal(await frame.evaluate(() => HarbourTown.status().ready), true, await frame.locator('#loading').innerText());
  await frame.waitForFunction(() => HarbourTown.status().frames > 1);
  assert.equal(await frame.evaluate(() => HarbourTown.status().residents), 3);
  const hasLocalModels = fs.existsSync(path.join(web, 'town/models/local/manifest.json'));
  if (hasLocalModels) {
    const models = await frame.evaluate(() => HarbourTown.status().models);
    const imported = JSON.parse(fs.readFileSync(path.join(web, 'town/models/local/manifest.json'))).residents;
    assert.equal(models.filter(m => m.type === 'mmd').length, Object.keys(imported).length, JSON.stringify(models));
    assert.ok(models.filter(m => m.type === 'mmd').every(m => m.activeMorphs <= 4 && m.physics === false));
  }
  assert.equal(runs.length, 0, 'scene loading must not call LLM');
  const initialResizes = await frame.evaluate(() => HarbourTown.status().graphics.resizeCount);
  await frame.evaluate(() => { for (let i = 0; i < 30; i++) window.dispatchEvent(new Event('resize')); });
  await page.waitForTimeout(100);
  assert.equal(await frame.evaluate(() => HarbourTown.status().graphics.resizeCount), initialResizes, 'identical bounds do not recreate GPU buffers');
  assert.ok(await frame.evaluate(() => HarbourTown.status().models.every(m => m.behavior.walkableCells > 2)), 'all residents have connected walking space');
  const patrolStart = await frame.evaluate(() => HarbourTown.status().models.map(m => [m.behavior.x, m.behavior.z]));
  // Moving over the canvas turns the camera with no button held. UI hover does not.
  await page.mouse.move(680, 400);
  const yaw = await frame.evaluate(() => HarbourTown.status().yaw);
  await page.mouse.move(860, 400, { steps: 8 });
  await frame.waitForFunction(value => Math.abs(HarbourTown.status().yaw - value) > .05, yaw);
  await openTownMenu(frame);
  const settingsPose = await frame.evaluate(() => { const { position, yaw, pitch, frames } = HarbourTown.status(); return { position, yaw, pitch, frames }; });
  await page.keyboard.down('KeyW'); await page.mouse.move(950, 390, { steps: 5 }); await page.waitForTimeout(120); await page.keyboard.up('KeyW');
  const afterSettingsInput = await frame.evaluate(() => { const { position, yaw, pitch, frames } = HarbourTown.status(); return { position, yaw, pitch, frames }; });
  assert.deepEqual(afterSettingsInput.position, settingsPose.position, 'settings cannot move the player');
  assert.equal(afterSettingsInput.yaw, settingsPose.yaw); assert.equal(afterSettingsInput.pitch, settingsPose.pitch);
  assert.ok(afterSettingsInput.frames > settingsPose.frames, 'residents and the scene keep animating behind settings');
  await frame.locator('#look').click();
  const fixedYaw = await frame.evaluate(() => HarbourTown.status().yaw);
  await page.mouse.move(600, 380); await page.mouse.move(850, 410, { steps: 8 });
  await page.waitForTimeout(100);
  assert.equal(await frame.evaluate(() => HarbourTown.status().yaw), fixedYaw, 'look switch releases camera');
  await frame.locator('#look').click();
  const uiYaw = await frame.evaluate(() => HarbourTown.status().yaw);
  await frame.locator('#sound').hover(); await frame.locator('#quality').hover();
  await page.waitForTimeout(100);
  assert.equal(await frame.evaluate(() => HarbourTown.status().yaw), uiYaw, 'hover over toolbar never turns');
  await frame.locator('#settings-close').click();
  const sceneBox = await frame.locator('#scene').boundingBox();
  await page.mouse.move(sceneBox.x + sceneBox.width - 2, sceneBox.y + sceneBox.height / 2);
  const edgeYaw = await frame.evaluate(() => HarbourTown.status().yaw);
  await frame.waitForFunction(value => Math.abs(HarbourTown.status().yaw - value) > .25, edgeYaw);
  await frame.locator('#settings-toggle').hover();
  await frame.waitForFunction(() => HarbourTown.status().models.every(m => m.behavior.time > 6));
  const patrolEnd = await frame.evaluate(() => HarbourTown.status().models.map(m => [m.behavior.x, m.behavior.z]));
  assert.ok(patrolEnd.every((p, i) => Math.hypot(p[0] - patrolStart[i][0], p[1] - patrolStart[i][1]) > .05), 'all real rigs actually change world position');
  await frame.locator('#scene').click({ position: { x: 650, y: 400 } });
  await frame.waitForFunction(() => HarbourTown.status().pointerLocked);
  const lockYaw = await frame.evaluate(() => HarbourTown.status().yaw);
  await page.mouse.move(3100, 410, { steps: 12 });
  await frame.waitForFunction(value => Math.abs(HarbourTown.status().yaw - value) > Math.PI, lockYaw);
  await page.keyboard.press('Alt');
  await frame.waitForFunction(() => !HarbourTown.status().pointerLocked && HarbourTown.status().cursorReleased);
  const releasedYaw = await frame.evaluate(() => HarbourTown.status().yaw);
  await page.mouse.move(sceneBox.x + sceneBox.width - 2, sceneBox.y + sceneBox.height / 2);
  await page.waitForTimeout(150);
  assert.equal(await frame.evaluate(() => HarbourTown.status().yaw), releasedYaw, 'released cursor does not keep turning at the screen edge');
  assert.match(await frame.locator('#look-hint').textContent(), /鼠标已释放/);
  await frame.locator('#scene').click({ position: { x: 650, y: 400 } });
  await frame.waitForFunction(() => HarbourTown.status().pointerLocked);
  await page.keyboard.press('m');
  await frame.waitForFunction(() => !HarbourTown.status().pointerLocked && !document.getElementById('settings-panel').hidden);
  await page.keyboard.press('m');
  assert.equal(await frame.locator('#settings-panel').isHidden(), true);
  assert.equal(await frame.evaluate(() => HarbourTown.status().pointerLocked), false, 'closing the menu does not silently recapture the mouse');
  await frame.locator('#scene').click({ position: { x: 650, y: 400 } });
  await frame.waitForFunction(() => HarbourTown.status().pointerLocked);
  await page.keyboard.press('Escape');
  await frame.waitForFunction(() => !HarbourTown.status().pointerLocked);
  await openTownMenu(frame);
  await frame.locator('#fullscreen').click();
  await frame.waitForFunction(() => !!document.fullscreenElement);
  await frame.locator('#fullscreen').click();
  await frame.waitForFunction(() => !document.fullscreenElement);
  await frame.locator('#settings-close').click();
  await exerciseTownMovement(frame, page.keyboard);
  const output = process.env.TOWN_SCREENSHOT_DIR || path.join(os.tmpdir(), 'harbour-town-preview'); fs.mkdirSync(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'town-wide.png') });
  await openTownMenu(frame, 'residents');
  await page.screenshot({ path: path.join(output, 'town-residents-menu.png'), animations: 'disabled' });
  await openTownMenu(frame, 'help');
  await page.screenshot({ path: path.join(output, 'town-help-menu.png'), animations: 'disabled' });
  await openTownMenu(frame);
  await page.screenshot({ path: path.join(output, 'town-settings-wide.png'), animations: 'disabled' });
  await frame.locator('#settings-close').click();
  await exerciseTownSocial(frame, page.keyboard, name => page.screenshot({ path: path.join(output, `${name}.png`) }));
  await visitTownResident(frame, 'chisa');
  await frame.waitForFunction(() => document.querySelector('#interact').textContent.includes('和千咲互动'));
  await frame.locator('#interact').click();
  await frame.locator('[data-social="wave"]').click();
  await frame.waitForFunction(() => HarbourTown.status().models.find(m => m.id === 'chisa').behavior.mode === 'greet');
  assert.equal(await frame.locator('#chat').isHidden(), true, 'visitor does not open a fake Main conversation');
  assert.equal(runs.length, 0); assert.equal(sessions.size, 0);
  await frame.waitForFunction(() => HarbourTown.status().models.find(m => m.id === 'chisa').behavior.phase > .8);
  await page.screenshot({ path: path.join(output, 'town-chisa-model.png') });
  if (hasLocalModels && JSON.parse(fs.readFileSync(path.join(web, 'town/models/local/manifest.json'))).residents.chisa) {
    await openTownMenu(frame, 'residents');
    await frame.locator('.appearance summary').click();
    await frame.getByLabel('千咲模型版本').selectOption('standard');
    await frame.waitForFunction(() => HarbourTown.status().models.find(m => m.id === 'chisa').variant === 'standard');
    await frame.getByLabel('千咲模型版本').selectOption('original');
    await frame.waitForFunction(() => HarbourTown.status().models.find(m => m.id === 'chisa').variant === 'original');
    await frame.locator('.appearance summary').click();
    await frame.locator('#settings-close').click();
  }
  await visitTownResident(frame, 'main-elaina');
  await frame.locator('#interact').waitFor({ state: 'visible' }).catch(async error => {
    console.log('Town focus failure:', await frame.evaluate(() => ({ status: HarbourTown.status(), notice: document.querySelector('#notice').textContent })), errors);
    await page.screenshot({ path: path.join(output, 'town-focus-failure.png') });
    throw error;
  });
  const renderNext = async () => {
    const frames = await frame.evaluate(() => HarbourTown.status().frames);
    await frame.waitForFunction(count => HarbourTown.status().frames > count + 1, frames);
  };
  await renderNext();
  assert.equal(await frame.evaluate(() => HarbourTown.status().models[0].behavior.mode), 'greet');
  assert.match(await frame.locator('#interact').innerText(), /伊蕾娜/, 'focus selects the resident we look at, not the closer neighbour');
  await page.screenshot({ path: path.join(output, 'town-elaina-model.png') });
  if (hasLocalModels) {
    // The prepass must use deformed geometry and each group's cut-out texture,
    // then reset uniforms so unrelated station meshes remain opaque.
    assert.equal(await frame.evaluate(async () => {
      const THREE = await import('/town/lib/three/build/three.module.js');
      const { extendModelPrepass, bindModelPrepass } = await import('/town/model-rendering.js');
      const pass = new THREE.ShaderMaterial({ vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>', fragmentShader: 'void main(){}' });
      extendModelPrepass(pass);
      const map = new THREE.Texture();
      const mesh = { material: [{ map, opacity: .8, alphaTest: .6 }] };
      bindModelPrepass(mesh);
      mesh.onBeforeRender(null, null, null, null, pass, { materialIndex: 0 });
      const valid = pass.uniforms.uTownMap.value === map && pass.uniforms.uTownOpacity.value === .8 && pass.uniforms.uTownCutoff.value === .6
        && pass.vertexShader.includes('#include <morphtarget_vertex>') && pass.vertexShader.includes('#include <morphnormal_vertex>');
      mesh.onAfterRender(null, null, null, null, pass);
      map.dispose(); pass.dispose();
      return valid && pass.uniforms.uTownUseMap.value === 0 && pass.uniforms.uTownOpacity.value === 1 && pass.uniforms.uTownCutoff.value === 0;
    }), true);
    await openTownMenu(frame, 'residents');
    await frame.locator('.appearance summary').click();
    await context.route('**/town/models/local/main-elaina/light.pmx', route => route.fulfill({ status: 503 }));
    await frame.getByLabel('伊蕾娜服装').selectOption('light');
    await frame.waitForFunction(() => document.querySelector('#notice').textContent.includes('换装未完成'));
    assert.equal(await frame.evaluate(() => HarbourTown.status().models[0].variant), 'original', 'failed swap keeps old avatar');
    await context.unroute('**/town/models/local/main-elaina/light.pmx');
    await frame.getByLabel('伊蕾娜服装').selectOption('light');
    await frame.waitForFunction(() => HarbourTown.status().models[0].variant === 'light');
    await renderNext();
    await page.screenshot({ path: path.join(output, 'town-elaina-light.png') });
    await frame.getByLabel('伊蕾娜服装').selectOption('long-sleeve');
    await frame.waitForFunction(() => HarbourTown.status().models[0].variant === 'long-sleeve');
    await renderNext();
    await page.screenshot({ path: path.join(output, 'town-elaina-long-sleeve.png') });
    await frame.getByLabel('伊蕾娜服装').selectOption('original');
    await frame.waitForFunction(() => HarbourTown.status().models[0].variant === 'original');
    await renderNext();
    await frame.locator('.appearance summary').click();
    await frame.locator('#settings-close').click();
    // Isolate resource accounting from the station's moving trains/NPCs, which
    // legitimately upload previously unseen textures while the scene runs.
    const memory = await frame.evaluate(async () => {
      const THREE = await import('/town/lib/three/build/three.module.js');
      const { loadAvatar, disposeAvatar, residentCatalogue } = await import('/town/model-residents.js');
      const { extendModelPrepass } = await import('/town/model-rendering.js');
      const { createRenderPipeline } = await import('/town/station/src/core/renderer.js');
      const signal = new AbortController().signal, catalog = await residentCatalogue(signal);
      const renderer = new THREE.WebGLRenderer({ canvas: document.createElement('canvas') }); renderer.setSize(128, 128);
      const pipeline = createRenderPipeline(renderer, { msaa: 0 }); extendModelPrepass(pipeline.ndMat); pipeline.setSize(128, 128, 1);
      const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(58, 1, .1, 100);
      camera.position.set(0, 1.4, 3); camera.lookAt(0, 1, 0); scene.add(new THREE.AmbientLight(0xffffff));
      const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()); box.position.z = -3; scene.add(box);
      const render = () => pipeline.render(scene, camera, new THREE.Vector3(0, 1, 0), 0);
      render(); const baseline = { ...renderer.info.memory }, after = [];
      try {
        for (const id of ['original', 'light', 'long-sleeve', 'original']) {
          const mesh = await loadAvatar('main-elaina', catalog['main-elaina'].variants.find(v => v.id === id), signal);
          scene.add(mesh); render(); render();
          disposeAvatar(mesh); render();
          after.push({ ...renderer.info.memory });
        }
        return { baseline, after };
      } finally { box.geometry.dispose(); box.material.dispose(); renderer.dispose(); renderer.forceContextLoss(); }
    });
    for (const after of memory.after) assert.deepEqual(after, memory.baseline, 'each removed avatar releases its GPU geometry, bone/morph textures and maps');
  }
  let releaseHistory;
  await frame.locator('#interact').click();
  await frame.locator('[data-social="pat"]').click();
  await frame.waitForFunction(() => HarbourTown.status().models.find(m => m.id === 'main-elaina').behavior.mode === 'pat');
  assert.equal(await frame.locator('[data-social="chat"]').isEnabled(), true, 'an ongoing local gesture never locks the chat entrance');
  await frame.waitForFunction(() => !HarbourTown.status().social.gesture);
  historyGate = new Promise(resolve => { releaseHistory = resolve; });
  await openTownChat(frame);
  await openTownMenu(frame, 'residents');
  releaseHistory(); historyGate = null;
  await frame.waitForFunction(() => !document.getElementById('send').disabled);
  assert.equal(await frame.locator('#settings-panel').isVisible(), true, 'late history cannot dismiss the menu or focus the hidden chat');
  assert.equal(await frame.locator('#chat').isVisible(), false);
  await frame.locator('#settings-close').click();
  await frame.locator('#message').fill('WASD，今天过得怎么样？');
  const position = await frame.evaluate(() => HarbourTown.status().position);
  await frame.locator('#message').press('w'); await frame.locator('#message').press('f');
  await frame.locator('#message').press('ArrowLeft');
  assert.deepEqual(await frame.evaluate(() => HarbourTown.status().position), position, 'typing must not move camera');
  await frame.locator('#send').click();
  await frame.waitForFunction(() => HarbourTown.status().busy);
  await frame.waitForFunction(() => HarbourTown.status().models[0].behavior.mode === 'think');
  await waitRun(1);
  assert.equal(runs.length, 1); assert.equal(runs[0].agent, 'main-elaina');
  assert.equal(runs[0].session.key, 'web:town:main-elaina');
  assert.match(runs[0].input, /用户摸了摸你的头/);
  assert.doesNotMatch(runs[0].input, /刚才猜拳/, 'Chisa activity is not passed to Elaina');
  assert.equal(await page.evaluate(() => entries.get('town-chat').isDirty()), true);
  await page.evaluate(() => { dispose(); const input = document.createElement('input'); input.id = 'other-section'; document.getElementById('root').replaceChildren(input); input.focus(); });
  assert.equal(await frame.evaluate(() => HarbourTown.status().busy), true, 'switching sections never cancels an in-flight chat');
  finishRun();
  await frame.waitForFunction(() => !HarbourTown.status().busy);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'other-section', 'background reply does not steal keyboard focus');
  await page.evaluate(() => { window.dispose = HarbourTownUI.mount(document.getElementById('root')); });
  await frame.locator('.bubble.assistant').waitFor();
  await frame.waitForFunction(() => HarbourTown.status().models[0].behavior.mode === 'reply');
  assert.equal(await frame.evaluate(() => window.evil), undefined);
  await page.screenshot({ path: path.join(output, 'town-chat.png') });
  await frame.locator('#chat-close').click();
  await visitTownResident(frame, 'main-aemeath');
  await frame.waitForFunction(() => document.querySelector('#interact').textContent.includes('爱弥斯'));
  await renderNext();
  await page.screenshot({ path: path.join(output, 'town-aemeath-model.png') });
  await openTownChat(frame);
  assert.equal(await frame.locator('#chat-name').textContent(), '爱弥斯');
  await frame.locator('#message').fill('停止测试'); await frame.locator('#send').click();
  await frame.waitForFunction(() => HarbourTown.status().busy);
  await waitRun(2);
  await frame.locator('#stop').click(); await frame.waitForFunction(() => !HarbourTown.status().busy);
  assert.equal(runs[1].agent, 'main-aemeath');
  await frame.locator('#chat-close').click();
  // Simulated visibility transition exercises our handler; not a claim about OS minimization.
  await openTownMenu(frame);
  await frame.locator('#sound').click();
  await frame.waitForFunction(() => HarbourTown.status().audio.state === 'running');
  await frame.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await frame.waitForFunction(() => HarbourTown.status().audio.state === 'suspended');
  const hiddenFrames = await frame.evaluate(() => HarbourTown.status().frames);
  const hiddenResizes = await frame.evaluate(() => HarbourTown.status().graphics.resizeCount);
  await page.setViewportSize({ width: 1100, height: 780 });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForTimeout(200);
  assert.equal(await frame.evaluate(() => HarbourTown.status().frames), hiddenFrames);
  assert.equal(await frame.evaluate(() => HarbourTown.status().graphics.resizeCount), hiddenResizes, 'hidden resize is deferred');
  await frame.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await frame.waitForFunction(count => HarbourTown.status().frames > count, hiddenFrames);
  await frame.waitForFunction(() => HarbourTown.status().audio.state === 'running');
  assert.equal(await frame.evaluate(() => HarbourTown.status().graphics.resizeCount), hiddenResizes + 1, 'resume applies only the latest dimensions');
  await openTownMenu(frame);
  await frame.locator('#sound').click();
  await frame.locator('#pause').click();
  const count = await frame.evaluate(() => HarbourTown.status().frames);
  const pausedResizes = await frame.evaluate(() => HarbourTown.status().graphics.resizeCount);
  await page.waitForTimeout(250);
  assert.equal(await frame.evaluate(() => HarbourTown.status().frames), count);
  await page.setViewportSize({ width: 600, height: 740 });
  await page.waitForTimeout(100);
  assert.equal(await frame.evaluate(() => HarbourTown.status().graphics.resizeCount), pausedResizes);
  await frame.locator('#pause').click();
  await page.screenshot({ path: path.join(output, 'town-settings-narrow.png'), animations: 'disabled' });
  await frame.locator('#settings-close').click();
  await openTownChat(frame);
  await page.screenshot({ path: path.join(output, 'town-narrow.png') });
  assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await frame.locator('#send').isVisible(), true);
  await frame.locator('#message').fill('未发送的草稿');
  assert.equal(await page.evaluate(() => entries.get('town-chat').isDirty()), true);
  assert.equal(await page.evaluate(() => entries.get('town-chat').discard()), true);
  assert.equal(await page.evaluate(() => entries.get('town-chat').isDirty()), false);
  await frame.locator('#message').fill('切换栏目后还在的草稿');
  await frame.locator('#chat-close').click();
  await visitTownResident(frame, 'main-aemeath');
  await frame.locator('#interact').click();
  await frame.locator('[data-social="follow"]').click();
  await openTownChat(frame);
  assert.equal(await frame.locator('#message').inputValue(), '切换栏目后还在的草稿');
  const retained = await frame.evaluate(() => HarbourTown.snapshot());
  const requestCount = modelRequests.length;
  await page.evaluate(() => { window.oldTown = document.querySelector('iframe').contentWindow.HarbourTown; dispose(); document.getElementById('root').replaceChildren(); });
  assert.equal(await page.evaluate(() => oldTown.status().destroyed), false);
  assert.equal(await page.locator('iframe').count(), 1);
  const backgroundFrames = await frame.evaluate(() => HarbourTown.status().frames);
  await page.waitForTimeout(200);
  assert.equal(await frame.evaluate(() => HarbourTown.status().frames), backgroundFrames, 'hidden town draws no frames');
  await page.evaluate(() => { window.dispose = HarbourTownUI.mount(document.getElementById('root')); });
  assert.equal(await page.evaluate(() => oldTown === document.querySelector('iframe').contentWindow.HarbourTown), true, 'route return retains exact world instance');
  assert.equal(await frame.locator('#message').inputValue(), '切换栏目后还在的草稿');
  assert.deepEqual(await frame.evaluate(() => HarbourTown.snapshot().pose.position), retained.pose.position);
  await frame.waitForFunction(n => HarbourTown.status().frames > n, backgroundFrames);
  assert.equal(modelRequests.length, requestCount, 'route return does not refetch model files or textures');
  // Browser popup transfers drafts/pose, while the embedded world stays paused.
  const popupEvent = page.waitForEvent('popup');
  await openTownMenu(frame);
  await frame.locator('#popout').click();
  const popup = await popupEvent; popup.on('pageerror', e => errors.push(e.message));
  await popup.waitForFunction(() => window.HarbourTown?.status().ready && document.getElementById('message').value === '切换栏目后还在的草稿', null, { timeout: 90000 });
  // The shared map restore validates the floor and converts eye/feet height;
  // that arithmetic can differ by one ULP, not an actual camera displacement.
  assert.ok((await popup.evaluate(() => HarbourTown.status().position)).every((n, i) => Math.abs(n - retained.pose.position[i]) < 1e-6));
  assert.equal(await frame.evaluate(() => HarbourTown.status().hidden), true);
  assert.deepEqual(await popup.evaluate(() => HarbourTown.status().social.companion), retained.social.companion, 'browser popout carries the current companion');
  assert.ok((await popup.evaluate(() => {
    const m = HarbourTown.status().models.find(m => m.id === 'main-aemeath'); return [m.behavior.x, m.behavior.z];
  })).every((v, i) => Math.abs(v - [retained.pose.models.find(m => m.id === 'main-aemeath').behavior.x, retained.pose.models.find(m => m.id === 'main-aemeath').behavior.z][i]) < .02), 'companion location survives window handoff');
  await page.evaluate(() => { dispose(); document.getElementById('root').replaceChildren(); });
  const popFrames = await popup.evaluate(() => HarbourTown.status().frames);
  await popup.waitForFunction(n => HarbourTown.status().frames > n + 1, popFrames);
  await openTownMenu(popup);
  await popup.locator('#popout').click();
  await page.waitForFunction(() => !document.querySelector('.town-stage'));
  await page.evaluate(() => { window.dispose = HarbourTownUI.mount(document.getElementById('root')); });
  await page.locator('iframe').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#message').inputValue(), '切换栏目后还在的草稿');
  await frame.evaluate(() => HarbourTown.discard());
  await page.evaluate(() => { dispose(); HarbourTownUI.destroy(); });
  assert.equal(await page.evaluate(() => oldTown.status().destroyed), true);
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(await page.evaluate(() => entries.size), 0);
  assert.deepEqual(errors, []); assert.deepEqual(outbound, []);
  console.log('Town screenshots:', output);
});
