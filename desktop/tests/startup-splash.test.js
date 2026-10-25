"use strict";
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const test = require("node:test");
const { StartupSplash, validTarget } = require("../companion/startup-splash");
const { parseDesktopLaunchIntent } = require("../companion/launch-intent");
const payload = { target: { x: 280, y: 130, width: 900, height: 620, radius: 22 },
  palette: { surface: "#fffdfc" } };
function fixture(options = {}) {
  const ipcMain = new EventEmitter(), calls = [], windows = [];
  class Window extends EventEmitter {
    constructor(config) {
      super(); this.config = config; this.destroyed = false; windows.push(this);
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: {}, isDestroyed: () => this.destroyed, getURL: () => "http://localhost:7788/",
        send: (channel, state) => calls.push({ channel, state: { ...state } }),
        setWindowOpenHandler: handler => { this.openHandler = handler; },
      });
    }
    removeMenu() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit("closed"); }
    showInactive() { calls.push("show-inactive"); }
    setParentWindow(parent) { this.parent = parent; }
    setBounds(bounds) { this.bounds = bounds; }
    getContentBounds() { return { x: -1400, y: 80, width: 1280, height: 820 }; }
    loadFile(file) { this.file = file; return options.loadError ? Promise.reject(new Error("fixture")) : Promise.resolve(); }
  }
  const splash = new StartupSplash({ BrowserWindow: Window, ipcMain,
    workArea: { x: -1920, y: 0, width: 1920, height: 1040 },
    onDismiss: () => calls.push("dismiss"), logger: { warn: () => calls.push("warning") }, ...options });
  splash.start();
  const win = windows[0], dashboard = new Window({});
  const event = sender => ({ sender, senderFrame: sender.mainFrame });
  return { splash, win, dashboard, windows, calls, ipcMain, event };
}

test("local theatre is sandboxed, credential-free and centered on the chosen monitor", t => {
  const f = fixture(); t.after(() => f.splash.dispose());
  assert.deepEqual([f.win.config.x,f.win.config.y,f.win.config.width,f.win.config.height], [-1600,90,1280,860]);
  assert.equal(f.win.config.alwaysOnTop, false);
  assert.equal(f.win.config.show, false);
  assert.equal(f.win.config.webPreferences.sandbox, true);
  assert.equal(f.win.config.webPreferences.nodeIntegration, false);
  assert.equal(f.win.config.webPreferences.contextIsolation, true);
  assert.equal(f.win.config.webPreferences.additionalArguments, undefined);
  assert.match(f.win.config.webPreferences.preload, /startup-preload\.js$/);
  assert.deepEqual(f.win.openHandler(), { action: "deny" });
  let prevented = 0;
  for (const name of ["will-navigate","will-attach-webview"]) f.win.webContents.emit(name,{ preventDefault:()=>prevented++ });
  assert.equal(prevented,2);
  f.splash.start(); assert.equal(f.windows.length,2);
});

test("late cold startup stays in animation after 8s and 60s; diagnostics remain actionable", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); t.after(() => f.splash.dispose()); f.win.emit("ready-to-show");
  t.mock.timers.tick(8000); assert.equal(f.splash.active,true); assert.equal(f.splash.finishing,undefined);
  t.mock.timers.tick(52000); assert.equal(f.splash.active,true); assert.equal(f.splash.state.slow,true);
  f.ipcMain.emit("harbour:startup-details", f.event(f.win.webContents));
  assert.equal(f.splash.active,false); assert.equal(f.calls.filter(x=>x==="dismiss").length,1);
});

