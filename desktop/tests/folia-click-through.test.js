const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// desktop/tests/folia-click-through.test.js
// Background-only contracts: execute production code with inert native objects, never Electron.
const root = path.resolve(__dirname, '../..');
const mainSource = fs.readFileSync(path.join(root, 'vendor/folia/electron/main.cjs'), 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `production boundary changed: ${start}`);
  return source.slice(from, to);
}

// Evaluate the actual native setter, hotspot monitor and IPC handlers, not reimplementations.
function nativeFixture(isEmbedded = () => false) {
  const handlers = new Map();
  const intervals = new Set();
  const sent = [];
  const ignored = [];
  const snapshots = [];
  const player = { isDestroyed: () => false, send: (...args) => sent.push(args), focus() {} };
  const remote = {};
  let visible = false;
  const mainWindow = {
    webContents: player, isDestroyed: () => false, isVisible: () => visible,
    show() { visible = true; }, hide() { visible = false; }, focus() {}, on() {},
    getBounds: () => ({ x: 100, y: 100, width: 1200, height: 800 }),
    getContentSize: () => [1200, 800],
    setIgnoreMouseEvents: (active, options) => ignored.push({ active, forward: options.forward }),
  };
  const context = vm.createContext({
    host: { isPlayerEmbedded: isEmbedded }, mainWindow,
    mainWindowClickThroughEnabled: false, mainWindowClickThroughUnlockHover: false,
    mainWindowClickThroughUnlockHoverTimer: null, mainWindowAlwaysOnTop: false,
    latestRemoteControlSnapshot: {}, isMacWallpaperActive: false,
    isX11WallpaperMode: () => false, isWindowsWallpaperMode: () => false,
    refreshTrayMenu() {}, sendRemoteControlSnapshot: snapshot => snapshots.push(snapshot),
    screen: { getCursorScreenPoint: () => context.cursor }, cursor: { x: 0, y: 0 },
    setInterval: fn => { intervals.add(fn); return fn; }, clearInterval: fn => intervals.delete(fn),
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    isTrustedMainWindowContents: sender => sender === player,
    isTrustedRemoteControlContents: sender => sender === remote,
  });
  vm.runInContext([
    section(mainSource, 'const MAIN_WINDOW_CLICK_THROUGH_UNLOCK_HOTSPOT =', 'const DEFAULT_WINDOW_BOUNDS ='),
    section(mainSource, 'function patchRemoteControlSnapshot(patch)', 'function sendRemoteControlSnapshot(snapshot)'),
    section(mainSource, "ipcMain.handle('window-get-click-through'", "ipcMain.handle('window-get-always-on-top'"),
    section(mainSource, "ipcMain.handle('remote-control-publish-snapshot'", "ipcMain.handle('video-export-choose-path'"),
    'globalThis.refreshPresentation = ({' + section(mainSource, '  refreshPresentation: () => {', '  snapshot: () =>') + '}).refreshPresentation;',
  ].join('\n'), context, { filename: 'folia-click-through-production-sections.cjs' });
  const invoke = (name, args = [], sender = player) => handlers.get(name)({ sender }, ...args);
  return { context, mainWindow, player, remote, intervals, sent, ignored, snapshots, invoke,
    runtime: { getMainWindow: () => mainWindow,
      setClickThrough: context.setMainWindowClickThroughEnabled,
      refreshPresentation: context.refreshPresentation } };
}

test('embedded native setter, direct IPC and Remote IPC all refuse click-through', () => {
  const f = nativeFixture(() => true);
  assert.equal(f.context.setMainWindowClickThroughEnabled(true), false, 'tray/preset calls share the native guard');
  assert.equal(f.invoke('window-set-click-through', [true]), false);
  assert.equal(f.invoke('remote-control-send-command', [{ type: 'set-main-window-click-through', enabled: true }], f.remote), false);
  assert.equal(f.invoke('window-get-click-through'), false);
  assert.equal(f.context.mainWindowClickThroughUnlockHover, false);
  assert.equal(f.intervals.size, 0, 'embedded locking never starts a hidden-shell hover monitor');
  assert.ok(f.ignored.every(call => call.active === false && call.forward === true));
  assert.ok(f.sent.every(([name, state]) => name === 'main-window-click-through-changed' && state.enabled === false));
  assert.equal(f.snapshots.at(-1).mainWindowClickThroughAvailable, false);
});

