const { app, BrowserWindow, protocol, dialog, shell, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { FoliaController } = require('../folia/controller');
const { SCHEMES } = require('../folia/host');

// desktop/tests/folia-controller-background.js
// Real controller/host/preload/renderer, isolated profile and runtime; native show/focus
// calls are recorded but suppressed so this diagnostic never foregrounds a window.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-folia-controller-'));
const source = path.resolve(__dirname, '../../vendor/folia');
const root = path.join(fixture, 'runtime');
fs.mkdirSync(root);
for (const name of ['electron', 'shared']) fs.cpSync(path.join(source, name), path.join(root, name), { recursive: true });
fs.copyFileSync(path.join(source, 'package.json'), path.join(root, 'package.json'));
for (const name of ['node_modules', 'build', 'dist']) {
  fs.symlinkSync(path.join(source, name), path.join(root, name), process.platform === 'win32' ? 'junction' : 'dir');
}
app.setPath('userData', path.join(fixture, 'profile'));
const originalGetPath = app.getPath.bind(app);
app.getPath = name => name === 'exe' ? path.join(fixture, 'bin', 'electron.exe') : originalGetPath(name);
process.chdir(fixture);
delete process.env.FOLIA_PENDING_DESKTOP_LYRIC;
protocol.registerSchemesAsPrivileged(SCHEMES);
app.on('window-all-closed', () => {});
const suppressed = [];
app.on('browser-window-created', (_event, win) => {
  for (const method of ['show', 'showInactive', 'focus', 'moveTop', 'restore']) {
    win[method] = () => { suppressed.push({ kind: 'window', method }); };
  }
});
app.on('web-contents-created', (_event, contents) => {
  contents.focus = () => { suppressed.push({ kind: 'contents', method: 'focus' }); };
  contents.on('media-started-playing', () => { throw new Error('Background controller test attempted media playback'); });
});
const forbidden = method => () => { throw new Error(`Background controller test attempted ${method}`); };
for (const method of ['showMessageBox', 'showMessageBoxSync', 'showErrorBox', 'showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync']) {
  dialog[method] = forbidden(method);
}
shell.openExternal = forbidden('openExternal');
let controller, dashboard;
let phase = 'ready';
async function inspect() {
  const win = controller?.runtime?.getMainWindow();
  const state = { phase, status: controller?.status(), suppressed, fixture };
  if (win && !win.isDestroyed()) {
    state.renderer = await Promise.race([
      win.webContents.executeJavaScript('({bridge:!!window.harbourFolia,home:!!document.querySelector("[data-folia-home]"),splash:!!document.querySelector("#app-splash"),readyState:document.readyState,children:document.querySelector("#root")?.children.length})').catch(error => ({ error: error.message })),
      new Promise(resolve => setTimeout(() => resolve({ unresponsive: true }), 1500)),
    ]);
  }
  console.log('FOLIA_CONTROLLER_BACKGROUND_DIAGNOSTIC', JSON.stringify(state));
}

app.whenReady().then(async () => {
  session.fromPartition('persist:harbour-folia').webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  dashboard = new BrowserWindow({ show: false, width: 1400, height: 1000 });
  await dashboard.loadURL('data:text/html,<title>Background controller fixture</title>');
  controller = new FoliaController({ root, dataDir: path.join(fixture, 'data'), offline: true });
  phase = 'ensure';
  await controller.ensure();
  assert.equal(controller.status().renderer.phase, 'ready');
  assert.equal(controller.mode, 'background');
  phase = 'production-playback-modes';
  // Exercise the shipped dist through the real IPC bridge, not only TS/source
  // fixtures: an old renderer must fail here instead of silently shipping again.
  const initialPlayback = await controller.command({ action: 'queue' });
  assert.equal(initialPlayback.playbackModeAvailable, true, 'production Folia must expose playback modes');
  assert.equal(initialPlayback.loaded, false);
  assert.equal(initialPlayback.playNextAvailable, false, 'shipped renderer exposes play-next and rejects an empty player');
  await assert.rejects(controller.command({ action: 'play_next', trackId: 'missing-fixture-song' }), /下一首播放/);
  for (const playbackMode of ['off', 'all', 'one', 'shuffle', 'shuffle', 'off']) {
    const result = await controller.command({ action: 'set_playback_mode', playbackMode });
    assert.equal(result.accepted, true);
    assert.equal(result.playbackMode, playbackMode);
    assert.equal(controller.status().playbackMode, playbackMode, 'host and renderer must agree');
    assert.equal(result.paused, true, 'changing modes never starts audio');
    assert.deepEqual(result.tracks, initialPlayback.tracks, 'changing modes never mutates the queue');
  }
  const contents = controller.runtime.getMainWindow().webContents;
  const playerId = contents.id;
  phase = 'embedded-open';
  const opened = await controller.open('embedded', dashboard, { x: 30, y: 80, width: 1100, height: 700 });
  assert.equal(opened.mode, 'embedded');
  assert.equal(controller.dock.window, dashboard);
  assert.equal(controller.dock.view.getVisible(), true);
  assert.equal(controller.dock.clip.getVisible(), true);
  assert.equal(await contents.executeJavaScript('window.harbourFolia.getPresentation()'), 'background', 'an embedded player in a hidden dashboard does not paint');
  assert.equal(await contents.executeJavaScript('window.electron.getMainWindowClickThroughEnabled()'), false);
  // Simulate the dashboard's visibility without foregrounding a native window.
  dashboard.isVisible = () => true; controller.publishPresentation();
  assert.equal(await contents.executeJavaScript('window.harbourFolia.getPresentation()'), 'embedded');
  controller.setVisualQuiet(true);
  assert.equal(await contents.executeJavaScript('window.harbourFolia.getPresentation()'), 'background');
  assert.equal(controller.runtime.getMainWindow().webContents.id, playerId);
  controller.setVisualQuiet(false);
  assert.equal(await contents.executeJavaScript('window.harbourFolia.getPresentation()'), 'embedded');
  dashboard.isVisible = () => false; controller.publishPresentation();
  phase = 'hide-and-reopen';
  controller.hide(dashboard);
  assert.equal(controller.mode, 'background');
  await controller.open('embedded', dashboard, { x: 30, y: 80, width: 1100, height: 700 });
  assert.equal(controller.mode, 'embedded');
  assert.equal(controller.runtime.getMainWindow().webContents.id, playerId);
  assert.ok(BrowserWindow.getAllWindows().every(win => !win.isVisible()));
  phase = 'passed';
  await inspect();
  await controller.close();
  dashboard.destroy();
  console.log('FOLIA_CONTROLLER_BACKGROUND_OK');
  app.exit(0);
}).catch(async error => {
  console.error(error.stack || error);
  await inspect();
  try { await controller?.close(); dashboard?.destroy(); } finally { app.exit(1); }
});
setTimeout(async () => { console.error('Background controller test timed out'); await inspect(); app.exit(1); }, 60000).unref();
