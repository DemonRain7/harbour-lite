// Harbour 桌面壳（Electron）。
//
// 定位：一个像 Claude Desktop 那样的窗口，里面就是 Harbour 的 web dashboard。
// 两种用法：
//   1) 远端连接模式：HARBOUR_URL 指向树莓派/局域网/公网服务，Electron 只做客户端。
//   2) 本机一体模式：URL 是 loopback 且能找到 Harbour 根目录时默认拉起后端；
//      HARBOUR_SPAWN=0 可显式关闭，HARBOUR_SPAWN=1 可显式开启。
//
// 配置来源（优先级从高到低）：环境变量 > 本机 config.json > 默认值。
//   HARBOUR_URL    服务地址，默认 http://localhost:7788
//   HARBOUR_TOKEN  访问令牌（服务端设了 WEB_AUTH_TOKEN 时需要）。会在页面加载前
//                 写进 localStorage，省去手动输入。
//   HARBOUR_SPAWN  =1 则在父目录跑 `npm run serve` 自带服务。

const { app, BrowserWindow, Menu, Tray, clipboard, dialog, globalShortcut, ipcMain, nativeImage, net, powerMonitor, protocol, screen, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { CharacterStore } = require("./companion/character-store");
const { RemoteTtsClient } = require("./companion/remote-tts-client");
const { RemoteCompanionBridge } = require("./companion/remote-bridge");
const { CoworkExecutor } = require("./companion/cowork-executor");
const { CompanionStateStore } = require("./companion/companion-state");
const { ConversationLink, conversationTarget } = require("./companion/conversation-link");
const { chatWindowUrl } = require("./companion/chat-window");
const conversationLink = new ConversationLink();
const { MusicStore } = require("./companion/music-store");
const { musicTransport } = require("./companion/music-transport");
const { QQMusicBridge } = require("./companion/qqmusic-bridge");
const { VisualPolicy } = require("./companion/visual-policy");
const { FoliaController, scaledFoliaBounds } = require("./folia/controller");
const { SCHEMES: FOLIA_SCHEMES, isFoliaWindow } = require("./folia/host");
const { TownController, isTownWindow } = require("./town/controller");
const { registerTownIpc } = require("./town/ipc");
const { StickerStore } = require("./companion/sticker-store");
const { buildDesktopLaunchArguments, parseDesktopLaunchIntent } = require("./companion/launch-intent");
const { createPetDragState } = require("./companion/pet-drag-state");
const { buildPetCatalog, normalizePetDefinition, resolvePetDefinitions } = require("./companion/pet-catalog");
const { resolveHarbourDataRoot } = require("./companion/platform-paths");
const { initializeDesktopStorage } = require("./companion/runtime-storage");
const { ensureLive2dPack } = require("./scripts/ensure-live2d-pack");
const { createCloseGuard } = require("./companion/close-guard");
const { createServiceActions, wireManagedServiceRestart } = require("./companion/service-actions");
const { createVoiceRequestBridge } = require("./companion/voice-request-bridge");
const { removeWindowMenu } = require("./companion/window-menu");
const { OrbController } = require("./companion/orb-controller");
const { OrbSignals } = require("./companion/orb-signals");
const { createOrbDesktop } = require("./companion/orb-desktop");
const { createFileOpener, authorizeFileSender } = require("./companion/file-opener");
const { StartupSplash } = require("./companion/startup-splash");

const APP_ICON_PATH = path.join(__dirname, "assets", "icon.ico");

// Separate instance/profile namespace; the public edition must not attach to the private app.
app.setName("HarbourPublic");
app.setPath("userData", path.join(app.getPath("appData"), "HarbourPublic"));

function packagedWebAssetPath(...parts) {
  return app.isPackaged
    ? path.join(process.resourcesPath, "web", ...parts)
    : path.join(__dirname, "..", "web", ...parts);
}

protocol.registerSchemesAsPrivileged([{
  scheme: "harbour-character",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}, {
  scheme: "harbour-music",
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}, {
  scheme: "harbour-sticker",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}, ...FOLIA_SCHEMES]);
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function configCandidates() {
  const candidates = [];
  if (process.env.HARBOUR_CONFIG) candidates.push(path.resolve(process.env.HARBOUR_CONFIG));
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, "config.json"));
  }
  if (app.isPackaged) candidates.push(path.join(path.dirname(process.execPath), "config.json"));
  candidates.push(path.join(resolveHarbourDataRoot(), "config.json"));
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "HarbourPublic", "config.json"));
  candidates.push(path.join(__dirname, "config.json"));
  return [...new Set(candidates)];
}

function loadConfig() {
  let file = {};
  for (const candidate of configCandidates()) {
    try {
      file = JSON.parse(fs.readFileSync(candidate, "utf8"));
      break;
    } catch {
      /* 没有 config.json 很正常，继续找下一个位置 */
    }
  }
  const spawnOverride = process.env.HARBOUR_SPAWN;
  const petsOverride = process.env.HARBOUR_PETS;
  const petEnabled = process.env.HARBOUR_PET !== "0" && file.pet !== false;
  const requestedPets = petsOverride !== undefined
    ? petsOverride.split(",")
    : Array.isArray(file.pets) ? file.pets : [{ id: "elaina", agentName: "main-assistant", displayName: "Assistant" }];
  const pets = petEnabled
    ? resolvePetDefinitions(requestedPets)
    : [];
  return {
    url: process.env.HARBOUR_URL || file.url || "http://localhost:7799",
    token: process.env.HARBOUR_TOKEN || file.token || "",
    spawn: spawnOverride !== undefined
      ? spawnOverride === "1"
      : typeof file.spawn === "boolean" ? file.spawn : undefined,
    backendRoot: process.env.HARBOUR_ROOT || file.backendRoot || "",
    dataHome: file.dataHome || "",
    coworkLabel: process.env.HARBOUR_DEVICE_NAME || file.deviceName || file.coworkLabel || "",
    petEnabled,
    pets,
  };
}

const cfg = loadConfig();
// Take the legacy instance lock before changing storage; a second launch must not
// copy a profile while the first instance is still writing its login databases.
const singleInstance = app.requestSingleInstanceLock();
if (singleInstance) {
  try {
    initializeDesktopStorage(app, { repoRoot: cfg.backendRoot || path.resolve(__dirname, ".."), dataHome: cfg.dataHome });
  } catch (error) {
    dialog.showErrorBox("Harbour 存储迁移未完成", `${error.message}\n旧数据未删除。请完整退出 Harbour 后重试。`);
    app.exit(1);
  }
}
// Keep the two built-ins, but allow future main-* companions to arrive from config without
// modifying this process. CharacterStore intentionally receives the same mutable object so a
// trusted Dashboard request can register a conventional `main-<id>` companion on demand.
const PET_CATALOG = cfg.petEnabled ? buildPetCatalog(cfg.pets) : {};
let serverProc = null;
let mainWindow = null;
let tray = null;
let startupSplash = null;
let desktopBootstrapping = true;
const petWindows = new Map();
const petRuntime = new Map();
const auxiliaryWindows = new Map();
const voiceRequestBridge = createVoiceRequestBridge({
  getWindow: () => auxiliaryWindows.get("call"), getConfig: () => cfg,
  expectedUrl: pathToFileURL(path.join(__dirname, "renderer", "voice-call.html")).href,
  voiceChoice: input => { initCompanionRuntime(); return ttsClient.voiceChoice("call", input); },
});
const pendingMusicCommands = new Map();
const pendingStickerSelections = new Map();
let petCursorTimer = null;
let serverStarted = false;
let serverStartupAttempt = 0;
let serverStartupFailure = "";
let serverOutputTail = "";
let characterStore = null;
let ttsClient = null;
let audioFocus = null;
let musicStore = null;
let qqMusicBridge = null;
let folia = null;
let town = null;
let stickerStore = null;
let companionState = null;
let remoteBridge = null;
let coworkExecutor = null;
let dashboardRetryTimer = null;
let musicProviderTimer = null;
let musicProviderRefresh = null;
let musicProviderPollRevision = 0;
let live2dBootstrap = null;
let serviceActionState = "idle";
let orb = null;
// Capture shared-bridge state even before the optional orb window is created.
const orbSignals = new OrbSignals({ agents: Object.values(buildPetCatalog(cfg.pets)).map(pet => pet.agentName) });
const visualPolicy = new VisualPolicy({ powerMonitor, file: path.join(app.getPath("userData"), "visual-policy.json"),
  onChange: ({ quiet }) => {
    folia?.setVisualQuiet(quiet); town?.setVisualQuiet(quiet); orb?.setVisualQuiet(quiet);
    startPetCursorTracking();
  } });
ipcMain.handle("desktop:visual-policy", event => visualPolicy.forSender(event));

const closeGuard = createCloseGuard({ app, ipcMain, dialog, cleanup: cleanupDesktop, showWindow: win => {
  if (town?.win === win) { town.reveal(); return; }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
} });
app.on("browser-window-created", (_event, win) => {
  // Electron emits this inside the constructor, before WebPreferences or the
  // movable Folia view is finalized. Classify the actual host-owned window only
  // after construction; renderer arguments are not an ownership credential.
  queueMicrotask(() => {
    if (!win.isDestroyed() && startupSplash?.win !== win) visualPolicy.register(win);
    if (!win.isDestroyed() && !isFoliaWindow(win) && !isTownWindow(win)
      && orb?.win !== win && startupSplash?.win !== win) closeGuard.register(win);
  });
});
const serviceActions = createServiceActions({
  request: requestServiceControl,
  confirm: async (message, detail) => {
    const result = await dialog.showMessageBox({ type: "question", title: "Harbour · 重启", message, detail,
      buttons: ["取消", "重启"], defaultId: 0, cancelId: 0, noLink: true });
    return result.response === 1;
  },
  onState: state => { serviceActionState = state; if (tray && !tray.isDestroyed()) createTray(); },
  notify: (kind, message) => {
    if (kind === "error") dialog.showErrorBox("Harbour · 重启未完成", message);
    else void dialog.showMessageBox({ type: "info", title: "Harbour · 重启完成", message });
  },
  quitGuard: closeGuard, app,
});

const PET_WIDTH = 232;
// The character surface remains 270px tall. The extra transparent headroom keeps the fixed
// completion/speech card entirely inside the native window even for the 188px Live2D profile.
const PET_VISUAL_HEIGHT = 270;
const PET_HEIGHT = 332;
// `floating` is only a normal topmost window on Windows and can be reordered below a
// borderless-fullscreen game.  `screen-saver` maps to Electron's highest supported layer.
const PET_ALWAYS_ON_TOP_LEVEL = "screen-saver";

function pageUrl(page) {
  const base = cfg.url.endsWith("/") ? cfg.url : `${cfg.url}/`;
  return new URL(page, base).toString();
}

function petPagePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "web", "desktop-pet.html")
    : path.join(__dirname, "..", "web", "desktop-pet.html");
}