test('click-through IPC keeps its player/Remote trust boundaries', () => {
  const f = nativeFixture();
  const foreign = {};
  assert.equal(f.invoke('window-set-click-through', [true], foreign), false);
  assert.equal(f.invoke('window-set-click-through-unlock-hover', [true], foreign), false);
  assert.throws(() => f.invoke('remote-control-send-command', [{ type: 'set-main-window-click-through', enabled: true }], foreign), /Untrusted renderer/);
  assert.equal(f.context.mainWindowClickThroughEnabled, false);
  assert.equal(f.ignored.length, 0);
});

test('standalone click-through retains its native cursor hotspot and explicit hover unlock', () => {
  const f = nativeFixture();
  assert.equal(f.invoke('window-set-click-through', [true]), true);
  assert.equal(f.ignored.at(-1).active, true);
  assert.equal(f.intervals.size, 1);
  f.invoke('window-set-click-through', [true]);
  assert.equal(f.intervals.size, 1, 'repeated enables must not duplicate timers');
  f.context.cursor = { x: 1100, y: 112 };
  for (const poll of f.intervals) poll();
  assert.equal(f.context.mainWindowClickThroughUnlockHover, true);
  assert.equal(f.ignored.at(-1).active, false, 'the original top-right unlock hotspot accepts clicks');
  f.context.cursor = { x: 400, y: 400 };
  for (const poll of f.intervals) poll();
  assert.equal(f.ignored.at(-1).active, true);
  assert.equal(f.invoke('window-set-click-through-unlock-hover', [true]), true);
  assert.equal(f.ignored.at(-1).active, false);
  assert.equal(f.invoke('window-set-click-through', [false]), false);
  assert.equal(f.context.mainWindowClickThroughUnlockHover, false);
  assert.equal(f.ignored.at(-1).active, false);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.snapshots.at(-1).mainWindowClickThroughAvailable, true);
});

test('standalone Remote can still enable and disable click-through', () => {
  const f = nativeFixture();
  const remoteToggle = enabled => f.invoke('remote-control-send-command', [{ type: 'set-main-window-click-through', enabled }], f.remote);
  assert.equal(remoteToggle(true), true);
  assert.equal(f.ignored.at(-1).active, true);
  assert.equal(remoteToggle(false), false);
  assert.equal(f.ignored.at(-1).active, false);
  assert.equal(f.intervals.size, 0);
});

test('native click-through remains compatible without a host presentation capability', () => {
  const f = nativeFixture();
  f.context.host = {};
  assert.equal(f.context.setMainWindowClickThroughEnabled(true), true);
  assert.equal(f.snapshots.at(-1).mainWindowClickThroughAvailable, true);
  assert.equal(f.context.setMainWindowClickThroughEnabled(false), false);
  assert.equal(f.intervals.size, 0);
});

test('standalone wallpaper restrictions remain stronger than click-through requests', () => {
  for (const mode of ['isX11WallpaperMode', 'isWindowsWallpaperMode', 'isMacWallpaperActive']) {
    const f = nativeFixture();
    f.context[mode] = mode === 'isMacWallpaperActive' ? true : () => true;
    assert.equal(f.context.setMainWindowClickThroughEnabled(true), false, mode);
    assert.equal(f.intervals.size, 0);
    assert.equal(f.ignored.length, 0);
  }
});

