const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { TownController, isTownWindow } = require('../town/controller');
const { registerTownIpc } = require('../town/ipc');
const { createCloseGuard } = require('../companion/close-guard');

// Real Electron view/preload/IPC and real Three scene; never foreground a window.
const output = process.env.TOWN_SCREENSHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-town-native-'));
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-town-profile-')));
app.on('window-all-closed', () => {});
app.on('browser-window-created', (_event, win) => {
  for (const method of ['show', 'showInactive', 'focus', 'moveTop', 'restore']) win[method] = () => {};
  // Exercise fullscreen dispatch/state without taking over the user's monitor.
  let full = false;
  win.setFullScreen = value => { full = value; win.emit(value ? 'enter-full-screen' : 'leave-full-screen'); };
  win.isFullScreen = () => full;
});
app.on('web-contents-created', (_event, contents) => { contents.focus = () => {}; });
for (const name of ['showMessageBox', 'showMessageBoxSync', 'showErrorBox']) dialog[name] = () => { throw new Error('Unexpected native dialog'); };
const closeGuard = createCloseGuard({ app, ipcMain, dialog, cleanup: async () => {} });
let town, dashboard, server, phase = 'start', runs = 0, returned = 0;
const errors = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let reportedPhase;
async function until(check, timeout = 120000) {
  if (reportedPhase !== phase) { reportedPhase = phase; console.log('TOWN_NATIVE_PHASE', phase); }
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw new Error(`Timed out: ${phase}`); await wait(80); }
}
async function cleanup() { town?.dispose(); if (dashboard && !dashboard.isDestroyed()) dashboard.destroy(); server?.closeAllConnections(); server?.close(); }
app.whenReady().then(async () => {
  const root = path.resolve(__dirname, '../../web');
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/run') runs++;
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ enabled: true, activeId: null, asks: [] })); return;
    }
    if (url.pathname === '/host') { res.setHeader('Content-Type', 'text/html'); res.end('<title>Background dashboard</title><link rel="stylesheet" href="/town-host.css"><style>html,body{height:100%;margin:0}#root{height:100%;display:flex}</style><main id="root"></main><script src="/town.js"></script>'); return; }
    const file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp' })[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  dashboard = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { preload: path.resolve(__dirname, '../preload.js'), sandbox: false, contextIsolation: true, nodeIntegration: false } });
  await dashboard.loadURL(url + '/host');
  town = new TownController({ url, onReturn: () => returned++,
    onState: state => { if (!dashboard.isDestroyed()) dashboard.webContents.send('desktop:town-state', state); }, onWindow: win => {
    assert.equal(isTownWindow(win), true);
    closeGuard.register(win, { required: true });
    win.webContents.on('console-message', details => { if (details.level === 'error' && /WebGL|shader|TypeError/.test(details.message)) errors.push(details.message); });
    win.webContents.on('preload-error', (_event, _path, error) => console.error('PRELOAD_ERROR', error.message));
    win.webContents.on('did-fail-load', (_event, code, error) => console.error('LOAD_ERROR', code, error));
  } });
  registerTownIpc({ ipcMain, controller: () => town, dashboard: event => {
    if (event.sender !== dashboard.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('invalid dashboard'); return dashboard;
  } });
  phase = 'embedded';
  await town.open('embedded', dashboard, { x: 20, y: 70, width: 1300, height: 800 });
  const wc = town.view.webContents, id = wc.id;
  const evaluate = code => wc.executeJavaScript(code);
  await until(() => evaluate('!!window.HarbourTown'));
  assert.equal(await evaluate('!!window.harbourTownHost'), true);
  assert.equal(await evaluate('typeof window.harbourDesktop'), 'undefined', 'Town does not receive broad desktop tools');
  assert.equal(await evaluate('HarbourTown.status().hidden'), true, 'hidden dashboard does not paint');
  await wait(150);
  assert.equal(await evaluate('HarbourTown.status().ready'), false, 'hidden startup defers expensive world building');
  // Never-shown native windows receive no compositor RAF. Supply only the clock
  // for this background fixture; WebGL, movement, IPC and lifetime stay real.
  // Browser tests separately exercise real RAF + Fullscreen API. No FPS claim.
  await evaluate('HarbourTown.setVisible(false); window.requestAnimationFrame=fn=>setTimeout(()=>fn(performance.now()),16); window.cancelAnimationFrame=id=>clearTimeout(id); void 0');
  await town.open('window');
  await until(() => evaluate('HarbourTown.status().ready'));
  await town.open('embedded', dashboard, { x: 20, y: 70, width: 1300, height: 800 });
  const pose = await evaluate('HarbourTown.snapshot().pose.position');
  await evaluate('window.retainedTown=HarbourTown; window.confirm=()=>false; document.querySelector("[data-resident=main-aemeath]").click()');
  // Same renderer can call only its narrow IPC. Foreign contents/subframes denied.
  assert.equal(town.owns({ sender: dashboard.webContents, senderFrame: dashboard.webContents.mainFrame }), false);
  assert.equal(town.owns({ sender: wc, senderFrame: {} }), false);
  assert.equal(town.owns({ sender: wc, senderFrame: wc.mainFrame }), true);
  phase = 'popout';
  await evaluate('harbourTownHost.popout()');
  assert.equal(town.mode, 'window'); assert.equal(wc.id, id);
  await until(() => evaluate('HarbourTown.status().frames > 2'));
  assert.equal(await evaluate('HarbourTown===retainedTown'), true);
  assert.equal(await evaluate('HarbourTown.status().residents'), 3);
  await evaluate('document.querySelector("[data-resident=chisa]").click()');
  await until(() => evaluate('document.getElementById("interact").textContent.includes("和千咲互动")'));
  await evaluate('document.getElementById("interact").click()');
  await evaluate('document.querySelector("[data-social=wave]").click()');
  await until(() => evaluate('HarbourTown.status().models.find(m=>m.id==="chisa").behavior.mode==="greet"'));
  assert.equal(await evaluate('document.getElementById("chat").hidden'), true);
  assert.equal(runs, 0, 'visitor greeting is entirely local');
  await evaluate('document.querySelector("[data-resident=main-aemeath]").click()');
  town.hide(dashboard); assert.equal(town.mode, 'window', 'sidebar leaves independent renderer running');
  const count = await evaluate('HarbourTown.status().frames');
  await until(async () => await evaluate('HarbourTown.status().frames') > count + 1);
  // Hidden native windows have no compositor surface to capture. Real visual
  // screenshots are produced by townBrowser; do not show a window for capture.
  phase = 'fullscreen'; await evaluate('harbourTownHost.fullscreen()');
  assert.equal(town.status().fullscreen, true);
  await evaluate('harbourTownHost.fullscreen()'); assert.equal(town.status().fullscreen, false);
  await evaluate('harbourTownHost.dock()'); assert.equal(returned, 1);
  phase = 'redock and zoom';
  dashboard.webContents.setZoomFactor(1.25);
  await town.open('embedded', dashboard, { x: 20, y: 70, width: 900, height: 600, clipLeft: 40 });
  assert.equal(wc.id, id); assert.equal(await evaluate('HarbourTown===retainedTown'), true);
  assert.deepEqual(town.view.getBounds(), { x: -50, y: 0, width: 1125, height: Math.min(750, dashboard.getContentSize()[1] - 88) });
  assert.equal(town.dock.clip.getBounds().x, 75);
  town.hide(dashboard); assert.equal(town.mode, 'background');
  await until(() => evaluate('HarbourTown.status().hidden'));
  const paused = await evaluate('HarbourTown.status().frames'); await wait(200); assert.equal(await evaluate('HarbourTown.status().frames'), paused);
  await town.open('embedded', dashboard, { x: 20, y: 70, width: 900, height: 600 });
  assert.equal(wc.id, id);
  phase = 'Dashboard reload retains and parks its native Town';
  const clip = town.dock.clip;
  await town.open('embedded', dashboard, { x: 20, y: 70, width: 900, height: 600 });
  assert.equal(town.dock.clip, clip, 'repeat embedding reuses the native clip');
  await dashboard.loadURL(url + '/host');
  assert.equal(town.mode, 'background'); assert.equal(town.dock, null);
  assert.equal(await evaluate('HarbourTown===retainedTown'), true, 'Dashboard refresh does not reload Town');
  await town.open('embedded', dashboard, { x: 20, y: 70, width: 900, height: 600 });
  phase = 'draft and close guard';
  await town.open('window');
  await evaluate('document.getElementById("social-close").click(); document.querySelector("[data-resident=main-aemeath]").click()');
  await until(() => evaluate('!document.getElementById("interact").hidden'));
  await evaluate('document.getElementById("interact").click()');
  await evaluate('document.querySelector("[data-social=chat]").click()');
  await until(() => evaluate('!document.getElementById("chat").hidden && !document.getElementById("send").disabled'));
  await evaluate('document.getElementById("message").value="保留这条草稿"');
  town.win.close();
  await until(() => evaluate('!!document.querySelector(".town-close-dialog[open]")'));
  await evaluate('document.querySelector(".town-close-dialog [data-stay]").click()'); await wait(100);
  assert.equal(town.win.isDestroyed(), false, 'cancel close retains the draft and world');
  assert.equal(await evaluate('document.getElementById("message").value'), '保留这条草稿');
  await town.open('embedded', dashboard, { x: 20, y: 70, width: 900, height: 600 });
  assert.equal(await evaluate('document.getElementById("message").value'), '保留这条草稿');
  assert.equal(await evaluate('HarbourTown===retainedTown'), true);
  await evaluate('HarbourTown.discard()');
  phase = 'Dashboard bridge routing';
  await dashboard.webContents.executeJavaScript('window.disposeTown=HarbourTownUI.mount(document.getElementById("root")); void 0');
  await until(() => dashboard.webContents.executeJavaScript('document.querySelector(".town-detached")?.hidden===true'));
  assert.equal(wc.id, id);
  await dashboard.webContents.executeJavaScript('disposeTown(); document.getElementById("root").replaceChildren()');
  await until(() => town.mode === 'background');
  await dashboard.webContents.executeJavaScript('window.disposeTown=HarbourTownUI.mount(document.getElementById("root")); void 0');
  await until(() => town.mode === 'embedded');
  assert.equal(wc.id, id);
  await evaluate('harbourTownHost.popout()');
  await dashboard.webContents.executeJavaScript('disposeTown(); document.getElementById("root").replaceChildren()');
  assert.equal(town.mode, 'window');
  phase = 'late open cancellation';
  await town.open('embedded', dashboard, { x: 20, y: 70, width: 900, height: 600 }); town.hide(dashboard);
  const ensure = town.ensure.bind(town); town.ensure = async () => { await wait(80); return ensure(); };
  const pending = town.open('embedded', dashboard, { x: 20, y: 70, width: 900, height: 600 }); town.hide(dashboard); await pending;
  assert.equal(town.mode, 'background'); assert.equal(town.dock, null);
  town.ensure = ensure;
  assert.notDeepEqual(await evaluate('HarbourTown.snapshot().pose.position'), pose);
  if (fs.existsSync(path.join(root, 'town/maps/suibo/source/src/core/env.js'))) {
    phase = 'native map switch and exact IPC URL';
    await town.open('window');
    await evaluate('document.getElementById("message").value="桌面跨地图草稿"; localStorage.setItem("harbour-town-quality","low"); document.getElementById("map").value="suibo"; document.getElementById("map").dispatchEvent(new Event("change")); void 0');
    try {
      await until(async () => { try { return await evaluate('HarbourTown?.status().ready && HarbourTown.status().mapId === "suibo"'); } catch { return false; } });
    } catch (error) {
      console.error('MAP_SWITCH_STATE', wc.getURL(), await evaluate('({ status: window.HarbourTown?.status(), loading: document.getElementById("loading")?.innerText, map: localStorage.getItem("harbour-town-map"), transferring: window.HarbourTown?.isTransferring(), dialog: !!document.querySelector("dialog[open]") })'));
      throw error;
    }
    assert.equal(wc.id, id); assert.equal(wc.getURL(), town.url, 'map choice must not expand the trusted IPC URL');
    assert.equal(town.owns({ sender: wc, senderFrame: wc.mainFrame }), true);
    assert.equal(await evaluate('HarbourTown.status().residents'), 3);
    await until(() => evaluate('document.getElementById("loading").hidden'));
    assert.equal(await evaluate('document.getElementById("message").value'), '桌面跨地图草稿');
    await evaluate('HarbourTown.discard()');
    for (const target of [url + '/host', town.url + '?map=station']) {
      await evaluate(`location.assign(${JSON.stringify(target)}); void 0`); await wait(100);
      assert.equal(wc.getURL(), town.url, 'other same-origin pages and query-expanded URLs remain denied');
    }
    await evaluate('HarbourTown.setVisible(false); window.requestAnimationFrame=fn=>setTimeout(()=>fn(performance.now()),16); window.cancelAnimationFrame=id=>clearTimeout(id); void 0');
    await evaluate('harbourTownHost.popout()');
    await until(() => evaluate('HarbourTown.status().frames > 2'));
    assert.equal(town.mode, 'window'); assert.equal(wc.id, id);
    await evaluate('harbourTownHost.fullscreen()'); assert.equal(town.status().fullscreen, true);
    await evaluate('harbourTownHost.fullscreen()');
    await town.open('embedded', dashboard, { x: 20, y: 70, width: 900, height: 600 });
    await until(() => evaluate('HarbourTown.status().hidden'));
    assert.equal(wc.id, id);
    assert.equal(await evaluate('HarbourTown.status().graphics.resources.buffersSuspended'), true);
    const frame = await evaluate('HarbourTown.status().frames');
    await town.open('window');
    await until(async () => await evaluate('HarbourTown.status().frames') > frame + 1);
    assert.equal(await evaluate('HarbourTown.status().graphics.resources.buffersSuspended'), false);
    assert.equal(await evaluate('HarbourTown.status().lighting.cafeResidents'), true);
    assert.equal(wc.id, id, 'cache eviction keeps the existing native scene');
  }
  phase = 'crashed renderer is retried explicitly without a second native view';
  wc.forcefullyCrashRenderer();
  await until(() => !!town.status().error);
  assert.equal(town.status().visible, false);
  // Exercise a failed first retry and then the real HTTP reload. The page remains
  // backgrounded, so this does not silently restart a chat or rebuild another map.
  const loadURL = wc.loadURL.bind(wc);
  wc.loadURL = () => Promise.reject(new Error('fixture: server temporarily unavailable'));
  await assert.rejects(town.open('embedded', dashboard, { x: 20, y: 70, width: 900, height: 600 }), /temporarily unavailable/);
  assert.equal(town.view.webContents.id, id); assert.ok(town.needsReload);
  wc.loadURL = loadURL;
  await town.open('embedded', dashboard, { x: 20, y: 70, width: 900, height: 600 });
  assert.equal(town.view.webContents.id, id); assert.equal(town.status().error, '');
  await until(() => evaluate('!!window.HarbourTown'));
  assert.equal(await evaluate('HarbourTown.status().ready'), false);
  phase = 'closing Dashboard parks Town';
  dashboard.destroy(); assert.equal(town.mode, 'background'); assert.equal(town.dock, null);
  assert.equal(runs, 0); assert.deepEqual(errors, []);
  // This assertion reads Electron's real visibility (show/focus calls were suppressed).
  assert.ok(BrowserWindow.getAllWindows().every(win => !win.isVisible()));
  await cleanup(); console.log('TOWN_NATIVE_BACKGROUND_OK', JSON.stringify({ sameWebContents: id, llmCalls: runs, output, fullscreen: 'IPC/state tested without taking over monitor', frameClock: 'test timer; never-shown native window' })); app.exit(0);
}).catch(async error => { console.error('TOWN_NATIVE_FAIL', phase, error.stack || error); await cleanup(); app.exit(1); });
setTimeout(() => { console.error('TOWN_NATIVE_TIMEOUT', phase); void cleanup().finally(() => app.exit(1)); }, 240000).unref();