function initCompanionRuntime() {
  if (characterStore && ttsClient && companionState && musicStore && qqMusicBridge && stickerStore) return;
  characterStore = new CharacterStore(app, PET_CATALOG);
  for (const pet of cfg.pets) characterStore.ensureCharacter(pet);
  musicStore = new MusicStore(app);
  folia = new FoliaController({ isQuitting: () => closeGuard.quitting, onState: next => {
    if (currentMusicProvider() === "folia") publishMusicState({ ...next, providerAvailable: next.available });
  } });
  qqMusicBridge = new QQMusicBridge();
  stickerStore = new StickerStore(app);
  companionState = new CompanionStateStore({ matcher: (id, text, mood) => stickerStore.match(id, text, mood) });
  companionState.setAppearance(characterStore.appearance());
  companionState.setMusic(musicStateForBridge());
  orbSignals.setMusic(companionState.music);
  orb?.publishMusic();
  let orbAppearance = "";
  companionState.on("change", (snapshot) => {
    broadcastDesktop("desktop:companion-state", snapshot);
    const appearance = JSON.stringify(snapshot.appearance);
    if (orb && appearance !== orbAppearance) { orbAppearance = appearance; orb.syncAppearance(snapshot.appearance); }
  });
  ttsClient = new RemoteTtsClient({
    baseUrl: cfg.url,
    token: cfg.token,
    logger: console,
  });
}

function startLive2dBootstrap() {
  if (live2dBootstrap || process.env.HARBOUR_LIVE2D_AUTO_INSTALL !== "1") return live2dBootstrap;
  const elaina = cfg.pets.find((pet) => pet.id === "elaina");
  if (!cfg.petEnabled || !elaina || !characterStore) return null;
  const profilePath = path.join(__dirname, "companion", "profiles", "elaina-lss.json");
  live2dBootstrap = ensureLive2dPack({
    profilePath,
    // Packaged apps do not ship esbuild. Reuse the adapter that was built into extraResources;
    // source checkouts use CharacterStore's existing build/fallback logic.
    adapterBuilder: () => characterStore.adapterSource(),
  }).then((result) => {
    characterStore.ensureCharacter(elaina);
    const win = petWindows.get(elaina.id);
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed() && result.noOp !== true) {
      win.webContents.reloadIgnoringCache();
    }
    console.log(`[harbour-desktop] Live2D ${result.noOp ? "ready" : "installed"}: ${result.characterRoot}`);
    return result;
  }).catch((error) => {
    // Model acquisition must never prevent the Dashboard or pixel companion from opening.
    console.warn(`[harbour-desktop] Live2D 暂不可用，继续使用像素桌宠：${error?.message || error}`);
    return null;
  });
  return live2dBootstrap;
}

function broadcastDesktop(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function sendToPets(channel, payload) {
  for (const win of petWindows.values()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function currentMusicProvider() {
  return musicStore?.getProvider?.() || "local";
}

function musicStateForBridge(patch = {}, provider = currentMusicProvider()) {
  if (provider === "folia") {
    // Lyrics stay on the local companion stream, not the server/agent bridge.
    const { lyrics, ...state } = folia.status();
    return { ...state, ...patch, providerAvailable: state.available };
  }
  const previous = companionState?.music?.provider === provider ? companionState.music : {};
  const localTracks = musicStore
    ? musicStore.list().map(({ id, title, artist, album, durationMs }) => ({ id, title, artist, album, durationMs }))
    : [];
  const tracks = Object.prototype.hasOwnProperty.call(patch, "tracks")
    ? patch.tracks
    : provider === "local" ? localTracks : previous.tracks || [];
  return {
    provider,
    connected: provider === "local",
    loaded: false,
    paused: true,
    volume: 70,
    providerCapabilities: provider === "local"
      ? ["status", "search", "open", "play", "pause", "resume", "stop", "next", "previous", "set_volume"]
      : ["status", "open"],
    ...previous,
    ...patch,
    provider,
    tracks: Array.isArray(tracks) ? tracks : [],
  };
}

function publishMusicState(state) {
  const { lyrics, ...transport } = state;
  companionState.setMusic(transport);
  orbSignals.setMusic(companionState.music);
  orb?.publishMusic();
  remoteBridge?.updateMusicState(transport);
  return transport;
}

function qqMusicStateForBridge(result = {}) {
  const currentTrack = result.currentTrack && typeof result.currentTrack === "object"
    ? result.currentTrack
    : null;
  return musicStateForBridge({
    connected: result.connected === true,
    loaded: result.loaded === true,
    paused: result.paused !== false,
    positionMs: Math.max(0, Number(result.positionMs) || 0),
    durationMs: Math.max(0, Number(result.durationMs) || 0),
    currentTrackId: result.currentTrackId || undefined,
    tracks: currentTrack ? [currentTrack] : [],
    providerAvailable: result.installed === true,
    playbackStatus: String(result.playbackStatus || "unavailable"),
    providerCapabilities: Array.isArray(result.capabilities) ? result.capabilities.map(String) : ["status", "open"],
    providerReason: result.reason ? String(result.reason) : undefined,
  }, "qqmusic");
}

async function refreshQQMusicState() {
  if (musicProviderRefresh) return musicProviderRefresh;
  musicProviderRefresh = (async () => {
    try {
      const state = qqMusicStateForBridge(await qqMusicBridge.status());
      return currentMusicProvider() === "qqmusic" ? publishMusicState(state) : state;
    } catch (error) {
      const state = qqMusicStateForBridge({
        connected: false,
        installed: true,
        paused: true,
        capabilities: ["status", "open"],
        reason: error instanceof Error ? error.message : String(error),
      });
      return currentMusicProvider() === "qqmusic" ? publishMusicState(state) : state;
    } finally {
      musicProviderRefresh = null;
    }
  })();
  return musicProviderRefresh;
}

function syncMusicProviderPolling() {
  const revision = ++musicProviderPollRevision;
  clearTimeout(musicProviderTimer);
  musicProviderTimer = null;
  if (currentMusicProvider() !== "qqmusic") return;
  const poll = async () => {
    const state = await refreshQQMusicState();
    if (revision !== musicProviderPollRevision || currentMusicProvider() !== "qqmusic") return;
    musicProviderTimer = setTimeout(poll, state.paused === false ? 5_000 : 15_000);
    musicProviderTimer.unref?.();
  };
  void poll();
}

async function setMusicProvider(provider) {
  const previous = currentMusicProvider();
  const next = String(provider || "").toLowerCase();
  if (!["local", "qqmusic", "folia"].includes(next)) throw new Error("未知音乐来源");
  if (previous === next) return musicStateForBridge();
  if (previous === "folia" && folia?.runtime) await folia.command({ action: "pause" });
  if (previous === "local" && auxiliaryWindows.get("music") && companionState.music?.paused === false) await executeMusicCommand({ action: "pause" });
  if (previous === "qqmusic" && next !== "qqmusic") {
    try { await qqMusicBridge.execute("pause"); } catch { /* a disconnected provider is already effectively paused */ }
  }
  musicStore.setProvider(next);
  const state = next === "qqmusic"
    ? await refreshQQMusicState()
    : publishMusicState(musicStateForBridge({}, next));
  syncMusicProviderPolling();
  return state;
}

function registerCharacterProtocol() {
  protocol.handle("harbour-character", (request) => {
    try {
      const url = new URL(request.url);
      const id = url.hostname.toLowerCase();
      const base = characterStore.characterDir(id);
      const requested = path.resolve(base, decodeURIComponent(url.pathname).replace(/^[/\\]+/, ""));
      if (requested !== base && !requested.startsWith(`${base}${path.sep}`)) return new Response("forbidden", { status: 403 });
      if (!fs.existsSync(requested) || !fs.statSync(requested).isFile()) return new Response("not found", { status: 404 });
      return net.fetch(pathToFileURL(requested).toString());
    } catch {
      return new Response("bad character asset", { status: 400 });
    }
  });
  protocol.handle("harbour-music", (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "track") return new Response("not found", { status: 404 });
      const file = musicStore.resolve(decodeURIComponent(url.pathname).replace(/^\/+/, ""));
      if (!file) return new Response("not found", { status: 404 });
      return net.fetch(pathToFileURL(file).toString(), { headers: request.headers });
    } catch {
      return new Response("bad music asset", { status: 400 });
    }
  });
  protocol.handle("harbour-sticker", (request) => {
    try {
      const url = new URL(request.url);
      const file = stickerStore.resolve(decodeURIComponent(url.pathname).replace(/^\/+/, ""));
      if (!file) return new Response("not found", { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response("bad sticker asset", { status: 400 });
    }
  });
}

function isBackendRoot(candidate) {
  if (!candidate) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8"));
    return manifest.name === "harbour" && fs.existsSync(path.join(candidate, "src", "index.ts"));
  } catch {
    return false;
  }
}

function resolveBackendRoot() {
  const launchDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  const candidates = [
    cfg.backendRoot && path.resolve(cfg.backendRoot),
    path.resolve(launchDir, "..", ".."),
    path.resolve(launchDir, "..", "..", ".."),
    path.resolve(__dirname, ".."),
  ].filter(Boolean);
  return candidates.find(isBackendRoot) || null;
}

function isLoopbackUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

// 自带服务模式：在仓库根目录（desktop/ 的上一级）跑 npm run serve。
function spawnServer(cwd) {
  if (serverStarted) return true;
  serverStartupAttempt += 1;
  serverStartupFailure = "";
  serverOutputTail = "";
  if (!cwd) {
    serverStartupFailure = "没有找到 Harbour 项目根目录；请在 config.json 设置 backendRoot，或先单独启动 npm run serve。";
    return false;
  }
  serverStarted = true;
  const configuredNode = String(process.env.HARBOUR_NODE_EXECUTABLE || process.env.npm_node_execpath || "").trim();
  let command = configuredNode && fs.existsSync(configuredNode) ? configuredNode : process.execPath;
  let args = [];
  const childEnv = {
    ...process.env,
    OPENCLI_BROWSER_AUTOSTART: "true",
    HARBOUR_DESKTOP_MANAGED: "1",
  };
  if (command === process.execPath) childEnv.ELECTRON_RUN_AS_NODE = "1";
  else delete childEnv.ELECTRON_RUN_AS_NODE;
  try {
    const builtEntry = path.join(cwd, "dist", "index.js");
    // Source checkouts must not silently boot an old dist build. Direct Node also keeps
    // the IPC child identity stable (no tsx CLI wrapper between Desktop and the service).
    if (fs.existsSync(path.join(cwd, "src", "index.ts"))) {
      require.resolve("tsx", { paths: [cwd] });
      args = ["--import", "tsx", path.join(cwd, "src", "index.ts")];
    } else if (fs.existsSync(builtEntry)) args = [builtEntry];
    else throw new Error("Harbour 后端入口不存在");
  } catch (error) {
    serverStarted = false;
    serverStartupFailure = "本机 Harbour 后端依赖未安装；请在仓库根执行 npm install，或连接远程后端并设置 spawn: false。";
    console.error("[harbour-desktop] 无法解析本机后端入口", error);
    return false;
  }
  try {
    serverProc = spawn(command, args, {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
  } catch (error) {
    serverStarted = false;
    serverStartupFailure = error instanceof Error ? error.message : String(error);
    console.error("[harbour-desktop] 无法创建后端进程", error);
    return false;
  }
  const rememberOutput = (chunk) => {
    const value = String(chunk || "").trim();
    if (!value) return;
    serverOutputTail = `${serverOutputTail}\n${value}`.slice(-4_000);
    console.error(`[harbour-backend] ${value}`);
  };
  const child = serverProc;
  child.stdout?.on("data", rememberOutput);
  child.stderr?.on("data", rememberOutput);
  wireManagedServiceRestart(child, {
    isCurrent: () => serverProc === child,
    isQuitting: () => closeGuard.quitting,
    onRestart: () => {
      serverProc = null; serverStarted = false;
      if (!spawnServer(cwd)) dialog.showErrorBox("Harbour 后端重启失败", serverStartupDiagnostic());
    },
  });
  child.on("error", (error) => {
    if (serverProc !== child) return;
    serverStarted = false;
    serverStartupFailure = `后端进程无法启动：${error.message}`;
    console.error("[harbour-desktop] 后端进程启动失败", error);
  });
  child.on("exit", (code, signal) => {
    if (serverProc !== child) return;
    serverProc = null;
    serverStarted = false;
    if (!serverStartupFailure) {
      serverStartupFailure = `后端进程已退出（code=${code ?? "null"}${signal ? `, signal=${signal}` : ""}）`;
    }
    console.log(`[harbour-desktop] server 退出 code=${code}${signal ? ` signal=${signal}` : ""}`);
  });
  return true;
}

function serverStartupDiagnostic() {
  const output = serverOutputTail.trim().split(/\r?\n/u).slice(-6).join("\n").slice(-1_500);
  // Keep the confirmed cause ahead of the log tail, even when a single log line is long.
  return [serverStartupFailure, output].filter(Boolean).join("\n\n")
    || "后端尚未就绪；请检查 Node/npm、项目依赖和后端 .env。";
}

async function waitForBackendStartup() {
  const attempt = serverStartupAttempt;
  const cancelled = () => closeGuard.quitting || serverStartupAttempt !== attempt;
  const stopWhen = () => cancelled() || !!serverStartupFailure;
  while (!stopWhen()) {
    const healthy = await waitForHealth(cfg.url, 40_000, { stopWhen });
    // A slow health probe is not proof of a dead process. Keep observing this attempt;
    // never spawn another backend or interrupt channel initialization on a timeout.
    if (stopWhen()) break;
    if (healthy) return "ready";
  }
  // A committed quit or managed restart invalidates this attempt, not the new process.
  return cancelled() ? "cancelled" : "failed";
}

function requestServiceControl(endpoint, body) {
  const target = new URL(endpoint, cfg.url);
  const payload = body ? JSON.stringify(body) : null;
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(target, { method: payload ? "POST" : "GET", headers: {
      ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
      ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), "x-harbour-service-action": "restart" } : {}),
    } }, res => {
      let text = "";
      res.on("data", chunk => { text += chunk; if (text.length > 65_536) req.destroy(new Error("服务状态响应过大")); });
      res.on("end", () => {
        let result; try { result = JSON.parse(text); } catch { return reject(new Error("后端没有返回有效服务状态")); }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(result.error || `服务接口返回 ${res.statusCode}`); error.status = res.statusCode; reject(error);
        } else resolve(result);
      });
      res.on("error", reject);
    });
    req.on("error", reject); req.setTimeout(20_000, () => req.destroy(new Error("服务控制请求超时")));
    req.end(payload);
  });
}