test('presentation refresh clears an old lock and publishes authoritative Remote availability', () => {
  let embedded = false;
  const f = nativeFixture(() => embedded);
  f.invoke('window-set-click-through', [true]);
  embedded = true;
  f.runtime.refreshPresentation();
  assert.equal(f.invoke('window-get-click-through'), false);
  assert.equal(f.ignored.at(-1).active, false);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.sent.at(-1)[1].enabled, false, 'renderer is told to remove its document input lock');
  assert.equal(f.snapshots.at(-1).mainWindowClickThroughAvailable, false);
  f.invoke('remote-control-publish-snapshot', [{ mainWindowClickThroughEnabled: true, mainWindowClickThroughAvailable: true }]);
  assert.equal(f.snapshots.at(-1).mainWindowClickThroughEnabled, false);
  assert.equal(f.snapshots.at(-1).mainWindowClickThroughAvailable, false, 'renderer snapshots cannot overwrite host authority');
  embedded = false;
  f.runtime.refreshPresentation();
  assert.equal(f.snapshots.at(-1).mainWindowClickThroughAvailable, true);
  assert.equal(f.invoke('window-get-click-through'), false, 'returning standalone never silently re-enables the old lock');
});

class FakeView {
  constructor() { this.children = []; }
  addChildView(view) { this.children.push(view); }
  removeChildView(view) { this.children = this.children.filter(child => child !== view); }
  setBounds() {}
  setBorderRadius() {}
  setVisible() {}
}

// Load the complete controller with inert Electron/host dependencies; all lifecycle methods are real.
function controllerFixture() {
  let controller;
  let hostOptions;
  const handlers = new Map();
  const f = nativeFixture(() => !!controller?.dock);
  f.mainWindow.isMinimized = () => false;
  const view = new FakeView();
  view.webContents = f.player;
  f.mainWindow.contentView = new FakeView();
  f.mainWindow.contentView.addChildView(view);
  let refreshes = 0;
  const refresh = f.runtime.refreshPresentation;
  f.runtime.refreshPresentation = () => { refreshes++; refresh(); };
  f.runtime.ready = { then(resolve) {
    handlers.get('harbour-folia:ready')({ sender: f.player });
    resolve();
  } };
  const fakeHost = { views: new Map([[f.mainWindow, view]]), dispose() {},
    ipc: { handle: (name, fn) => handlers.set(name, fn), on() {} } };
  class FakeHealth {
    snapshot() { return { phase: 'ready' }; }
    start() {} ready() {} seen() {} close() {}
  }
  const module = { exports: {} };
  const controllerPath = path.join(root, 'desktop/folia/controller.js');
  vm.runInNewContext(fs.readFileSync(controllerPath, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(controllerPath), console,
    require(name) {
      if (name === 'electron') return { app: { isPackaged: false, getPath: () => '/fixture' }, View: FakeView };
      if (name === 'node:fs') return { existsSync: () => true };
      if (name === './host') return { createFoliaHost: options => { hostOptions = options; return fakeHost; } };
      if (name === './renderer-health') return { FoliaRendererHealth: FakeHealth };
      if (name.replaceAll('\\', '/').endsWith('electron/main.cjs')) return () => f.runtime;
      return require(name);
    },
  }, { filename: controllerPath });
  controller = new module.exports.FoliaController({ root: '/unbuilt-folia-fixture', dataDir: '/fixture' });
  const parent = { contentView: new FakeView(), isDestroyed: () => false, visible: true, minimized: false,
    isVisible: () => parent.visible, isMinimized: () => parent.minimized,
    getContentSize: () => [1400, 1000], on() {} };
  return { ...f, controller, parent, hostOptions: () => hostOptions, refreshes: () => refreshes,
    invokeHost: (name, sender = f.player) => handlers.get(name)({ sender }),
    presentationEvents: () => f.sent.filter(([name]) => name === 'harbour-folia:presentation') };
}

