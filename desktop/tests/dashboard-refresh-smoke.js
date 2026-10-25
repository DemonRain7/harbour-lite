// Real Dashboard keyboard -> production main handler -> preload -> leave guard.
// Hidden isolated windows and HTTP/WS fixtures only; no user tasks or services.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { startFixture, waitFor, evaluate, click } = require('./session-browsing-smoke');
const { createCloseGuard } = require('../companion/close-guard');
const root = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(root, 'desktop/main.js'), 'utf8');
const source = name => main.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^}`, 'm'))[0];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let fixture, win;
const safety = setTimeout(() => { console.error('refresh smoke timeout'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  fixture = await startFixture({ cat: 'anime', nativePreload: true, parallel: true });
  for (const channel of ['desktop:visual-policy', 'desktop:orb-status', 'desktop:cowork-device', 'desktop:music-provider-get', 'desktop:folia-status', 'desktop:companion-state', 'desktop:companion-set-appearance'])
    ipcMain.handle(channel, () => null);
  const guard = createCloseGuard({ app, ipcMain, timeoutMs: 1200, cleanup() {}, showWindow() {},
    dialog: { async showMessageBox(_win, options) { throw new Error('unexpected fallback: ' + options.message); } } });
  class HiddenWindow extends BrowserWindow {
    constructor(options) { super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } }); }
    show() {} focus() {}
  }
  const ctx = vm.createContext({ BrowserWindow: HiddenWindow, startupSplash: null, mainWindow: null, remoteBridge: null,
    cfg: { url: fixture.base + '/#chat?session=A&agent=main-elaina', token: '', petEnabled: false },
    initCompanionRuntime() {}, startRemoteCompanionBridge() {}, removeWindowMenu() {},
    closeGuard: guard, conversationLink: { loading() {}, flush() {} }, openDashboardLink: () => ({ action: 'deny' }),
    town: null, path, __dirname: path.join(root, 'desktop'), APP_ICON_PATH: '', PET_CATALOG: {},
    URL, console, clearTimeout, setTimeout, dashboardRetryTimer: null,
    loadDashboard: target => target.loadURL(ctx.cfg.url),
  });
  vm.runInContext([source('refreshDashboard'), source('createDashboardWindow')].join('\n'), ctx);
  win = await ctx.createDashboardWindow();
  let loads = 0, keys = 0;
  win.webContents.on('did-finish-load', () => loads++);
  win.webContents.on('before-input-event', () => keys++);
  const ready = () => waitFor(win, 'state.chat.sessionId==="A" && !routePending', 'real Dashboard ready');
  await ready();
  const press = (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  for (const [key, modifiers] of [['F5', []], ['R', ['control']], ['F5', []]]) {
    const before = loads; press(key, modifiers);
    for (let i = 0; loads === before && i < 200; i++) await pause(20);
    assert.equal(loads, before + 1, `real ${key} reloads exactly once (keys=${keys})`);
    await ready();
    assert.equal(await evaluate(win, 'document.body.inert'), false);
  }
  // A user/system-cancelled navigation must not leave the guard permanently busy.
  // Hold only the fixture's next main document, then stop its real Chromium load.
  let releaseNavigation;
  const navigationEvents = [];
  const recordFailure = (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame) navigationEvents.push(`fail:${code}`);
  };
  const recordStop = () => navigationEvents.push('stop');
  win.webContents.on('did-fail-load', recordFailure);
  win.webContents.on('did-stop-loading', recordStop);
  win.webContents.session.webRequest.onBeforeRequest({ urls: [fixture.base + '/*'] }, (details, callback) => {
    if (details.resourceType === 'mainFrame') releaseNavigation = callback;
    else callback({});
  });
  press('F5');
  for (let i = 0; !releaseNavigation && i < 200; i++) await pause(20);
  assert.ok(releaseNavigation, 'next navigation reaches the fixture request');
  win.webContents.stop();
  releaseNavigation({});
  win.webContents.session.webRequest.onBeforeRequest(null);
  await pause(100);
  assert.ok(navigationEvents.includes('stop'), `cancelled load really stopped: ${navigationEvents}`);
  const beforeRetry = loads;
  press('F5');
  for (let i = 0; loads === beforeRetry && i < 200; i++) await pause(20);
  assert.equal(loads, beforeRetry + 1, `F5 works after interrupted reload: ${navigationEvents}`);
  await ready();
  win.webContents.removeListener('did-fail-load', recordFailure);
  win.webContents.removeListener('did-stop-loading', recordStop);
  assert.equal(await guard.run(win, 'reload', () => false), false, 'interrupted operation is not reported as success');
  await click(win, '#chatInput'); // Real activation is required for Chromium's native beforeunload veto.
  await evaluate(win, `window.__dirty=true; window.HarbourUnsavedChanges.register('refresh-fixture', {
    label:'刷新草稿',isActive:()=>true,isDirty:()=>window.__dirty,version:()=>1,discard:()=>{window.__dirty=false;}}); true`);
  const beforeCancel = loads;
  // A failed operation revoked its native unload permission; even a direct reload
  // still asks instead of silently dropping a draft created just after the failure.
  win.webContents.reload();
  await waitFor(win, '!!document.querySelector(".harbour-dialog-cancel")', 'refresh approval visible');
  await click(win, '.harbour-dialog-cancel'); await pause(100);
  assert.equal(loads, beforeCancel, 'cancel retains page');
  assert.equal(await evaluate(win, 'window.__dirty'), true, 'cancel keeps the draft');
  press('F5');
  await waitFor(win, '!!document.querySelector(".harbour-dialog-discard")', 'second refresh approval visible');
  await click(win, '.harbour-dialog-discard');
  for (let i = 0; loads === beforeCancel && i < 200; i++) await pause(20);
  assert.equal(loads, beforeCancel + 1); await ready();
  console.log('PASS actual F5/Ctrl+R -> main -> preload -> leave guard -> reload; interrupted reload recovery, repeated reload and dirty cancel/discard');
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  clearTimeout(safety); if (win && !win.isDestroyed()) win.destroy(); await fixture?.close(); app.exit(process.exitCode || 0);
});
