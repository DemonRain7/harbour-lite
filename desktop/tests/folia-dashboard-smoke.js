const { app, BrowserWindow, protocol, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { WebSocketServer } = require('ws');
const { FoliaController, scaledFoliaBounds } = require('../folia/controller');
const { SCHEMES } = require('../folia/host');
const createFixtureProbe = require('./folia-fixture-probe');
// Real dashboard, preload and Folia view. Backend list responses are fixtures; no owner data.
const root = path.resolve(__dirname, '../..'), web = path.join(root, 'web');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-folia-dashboard-')));
protocol.registerSchemesAsPrivileged(SCHEMES);
app.on('window-all-closed', () => {});
app.commandLine.appendSwitch('force-device-scale-factor', '1');
// Hidden BrowserWindows suppress CSS animation frames even with throttling off.
// Render this isolated fixture off-screen; never focus or resize the owner's app.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const onRunner = process.env.GITHUB_ACTIONS === 'true';
let folia;
// The 7×4 matrix runs real two-way animations plus native frame captures. Mac
// runners take ~90s before final remount checks; individual JS calls stay bounded.
const probe = createFixtureProbe('folia-dashboard', () => folia, process.argv.includes('--themes') ? 150_000 : 90_000);
const themes = [
  ['premium','neutral','premium-champagne'], ['premium','neutral','premium-tungsten'],
  ['anime','elaina','anime-wisteria'], ['anime','elaina','anime-sky'],
  ['anime','aemeath','anime-snowfleece'], ['anime','aemeath','anime-stardust'], ['anime','aemeath','anime-neon'],
];
app.whenReady().then(async () => {
  require('./folia-fixture-locale').prepare();
  folia = new FoliaController({ offline: true });
  probe.progress('dashboard startup');
  let deviceList = [{ id: 'music-test', label: 'Desktop device' }];
  let statusOverride, commandOverride;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      const agent = { name: 'main-elaina', taskType: 'main', description: 'fixture', tools: [], skills: [] };
      const data = url.pathname === '/api/state' ? { agents: [agent], backends: {}, uptimeMs: 6000, defaultAgent: agent.name }
        : url.pathname === '/api/music/devices' ? { devices: deviceList.map(device => ({ ...device, music: device.music || statusOverride || folia.status() })) }
        : url.pathname === '/api/agents' ? { agents: [agent] } : {};
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); return;
    }
    const file = path.resolve(web, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(web + path.sep)) { res.writeHead(403);res.end();return; }
    try { res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream' }); res.end(fs.readFileSync(file)); }
    catch {res.writeHead(404);res.end();}
  });
  const ws = new WebSocketServer({ server, path: '/ws' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  // A dedicated CI desktop must present the view on-screen: macOS suppresses
  // compositor animation frames for off-screen windows. Local fixtures stay away
  // from the owner's app. The OS may still clamp height to its actual work area.
  const win = new BrowserWindow({ width: 1400, height: 940, x: onRunner ? 0 : -10000, y: onRunner ? 0 : -10000, show: false, webPreferences: {
    // Exercise foreground layout delivery without flashing a test window over
    // the owner's music. Hidden Chromium otherwise defers ResizeObserver.
    backgroundThrottling: false,
    preload: path.join(root, 'desktop/preload.js'), additionalArguments: ['--harbour-cowork-device=music-test', '--harbour-pet-enabled=0'],
  } });
  const commands = [], nativeFrames = [], presentations = [];
  const scaledBounds = bounds => scaledFoliaBounds(win, bounds);
  ipcMain.handle('desktop:folia-status', () => statusOverride || folia.status());
  ipcMain.handle('desktop:folia-open', (_e, mode, bounds) => { presentations.push(mode); return folia.open(mode, win, scaledBounds(bounds)); });
  ipcMain.handle('desktop:folia-hide', () => { presentations.push('hide'); folia.hide(win); return true; });
  ipcMain.handle('desktop:folia-device-menu', (_e, request) => folia.showDeviceMenu(win, request));
  ipcMain.on('desktop:folia-device-menu-close', () => folia.closeDeviceMenu(win));
  ipcMain.handle('desktop:folia-command', (_e, command) => { commands.push(command); return commandOverride ? commandOverride(command) : folia.command(command); });
  ipcMain.on('desktop:folia-resize', (_e, bounds, visible) => {
    folia.resize(win, scaledBounds(bounds), visible);
    if (folia.dock?.window === win) nativeFrames.push({ view: folia.dock.view.getBounds(), clip: folia.dock.clip.getBounds(), visible });
  });
  ipcMain.handle('desktop:companion-state', () => ({}));
  ipcMain.handle('desktop:companion-set-appearance', () => ({}));
  const js = code => probe.js(win.webContents, code);
  const waitFor = async expression => { for (let i = 0; i < 150; i++) { if (await js(expression)) return; await pause(50); } throw new Error('Timeout ' + expression); };
  await win.loadURL(url + '/#music');
  if (onRunner) win.show(); else win.showInactive();
  await waitFor('!!document.querySelector("#musicStage")');
  if (process.argv.includes('--shuffle-ui')) {
    await require('./music-shuffle-ui-checks')({ win, js, waitFor, pause, themes, root, commands,
      setStatus: value => { statusOverride = value; },
      setCommand: value => { commandOverride = value; },
      setDevices: value => { deviceList = value; } });
    win.destroy(); ws.close(); server.close(); app.exit(0); return;
  }
  if (process.argv.includes('--device-menu')) {
    await require('./music-device-select-checks')({ win, js, waitFor, pause, themes, root, setDevices: value => { deviceList = value; } });
  }
  if (process.argv.includes('--themes')) {
    probe.progress('theme and viewport layout');
    for (const [category, persona, theme] of themes) {
      await js(`applyTheme(${JSON.stringify(category)},${JSON.stringify(persona)},${JSON.stringify(theme)})`);
      await waitFor('!!document.querySelector("#musicStage")');
      for (const width of [520, 860, 1400, 1920]) {
        win.setSize(width, 940);
        // A cold page is still in its 420ms entrance animation. Measure the
        // settled layout, not a transient translated footer after a fixed sleep.
        await waitFor(`!document.querySelector('.music-workspace').getAnimations().some(a=>a.playState==='running') &&
          document.querySelector('.music-workspace').getBoundingClientRect().right <= innerWidth+1 &&
          document.querySelector('.music-footer').getBoundingClientRect().bottom <= innerHeight+1`);
        const sizes = await js(`(() => { const r=s=>document.querySelector(s).getBoundingClientRect(); return { width:innerWidth, height:innerHeight, right:r('.music-workspace').right, footer:r('.music-footer').bottom, stage:r('#musicStage').height, controls:r('.music-tools').right }; })()`);
        assert.ok(sizes.right <= sizes.width + 1 && sizes.controls <= sizes.width + 1 && sizes.footer <= sizes.height + 1 && sizes.stage > sizes.height * .65, JSON.stringify({theme,width,sizes}));
      }
    }
    win.setSize(1400,940);
    console.log('FOLIA_LAYOUT_OK: seven themes × four widths');
  }
  if (process.argv.includes('--compact-height')) {
    win.setContentSize(1400, 656); await pause(200);
    // Account for platform/DPI window-frame adjustments using the measured DOM
    // viewport, so this regression really exercises the small CI-height case.
    for (let i = 0; i < 3 && await js('innerHeight > 656'); i++) {
      const excess = await js('innerHeight - 656');
      const [width, height] = win.getSize();
      win.setSize(width, height - excess); await pause(200);
    }
    assert.ok(await js('innerHeight <= 656'), 'compact-height fixture must have a genuinely short viewport');
  }
  probe.progress('embedded player startup');
  await js(`applyTheme('anime','elaina','anime-wisteria')`);
  await waitFor('!!document.querySelector("#musicStage")');
  await js(`document.querySelector('[data-music="embedded"]').click()`);
  for (let i=0;i<150&&!folia.dock;i++) await pause(50);
  assert.ok(folia.dock, await js('document.body.innerText'));
  const playerId = folia.runtime.getMainWindow().webContents.id;
  await pause(600);
  const player = folia.runtime.getMainWindow().webContents;
  await require('./folia-fixture-locale')(player);
  for (let i = 0; i < 100 && await player.executeJavaScript('!!document.querySelector("#app-splash")'); i++) await pause(50);
  assert.equal(await player.executeJavaScript('!!document.querySelector("#app-splash")'), false, 'capture only the ready application, not its splash');
  await player.executeJavaScript('document.fonts.ready.then(() => true)');
  await player.executeJavaScript(`[...document.querySelectorAll('button')].find(b => b.innerText.trim() === '我知道了')?.click()`);
  await pause(400);
  assert.ok(folia.dock.view.getBounds().width > 900);
  if (process.argv.includes('--host-runtime')) {
    await require('./folia-host-runtime-checks')({ js, pause, folia, nativeFrames });
  }
  if (process.argv.includes('--source-menu')) {
    await require('./music-source-select-checks')({ win, js, waitFor, pause, themes, root, folia, commands });
  }
  if (process.argv.includes('--device-menu')) {
    const stageBefore = { ...folia.dock.bounds }, viewBefore = folia.dock.view.getBounds(), clipBefore = folia.dock.clip.getBounds();
    const deviceCommands = commands.length;
    await js(`document.querySelector('[data-hs-for="musicDevice"] .hs-trigger').click()`);
    await win.webContents.capturePage(); await pause(250);
    assert.equal(folia.dock.view.getVisible(), true, 'device menu must not blank the native player');
    for (let i = 0; i < 50 && !win.contentView.children.includes(folia.deviceMenu?.view); i++) await pause(100);
    const menu = folia.deviceMenu;
    assert.ok(menu?.webContents && win.contentView.children.includes(menu.view), 'native popup must attach above Folia');
    assert.equal(win.contentView.children.at(-1), menu.view);
    assert.deepEqual(folia.dock.bounds, stageBefore, 'opening the menu must not move or shrink Folia');
    assert.deepEqual(folia.dock.view.getBounds(), viewBefore);
    assert.deepEqual(folia.dock.clip.getBounds(), clipBefore);
    await pause(2800);
    assert.equal(folia.dock.view.getVisible(), true, 'polling must preserve the live player under the menu');
    fs.writeFileSync(path.join(root, 'assets/reports/folia/device-menu/native-menu.png'), (await menu.webContents.capturePage()).toPNG());
    await menu.webContents.executeJavaScript(`document.querySelector('#options [aria-selected="true"]').click()`);
    await win.webContents.capturePage(); await pause(250);
    assert.equal(folia.dock.view.getVisible(), true);
    assert.deepEqual(folia.dock.bounds, stageBefore, 'closing the menu keeps the same full player area');
    assert.equal(folia.runtime.getMainWindow().webContents.id, playerId, 'opening/selecting the current device must not recreate the player');
    assert.equal(commands.length, deviceCommands, 'opening/selecting the current device must not send playback commands');
  }
  const report = path.join(root, 'assets/reports/folia'); fs.mkdirSync(report, { recursive: true });
  // Separate surfaces: webContents capture does NOT include a native child view.
  const capture = async contents => {
    // Cold hidden surfaces can have no Viz frame yet. One capture wakes them;
    // the final capture must succeed (do not mask real or repeated failures).
    try { await contents.capturePage(); } catch (error) {
      if (error.message !== 'UnknownVizError') throw error;
    }
    await pause(300);
    return contents.capturePage();
  };
  fs.writeFileSync(path.join(report, 'dashboard-anime-frame.png'), (await capture(win.webContents)).toPNG());
  fs.writeFileSync(path.join(report, 'folia-player.png'), (await capture(player)).toPNG());
  const layout = await js(`(() => {
    const rect = s => { const r = document.querySelector(s).getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right }; };
    return {header:rect('.music-header'), stage:rect('#musicStage'), footer:rect('.music-footer'), device:rect('.music-device-label'), modes:rect('.music-view-switch'), remote:rect('.music-remote-button'), content:rect('#content'), viewport:{width:innerWidth,height:innerHeight}};
  })()`);
  assert.ok(layout.header.height <= 44, JSON.stringify(layout));
  // Check the entire available area, not 80% of an assumed 940px window. A Mac
  // runner may provide only 656px after native title/menu/work-area constraints.
  const topGap = layout.stage.y - layout.header.bottom;
  const bottomGap = layout.footer.y - layout.stage.bottom;
  const bottomInset = layout.content.bottom - layout.footer.bottom;
  assert.ok(topGap >= 0 && topGap <= 12 && bottomGap >= 0 && bottomGap <= 12 &&
    layout.footer.height <= 54 && bottomInset >= 0 && bottomInset <= 12 &&
    layout.stage.height > 0, 'Folia fills the space between compact controls: ' + JSON.stringify(layout));
  console.log('FOLIA_AVAILABLE_LAYOUT_OK', JSON.stringify(layout));
  assert.ok(Math.abs(layout.device.y - layout.modes.y) <= 1 && Math.abs(layout.remote.y - layout.modes.y) <= 1, 'device and window controls align');
  await js(`document.querySelector('#musicControlToggle').click()`);
  await pause(250);
  const searchLayout = await js(`(() => {
    const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,height:r.height,right:r.right,bottom:r.bottom}};
    const pane=document.querySelector('#musicRemote'), style=getComputedStyle(pane);
    return {stage:rect('#musicStage'),pane:rect('#musicRemote'),results:rect('#musicResults'),heading:rect('.music-results-heading'),inset:parseFloat(style.paddingBottom)+parseFloat(style.borderBottomWidth)};
  })()`);
  const { stage, pane, results, heading, inset } = searchLayout;
  assert.ok(pane.x >= stage.right && Math.abs(pane.height - stage.height) <= 1 &&
    Math.abs(pane.y - stage.y) <= 1 && results.height > 0 && results.y >= heading.bottom &&
    results.y - heading.bottom <= 8 && Math.abs(results.bottom - (pane.bottom - inset)) <= 1,
  'search fills the available side pane, never a squeezed bottom row: ' + JSON.stringify(searchLayout));
  fs.writeFileSync(path.join(report, 'dashboard-search-frame.png'), (await capture(win.webContents)).toPNG());
  await js(`document.querySelector('#musicControlClose').click()`); await pause(100);
  if (process.argv.includes('--panels')) {
    probe.progress('Folia settings and Theme Park');
    // Cold launch now deliberately shows Ctrl+B. Navigate the real back button
    // before checking home-page settings; never change the production default.
    const waitForPlayer = async (expression, label) => {
      for (let i = 0; i < 150; i++) {
        if (await player.executeJavaScript(expression)) return;
        await pause(50);
      }
      throw new Error('Folia settings fixture timed out: ' + label);
    };
    await waitForPlayer('!document.querySelector(".lattice-root") && !!document.querySelector(\'button[title="选项"]\')', 'home options button');
    await player.executeJavaScript(`document.querySelector('button[title="选项"]').click()`);
    await pause(700);
    await player.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='选项').click()`);
    await pause(500);
    assert.ok((await player.executeJavaScript('document.body.innerText')).includes('视觉设置'));
    fs.writeFileSync(path.join(report, 'folia-settings.png'), (await capture(player)).toPNG());
    for (const label of ['播放控制', '交互控制', '连接与集成', '存储与同步', '桌面端设置', '实验室', '视觉设置']) {
      await player.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(label)}).click()`);
      await pause(300);
      assert.ok((await player.executeJavaScript('document.body.innerText')).includes(label));
    }
    await player.executeJavaScript(`document.querySelector('button[title="打开 Theme Park"]').click()`);
    await pause(600);
    assert.ok(await player.executeJavaScript(`document.body.innerText.includes('Theme Park') && [...document.querySelectorAll('button')].some(b=>/保存并应用/.test(b.innerText))`), 'the complete original theme editor opens, with its save action');
    fs.writeFileSync(path.join(report, 'folia-theme-park.png'), (await capture(player)).toPNG());
  }
  probe.progress('native navigation animation');
  await require('./folia-nav-overlay-checks')({ folia, win, player, js, pause, capture, themes, commands, nativeFrames, presentations });
  probe.progress('page leave, popout and remount');
  // Leaving during a slide cancels its frame callbacks, returns the same view
  // to its parked shell, and cannot attach an old clip to the next page.
  const departingClip = folia.dock.clip;
  await js('document.querySelector("#navToggle").click()'); await pause(40);
  await js('document.querySelector("#sidebar [data-route=history]").click()');
  await waitFor('document.body.dataset.panel === "history"'); await pause(350);
  assert.equal(folia.mode, 'background'); assert.equal(folia.dock, null);
  assert.equal(departingClip.children.length, 0);
  assert.ok(!win.contentView.children.includes(departingClip));
  assert.equal(folia.runtime.getMainWindow().webContents.id, playerId);
  await js('location.hash="#music"'); await waitFor('!!document.querySelector("#musicStage")');
  await js('document.querySelector("[data-music=embedded]").click()');
  for (let i=0;i<100&&!folia.dock;i++) await pause(50);
  assert.ok(folia.dock);
  if (process.argv.includes('--native-preview')) {
    win.setTitle('Harbour Folia sidebar validation'); win.setPosition(50,50); win.showInactive();
    console.log('FOLIA_NAV_INSPECT_READY'); await pause(30000);
  }
  const poppedClip = folia.dock.clip;
  await js(`document.querySelector('[data-music="window"]').click()`); await pause(100);
  assert.equal(folia.mode, 'window'); assert.equal(folia.runtime.getMainWindow().webContents.id, playerId);
  assert.equal(poppedClip.children.length, 0); assert.ok(!win.contentView.children.includes(poppedClip));
  await js(`location.hash='#history'`); await waitFor('document.body.dataset.panel === "history"');
  assert.equal(folia.mode, 'window', 'leaving embedded page must not hide an already popped-out window');
  assert.equal(await js(`document.querySelector('#content').style.getPropertyValue('--music-nav-inset')`), '', 'music layout must not leak into other pages');
  await js(`location.hash='#music'`); await waitFor('!!document.querySelector("#musicStage")');
  await js(`document.querySelector('[data-music="embedded"]').click()`); await pause(100);
  await js(`document.querySelector('#musicPlay').click()`); await pause(100);
  assert.equal(commands.filter(c=>c.action==='resume').length, 1, 'remount must not duplicate event handlers');
  await waitFor('!document.querySelector("#musicPlay").disabled');
  assert.ok(await js('document.querySelector("#musicNotice").textContent.includes("请先选择歌曲")'), 'empty playback returns guidance instead of a stuck button');
  win.setSize(860, 850); await pause(300);
  assert.ok(folia.dock.view.getBounds().width > 500);
  await js(`document.querySelector('#musicControlToggle').click()`); await pause(150);
  assert.equal(folia.dock.view.getVisible(), true, 'narrow search shares space without hiding the player');
  assert.ok(await js(`(() => {const s=document.querySelector('#musicStage').getBoundingClientRect(),r=document.querySelector('#musicRemote').getBoundingClientRect();return r.y>=s.bottom && r.height>=200 && s.height>120;})()`));
  await js(`document.querySelector('#musicControlClose').click()`); await pause(150);
  assert.equal(folia.dock.view.getVisible(), true);
  fs.writeFileSync(path.join(report, 'dashboard-narrow-frame.png'), (await capture(win.webContents)).toPNG());
  await js(`document.querySelector('#musicUnload').click()`); await pause(150);
  assert.equal(folia.runtime, null); assert.equal(win.isDestroyed(), false);
  await folia.close(); win.destroy();
  for (const socket of ws.clients) socket.terminate(); ws.close(); server.close();
  console.log('FOLIA_DASHBOARD_OK: real view, two widths, drawer, popout, remount, unload');
  probe.complete();
  app.exit(0);
}).catch(error => probe.fail(error));