// 有界连接探测。false 只表示本轮未连接，不代表后端进程启动失败。
function waitForHealth(url, timeoutMs = 40000, { stopWhen } = {}) {
  const healthUrl = url.replace(/\/+$/, "") + "/api/health";
  const transport = new URL(healthUrl).protocol === "https:" ? https : http;
  const start = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const tick = () => {
      if (settled) return;
      if (stopWhen?.()) return finish(false);
      const req = transport.get(healthUrl, (res) => {
        res.resume();
        if (stopWhen?.()) return finish(false);
        if (res.statusCode === 200) return finish(true);
        retry();
      });
      req.on("error", retry);
      req.setTimeout(2000, () => req.destroy());
    };
    const retry = () => {
      if (settled) return;
      if (stopWhen?.() || Date.now() - start > timeoutMs) finish(false);
      else setTimeout(tick, 800);
    };
    tick();
  });
}

function startStartupSplash() {
  const intent = parseDesktopLaunchIntent(process.argv);
  // Pet shortcuts, refreshes and second-instance activation never replay the opening.
  if (startupSplash || !["default", "dashboard"].includes(intent.kind)
    || (mainWindow && !mainWindow.isDestroyed())) return;
  try {
    startupSplash = new StartupSplash({
      BrowserWindow, ipcMain, icon: APP_ICON_PATH,
      workArea: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
      onDismiss: () => {
        if (!closeGuard.quitting && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
      },
    });
    startupSplash.start();
  } catch (error) {
    console.warn("[harbour-desktop] 开屏初始化失败，继续启动", error);
    startupSplash?.dispose();
  }
}

async function createDashboardWindow() {
  // Activation/second-instance can arrive while bootstrap awaits backend health.
  // Resolve the stable local identity before freezing it into preload arguments.
  initCompanionRuntime();
  startRemoteCompanionBridge();
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (startupSplash?.active) {
      startupSplash.win?.show();
      startupSplash.win?.focus();
      return mainWindow;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (!/^https?:/i.test(mainWindow.webContents.getURL())) void loadDashboard(mainWindow);
    return mainWindow;
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    ...(startupSplash?.active ? startupSplash.bounds : {}),
    show: !startupSplash?.active,
    icon: APP_ICON_PATH,
    backgroundColor: "#fcfaf6",
    title: "Harbour",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // 让 preload 能读 process.argv 拿到注入的 token
      additionalArguments: [
        `--harbour-token=${cfg.token}`,
        `--harbour-url=${encodeURIComponent(cfg.url)}`,
        `--harbour-cowork-device=${encodeURIComponent(remoteBridge?.clientId || "")}`,
        `--harbour-pet-enabled=${cfg.petEnabled ? "1" : "0"}`,
        `--harbour-pets=${encodeURIComponent(JSON.stringify(Object.values(PET_CATALOG)))}`,
        "--harbour-surface=dashboard",
        `--harbour-startup=${startupSplash?.active ? "1" : "0"}`,
      ],
    },
  });
  removeWindowMenu(win);
  mainWindow = win;
  startupSplash?.attachDashboard(win, cfg.url);
  win.on("close", () => town?.hide(win));
  win.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) { conversationLink.loading(win.webContents); town?.hide(win); }
  });
  win.webContents.on("did-finish-load", () => conversationLink.flush());
  closeGuard.register(win, { required: true });
  win.on("closed", () => {
    clearTimeout(dashboardRetryTimer);
    dashboardRetryTimer = null;
    mainWindow = null;
    startupSplash?.dispose();
  });

  // 外部链接（附件外链等）走系统浏览器，不在 app 里乱跳。
  win.webContents.setWindowOpenHandler(openDashboardLink);

  // 隐藏原生菜单后仍保留桌面应用常见的 F5 / Ctrl+R 刷新语义。
  // 始终经过未保存内容保护，不依赖页面里的刷新按钮。
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const refresh = input.key === "F5" || ((input.control || input.meta) && input.key.toLowerCase() === "r");
    if (!refresh) return;
    event.preventDefault();
    void closeGuard.run(win, "reload", () => refreshDashboard(win));
  });

  win.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    void closeGuard.run(win, "navigate", () => win.loadURL(url));
  });

  try {
    await loadDashboard(win);
  } finally {
    // Page load does not prove the app is ready. The theatre waits for rendered
    // Main Chat and a real WS snapshot, including when loadDashboard is offline.
    if (!startupSplash?.active && !closeGuard.quitting && !win.isDestroyed() && !win.isVisible()) win.show();
  }
  return win;
}

async function refreshDashboard(win) {
  if (!win || win.isDestroyed()) return false;
  try {
    const current = new URL(win.webContents.getURL()), configured = new URL(cfg.url);
    if (current.origin === configured.origin && current.pathname === configured.pathname && current.search === configured.search) {
      // Reload the current entry, retaining its route and the forward branch.
      return new Promise(resolve => {
        const contents = win.webContents;
        let settled = false;
        let timer;
        const cleanup = () => {
          clearTimeout(timer);
          contents.removeListener("did-finish-load", loaded);
          contents.removeListener("did-fail-load", failed);
          contents.removeListener("did-stop-loading", stopped);
          contents.removeListener("render-process-gone", stopped);
          contents.removeListener("destroyed", destroyed);
        };
        const finish = (result) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };
        const loaded = () => finish(true);
        const stopped = () => finish(false);
        const destroyed = () => finish(false);
        const recover = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(loadDashboard(win)); // Preserve the existing offline/retry page.
        };
        const failed = (_event, code, _description, _url, isMainFrame) => {
          if (!isMainFrame || code === -3) return; // Cancellation settles at did-stop-loading, not a second navigation.
          recover();
        };
        contents.once("did-finish-load", loaded);
        contents.on("did-fail-load", failed);
        // Chromium can stop a cancelled reload without either finish-load or fail-load.
        // Leaving its Promise pending locks closeGuard, swallowing every subsequent F5.
        contents.once("did-stop-loading", stopped);
        contents.once("render-process-gone", stopped);
        contents.once("destroyed", destroyed);
        // Bound only the approved navigation, never the user's unsaved-edit decision.
        // No automatic retry or force-close: the next key press runs preflight again.
        timer = setTimeout(stopped, 30_000);
        try { contents.reloadIgnoringCache(); }
        catch { recover(); }
      });
    }
  } catch { /* Offline/file pages recover through the configured Dashboard URL. */ }
  return loadDashboard(win);
}

async function loadDashboard(win) {
  if (!win || win.isDestroyed()) return false;
  clearTimeout(dashboardRetryTimer);
  dashboardRetryTimer = null;
  try {
    await win.loadURL(cfg.url);
    return true;
  } catch (error) {
    console.warn(`[harbour-desktop] Dashboard 无法连接 ${cfg.url}: ${error?.message || error}`);
    if (win.isDestroyed()) return false;
    await win.loadFile(rendererPagePath("backend-offline.html"), {
      query: { url: cfg.url },
    }).catch((fallbackError) => {
      console.error("[harbour-desktop] 无法加载后端离线页", fallbackError);
    });
    scheduleDashboardRetry(win);
    return false;
  }
}

function scheduleDashboardRetry(win) {
  clearTimeout(dashboardRetryTimer);
  dashboardRetryTimer = setTimeout(async () => {
    dashboardRetryTimer = null;
    if (!win || win.isDestroyed()) return;
    if (await waitForHealth(cfg.url, 1_500)) await loadDashboard(win);
    else scheduleDashboardRetry(win);
  }, 2_500);
}

function rendererPagePath(file) {
  return path.join(__dirname, "renderer", file);
}

const AUXILIARY_SPECS = Object.freeze({
  companion: { file: "companion-settings.html", title: "Harbour · 桌面陪伴", width: 760, height: 650 },
  music: { file: "music-player.html", title: "Harbour · 音乐陪伴", width: 820, height: 720 },
  stickers: { file: "sticker-manager.html", title: "Harbour · 智能表情包", width: 820, height: 720 },
  call: { file: "voice-call.html", title: "Harbour · 语音通话", width: 620, height: 720 },
});

async function createAuxiliaryWindow(kind, { show = true } = {}) {
  const spec = AUXILIARY_SPECS[kind];
  if (!spec) return null;
  const existing = auxiliaryWindows.get(kind);
  if (existing && !existing.isDestroyed()) {
    if (show) { existing.show(); existing.focus(); }
    return existing;
  }
  const win = new BrowserWindow({
    width: spec.width,
    height: spec.height,
    minWidth: 560,
    minHeight: 440,
    icon: APP_ICON_PATH,
    title: spec.title,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#12131a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // HTML audio continues independently; the hidden controls need no full-rate UI clock.
      backgroundThrottling: true,
      additionalArguments: [
        `--harbour-token=${cfg.token}`,
        `--harbour-url=${encodeURIComponent(cfg.url)}`,
        `--harbour-surface=${kind}`,
        `--harbour-cowork-device=${encodeURIComponent(remoteBridge?.clientId || "")}`,
      ],
    },
  });
  removeWindowMenu(win);
  auxiliaryWindows.set(kind, win);
  if (kind === "call") {
    const contents = win.webContents;
    win.on("closed", () => voiceRequestBridge.close(contents));
    contents.on("will-navigate", () => voiceRequestBridge.close(contents));
    contents.on("render-process-gone", () => voiceRequestBridge.close(contents));
  }
  win.on("closed", () => auxiliaryWindows.delete(kind));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  await win.loadFile(rendererPagePath(spec.file));
  if (show) { win.show(); win.focus(); }
  return win;
}