test("skip/escape skips motion, not the connection; ready geometry then reveals once", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); t.after(() => f.splash.dispose()); f.win.emit("ready-to-show");
  f.splash.attachDashboard(f.dashboard,"http://localhost:7788/");
  const showCount = f.calls.filter(x=>x==="show-inactive").length;
  f.ipcMain.emit("harbour:startup-skip", f.event(f.win.webContents));
  assert.equal(f.splash.state.quiet,true); assert.equal(f.splash.active,true);
  assert.equal(f.calls.filter(x=>x==="show-inactive").length,showCount);
  f.ipcMain.emit("desktop:startup-ready", f.event(f.dashboard.webContents), payload);
  assert.equal(f.splash.finishing,true);
  assert.equal(f.calls.filter(x=>x==="show-inactive").length,showCount+1);
  t.mock.timers.tick(160); await f.splash.finishPromise;
  for (const channel of ["harbour:startup-skip","harbour:startup-details","desktop:startup-ready","desktop:startup-status"])
    assert.equal(f.ipcMain.listenerCount(channel),0);
});

test("ready before first paint waits for paint and a bounded scene; repeated signals cannot restart it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); t.after(() => f.splash.dispose());
  const done=f.splash.finish(payload); assert.equal(done,f.splash.finish(payload));
  t.mock.timers.tick(3000); assert.equal(f.splash.finishing,undefined);
  f.win.emit("ready-to-show"); t.mock.timers.tick(2399); assert.equal(f.splash.finishing,undefined);
  t.mock.timers.tick(1); assert.equal(f.splash.state.phase,"ready");
  f.splash.update({phase:"starting"}); assert.equal(f.splash.state.phase,"ready");
  t.mock.timers.tick(900); await done; assert.equal(f.splash.active,false);
});

test("loadURL success, wrong origin, other renderer, subframe and invalid geometry are not readiness", t => {
  const f=fixture(); t.after(()=>f.splash.dispose()); f.splash.attachDashboard(f.dashboard,"http://localhost:7788/");
  f.dashboard.webContents.emit("did-finish-load"); assert.equal(f.splash.readyPayload,undefined);
  for (const event of [f.event(f.win.webContents),{sender:f.dashboard.webContents,senderFrame:{}}])
    f.ipcMain.emit("desktop:startup-ready",event,payload);
  for (const url of ["http://evil.test/","http://localhost:7788/other","file:///backend-offline.html"]) {
    f.dashboard.webContents.getURL=()=>url;
    f.ipcMain.emit("desktop:startup-ready",f.event(f.dashboard.webContents),payload);
  }
  f.dashboard.webContents.getURL=()=>"http://localhost:7788/";
  for (const target of [{...payload.target,x:-1},{...payload.target,width:Infinity},{...payload.target,height:9999},{...payload.target,radius:1000}])
    f.ipcMain.emit("desktop:startup-ready",f.event(f.dashboard.webContents),{target});
  assert.equal(f.splash.readyPayload,undefined);
  assert.equal(validTarget(payload.target,f.dashboard.getContentBounds()),true);
  f.ipcMain.emit("desktop:startup-ready",f.event(f.dashboard.webContents),payload);
  assert.deepEqual(f.splash.readyPayload,payload);
});

test("status is limited and authenticated; a newer document invalidates an unpresented ready signal", t => {
  const f=fixture(); t.after(()=>f.splash.dispose()); f.splash.attachDashboard(f.dashboard,"http://localhost:7788/");
  const event=f.event(f.dashboard.webContents);
  f.ipcMain.emit("desktop:startup-status",event,{reason:"arbitrary secret"});
  assert.equal(f.splash.state.phase,"connecting");
  f.ipcMain.emit("desktop:startup-status",event,{reason:"auth"});
  assert.equal(f.splash.state.phase,"attention");
  f.ipcMain.emit("desktop:startup-ready",event,payload);
  f.dashboard.webContents.emit("did-start-navigation",{},"file:///backend-offline.html",false,true);
  assert.equal(f.splash.readyPayload,null);
  f.ipcMain.emit("desktop:startup-ready",event,payload);
  assert.deepEqual(f.splash.readyPayload,payload);
});

test("fake skip/details cannot reveal the Dashboard", t => {
  const f=fixture(); t.after(()=>f.splash.dispose());
  for (const channel of ["harbour:startup-skip","harbour:startup-details"]) {
    f.ipcMain.emit(channel,{sender:{},senderFrame:f.win.webContents.mainFrame});
    f.ipcMain.emit(channel,{sender:f.win.webContents,senderFrame:{}});
  }
  assert.equal(f.splash.state.quiet,false); assert.equal(f.splash.active,true);
});

