const { app, protocol, BrowserWindow, View, dialog, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createFoliaHost, SCHEMES } = require('../folia/host');

// Real Folia preload / main-process IPC / React integration in hidden, disposable
// windows. Never attach to the owner's profile, move the pointer or play audio.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-folia-input-'));
const source = path.resolve(__dirname, '../../vendor/folia');
const build = process.argv.find(arg => arg.startsWith('--build='))?.slice(8);
assert.ok(build && fs.existsSync(path.join(build, 'index.html')), 'pass an isolated --build= directory');
const root = path.join(fixture, 'runtime');
fs.mkdirSync(root);
for (const dir of ['electron', 'shared']) fs.cpSync(path.join(source, dir), path.join(root, dir), { recursive: true });
fs.copyFileSync(path.join(source, 'package.json'), path.join(root, 'package.json'));
for (const [dir, target] of [['node_modules', path.join(source, 'node_modules')], ['build', path.join(source, 'build')], ['dist', path.resolve(build)]]) {
  fs.symlinkSync(target, path.join(root, dir), process.platform === 'win32' ? 'junction' : 'dir');
}
app.setPath('userData', path.join(fixture, 'profile'));
process.chdir(fixture); // Don't let optional dependencies read Harbour's .env.
delete process.env.FOLIA_PENDING_DESKTOP_LYRIC;
protocol.registerSchemesAsPrivileged(SCHEMES);
app.on('window-all-closed', () => {});
const forbid = action => () => { throw new Error(`Background test attempted ${action}`); };
app.on('browser-window-created', (_event, win) => {
  for (const method of ['show', 'showInactive', 'focus', 'moveTop', 'restore']) win[method] = forbid(method);
});
app.on('web-contents-created', (_event, contents) => {
  contents.focus = forbid('webContents.focus');
  contents.on('media-started-playing', forbid('media playback'));
});
for (const method of ['showMessageBox', 'showMessageBoxSync', 'showErrorBox', 'showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync']) dialog[method] = forbid(method);
shell.openExternal = forbid('openExternal');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await pause(40); }
  assert.fail(message);
}
let host, runtime, dashboard, embedded = false;
app.whenReady().then(async () => {
  host = createFoliaHost({ root, dataDir: path.join(fixture, 'data'), offline: true,
    isPlayerEmbedded: () => embedded, onQuit: () => { throw new Error('Unexpected quit'); } });
  host.ipc.handle('harbour-folia:ready', () => true);
  host.ipc.handle('harbour-folia:get-presentation', () => embedded ? 'embedded' : 'window');
  runtime = require(path.join(root, 'electron/main.cjs'))(host);
  await runtime.ready;
  const player = runtime.getMainWindow(), wc = player.webContents;
  const js = code => wc.executeJavaScript(code);
  await until(() => js('!!window.electron && !!document.querySelector("[data-folia-home]")'), 'real Folia home did not mount');
  await js('window.__inputSentinel = "same-player"');
  dashboard = new BrowserWindow({ show: false, width: 1200, height: 800 });
  const view = host.views.get(player), clip = new View();
  player.contentView.removeChildView(view);
  clip.addChildView(view); dashboard.contentView.addChildView(clip);
  clip.setBounds({ x: 30, y: 80, width: 1100, height: 650 });
  view.setBounds({ x: 0, y: 0, width: 1100, height: 650 });
  const publishPresentation = mode => {
    embedded = mode === 'embedded';
    runtime.refreshPresentation();
    wc.send('harbour-folia:presentation', mode);
  };
  publishPresentation('embedded');
  await until(() => js(`!document.querySelector('[aria-label="Enable click-through"]')`), 'embedded titlebar was not removed');
  assert.equal(await js('window.electron.setMainWindowClickThroughEnabled(true)'), false);
  assert.equal(await js('window.electron.getMainWindowClickThroughEnabled()'), false);
  // This isolated preference avoids Remote's normal moveTop action; foreground
  // guards remain active instead of silently replacing native calls with no-ops.
  await js('window.electron.saveSettings("REMOTE_CONTROL_ALWAYS_ON_TOP", false)');
  const remote = runtime.openRemote(); // New shells stay hidden; no host onWindow show callback.
  const rjs = code => remote.webContents.executeJavaScript(code);
  await until(() => rjs('!!window.electron && !!document.querySelector("#root")?.children.length'), 'Remote did not mount');
  assert.equal(await rjs('window.electron.sendRemoteControlCommand({type:"set-main-window-click-through",enabled:true})'), false);
  assert.equal(await js('document.documentElement.dataset.clickThrough'), undefined);
  assert.equal(runtime.snapshot().mainWindowClickThroughAvailable, false);
  // Verify native IPC and pointer state still work in a standalone presentation,
  // without showing that test shell or changing the owner's active window.
  clip.removeChildView(view); player.contentView.addChildView(view);
  publishPresentation('window');
  await until(() => js(`!!document.querySelector('[aria-label="Enable click-through"]')`), 'standalone titlebar was not restored');
  assert.equal(await rjs('window.electron.sendRemoteControlCommand({type:"set-main-window-click-through",enabled:true})'), true);
  await until(() => js('document.documentElement.dataset.clickThrough === "active"'), 'native lock did not reach renderer');
  assert.equal(await js('window.electron.setMainWindowClickThroughEnabled(false)'), false);
  await until(() => js('!document.documentElement.dataset.clickThrough'), 'unlock did not restore document input');
  await js('window.electron.setMainWindowClickThroughEnabled(true)');
  player.contentView.removeChildView(view); clip.addChildView(view);
  publishPresentation('embedded');
  await until(() => js(`!document.documentElement.dataset.clickThrough && !document.querySelector('[aria-label="Enable click-through"]')`), 're-embedding left stale lock/chrome');
  assert.equal(await js('window.__inputSentinel'), 'same-player', 'presentation must not reload the player');
  assert.equal(runtime.snapshot().mainWindowClickThroughAvailable, false);
  assert.ok(BrowserWindow.getAllWindows().every(win => !win.isVisible()));
  clip.removeChildView(view); player.contentView.addChildView(view);
  await runtime.dispose(); host.dispose(); dashboard.destroy();
  console.log('FOLIA_CLICK_THROUGH_BACKGROUND_OK: real IPC, direct + Remote guard, standalone lock/unlock, same-renderer re-embed; no visible window or playback');
  app.exit(0);
}).catch(async error => {
  console.error(error.stack || error);
  try { await runtime?.dispose(); host?.dispose(); dashboard?.destroy(); } finally { app.exit(1); }
});
setTimeout(() => { console.error('Background input test timed out'); app.exit(1); }, 60000).unref();
