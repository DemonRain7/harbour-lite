"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { EDGES, RESIZE_EDGES, panelSize, resizePanel, placeOrb, dockAt, hitOrb, hitTrigger, withinOrb } = require("./orb-geometry");
const { OrbHover } = require("./orb-hover");
const { OrbChat } = require("./orb-chat");
const { OrbSignals } = require("./orb-signals");
const { revision, validReceipt } = require("./orb-read-state");
const { musicView, musicCommand } = require("./orb-music");
const { placeLyrics } = require("./orb-lyrics");

class OrbController {
  constructor({ BrowserWindow, screen, Menu, dataDir, getConfig, agents, deviceId, getAppearance,
    openConversation, openDashboard, openSettings, openMusic, music, signals, onVisibility = () => {}, isQuitting = () => false,
    hidden = false, getAvatar = () => "", getExpressionAtlas = () => "", getPeekAtlas = () => "", getPeekBlinkAtlas = () => "", desktopActions = {}, voiceChoice }) {
    Object.assign(this, { BrowserWindow, screen, Menu, getAppearance, openConversation, openDashboard, openSettings, openMusic, onVisibility, isQuitting, hidden });
    this.signals = signals || new OrbSignals({ agents: agents.map(a => a.agentName) });
    this.onSignals = () => this.publish(); this.signals.on("change", this.onSignals);
    this.agents = agents.map(a => ({ ...a, avatar: getAvatar(a.agentName), expressionAtlas: getExpressionAtlas(a.agentName),
      peekAtlas: getPeekAtlas(a.agentName), peekBlinkAtlas: getPeekBlinkAtlas(a.agentName) }));
    this.desktopActions = desktopActions;
    this.voiceChoice = voiceChoice;
    this.music = music; this.musicRevision = 0; this.musicWatching = false; this.musicBusy = false;
    this.win = null; this.expanded = false; this.pinned = false; this.connection = "connecting";
    this.statePath = path.join(dataDir, "orb-state.json");
    this.page = path.resolve(__dirname, "../renderer/orb.html");
    this.expectedUrl = pathToFileURL(this.page).href;
    let saved = {}; try { saved = JSON.parse(fs.readFileSync(this.statePath, "utf8")); } catch { /* First use. */ }
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) saved = {};
    // Last session's temporary hide is not an opt-out from launching next time.
    this.enabled = false;
    this.autoStart = saved.autoStart !== false;
    this.alwaysOnTop = saved.alwaysOnTop !== false;
    this.visibilityRevision = 0;
    this.stateRevision = 0;
    this.themePersona = getAppearance()?.persona;
    this.agent = this.themeAgent(this.themePersona) || (agents.some(a => a.agentName === saved.agent) ? saved.agent : agents[0].agentName);
    this.anchor = Number.isFinite(saved.x) && Number.isFinite(saved.y) ? { x: saved.x, y: saved.y } : null;
    this.dock = EDGES.includes(saved.dock) ? saved.dock : null;
    this.panelSize = panelSize(saved.panelSize); this.panelPlacement = null; this.resize = null;
    this.lyricOverlay = saved.lyricOverlay === true; this.musicOverlayVisible = false;
    this.hover = new OrbHover(); this.retracting = false; this.menuOpen = false;
    this.unreadAgents = new Set(); this.unreadSessions = new Map();
    this.chat = new OrbChat({ getConfig, deviceId, agents, onRead: event => this.consume(event), onChange: row => {
      if (row.sessionId && row.lastMessageRole === "assistant") {
        if (row.replyRevision > row.readReplyRevision || !revision(row.replyRevision) && row.phase === "complete" && !row.notificationRead) {
          const old = this.unreadSessions.get(row.sessionId);
          if (!old || !(old.replyRevision > row.replyRevision)) this.unreadSessions.set(row.sessionId, row);
          if (this.unreadSessions.size > 512) this.unreadSessions.delete(this.unreadSessions.keys().next().value);
        }
        const receipt = { id: row.sessionId, replyRevision: row.replyRevision, readReplyRevision: row.readReplyRevision };
        if (validReceipt(receipt)) { this.clearReadNotifications(receipt); this.signals.consume({ __harbour: "session-read", ...receipt }); }
        else if (row.notificationRead) this.unreadSessions.delete(row.sessionId);
      }
      this.updateUnreadAgents(); this.publish();
    } });
    this.onDisplayChange = () => {
      this.endResize(); this.panelPlacement = null;
      this.cancelRetraction(); this.drag = null; this.dropPoint = null; this.snapTarget = null;
      this.hover.reset(true); this.reflow(); this.save();
    };
    for (const event of ["display-removed", "display-metrics-changed"]) screen.on(event, this.onDisplayChange);
  }
  themeAgent(persona) { return this.agents.find(a => a.id === persona || a.agentName === `main-${persona}`)?.agentName; }
  setVisualQuiet(value) {
    if (this.visualQuiet === value) return;
    this.visualQuiet = value;
    this.syncHitTesting();
    if (value) { this.hover.reset(true); }
    else { this.publish(); this.publishMusic(); }
  }
  updateUnreadAgents() {
    this.unreadAgents = new Set([...this.unreadSessions.values()].map(row => row.agent));
  }
  clearReadNotifications(receipt) {
    if (!validReceipt(receipt)) return;
    const row = this.unreadSessions.get(receipt.id);
    if (row?.replyRevision > 0 && row.replyRevision <= receipt.readReplyRevision) this.unreadSessions.delete(receipt.id);
    this.updateUnreadAgents();
  }
  async reconcileReadState() {
    if (this.readReconcile || this.disposed) return;
    const wanted = new Map([...this.unreadSessions].map(([id, row]) => [id, row.agent]));
    for (const row of this.signals.tasks.values()) if (row.sessionId && ["complete", "error", "unknown"].includes(row.phase)) wanted.set(row.sessionId, row.agent);
    if (!wanted.size) return;
    const serverUrl = this.chat.getConfig().url;
    // One small metadata read per affected persona on reconnect, never polling
    // complete histories or loading a model just to remove a dot.
    this.readReconcile = (async () => {
      for (const agent of new Set(wanted.values())) {
        try {
          const result = await this.chat.request(`/api/conversations/explorer?agentName=${encodeURIComponent(agent)}`);
          if (this.disposed || this.chat.getConfig().url !== serverUrl) return;
          for (const session of result.sessions || []) if (session.agentName === agent && wanted.get(session.id) === agent && validReceipt(session)) {
            this.consume({ __harbour: "session-read", id: session.id, replyRevision: session.replyRevision,
              readReplyRevision: session.readReplyRevision, replyRunId: session.replyRunId });
          }
        } catch { /* Retain notifications; retry at the next real reconnect. */ }
      }
    })();
    try { await this.readReconcile; } finally { this.readReconcile = null; }
  }
  read(input) {
    const agent = input.agent || this.agent;
    if (!this.visualQuiet && this.enabled && this.expanded && agent === this.agent) {
      return this.chat.markRead(agent, input);
    }
    return false;
  }
  syncHitTesting() {
    const win = this.win;
    const active = !this.disposed && !this.visualQuiet && win && !win.isDestroyed() && win.isVisible();
    if (!active) { clearInterval(this.hitTimer); this.hitTimer = null; return; }
    if (this.hitTimer) return;
    this.hitTimer = setInterval(() => {
      if (this.win !== win || win.isDestroyed() || !win.isVisible() || !this.layout) return;
      const ignore = !this.drag && !this.resize && !this.menuOpen && !hitOrb(this.screen.getCursorScreenPoint(), this.layout);
      if (ignore !== this.ignoring) { this.ignoring = ignore; win.setIgnoreMouseEvents(ignore, { forward: true }); }
      this.samplePointer();
    }, 100);
    this.hitTimer.unref?.();
  }
  syncAppearance(appearance) {
    if (appearance.persona !== this.themePersona) {
      this.themePersona = appearance.persona;
      const agent = this.themeAgent(appearance.persona);
      if (agent && appearance.followDashboard !== false) {
        this.agent = agent; this.save();
        if (this.expanded) this.chat.load(agent).catch(() => {});
      }
    }
    this.publish();
  }
  owns(event) {
    return !!this.win && !this.win.isDestroyed() && event.sender === this.win.webContents
      && event.senderFrame === event.sender.mainFrame && event.senderFrame.url === this.expectedUrl
      && event.sender.getURL() === this.expectedUrl;
  }
  snapshot({ includeHistory = true } = {}) {
    const appearance = { ...this.getAppearance() };
    // A manually chosen orb persona keeps its own palette until the Dashboard changes
    // persona again. The label, avatar and actual Main are always the same person.
    if (appearance.category !== "premium" && !appearance.theme?.startsWith("premium")
      && this.themeAgent(appearance.persona) !== this.agent) {
      appearance.theme = this.agent === "main-aemeath" ? "anime-snowfleece" : "anime-wisteria";
    }
    return { stateRevision: this.stateRevision, enabled: this.enabled, autoStart: this.autoStart, expanded: this.expanded, pinned: this.pinned, alwaysOnTop: this.alwaysOnTop, agent: this.agent,
      agents: this.agents, layout: this.layout, connection: this.connection, appearance, chat: this.chat.snapshot(this.agent, { includeHistory }),
      signals: this.signals.snapshot(this.agent, this.connection), lyricOverlay: this.lyricOverlay,
      unread: this.unreadAgents.size > 0, unreadAgents: [...this.unreadAgents] };
  }
  publish() {
    if (this.consuming) { this.pendingPublish = true; return; }
    ++this.stateRevision;
    if (this.visualQuiet) return; // Keep the model state, replay the latest view on return.
    if (!this.win || this.win.isDestroyed() || this.win.webContents.isDestroyed?.()
      || this.rendererFailed || this.win.webContents.isLoadingMainFrame()) return;
    // Send one disabled state to stop renderer clocks, then leave a hidden
    // window asleep. The authenticated bridge still retains all task updates.
    if (!this.enabled && this.publishedEnabled === false) return;
    const row = this.chat.row(this.agent);
    const key = JSON.stringify([this.agent, row.sessionId, this.chat.historyRevision(row)]);
    if (!this.enabled || !this.expanded) this.sentHistoryKey = "";
    const includeHistory = this.enabled && this.expanded && this.sentHistoryKey !== key;
    this.win.webContents.send("orb:state", this.snapshot({ includeHistory }));
    this.publishedEnabled = this.enabled;
    if (includeHistory) this.sentHistoryKey = key;
  }
  musicSnapshot() {
    return { ...musicView(this.music?.getState(), !this.musicWatching), revision: this.musicRevision,
      supported: !!this.music, busy: this.musicBusy, lyricOverlay: this.lyricOverlay };
  }
  publishMusic() {
    ++this.musicRevision;
    if (this.visualQuiet) return;
    // Closed drawer + opted-out lyrics: no queue projection or IPC. A compact
    // lyric stream never republishes chat history or starts the audio owner.
    if (!this.enabled || !(this.musicWatching && this.expanded || this.lyricOverlay)) return;
    if (!this.win || this.win.isDestroyed() || this.rendererFailed || this.win.webContents.isLoadingMainFrame()) return;
    const view = this.musicSnapshot();
    const visible = this.lyricOverlay && view.loaded && view.provider === "folia";
    if (visible !== this.musicOverlayVisible) { this.musicOverlayVisible = visible; this.reflow(false); }
    this.win.webContents.send("orb:music", view);
  }
  setLyricOverlay(value) {
    if (typeof value !== "boolean") throw new Error("歌词开关必须为布尔值");
    const previous = this.lyricOverlay; this.lyricOverlay = value;
    try { this.save(); } catch (error) { this.lyricOverlay = previous; throw error; }
    if (!value) this.musicOverlayVisible = false;
    this.reflow(); this.publishMusic(); return this.musicSnapshot();
  }
  async controlMusic(command, openFolia = false) {
    if (!this.music) throw new Error("当前环境不支持音乐控制");
    if (this.musicBusy) throw new Error("正在处理上一项音乐操作，请稍候");
    const validated = openFolia ? null : musicCommand(command, this.music.getState());
    this.musicBusy = true; this.publishMusic();
    try {
      if (openFolia) await this.music.openFolia();
      else await this.music.execute(validated);
    } finally { this.musicBusy = false; this.publishMusic(); }
    return this.musicSnapshot();
  }
  save() {
    const committed = this.resize?.original;
    const value = { version: 4, enabled: this.enabled, autoStart: this.autoStart, alwaysOnTop: this.alwaysOnTop, agent: this.agent,
      ...(committed ? committed.anchor : this.anchor), dock: committed ? committed.dock : this.dock,
      panelSize: committed ? committed.size : this.panelSize, lyricOverlay: this.lyricOverlay };
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath + ".tmp", JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(this.statePath + ".tmp", this.statePath);
  }
  reflow(publish = true) {
    if (!this.anchor) {
      const area = this.screen.getPrimaryDisplay().workArea;
      this.anchor = { x: area.x + area.width - 46, y: area.y + area.height * .56 };
    }
    const area = this.screen.getDisplayNearestPoint({ x: Math.round(this.anchor.x), y: Math.round(this.anchor.y) }).workArea;
    const resting = placeOrb(this.anchor, area, false, this.dock);
    this.layout = { ...placeLyrics(placeOrb(resting.anchor, area, this.expanded || this.retracting, this.dock, this.panelSize, this.panelPlacement),
      area, this.enabled && this.lyricOverlay && this.musicOverlayVisible),
      resizing: this.resize?.edge || null, retracting: this.retracting, snapTarget: this.snapTarget || null };
    // Previewing must not save a shifted resting position on a short display.
    this.anchor = this.dock ? resting.anchor : this.layout.anchor;
    if (this.win && !this.win.isDestroyed()) this.win.setBounds(this.layout.bounds);
    if (publish) this.publish();
    else this.win?.webContents.send("orb:layout", this.layout);
  }
  async ensureWindow() {
    if (this.disposed) throw new Error("悬浮助手已经退出");
    if (this.loading) return this.loading;
    if (this.win && !this.win.isDestroyed()) {
      if (!this.rendererFailed && !this.win.webContents.isDestroyed()) return this.win;
      this.win.destroy();
    }
    this.rendererFailed = false;
    this.sentHistoryKey = ""; this.publishedEnabled = undefined;
    this.ignoring = false;
    this.reflow();
    const win = this.win = new this.BrowserWindow({ ...this.layout.bounds, title: "Harbour · 悬浮助手",
      show: false, frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
      resizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: this.alwaysOnTop,
      webPreferences: { preload: path.join(__dirname, "orb-preload.js"), contextIsolation: true,
        nodeIntegration: false, sandbox: true, backgroundThrottling: true, offscreen: this.hidden } });
    win.setMenu(null); win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", event => event.preventDefault());
    // Asset loading may outlive loadFile's promise. Replay updates suppressed by
    // isLoadingMainFrame (including tray show and WS state) once loading settles.
    win.webContents.on("did-stop-loading", () => {
      if (this.win === win) {
        this.sentHistoryKey = ""; this.publishedEnabled = undefined;
        this.publish(); this.publishMusic();
      }
    });
    win.on("close", event => { if (!this.isQuitting()) { event.preventDefault(); this.setEnabled(false).catch(() => win.hide()); } });
    win.on("closed", () => {
      if (this.win === win) { clearInterval(this.hitTimer); this.hitTimer = null; this.win = null; this.musicWatching = false; }
    });
    for (const event of ["show", "hide"]) win.on(event, () => this.syncHitTesting());
    win.on("blur", () => { if (this.drag) this.endDrag(); this.endResize(); });
    win.webContents.on("render-process-gone", () => {
      if (this.win !== win || this.disposed) return;
      this.rendererFailed = true;
      // Only the view failed. Keep the original Main request/session alive, and let
      // the next explicit show recreate the view instead of reusing a blank window.
      this.setEnabled(false).catch(() => { if (!win.isDestroyed()) win.hide(); });
    });
    win.webContents.on("context-menu", (_event, params) => {
      this.menuOpen = true;
      this.Menu.buildFromTemplate([
        ...(params.isEditable ? [{ role: "cut" }, { role: "copy" }, { role: "paste" }, { type: "separator" }] : []),
        { label: "打开 Harbour", click: () => this.openDashboard() },
        { label: "窗口置顶", type: "checkbox", checked: this.alwaysOnTop, click: item => this.setAlwaysOnTop(item.checked) },
        { label: "固定展开", type: "checkbox", checked: this.pinned, click: item => this.expand(true, item.checked) },
        { label: "恢复默认聊天框大小", enabled: !!this.panelSize, click: () => this.resetPanelSize() },
        { label: "桌面歌词", type: "checkbox", checked: this.lyricOverlay, click: item => this.setLyricOverlay(item.checked) },
        ...(this.dock ? [{ label: "移出屏幕边缘", click: () => this.undock() }] : []),
        { label: "桌面陪伴设置", click: () => this.openSettings() },
        { type: "separator" },
        { label: "隐藏悬浮助手（任务继续）", click: () => this.setEnabled(false) },
      ]).popup({ window: win, callback: () => { this.menuOpen = false; this.hover.reset(); } });
    });
    // Transparent shadow/margin never creates an invisible click-blocking rectangle.
    this.syncHitTesting();
    const loading = this.loading = Promise.resolve().then(() => win.loadFile(this.page)).then(() => {
      if (win.isDestroyed() || this.win !== win || this.disposed) throw new Error("悬浮助手窗口已关闭，请重新开启");
      this.publish(); return win;
    });
    try { return await loading; }
    catch (error) { if (!win.isDestroyed()) win.destroy(); throw error; }
    finally { if (this.loading === loading) this.loading = null; }
  }
  async setEnabled(enabled, { restoreDock = false } = {}) {
    const revision = ++this.visibilityRevision;
    this.endResize();
    this.cancelRetraction(); this.hover.reset(true);
    this.enabled = enabled === true; this.save();
    try {
      if (this.enabled) {
        const win = await this.ensureWindow();
        if (revision !== this.visibilityRevision || !this.enabled) return { enabled: this.enabled };
        // Explicit tray/settings/shortcut wake-up must reveal the ball, not just a
        // saved 8px edge tab or a minimized/click-through native window.
        this.drag = null; this.snapTarget = null;
        if (!restoreDock) this.dock = null;
        this.reflow(); this.save();
        this.ignoring = false; win.setIgnoreMouseEvents(false);
        if (!this.hidden) {
          if (win.isMinimized()) win.restore();
          win.showInactive();
        }
        win.setAlwaysOnTop(this.alwaysOnTop);
        if (!this.hidden) win.moveTop();
      } else {
        this.musicWatching = false;
        this.musicOverlayVisible = false;
        this.expanded = false; this.pinned = false; this.drag = null; this.menuOpen = false; this.panelPlacement = null;
        if (this.win && !this.win.isDestroyed()) { this.win.hide(); this.reflow(); }
      }
    } catch (error) {
      if (revision === this.visibilityRevision) { this.enabled = false; this.save(); }
      throw error;
    } finally {
      this.onVisibility(this.enabled); this.publish(); this.publishMusic();
    }
    return { enabled: this.enabled };
  }
  async start() {
    return this.autoStart ? this.setEnabled(true, { restoreDock: true }) : { enabled: this.enabled };
  }
  setAutoStart(value) {
    if (typeof value !== "boolean") throw new Error("自启设置必须为布尔值");
    const previous = this.autoStart;
    this.autoStart = value;
    try { this.save(); }
    catch (error) { this.autoStart = previous; throw error; }
    this.publish();
    return { autoStart: value };
  }
  setAlwaysOnTop(value) {
    if (typeof value !== "boolean") throw new Error("置顶设置必须为布尔值");
    this.alwaysOnTop = value;
    if (this.win && !this.win.isDestroyed()) this.win.setAlwaysOnTop(value);
    this.save(); this.publish(); this.onVisibility(this.enabled);
    return { alwaysOnTop: value };
  }
  cancelRetraction() {
    clearTimeout(this.retractTimer); this.retractTimer = null; this.retracting = false; this.retractionAutomatic = false;
  }
  samplePointer(now = Date.now()) {
    if (!this.enabled || !this.layout || this.disposed) return;
    const point = this.screen.getCursorScreenPoint();
    // Returning during the fade keeps a hover preview open. Explicit close
    // must not be undone by the pointer that is still over the handle.
    if (this.retracting && this.retractionAutomatic && withinOrb(point, this.layout)) {
      void this.expand(true, false, true).catch(() => {}); return;
    }
    const intent = this.hover.step({ now, inside: withinOrb(point, this.layout), trigger: hitTrigger(point, this.layout),
      expanded: this.expanded, pinned: this.pinned, held: !!this.drag || !!this.resize || this.menuOpen || this.retracting });
    if (intent) void this.expand(intent === "open", false, true).catch(() => {});
  }
  undock() {
    if (!this.dock) return this.snapshot();
    this.endResize(); this.panelPlacement = null;
    const edge = this.dock;
    this.cancelRetraction(); this.hover.reset(true); this.dock = null;
    this.anchor = { x: this.anchor.x + (edge === "left" ? 72 : edge === "right" ? -72 : 0),
      y: this.anchor.y + (edge === "top" ? 72 : edge === "bottom" ? -72 : 0) };
    this.reflow(); this.save(); return this.snapshot();
  }
  async expand(expanded, pinned = this.pinned, automatic = false) {
    if (!this.enabled) return this.snapshot();
    if (!expanded) this.endResize();
    const wasExpanded = this.expanded;
    this.cancelRetraction();
    this.pinned = pinned === true; this.expanded = expanded === true;
    this.hover.reset(!this.expanded && !automatic);
    if (!this.expanded) { this.pinned = false; this.musicWatching = false; }
    if (wasExpanded && !this.expanded && this.dock && this.win && !this.win.isDestroyed()) {
      // Fade/slide the content first, then shrink the native hit surface. Hover
      // reopening, hide, display changes and drag all cancel this one-shot timer.
      this.retracting = true;
      this.retractionAutomatic = automatic;
      this.retractTimer = setTimeout(() => { this.cancelRetraction(); this.panelPlacement = null; this.reflow(); }, 180);
      this.retractTimer.unref?.();
    }
    if (!this.expanded && !this.retracting) this.panelPlacement = null;
    this.reflow();
    if (this.expanded) {
      if (this.pinned && !this.hidden && !automatic) { this.win?.show(); this.win?.focus(); }
      if (!wasExpanded) {
        this.chat.load(this.agent).catch(error => { this.win?.webContents.send("orb:notice", error.message); });
        this.chat.refreshAsks().catch(() => {});
      }
    }
    return this.snapshot();
  }
  startDrag() {
    if (!this.enabled) return;
    this.endResize(); this.panelPlacement = null;
    this.cancelRetraction(); this.hover.reset(true);
    this.drag = { cursor: this.screen.getCursorScreenPoint(), anchor: { ...this.anchor }, dock: this.dock, moved: false };
    this.dropPoint = null;
  }
  moveDrag() {
    if (!this.drag) return;
    const cursor = this.screen.getCursorScreenPoint(), d = this.drag;
    const dx = cursor.x - d.cursor.x, dy = cursor.y - d.cursor.y;
    if (!d.moved && Math.hypot(dx, dy) < 6) return;
    d.moved = true; this.expanded = false; this.pinned = false; this.dock = null;
    this.anchor = { x: d.anchor.x + dx, y: d.anchor.y + dy };
    // Keep the raw drop point separately: reflow clamps the painted circle into the display.
    this.dropPoint = { ...this.anchor };
    this.snapTarget = dockAt(this.dropPoint, this.screen.getDisplayNearestPoint(this.dropPoint).workArea, d.dock);
    this.reflow(false);
  }
  endDrag() {
    const moved = this.drag?.moved === true;
    if (moved) {
      const point = this.dropPoint || this.anchor;
      this.dock = dockAt(point, this.screen.getDisplayNearestPoint(point).workArea, this.drag.dock);
    }
    this.hover.reset(true); this.drag = null; this.dropPoint = null; this.snapTarget = null;
    this.reflow(); this.save(); return moved;
  }
  startResize(edge) {
    if (!RESIZE_EDGES.includes(edge)) throw new Error("无效的聊天框边界");
    if (!this.enabled || !this.expanded || this.retracting || this.drag || !this.layout?.panel)
      throw new Error("请先展开悬浮聊天框");
    if (this.resize) return false;
    this.cancelRetraction(); this.hover.reset(true);
    this.resize = { edge, cursor: { ...this.screen.getCursorScreenPoint() }, layout: this.layout,
      work: this.screen.getDisplayNearestPoint(this.anchor).workArea, moved: false,
      original: { size: this.panelSize, placement: this.panelPlacement, anchor: { ...this.anchor }, dock: this.dock } };
    this.panelPlacement = this.layout.placement; this.pinned = true;
    this.ignoring = false; this.win?.setIgnoreMouseEvents(false);
    this.reflow(); return true;
  }
  moveResize(delta = null) {
    const r = this.resize; if (!r) return false;
    const cursor = this.screen.getCursorScreenPoint();
    const next = resizePanel(r.layout, r.work, r.edge, delta || { x: cursor.x - r.cursor.x, y: cursor.y - r.cursor.y });
    if (!next) return false;
    const p = this.layout.panel;
    if (p.width === next.size.width && p.height === next.size.height) return false;
    r.moved = true; this.panelSize = panelSize(next.size); this.panelPlacement = next.placement; this.anchor = next.anchor;
    // Keep docking when its attachment point stays put. Pulling the attached
    // border inward deliberately frees the panel, without a snap or jump.
    const rest = placeOrb(next.anchor, r.work, false, this.dock).anchor;
    if (this.dock && (Math.abs(rest.x - next.anchor.x) > 1 || Math.abs(rest.y - next.anchor.y) > 1)) this.dock = null;
    this.reflow(false); return true;
  }
  endResize(cancel = false) {
    const r = this.resize; if (!r) return false;
    this.resize = null;
    if (cancel) {
      this.panelSize = r.original.size; this.panelPlacement = r.original.placement;
      this.anchor = r.original.anchor; this.dock = r.original.dock;
    }
    this.hover.reset(true); this.reflow();
    // Do not turn a click or display fitting into a saved size; write once at
    // gesture completion, never once per pointer move / progress update.
    if (r.moved && !cancel) this.save();
    return r.moved;
  }
  resetPanelSize() {
    this.endResize(true); this.panelSize = null; this.panelPlacement = null;
    this.reflow(); this.save(); return true;
  }
  async action(event, input = {}) {
    if (!this.owns(event)) throw new Error("悬浮助手只接受本地专属窗口的请求");
    const action = input?.action;
    if (action === "state") return this.snapshot();
    if (action === "music-watch") {
      this.musicWatching = input.value === true && this.enabled && this.expanded;
      return this.musicWatching ? this.musicSnapshot() : null;
    }
    if (action === "music-command") return this.controlMusic(input.command);
    if (action === "lyric-overlay") return this.setLyricOverlay(input.value);
    if (action === "open-folia") return this.controlMusic(null, true);
    if (action === "expand") return this.expand(input.expanded, input.pinned);
    if (action === "toggle") return this.enabled ? this.expand(!this.expanded, !this.expanded) : this.snapshot();
    if (action === "drag-start") { this.startDrag(); return true; }
    if (action === "drag-move") { this.moveDrag(); return true; }
    if (action === "drag-end") return this.endDrag();
    if (action === "resize-start") return this.startResize(input.edge);
    if (action === "resize-move") return this.moveResize();
    if (action === "resize-end") { this.moveResize(); return this.endResize(); }
    if (action === "resize-cancel") return this.endResize(true);
    if (action === "resize-step") {
      if (!Number.isFinite(input.dx) || !Number.isFinite(input.dy) || Math.abs(input.dx) > 40 || Math.abs(input.dy) > 40)
        throw new Error("无效的尺寸调整步长");
      if (!this.startResize(input.edge)) return false;
      this.moveResize({ x: input.dx, y: input.dy }); return this.endResize();
    }
    if (action === "hide") return this.setEnabled(false);
    if (action === "undock") return this.undock();
    if (action === "always-on-top") return this.setAlwaysOnTop(input.value);
    if (action === "agent") {
      this.chat.row(input.agent); this.agent = input.agent;
      this.save(); this.publish();
      return this.chat.load(this.agent);
    }
    // Every async operation is bound to the persona visible when it was initiated.
    const agent = input.agent || this.agent;
    this.chat.row(agent);
    if (action === "read") return this.read(input);
    if (action === "voice-choice") {
      if (!this.voiceChoice) throw new Error("请重启 Harbour 桌面端以加载音色选择");
      return this.voiceChoice({ action: input.choice, companionId: agent.replace(/^main-/, ""), voiceId: input.voiceId });
    }
    if (action === "open-task") {
      // A renderer cannot smuggle in a session, channel, URL or another persona.
      const task = this.signals.snapshot(agent, this.connection).task;
      if (!task || task.runId !== input.runId || !task.canOpen) throw new Error("这条状态已更新，请重新查看");
      await this.openConversation({ sessionId: task.sessionId, agentName: agent });
      // Opening a window is not a receipt; Main Chat confirms the visible reply.
      return true;
    }
    if (action === "open-music") {
      if (!this.openMusic) throw new Error("当前环境不支持打开音乐播放器");
      await this.openMusic(); return true;
    }
    if (action === "send") return this.chat.submit(agent, input.text, input.fileIds, input.mode);
    if (action === "upload") return this.chat.upload(agent, input.file);
    if (action === "image") return this.chat.image(agent, input.id);
    if (action === "remove-upload") { this.chat.removeUpload(agent, input.id); return true; }
    if (action === "history") return this.chat.history(agent);
    if (action === "select") return this.chat.select(agent, input.id);
    if (action === "config") return this.chat.settings(agent);
    if (action === "configure") {
      if (input.sessionId !== null && typeof input.sessionId !== "string") throw new Error("请重新打开当前会话的设置");
      return this.chat.configure(agent, input.config, input.sessionId);
    }
    if (action === "copy") {
      if (typeof input.text !== "string" || input.text.length > 240_000) throw new Error("复制内容过长");
      this.desktopActions.copy?.(input.text); return true;
    }
    if (["clipboard", "capture-sources", "capture", "search"].includes(action)) {
      const fn = this.desktopActions[action];
      if (!fn) throw new Error("当前环境不支持此桌面功能");
      return fn(input);
    }
    if (action === "stop") return this.chat.stop(agent);
    if (action === "answer") return this.chat.answer(agent, input.id, input.text);
    if (action === "new") {
      this.chat.assertIdle(this.chat.row(agent));
      return this.chat.load(agent, true);
    }
    if (action === "open") {
      const row = this.chat.row(agent);
      if (row.sessionId) await this.openConversation({ sessionId: row.sessionId, agentName: agent });
      else await this.openDashboard();
      return true;
    }
    if (action === "settings") { await this.openSettings(); return true; }
    throw new Error("不支持的悬浮助手操作");
  }
  consume(event) {
    this.consuming = true;
    try {
      if (event?.__harbour === "session-read") { this.clearReadNotifications(event); this.pendingPublish = true; }
      if (event?.__harbour === "orb-legacy-read") {
        const row = this.unreadSessions.get(event.sessionId);
        if (row?.agent === event.agent && row.historyRevision === event.historyRevision && !revision(row.replyRevision)) {
          this.unreadSessions.delete(event.sessionId); this.updateUnreadAgents();
        }
        this.signals.acknowledgeSession(event.agent, event.sessionId);
      } else { this.signals.consume(event); this.chat.consume(event); }
      if (event?.__harbour === "activity-snapshot") void this.reconcileReadState();
    }
    finally { this.consuming = false; if (this.pendingPublish) { this.pendingPublish = false; this.publish(); } }
  }
  setConnection(value) { this.connection = value; this.publish(); if (value === "open") this.chat.refreshAsks().catch(() => {}); }
  dispose() {
    if (this.voiceChoice) void Promise.resolve(this.voiceChoice({ action: "cancel" })).catch(() => {});
    this.endResize();
    this.disposed = true; ++this.visibilityRevision;
    this.signals.removeListener("change", this.onSignals);
    this.cancelRetraction(); clearInterval(this.hitTimer); this.chat.dispose();
    for (const event of ["display-removed", "display-metrics-changed"]) this.screen.removeListener(event, this.onDisplayChange);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}

module.exports = { OrbController };
