const { app, protocol, BrowserWindow, dialog, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { FoliaController } = require('../folia/controller');
const { SCHEMES } = require('../folia/host');
// Opt-in live public search, through the real Folia renderer + Omni + QQ service.
// Background-only: no owner account, playback, window activation or provider mock.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-folia-online-'));
app.setPath('userData', fixtureDir);
// Provider dependencies may call dotenv.config(); never load the workspace .env.
process.chdir(fixtureDir);
delete process.env.FOLIA_PENDING_DESKTOP_LYRIC;
protocol.registerSchemesAsPrivileged(SCHEMES);
app.on('window-all-closed', () => {}); // Keep the fixture host alive across unload/reopen.
// Fail before a native activation/dialog can interrupt someone using the desktop.
// HostedWindow constructs with show:false; these guards do not hide a shown window
// or silently turn a foreground regression into a passing background test.
const forbid = action => () => {
  console.error(`FOLIA_QQ_BACKGROUND_VIOLATION: ${action}`);
  app.exit(1);
  throw new Error(`Background search attempted ${action}`);
};
app.on('browser-window-created', (_event, win) => {
  for (const method of ['show', 'showInactive', 'focus', 'moveTop', 'restore']) win[method] = forbid(method);
});
app.on('web-contents-created', (_event, contents) => {
  contents.focus = forbid('webContents.focus');
  contents.on('media-started-playing', forbid('media playback'));
});
for (const method of ['showMessageBox', 'showMessageBoxSync', 'showErrorBox', 'showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync']) {
  dialog[method] = forbid(`dialog.${method}`);
}
shell.openExternal = forbid('shell.openExternal');
async function assertClosed(contents) {
  // Native WebContents.close() finishes asynchronously after the shell's closed event.
  if (!contents.isDestroyed()) await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      contents.off('destroyed', done);
      reject(new Error('unload did not dispose the isolated renderer within 5 seconds'));
    }, 5000);
    const done = () => { clearTimeout(timer); resolve(); };
    contents.once('destroyed', done);
  });
  assert.equal(contents.isDestroyed(), true, 'unload must dispose the isolated renderer');
  assert.equal(BrowserWindow.getAllWindows().length, 0);
}
function assertBackground() {
  assert.ok(BrowserWindow.getAllWindows().every(win => !win.isVisible()), 'search must never show a window');
  const state = controller.status();
  assert.equal(state.mode, 'background');
  assert.equal(state.paused, true, 'search must not start playback');
  assert.equal(state.tracks.length, 0, 'search must not replace the playback queue');
}
function assertSearch(result) {
  assert.equal(result.source, 'qq');
  assert.ok(result.tracks.length > 0, 'public QQ search returned no tracks');
  assert.ok(result.tracks.every(track => typeof track.id === 'string' && track.title));
  assertBackground();
}
let controller;
app.whenReady().then(async () => {
  controller = new FoliaController();
  await controller.ensure();
  assertBackground();
  const firstContents = controller.runtime.getMainWindow().webContents;
  const result = await controller.command({ action: 'search', source: 'qq', query: '晴天 周杰伦' });
  assertSearch(result);
  console.log(JSON.stringify({ status: 'FOLIA_QQ_SEARCH_OK', count: result.tracks.length, tracks: result.tracks.slice(0, 3) }));
  await controller.close();
  await assertClosed(firstContents);
  await controller.ensure();
  const reopenedContents = controller.runtime.getMainWindow().webContents;
  assert.notEqual(reopenedContents, firstContents);
  assertBackground();
  const resumed = await controller.command({ action: 'search', source: 'qq', query: '晴天 周杰伦' });
  assertSearch(resumed);
  await controller.close();
  await assertClosed(reopenedContents);
  console.log('FOLIA_QQ_REOPEN_OK');
  app.exit(0);
}).catch(async error => {
  console.error('FOLIA_QQ_SEARCH_FAILED:', error.message);
  try { await controller?.close(); } finally { app.exit(1); }
});
setTimeout(() => { console.error('Folia online smoke timed out'); app.exit(1); }, 65_000).unref();