test("saved Dashboard zoom maps CSS endpoints back to native DIP", t => {
  const f=fixture(); t.after(()=>f.splash.dispose()); f.splash.attachDashboard(f.dashboard,"http://localhost:7788/");
  f.dashboard.webContents.getZoomFactor=()=>1.25;
  const target={x:200,y:80,width:700,height:500,radius:20};
  f.ipcMain.emit("desktop:startup-ready",f.event(f.dashboard.webContents),{target});
  assert.deepEqual(f.splash.readyPayload.target,{x:250,y:100,width:875,height:625,radius:25});
});

test("a disconnect while the minimum scene plays withdraws readiness until a fresh snapshot", t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  const f=fixture(); t.after(()=>f.splash.dispose()); f.win.emit("ready-to-show");
  f.splash.attachDashboard(f.dashboard,"http://localhost:7788/");
  const event=f.event(f.dashboard.webContents);
  f.ipcMain.emit("desktop:startup-ready",event,payload);
  f.ipcMain.emit("desktop:startup-status",event,{reason:"network"});
  t.mock.timers.tick(3000); assert.equal(f.splash.finishing,undefined);
  f.ipcMain.emit("desktop:startup-ready",event,payload); assert.equal(f.splash.finishing,true);
});

test("reduced motion does not wait out an animated minimum", t => {
  const f=fixture(); t.after(()=>f.splash.dispose()); f.win.emit("ready-to-show");
  void f.splash.finish({...payload,reducedMotion:true});
  assert.equal(f.splash.finishing,true); assert.equal(f.splash.state.quiet,true);
});

test("load failure, renderer crash and native close dispose safely", async t => {
  for (const fault of ["load","crash","close"]) {
    const f=fixture({loadError:fault==="load"}); t.after(()=>f.splash.dispose());
    if (fault==="load") await new Promise(resolve=>setImmediate(resolve));
    if (fault==="crash") f.win.webContents.emit("render-process-gone");
    if (fault==="close") f.win.destroy();
    assert.equal(f.splash.active,false);
    assert.equal(f.calls.filter(x=>x==="dismiss").length,1);
  }
});

test("native construction failure is nonfatal",()=>{
  const splash=new StartupSplash({BrowserWindow:class{constructor(){throw new Error("fixture");}},
    ipcMain:new EventEmitter(),logger:{warn(){}}});
  assert.doesNotThrow(()=>splash.start()); assert.equal(splash.active,false);
});

