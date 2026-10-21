const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chatWindowUrl } = require('../companion/chat-window');
const base = 'http://localhost:7788';

test('only exact-server, path and known chat navigation can open an authenticated window', () => {
  for (const hash of ['#chat?new=1&agent=main-elaina', '#chat?session=cs-123&agent=main-elaina', '#chat?new=1&mode=cowork']) {
    assert.equal(chatWindowUrl(base + '/' + hash, base), base + '/' + hash);
  }
  for (const url of ['https://evil.test/#chat?new=1', base + '.evil.test/#chat?new=1', 'file:///c:/evil#chat?new=1',
    base + '/uploads/a.html#chat?new=1', base + '/?token=oops#chat?new=1', base + '/#chat?new=1&session=foo',
    base + '/#chat?new=1&input=run', base + '/#chat?session=..%2Fsecret', base + '/#chat?session=one&session=two']) {
    assert.equal(chatWindowUrl(url, base), null, url);
  }
});

test('explicit chat windows are independent and close only their own entry; ordinary auxiliary reuse is preserved', async () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
  const source = main.match(/^async function createDashboardSurface\([^\n]*\) \{[\s\S]*?^}/m)[0];
  const windows = [], auxiliaryWindows = new Map(); let seq = 0;
  class FakeWindow {
    constructor(options) { this.options = options; this.events = {}; this.webContents = { setWindowOpenHandler() {}, on() {} }; windows.push(this); }
    on(type, fn) { this.events[type] = fn; } isDestroyed() { return false; } show() {} focus() {}
    async loadURL(url) { this.url = url; }
  }
  const ctx = vm.createContext({ BrowserWindow: FakeWindow, auxiliaryWindows, chatWindowUrl, randomUUID: () => `window-${++seq}`,
    cfg: { url: base, token: 'fixture' }, path, __dirname: path.resolve(__dirname, '..'), APP_ICON_PATH: '', remoteBridge: null,
    removeWindowMenu() {}, closeGuard: { register() {} }, openDashboardLink() {} });
  vm.runInContext(source, ctx);
  const a = await ctx.createDashboardSurface('chat', base + '/#chat?session=A');
  const b = await ctx.createDashboardSurface('chat', base + '/#chat?session=B');
  assert.notEqual(a, b); assert.equal(auxiliaryWindows.size, 2);
  assert.equal(a.options.webPreferences.nodeIntegration, false); assert.equal(a.options.webPreferences.contextIsolation, true);
  assert.ok(!a.options.webPreferences.additionalArguments.includes('--harbour-startup=1'));
  a.events.closed(); assert.equal(auxiliaryWindows.size, 1); assert.ok([...auxiliaryWindows.values()].includes(b));
  const ordinary = await ctx.createDashboardSurface('tasks');
  assert.equal(await ctx.createDashboardSurface('tasks'), ordinary);
  await assert.rejects(ctx.createDashboardSurface('chat', 'https://evil.test/#chat?new=1'));
  assert.equal(windows.length, 3);
});
