"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { wireManagedServiceRestart } = require("../companion/service-actions");
const { parseDesktopLaunchIntent } = require("../companion/launch-intent");
const {
  inspectDependencies,
  isLoopbackUrl,
  launcherRuntime,
  runElectronInstaller,
} = require("../../scripts/desktop-launch");

test("fresh-clone dependency inspection covers runtime and development dependencies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-desktop-startup-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      dependencies: { alpha: "1.0.0" },
      devDependencies: { beta: "1.0.0" },
    }));
    fs.mkdirSync(path.join(root, "node_modules", "alpha"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "alpha", "package.json"), "{}");
    assert.deepEqual(inspectDependencies(root).missing, ["beta"]);

    fs.mkdirSync(path.join(root, "node_modules", "beta"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "beta", "package.json"), "{}");
    assert.equal(inspectDependencies(root).ready, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher skips backend dependencies for remote mode and prepares them for local mode", () => {
  assert.deepEqual(launcherRuntime({
    HARBOUR_URL: "https://harbour.example.test",
    HARBOUR_CONFIG: path.join(os.tmpdir(), "missing-harbour-config.json"),
  }), { url: "https://harbour.example.test", spawnLocal: false });
  assert.deepEqual(launcherRuntime({
    HARBOUR_URL: "http://localhost:7788",
    HARBOUR_SPAWN: "1",
    HARBOUR_CONFIG: path.join(os.tmpdir(), "missing-harbour-config.json"),
  }), { url: "http://localhost:7788", spawnLocal: true });
  assert.equal(launcherRuntime({
    HARBOUR_URL: "http://localhost:7788",
    HARBOUR_SPAWN: "0",
    HARBOUR_CONFIG: path.join(os.tmpdir(), "missing-harbour-config.json"),
  }).spawnLocal, false);
});

