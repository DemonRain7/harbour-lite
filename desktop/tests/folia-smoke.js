const { app, BrowserWindow, protocol } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { FoliaController } = require('../folia/controller');
const { SCHEMES } = require('../folia/host');
const { packagedFoliaRoot } = require('./packaged-folia-root');
// Isolated real renderer smoke; no owner account, API generation or existing app instance.
const taskDir = mkdtempSync(path.join(os.tmpdir(), 'harbour-folia-test-'));
app.setPath('userData', taskDir);
protocol.registerSchemesAsPrivileged(SCHEMES);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
let phase = 'electron-ready';
let activeController;
// A native CI failure must identify the pending boundary, even if the renderer
// cannot answer JavaScript. These diagnostics only use the isolated fixture.
async function diagnostic() {
  const controller = activeController;
  const win = controller?.runtime?.getMainWindow();
  const bounded = promise => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve('unresponsive'), 1500))]);
  const state = { phase, mode: controller?.mode, starting: !!controller?.starting,
    closing: !!controller?.closing, rendererReady: !!controller?.rendererReady,
    windows: controller?.host ? [...controller.host.windows].map(w => ({ visible: w.isVisible(), url: w.webContents.getURL() })) : [] };
  if (controller?.runtime) state.runtimeReady = await bounded(controller.runtime.ready.then(() => true, e => e.message));
  if (win && !win.isDestroyed()) state.renderer = await bounded(win.webContents.executeJavaScript('JSON.stringify({bridge:!!window.harbourFolia,ready:document.readyState,splash:!!document.querySelector("#app-splash"),textLength:document.body.innerText.length})').catch(e => e.message));
  console.log('[folia smoke diagnostic]', JSON.stringify(state));
}
const progress = label => { phase = label; console.log('[folia smoke]', label); };
app.whenReady().then(async () => {
  const host = new BrowserWindow({ show: false, width: 1280, height: 850 });
  const errors = [];
  const controller = new FoliaController({ dataDir: path.join(taskDir, 'folia'), offline: true,
    root: process.argv.includes('--packaged') ? packagedFoliaRoot(path.resolve(__dirname, '..')) : undefined });
  activeController = controller;
  progress('cold Remote');
  await controller.open('remote');
  assert.equal(controller.mode, 'background', 'cold Remote opens only the remote presentation');
  assert.equal(controller.runtime.getMainWindow().isVisible(), false);
  assert.ok([...controller.host.windows].some(w => w !== controller.runtime.getMainWindow() && w.isVisible()));
  progress('close cold Remote');
  await controller.close();
  await host.loadURL('data:text/html,<title>Folia integration smoke</title>');
  host.show();
  progress('cold embedded');
  await controller.open('embedded', host, { x: 0, y: 70, width: 1280, height: 760 });
  const win = controller.runtime.getMainWindow();
  assert.equal(win.getTitle(), 'Folia', 'the music window must not be mislabeled Harbour');
  win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  const id = win.webContents.id;
  let ready;
  for (let i = 0; i < 100; i++) {
    ready = await win.webContents.executeJavaScript(`({
      splash: !!document.querySelector('#app-splash'),
      home: !!document.querySelector('[data-folia-home]'),
      bridge: !!window.harbourFolia,
      text: document.body.innerText
    })`);
    if (!ready.splash && ready.home && ready.bridge) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // Require the real library view and IPC bridge, not a locale-dependent text count.
  assert.ok(!ready.splash && ready.home && ready.bridge, JSON.stringify(ready));
  assert.equal(await win.webContents.executeJavaScript('!!document.querySelector(".lattice-root")'), false);
  const text = ready.text;
  assert.equal(controller.mode, 'embedded');
  // This is an ordinary React hover/cleanup IPC, not a request for a new window.
  await win.webContents.executeJavaScript('window.electron.setMainWindowClickThroughUnlockHover(false)');
  assert.equal(controller.mode, 'embedded', 'unlock hover must not pop the player out of Harbour');
  assert.equal(await win.webContents.executeJavaScript('window.electron.getMainWindowClickThroughEnabled()'), false);
  // Embedded has no independent click-through surface; even a stale button
  // must neither undock nor disable document input.
  await win.webContents.executeJavaScript('window.electron.setMainWindowClickThroughEnabled(true)');
  assert.equal(controller.mode, 'embedded');
  assert.equal(await win.webContents.executeJavaScript('window.electron.getMainWindowClickThroughEnabled()'), false);
  await controller.open('window');
  await win.webContents.executeJavaScript('window.electron.setMainWindowClickThroughEnabled(true)');
  assert.equal(await win.webContents.executeJavaScript('window.electron.getMainWindowClickThroughEnabled()'), true);
  await controller.open('embedded', host, { x: 0, y: 70, width: 1280, height: 760 });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await win.webContents.executeJavaScript('window.electron.getMainWindowClickThroughEnabled()'), false);
  assert.equal(await win.webContents.executeJavaScript('document.documentElement.dataset.clickThrough'), undefined);
  controller.dock.view.setVisible(false);
  await controller.open('window');
  assert.equal(controller.host.views.get(win).getVisible(), true, 'an overlay-hidden view becomes visible in the new window');
  assert.equal(controller.runtime.getMainWindow().webContents.id, id);
  progress('native hide');
  win.hide();
  for (let i = 0; i < 40 && controller.mode !== 'background'; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(controller.mode, 'background', 'native hide/close must update the dashboard presentation state');
  progress('presentation and Remote reuse');
  await controller.open('window');
  await controller.open('remote');
  const remote = [...controller.host.windows].find(w => w !== win);
  for (let i = 0; i < 100 && !remote?.isVisible(); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(remote?.isVisible(), 'the very first Remote request must show a window');
  await controller.open('remote');
  assert.equal(controller.host.windows.size, 2, 'repeated Remote opens reuse one window');
  remote.close();
  await new Promise(resolve => remote.isDestroyed() ? resolve() : remote.once('closed', resolve));
  await controller.open('remote');
  assert.equal(controller.host.windows.size, 2, 'closed Remote can be reopened');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok([...controller.host.windows].some(w => w !== win && w.isVisible()));
  await controller.open('embedded', host, { x: 0, y: 70, width: 1280, height: 760 });
  assert.equal(controller.runtime.getMainWindow().webContents.id, id);
  progress('commands');
  const volume = await controller.command({ action: 'set_volume', volume: 0 });
  assert.equal(volume.volume, 0);
  await assert.rejects(controller.command({ action: 'play', trackId: 'invented-id' }), /曲目 ID/);
  await assert.rejects(controller.command({ action: 'resume' }), /请先选择歌曲/);
  await assert.rejects(controller.command({ action: 'play' }), /请先选择歌曲/);
  const reportDir = path.join(__dirname, '../../assets/reports/folia');
  mkdirSync(reportDir, { recursive: true });
  // The cold player no longer flashes a visible window. Give the embedded view
  // a real visible host before requesting a compositor frame for this artifact.
  progress('capture embedded');
  host.focus();
  try { await win.webContents.capturePage(); } catch (error) {
    if (error.message !== 'UnknownVizError') throw error;
  }
  await new Promise(resolve => setTimeout(resolve, 200));
  try {
    writeFileSync(path.join(reportDir, 'embedded.png'), (await win.webContents.capturePage()).toPNG());
  } catch (error) { throw new Error('Embedded smoke capture failed', { cause: error }); }
  host.hide();
  progress('close and concurrent reopen');
  const before = controller.host.windows.size;
  await controller.close();
  const opening = controller.open('embedded', host, { x: 0, y: 70, width: 1280, height: 760 });
  const closing = controller.close();
  await Promise.all([opening, closing]);
  assert.equal(controller.runtime, null, 'unload wins over an in-flight startup');
  assert.equal(controller.runtime, null);
  assert.equal(host.isDestroyed(), false, 'Closing Folia must not close Harbour');
  const leavingDuringOpen = controller.open('embedded', host, { x: 0, y: 70, width: 1280, height: 760 });
  controller.hide(host);
  await leavingDuringOpen;
  assert.equal(controller.mode, 'background', 'page leave cancels a pending embed without popping a window');
  assert.equal(controller.runtime.getMainWindow().isVisible(), false);
  await controller.open('embedded', host, { x: 0, y: 70, width: 1280, height: 760 });
  await controller.close();
  console.log(JSON.stringify({ status: 'FOLIA_SMOKE_OK', windowsBeforeClose: before, text: text.slice(0, 180), errors }));
  app.exit(0);
}).catch(async error => { console.error(error); await diagnostic(); app.exit(1); });
setInterval(() => { void diagnostic(); }, 20_000).unref();
setTimeout(async () => { console.error('Folia smoke timed out'); await diagnostic(); app.exit(1); }, 90_000).unref();