function openDashboardLink({ url }) {
  const target = chatWindowUrl(url, cfg.url);
  if (target) void createDashboardSurface("chat", target).catch(error => console.warn("[harbour-desktop] 对话窗口打开失败", error.message));
  else shell.openExternal(url);
  return { action: "deny" };
}

async function createDashboardSurface(kind, chatTarget = null) {
  const hash = kind === "tasks" ? "#cron" : "#chat";
  if (chatTarget && (kind !== "chat" || !chatWindowUrl(chatTarget, cfg.url))) throw new Error("invalid chat window target");
  // Explicit new-window gestures never focus/reuse another conversation window.
  const key = `surface:${kind}${chatTarget ? `:${randomUUID()}` : ""}`;
  const existing = auxiliaryWindows.get(key);
  if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return existing; }
  const win = new BrowserWindow({
    width: kind === "tasks" ? 1120 : 1040,
    height: 760,
    minWidth: 800,
    minHeight: 560,
    icon: APP_ICON_PATH,
    title: kind === "tasks" ? "Harbour · 任务" : "Harbour · 对话",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [
        `--harbour-token=${cfg.token}`,
        `--harbour-url=${encodeURIComponent(cfg.url)}`,
        `--harbour-surface=${kind}`,
        `--harbour-cowork-device=${encodeURIComponent(remoteBridge?.clientId || "")}`,
      ],
    },
  });
  removeWindowMenu(win);
  auxiliaryWindows.set(key, win);
  closeGuard.register(win, { required: true });
  win.on("closed", () => auxiliaryWindows.delete(key));
  win.webContents.setWindowOpenHandler(openDashboardLink);
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key !== "F5" && !((input.control || input.meta) && input.key.toLowerCase() === "r")) return;
    event.preventDefault();
    void closeGuard.run(win, "reload", () => win.loadURL(win.webContents.getURL()));
  });
  win.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    void closeGuard.run(win, "navigate", () => win.loadURL(url));
  });
  await win.loadURL(chatTarget || `${cfg.url.replace(/\/+$/, "")}/${hash}`);
  return win;
}

async function openCompanionWindow(kind) {
  if (kind === "music") { await setMusicProvider("folia"); return folia.open("window"); }
  if (kind === "chat" || kind === "tasks") return createDashboardSurface(kind);
  if (kind === "call") await createConfiguredPetWindows();
  return createAuxiliaryWindow(kind);
}

async function executeMusicCommand(command) {
  const action = String(command?.action || "");
  if (command?.player === "folia") await setMusicProvider("folia");
  if (currentMusicProvider() === "folia") {
    const { lyrics, ...result } = await folia.command(command);
    return result;
  }
  if (currentMusicProvider() === "qqmusic") {
    if (action === "set_volume") throw new Error("QQ 音乐 Provider 不接管系统音量；请在 QQ 音乐或系统中调整");
    if (action === "search") throw new Error("QQ 音乐的云端搜索由已登录客户端负责，Harbour 不读取账号或私有接口");
    const result = action === "status" ? await qqMusicBridge.status() : await qqMusicBridge.execute(action);
    publishMusicState(qqMusicStateForBridge(result));
    return result;
  }
  const win = await createAuxiliaryWindow("music", { show: action === "open" });
  if (!win || win.isDestroyed()) throw new Error("音乐窗口不可用");
  if (action === "open") return { opened: true };
  const commandId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingMusicCommands.delete(commandId);
      reject(new Error("本地音乐播放器执行超时"));
    }, 6_000);
    pendingMusicCommands.set(commandId, { win, resolve, reject, timer });
    win.webContents.send("desktop:music-command", { commandId, command });
  });
}

function startRemoteCompanionBridge() {
  if (remoteBridge) return;
  remoteBridge = new RemoteCompanionBridge({
    label: cfg.coworkLabel || require("node:os").hostname(),
    baseUrl: cfg.url,
    token: cfg.token,
    dataDir: app.getPath("userData"),
    onConnection: (connection) => { companionState.setConnection(connection); orb?.setConnection(connection); },
    onEvent: (event) => {
      companionState.consume(event);
      sendToPets("desktop:companion-event", event);
      if (orb) orb.consume(event); else orbSignals.consume(event);
    },
    onCommand: (capability, command) => {
      if (capability !== "music") throw new Error(`不支持的桌面能力：${capability}`);
      return executeMusicCommand(command);
    },
  });
  try {
    coworkExecutor = new CoworkExecutor({
      dataDir: app.getPath("userData"),
      deviceId: remoteBridge.clientId,
      label: cfg.coworkLabel,
      backendRoot: resolveBackendRoot(),
      baseUrl: cfg.url,
      token: cfg.token,
    });
    remoteBridge.setCoworkExecutor(coworkExecutor);
  } catch (error) {
    // A broken durable journal disables Cowork; companion/music remain available.
    console.error(`[harbour-desktop] Cowork unavailable: ${error.message}`);
  }
  remoteBridge.start();
  remoteBridge.updateMusicState(musicStateForBridge());
  syncMusicProviderPolling();
}

function petPositionPath(petId) {
  return path.join(app.getPath("userData"), petId === "elaina" ? "pet-position.json" : `pet-position-${petId}.json`);
}

function savedPetPosition(petId) {
  try {
    const value = JSON.parse(fs.readFileSync(petPositionPath(petId), "utf8"));
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
    const savedHeight = Number.isFinite(value.height)
      ? (Math.abs(value.height - PET_HEIGHT) <= 2 ? PET_HEIGHT : value.height)
      : PET_VISUAL_HEIGHT;
    // Position files written by the former 270px window stored its top-left corner. Preserve
    // the character's screen position by anchoring the enlarged transparent window at the
    // same bottom edge; future writes include the height and no longer need migration.
    const y = value.y + savedHeight - PET_HEIGHT;
    const visible = screen.getAllDisplays().some(({ workArea }) =>
      value.x + PET_WIDTH / 2 >= workArea.x && value.x + PET_WIDTH / 2 <= workArea.x + workArea.width &&
      y + PET_HEIGHT / 2 >= workArea.y && y + PET_HEIGHT / 2 <= workArea.y + workArea.height);
    return visible ? { x: value.x, y } : null;
  } catch {
    return null;
  }
}

function defaultPetPosition(petId) {
  const { workArea } = screen.getPrimaryDisplay();
  const order = [...new Set([...cfg.pets.map((pet) => pet.id), ...Object.keys(PET_CATALOG)])];
  const index = Math.max(0, order.indexOf(petId));
  return {
    x: workArea.x + workArea.width - PET_WIDTH - 22 - index * (PET_WIDTH + 12),
    y: workArea.y + workArea.height - PET_HEIGHT - 22,
  };
}

function revealPetWindow(win, petId) {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getContentBounds();
  const onScreen = screen.getAllDisplays().some(({ workArea }) =>
    bounds.x < workArea.x + workArea.width
    && bounds.x + bounds.width > workArea.x
    && bounds.y < workArea.y + workArea.height
    && bounds.y + bounds.height > workArea.y);
  if (!onScreen) {
    const pos = defaultPetPosition(petId);
    win.setContentBounds({ x: pos.x, y: pos.y, width: PET_WIDTH, height: PET_HEIGHT }, false);
  }
  win.setOpacity(1);
  win.showInactive();
  applyPetWindowLayer(win, petAlwaysOnTop(), { raise: true });
}

function runtimeForPet(petId) {
  let state = petRuntime.get(petId);
  if (!state) {
    state = {
      positionTimer: null,
      topmostTimer: null,
      nativeDragging: false,
      dragDirection: null,
      inputRegions: [],
      mouseInteractive: null,
      lastCursorX: null,
      lastCursorY: null,
      dragTracker: null,
    };
    petRuntime.set(petId, state);
    state.dragTracker = createPetDragState({
      onDirection: (direction) => sendPetDragDirection(petId, direction),
      onActiveChange: (active) => { state.nativeDragging = active; },
      onSettled: () => rememberPetPosition(petId),
    });
  }
  return state;
}

function rememberPetPosition(petId, immediate = false) {
  const win = petWindows.get(petId);
  if (!win || win.isDestroyed()) return;
  const state = runtimeForPet(petId);
  clearTimeout(state.positionTimer);
  const persist = () => {
    state.positionTimer = null;
    const current = petWindows.get(petId);
    if (!current || current.isDestroyed()) return;
    const { x, y } = current.getContentBounds();
    try {
      // Persist the requested CSS-pixel height rather than Windows' DPI-rounded native value;
      // otherwise a 332px window can be reported as 333px and drift by one pixel per restart.
      fs.writeFileSync(petPositionPath(petId), JSON.stringify({ x, y, height: PET_HEIGHT }), "utf8");
    } catch {
      /* 位置记忆失败不影响桌宠 */
    }
  };
  if (immediate) persist();
  else state.positionTimer = setTimeout(persist, 180);
}

function trackPetMovement(petId) {
  const win = petWindows.get(petId);
  if (!win || win.isDestroyed()) return;
  const state = runtimeForPet(petId);
  const { x, y } = win.getContentBounds();
  state.dragTracker?.move({ x, y });
  rememberPetPosition(petId);
}

function sendPetDragDirection(petId, direction) {
  const win = petWindows.get(petId);
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  const state = runtimeForPet(petId);
  const next = direction === "left" || direction === "right" ? direction : null;
  if (state.dragDirection === next) return;
  state.dragDirection = next;
  win.webContents.send("desktop:pet-drag-direction", next);
}

function startPetCursorTracking() {
  const visible = !visualPolicy.quiet && !visualPolicy.locked
    && [...petWindows.values()].some(win => !win.isDestroyed() && win.isVisible());
  if (!visible) {
    clearInterval(petCursorTimer);
    petCursorTimer = null;
    return;
  }
  if (petCursorTimer) return;
  petCursorTimer = setInterval(() => {
    const cursor = screen.getCursorScreenPoint();
    for (const [petId, win] of petWindows) {
      if (!win || win.isDestroyed() || !win.isVisible() || win.webContents.isDestroyed()) continue;
      const bounds = win.getContentBounds();
      const local = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
      const state = runtimeForPet(petId);
      const interactive = state.inputRegions.some((region) =>
        local.x >= region.x && local.x < region.x + region.width
        && local.y >= region.y && local.y < region.y + region.height);
      if (state.mouseInteractive !== interactive) {
        state.mouseInteractive = interactive;
        win.setIgnoreMouseEvents(!interactive, { forward: true });
      }
      // A stationary cursor must not keep resetting the renderer's return-to-centre timer.
      // Still recompute hit regions above because speech/task cards can appear under it.
      if (state.lastCursorX !== local.x || state.lastCursorY !== local.y) {
        state.lastCursorX = local.x;
        state.lastCursorY = local.y;
        win.webContents.send("desktop:pet-cursor", local);
      }
    }
  }, 90);
}

function closePetWindow(petId) {
  const win = petWindows.get(petId);
  if (!win || win.isDestroyed()) return false;
  // A pet has no editable document. Explicitly closing it must release the
  // renderer/model/textures, not just hide a still-subscribed speaking pet.
  runtimeForPet(petId).dragTracker?.finish();
  rememberPetPosition(petId, true);
  win.destroy(); // The closed handler owns timers, speech and registration cleanup.
  return true;
}

