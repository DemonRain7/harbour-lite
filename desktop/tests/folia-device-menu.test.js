const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { FoliaDeviceMenu, normalizeRequest, menuBounds } = require('../folia/device-menu');

const request = () => ({ items: [{ value: 'local', label: '本机', description: '在线', selected: true }, { value: 'offline', label: '离线', disabled: true }],
  anchor: { x: 400, y: 80, width: 130, height: 30 }, theme: { panel: 'rgb(20, 21, 25)', accent: 'oklch(75% 0.12 280)', fontFamily: '"Segoe UI", sans-serif' } });

function fixture() {
  const ipcMain = new EventEmitter();
  const views = [];
  class Contents extends EventEmitter {
    constructor() { super(); this.mainFrame = {}; this.destroyed = false; this.zoom = 1; this.messages = []; }
    isDestroyed() { return this.destroyed; }
    setZoomFactor(value) { this.zoom = value; }
    getZoomFactor() { return this.zoom; }
    setWindowOpenHandler(handler) { this.openHandler = handler; }
    loadFile() { return new Promise(resolve => { this.loaded = resolve; }); }
    send(...args) { this.messages.push(args); }
    focus() { this.focused = true; }
    close() { this.destroyed = true; this.emit('destroyed'); }
  }
  class WebContentsView {
    constructor(options) { this.options = options; this.webContents = new Contents(); views.push(this); }
    setBackgroundColor(value) { this.background = value; }
    setBorderRadius(value) { this.radius = value; }
    setBounds(value) { this.bounds = value; }
  }
  const parent = new EventEmitter();
  parent.webContents = new Contents(); parent.isDestroyed = () => false; parent.getContentSize = () => [1000, 800];
  const child = {};
  parent.contentView = { children: [child], addChildView(view) { this.children.push(view); }, removeChildView(view) { this.children = this.children.filter(item => item !== view); } };
  const player = new Contents();
  const menu = new FoliaDeviceMenu({ electron: { WebContentsView, ipcMain } });
  const send = message => ipcMain.emit('folia-device-menu:event', { sender: menu.webContents, senderFrame: menu.webContents.mainFrame }, message);
  const loaded = async () => { views.at(-1).webContents.loaded(); await Promise.resolve(); };
  return { menu, parent, player, views, child, ipcMain, send, loaded };
}

test('request data is bounded; untrusted styles never become URLs or declarations', () => {
  const data = request(); data.theme.panel = 'url(https://invalid.example/x)'; data.theme.fontFamily = 'bad; color:red';
  const clean = normalizeRequest(data);
  assert.equal(clean.theme.panel, '#202229'); assert.equal(clean.theme.fontFamily, '"Segoe UI", sans-serif');
  assert.equal(clean.theme.accent, 'oklch(75% 0.12 280)');
  assert.throws(() => normalizeRequest({ ...data, items: [...data.items, data.items[0]] }), /option/);
  assert.throws(() => normalizeRequest({ ...data, anchor: { ...data.anchor, x: Infinity } }), /anchor/);
  assert.throws(() => normalizeRequest({ ...data, items: Array(101).fill(data.items[0]) }), /items/);
});

test('bounded geometry converts CSS pixels once and can open upward', () => {
  const f = fixture();
  for (const zoom of [0.9, 1, 1.25, 1.5]) {
    f.parent.webContents.zoom = zoom;
    const { bounds } = menuBounds(f.parent, request().anchor, 116);
    assert.equal(bounds.width, Math.round(272 * zoom));
    assert.equal(bounds.height, Math.round(116 * zoom));
    assert.equal(bounds.y, Math.round(117 * zoom));
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 1000);
  }
  f.parent.webContents.zoom = 1;
  const up = menuBounds(f.parent, { x: 980, y: 760, width: 10, height: 20 }, 170).bounds;
  assert.equal(up.y, 583); assert.equal(up.x + up.width, 992);
});

test('native overlay stays above existing children, scopes IPC, and validates option identity', async () => {
  const f = fixture(), result = f.menu.open(f.parent, request(), { playerContents: f.player });
  const contents = f.menu.webContents;
  await f.loaded();
  assert.deepEqual(f.parent.contentView.children, [f.child, f.menu.view]);
  assert.equal(contents.focused, true); assert.equal(f.menu.view.options.webPreferences.sandbox, true);
  assert.equal(f.menu.view.options.webPreferences.nodeIntegration, false);
  assert.deepEqual(contents.openHandler(), { action: 'deny' });
  f.ipcMain.emit('folia-device-menu:event', { sender: f.player, senderFrame: f.player.mainFrame }, { type: 'choose', value: 'local' });
  f.ipcMain.emit('folia-device-menu:event', { sender: contents, senderFrame: {} }, { type: 'choose', value: 'local' });
  f.send({ type: 'choose', value: 'offline' }); f.send({ type: 'choose', value: 'unknown' });
  assert.equal(f.menu.webContents, contents);
  f.send({ type: 'choose', value: 'local' });
  assert.deepEqual(await result, { value: 'local' }); assert.equal(contents.isDestroyed(), true);
  assert.equal(f.parent.webContents.focused, true, 'selection returns native focus to Dashboard without focusing the OS window');
  assert.deepEqual(f.parent.contentView.children, [f.child]); assert.equal(f.menu.webContents, null);
  assert.equal(f.ipcMain.listenerCount('folia-device-menu:event'), 0);
  assert.equal(f.player.listenerCount('before-mouse-event'), 0); assert.equal(f.parent.listenerCount('resize'), 0);
});

test('outside mouse down is not consumed, keyboard reasons survive, late load cannot attach', async () => {
  const f = fixture();
  const first = f.menu.open(f.parent, request(), { playerContents: f.player });
  const firstContents = f.menu.webContents;
  const second = f.menu.open(f.parent, request(), { playerContents: f.player });
  assert.equal(await first, null); firstContents.loaded(); await Promise.resolve();
  assert.deepEqual(f.parent.contentView.children, [f.child]);
  await f.loaded();
  let prevented = false;
  f.player.emit('before-mouse-event', { preventDefault() { prevented = true; } }, { type: 'mouseMove' });
  assert.ok(f.menu.webContents);
  f.player.emit('before-mouse-event', { preventDefault() { prevented = true; } }, { type: 'mouseDown' });
  assert.equal(await second, null); assert.equal(prevented, false);
  assert.notEqual(f.parent.webContents.focused, true, 'outside click must retain its own focus target');
  for (const reason of ['escape', 'tab', 'shift-tab']) {
    f.parent.webContents.focused = false;
    const pending = f.menu.open(f.parent, request()); await f.loaded(); f.send({ type: 'dismiss', reason });
    assert.deepEqual(await pending, { dismiss: reason });
    assert.equal(f.parent.webContents.focused, true, `${reason} returns native focus before shared-select DOM focus`);
  }
});

test('parent lifecycle always cancels and removes transient listeners', async () => {
  const f = fixture();
  for (const [target, event] of [[f.parent, 'resize'], [f.parent, 'blur'], [f.parent, 'hide'], [f.parent.webContents, 'zoom-changed']]) {
    const pending = f.menu.open(f.parent, request(), { playerContents: f.player }); await f.loaded(); target.emit(event);
    assert.equal(await pending, null); assert.equal(f.menu.webContents, null);
    assert.deepEqual(f.parent.contentView.children, [f.child]); assert.equal(f.ipcMain.listenerCount('folia-device-menu:event'), 0);
  }
});
