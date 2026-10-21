"use strict";

const path = require("node:path");
const { readStartupAppearance } = require("./startup-appearance");

// Local, credential-free theatre. Loading an offline page is NOT readiness:
// only the authenticated Dashboard's rendered-chat + WS handshake is.
class StartupSplash {
  constructor({ BrowserWindow, ipcMain, workArea, icon, onDismiss = () => {},
    minSceneMs = 2400, attentionMs = 15000, exitMs = 900, logger = console }) {
    Object.assign(this, { BrowserWindow, ipcMain, workArea, icon, onDismiss, minSceneMs, attentionMs, exitMs, logger });
    this.win = null;
    this.active = false;
    this.presented = false;
    this.state = { phase: "connecting", slow: false, quiet: false, appearance: readStartupAppearance() };
    this.onSkip = event => {
      if (!this.isSplashSender(event)) return;
      this.state.quiet = true;
      this.publish();
      // Skip choreography, never skip readiness and expose a connection page.
      if (this.readyPayload) this.beginExit();
    };
    this.onDetails = event => { if (this.isSplashSender(event)) this.dispose(); };
    this.onReady = (event, payload) => {
      if (!this.isDashboardSender(event)) return;
      // CSS pixels differ from native DIP when the Dashboard has a saved zoom.
      const zoom = this.dashboard.webContents.getZoomFactor?.() || 1;
      const target = Object.fromEntries(["x", "y", "width", "height", "radius"].map(key => [key, payload?.target?.[key] * zoom]));
      if (!validTarget(target, this.dashboard.getContentBounds())) return;
      void this.finish({ ...payload, target });
    };
    this.onStatus = (event, payload) => {
      if (!this.isDashboardSender(event) || !["auth", "data", "network"].includes(payload?.reason)) return;
      if (!this.finishing) this.clearReadiness();
      this.update({ phase: "attention", reason: payload.reason, slow: true });
    };
  }

  isSplashSender(event) {
    return this.win && !this.win.isDestroyed() && event.sender === this.win.webContents
      && event.senderFrame === event.sender.mainFrame;
  }

  isDashboardSender(event) {
    if (!this.active || !this.dashboard || this.dashboard.isDestroyed()
      || event.sender !== this.dashboard.webContents || event.senderFrame !== event.sender.mainFrame) return false;
    try {
      const actual = new URL(event.sender.getURL());
      return actual.origin === this.dashboardOrigin && actual.pathname === this.dashboardPath;
    } catch { return false; }
  }