function closeAllPetWindows() {
  for (const petId of [...petWindows.keys()]) closePetWindow(petId);
}

function createTray() {
  if (!tray || tray.isDestroyed()) {
    let source = nativeImage.createFromPath(APP_ICON_PATH);
    if (source.isEmpty()) source = nativeImage.createFromPath(packagedWebAssetPath("assets", "elaina-avatar.png"));
    const icon = source.isEmpty() ? nativeImage.createEmpty() : source.resize({ width: 20, height: 20 });
    tray = new Tray(icon);
    tray.on("click", () => runDesktopAction("show pets", createConfiguredPetWindows));
    tray.on("double-click", () => runDesktopAction("open dashboard", createDashboardWindow));
  }
  const petNames = cfg.pets.map((pet) => pet.displayName).join(" + ");
  tray.setToolTip(petNames ? `Harbour · ${petNames}` : "Harbour");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示悬浮助手", click: () => runDesktopAction("show orb", () => orbController().setEnabled(true)) },
    { label: "隐藏悬浮助手（任务继续）", enabled: orb?.enabled === true,
      click: () => runDesktopAction("hide orb", () => orbController().setEnabled(false)) },
    { label: "悬浮助手置顶", type: "checkbox", checked: orb?.alwaysOnTop !== false,
      click: item => orbController().setAlwaysOnTop(item.checked) },
    { type: "separator" },
    ...cfg.pets.map((pet) => ({
      label: `显示 ${pet.displayName} 桌宠`,
      click: () => runDesktopAction(`show ${pet.id}`, () => createPetWindow(pet.id)),
    })),
    ...(cfg.pets.length ? [{ type: "separator" }] : []),
    {
      label: "桌面宠物",
      enabled: cfg.pets.length > 0,
      submenu: cfg.pets.flatMap((pet, index) => [
        { label: `显示 ${pet.displayName}`, click: () => runDesktopAction(`show ${pet.id}`, () => createPetWindow(pet.id)) },
        { label: `关闭 ${pet.displayName}（释放资源）`, click: () => closePetWindow(pet.id) },
        {
          label: `${characterStore?.voiceEnabled(pet.id) ? "关闭" : "开启"} ${pet.displayName} 语音`,
          click: () => setPetVoiceEnabled(pet.id, !characterStore.voiceEnabled(pet.id)),
        },
        ...(index < cfg.pets.length - 1 ? [{ type: "separator" }] : []),
      ]),
    },
    { label: "显示全部桌宠", enabled: cfg.pets.length > 0, click: () => runDesktopAction("show all pets", createConfiguredPetWindows) },
    { label: "关闭全部桌宠（释放资源）", enabled: cfg.pets.length > 0, click: closeAllPetWindows },
    {
      label: "桌宠始终置顶",
      type: "checkbox",
      enabled: cfg.pets.length > 0,
      checked: petAlwaysOnTop(),
      click: (item) => setPetAlwaysOnTop(item.checked),
    },
    { type: "separator" },
    { label: "音乐陪伴", click: () => openCompanionWindow("music") },
    { label: "语音通话", click: () => openCompanionWindow("call") },
    { label: "智能表情包", click: () => openCompanionWindow("stickers") },
    { label: "桌面陪伴设置", click: () => openCompanionWindow("companion") },
    { label: "性能 · 游戏避让", submenu: [
      ["auto", "自动避让全屏游戏 / 演示"], ["quiet", "静默视觉（任务、音乐继续）"], ["normal", "正常视觉（仍暂停隐藏页面）"],
    ].map(([mode, label]) => ({ label, type: "radio", checked: visualPolicy.mode === mode,
      click: () => runDesktopAction("visual policy", () => { visualPolicy.setMode(mode); createTray(); }) })) },
    { type: "separator" },
    { label: "独立对话窗口", click: () => openCompanionWindow("chat") },
    { label: "独立任务窗口", click: () => openCompanionWindow("tasks") },
    { type: "separator" },
    { label: "打开 Harbour", click: () => createDashboardWindow() },
    { type: "separator" },
    { label: serviceActionState === "restarting" ? "后端服务正在重启…" : "重启后端服务", enabled: serviceActionState === "idle",
      click: () => serviceActions.restartBackend() },
    { label: serviceActionState === "client-restarting" ? "客户端正在重启…" : "重启 Harbour 客户端", enabled: serviceActionState === "idle",
      click: () => serviceActions.restartClient() },
    { type: "separator" },
    { label: "退出 Harbour", click: () => app.quit() },
  ]));
  return tray;
}

function runDesktopAction(label, action) {
  void Promise.resolve()
    .then(action)
    .catch((error) => console.error(`[desktop] ${label} failed`, error));
}

function registerWindowsUserTasks() {
  if (process.platform !== "win32") return true;
  const launchArguments = (...flags) => buildDesktopLaunchArguments({
    isPackaged: app.isPackaged,
    appDirectory: __dirname,
    flags,
  });
  const petTasks = cfg.pets.slice(0, 5).map((pet) => ({
    program: process.execPath,
    arguments: launchArguments(`--harbour-show-pet=${pet.id}`),
    iconPath: APP_ICON_PATH,
    iconIndex: 0,
    title: `显示 ${pet.displayName} 桌宠`,
    description: `恢复并显示 ${pet.displayName} 桌面角色`,
  }));
  const registered = app.setUserTasks([
    ...petTasks,
    {
      program: process.execPath,
      arguments: launchArguments("--harbour-open-dashboard"),
      iconPath: APP_ICON_PATH,
      iconIndex: 0,
      title: "打开 Harbour",
      description: "打开 Harbour 主界面",
    },
  ]);
  if (!registered) console.warn("[desktop] Windows taskbar user tasks were not registered");
  return registered;
}

function repairWindowsShortcutIdentity() {
  if (process.platform !== "win32") return [];
  const roots = [
    app.getPath("desktop"),
    process.env.APPDATA && path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"),
    process.env.APPDATA && path.join(process.env.APPDATA, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar"),
  ].filter(Boolean);
  const repaired = [];
  for (const root of roots) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (!/^harbour(?: \(\d+\))?\.lnk$/i.test(name)) continue;
      const shortcutPath = path.join(root, name);
      try {
        const details = shell.readShortcutLink(shortcutPath);
        const sameExecutable = path.resolve(details.target) === path.resolve(process.execPath);
        const sameDevelopmentApp = app.isPackaged || String(details.args || "").toLowerCase().includes(__dirname.toLowerCase());
        if (!sameExecutable || !sameDevelopmentApp || details.appUserModelId === "org.harbour.public") continue;
        if (shell.writeShortcutLink(shortcutPath, "update", {
          ...details,
          target: details.target,
          appUserModelId: "org.harbour.public",
        })) repaired.push(shortcutPath);
      } catch (error) {
        console.warn(`[desktop] could not refresh shortcut identity: ${shortcutPath}`, error);
      }
    }
  }
  return repaired;
}

function setPetVoiceEnabled(petId, enabled) {
  initCompanionRuntime();
  characterStore.setVoiceEnabled(petId, enabled);
  if (!enabled) {
    cancelPetSpeechRequests(petId);
    if (audioFocus?.petId === petId) audioFocus = null;
  }
  const win = petWindows.get(petId);
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send("desktop:companion-voice-changed", !!enabled);
  }
  createTray();
  return !!enabled;
}

function petSpeechRequestKey(petId, requestId = "") {
  const id = String(petId || "").replace(/[^a-z0-9_-]/gi, "").toLowerCase();
  const request = String(requestId || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 80);
  return id && request ? `${id}:${request}` : "";
}

function cancelPetSpeechRequests(petId) {
  const id = String(petId || "").replace(/[^a-z0-9_-]/gi, "").toLowerCase();
  return id ? (ttsClient?.cancelPrefix(`${id}:`) || 0) : 0;
}

function petDefinition(petId) {
  if (!cfg.petEnabled) return null;
  const id = String(petId || "").trim().toLowerCase();
  const existing = cfg.pets.find((pet) => pet.id === id) || PET_CATALOG[id];
  if (existing) return existing;
  const conventional = normalizePetDefinition(id);
  if (!conventional) return null;
  PET_CATALOG[id] = conventional;
  return conventional;
}

function petAlwaysOnTop(appearance = characterStore?.appearance()) {
  return appearance?.alwaysOnTop !== false;
}

function applyPetWindowLayer(win, enabled, { raise = false } = {}) {
  if (!win || win.isDestroyed()) return false;
  try {
    if (enabled) {
      // A desktop companion must not activate/minimise an exclusive game when clicked.
      // Mouse input and native drag regions continue to work on a non-focusable HWND.
      if (process.platform === "win32") win.setFocusable(false);
      win.setAlwaysOnTop(true, PET_ALWAYS_ON_TOP_LEVEL);
      if (process.platform !== "win32") {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      }
      if (raise && win.isVisible()) win.moveTop();
    } else {
      win.setAlwaysOnTop(false);
      if (process.platform === "win32") win.setFocusable(true);
      if (process.platform !== "win32") win.setVisibleOnAllWorkspaces(false);
    }
    return true;
  } catch (error) {
    console.warn("[desktop] could not apply pet window layer", error);
    return false;
  }
}

function schedulePetTopmostRestore(petId, delayMs = 60) {
  const state = runtimeForPet(petId);
  clearTimeout(state.topmostTimer);
  state.topmostTimer = null;
  if (!petAlwaysOnTop()) return;
  state.topmostTimer = setTimeout(() => {
    state.topmostTimer = null;
    const win = petWindows.get(petId);
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    // `moveTop` changes only Z-order; it intentionally does not steal focus from the game.
    applyPetWindowLayer(win, true, { raise: true });
  }, Math.max(0, Number(delayMs) || 0));
}

function applyPetAlwaysOnTop(appearance = characterStore?.appearance()) {
  const enabled = petAlwaysOnTop(appearance);
  for (const [petId, win] of petWindows) {
    if (!win || win.isDestroyed()) continue;
    const state = runtimeForPet(petId);
    clearTimeout(state.topmostTimer);
    state.topmostTimer = null;
    applyPetWindowLayer(win, enabled, { raise: enabled });
  }
  return enabled;
}

function setPetAlwaysOnTop(enabled) {
  initCompanionRuntime();
  const appearance = characterStore.setAppearance({ alwaysOnTop: !!enabled });
  companionState.setAppearance(appearance);
  applyPetAlwaysOnTop(appearance);
  createTray();
  return appearance.alwaysOnTop;
}

