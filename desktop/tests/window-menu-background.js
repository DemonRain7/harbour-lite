const { app, BrowserWindow, Menu } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { removeWindowMenu } = require('../companion/window-menu');

// Separate hidden Electron process/profile; no foreground, backend or real UI.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-menu-test-')));
app.on('window-all-closed', () => {});
let win;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  if (process.platform === 'darwin') { console.log('macOS application menu intentionally retained; see policy unit test'); app.exit(0); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'File', submenu: [{ role: 'reload' }] }, { role: 'editMenu' }]));
  win = new BrowserWindow({ show: false, autoHideMenuBar: true, width: 900, height: 600 });
  removeWindowMenu(win);
  await win.loadURL('data:text/html,<input id="field"><script>window.keys=[];onkeydown=e=>keys.push(e.key)</script>');
  const original = win.getContentSize();
  for (let i = 0; i < 3; i++) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Alt' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Alt' });
  }
  await wait(100);
  assert.equal(win.isMenuBarVisible(), false);
  assert.deepEqual(win.getContentSize(), original, 'Alt does not shrink renderer bounds');
  assert.ok((await win.webContents.executeJavaScript('keys')).includes('Alt'), 'Alt still reaches renderer controls');
  await win.webContents.executeJavaScript('field.focus();field.value="hello";field.setSelectionRange(0,0)');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
  await wait(100);
  assert.deepEqual(await win.webContents.executeJavaScript('[field.selectionStart,field.selectionEnd]'), [0, 5], 'standard text editing still works');
  assert.equal(win.isVisible(), false);
  console.log('WINDOW_MENU_BACKGROUND_OK: no Alt menu, stable bounds, renderer Alt and Ctrl+A intact; no visible window');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); if (win && !win.isDestroyed()) win.destroy(); app.exit(1); });
setTimeout(() => app.exit(1), 20000).unref();
