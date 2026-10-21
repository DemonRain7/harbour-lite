const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createCloseGuard } = require('../companion/close-guard');
const { FoliaController } = require('../folia/controller');
const { SCHEMES, isFoliaWindow } = require('../folia/host');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-folia-exit-')));
protocol.registerSchemesAsPrivileged(SCHEMES);
let controller, cleaned = false, failed = false;
let registeredMusicWindows = 0;
const guard = createCloseGuard({ app, ipcMain, dialog: {}, async cleanup() {
  await controller.close();
  assert.equal(controller.runtime, null);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  cleaned = true;
} });
// Use the same automatic registration as production main.js. Testing a guard
// with no registered windows would miss the hosted-view registration race.
app.on('browser-window-created', (_event, win) => {
  queueMicrotask(() => {
    if (!win.isDestroyed() && !isFoliaWindow(win)) {
      registeredMusicWindows++;
      guard.register(win);
    }
  });
});
app.on('quit', () => {
  if (failed) return;
  assert.ok(cleaned, 'actual app exit waits for asynchronous music cleanup');
  console.log('FOLIA_EXIT_OK: approved Harbour quit is not vetoed by music hide-on-close');
});
app.whenReady().then(async () => {
  controller = new FoliaController({ offline: true, isQuitting: () => guard.quitting });
  await controller.open('window');
  await controller.open('remote');
  assert.equal(registeredMusicWindows, 0, 'Folia/Remote do not implement the Harbour editor-draft protocol');
  await guard.requestQuit();
}).catch(async error => { failed = true; console.error(error); await controller?.close(); app.exit(1); });
setTimeout(() => { failed = true; console.error('Folia native quit timed out'); app.exit(1); }, 50_000).unref();