test("Electron inspection is read-only and rejects binaries from another platform", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-electron-check-"));
  try {
    const electronRoot = path.join(root, "node_modules", "electron");
    const marker = path.join(root, "unexpected-package-execution");
    const executable = path.join(electronRoot, "dist", "Electron.app", "Contents", "MacOS", "Electron");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ devDependencies: { electron: "1.0.0" } }));
    fs.writeFileSync(path.join(electronRoot, "package.json"), JSON.stringify({ main: "index.js" }));
    fs.writeFileSync(path.join(electronRoot, "index.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "download attempted"); throw new Error("must not execute");`);
    const options = { requireElectronBinary: true, platform: "darwin", env: {} };
    assert.deepEqual(inspectDependencies(root, options).missing, ["electron (binary)"]);
    assert.equal(fs.existsSync(marker), false, "checking a missing binary must not execute Electron's downloader");

    fs.writeFileSync(path.join(electronRoot, "path.txt"), "Electron.app/Contents/MacOS/Electron");
    fs.writeFileSync(executable, "fixture executable", { mode: 0o755 });
    assert.equal(inspectDependencies(root, options).electronBinaryReady, true);
    if (process.platform !== "win32") {
      fs.chmodSync(executable, 0o644);
      assert.equal(inspectDependencies(root, options).ready, false, "Mac requires an executable file, not just an existing path");
      fs.chmodSync(executable, 0o755);
    }
    assert.equal(inspectDependencies(root, { ...options, platform: "win32" }).ready, false);
    fs.writeFileSync(path.join(electronRoot, "path.txt"), "electron.exe");
    fs.writeFileSync(path.join(electronRoot, "dist", "electron.exe"), "fixture executable");
    assert.equal(inspectDependencies(root, options).ready, false, "a Windows binary must not satisfy a Mac checkout");
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Electron override works without path.txt and honors it when present", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-electron-override-"));
  try {
    const electronRoot = path.join(root, "node_modules", "electron");
    const override = path.join(root, "custom-dist");
    fs.mkdirSync(electronRoot, { recursive: true });
    fs.mkdirSync(override);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ devDependencies: { electron: "1.0.0" } }));
    fs.writeFileSync(path.join(electronRoot, "package.json"), "{}");
    const options = { requireElectronBinary: true, platform: "darwin", env: { ELECTRON_OVERRIDE_DIST_PATH: override } };
    assert.equal(inspectDependencies(root, options).ready, false);
    fs.writeFileSync(path.join(override, "electron"), "fixture executable", { mode: 0o755 });
    for (const platform of ["darwin", "win32", "linux"]) {
      assert.equal(inspectDependencies(root, { ...options, platform }).ready, true, platform);
    }
    assert.equal(fs.existsSync(path.join(electronRoot, "path.txt")), false, "inspection must not create path.txt");
    assert.equal(inspectDependencies(root, { ...options, env: {} }).ready, false);

    fs.writeFileSync(path.join(electronRoot, "path.txt"), "Electron.app/Contents/MacOS/Electron");
    assert.equal(inspectDependencies(root, options).ready, false, "path.txt must override the fallback name");
    const macExecutable = path.join(override, "Electron.app", "Contents", "MacOS", "Electron");
    fs.mkdirSync(path.dirname(macExecutable), { recursive: true });
    fs.writeFileSync(macExecutable, "fixture executable", { mode: 0o755 });
    assert.equal(inspectDependencies(root, options).ready, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicit Electron preparation works without a package postinstall", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-electron-lazy-install-"));
  try {
    const electronRoot = path.join(root, "node_modules", "electron");
    const expectedPath = process.platform === "win32" ? "electron.exe"
      : process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron";
    fs.mkdirSync(electronRoot, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ devDependencies: { electron: "43.3.0" } }));
    fs.writeFileSync(path.join(electronRoot, "package.json"), JSON.stringify({
      name: "electron", version: "43.3.0", bin: { "install-electron": "install.js" },
    }));
    // Like Electron 43, this fixture has an explicit installer but no lifecycle scripts.
    // Its installer writes only fixture files, never downloads or launches Electron.
    fs.writeFileSync(path.join(electronRoot, "install.js"), `
      const fs = require("node:fs"), path = require("node:path");
      const relative = ${JSON.stringify(expectedPath)};
      const executable = path.join(__dirname, "dist", relative);
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      fs.writeFileSync(executable, "fixture executable", { mode: 0o755 });
      fs.writeFileSync(path.join(__dirname, "path.txt"), relative);
    `);
    const options = { requireElectronBinary: true, env: {} };
    assert.deepEqual(inspectDependencies(root, options).missing, ["electron (binary)"]);
    const prepared = runElectronInstaller(root, { stdio: "pipe", encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr || prepared.error?.message);
    assert.equal(inspectDependencies(root, options).ready, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher recognizes IPv6 loopback and keeps external hosts remote", () => {
  for (const url of ["http://localhost:7788", "http://127.0.0.1:7788", "http://[::1]:7788"]) {
    assert.equal(isLoopbackUrl(url), true, url);
  }
  for (const url of ["https://harbour.example.test", "http://localhost.example.test", "invalid"]) {
    assert.equal(isLoopbackUrl(url), false, url);
  }
  const main = fs.readFileSync(path.resolve(__dirname, "..", "main.js"), "utf8");
  const functionSource = main.match(/function isLoopbackUrl\(value\) \{[\s\S]+?\n\}/u)?.[0];
  assert.ok(functionSource, "Electron main must retain loopback detection");
  const mainIsLoopback = require("node:vm").runInNewContext(`(${functionSource})`, { URL });
  assert.equal(mainIsLoopback("http://[::1]:7788"), true);
  assert.equal(mainIsLoopback("https://harbour.example.test"), false);
});

