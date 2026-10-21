const electron = require('electron');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const { fileURLToPath } = require('node:url');
const { createFoliaCrashReporting } = require('./crash-reporting');
const foliaWindows = new WeakSet();
const isFoliaWindow = win => foliaWindows.has(win);

// Host boundaries for the vendored Folia app; never expose Harbour's preload to Folia.
const SCHEMES = ['folia-cover', 'folia-transcode', 'folia-mod'].map(scheme => ({
  scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}));

function createFoliaHost({ root, dataDir, onQuit, onWindow, onWindowCreated, beforeNativeAction, isPlayerEmbedded = () => false, offline = false }) {
  const { app, BrowserWindow, WebContentsView, ipcMain, session } = electron;
  fs.mkdirSync(dataDir, { recursive: true });
  const events = new EventEmitter();
  const crashReporting = createFoliaCrashReporting(events);
  const windows = new Set();
  const views = new Map();
  const viewOwners = new WeakMap();
  const viewGeometry = new WeakMap();
  let retainedView = null;
  const handlers = new Set();
  const listeners = [];
  const screenListeners = [];
  const sessionListeners = [];
  const partition = session.fromPartition('persist:harbour-folia');
  let disposed = false;
  let themeSource = 'system';
  const localPage = url => {
    try { const file = path.resolve(fileURLToPath(url)); return file.startsWith(path.join(root, 'dist') + path.sep); } catch { return false; }
  };
  const owned = sender => localPage(sender.getURL()) && [...windows].some(w => !w.isDestroyed() && w.webContents === sender);
  const bind = (object, prop) => typeof object[prop] === 'function' ? object[prop].bind(object) : object[prop];
  const appFacade = new Proxy(events, { get(target, prop) {
    if (prop === 'getPath') return key => key === 'userData' || key === 'sessionData' ? dataDir : app.getPath(key);
    if (prop === 'getAppPath') return () => root;
    if (prop === 'getVersion') return () => require(path.join(root, 'package.json')).version;
    if (prop === 'isPackaged') return false;
    if (prop === 'whenReady') return () => Promise.resolve();
    if (prop === 'isReady' || prop === 'requestSingleInstanceLock') return () => true;
    if (prop === 'quit' || prop === 'exit') return () => { void onQuit(); };
    if (prop === 'relaunch') return () => { throw new Error('此功能需重建音乐窗口；不能重启 Harbour。'); };
    if (prop === 'setAppUserModelId' || prop === 'disableHardwareAcceleration' || prop === 'setName') return () => {};
    if (prop === 'commandLine') return { appendSwitch() {}, getSwitchValue: key => app.commandLine.getSwitchValue(key) };
    if (prop in target) return bind(target, prop);
    return bind(app, prop);
  }});

  // A native shell owns one movable WebContentsView from the outset. Adopting the
  // BrowserWindow's built-in webContents later is not supported by Electron.
  const HostedWindow = new Proxy(BrowserWindow, {
    construct(_target, [options = {}]) {
      const webPreferences = { ...options.webPreferences, session: partition, sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
        additionalArguments: [...(options.webPreferences?.additionalArguments || []), '--harbour-folia-host'] };
      const win = new BrowserWindow({ ...options, title: options.title || 'Folia', show: false, webPreferences: { session: partition, additionalArguments: ['--harbour-folia-host'] } });
      foliaWindows.add(win);
      const blank = win.webContents;
      const reuse = retainedView;
      retainedView = null;
      const view = reuse?.view || new WebContentsView({ webPreferences });
      crashReporting.observe(view.webContents);
      viewOwners.set(view, win);
      // Child views default to opaque white even inside a transparent window.
      view.setBackgroundColor('#00000000');
      // The shell's blank webContents no longer receives document title updates.
      // Keep the movable view's title, without overwriting Remote's explicit title.
      if (!reuse) {
        view.webContents.on('page-title-updated', (_event, title) => {
          const owner = viewOwners.get(view);
          if (!options.title && owner && !owner.isDestroyed()) owner.setTitle(title || 'Folia');
        });
        view.webContents.on('preload-error', (_event, _file, error) => console.error('[folia] preload:', error));
        view.webContents.on('did-fail-load', (_event, code, reason) => console.error('[folia] load:', code, reason));
        view.webContents.on('console-message', details => {
          if (details.level === 'error') console.error('[folia renderer]', details.message);
        });
      }
      Object.defineProperty(win, 'webContents', { value: view.webContents });
      // A docked player stays in the dashboard. Only its unused native shell
      // changes; a standalone player's view moves to the replacement shell.
      if (!reuse?.embedded) {
        if (reuse) reuse.previous.contentView.removeChildView(view);
        win.contentView.addChildView(view);
      }
      windows.add(win);
      views.set(win, view);
      const ready = () => {
        if (offline) console.log('[folia test] loaded', view.webContents.getURL());
        if (!win.isDestroyed()) win.emit('ready-to-show');
        if (!win.isDestroyed()) onWindow?.(win, view);
      };
      let retainedNavigation = !!reuse;
      const navigate = (method, args) => {
        if (!retainedNavigation) return view.webContents[method](...args);
        retainedNavigation = false;
        // loadAppEntry constructs a shell but must not reload the live player.
        setImmediate(ready);
        return Promise.resolve();
      };
      win.loadFile = (...args) => navigate('loadFile', args);
      win.loadURL = (...args) => navigate('loadURL', args);
      const resize = () => {
        if (win.isDestroyed() || !win.contentView.children.includes(view)) return;
        const [width, height] = win.getContentSize();
        view.setBounds({ x: 0, y: 0, width, height });
      };
      win.on('resize', resize);
      resize();
      if (!reuse) view.webContents.once('did-finish-load', ready);
      view.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) void electron.shell.openExternal(url);
        return { action: 'deny' };
      });
      if (!reuse) view.webContents.on('will-navigate', (event, url) => {
        if (localPage(url)) return;
        event.preventDefault();
        if (/^https?:\/\//i.test(url)) void electron.shell.openExternal(url);
      });
      win.on('closed', () => {
        windows.delete(win); views.delete(win);
        if (viewOwners.get(view) === win && !view.webContents.isDestroyed()) view.webContents.close();
        if (!blank.isDestroyed()) blank.close();
      });
      // The renderer can announce its bridge before did-finish-load on macOS.
      // Install lifecycle guards now, before any caller can show/hide the shell.
      onWindowCreated?.(win);
      return win;
    },
    get(target, prop) {
      if (prop === 'getAllWindows') return () => [...windows].filter(w => !w.isDestroyed());
      if (prop === 'fromWebContents') return contents => [...windows].find(w => !w.isDestroyed() && w.webContents === contents) || null;
      return bind(target, prop);
    },
  });
  const ipc = {
    handle(channel, handler) {
      handlers.add(channel);
      ipcMain.handle(channel, (event, ...args) => {
        if (!owned(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid Folia sender');
        beforeNativeAction?.(channel, args, event.sender);
        return handler(event, ...args);
      });
    },
    on(channel, handler) {
      const listener = (event, ...args) => { if (owned(event.sender) && event.senderFrame === event.sender.mainFrame) handler(event, ...args); };
      listeners.push([channel, listener]); ipcMain.on(channel, listener);
    },
    removeHandler(channel) { ipcMain.removeHandler(channel); handlers.delete(channel); },
  };
  const screenFacade = new Proxy(electron.screen, { get(target, prop) {
    if (prop === 'on') return (event, listener) => { screenListeners.push([event, listener]); target.on(event, listener); };
    return bind(target, prop);
  }});
  const nativeTheme = new Proxy(electron.nativeTheme, {
    get(target, prop) { if (prop === 'themeSource') return themeSource; return bind(target, prop); },
    set(_target, prop, value) { if (prop === 'themeSource') themeSource = value; return true; },
  });
  return {
    dataDir, offline, windows, views, owned, ipc, startHidden: true, isPlayerEmbedded,
    installCrashHandlers: options => crashReporting.install(options),
    recreateWindowWithView(previous, createNext) {
      const view = views.get(previous);
      if (!view || view.webContents.isDestroyed()) throw new Error('Folia player view is unavailable');
      const embedded = !previous.contentView.children.includes(view);
      const actual = previous.getContentBounds(), saved = viewGeometry.get(view);
      const unchanged = saved && ['x', 'y', 'width', 'height'].every(key => saved.actual[key] === actual[key]);
      const target = unchanged ? saved.target : actual;
      retainedView = { previous, view, embedded };
      try {
        const next = createNext();
        // Native frame thickness changes with transparency. Preserve content
        // coordinates rather than copying the old outer window rectangle.
        // Fractional desktop scaling can round setContentBounds by one DIP.
        // Reuse the requested rectangle until the user actually moves/resizes,
        // instead of accumulating that rounding on every transparency toggle.
        next.setContentBounds(target);
        viewGeometry.set(view, { target, actual: next.getContentBounds() });
        return next;
      } catch (error) {
        // Construction can fail after adopting the view. Restore the old owner
        // before destroying the partial shell so cleanup cannot destroy audio.
        const failed = viewOwners.get(view);
        viewOwners.set(view, previous);
        if (failed && failed !== previous && !failed.isDestroyed()) {
          if (failed.contentView.children.includes(view)) failed.contentView.removeChildView(view);
          if (!embedded) {
            previous.contentView.addChildView(view);
            const [width, height] = previous.getContentSize();
            view.setBounds({ x: 0, y: 0, width, height });
          }
          failed.destroy();
        }
        throw error;
      } finally { retainedView = null; }
    },
    getPlayerCaptureSource(sender) {
      if (!owned(sender)) throw new Error('Invalid Folia capture sender');
      // Capture this renderer, not a similarly named OS window. The short-lived
      // token is bound to the same requester and does not expose Harbour/Remote.
      return { id: sender.getMediaSourceId(sender), name: 'Folia', mediaSource: 'tab' };
    },
    electron: { ...electron, app: appFacade, BrowserWindow: HostedWindow, ipcMain: ipc,
      screen: screenFacade, nativeTheme,
      session: { ...session, defaultSession: new Proxy(partition, { get(target, prop) {
        if (prop === 'on') return (name, listener) => { sessionListeners.push([name, listener]); target.on(name, listener); };
        return bind(target, prop);
      } }) },
      protocol: new Proxy(partition.protocol, { get(target, prop) {
        return prop === 'registerSchemesAsPrivileged' ? () => {} : bind(target, prop);
      }}),
    },
    dispose() {
      if (disposed) return; disposed = true;
      crashReporting.dispose();
      for (const win of [...windows]) if (!win.isDestroyed()) win.destroy();
      for (const channel of handlers) ipcMain.removeHandler(channel);
      for (const [channel, listener] of listeners) ipcMain.off(channel, listener);
      for (const [event, listener] of screenListeners) electron.screen.off(event, listener);
      for (const [event, listener] of sessionListeners) partition.off(event, listener);
      for (const scheme of SCHEMES) {
        try { partition.protocol.unhandle(scheme.scheme); } catch { /* Optional modules may never register their protocol. */ }
      }
      events.removeAllListeners();
    },
  };
}

module.exports = { createFoliaHost, isFoliaWindow, SCHEMES };