  start() {
    if (this.started) return;
    this.started = true;
    const area = this.workArea || { x: 0, y: 0, width: 1280, height: 860 };
    const width = Math.min(1280, area.width), height = Math.min(860, area.height);
    this.bounds = { width, height, x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2) };
    this.active = true;
    try {
      const win = this.win = new this.BrowserWindow({
        ...this.bounds, show: false, frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: true,
        resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
        skipTaskbar: true, alwaysOnTop: false, title: "Harbour · 今天也一起", icon: this.icon,
        webPreferences: { preload: path.join(__dirname, "startup-preload.js"),
          contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true },
      });
      win.removeMenu();
      this.ipcMain.on("harbour:startup-skip", this.onSkip);
      this.ipcMain.on("harbour:startup-details", this.onDetails);
      this.ipcMain.on("desktop:startup-ready", this.onReady);
      this.ipcMain.on("desktop:startup-status", this.onStatus);
      win.on("closed", () => this.dispose());
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", event => event.preventDefault());
      win.webContents.on("will-attach-webview", event => event.preventDefault());
      win.webContents.on("render-process-gone", () => this.dispose());
      win.webContents.on("did-finish-load", () => this.publish());
      win.once("ready-to-show", () => {
        if (!this.active || win.isDestroyed()) return;
        this.presented = true;
        win.showInactive();
        this.sceneTimer = setTimeout(() => { this.sceneComplete = true; if (this.readyPayload) this.beginExit(); }, this.minSceneMs);
        if (this.readyPayload && this.state.quiet) this.beginExit();
      });
      // A deadline must not masquerade as successful startup or kill the service.
      this.attentionTimer = setTimeout(() => this.update({ slow: true }), this.attentionMs);
      void win.loadFile(path.join(__dirname, "../renderer/startup.html")).catch(error => {
        this.logger.warn("[harbour-desktop] 开屏不可用，继续启动", error?.message || error);
        this.dispose();
      });
    } catch (error) {
      this.logger.warn("[harbour-desktop] 开屏不可用，继续启动", error?.message || error);
      this.dispose();
    }
  }

  attachDashboard(win, url) {
    if (!this.active) return;
    this.dashboard = win;
    const target = new URL(url);
    this.dashboardOrigin = target.origin;
    this.dashboardPath = target.pathname;
    // A child stays above its own Dashboard, not every other application.
    try {
      this.win.setParentWindow(win);
      this.win.setBounds(win.getContentBounds());
    } catch (error) {
      this.logger.warn("[harbour-desktop] 开屏窗口无法附着，继续启动", error?.message || error);
      this.dispose();
      return;
    }
    this.onNavigation = (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace && !this.finishing) {
        this.clearReadiness();
      }
    };
    win.webContents.on("did-start-navigation", this.onNavigation);
  }

  update(patch) {
    if (!this.active || this.finishing) return;
    this.state = { ...this.state, ...patch };
    this.publish();
  }

  clearReadiness() {
    this.readyPayload = null;
    this.finishPromise = null;
    this.resolveFinish?.();
    this.resolveFinish = null;
  }

  publish() {
    if (!this.win || this.win.isDestroyed() || this.win.webContents.isDestroyed()) return;
    try { this.win.webContents.send("harbour:startup-state", this.state); } catch { /* optional view */ }
  }

  finish(payload) {
    if (!this.active) return Promise.resolve();
    if (this.finishPromise) return this.finishPromise;
    this.readyPayload = payload;
    if (payload?.reducedMotion === true) this.state.quiet = true;
    this.finishPromise = new Promise(resolve => { this.resolveFinish = resolve; });
    if (this.presented && (this.sceneComplete || this.state.quiet)) this.beginExit();
    return this.finishPromise;
  }

  beginExit() {
    if (!this.active || this.finishing || !this.readyPayload) return;
    this.finishing = true;
    clearTimeout(this.sceneTimer);
    clearTimeout(this.attentionTimer);
    if (this.dashboard && !this.dashboard.isDestroyed()) {
      this.win.setBounds(this.dashboard.getContentBounds());
      this.dashboard.webContents.send("desktop:startup-entered");
      this.dashboard.showInactive();
    }
    this.state = { ...this.state, phase: "ready", target: this.readyPayload.target,
      palette: safePalette(this.readyPayload.palette), quiet: this.state.quiet || this.readyPayload.reducedMotion === true };
    this.publish();
    this.exitTimer = setTimeout(() => this.dispose(), this.state.quiet ? 160 : this.exitMs);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    for (const timer of [this.attentionTimer, this.sceneTimer, this.exitTimer]) clearTimeout(timer);
    this.ipcMain.removeListener("harbour:startup-skip", this.onSkip);
    this.ipcMain.removeListener("harbour:startup-details", this.onDetails);
    this.ipcMain.removeListener("desktop:startup-ready", this.onReady);
    this.ipcMain.removeListener("desktop:startup-status", this.onStatus);
    if (this.onNavigation) this.dashboard?.webContents?.removeListener("did-start-navigation", this.onNavigation);
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) win.destroy();
    this.resolveFinish?.();
    this.resolveFinish = null;
    this.onDismiss();
  }
}

function validTarget(rect, viewport) {
  return rect && ["x", "y", "width", "height", "radius"].every(key => Number.isFinite(rect[key]))
    && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 && rect.radius >= 0 && rect.radius <= 80
    && rect.x + rect.width <= viewport.width + 2 && rect.y + rect.height <= viewport.height + 2;
}
function safePalette(palette) {
  const result = {};
  for (const key of ["background", "surface", "border"]) {
    if (typeof palette?.[key] === "string" && /^(#[\da-f]{3,8}|rgba?\([\d.,%\s]+\))$/i.test(palette[key])) result[key] = palette[key];
  }
  return result;
}

module.exports = { StartupSplash, validTarget };
