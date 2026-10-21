const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FoliaDeviceMenu } = require('../folia/device-menu');

// Only isolated hidden test surfaces: no Folia runtime, audio, visible windows,
// screenshots, native mouse injection, production data, network or server.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-device-menu-test-')));
app.commandLine.appendSwitch('mute-audio');
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async predicate => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await pause(20); } throw new Error('Timed out waiting for native menu'); };
const data = () => ({ items: [{ value: 'local', label: '用户 的本机', description: '本机 · 在线', selected: true }], anchor: { x: 390, y: 75, width: 150, height: 30 },
  theme: { panel: '#fcfbff', fg: '#262330', dim: '#746c84', border: '#d9d2e6', accent: '#906aba', fontFamily: '"Segoe UI", sans-serif' } });

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
  const player = new WebContentsView({ webPreferences: { backgroundThrottling: false, partition: 'device-menu-test-player' } });
  const menu = new FoliaDeviceMenu();
  const guard = contents => {
    contents.setAudioMuted(true);
    contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    contents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data):/.test(details.url) }));
  };
  guard(win.webContents); guard(player.webContents);
  win.on('show', () => { throw new Error('Test must never show a native window'); });
  try {
    await win.loadURL('data:text/html,<body>Hidden Dashboard placeholder</body>');
    win.contentView.addChildView(player); player.setBounds({ x: 20, y: 100, width: 940, height: 500 });
    await player.webContents.loadURL('data:text/html,<body>Hidden player placeholder</body>');
    await player.webContents.executeJavaScript('window.resizeCount=0;addEventListener("resize",()=>resizeCount++)');
    const baseline = player.getBounds(), id = player.webContents.id;
    const viewport = await player.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');
    const open = async request => {
      const result = menu.open(win, request, { playerContents: player.webContents });
      const wc = menu.webContents; guard(wc);
      await waitFor(async () => !wc.isDestroyed() && await wc.executeJavaScript('!!document.querySelector("#options button")').catch(() => false));
      await pause(80);
      assert.equal(win.isVisible(), false); assert.equal(win.contentView.children.at(-1), menu.view);
      assert.deepEqual(player.getBounds(), baseline); assert.equal(player.getVisible(), true); assert.equal(player.webContents.id, id);
      return { result, wc };
    };
    let current = await open(data());
    const focusDiagnostic = async label => {
      if (!process.argv.includes('--focus-diagnostics')) return;
      console.log('FOLIA_DEVICE_MENU_FOCUS', JSON.stringify({ label, window: win.isFocused(), dashboard: win.webContents.isFocused(),
        dashboardDocument: await win.webContents.executeJavaScript('document.hasFocus()'), player: player.webContents.isFocused(), menu: menu.webContents?.isFocused() ?? null }));
    };
    await focusDiagnostic('menu-open');
    const one = await current.wc.executeJavaScript('({height:innerHeight,scroll:document.querySelector("#options").scrollHeight-document.querySelector("#options").clientHeight,selected:document.activeElement.dataset.value,bg:getComputedStyle(document.querySelector("#menu")).backgroundColor})');
    assert.ok(one.height < 145, JSON.stringify(one)); assert.equal(one.scroll, 0); assert.equal(one.selected, 'local'); assert.equal(one.bg, 'rgb(252, 251, 255)');
    await current.wc.executeJavaScript('document.activeElement.click()'); assert.deepEqual(await current.result, { value: 'local' });
    await waitFor(() => current.wc.isDestroyed()); assert.equal(menu.webContents, null);
    await win.webContents.executeJavaScript('const trigger=document.createElement("button"); trigger.textContent="Device";document.body.append(trigger);trigger.focus()');
    await focusDiagnostic('selected-dom-trigger-focused');

    const many = data(); many.items.push(...Array.from({ length: 12 }, (_, i) => ({ value: `remote-${i}`, label: `远端 ${i} LongDeviceNameWithoutSpaces01234567890123456789`, description: '远端设备 · 在线', disabled: i === 10 })));
    current = await open(many);
    assert.ok(await current.wc.executeJavaScript('document.querySelector("#options").scrollHeight>document.querySelector("#options").clientHeight'));
    await current.wc.executeJavaScript('dispatchEvent(new KeyboardEvent("keydown",{key:"End"}))');
    assert.equal(await current.wc.executeJavaScript('document.activeElement.dataset.value'), 'remote-11');
    await current.wc.executeJavaScript('dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp"}))');
    assert.equal(await current.wc.executeJavaScript('document.activeElement.dataset.value'), 'remote-9');
    await current.wc.executeJavaScript('dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}))');
    assert.deepEqual(await current.result, { dismiss: 'escape' });

    for (const zoom of [0.9, 1.25, 1.5]) {
      win.webContents.setZoomFactor(zoom); current = await open(data());
      assert.equal(menu.view.getBounds().width, Math.round(272 * zoom)); assert.equal(current.wc.getZoomFactor(), zoom);
      await current.wc.executeJavaScript('dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",shiftKey:true}))');
      assert.deepEqual(await current.result, { dismiss: 'shift-tab' });
    }
    current = await open(data());
    // Exercise native event wiring without moving/clicking the user's mouse.
    let prevented = false;
    player.webContents.emit('before-mouse-event', { preventDefault() { prevented = true; } }, { type: 'mouseDown' });
    assert.equal(await current.result, null); assert.equal(prevented, false);
    assert.deepEqual(await player.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})'), viewport);
    assert.equal(await player.webContents.executeJavaScript('resizeCount'), 0);
    assert.deepEqual(player.getBounds(), baseline); assert.deepEqual(win.contentView.children.filter(view => view === player), [player]);
    assert.equal(ipcMain.listenerCount('folia-device-menu:event'), 0);
    console.log('FOLIA_DEVICE_MENU_NATIVE_OK: hidden isolated native stacking, compact dimensions, keyboard, four zooms, IPC lifecycle, unchanged player');
  } finally { menu.close(); player.webContents.close(); win.destroy(); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