async function createPetWindow(petId = cfg.pets[0]?.id) {
  const pet = petDefinition(petId);
  if (!pet) return null;
  const existing = petWindows.get(pet.id);
  if (existing && !existing.isDestroyed()) {
    revealPetWindow(existing, pet.id);
    return existing;
  }
  const pos = savedPetPosition(pet.id) || defaultPetPosition(pet.id);
  const alwaysOnTop = petAlwaysOnTop();
  const win = new BrowserWindow({
    width: PET_WIDTH,
    height: PET_HEIGHT,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop,
    focusable: !(process.platform === "win32" && alwaysOnTop),
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    title: pet.displayName,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Let hide/minimize reach Page Visibility so the pet stops WebGL rendering.
      // Visible unfocused pets still animate; connection/task state stays in the shared bridge.
      backgroundThrottling: true,
      additionalArguments: [
        `--harbour-token=${cfg.token}`,
        `--harbour-url=${encodeURIComponent(cfg.url)}`,
        `--harbour-pet-id=${encodeURIComponent(pet.id)}`,
        `--harbour-pet-agent=${encodeURIComponent(pet.agentName)}`,
        `--harbour-pet-name=${encodeURIComponent(pet.displayName)}`,
      ],
    },
  });
  // Electron 的 width/height 默认描述外框；桌宠的 DOM 与拖动锚点使用的是内容坐标。
  // 显式锁定 content bounds，避免 Windows DPI/隐藏边框令角色与光标产生固定偏移。
  win.setContentBounds({ x: pos.x, y: pos.y, width: PET_WIDTH, height: PET_HEIGHT }, false);
  petWindows.set(pet.id, win);
  const state = runtimeForPet(pet.id);
  // Keep the transparent margins click-through from the first frame. Cursor tracking enables
  // input only while the pointer is over a renderer-reported interactive region.
  win.setIgnoreMouseEvents(true, { forward: true });
  state.mouseInteractive = false;
  applyPetWindowLayer(win, alwaysOnTop);
  win.on("will-move", () => {
    const { x, y } = win.getContentBounds();
    state.dragTracker?.begin({ x, y });
  });
  win.on("move", () => trackPetMovement(pet.id));
  win.on("moved", () => {
    state.dragTracker?.finish();
    rememberPetPosition(pet.id);
    schedulePetTopmostRestore(pet.id);
  });
  // `moved` is not reliable on every Windows native-drag path. Blur/hide plus the tracker's
  // settle timer guarantee that a long press can never leave the running animation latched.
  win.on("blur", () => {
    state.dragTracker?.finish();
    schedulePetTopmostRestore(pet.id);
  });
  win.on("hide", () => {
    state.dragTracker?.finish();
    clearTimeout(state.topmostTimer);
    state.topmostTimer = null;
    startPetCursorTracking();
  });
  win.on("show", () => {
    schedulePetTopmostRestore(pet.id, 0);
    startPetCursorTracking();
  });
  let revealTimer = null;
  win.on("closed", () => {
    clearTimeout(revealTimer);
    clearTimeout(state.positionTimer);
    clearTimeout(state.topmostTimer);
    state.dragTracker?.dispose();
    if (petWindows.get(pet.id) === win) {
      cancelPetSpeechRequests(pet.id);
      if (audioFocus?.petId === pet.id) audioFocus = null;
      petRuntime.delete(pet.id);
      petWindows.delete(pet.id);
    }
    startPetCursorTracking();
  });
  const reveal = () => {
    clearTimeout(revealTimer);
    revealTimer = null;
    if (win.isDestroyed() || petWindows.get(pet.id) !== win) return;
    revealPetWindow(win, pet.id);
  };
  win.once("ready-to-show", reveal);
  // Transparent GPU windows can finish loading without reliably emitting ready-to-show.
  // Keep a deterministic second path so a taskbar launch never leaves a hidden renderer.
  win.webContents.once("did-finish-load", reveal);
  revealTimer = setTimeout(reveal, 1500);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("context-menu", () => {
    Menu.buildFromTemplate([
      { label: "打开 Harbour", click: () => createDashboardWindow() },
      { label: "音乐陪伴", click: () => openCompanionWindow("music") },
      { label: "语音通话", click: () => openCompanionWindow("call") },
      { label: "智能表情包", click: () => openCompanionWindow("stickers") },
      { label: "桌面陪伴设置", click: () => openCompanionWindow("companion") },
      {
        label: "始终置顶",
        type: "checkbox",
        checked: petAlwaysOnTop(),
        click: (item) => setPetAlwaysOnTop(item.checked),
      },
      { type: "separator" },
      { label: `关闭 ${pet.displayName}（释放资源）`, click: () => closePetWindow(pet.id) },
      { label: "退出 Harbour", click: () => app.quit() },
    ]).popup({ window: win });
  });
  // Model acquisition is needed only when a pet is actually requested, not for
  // Dashboard-only launches. Existing assets/settings remain on disk after close.
  if (pet.id === "elaina") void startLive2dBootstrap();
  try {
    await win.loadFile(petPagePath(), {
      query: { pet: pet.id, agent: pet.agentName, name: pet.displayName },
    });
  } catch (error) {
    if (win.isDestroyed()) return null; // User closed it during initial loading.
    closePetWindow(pet.id);
    throw error;
  }
  if (win.isDestroyed()) return null;
  startPetCursorTracking();
  return win;
}

async function createConfiguredPetWindows() {
  await Promise.all(cfg.pets.map((pet) => createPetWindow(pet.id)));
}

async function handleDesktopLaunch(argv = process.argv) {
  const intent = parseDesktopLaunchIntent(argv);
  if (intent.kind === "pet") {
    await createPetWindow(intent.petId);
    return intent;
  }
  if (intent.kind === "pets") {
    await createConfiguredPetWindows();
    return intent;
  }
  // A normal launch (including a second-instance activation) opens only the
  // Dashboard. Keep pet capability/settings intact, but do not create a hidden
  // renderer or acquire/load Live2D until the user explicitly opens a pet.
  await createDashboardWindow();
  return intent;
}

function orbController() {
  if (!orb) {
    orb = new OrbController({ BrowserWindow, screen, Menu, dataDir: app.getPath("userData"), getConfig: () => cfg,
      agents: Object.values(buildPetCatalog(cfg.pets)), deviceId: remoteBridge?.clientId || require("node:os").hostname(),
      getAppearance: () => characterStore?.appearance() || {}, signals: orbSignals,
      voiceChoice: input => { initCompanionRuntime(); return ttsClient.voiceChoice("orb", input); },
      openMusic: () => executeMusicCommand({ action: "open" }),
      music: { getState: () => currentMusicProvider() === "folia" ? folia.status() : musicStateForBridge(), execute: command => executeMusicCommand(command),
        openFolia: () => executeMusicCommand({ action: "open", player: "folia" }) },
      getAvatar: agent => {
        const file = { "main-elaina": "elaina-avatar.png", "main-aemeath": "orb/aemeath-avatar-v4.png" }[agent];
        const avatar = file && nativeImage.createFromPath(packagedWebAssetPath("assets", file));
        return avatar && !avatar.isEmpty() ? avatar.resize({ width: 128 }).toDataURL() : "";
      },
      getExpressionAtlas: agent => {
        const file = { "main-elaina": "elaina-expressions-v2.png", "main-aemeath": "aemeath-expressions-v4.png" }[agent];
        const asset = file && packagedWebAssetPath("assets", "orb", file);
        // Only bundled, fixed public assets; no renderer-supplied filesystem path.
        return asset && fs.existsSync(asset) ? pathToFileURL(asset).href : "";
      },
      getPeekAtlas: agent => {
        const file = { "main-elaina": "elaina-peek-v3.png", "main-aemeath": "aemeath-peek-v5.png" }[agent];
        const asset = file && packagedWebAssetPath("assets", "orb", file);
        return asset && fs.existsSync(asset) ? pathToFileURL(asset).href : "";
      },
      getPeekBlinkAtlas: agent => {
        const file = { "main-elaina": "elaina-peek-blink-v3.png", "main-aemeath": "aemeath-peek-blink-v5.png" }[agent];
        const asset = file && packagedWebAssetPath("assets", "orb", file);
        return asset && fs.existsSync(asset) ? pathToFileURL(asset).href : "";
      },
      desktopActions: createOrbDesktop({ clipboard, desktopCapturer: require("electron").desktopCapturer, shell, getWindow: () => orb?.win }),
      isQuitting: () => closeGuard.quitting,
      onVisibility: () => { if (tray && !tray.isDestroyed()) createTray(); },
      openConversation: async target => { conversationLink.enqueue(target); await createDashboardWindow(); conversationLink.flush(); },
      openDashboard: createDashboardWindow, openSettings: () => openCompanionWindow("companion"),
    });
    orb.setConnection(companionState?.connection || "connecting");
    if (tray && !tray.isDestroyed()) createTray();
  }
  return orb;
}
ipcMain.handle("desktop:orb-action", (event, input) => orbController().action(event, input));
ipcMain.handle("desktop:orb-status", event => {
  if (!trustedDesktopSender(event) || event.senderFrame !== event.sender.mainFrame) throw new Error("invalid desktop window");
  const controller = orbController();
  return { enabled: controller.enabled, autoStart: controller.autoStart };
});
ipcMain.handle("desktop:orb-enable", (event, enabled) => {
  if (!trustedDesktopSender(event) || event.senderFrame !== event.sender.mainFrame || typeof enabled !== "boolean") throw new Error("invalid desktop window");
  return orbController().setEnabled(enabled);
});
ipcMain.handle("desktop:orb-autostart", (event, enabled) => {
  if (!trustedDesktopSender(event) || event.senderFrame !== event.sender.mainFrame || typeof enabled !== "boolean") throw new Error("invalid desktop window");
  return orbController().setAutoStart(enabled);
});
// A fixed, synchronous boolean only: offline documents must not consume startup,
// and choosing diagnostics must not leave subsequent reloads in startup mode.
ipcMain.on("desktop:startup-context", event => {
  event.returnValue = !!(startupSplash?.active && mainWindow && !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents && event.senderFrame === event.sender.mainFrame);
});
ipcMain.handle("desktop:open-dashboard", async () => { await createDashboardWindow(); return true; });
let attachmentOpener;
ipcMain.handle("desktop:open-attachment", (event, input) => {
  const windows = [mainWindow, ...[...auxiliaryWindows].filter(([key]) => key.startsWith("surface:")).map(([, win]) => win)];
  if (!authorizeFileSender(event, windows, cfg.url)) throw new Error("invalid attachment window");
  attachmentOpener ??= createFileOpener({ getConfig: () => cfg, cacheRoot: path.join(app.getPath("userData"), "file-previews"), shell });
  return attachmentOpener(input);
});
ipcMain.handle("desktop:voice-request", (event, input) => voiceRequestBridge.request(event, input));
ipcMain.handle("desktop:voice-choice", (event, input) => voiceRequestBridge.choice(event, input));
ipcMain.on("desktop:voice-cancel", event => { try { voiceRequestBridge.cancel(event); } catch { /* Untrusted or departed frame. */ } });
ipcMain.handle("desktop:open-conversation", async (event, value) => {
  const sender = trustedDesktopSender(event);
  const target = conversationTarget(value);
  if (!sender?.startsWith("pet:") || event.senderFrame !== event.sender.mainFrame || !target
    || petDefinition(sender.slice(4))?.agentName !== target.agentName) return false;
  conversationLink.enqueue(target);
  await createDashboardWindow();
  conversationLink.flush();
  return true;
});
ipcMain.on("desktop:conversation-ready", (event) => {
  if (trustedDesktopSender(event) !== "dashboard" || event.senderFrame !== event.sender.mainFrame) return;
  conversationLink.ready(event.sender);
});
function desktopDeviceInfo() {
  if (coworkExecutor) return coworkExecutor.hello();
  // A failed Cowork journal must not erase the companion/music device identity.
  return remoteBridge?.clientId ? {
    deviceId: remoteBridge.clientId, label: remoteBridge.label,
    platform: process.platform, arch: process.arch, hostname: require("node:os").hostname(), tools: [],
  } : null;
}
ipcMain.handle("desktop:cowork-device", (event) => {
  if (!trustedDesktopSender(event)) throw new Error("invalid desktop window");
  return desktopDeviceInfo();
});
ipcMain.handle("desktop:reload-dashboard", (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents !== event.sender
    || event.senderFrame !== event.sender.mainFrame) return false;
  return closeGuard.run(mainWindow, "reload", () => refreshDashboard(mainWindow));
});
ipcMain.handle("desktop:copy-image", (event, dataUrl) => {
  // 只接受 Dashboard 自己送来的、有界 PNG data URL。网页端会先把 JPEG/WebP/GIF
  // 当前帧转成 PNG；这里用 Electron 原生剪贴板兜住远端 HTTP 非 secure-context 的情况。
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents !== event.sender) return false;
  if (typeof dataUrl !== "string"
    || !/^data:image\/png;base64,[a-z0-9+/=]+$/i.test(dataUrl)
    || dataUrl.length > 64 * 1024 * 1024) return false;
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) return false;
  clipboard.writeImage(image);
  return true;
});
ipcMain.handle("desktop:show-pet", async (_event, petId) => {
  if (petId) await createPetWindow(String(petId));
  else await createConfiguredPetWindows();
  return true;
});
ipcMain.handle("desktop:hide-pet", (event, petId) => {
  const sender = trustedDesktopSender(event);
  if (!sender || event.senderFrame !== event.sender.mainFrame) return false;
  // A late IPC from an old pet cannot close a freshly reopened instance/peer.
  if (sender.startsWith("pet:")) {
    const id = sender.slice(4);
    if (petId && String(petId) !== id) return false;
    closePetWindow(id);
  } else if (sender === "dashboard" || sender === "companion") {
    if (petId) closePetWindow(String(petId));
    else closeAllPetWindows();
  } else return false;
  return true;
});
ipcMain.handle("desktop:is-pet-visible", (_event, petId) => {
  if (petId) {
    const win = petWindows.get(String(petId));
    return !!win && !win.isDestroyed() && win.isVisible();
  }
  return [...petWindows.values()].some((win) => !win.isDestroyed() && win.isVisible());
});

