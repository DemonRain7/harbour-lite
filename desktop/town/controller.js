const { BrowserWindow, WebContentsView, View } = require('electron');
const path = require('node:path');
const { removeWindowMenu } = require('../companion/window-menu');
const windows = new WeakSet();
const isTownWindow = win => windows.has(win);

// One renderer/GPU scene, reparented between the Dashboard and a native shell.
// Never open a second Town to implement pop-out/fullscreen.
class TownController {
  constructor({ url, token = '', onState = () => {}, onWindow = () => {}, onReturn = () => {} }) {
    this.url = new URL('/town/index.html', url).href;
    this.token = token; this.onState = onState; this.onWindow = onWindow; this.onReturn = onReturn;
    this.mode = 'closed'; this.generation = 0; this.visible = false;
  }
  status() { return { mode: this.mode, visible: this.visible && !this.visualQuiet, running: !!this.view, fullscreen: !!this.win && !this.win.isDestroyed() && this.win.isFullScreen(), error: this.error || '' }; }
  setVisualQuiet(value) { if (value !== this.visualQuiet) { this.visualQuiet = value; this.publish(); } }
  owns(event) {
    return !!this.view && !this.view.webContents.isDestroyed() && event.sender === this.view.webContents
      && event.senderFrame === event.sender.mainFrame && event.sender.getURL().split('#')[0] === this.url;
  }
  publish(force = false) {
    const state = this.status();
    const key = JSON.stringify(state);
    if (!force && key === this.lastState) return state;
    this.lastState = key;
    if (this.view && !this.needsReload && !this.view.webContents.isDestroyed()) this.view.webContents.send('town:state', state);
    this.onState(state); return state;
  }
  load(view) {
    const pending = view.webContents.loadURL(this.url).then(() => {
      if (this.view === view) { this.error = ''; this.needsReload = false; this.publish(true); }
    }).catch(error => {
      if (this.view === view) { this.error = `小镇载入失败：${error.message}`; this.needsReload = true; this.visible = false; this.publish(); }
      throw error;
    }).finally(() => { if (this.starting === pending) this.starting = null; });
    this.starting = pending;
    return pending;
  }
  async ensure() {
    if (this.starting) return this.starting;
    // Retry only on an explicit open, in the same WebContents. Never replay a
    // chat request or open a second scene when loading/the renderer has failed.
    if (this.view && !this.view.webContents.isDestroyed()) return this.needsReload ? this.load(this.view) : undefined;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    const win = new BrowserWindow({ show: false, width: 1280, height: 860, minWidth: 640, minHeight: 480,
      title: 'Harbour · 小镇', autoHideMenuBar: true, backgroundColor: '#edf0ed',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    removeWindowMenu(win);
    windows.add(win);
    const blank = win.webContents;
    const view = new WebContentsView({ webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
      // Its native shell stays hidden while docked. Explicit host visibility
      // stops drawing/audio; shell occlusion must not suspend a visible child.
      backgroundThrottling: false,
      additionalArguments: [`--town-url=${encodeURIComponent(this.url)}`, `--town-token=${encodeURIComponent(this.token)}`],
    } });
    this.win = win; this.view = view; this.mode = 'background';
    Object.defineProperty(win, 'webContents', { value: view.webContents });
    win.contentView.addChildView(view);
    const fit = () => { if (!this.dock && !win.isDestroyed()) { const [width, height] = win.getContentSize(); view.setBounds({ x: 0, y: 0, width, height }); } };
    fit(); win.on('resize', fit);
    for (const name of ['enter-full-screen', 'leave-full-screen']) win.on(name, () => { fit(); this.publish(); });
    win.on('minimize', () => { if (!this.dock) { this.visible = false; this.publish(); } });
    win.on('restore', () => { if (!this.dock && this.mode === 'window') { this.visible = true; this.publish(); } });
    win.on('hide', () => { if (!this.dock) { this.visible = false; this.publish(); } });
    // Native shell owns a movable view, not its blank built-in webContents.
    this.onWindow(win);
    win.on('closed', () => {
      if (this.win !== win) return;
      this.detach();
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
      if (!blank.isDestroyed()) blank.close();
      this.win = this.view = null; this.starting = null; this.error = ''; this.needsReload = false;
      this.mode = 'closed'; this.visible = false; this.generation++; this.publish();
    });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Map/quality changes release their GPU realm by reloading this exact
    // document. No query, path, origin or frame expansion is allowed.
    view.webContents.on('will-navigate', (event, url) => {
      if ((event.url || url) !== this.url || view.webContents.getURL().split('#')[0] !== this.url) event.preventDefault();
    });
    view.webContents.on('will-redirect', event => event.preventDefault());
    view.webContents.on('render-process-gone', () => {
      this.error = '小镇画面进程已退出，可重新载入画面；进行中的对话请先在聊天记录中核对，不会自动重发。';
      this.needsReload = true; this.visible = false; view.setVisible(false); this.publish();
    });
    return this.load(view);
  }
  watchParent(parent) {
    if (!parent || (this.parents ||= new WeakSet()).has(parent)) return;
    this.parents.add(parent);
    for (const event of ['hide', 'show', 'minimize', 'restore']) parent.on(event, () => {
      if (this.dock?.parent === parent) this.resize(parent, this.dock.bounds, this.dock.requestedVisible);
    });
    // Hash routing is handled by the page. A full refresh/navigation cannot
    // rely on that page's cleanup; park the retained native scene ourselves.
    parent.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) this.hide(parent);
    });
    parent.on('closed', () => this.hide(parent));
  }
  detach() {
    if (!this.dock) return;
    const { parent, clip } = this.dock;
    clip.removeChildView(this.view);
    if (!parent.isDestroyed()) parent.contentView.removeChildView(clip);
    this.dock = null;
  }
  undock() {
    this.detach();
    if (!this.win || this.win.isDestroyed()) return;
    if (!this.win.contentView.children.includes(this.view)) this.win.contentView.addChildView(this.view);
    this.view.setBorderRadius(0); this.view.setVisible(true);
    const [width, height] = this.win.getContentSize(); this.view.setBounds({ x: 0, y: 0, width, height });
  }
  reveal() {
    if (!this.win || this.win.isDestroyed()) return;
    this.undock(); this.mode = this.requestedMode = 'window'; this.visible = true;
    this.win.show(); if (this.win.isMinimized()) this.win.restore(); this.win.focus(); this.view.webContents.focus(); this.publish(true);
  }
  async open(mode, parent, bounds, visible = true) {
    if (!['embedded', 'window'].includes(mode)) throw new Error('未知小镇窗口模式');
    if (mode === 'embedded') this.watchParent(parent);
    this.requestedMode = mode;
    const generation = ++this.generation;
    await this.ensure();
    if (generation !== this.generation || !this.view) return this.status();
    if (mode === 'window') {
      this.reveal();
    } else {
      if (!parent || parent.isDestroyed()) return this.status();
      if (this.win.isFullScreen()) this.win.setFullScreen(false);
      if (this.dock?.parent !== parent) {
        this.detach();
        if (this.win.contentView.children.includes(this.view)) this.win.contentView.removeChildView(this.view);
        const clip = new View(); parent.contentView.addChildView(clip); clip.addChildView(this.view);
        this.dock = { parent, clip };
      }
      this.mode = 'embedded'; this.view.setBorderRadius(18);
      this.win.hide(); this.resize(parent, bounds, visible);
    }
    return this.publish();
  }
  resize(parent, bounds = {}, visible = true) {
    if (this.dock?.parent !== parent || parent.isDestroyed()) return;
    this.dock.bounds = bounds; this.dock.requestedVisible = visible;
    const zoom = parent.webContents.getZoomFactor();
    const value = key => Number.isFinite(bounds[key]) ? Math.round(bounds[key] * zoom) : 0;
    const [width, height] = parent.getContentSize();
    const x = Math.max(0, Math.min(width, value('x'))), y = Math.max(0, Math.min(height, value('y')));
    const w = Math.max(0, Math.min(width - x, value('width'))), h = Math.max(0, Math.min(height - y, value('height')));
    const left = Math.max(0, Math.min(w, value('clipLeft')));
    const key = [x, y, w, h, left].join(':');
    if (this.dock.geometry !== key) {
      this.dock.clip.setBounds({ x: x + left, y, width: Math.max(1, w - left), height: Math.max(1, h) });
      this.view.setBounds({ x: -left, y: 0, width: Math.max(1, w), height: Math.max(1, h) });
      this.dock.geometry = key;
    }
    this.visible = !this.error && visible && parent.isVisible() && !parent.isMinimized() && w > left && h > 0;
    this.dock.clip.setVisible(this.visible); this.view.setVisible(this.visible); this.publish();
  }
  hide(parent) {
    // Cancels an outstanding embedded-open without hiding an independent town.
    if (this.mode === 'window' || this.requestedMode === 'window' || (this.dock && this.dock.parent !== parent)) return this.status();
    this.generation++; this.requestedMode = 'background';
    this.undock(); this.win?.hide(); this.mode = this.view ? 'background' : 'closed'; this.visible = false;
    return this.publish();
  }
  async fullscreen() {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.win.isFullScreen()) this.win.setFullScreen(false);
    else { await this.open('window'); this.win.setFullScreen(true); }
    return this.publish();
  }
  returnToDashboard() { return this.onReturn(); }
  dispose() { if (this.win && !this.win.isDestroyed()) { this.detach(); this.win.destroy(); } }
}
module.exports = { TownController, isTownWindow };
