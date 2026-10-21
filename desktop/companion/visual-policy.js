"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Read one OS enum, not process names, screenshots or a spawned shell. Loaded only
// on Windows, when an unfocused visible Harbour surface actually needs detection.
function windowsPresentationProbe() {
  const koffi = require("koffi");
  const shell = koffi.load("shell32.dll");
  const query = shell.func("int __stdcall SHQueryUserNotificationState(_Out_ uint32_t *state)");
  return () => {
    const state = [0];
    if (query(state) !== 0) throw new Error("Windows presentation state unavailable");
    return [2, 3, 4].includes(state[0]);
  };
}

class VisualPolicy {
  constructor({ platform = process.platform, probeFactory = windowsPresentationProbe,
    onChange = () => {}, powerMonitor, file, logger = console } = {}) {
    Object.assign(this, { platform, probeFactory, onChange, powerMonitor, file, logger });
    this.windows = new Map(); this.mode = "auto"; this.quiet = false; this.locked = false;
    this.disposed = false; this.listeners = []; this.probeUnavailable = false;
    try { const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (["auto", "quiet", "normal"].includes(saved.mode)) this.mode = saved.mode;
    } catch { /* Optional device-local preference. */ }
  }
  start() {
    if (this.started || this.disposed) return;
    this.started = true;
    for (const [event, field, value] of [["lock-screen", "screenLocked", true], ["suspend", "suspended", true], ["unlock-screen", "screenLocked", false], ["resume", "suspended", false]]) {
      const fn = () => { this[field] = value; this.locked = !!(this.screenLocked || this.suspended); this.refresh(); };
      this.powerMonitor?.on(event, fn); this.listeners.push([event, fn]);
    }
    this.refresh();
  }
  setMode(mode) {
    if (!["auto", "quiet", "normal"].includes(mode)) throw new Error("Unknown visual policy");
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + ".tmp", JSON.stringify({ mode }), { mode: 0o600 });
      fs.renameSync(this.file + ".tmp", this.file);
    }
    this.mode = mode; this.refresh();
  }
  visible(win) { return !win.isDestroyed() && win.isVisible() && !win.isMinimized(); }
  snapshot(win) {
    return { paused: this.locked || this.quiet || !this.visible(win), mode: this.mode,
      reason: this.locked ? "locked" : this.quiet ? "presentation" : !this.visible(win) ? "hidden" : "active" };
  }
  register(win) {
    if (this.disposed || win.isDestroyed() || this.windows.has(win)) return;
    const row = { listeners: [], key: "" }; this.windows.set(win, row);
    for (const event of ["show", "hide", "minimize", "restore", "focus", "blur"]) {
      const fn = () => this.refresh(); win.on(event, fn); row.listeners.push([event, fn]);
    }
    row.loaded = () => { row.key = ""; this.publish(win, row); };
    win.webContents.on("did-finish-load", row.loaded);
    win.once("closed", () => { this.windows.delete(win); this.refresh(); });
    this.refresh();
  }
  forSender(event) {
    for (const win of this.windows.keys()) {
      if (!win.isDestroyed() && event.sender === win.webContents && event.senderFrame === event.sender.mainFrame) return this.snapshot(win);
    }
    throw new Error("Unknown visual policy surface");
  }
  publish(win, row) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    const state = this.snapshot(win), key = JSON.stringify(state);
    if (row.key === key) return;
    row.key = key; win.webContents.send("desktop:visual-policy", state);
  }
  refresh() {
    if (this.disposed) return;
    clearTimeout(this.timer); this.timer = null;
    const visible = [...this.windows.keys()].filter(win => this.visible(win));
    const focused = visible.some(win => win.isFocused());
    let quiet = this.mode === "quiet";
    const detect = this.mode === "auto" && this.platform === "win32" && !this.locked && visible.length && !focused && !this.probeUnavailable;
    if (detect) {
      try { this.probe ||= this.probeFactory(); quiet = this.probe() === true; }
      catch (error) {
        this.probeUnavailable = true; // No failure/restart loop; manual mode still works.
        this.logger.warn("[harbour-desktop] 自动全屏避让不可用，仍可在托盘手动开启：", error.message);
      }
    }
    const changed = quiet !== this.quiet; this.quiet = quiet;
    for (const [win, row] of this.windows) this.publish(win, row);
    this.onChange({ quiet: quiet || this.locked, mode: this.mode, changed });
    if (detect && !this.probeUnavailable) {
      this.timer = setTimeout(() => this.refresh(), 2000); this.timer.unref?.();
    }
  }
  dispose() {
    this.disposed = true; clearTimeout(this.timer);
    for (const [event, fn] of this.listeners) this.powerMonitor?.removeListener(event, fn);
    for (const [win, row] of this.windows) if (!win.isDestroyed()) {
      for (const [event, fn] of row.listeners) win.removeListener(event, fn);
      win.webContents.removeListener("did-finish-load", row.loaded);
    }
    this.windows.clear();
  }
}

module.exports = { VisualPolicy, windowsPresentationProbe };
