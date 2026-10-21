const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { FoliaController } = require('../folia/controller');
const { SCHEMES } = require('../folia/host');

// Real renderer/IPC regression, isolated from the owner's library and settings.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-folia-transparency-')));
protocol.registerSchemesAsPrivileged(SCHEMES);
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const dashboard = new BrowserWindow({ show: false, width: 1200, height: 800 });
  const folia = new FoliaController({ offline: true });
  await folia.open('embedded', dashboard, { x: 240, y: 100, width: 920, height: 650 });
  const original = folia.runtime.getMainWindow().webContents;
  const originalBounds = folia.dock.bounds;
  const initialStoredBounds = folia.runtime.getMainWindow().getContentBounds();
  const rendererListeners = original.listenerCount('render-process-gone');
  const js = code => folia.runtime.getMainWindow().webContents.executeJavaScript(code, true);
  const waitForZoom = async zoom => {
    let geometry;
    for (let i = 0; i < 100; i++) {
      geometry = { viewport: await js('({width:innerWidth,height:innerHeight})'),
        native: folia.host.views.get(folia.runtime.getMainWindow()).getBounds() };
      if (['width', 'height'].every(key => Math.abs(geometry.viewport[key] * zoom - geometry.native[key]) <= 2)) return;
      await delay(25);
    }
    assert.fail(`Renderer zoom did not settle: ${JSON.stringify({ zoom, geometry })}`);
  };
  await js('window.transparencySentinel = "same-player"');
  for (const enabled of [true, false, true]) {
    assert.equal(await js(`window.electron.setWindowTransparentMode(${enabled})`), true);
    await delay(100);
    assert.equal(folia.mode, 'embedded', 'a visual setting must not undock the player');
    assert.equal(folia.runtime.getMainWindow().webContents, original, 'embedded toggles must not reload audio/UI');
    assert.equal(await js('window.transparencySentinel'), 'same-player');
    assert.equal(await js('window.electron.getWindowTransparentMode()'), enabled);
    assert.equal(folia.runtime.getMainWindow().isVisible(), false);
    assert.equal(await js('localStorage.getItem("transparent_player_background")'), String(enabled));
    assert.deepEqual(folia.dock.bounds, originalBounds);
    assert.equal(folia.host.windows.size, 1, 'replacement shells must not leak windows');
  }
  console.log('FOLIA_EMBEDDED_TRANSPARENCY_OK');
  await folia.open('window');
  // macOS may constrain an oversized hidden window to the CI display on its
  // first show. Compare subsequent transparency swaps to that visible geometry.
  await delay(150);
  // Windows retains the original requested rectangle across fractional-frame
  // rounding; macOS instead constrains the first visible frame to the display.
  const initialNativeBounds = process.platform === 'darwin'
    ? folia.runtime.getMainWindow().getContentBounds() : initialStoredBounds;
  for (const zoom of [.8, 1, 1.25]) {
    original.setZoomFactor(zoom);
    // getZoomFactor changes before Chromium applies its visual/input transform.
    // Test a settled zoom, not a zoom notification racing native-shell adoption.
    await waitForZoom(zoom);
    for (const enabled of [false, true]) {
      assert.equal(await js(`window.electron.setWindowTransparentMode(${enabled})`), true);
      await delay(150);
      await waitForZoom(zoom);
      const win = folia.runtime.getMainWindow();
      assert.equal(folia.mode, 'window');
      assert.equal(win.isVisible(), true);
      assert.equal(win.webContents, original);
      assert.equal(original.getZoomFactor(), zoom);
      const actualBounds = win.getContentBounds();
      for (const key of ['x','y','width','height']) assert.ok(Math.abs(actualBounds[key]-initialNativeBounds[key])<=1,
        `no cumulative native rounding: ${JSON.stringify({actualBounds,initialNativeBounds})}`);
      assert.equal(original.listenerCount('render-process-gone'), rendererListeners, 'no listeners leak across shell swaps');
      assert.equal(folia.host.windows.size, 1);
      await js(`(() => {
        document.querySelector('#hitProbe')?.remove();
        const probe = document.createElement('button'); probe.id = 'hitProbe';
        probe.style.cssText = 'position:fixed;left:20px;top:80px;width:100px;height:60px;z-index:2147483647;pointer-events:auto;app-region:no-drag';
        probe.textContent = 'Hit target'; probe.onclick = e => window.hitResult = { x:e.clientX, y:e.clientY };
        document.body.append(probe); window.hitResult = null;
      })()`);
      original.focus();
      const hit = { x: Math.round(70*zoom), y: Math.round(110*zoom), button: 'left', clickCount: 1 };
      original.sendInputEvent({ type: 'mouseDown', ...hit });
      original.sendInputEvent({ type: 'mouseUp', ...hit });
      await delay(50);
      const result = await js('window.hitResult');
      assert.ok(result && Math.abs(result.x-70)<=1 && Math.abs(result.y-110)<=1, JSON.stringify({zoom,enabled,result, viewport: await js('({width:innerWidth,ratio:devicePixelRatio})'), native: folia.host.views.get(win).getBounds()}));
      const beforeRepeat = folia.runtime.getMainWindow();
      await js(`window.electron.setWindowTransparentMode(${enabled})`);
      assert.equal(folia.runtime.getMainWindow(), beforeRepeat, 'same-value updates are idempotent');
    }
  }
  await folia.open('embedded', dashboard, originalBounds);
  await js('Promise.all([false,true,false,true].map(value => window.electron.setWindowTransparentMode(value)))');
  await delay(150);
  assert.equal(folia.mode, 'embedded');
  assert.equal(folia.host.windows.size, 1, 'rapid updates retire superseded shells');
  assert.equal(await js('localStorage.getItem("transparent_player_background")'), 'true');
  assert.equal(folia.runtime.getMainWindow().webContents, original);
  assert.deepEqual(folia.dock.bounds, originalBounds);
  await folia.open('remote');
  const remote = [...folia.host.windows].find(win => win !== folia.runtime.getMainWindow());
  assert.ok(remote?.isVisible());
  for (const enabled of [false, true]) {
    await remote.webContents.executeJavaScript(`window.electron.sendRemoteControlCommand({type:'set-transparent-mode-enabled',enabled:${enabled}})`);
    await delay(150);
    assert.equal(folia.mode, 'embedded', 'Remote transparency must not undock the player');
    assert.equal(folia.runtime.getMainWindow().webContents, original);
    assert.equal(await js('localStorage.getItem("transparent_player_background")'), String(enabled));
    assert.equal(folia.host.windows.size, 2, 'one main shell and one Remote');
  }
  remote.close();
  await delay(100);
  const beforeFailure = folia.runtime.getMainWindow();
  assert.throws(() => folia.host.recreateWindowWithView(beforeFailure, () => {
    new folia.host.electron.BrowserWindow({ show: false, width: 600, height: 400 });
    throw new Error('Injected shell construction failure');
  }), /Injected shell construction failure/);
  assert.equal(folia.host.windows.size, 1, 'failed native shells are cleaned up');
  assert.equal(folia.runtime.getMainWindow(), beforeFailure);
  assert.equal(folia.runtime.getMainWindow().webContents, original);
  assert.equal(await js('window.transparencySentinel'), 'same-player');
  assert.deepEqual(folia.dock.bounds, originalBounds);
  console.log('FOLIA_TRANSPARENCY_REMOTE_ROLLBACK_OK');
  console.log('FOLIA_TRANSPARENCY_GEOMETRY_OK: transparent/opaque × 3 zooms, one live renderer');
  await folia.close(); dashboard.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
setTimeout(() => { console.error('Transparency smoke timeout'); app.exit(1); }, 60_000).unref();