function petWindowFromSender(event, petId) {
  const id = String(petId || "");
  const win = petWindows.get(id);
  if (!win || win.isDestroyed() || win.webContents !== event.sender) return null;
  return { id, win };
}

function auxiliaryKindFromSender(event) {
  for (const [kind, win] of auxiliaryWindows) {
    if (!win.isDestroyed() && win.webContents === event.sender) return kind;
  }
  return null;
}

function trustedDesktopSender(event) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents === event.sender) return "dashboard";
  const auxiliary = auxiliaryKindFromSender(event);
  if (auxiliary) return auxiliary;
  for (const [id, win] of petWindows) if (!win.isDestroyed() && win.webContents === event.sender) return `pet:${id}`;
  return null;
}

ipcMain.handle("desktop:companion-character", async (event, petId) => {
  const sender = trustedDesktopSender(event);
  const id = String(petId || (sender?.startsWith("pet:") ? sender.slice(4) : ""));
  if (!sender || !petDefinition(id)) throw new Error("invalid companion window");
  initCompanionRuntime();
  const character = characterStore.readCharacter(id);
  const owner = petWindowFromSender(event, id);
  const voiceService = await ttsClient.status(owner ? petSpeechRequestKey(id, `status-${randomUUID()}`) : undefined);
  if (owner && (owner.win.isDestroyed() || petWindows.get(id) !== owner.win)) return null;
  return {
    manifest: character.manifest,
    assetBase: `harbour-character://${id}/`,
    voiceEnabled: characterStore.voiceEnabled(id),
    voiceService,
  };
});

ipcMain.handle("desktop:companion-set-voice", (event, petId, enabled) => {
  const target = petWindowFromSender(event, petId);
  if (!target) throw new Error("invalid companion window");
  return setPetVoiceEnabled(target.id, !!enabled);
});

ipcMain.handle("desktop:companion-synthesize", async (event, petId, request) => {
  const target = petWindowFromSender(event, petId);
  if (!target) throw new Error("invalid companion window");
  initCompanionRuntime();
  if (!characterStore.voiceEnabled(target.id)) throw new Error("该角色语音已关闭");
  const text = String(request?.text || "").trim();
  const requestId = String(request?.requestId || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 80);
  if (!requestId || !text || text.length > 1200) throw new Error("invalid companion speech request");
  const { manifest } = characterStore.readCharacter(target.id);
  const platform = String(request?.source?.platform || "web").toLowerCase();
  const allowed = Array.isArray(manifest.voice?.allowedSources) ? manifest.voice.allowedSources.map((item) => String(item).toLowerCase()) : [];
  if (allowed.length && !allowed.includes(platform)) throw new Error(`语音未对 ${platform} 来源开启`);
  return ttsClient.synthesize(petSpeechRequestKey(target.id, requestId), {
    characterId: target.id,
    text,
    emotion: String(request?.emotion || "neutral").slice(0, 40),
    source: { platform },
  });
});

ipcMain.handle("desktop:companion-cancel-speech", (event, petId, requestId, terminate = false) => {
  const target = petWindowFromSender(event, petId);
  if (!target) return false;
  if (terminate) {
    cancelPetSpeechRequests(target.id);
    if (audioFocus?.petId === target.id) audioFocus = null;
    return true;
  }
  if (requestId) return ttsClient?.cancel(petSpeechRequestKey(target.id, requestId)) || false;
  cancelPetSpeechRequests(target.id);
  if (audioFocus?.petId === target.id) audioFocus = null;
  return true;
});

ipcMain.handle("desktop:companion-audio-focus", (event, petId, action, requestId) => {
  const target = petWindowFromSender(event, petId);
  if (!target) return false;
  const id = String(requestId || "").slice(0, 80);
  if (action === "release") {
    if (audioFocus?.petId === target.id && audioFocus?.requestId === id) audioFocus = null;
    return true;
  }
  if (audioFocus && Date.now() - audioFocus.acquiredAt < 120_000 && audioFocus.petId !== target.id) return false;
  audioFocus = { petId: target.id, requestId: id, acquiredAt: Date.now() };
  return true;
});

ipcMain.handle("desktop:companion-open-folder", (event, petId) => {
  const sender = trustedDesktopSender(event);
  const id = String(petId || (sender?.startsWith("pet:") ? sender.slice(4) : ""));
  if (!sender || !petDefinition(id)) return false;
  initCompanionRuntime();
  shell.openPath(characterStore.characterDir(id));
  return true;
});

ipcMain.handle("desktop:companion-state", (event) => {
  if (!trustedDesktopSender(event)) throw new Error("invalid desktop window");
  return companionState.snapshot();
});

ipcMain.handle("desktop:companion-music-control", (event, command) => {
  const sender = trustedDesktopSender(event);
  if (event.senderFrame !== event.sender.mainFrame
    || !(sender === 'dashboard' || sender?.startsWith('pet:'))) throw new Error('invalid music control window');
  return folia.command(musicTransport(command, currentMusicProvider(), folia.status()));
});

ipcMain.handle("desktop:companion-dismiss-bubble", (event, petId, bubbleId) => {
  if (event.senderFrame !== event.sender.mainFrame || !petWindowFromSender(event, petId)) return false;
  return companionState.dismissBubble(petId, bubbleId);
});

ipcMain.handle("desktop:companion-set-appearance", (event, patch) => {
  const sender = trustedDesktopSender(event);
  if (!sender || (sender !== "dashboard" && sender !== "companion")) throw new Error("appearance changes require Dashboard or Companion Settings");
  if (sender === "dashboard" && characterStore.appearance().followDashboard === false) return characterStore.appearance();
  const appearance = characterStore.setAppearance(patch || {});
  companionState.setAppearance(appearance);
  applyPetAlwaysOnTop(appearance);
  createTray();
  return appearance;
});

ipcMain.handle("desktop:companion-set-visual", (event, petId, visualMode) => {
  const sender = trustedDesktopSender(event);
  const id = String(petId || "");
  if (sender !== "companion" || !characterStore.setVisualMode(id, String(visualMode))) return false;
  const win = petWindows.get(id);
  if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
  return true;
});

ipcMain.handle("desktop:companion-open-window", (event, kind) => {
  if (!trustedDesktopSender(event)) return false;
  const value = String(kind || "");
  if (!["companion", "music", "stickers", "call", "chat", "tasks"].includes(value)) return false;
  void openCompanionWindow(value);
  return true;
});

ipcMain.handle("desktop:music-list", (event) => {
  if (auxiliaryKindFromSender(event) !== "music") throw new Error("invalid music window");
  return musicStore.list();
});

function foliaDashboard(event) {
  if (event.senderFrame !== event.sender.mainFrame || trustedDesktopSender(event) !== "dashboard") throw new Error("Folia 宿主操作只接受 Dashboard");
  return mainWindow;
}
function townDashboard(event) {
  if (event.senderFrame !== event.sender.mainFrame || trustedDesktopSender(event) !== 'dashboard'
    || new URL(event.sender.getURL()).origin !== new URL(cfg.url).origin) throw new Error('小镇宿主操作只接受 Dashboard');
  return mainWindow;
}
function townController() {
  if (!town) town = new TownController({ url: cfg.url, token: cfg.token,
    onState: state => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:town-state', state); },
    onWindow: win => {
      closeGuard.register(win, { required: true });
      win.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        if (input.key === 'Escape' && win.isFullScreen()) { event.preventDefault(); win.setFullScreen(false); }
        if (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r')) {
          event.preventDefault(); void closeGuard.run(win, 'reload', () => win.webContents.reload());
        }
      });
    },
    onReturn: async () => { const win = await createDashboardWindow(); win.show(); win.focus(); win.webContents.send('desktop:town-return'); },
  });
  return town;
}
registerTownIpc({ ipcMain, controller: townController, dashboard: townDashboard });
ipcMain.handle("desktop:folia-status", event => { foliaDashboard(event); return folia.status(); });
ipcMain.handle("desktop:folia-open", async (event, mode, bounds) => {
  const win = foliaDashboard(event);
  if (!["embedded", "window", "remote"].includes(mode)) throw new Error("未知音乐窗口模式");
  await setMusicProvider("folia");
  return folia.open(mode, win, scaledFoliaBounds(win, bounds));
});
ipcMain.on("desktop:folia-resize", (event, bounds, visible) => {
  try {
    const win = foliaDashboard(event);
    folia.resize(win, scaledFoliaBounds(win, bounds), visible !== false);
  } catch { /* A departed renderer cannot resize another surface. */ }
});
ipcMain.handle("desktop:folia-hide", event => { folia.hide(foliaDashboard(event)); return true; });
ipcMain.handle("desktop:folia-device-menu", (event, request) => folia.showDeviceMenu(foliaDashboard(event), request));
ipcMain.on("desktop:folia-device-menu-close", event => {
  try { folia.closeDeviceMenu(foliaDashboard(event)); } catch { /* Departed/untrusted frames cannot affect another surface. */ }
});
ipcMain.handle("desktop:folia-command", async (event, command) => {
  foliaDashboard(event);
  await setMusicProvider("folia");
  return folia.command(command || {});
});
ipcMain.handle("desktop:folia-legacy", async (event, mode) => {
  foliaDashboard(event);
  if (mode === 'player') {
    if (currentMusicProvider() === 'folia') await setMusicProvider('local');
    await createAuxiliaryWindow('music', { show: true });
    return { opened: true };
  }
  // Existing copies and metadata remain untouched; user can import this folder in Folia.
  await shell.openPath(musicStore.tracksDir);
  return { tracks: musicStore.list().length, path: musicStore.tracksDir };
});

ipcMain.handle("desktop:music-provider-get", (event) => {
  if (auxiliaryKindFromSender(event) !== "music") throw new Error("invalid music window");
  return { provider: currentMusicProvider(), state: companionState.music };
});

