const path = require('node:path');

const EVENT_CHANNEL = 'folia-device-menu:event';
const DATA_CHANNEL = 'folia-device-menu:data';
const THEME_DEFAULTS = Object.freeze({ panel: '#202229', fg: '#f3f4f6', dim: '#a3a8b5', border: '#454954', accent: '#ae99ef', fontFamily: '"Segoe UI", sans-serif' });
const COLOR = /^(?:#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla|lab|lch|oklab|oklch|color)\([a-z\d.,%+\-\s/]+\)|transparent|black|white)$/i;

function normalizeRequest(request) {
  if (!request || !Array.isArray(request.items) || request.items.length > 100) throw new TypeError('Invalid device menu items');
  const values = new Set();
  const items = request.items.map(item => {
    if (!item || typeof item.value !== 'string' || item.value.length > 500 || values.has(item.value)
      || typeof item.label !== 'string' || item.label.length > 500
      || (item.description !== undefined && (typeof item.description !== 'string' || item.description.length > 500))) throw new TypeError('Invalid device menu option');
    values.add(item.value);
    return { value: item.value, label: item.label, description: item.description || '', disabled: item.disabled === true, selected: item.selected === true };
  });
  const anchor = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const value = request.anchor?.[key];
    if (!Number.isFinite(value) || Math.abs(value) > 100_000 || (['width', 'height'].includes(key) && value < 0)) throw new TypeError('Invalid device menu anchor');
    anchor[key] = value;
  }
  const theme = { ...THEME_DEFAULTS };
  for (const key of ['panel', 'fg', 'dim', 'border', 'accent']) {
    const value = request.theme?.[key];
    if (typeof value === 'string' && value.length <= 180 && COLOR.test(value.trim())) theme[key] = value.trim();
  }
  const font = request.theme?.fontFamily;
  if (typeof font === 'string' && font.length <= 240 && /^[\p{L}\p{N}\s,"'_-]+$/u.test(font)) theme.fontFamily = font;
  return { items, anchor, theme };
}

function menuBounds(parent, anchor, contentHeight = 340) {
  const zoom = parent.webContents.getZoomFactor();
  const [nativeWidth, nativeHeight] = parent.getContentSize();
  const viewportWidth = nativeWidth / zoom, viewportHeight = nativeHeight / zoom;
  const pad = 8, gap = 7;
  const width = Math.max(1, Math.min(272, viewportWidth - pad * 2));
  const wanted = Math.min(Math.max(1, contentHeight), 340, Math.max(1, viewportHeight - pad * 2));
  const below = Math.max(0, viewportHeight - pad - anchor.y - anchor.height - gap);
  const above = Math.max(0, anchor.y - gap - pad);
  const up = below < wanted && above > below;
  const height = Math.max(1, Math.min(wanted, up ? above : below));
  const x = Math.max(0, Math.min(Math.max(pad, anchor.x), viewportWidth - pad - width));
  const y = Math.max(0, Math.min(up ? anchor.y - gap - height : anchor.y + anchor.height + gap, viewportHeight - pad - height));
  return { zoom, bounds: { x: Math.round(x * zoom), y: Math.round(y * zoom), width: Math.max(1, Math.round(width * zoom)), height: Math.max(1, Math.round(height * zoom)) } };
}

// A bounded native sibling, not a second music surface. It owns no player API,
// credentials or network access and exists only for the duration of one menu.
class FoliaDeviceMenu {
  constructor({ electron = require('electron') } = {}) { this.electron = electron; this.current = null; }
  get webContents() { return this.current?.view.webContents || null; }
  get view() { return this.current?.view || null; }
  async open(parent, request, { playerContents } = {}) {
    const normalized = normalizeRequest(request);
    this.close();
    if (!parent || parent.isDestroyed() || parent.webContents.isDestroyed()) return null;
    const { WebContentsView, ipcMain } = this.electron;
    const view = new WebContentsView({ webPreferences: {
      preload: path.join(__dirname, 'device-menu-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, partition: 'harbour-device-menu',
    } });
    view.setBackgroundColor('#00000000');
    view.setBorderRadius(12);
    const contents = view.webContents;
    const listeners = [];
    const bind = (target, name, listener) => { target.on(name, listener); listeners.push([target, name, listener]); };
    let resolve;
    const result = new Promise(done => { resolve = done; });
    const state = { parent, view, listeners, resolve, items: normalized.items, attached: false };
    this.current = state;
    const active = () => this.current === state && !parent.isDestroyed() && !contents.isDestroyed();
    const position = height => {
      if (!active()) return;
      const { zoom, bounds } = menuBounds(parent, normalized.anchor, height);
      contents.setZoomFactor(zoom);
      view.setBounds(bounds);
    };
    const dismiss = () => { if (this.current === state) this.close(); };
    const outside = (_event, input) => { if (input.type === 'mouseDown') dismiss(); };
    // Dashboard pointerdown already belongs to the shared select. Closing here
    // before its trigger click would race that handler and reopen the menu.
    if (playerContents && !playerContents.isDestroyed()) bind(playerContents, 'before-mouse-event', outside);
    for (const name of ['blur', 'minimize', 'hide', 'resize', 'close', 'closed']) bind(parent, name, dismiss);
    for (const name of ['zoom-changed', 'did-start-navigation', 'destroyed']) bind(parent.webContents, name, dismiss);
    bind(contents, 'render-process-gone', dismiss);
    bind(contents, 'destroyed', dismiss);
    bind(ipcMain, EVENT_CHANNEL, (event, message) => {
      if (!active() || event.sender !== contents || event.senderFrame !== contents.mainFrame || !message) return;
      if (message.type === 'size' && Number.isFinite(message.height)) { position(Math.max(1, Math.min(message.height, 10_000))); return; }
      if (message.type === 'dismiss') {
        if (['escape', 'tab', 'shift-tab'].includes(message.reason)) this.close({ dismiss: message.reason });
        else dismiss();
        return;
      }
      if (message.type !== 'choose' || typeof message.value !== 'string') return;
      const option = state.items.find(item => item.value === message.value && !item.disabled);
      if (option) this.close({ value: option.value });
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    bind(contents, 'will-navigate', event => event.preventDefault());
    position(68 + Math.max(1, normalized.items.length) * 52);
    void contents.loadFile(path.join(__dirname, 'device-menu.html')).then(() => {
      if (!active()) return;
      parent.contentView.addChildView(view);
      state.attached = true;
      contents.send(DATA_CHANNEL, normalized);
      contents.focus();
    }).catch(dismiss);
    return result;
  }
  close(result = null) {
    const state = this.current;
    if (!state) return;
    this.current = null;
    for (const [target, name, listener] of state.listeners) target.removeListener(name, listener);
    if (state.attached && !state.parent.isDestroyed()) state.parent.contentView.removeChildView(state.view);
    if (!state.view.webContents.isDestroyed()) state.view.webContents.close();
    // DOM element.focus() alone cannot transfer native focus from another
    // WebContents. Return it for a completed keyboard/selection interaction,
    // without focusing/showing the OS window or stealing an outside click.
    if (result && (typeof result.value === 'string' || ['escape', 'tab', 'shift-tab'].includes(result.dismiss))
      && !state.parent.isDestroyed() && !state.parent.webContents.isDestroyed()) state.parent.webContents.focus();
    state.resolve(result);
  }
}

module.exports = { FoliaDeviceMenu, normalizeRequest, menuBounds };
