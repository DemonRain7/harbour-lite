// 预加载脚本：在页面脚本运行前，把注入的访问令牌写进 localStorage，
// 这样 dashboard（web/app.js 的 authToken()）能直接拿到，免去手动输入登录。
// 令牌通过 webPreferences.additionalArguments 以 --harbour-token=xxx 传入。

const { contextBridge, ipcRenderer } = require("electron");

function argumentValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  if (!arg) return "";
  try { return decodeURIComponent(arg.slice(prefix.length)); } catch { return arg.slice(prefix.length); }
}

const token = argumentValue("harbour-token");
const serverUrl = argumentValue("harbour-url") || "http://localhost:7788";
const surface = argumentValue("harbour-surface") || (argumentValue("harbour-pet-id") ? "pet" : "dashboard");
// Offline pages do not consume this per-window launch. F5 after entry keeps the
// usual navigation/history behavior; no backend session is created or cleared.
let startup = false;
try {
  startup = process.isMainFrame && surface === "dashboard" && argumentValue("harbour-startup") === "1"
    && /^https?:$/.test(location.protocol) && !sessionStorage.getItem("harbour-startup-entered")
    && ipcRenderer.sendSync("desktop:startup-context") === true;
  if (startup) history.replaceState(null, "", `${location.pathname}${location.search}#chat`);
} catch { /* storage unavailable: the regular Dashboard remains usable */ }
if (startup) ipcRenderer.once("desktop:startup-entered", () => {
  startup = false;
  try { sessionStorage.setItem("harbour-startup-entered", "1"); } catch { /* optional local navigation state */ }
});
const petsEnabled = argumentValue("harbour-pet-enabled") !== "0";
let petCatalog = [];
try {
  const parsed = JSON.parse(argumentValue("harbour-pets") || "[]");
  if (Array.isArray(parsed)) {
    petCatalog = parsed
      .filter((pet) => pet && typeof pet === "object")
      .map((pet) => ({
        id: String(pet.id || ""),
        agentName: String(pet.agentName || ""),
        displayName: String(pet.displayName || ""),
      }))
      .filter((pet) => pet.id && pet.agentName);
  }
} catch {
  petCatalog = [];
}
const petContext = argumentValue("harbour-pet-id") ? {
  id: argumentValue("harbour-pet-id"),
  agentName: argumentValue("harbour-pet-agent"),
  displayName: argumentValue("harbour-pet-name"),
} : null;

let beforeCloseHandler = null;
let conversationHandler = null;
let pendingConversation = null;
if (process.isMainFrame) ipcRenderer.on("desktop:open-conversation", (_event, target) => {
  if (conversationHandler) conversationHandler(target);
  else pendingConversation = target;
});
// Never expose ipcRenderer or a caller-supplied channel/request ID to page scripts.
// Only the current top-frame handler may answer a main-process lifecycle request.
if (process.isMainFrame) ipcRenderer.on("desktop:before-close", async (_event, payload) => {
  if (!payload || typeof payload.requestId !== "string"
    || !["close", "quit", "reload", "navigate"].includes(payload.reason)) return;
  const reply = (fields) => ipcRenderer.send("desktop:before-close-result", { requestId: payload.requestId, ...fields });
  if (!beforeCloseHandler) {
    reply(payload.required ? { phase: "unavailable" } : { phase: "result", allowed: true });
    return;
  }
  // A visible themed modal may legitimately remain open for minutes. The heartbeat
  // distinguishes that from a hung renderer without timing out the user's decision.
  reply({ phase: "pending" });
  const timer = setInterval(() => reply({ phase: "pending" }), 1_000);
  try {
    const allowed = await beforeCloseHandler({ reason: payload.reason, phase: payload.phase });
    reply({ phase: "result", allowed: allowed === true });
  } catch {
    reply({ phase: "unavailable" });
  } finally { clearInterval(timer); }
});

if (token) {
  try {
    window.addEventListener("DOMContentLoaded", () => {
      try {
        if (localStorage.getItem("harbour-token") !== token) localStorage.setItem("harbour-token", token);
      } catch {
        /* ignore */
      }
    });
    // DOMContentLoaded 之前 localStorage 也已可用，提前写一次更稳。
    localStorage.setItem("harbour-token", token);
  } catch {
    /* localStorage 可能在极早期还不可用，忽略 */
  }
}