test("launcher isolates public configuration and honors portable overrides", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-desktop-config-"));
  try {
    const appData = path.join(root, "roaming");
    const portable = path.join(root, "portable");
    fs.mkdirSync(path.join(appData, "Harbour"), { recursive: true });
    fs.mkdirSync(portable);
    fs.writeFileSync(path.join(appData, "Harbour", "config.json"), JSON.stringify({ url: "https://legacy.example.test", spawn: false }));
    const env = { APPDATA: appData, HARBOUR_DATA_HOME: path.join(root, "local") };
    assert.deepEqual(launcherRuntime(env), { url: "http://localhost:7799", spawnLocal: true });
    fs.mkdirSync(path.join(appData, "HarbourPublic"), { recursive: true });
    fs.writeFileSync(path.join(appData, "HarbourPublic", "config.json"), JSON.stringify({ url: "https://public.example.test", spawn: false }));
    assert.deepEqual(launcherRuntime(env), { url: "https://public.example.test", spawnLocal: false });
    fs.writeFileSync(path.join(portable, "config.json"), JSON.stringify({ url: "https://portable.example.test", spawn: false }));
    assert.deepEqual(launcherRuntime({ ...env, PORTABLE_EXECUTABLE_DIR: portable }),
      { url: "https://portable.example.test", spawnLocal: false });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("source and packaged startup acquire Live2D only when a pet is requested", () => {
  const desktopRoot = path.resolve(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
  assert.equal(manifest.scripts.start, "npm run build:companion && electron .");
  assert.ok(manifest.build.files.includes("scripts/install-live2d-pack.js"));
  assert.ok(manifest.build.files.includes("scripts/ensure-live2d-pack.js"));

  const main = fs.readFileSync(path.join(desktopRoot, "main.js"), "utf8");
  assert.match(mainFunction("createPetWindow"), /void startLive2dBootstrap\(\)/u);
  assert.doesNotMatch(mainFunction("bootstrap"), /startLive2dBootstrap/u);
  assert.match(main, /continue using pixel companion|继续使用像素桌宠/u);
  assert.match(main, /protocol === "https:" \? https : http/u);
});

function mainFunction(name) {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "main.js"), "utf8");
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]+?\\n\\}`, "u"));
  assert.ok(match, `main process function ${name} is available`);
  return match[0];
}

function desktopLaunchFixture() {
  const calls = [];
  const context = vm.createContext({
    parseDesktopLaunchIntent,
    process: { argv: ["Harbour.exe"] },
    // Saved/enabled models must remain available without auto-opening them.
    cfg: { petEnabled: true, pets: [{ id: "elaina" }, { id: "aemeath" }] },
    createDashboardWindow: async () => calls.push("dashboard"),
    createPetWindow: async (id) => calls.push(`pet:${id}`),
  });
  vm.runInContext(`${mainFunction("createConfiguredPetWindows")}\n${mainFunction("handleDesktopLaunch")}`, context);
  return { calls, launch: context.handleDesktopLaunch };
}

test("ordinary source and packaged launches leave Live2D closed even with configured pets", async () => {
  for (const argv of [
    undefined,
    ["Harbour.exe"],
    ["electron", "D:\\Harbour App\\desktop"],
    ["Harbour.exe", "--harbour-open-dashboard"],
  ]) {
    const { calls, launch } = desktopLaunchFixture();
    await launch(argv);
    assert.deepEqual(calls, ["dashboard"]);
  }
});

test("explicit pet launches remain available without opening the Dashboard", async () => {
  const { calls, launch } = desktopLaunchFixture();
  await launch(["Harbour.exe", "--harbour-show-pet=elaina"]);
  await launch(["Harbour.exe", "--harbour-show-pet=aemeath"]);
  await launch(["Harbour.exe", "--harbour-show-pets"]);
  assert.deepEqual(calls, ["pet:elaina", "pet:aemeath", "pet:elaina", "pet:aemeath"]);
});

test("ordinary reactivation does not reopen pets after they were manually requested", async () => {
  const { calls, launch } = desktopLaunchFixture();
  await launch();
  await launch(["Harbour.exe", "--harbour-show-pets"]);
  calls.length = 0;
  await launch();
  await launch(["Harbour.exe", "--harbour-open-dashboard"]);
  assert.deepEqual(calls, ["dashboard", "dashboard"]);
});

test("bootstrap establishes local device identity before its first backend health await", async () => {
  const calls = [];
  let resolveHealth;
  const health = new Promise(resolve => { resolveHealth = resolve; });
  const bootstrap = vm.runInNewContext(`(${mainFunction("bootstrap")})`, {
    visualPolicy: { start() {} },
    startStartupSplash() {}, startupSplash: null,
    initCompanionRuntime: () => calls.push("runtime"), registerCharacterProtocol() {},
    startRemoteCompanionBridge: () => calls.push("identity"),
    resolveBackendRoot: () => "/fixture", cfg: { spawn: true, url: "http://localhost:7788" },
    waitForHealth: () => { calls.push("health"); return health; },
    createTray() {}, repairWindowsShortcutIdentity() {}, registerWindowsUserTasks() {},
    handleDesktopLaunch: async () => calls.push("launch"), process: { argv: [] },
    orbController: () => ({ start: async () => calls.push("orb-start") }), globalShortcut: { register: () => true },
  });
  const running = bootstrap();
  assert.deepEqual(calls, ["runtime", "identity", "health"]);
  resolveHealth(true);
  await running;
  assert.deepEqual(calls, ["runtime", "identity", "health", "launch", "orb-start"]);
});

test("optional orb startup failure does not fail the desktop bootstrap", async () => {
  const calls = [];
  const bootstrap = vm.runInNewContext(`(${mainFunction("bootstrap")})`, {
    visualPolicy: { start() {} },
    startStartupSplash() {}, startupSplash: null,
    initCompanionRuntime() {}, registerCharacterProtocol() {}, startRemoteCompanionBridge() {},
    resolveBackendRoot: () => null, cfg: { spawn: false },
    createTray() {}, repairWindowsShortcutIdentity() {}, registerWindowsUserTasks() {},
    handleDesktopLaunch: async () => calls.push("launch"), process: { argv: [] },
    orbController: () => ({ start: async () => { throw new Error("fixture load failure"); } }),
    console: { warn: () => calls.push("orb-warning") },
    globalShortcut: { register: () => { calls.push("shortcut"); return true; } },
  });
  await bootstrap(); assert.deepEqual(calls, ["launch", "orb-warning", "shortcut"]);
});

test("early Dashboard activation initializes identity before constructing preload arguments", async () => {
  const calls = [];
  const stopped = new Error("fixture stops at window construction");
  let args;
  const context = vm.createContext({
    startupSplash: null,
    mainWindow: null, remoteBridge: null, cfg: { token: "", url: "http://localhost:7788", petEnabled: false },
    initCompanionRuntime: () => calls.push("runtime"),
    startRemoteCompanionBridge() { calls.push("identity"); context.remoteBridge = { clientId: "desktop-fixture" }; },
    BrowserWindow: class { constructor(options) { args = options.webPreferences.additionalArguments; calls.push("window"); throw stopped; } },
    APP_ICON_PATH: "/fixture/icon", PET_CATALOG: {}, path, __dirname: "/fixture", encodeURIComponent,
  });
  const create = vm.runInContext(`(${mainFunction("createDashboardWindow")})`, context);
  await assert.rejects(create(), error => error === stopped);
  assert.deepEqual(calls, ["runtime", "identity", "window"]);
  assert.ok(args.includes("--harbour-cowork-device=desktop-fixture"));
});

test("Dashboard F5 and Ctrl/Cmd+R reload through the unsaved-content guard without a UI button", async () => {
  const guards = [], loads = [];
  let approved = false;
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; }
    isDestroyed() { return false; }
    isVisible() { return true; }
  }
  const context = vm.createContext({
    startupSplash: null, mainWindow: null, remoteBridge: null,
    cfg: { token: "", url: "http://localhost:7788", petEnabled: false },
    initCompanionRuntime() {}, startRemoteCompanionBridge() {},
    BrowserWindow: Window, removeWindowMenu() {}, conversationLink: { flush() {} }, openDashboardLink: () => ({ action: 'deny' }),
    closeGuard: { register() {}, run: async (win, reason, action) => { guards.push({ win, reason }); if (approved) await action(); return approved; } },
    loadDashboard: async win => loads.push(win),
    refreshDashboard: async win => loads.push(win),
    APP_ICON_PATH: "/fixture/icon", PET_CATALOG: {}, path, __dirname: "/fixture", encodeURIComponent,
  });
  const create = vm.runInContext(`(${mainFunction("createDashboardWindow")})`, context);
  const win = await create();
  assert.equal(loads.length, 1);
  let prevented = 0;
  const input = event => win.webContents.emit("before-input-event", { preventDefault: () => prevented++ }, event);
  input({ type: "keyDown", key: "F5" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(guards.length, 1);
  assert.equal(loads.length, 1, "cancelled refresh preserves the current document");
  approved = true;
  for (const key of [{ key: "F5" }, { key: "r", control: true }, { key: "R", meta: true }]) {
    input({ type: "keyDown", ...key });
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(loads.length, 4);
  assert.equal(prevented, 4, "native unguarded reload is suppressed");
  assert.ok(guards.every(call => call.win === win && call.reason === "reload"));
  input({ type: "keyUp", key: "F5" }); input({ type: "keyDown", key: "r" });
  assert.equal(guards.length, 4, "typing and keyup never request refresh");
});

test("Dashboard refresh reloads the current entry instead of clearing its forward history", async () => {
  const reloads = [], loads = [];
  let currentUrl = "http://localhost:7788/#calendar?date=2026-10-13";
  const contents = new EventEmitter();
  contents.getURL = () => currentUrl;
  contents.reloadIgnoringCache = () => { reloads.push(currentUrl); contents.emit('did-finish-load'); };
  const win = { isDestroyed: () => false, webContents: contents };
  const refresh = vm.runInNewContext(`(${mainFunction("refreshDashboard")})`, {
    URL, setTimeout, clearTimeout, cfg: { url: "http://localhost:7788/" }, loadDashboard: async target => { loads.push(target); return true; },
  });
  assert.equal(await refresh(win), true);
  assert.deepEqual(reloads, [currentUrl]);
  assert.equal(loads.length, 0, "a healthy page keeps its native history entry");
  assert.equal(contents.eventNames().length, 0, 'completed refresh releases listeners');
  for (const url of ["file:///backend-offline.html", "http://elsewhere.test/", "http://localhost:7788/another-app", "http://localhost:7788/?context=another"]) {
    currentUrl = url; assert.equal(await refresh(win), true);
  }
  assert.equal(reloads.length, 1, "an unrelated or offline page is not reloaded in place");
  assert.equal(loads.length, 4);
  currentUrl = 'http://localhost:7788/#cron';
  contents.reloadIgnoringCache = () => contents.emit('did-fail-load', {}, -102, 'fixture offline', currentUrl, true);
  assert.equal(await refresh(win), true);
  assert.equal(loads.length, 5, 'a failed reload uses the existing offline/retry path');
  assert.equal(contents.eventNames().length, 0);
  contents.reloadIgnoringCache = () => {
    contents.emit('did-fail-load', {}, -3, 'cancelled', currentUrl, true);
    contents.emit('did-fail-load', {}, -102, 'subframe', currentUrl, false);
    contents.emit('did-finish-load');
  };
  assert.equal(await refresh(win), true);
  assert.equal(loads.length, 5, 'cancelled loads and subframes do not trigger a second navigation');
  contents.reloadIgnoringCache = () => contents.emit('destroyed');
  assert.equal(await refresh(win), false);
  assert.equal(contents.eventNames().length, 0);
  assert.equal(await refresh(null), false);
  assert.equal(await refresh({ isDestroyed: () => true }), false);
});

test("interrupted Dashboard reloads settle without replay and release listeners for another F5", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const contents = new EventEmitter();
  const url = 'http://localhost:7788/#chat?session=fixture&agent=main-elaina';
  let loads = 0, reloads = 0;
  contents.getURL = () => url;
  contents.reloadIgnoringCache = () => reloads++;
  const win = { isDestroyed: () => false, webContents: contents };
  const refresh = vm.runInNewContext(`(${mainFunction('refreshDashboard')})`, {
    URL, setTimeout, clearTimeout, cfg: { url: 'http://localhost:7788/' },
    loadDashboard: async () => { loads++; return true; },
  });
  for (const interrupt of ['did-stop-loading', 'render-process-gone', 'destroyed', 'timeout']) {
    const attempt = refresh(win);
    if (interrupt === 'timeout') t.mock.timers.tick(30_000);
    else contents.emit(interrupt);
    assert.equal(await attempt, false, interrupt);
    assert.equal(contents.eventNames().length, 0, `${interrupt} releases every listener`);
    assert.equal(loads, 0, 'interruption never retries or replaces the current route');
    const retry = refresh(win);
    contents.emit('did-finish-load');
    assert.equal(await retry, true, `explicit retry works after ${interrupt}`);
    assert.equal(contents.eventNames().length, 0);
  }
  const aborted = refresh(win);
  contents.emit('did-fail-load', {}, -3, 'aborted', url, true);
  contents.emit('did-stop-loading');
  assert.equal(await aborted, false);
  assert.equal(loads, 0);
  assert.equal(reloads, 9);
  assert.equal(contents.eventNames().length, 0);
  // A late completion after an interrupted attempt cannot initiate recovery.
  contents.emit('did-finish-load');
  contents.emit('did-fail-load', {}, -102, 'late failure', url, true);
  t.mock.timers.tick(30_000);
  assert.equal(loads, 0);
});

test("music identity survives an unavailable Cowork executor without claiming execution tools", () => {
  const context = vm.createContext({
    coworkExecutor: null, remoteBridge: { clientId: "desktop-fixture", label: "Local player" },
    process: { platform: "win32", arch: "x64" }, require: () => ({ hostname: () => "fixture-host" }),
  });
  const read = vm.runInContext(`(${mainFunction("desktopDeviceInfo")})`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(read())), {
    deviceId: "desktop-fixture", label: "Local player", platform: "win32", arch: "x64", hostname: "fixture-host", tools: [],
  });
  const hello = { deviceId: "desktop-fixture", tools: ["read_file"], cwd: "/fixture" };
  context.coworkExecutor = { hello: () => hello };
  assert.equal(read(), hello, "healthy Cowork keeps its existing exact hello contract");
  context.coworkExecutor = null;
  context.remoteBridge = null;
  assert.equal(read(), null, "identity must never be guessed without a local bridge");
});

function startupFixture({ root = "/fixture", spawnFailure = "", alreadyRunning = false } = {}) {
  const calls = [], probes = [], errors = [];
  const context = vm.createContext({
    visualPolicy: { start() {} },
    startStartupSplash() {}, startupSplash: null,
    initCompanionRuntime() {}, registerCharacterProtocol() {}, startRemoteCompanionBridge() {},
    resolveBackendRoot: () => root, cfg: { spawn: true, url: "http://localhost:7788" },
    serverStartupAttempt: 0, serverStartupFailure: "", serverOutputTail: "",
    closeGuard: { quitting: false },
    mainWindow: { isDestroyed: () => false, webContents: { getURL: () => "file:///backend-offline.html" } },
    waitForHealth(_url, timeoutMs, options = {}) {
      if (timeoutMs === 1500) return Promise.resolve(alreadyRunning);
      return new Promise(resolve => probes.push({ timeoutMs, stopWhen: options.stopWhen, resolve }));
    },
    spawnServer() {
      calls.push("spawn"); context.serverStartupAttempt += 1;
      context.serverStartupFailure = spawnFailure || (!root ? "没有找到 Harbour 项目根目录" : "");
      return !context.serverStartupFailure;
    },
    createTray: () => calls.push("tray"), repairWindowsShortcutIdentity() {}, registerWindowsUserTasks() {},
    handleDesktopLaunch: async () => calls.push("launch"), process: { argv: [] },
    orbController: () => ({ start: async () => calls.push("orb") }),
    globalShortcut: { register: () => true },
    loadDashboard: async () => calls.push("connected"),
    dialog: { showErrorBox: (title, message) => errors.push({ title, message }) },
  });
  vm.runInContext(["waitForBackendStartup", "serverStartupDiagnostic", "bootstrap"].map(mainFunction).join("\n"), context);
  const running = context.bootstrap();
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { context, calls, probes, errors, running, flush };
}

test("cold startup can exceed multiple health windows without a failure dialog or a second backend", async () => {
  const f = startupFixture();
  await f.flush();
  assert.deepEqual(f.calls, ["spawn", "tray", "launch", "orb"], "desktop stays interactive while health is pending");
  for (let i = 0; i < 3; i++) {
    assert.equal(f.probes[i].timeoutMs, 40_000);
    assert.equal(f.probes[i].stopWhen(), false);
    f.probes[i].resolve(false);
    await f.flush();
    assert.equal(f.errors.length, 0, "a missed health deadline is not a startup failure");
    assert.equal(f.probes.length, i + 2, "the same process continues to be observed");
  }
  f.probes[3].resolve(true);
  await f.running;
  assert.equal(f.calls.filter(call => call === "spawn").length, 1);
  assert.equal(f.calls.filter(call => call === "connected").length, 1, "late readiness restores Dashboard automatically");
  assert.equal(f.errors.length, 0);
});

test("confirmed child failure is reported once both before and after the old deadline", async () => {
  for (const slow of [false, true]) {
    const f = startupFixture();
    await f.flush();
    if (slow) { f.probes[0].resolve(false); await f.flush(); }
    f.context.serverStartupFailure = "后端进程已退出（code=1）";
    const probe = f.probes.at(-1);
    assert.equal(probe.stopWhen(), true);
    probe.resolve(false);
    await f.running;
    assert.equal(f.errors.length, 1);
    assert.equal(f.errors[0].title, "Harbour 后端启动失败");
    assert.match(f.errors[0].message, /code=1/);
    assert.equal(f.calls.includes("connected"), false);
    assert.equal(f.calls.filter(call => call === "spawn").length, 1);
  }
});

test("a late successful probe cannot hide a confirmed process failure", async () => {
  const f = startupFixture();
  await f.flush();
  f.context.serverStartupFailure = "后端进程无法启动：ENOENT";
  f.probes[0].resolve(true);
  await f.running;
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0].message, /ENOENT/);
  assert.equal(f.calls.includes("connected"), false);
});

test("startup diagnostics distinguish a missing project root from missing dependencies", async () => {
  for (const [options, title, cause] of [
    [{ root: null }, "Harbour 后端路径不可用", /没有找到/],
    [{ spawnFailure: "本机 Harbour 后端依赖未安装" }, "Harbour 后端启动失败", /依赖未安装/],
    [{ spawnFailure: "创建进程失败：EACCES" }, "Harbour 后端启动失败", /EACCES/],
  ]) {
    const f = startupFixture(options);
    await f.running;
    assert.equal(f.errors.length, 1);
    assert.equal(f.errors[0].title, title);
    assert.match(f.errors[0].message, cause);
    assert.equal(f.probes.length, 0);
  }
});

test("committed quit or a replacement attempt cancels stale startup notifications and navigation", async () => {
  for (const mode of ["quit", "replacement"]) {
    const f = startupFixture();
    await f.flush();
    f.probes[0].resolve(false);
    await f.flush();
    if (mode === "quit") f.context.closeGuard.quitting = true;
    else f.context.serverStartupAttempt += 1;
    // Even if a superseding attempt fails, the original watcher must not duplicate its alert.
    f.context.serverStartupFailure = "different attempt failure";
    assert.equal(f.probes[1].stopWhen(), true);
    f.probes[1].resolve(true);
    await f.running;
    assert.equal(f.errors.length, 0);
    assert.equal(f.calls.includes("connected"), false);
    assert.equal(f.probes.length, 2);
  }
});

test("late readiness neither reopens a closed Dashboard nor reloads an already connected page", async () => {
  for (const mode of ["closed", "connected"]) {
    const f = startupFixture();
    await f.flush();
    f.probes[0].resolve(false);
    await f.flush();
    if (mode === "closed") f.context.mainWindow = null;
    else f.context.mainWindow.webContents.getURL = () => "http://localhost:7788/";
    f.probes[1].resolve(true);
    await f.running;
    assert.equal(f.errors.length, 0);
    assert.equal(f.calls.includes("connected"), false);
  }
});

test("an already running backend is reused without spawning or starting an owned-process watcher", async () => {
  const f = startupFixture({ alreadyRunning: true });
  await f.running;
  assert.deepEqual(f.calls, ["tray", "launch", "orb"]);
  assert.equal(f.errors.length, 0);
  assert.equal(f.probes.length, 0);
});

test("long log lines do not displace the confirmed cause in startup diagnostics", () => {
  const read = vm.runInNewContext(`(${mainFunction("serverStartupDiagnostic")})`, {
    serverStartupFailure: "后端进程无法启动：fixture failure", serverOutputTail: "x".repeat(4_000),
  });
  assert.match(read(), /^后端进程无法启动：fixture failure/);
  assert.ok(read().length < 2_000);
  assert.doesNotMatch(read(), /40 秒/);
});

test("real loopback health polling recovers after the old deadline and observes a late failure", { timeout: 10_000 }, async () => {
  for (const outcome of ["ready", "failed"]) {
    let virtualTime = 0, fixture;
    const requests = [], results = [];
    const server = http.createServer((request, response) => {
      requests.push(request.url);
      if (outcome === "failed" && virtualTime >= 45_000) fixture.context.serverStartupFailure = "fixture process exited";
      response.writeHead(outcome === "ready" && virtualTime >= 45_000 ? 200 : 503);
      response.end("{}");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      fixture = startupFixture();
      fixture.context.cfg.url = `http://127.0.0.1:${server.address().port}`;
      Object.assign(fixture.context, {
        http, URL, Date: { now: () => virtualTime },
        // Fast-forward only the retry clock. HTTP still uses real isolated loopback sockets;
        // no real Harbour process, credentials, channel login or model call is involved.
        setTimeout: (callback, delay) => setTimeout(() => { virtualTime += delay; callback(); }, 0),
      });
      const probe = vm.runInContext(`(${mainFunction("waitForHealth")})`, fixture.context);
      fixture.context.waitForHealth = async (...args) => {
        const result = await probe(...args); results.push(result); return result;
      };
      await fixture.running;
      assert.ok(virtualTime >= 45_000);
      assert.deepEqual(results, [false, outcome === "ready"], "the first missed deadline must not settle bootstrap as failed");
      assert.ok(requests.length > 2 && requests.every(url => url === "/api/health"));
      assert.equal(fixture.calls.filter(call => call === "spawn").length, 1);
      assert.equal(fixture.calls.includes("connected"), outcome === "ready");
      assert.equal(fixture.errors.length, outcome === "failed" ? 1 : 0);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
});

