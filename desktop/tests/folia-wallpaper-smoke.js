const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { FoliaController } = require('../folia/controller');
const { SCHEMES } = require('../folia/host');
if (process.platform !== 'win32') { console.log('Windows wallpaper fixture only'); app.exit(0); }
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-folia-wallpaper-')));
protocol.registerSchemesAsPrivileged(SCHEMES);
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const events = [];
// Observe the REAL helper output, do not replace native attach/detach with mocks.
const spawn = childProcess.spawn;
childProcess.spawn = function(command, args, options) {
  const child = spawn.call(this, command, args, options);
  if (String(command).endsWith('folia-wallpaper-helper.exe') && args[0] === 'attach') {
    let pending = '';
    child.stdout?.on('data', chunk => {
      pending += chunk.toString();
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        try { events.push(JSON.parse(line)); } catch { /* non-JSON diagnostics are not evidence */ }
      }
    });
  }
  return child;
};
const waitFor = async (get, check, label) => {
  for (let i = 0; i < 180; i++) { const value = await get(); if (check(value)) return value; await pause(100); }
  throw new Error('Timed out: ' + label + ' ' + JSON.stringify(events));
};
let controller, dashboard;
app.whenReady().then(async () => {
  controller = new FoliaController({ offline: true });
  dashboard = new BrowserWindow({ show: false, width: 1100, height: 740 });
  await dashboard.loadURL('data:text/html,<h1>Harbour host must remain a normal window</h1>');
  const originalBounds = dashboard.getBounds();
  await controller.open('embedded', dashboard, { x: 0, y: 40, width: 1100, height: 700 });
  const js = code => controller.runtime.getMainWindow().webContents.executeJavaScript(code, true);
  await js(`window.electron.saveSettings('wallpaper_forward_mouse',false)`);
  await js(`window.electron.saveSettings('wallpaper_mode',true)`);
  const attached = await waitFor(async () => events.find(e => e.event === 'attached'), Boolean, 'native WorkerW attach');
  assert.equal(controller.dock, null, 'only the music renderer leaves the dashboard');
  assert.deepEqual(dashboard.getBounds(), originalBounds);
  assert.equal(dashboard.isDestroyed(), false);
  await waitFor(() => js(`!!window.electron`), Boolean, 'new music window ready');
  await js(`window.electron.saveSettings('wallpaper_mode',false)`);
  await waitFor(async () => events.find(e => e.event === 'detached'), Boolean, 'native detach');
  await pause(800);
  const settings = await js('window.electron.getSettings()');
  assert.equal(settings.wallpaper_mode, false);
  assert.equal(dashboard.isDestroyed(), false);
  await controller.close(); dashboard.destroy();
  childProcess.spawn = spawn;
  console.log(JSON.stringify({ status:'FOLIA_WALLPAPER_OK', mode:attached.mode, events:events.map(e=>e.event) }));
  app.exit(0);
}).catch(async error => {
  console.error(error);
  try { await controller?.close(); } catch { /* preserve original error */ }
  if (dashboard && !dashboard.isDestroyed()) dashboard.destroy();
  childProcess.spawn = spawn;
  app.exit(1);
});
setTimeout(async () => { await controller?.close(); app.exit(2); }, 45_000).unref();