const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
function mainFunction(name) {
  const source = main.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]+?\\n\\}`, "u"))?.[0];
  assert.ok(source, name); return source;
}

test("only an initial Dashboard launch creates a splash; pet shortcuts and already-open windows do not", () => {
  for (const flags of [[], ["--harbour-open-dashboard"], ["--harbour-show-pets"], ["--harbour-show-pet=elaina"]]) {
    let created = 0;
    const context = vm.createContext({ parseDesktopLaunchIntent, process: { argv: flags }, startupSplash: null, mainWindow: null,
      StartupSplash: class { constructor() { created++; } start() {} }, BrowserWindow: {}, ipcMain: {}, APP_ICON_PATH: "",
      screen: { getCursorScreenPoint: () => ({}), getDisplayNearestPoint: () => ({ workArea: {} }) }, console });
    const start = vm.runInContext(`(${mainFunction("startStartupSplash")})`, context);
    start(); start();
    assert.equal(created, flags[0]?.startsWith("--harbour-show-pet") ? 0 : 1);
    context.startupSplash = null; context.mainWindow = { isDestroyed: () => false };
    start(); assert.ok(created <= 1);
  }
});

test("Dashboard loads concurrently but never reveals an HTTP/offline page before the app handshake", async () => {
  for (const mode of ["ready", "offline", "throw", "closed", "quitting", "skip"]) {
    const calls = []; let resolveLoad, options, win;
    const load = new Promise(resolve => { resolveLoad = resolve; });
    const splash = { active: mode !== "skip", attachDashboard: () => {} };
    const context = vm.createContext({ startupSplash: splash, mainWindow: null, remoteBridge: null,
      closeGuard: { quitting: mode === "quitting", register() {} },
      cfg: { token: "fixture", url: "http://localhost:7788", petEnabled: false },
      APP_ICON_PATH: "", PET_CATALOG: {}, path, __dirname: "/fixture", encodeURIComponent,
      initCompanionRuntime() {}, startRemoteCompanionBridge() {}, removeWindowMenu() {}, conversationLink: {}, openDashboardLink: () => ({ action: 'deny' }),
      BrowserWindow: class extends EventEmitter {
        constructor(config) { super(); options = config; win = this; this.visible = config.show;
          this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} }); }
        isDestroyed() { return mode === "closed"; }
        isVisible() { return this.visible; }
        show() { this.visible = true; calls.push("show"); }
      },
      loadDashboard: async () => { calls.push("load"); await load; if (mode === "throw") throw new Error("fixture"); return mode === "ready"; },
    });
    const create = vm.runInContext(`(${mainFunction("createDashboardWindow")})`, context);
    const pending = create();
    assert.deepEqual(calls, ["load"], "do not await the animation before requesting Dashboard");
    assert.equal(options.show, mode === "skip");
    resolveLoad();
    if (mode === "throw") await assert.rejects(pending, /fixture/); else await pending;
    assert.equal(calls.includes("finish"), false);
    assert.equal(calls.includes("show"), false, "the theatre owns readiness, not loadURL completion");
    assert.equal(win, context.mainWindow);
  }
});

test("splash is excluded from editor-close prompts and disposed on quit; renderer assets are bundled and lightweight", () => {
  assert.match(main, /startupSplash\?\.win !== win\) closeGuard\.register/);
  assert.match(mainFunction("cleanupDesktop"), /startupSplash\?\.dispose\(\)/);
  assert.match(main, /if \(desktopBootstrapping\) return/);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  assert.ok(manifest.build.files.includes("companion/*.js"));
  assert.ok(manifest.build.files.includes("renderer/**/*"));
  const assets = ["startup.html", "startup.css", "startup.js"].map(name => fs.readFileSync(path.join(__dirname, "../renderer", name), "utf8"));
  assert.ok(assets.reduce((sum, asset) => sum + Buffer.byteLength(asset), 0) < 28_000);
  assert.match(assets[0], /connect-src 'none'/);
  assert.doesNotMatch(assets.join("\n"), /https?:\/\/|\bfetch\(|setInterval\(|requestAnimationFrame\(/);
  assert.match(assets[1], /prefers-reduced-motion: reduce/);
});

test("character cutouts are local, compact, versioned, and have reproducible provenance", () => {
  const dir = path.join(__dirname, "../renderer/assets/startup");
  const provenance = JSON.parse(fs.readFileSync(path.join(dir, "provenance.json"), "utf8"));
  const html = fs.readFileSync(path.join(__dirname, "../renderer/startup.html"), "utf8");
  assert.equal(provenance.sourceModel, "NAI Diffusion V5 Full");
  assert.equal(provenance.assets.length, 2);
  let total = 0;
  for (const asset of provenance.assets) {
    assert.match(asset.file, /^(elaina|aemeath)-v[1-9][0-9]*\.webp$/);
    assert.ok(html.includes(`src="assets/startup/${asset.file}"`), "render the inspected version from the provenance manifest");
    const bytes = fs.readFileSync(path.join(dir, asset.file));
    total += bytes.length;
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.toString("ascii", 8, 12), "WEBP");
    assert.equal(require("node:crypto").createHash("sha256").update(bytes).digest("hex"), asset.sha256);
    assert.equal(asset.width, 640); assert.equal(asset.height, 640);
    assert.equal(asset.alpha, true);
    assert.ok(asset.transparentMarginPixels >= 12, "complete hair/hat safety margin");
  }
  assert.ok(total < 500_000, "both decorations together stay below 500KB");
});