contextBridge.exposeInMainWorld("harbourDesktop", {
  isElectron: true,
  getVisualPolicy: () => ipcRenderer.invoke("desktop:visual-policy"),
  onVisualPolicy: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("desktop:visual-policy", listener);
    return () => ipcRenderer.removeListener("desktop:visual-policy", listener);
  },
  serverUrl,
  surface,
  startup,
  ...(process.isMainFrame && surface === "dashboard" ? {
    startupReady: payload => {
      if (!startup) return;
      ipcRenderer.send("desktop:startup-ready", payload);
    },
    startupStatus: reason => { if (startup) ipcRenderer.send("desktop:startup-status", { reason }); },
    onStartupEntered: callback => {
      if (typeof callback !== "function") return () => {};
      const listener = () => callback();
      ipcRenderer.once("desktop:startup-entered", listener);
      return () => ipcRenderer.removeListener("desktop:startup-entered", listener);
    },
  } : {}),
  ...(process.isMainFrame && surface === 'dashboard' ? {
    townStatus: () => ipcRenderer.invoke('desktop:town-status'),
    townOpen: (mode, bounds, visible) => ipcRenderer.invoke('desktop:town-open', mode, bounds, visible),
    townResize: (bounds, visible) => ipcRenderer.send('desktop:town-resize', bounds, visible),
    townHide: () => ipcRenderer.invoke('desktop:town-hide'),
    onTownState: fn => { const listener = (_event, state) => fn(state); ipcRenderer.on('desktop:town-state', listener); return () => ipcRenderer.removeListener('desktop:town-state', listener); },
    onTownReturn: fn => { const listener = () => fn(); ipcRenderer.on('desktop:town-return', listener); return () => ipcRenderer.removeListener('desktop:town-return', listener); },
  } : {}),
  ...(process.isMainFrame && surface === "call" ? {
    voiceRequest: (pathname, body) => ipcRenderer.invoke("desktop:voice-request", { pathname, body }),
    voiceChoice: input => ipcRenderer.invoke("desktop:voice-choice", input),
    cancelVoiceRequests: () => ipcRenderer.send("desktop:voice-cancel"),
  } : {}),
  onBeforeClose: (handler) => {
    if (!process.isMainFrame || typeof handler !== "function") return () => {};
    beforeCloseHandler = handler;
    return () => { if (beforeCloseHandler === handler) beforeCloseHandler = null; };
  },
  usesSharedCompanionBridge: true,
  coworkDeviceId: argumentValue("harbour-cowork-device") || null,
  getCoworkDevice: () => ipcRenderer.invoke("desktop:cowork-device"),
  getCoworkDeviceInfo: () => ipcRenderer.invoke("desktop:cowork-device"),
  petContext,
  petCatalog,
  petsEnabled,
  ...(process.isMainFrame && ["dashboard", "chat", "tasks"].includes(surface) ? {
    openAttachment: (input) => ipcRenderer.invoke("desktop:open-attachment", input),
  } : {}),
  ...(process.isMainFrame && ["dashboard", "companion"].includes(surface) ? {
    orbStatus: () => ipcRenderer.invoke("desktop:orb-status"),
    setOrbEnabled: enabled => ipcRenderer.invoke("desktop:orb-enable", enabled === true),
    setOrbAutoStart: enabled => ipcRenderer.invoke("desktop:orb-autostart", enabled === true),
  } : {}),
  openDashboard: () => ipcRenderer.invoke("desktop:open-dashboard"),
  openConversation: (target) => ipcRenderer.invoke("desktop:open-conversation", target),
  onOpenConversation: (handler) => {
    if (!process.isMainFrame || surface !== "dashboard" || typeof handler !== "function") return () => {};
    conversationHandler = handler;
    ipcRenderer.send("desktop:conversation-ready");
    if (pendingConversation) { const target = pendingConversation; pendingConversation = null; handler(target); }
    return () => { if (conversationHandler === handler) conversationHandler = null; };
  },
  dismissCompanionBubble: (bubbleId, petId = petContext?.id) => ipcRenderer.invoke("desktop:companion-dismiss-bubble", petId, bubbleId),
  reloadDashboard: () => ipcRenderer.invoke("desktop:reload-dashboard"),
  copyImage: (dataUrl) => ipcRenderer.invoke("desktop:copy-image", dataUrl),
  showPet: (petId = petContext?.id) => ipcRenderer.invoke("desktop:show-pet", petId || null),
  hidePet: (petId = petContext?.id) => ipcRenderer.invoke("desktop:hide-pet", petId || null),
  petVisible: (petId = petContext?.id) => ipcRenderer.invoke("desktop:is-pet-visible", petId || null),
  setPetInputRegions: (regions, petId = petContext?.id) => ipcRenderer.send("desktop:pet-input-regions", petId || null, regions),
  getCompanionCharacter: (petId = petContext?.id) => ipcRenderer.invoke("desktop:companion-character", petId || null),
  setCompanionVoice: (enabled, petId = petContext?.id) => ipcRenderer.invoke("desktop:companion-set-voice", petId || null, !!enabled),
  synthesizeCompanionSpeech: (request, petId = petContext?.id) => ipcRenderer.invoke("desktop:companion-synthesize", petId || null, request),
  cancelCompanionSpeech: (requestId, terminate = false, petId = petContext?.id) => ipcRenderer.invoke("desktop:companion-cancel-speech", petId || null, requestId || null, !!terminate),
  companionAudioFocus: (action, requestId, petId = petContext?.id) => ipcRenderer.invoke("desktop:companion-audio-focus", petId || null, action, requestId || null),
  openCompanionFolder: (petId = petContext?.id) => ipcRenderer.invoke("desktop:companion-open-folder", petId || null),
  getCompanionState: () => ipcRenderer.invoke("desktop:companion-state"),
  controlCompanionMusic: (command) => ipcRenderer.invoke("desktop:companion-music-control", command),
  setCompanionAppearance: (appearance) => ipcRenderer.invoke("desktop:companion-set-appearance", appearance || {}),
  setCompanionVisualMode: (petId, visualMode) => ipcRenderer.invoke("desktop:companion-set-visual", petId || null, visualMode),
  openCompanionWindow: (kind) => ipcRenderer.invoke("desktop:companion-open-window", kind),
  listMusic: () => ipcRenderer.invoke("desktop:music-list"),
  getMusicProvider: () => ipcRenderer.invoke("desktop:music-provider-get"),
  foliaStatus: () => ipcRenderer.invoke("desktop:folia-status"),
  foliaOpen: (mode, bounds) => ipcRenderer.invoke("desktop:folia-open", mode, bounds),
  foliaResize: (bounds, visible = true) => ipcRenderer.send("desktop:folia-resize", bounds, visible),
  foliaHide: () => ipcRenderer.invoke("desktop:folia-hide"),
  foliaDeviceMenu: request => ipcRenderer.invoke("desktop:folia-device-menu", request),
  foliaCloseDeviceMenu: () => ipcRenderer.send("desktop:folia-device-menu-close"),
  foliaCommand: (command) => ipcRenderer.invoke("desktop:folia-command", command),
  foliaLegacyLibrary: (mode) => ipcRenderer.invoke("desktop:folia-legacy", mode),
  setMusicProvider: (provider) => ipcRenderer.invoke("desktop:music-provider-set", provider),
  getQQMusicStatus: () => ipcRenderer.invoke("desktop:qqmusic-status"),
  controlQQMusic: (action) => ipcRenderer.invoke("desktop:qqmusic-command", action),
  importMusic: () => ipcRenderer.invoke("desktop:music-import"),
  removeMusic: (trackId) => ipcRenderer.invoke("desktop:music-remove", trackId),
  reportMusicState: (state) => ipcRenderer.send("desktop:music-state", state || {}),
  listStickers: (companionId = petContext?.id || "elaina") => ipcRenderer.invoke("desktop:sticker-list", companionId),
  chooseSticker: () => ipcRenderer.invoke("desktop:sticker-choose"),
  addSticker: (input) => ipcRenderer.invoke("desktop:sticker-add", input || {}),
  setStickerEnabled: (id, enabled) => ipcRenderer.invoke("desktop:sticker-enabled", id, !!enabled),
  removeSticker: (id) => ipcRenderer.invoke("desktop:sticker-remove", id),
  onCompanionVoiceChanged: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, enabled) => callback(!!enabled);
    ipcRenderer.on("desktop:companion-voice-changed", listener);
    return () => ipcRenderer.removeListener("desktop:companion-voice-changed", listener);
  },
  onCompanionEvent: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("desktop:companion-event", listener);
    return () => ipcRenderer.removeListener("desktop:companion-event", listener);
  },
  onCompanionState: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("desktop:companion-state", listener);
    return () => ipcRenderer.removeListener("desktop:companion-state", listener);
  },
  onMusicCommand: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = async (_event, payload) => {
      const commandId = String(payload?.commandId || "");
      try {
        const result = await callback(payload?.command || {});
        ipcRenderer.send("desktop:music-command-result", { commandId, ok: true, result });
      } catch (error) {
        ipcRenderer.send("desktop:music-command-result", {
          commandId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    ipcRenderer.on("desktop:music-command", listener);
    return () => ipcRenderer.removeListener("desktop:music-command", listener);
  },
  onPetDragDirection: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, direction) => callback(direction === "left" || direction === "right" ? direction : null);
    ipcRenderer.on("desktop:pet-drag-direction", listener);
    return () => ipcRenderer.removeListener("desktop:pet-drag-direction", listener);
  },
  onPetCursor: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, point) => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      callback({ x: point.x, y: point.y });
    };
    ipcRenderer.on("desktop:pet-cursor", listener);
    return () => ipcRenderer.removeListener("desktop:pet-cursor", listener);
  },
});