test('hidden, minimized and game-quiet Folia change visuals only; audio state is preserved', async () => {
  const f = controllerFixture();
  await f.controller.open('embedded', f.parent, { width: 1000, height: 700 });
  f.controller.publish({ paused: false, currentTrackId: 'keep-playing', positionMs: 1000 });
  f.controller.setVisualQuiet(true);
  assert.equal(f.controller.presentation(), 'background');
  const count = f.presentationEvents().length;
  f.controller.publish({ positionMs: 2000 }); f.controller.setVisualQuiet(true);
  assert.equal(f.presentationEvents().length, count);
  assert.equal(f.controller.status().paused, false); assert.equal(f.controller.status().currentTrackId, 'keep-playing');
  f.controller.setVisualQuiet(false); assert.equal(f.controller.presentation(), 'embedded');
  f.parent.minimized = true; f.controller.publishPresentation(); assert.equal(f.controller.presentation(), 'background');
  f.parent.minimized = false; f.parent.visible = false; assert.equal(f.controller.presentation(), 'background');
  f.parent.visible = true; assert.equal(f.controller.presentation(), 'embedded');
});

test('controller rejects embedded direct/Remote locking without undocking, then clears a standalone lock on re-embed', async () => {
  const f = controllerFixture();
  const bounds = { x: 20, y: 70, width: 1200, height: 800 };
  await f.controller.open('embedded', f.parent, bounds);
  const dock = f.controller.dock;
  const options = f.hostOptions();
  assert.equal(options.isPlayerEmbedded(), true);
  for (const [name, args, sender] of [
    ['window-set-click-through', [true], f.player],
    ['remote-control-send-command', [{ type: 'set-main-window-click-through', enabled: true }], f.remote],
    ['window-set-click-through-unlock-hover', [false], f.player],
  ]) {
    options.beforeNativeAction(name, args, sender);
    f.invoke(name, args, sender);
    assert.equal(f.controller.dock, dock, `${name} must not move the embedded view`);
    assert.equal(f.controller.mode, 'embedded');
    assert.equal(f.context.mainWindowClickThroughEnabled, false);
  }
  await f.controller.open('window');
  assert.equal(options.isPlayerEmbedded(), false);
  assert.equal(f.invoke('window-set-click-through', [true]), true);
  await f.controller.open('embedded', f.parent, bounds);
  assert.equal(f.controller.mode, 'embedded');
  assert.equal(f.invoke('window-get-click-through'), false);
  assert.equal(f.ignored.at(-1).active, false);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.mainWindow.webContents, f.player, 'presentation changes preserve the renderer');
});

test('controller sends presentation notifications only on discrete changes, not playback publishes', async () => {
  const f = controllerFixture();
  await f.controller.open('embedded', f.parent, { width: 1000, height: 700 });
  const initialEvents = f.presentationEvents().length;
  const initialRefreshes = f.refreshes();
  for (let position = 0; position < 120; position++) f.controller.publish({ position, paused: position % 2 === 0 });
  assert.equal(f.presentationEvents().length, initialEvents);
  assert.equal(f.refreshes(), initialRefreshes);
  await f.controller.open('window');
  assert.equal(f.presentationEvents().length, initialEvents + 1);
  assert.equal(f.presentationEvents().at(-1)[1], 'window');
  f.controller.publish();
  assert.equal(f.presentationEvents().length, initialEvents + 1);
  f.controller.hide();
  assert.equal(f.presentationEvents().length, initialEvents + 2);
  assert.equal(f.presentationEvents().at(-1)[1], 'background');
  f.controller.publish();
  assert.equal(f.presentationEvents().length, initialEvents + 2);
  assert.equal(f.refreshes(), initialRefreshes + 2);
});

test('a reloaded renderer can read unchanged presentation without needing a replayed event', async () => {
  const f = controllerFixture();
  await f.controller.open('embedded', f.parent, { width: 1000, height: 700 });
  const previousEvents = f.presentationEvents().length;
  assert.equal(f.invokeHost('harbour-folia:get-presentation'), 'embedded');
  assert.equal(f.invokeHost('harbour-folia:get-presentation'), 'embedded');
  assert.equal(f.presentationEvents().length, previousEvents);
  assert.throws(() => f.invokeHost('harbour-folia:get-presentation', f.remote), /Only the Folia player/);
  await f.controller.open('window');
  assert.equal(f.invokeHost('harbour-folia:get-presentation'), 'window');
});