test("owned child events preserve real failure causes and invalidate replaced startup attempts", () => {
  const children = [], errors = [];
  const context = vm.createContext({
    serverStarted: false, serverStartupAttempt: 0, serverStartupFailure: "", serverOutputTail: "", serverProc: null,
    closeGuard: { quitting: false }, process: { env: {}, execPath: "/fixture/electron", platform: "win32" },
    path, fs: { existsSync: () => true }, require: { resolve: () => "/fixture/tsx" },
    console: { log() {}, error() {} }, wireManagedServiceRestart,
    dialog: { showErrorBox: (...args) => errors.push(args) },
    spawn: () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.connected = true; child.send = () => {}; children.push(child); return child;
    },
  });
  vm.runInContext(["spawnServer", "serverStartupDiagnostic"].map(mainFunction).join("\n"), context);
  assert.equal(context.spawnServer("/fixture"), true);
  assert.equal(context.serverStartupAttempt, 1);
  assert.equal(context.spawnServer("/fixture"), true);
  assert.equal(children.length, 1, "an existing child must not be started twice");
  children[0].emit("message", { type: "harbour:restart-prepare", nonce: "fixture" });
  children[0].emit("message", { type: "harbour:restart-commit", nonce: "fixture" });
  children[0].emit("exit", 0);
  assert.equal(context.serverStartupAttempt, 2);
  assert.equal(context.serverProc, children[1]);
  assert.equal(context.serverStartupFailure, "", "the old successful exit must not poison its replacement");
  children[0].emit("error", new Error("stale child error"));
  assert.equal(context.serverStartupFailure, "");
  children[1].emit("error", new Error("fixture ENOENT"));
  assert.match(context.serverStartupFailure, /fixture ENOENT/);
  children[1].emit("exit", 1);
  assert.match(context.serverStartupFailure, /fixture ENOENT/, "a later exit does not erase the precise spawn error");
  assert.equal(context.serverStarted, false);
  assert.equal(context.serverProc, null);
  assert.equal(errors.length, 0);
});
