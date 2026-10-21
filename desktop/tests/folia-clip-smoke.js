const { app, BrowserWindow, View, WebContentsView } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FoliaController, scaledFoliaBounds } = require('../folia/controller');

// Actual native View/renderer, isolated data. --native-preview leaves a visible test
// window for 60s: Space opens/closes the clip; both buttons should remain usable.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-native-clip-')));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ title: 'Harbour isolated Folia clip test', width: 1200, height: 850, show: false, webPreferences: { backgroundThrottling: false } });
  win.setMenu(null);
  await win.loadURL('data:text/html,<body style="margin:0;background:rgb(0,128,0)">Harbour navigation<button style="position:absolute;left:35px;top:100px" onclick="this.textContent=\'NAV OK\'">Navigation</button></body>');
  const clip = new View(); clip.setBorderRadius(1);
  const player = new WebContentsView({ webPreferences: { partition: 'native-clip-player', backgroundThrottling: false } });
  clip.addChildView(player); win.contentView.addChildView(clip);
  await player.webContents.loadURL('data:text/html,<body style="margin:0;background:rgb(128,0,0)"><button style="position:absolute;left:300px;top:100px;width:100px;height:40px;background:blue;color:white" onclick="this.textContent=\'PLAYER OK\'">Player</button></body>');
  const controller = new FoliaController();
  controller.dock = { window: win, view: player, clip, visible: true };
  const frame = { x: 20, y: 60, width: 700, height: 450 };
  const apply = (clipLeft = 0, visible = true) => controller.resize(win, scaledFoliaBounds(win, { ...frame, clipLeft }), visible);
  for (const zoom of [1, 1.25, .9, 1.5]) {
    win.webContents.setZoomFactor(zoom); apply(); await pause(50);
    const size = await player.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');
    for (const inset of [0, 50.4, 200, 75, 0, null, -50, Infinity]) {
      apply(inset); await pause(30);
      const viewBounds = player.getBounds(), clipBounds = clip.getBounds();
      assert.deepEqual(await player.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})'), size);
      assert.equal(viewBounds.width, Math.round(frame.width*zoom));
      assert.equal(viewBounds.height, Math.round(frame.height*zoom));
      assert.equal(clipBounds.x + viewBounds.x, Math.round(frame.x*zoom));
      assert.equal(clipBounds.y + viewBounds.y, Math.round(frame.y*zoom));
      assert.equal(clipBounds.width - viewBounds.x, viewBounds.width);
      assert.equal(clip.getVisible(), true);
    }
    apply(frame.width); assert.equal(clip.getVisible(), false, 'fully covered cannot paint/capture outside clip');
    apply(frame.width-1); assert.equal(clip.getVisible(), false, 'sub-32 DIP clip must not expose unclipped children');
    apply(200, false); assert.equal(clip.getVisible(), false); assert.equal(player.getVisible(), false);
    apply(); assert.equal(player.getVisible(), true); assert.equal(clip.getVisible(), true);
  }
  const parking = new BrowserWindow({ show: false });
  const before = player.getBounds();
  controller.resize(parking, { ...frame, clipLeft: 100 });
  assert.deepEqual(player.getBounds(), before, 'another window cannot move the embedded view');
  if (process.argv.includes('--native-preview')) {
    win.webContents.setZoomFactor(1); apply(); win.show();
    let inset = 0;
    const toggle = (_event, input) => { if (input.type === 'keyDown' && input.key === ' ') { inset = inset ? 0 : 200; apply(inset); } };
    win.webContents.on('before-input-event', toggle); player.webContents.on('before-input-event', toggle);
    console.log('NATIVE_CLIP_INSPECT: Space toggles the overlay; click Navigation and Player.');
    await pause(60000);
  }
  controller.runtime = { getMainWindow: () => parking };
  controller.undock();
  assert.equal(controller.dock, null);
  assert.equal(clip.children.length, 0, 'no retained native player after undock');
  assert.ok(!win.contentView.children.includes(clip));
  assert.ok(parking.contentView.children.includes(player));
  assert.equal(player.getVisible(), true);
  player.webContents.close(); win.destroy(); parking.destroy();
  console.log('FOLIA_CLIP_OK: native geometry, four zoom levels, invalid bounds, modal/ownership/undock');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