ipcMain.handle("desktop:music-provider-set", async (event, provider) => {
  if (auxiliaryKindFromSender(event) !== "music") throw new Error("invalid music window");
  const state = await setMusicProvider(provider);
  return { provider: currentMusicProvider(), state };
});

ipcMain.handle("desktop:qqmusic-command", async (event, action) => {
  if (auxiliaryKindFromSender(event) !== "music") throw new Error("invalid music window");
  const result = await qqMusicBridge.execute(String(action || ""));
  const state = publishMusicState(qqMusicStateForBridge(result));
  return { result, state };
});

ipcMain.handle("desktop:qqmusic-status", async (event) => {
  if (auxiliaryKindFromSender(event) !== "music") throw new Error("invalid music window");
  const state = await refreshQQMusicState();
  return { provider: currentMusicProvider(), state };
});

ipcMain.handle("desktop:music-import", async (event) => {
  if (auxiliaryKindFromSender(event) !== "music") throw new Error("invalid music window");
  const win = auxiliaryWindows.get("music");
  const selection = await dialog.showOpenDialog(win, {
    title: "导入到 Harbour 本地曲库",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "音频", extensions: ["mp3", "flac", "m4a", "aac", "wav", "ogg", "opus", "webm"] }],
  });
  if (selection.canceled) return [];
  const imported = musicStore.importFiles(selection.filePaths);
  if (currentMusicProvider() === "local") publishMusicState(musicStateForBridge({}, "local"));
  return imported;
});

ipcMain.handle("desktop:music-remove", async (event, trackId) => {
  if (auxiliaryKindFromSender(event) !== "music") return false;
  const id = String(trackId || "");
  const file = musicStore.resolve(id);
  if (!file) return false;
  // Keep deletion recoverable: the copied audio goes to the OS recycle bin before its library
  // entry is removed. The original source file is never touched.
  try { await shell.trashItem(file); } catch { return false; }
  const removed = musicStore.remove(id);
  if (currentMusicProvider() === "local") {
    const next = musicStateForBridge({ currentTrackId: companionState.music.currentTrackId === id ? undefined : companionState.music.currentTrackId }, "local");
    publishMusicState(next);
  }
  return removed;
});

ipcMain.on("desktop:music-state", (event, state) => {
  if (auxiliaryKindFromSender(event) !== "music" || !state || typeof state !== "object") return;
  if (currentMusicProvider() !== "local") return;
  const playback = {
    loaded: state.loaded === true,
    paused: state.paused !== false,
    volume: Math.max(0, Math.min(100, Number(state.volume) || 0)),
    positionMs: Math.max(0, Number(state.positionMs) || 0),
    durationMs: Math.max(0, Number(state.durationMs) || 0),
    currentTrackId: String(state.currentTrackId || "").slice(0, 120) || null,
  };
  const next = musicStateForBridge({ ...playback, currentTrackId: playback.currentTrackId || undefined }, "local");
  publishMusicState(next);
});

ipcMain.on("desktop:music-command-result", (event, message) => {
  const pending = pendingMusicCommands.get(String(message?.commandId || ""));
  if (!pending || pending.win.webContents !== event.sender) return;
  clearTimeout(pending.timer);
  pendingMusicCommands.delete(message.commandId);
  if (message.ok === false) pending.reject(new Error(String(message.error || "音乐播放器执行失败")));
  else pending.resolve(message.result ?? { ok: true });
});

ipcMain.handle("desktop:sticker-list", (event, companionId) => {
  if (!trustedDesktopSender(event)) throw new Error("invalid desktop window");
  return stickerStore.list(String(companionId || "elaina"));
});

ipcMain.handle("desktop:sticker-choose", async (event) => {
  if (auxiliaryKindFromSender(event) !== "stickers") throw new Error("invalid sticker window");
  const win = auxiliaryWindows.get("stickers");
  const selection = await dialog.showOpenDialog(win, {
    title: "选择本地表情包",
    properties: ["openFile"],
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
  });
  if (selection.canceled || !selection.filePaths[0]) return null;
  const selected = selection.filePaths[0];
  pendingStickerSelections.set(event.sender.id, selected);
  return { path: selected, previewUrl: pathToFileURL(selected).toString(), label: path.basename(selected, path.extname(selected)) };
});

ipcMain.handle("desktop:sticker-add", (event, input) => {
  if (auxiliaryKindFromSender(event) !== "stickers") throw new Error("invalid sticker window");
  const selected = pendingStickerSelections.get(event.sender.id);
  pendingStickerSelections.delete(event.sender.id);
  if (!selected || path.resolve(selected) !== path.resolve(String(input?.path || ""))) throw new Error("请先通过选择器选取表情包");
  return stickerStore.importFile(selected, input || {});
});

ipcMain.handle("desktop:sticker-enabled", (event, id, enabled) => {
  if (auxiliaryKindFromSender(event) !== "stickers") return false;
  return stickerStore.setEnabled(String(id || ""), !!enabled);
});

ipcMain.handle("desktop:sticker-remove", async (event, id) => {
  if (auxiliaryKindFromSender(event) !== "stickers") return false;
  const file = stickerStore.resolve(String(id || ""));
  if (!file) return false;
  try { await shell.trashItem(file); } catch { return false; }
  return stickerStore.remove(String(id || ""));
});

ipcMain.on("desktop:pet-input-regions", (event, petId, regions) => {
  const target = petWindowFromSender(event, petId);
  if (!target || !Array.isArray(regions)) return;
  const { width: contentWidth, height: contentHeight } = target.win.getContentBounds();
  const safe = regions.slice(0, 16).flatMap((region) => {
    if (!region || ![region.x, region.y, region.width, region.height].every(Number.isFinite)) return [];
    const x = Math.max(0, Math.floor(region.x));
    const y = Math.max(0, Math.floor(region.y));
    const right = Math.min(contentWidth, Math.ceil(region.x + region.width));
    const bottom = Math.min(contentHeight, Math.ceil(region.y + region.height));
    return right > x && bottom > y ? [{ x, y, width: right - x, height: bottom - y }] : [];
  });
  if (!safe.length) return;
  // BrowserWindow.setShape also clips drawing, and its native coordinate conversion is wrong
  // for transparent high-DPI windows on Windows. Retain the complete visual surface and use
  // setIgnoreMouseEvents from the cursor loop for region-aware click-through instead.
  runtimeForPet(target.id).inputRegions = safe;
});

async function bootstrap() {
  visualPolicy.start();
  startStartupSplash();
  initCompanionRuntime();
  registerCharacterProtocol();
  startRemoteCompanionBridge();
  const backendRoot = resolveBackendRoot();
  const shouldSpawn = cfg.spawn ?? (isLoopbackUrl(cfg.url) && !!backendRoot);
  let backendStartup = null;
  let backendSpawned = false;
  if (shouldSpawn) {
    const alreadyRunning = await waitForHealth(cfg.url, 1500);
    if (!alreadyRunning) {
      backendSpawned = spawnServer(backendRoot);
      if (backendSpawned) startupSplash?.update({ phase: "starting" });
      backendStartup = backendSpawned
        ? waitForBackendStartup()
        : Promise.resolve("failed");
    }
  }
  createTray();
  repairWindowsShortcutIdentity();
  registerWindowsUserTasks();
  startupSplash?.update({ phase: "opening" });
  await handleDesktopLaunch(process.argv);
  // A failed optional orb view must not terminate the Dashboard or owned backend.
  try { await orbController().start(); }
  catch (error) { console.warn("[harbour-desktop] 悬浮助手自启失败，可从托盘重新开启", error); }
  const orbShortcut = globalShortcut.register("CommandOrControl+Shift+Space", () => runDesktopAction("summon orb", async () => {
    const controller = orbController();
    if (!controller.enabled) await controller.setEnabled(true);
    await controller.expand(!controller.expanded, true);
  }));
  if (!orbShortcut) console.warn("[harbour-desktop] 悬浮助手快捷键已被占用，仍可使用托盘或设置开启");
  // Keep the native window responsive while the local backend boots. loadDashboard already
  // renders the themed offline page and its retry loop; startup diagnostics arrive separately.
  if (backendStartup) {
    const status = await backendStartup;
    if (closeGuard.quitting || status === "cancelled") return;
    if (status === "ready") {
      if (mainWindow && !mainWindow.isDestroyed()
        && !/^https?:/i.test(mainWindow.webContents.getURL())) await loadDashboard(mainWindow);
    } else if (status === "failed") {
      startupSplash?.update({ phase: "attention", reason: "backend", slow: true });
      dialog.showErrorBox(
        backendRoot ? "Harbour 后端启动失败" : "Harbour 后端路径不可用",
        `${serverStartupDiagnostic()}\n\n修复后可重新启动 Harbour。客户端会继续检查 ${cfg.url} 的连接，不会重复启动后端。`
      );
    }
  }
}

// Desktop bootstrap entry (isolated lifecycle fixtures stop before this point).
if (process.platform === "win32") app.setAppUserModelId("org.harbour.public");
if (!singleInstance) app.quit();
else app.whenReady().then(bootstrap).catch((error) => {
  startupSplash?.dispose();
  const detail = error instanceof Error ? (error.stack || error.message) : String(error);
  console.error("[harbour-desktop] 启动失败", error);
  try {
    dialog.showErrorBox(
      "Harbour Desktop 启动失败",
      `${detail}\n\n配置目录：${resolveHarbourDataRoot()}\n请从终端运行 npm run desktop 获取完整日志。`
    );
  } finally {
    app.exit(1);
  }
}).finally(() => { desktopBootstrapping = false; });

app.on("second-instance", (_event, commandLine) => {
  runDesktopAction("handle second instance", () => handleDesktopLaunch(commandLine));
});

app.on("window-all-closed", () => {
  // Skipping the early, disposable splash is not an application quit.
  if (desktopBootstrapping) return;
  // Cowork and companion work belong to the desktop process, not a renderer window.
  // Closing Dashboard keeps the authenticated worker alive until the tray's Quit action.
  if (process.platform !== "darwin" && (!tray || tray.isDestroyed())) app.quit();
});

app.on("activate", () => {
  createDashboardWindow();
  // macOS Dock activation restores the app, not pets the user explicitly closed.
});

// Only closeGuard's will-quit commit may stop owned services. Cancelling a renderer's
// close/quit prompt must leave the tray, Cowork, companion bridge and server intact.
async function cleanupDesktop() {
  visualPolicy.dispose(); ++musicProviderPollRevision;
  startupSplash?.dispose();
  globalShortcut.unregister("CommandOrControl+Shift+Space");
  orb?.dispose();
  clearTimeout(dashboardRetryTimer);
  if (petCursorTimer) clearInterval(petCursorTimer);
  if (musicProviderTimer) clearTimeout(musicProviderTimer);
  for (const state of petRuntime.values()) {
    clearTimeout(state.positionTimer);
    clearTimeout(state.topmostTimer);
  }
  if (tray && !tray.isDestroyed()) tray.destroy();
  coworkExecutor?.stop();
  remoteBridge?.stop();
  companionState?.dispose();
  for (const pending of pendingMusicCommands.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Harbour Desktop 正在退出"));
  }
  pendingMusicCommands.clear();
  ttsClient?.stop();
  town?.dispose();
  try { await folia?.close(); } catch (error) { console.error('[harbour-desktop] Folia cleanup:', error.message); }
  if (serverProc && !serverProc.killed && serverProc.pid) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(serverProc.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      try { process.kill(-serverProc.pid, "SIGTERM"); } catch { serverProc.kill(); }
    }
  }
}
