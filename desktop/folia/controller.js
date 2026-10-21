const { app, View } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { createFoliaHost } = require('./host');
const { FoliaRendererHealth } = require('./renderer-health');

// Dashboard bounds are CSS pixels; native views use DIP (not physical pixels).
function scaledFoliaBounds(window, bounds = {}) {
  const zoom = window.webContents.getZoomFactor();
  return Object.fromEntries(['x','y','width','height','clipLeft'].map(key => [key, Number.isFinite(bounds?.[key]) ? bounds[key]*zoom : 0]));
}

// One audio owner per Electron device; page/window/Remote are presentations of it.
class FoliaController {
  constructor({ root, dataDir, onState = () => {}, isQuitting = () => false, offline = false } = {}) {
    this.root = root || (app.isPackaged ? path.join(process.resourcesPath, 'folia') : path.join(__dirname, '../../vendor/folia'));
    this.dataDir = dataDir || path.join(app.getPath('userData'), 'folia');
    this.onState = onState;
    this.isQuitting = isQuitting;
    this.offline = offline;
    this.rendererHealth = new FoliaRendererHealth(this.dataDir);
    this.pending = new Map();
    this.state = { provider: 'folia', loaded: false, paused: true, volume: 70, tracks: [], shuffleAvailable: false, playNextAvailable: false, playbackModeAvailable: false, providerCapabilities: ['search', 'play', 'play_next', 'pause', 'resume', 'next', 'previous', 'shuffle', 'set_playback_mode', 'set_volume', 'seek', 'queue'] };
    this.mode = 'closed';
    this.requestedMode = 'closed';
    this.generation = 0;
  }
  status() {
    const renderer = this.rendererHealth.snapshot();
    const failed = renderer.phase === 'failed' || renderer.phase === 'unresponsive';
    return { ...this.state, renderer, connected: !failed,
      shuffleAvailable: !failed && !!this.runtime && this.state.shuffleAvailable === true,
      playNextAvailable: !failed && !!this.runtime && this.state.playNextAvailable === true,
      playbackModeAvailable: !failed && !!this.runtime && this.state.playbackModeAvailable === true,
      ...(failed ? { playbackStatus: 'UNKNOWN', providerReason: 'Folia 播放页面异常或无响应；请重新打开音乐模块。' } : {}),
      mode: this.mode, available: fs.existsSync(path.join(this.root, 'dist/index.html')), running: !!this.runtime };
  }
  presentation() {
    const owner = this.dock?.window || this.runtime?.getMainWindow();
    if (this.visualQuiet || !owner || owner.isDestroyed() || owner.isMinimized()
      || (this.dock && (!this.dock.visible || !owner.isVisible()))) return 'background';
    return this.dock ? 'embedded' : this.mode === 'window' ? 'window' : 'background';
  }
  setVisualQuiet(value) {
    if (this.visualQuiet === value) return;
    this.visualQuiet = value; this.publish(); // Presentation only; never pause the audio owner.
  }
  publishPresentation() {
    const presentation = this.presentation();
    if (presentation !== this.lastPresentation) {
      this.lastPresentation = presentation;
      const contents = this.runtime?.getMainWindow()?.webContents;
      if (contents && !contents.isDestroyed()) contents.send('harbour-folia:presentation', presentation);
      this.runtime?.refreshPresentation?.();
    }
  }
  publish(next = {}) {
    this.state = { ...this.state, ...next };
    this.publishPresentation();
    this.onState(this.status());
  }
  async ensure() {
    if (this.closing) await this.closing;
    if (this.starting) return this.starting;
    if (this.runtime) return this.runtime;
    if (!this.status().available) throw new Error('Folia 尚未构建；请在项目根运行 npm run folia:prepare。');
    this.starting = (async () => {
      this.rendererHealth.start();
      this.host = createFoliaHost({ root: this.root, dataDir: this.dataDir, offline: this.offline, onQuit: () => this.close(),
        isPlayerEmbedded: () => !!this.dock,
        onWindow: win => {
          if (win.webContents.getURL().includes('remote=1')) {
            // Hosted shells start hidden. Upstream Remote normally relies on the
            // BrowserWindow constructor's default show:true, unlike the player.
            win.show(); win.focus(); win.webContents.focus(); return;
          }
        },
        onWindowCreated: win => {
          const wc = win.webContents;
          // A transparency shell replacement reuses this view. Bind once to the view, not shell.
          if (!(this.healthWatched ||= new WeakSet()).has(wc)) {
            this.healthWatched.add(wc);
            wc.on('render-process-gone', (_event, details) => {
              if (this.runtime?.getMainWindow()?.webContents !== wc || this.closing) return;
              this.rendererReady = false;
              this.rendererHealth.report(['crashed', 'oom', 'killed'].includes(details.reason) ? details.reason : 'abnormal-exit', undefined, true);
              this.rejectPending('Folia 播放页面已退出，已提交命令的结果未知；请重新打开音乐模块，勿重放命令。');
              this.publish({ connected: false, paused: true });
            });
          }
          win.on('close', event => {
            if (this.runtime?.getMainWindow() === win && !this.closing && !this.isQuitting()) { event.preventDefault(); this.hide(); }
          });
          // Upstream's close shortcut can hide directly rather than emit close.
          // Keep the dashboard truthful without changing playback or recreating it.
          const syncHidden = () => {
            if (!win.isVisible() && !this.dock && !this.closing && this.runtime?.getMainWindow() === win && this.mode === 'window') {
              this.mode = 'background'; this.requestedMode = 'background'; this.publish();
            }
          };
          win.on('hide', syncHidden);
          for (const event of ['minimize', 'restore']) win.on(event, () => this.publishPresentation());
          // macOS hide events follow occlusion and may be absent if an already
          // occluded window is explicitly hidden. Reconcile the successful
          // native operation too; do not synthesize an Electron event or poll.
          const nativeHide = win.hide.bind(win);
          win.hide = () => { const result = nativeHide(); syncHidden(); return result; };
        },
        beforeNativeAction: (channel, args) => {
          if (!this.dock) return;
          if (['window-toggle-maximize', 'window-toggle-fullscreen',
            'window-set-always-on-top', 'window-minimize'].includes(channel)
            || /^video-export-(prepare|restore|get-main-window-source)/.test(channel)
            || (channel === 'save-settings' && /wallpaper|desktop_lyric/.test(String(args[0])))) {
            this.undock();
            const win = this.runtime.getMainWindow();
            win.show(); win.focus(); win.webContents.focus();
            this.mode = 'window'; this.requestedMode = 'window'; this.publish();
          }
        },
      });
      const primary = event => this.runtime?.getMainWindow()?.webContents === event.sender;
      this.host.ipc.handle('harbour-folia:get-presentation', event => {
        if (!primary(event)) throw new Error('Only the Folia player owns its presentation');
        return this.presentation();
      });
      this.host.ipc.handle('harbour-folia:ready', event => {
        if (!primary(event)) throw new Error('Only the Folia player owns the music bridge');
        this.rendererReady = true; this.rendererHealth.ready(); this.publish(); return true;
      });
      this.host.ipc.on('harbour-folia:state', (event, next) => {
        if (primary(event) && next && typeof next === 'object') { this.rendererHealth.seen(); this.publish(next); }
      });
      this.host.ipc.on('harbour-folia:failure', (event, failure) => {
        if (!primary(event) || !['react-root', 'visualizer', 'visualizer-cleanup'].includes(failure?.kind)) return;
        const fatal = failure.kind === 'react-root';
        this.rendererHealth.report(failure.kind, failure.mode, fatal);
        if (fatal) {
          this.rendererReady = false;
          this.rejectPending('Folia 播放页面异常，已提交命令的结果未知；请重新打开音乐模块，勿重放命令。');
        }
        this.publish(fatal ? { connected: false, paused: true } : {});
      });
      this.host.ipc.on('harbour-folia:result', (event, reply) => {
        if (!primary(event)) return;
        const pending = this.pending.get(reply?.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(reply.id);
        reply.ok ? pending.resolve(reply.result) : pending.reject(new Error(reply.error === 'NO_ACTIVE_TRACK'
          ? '当前没有可播放曲目，请先选择歌曲。' : reply.error || 'Folia 操作失败'));
      });
      this.runtime = require(path.join(this.root, 'electron/main.cjs'))(this.host);
      await this.runtime.ready;
      const deadline = Date.now() + 30_000;
      while (!this.rendererReady && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      if (!this.rendererReady) {
        console.error('[folia] startup diagnostic', await this.runtime.getMainWindow()?.webContents.executeJavaScript('JSON.stringify({bridge:!!window.harbourFolia,readyState:document.readyState})'));
        throw new Error('Folia 页面启动超时；未提交播放命令。');
      }
      // ensure() creates the audio owner, not a visible presentation. In
      // particular, a cold Remote/search request must not report a ghost window.
      this.mode = this.runtime.getMainWindow().isVisible() ? 'window' : 'background';
      this.publish();
      return this.runtime;
    })().catch(async error => {
      try { await this.runtime?.dispose(); } catch (cleanupError) { console.error('[folia] startup cleanup:', cleanupError.message); }
      this.host?.dispose(); this.runtime = null; this.host = null; this.rendererReady = false;
      this.rendererHealth.close();
      throw error;
    }).finally(() => { this.starting = null; });
    return this.starting;
  }
  undock() {
    this.closeDeviceMenu();
    if (!this.dock || !this.runtime) return;
    const { window: parent, view, clip } = this.dock;
    clip.removeChildView(view);
    if (!parent.isDestroyed()) parent.contentView.removeChildView(clip);
    const win = this.runtime.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.contentView.addChildView(view);
      const [width, height] = win.getContentSize();
      view.setBounds({ x: 0, y: 0, width, height });
      // A Dashboard overlay may have hidden it before the move. Visibility is
      // independent of the new shell's show/focus state.
      view.setVisible(true);
      view.setBorderRadius(0);
    }
    this.dock = null;
  }
  async open(mode = 'window', window, bounds) {
    const generation = ++this.generation;
    if (mode !== 'remote') this.requestedMode = mode;
    this.openingWindow = mode === 'embedded' ? window : null;
    await this.ensure();
    await this.recoverRenderer();
    if (generation !== this.generation || this.closing) {
      if (!this.closing && this.requestedMode === 'background') this.hide();
      return this.status();
    }
    const win = this.runtime.getMainWindow();
    if (mode === 'remote') {
      const remote = this.runtime.openRemote();
      if (!remote.isVisible()) await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timer); remote.off('show', shown); remote.off('closed', closed);
          error ? reject(error) : resolve();
        };
        const shown = () => finish();
        const closed = () => finish(new Error('Remote 在打开前已关闭。'));
        const timer = setTimeout(() => finish(new Error('Remote 页面启动超时，请重试打开小窗。')), 30_000);
        remote.once('show', shown); remote.once('closed', closed);
      });
      if (!remote.isDestroyed()) { remote.show(); remote.focus(); remote.webContents.focus(); }
      return this.status();
    }
    // Choosing a normal presentation explicitly leaves click-through mode.
    // Clear both upstream renderer state and OS hit-testing, not just the shell.
    this.runtime.setClickThrough(false);
    this.undock();
    if (mode === 'embedded') {
      if (!window || window.isDestroyed()) throw new Error('宿主窗口已关闭');
      const view = this.host.views.get(win);
      win.contentView.removeChildView(view);
      // A native child view sits above Dashboard DOM. Clip the covered strip,
      // not the player's viewport: no reload, reflow or second audio owner.
      const clip = new View();
      clip.setBorderRadius(1);
      clip.addChildView(view);
      window.contentView.addChildView(clip);
      view.setBorderRadius(14);
      this.dock = { window, view, clip, visible: true };
      this.resize(window, bounds);
      win.hide(); view.setVisible(true); view.webContents.focus();
      // Return the view before the Dashboard is destroyed; its close must not stop audio.
      if (!this.watched?.has(window)) {
        (this.watched ||= new WeakSet()).add(window);
        window.on('close', () => { if (this.dock?.window === window) this.hide(window); });
        for (const event of ['hide', 'show', 'minimize', 'restore']) window.on(event, () => {
          if (this.dock?.window === window) this.publishPresentation();
        });
      }
      this.mode = 'embedded';
    } else {
      this.host.views.get(win).setVisible(true);
      this.host.views.get(win).setBorderRadius(0);
      win.show(); win.focus(); win.webContents.focus(); this.mode = 'window';
    }
    this.publish(); return this.status();
  }
  resize(window, bounds = {}, visible) {
    if (this.dock?.window !== window || window.isDestroyed()) return;
    const [width, height] = window.getContentSize();
    const num = value => Number.isFinite(value) ? Math.round(value) : 0;
    const x = Math.max(0, Math.min(width, num(bounds.x))), y = Math.max(0, Math.min(height, num(bounds.y)));
    const frame = { x, y, width: Math.max(0, Math.min(width - x, num(bounds.width))), height: Math.max(0, Math.min(height - y, num(bounds.height))) };
    const left = Math.max(0, Math.min(frame.width, num(bounds.clipLeft)));
    const { view, clip } = this.dock;
    if (visible === false || JSON.stringify(frame) !== JSON.stringify(this.dock.bounds) || left !== this.dock.clipLeft) this.closeDeviceMenu(window);
    this.dock.clipLeft = left;
    this.dock.bounds = frame;
    if (visible !== undefined) this.dock.visible = visible !== false;
    // Parent + child offsets cancel out, preserving both screen position and
    // input coordinates while the sidebar slides. Only the clip size changes.
    clip.setBounds({ x: x + left, y, width: frame.width - left, height: frame.height });
    view.setBounds({ x: -left, y: 0, width: frame.width, height: frame.height });
    view.setVisible(this.dock.visible);
    // Electron's rounded clipping is disabled below 32 DIP. A fully/nearly
    // covered viewport must not paint or receive input outside its tiny clip.
    clip.setVisible(this.dock.visible && frame.width - left >= 32 && frame.height >= 32);
    this.publishPresentation();
  }
  showDeviceMenu(window, request) {
    if (window?.isDestroyed() || this.dock?.window !== window || !this.dock.visible) return Promise.resolve(null);
    const { FoliaDeviceMenu } = require('./device-menu');
    this.deviceMenu ||= new FoliaDeviceMenu();
    return this.deviceMenu.open(window, request, { playerContents: this.dock.view.webContents });
  }
  closeDeviceMenu(window) {
    if (!window || this.dock?.window === window) this.deviceMenu?.close();
  }
  hide(window) {
    if (window && this.dock?.window !== window && !(this.starting && this.openingWindow === window)) return;
    ++this.generation;
    this.requestedMode = 'background';
    this.undock();
    const windowToHide = this.runtime?.getMainWindow();
    if (windowToHide && !windowToHide.isDestroyed()) windowToHide.hide();
    if (this.runtime) { this.mode = 'background'; this.publish(); }
  }
  async command(command) {
    if (command.action === 'status') return this.status();
    if (command.action === 'open') return this.open('window');
    if (command.action === 'close') return this.close();
    await this.ensure();
    if (this.closing || !this.runtime) throw new Error('音乐模块正在关闭，未提交命令');
    if (this.recovering || this.rendererHealth.snapshot().phase === 'failed') {
      throw new Error('Folia 播放页面异常，请重新打开音乐模块；本次命令未提交。');
    }
    if (this.rendererHealth.snapshot().phase === 'unresponsive') {
      // Check the live bridge, not the last cached PLAYING record, before sending a new action.
      try { await this.request({ action: 'status' }, 2000); this.rendererHealth.seen(); }
      catch { throw new Error('Folia 播放页面无响应，请重新打开音乐模块；本次命令未提交。'); }
    }
    if (command.action === 'play_next') {
      // A fresh capability check prevents an old/reloaded renderer from acknowledging a no-op.
      const state = await this.request({ action: 'status' });
      if (state?.playNextAvailable !== true) throw new Error('当前 Folia 不支持下一首播放；请确认已有普通队列歌曲，并更新音乐模块。');
    }
    return this.request(command);
  }
  request(command, timeoutMs = 25_000) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Folia 回执超时，结果未知；请先查询状态，勿重放命令。')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.runtime.getMainWindow().webContents.send('harbour-folia:command', { id, command }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  rejectPending(message) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); }
    this.pending.clear();
  }
  async recoverRenderer() {
    if (this.recovering) return this.recovering;
    const phase = this.rendererHealth.snapshot().phase;
    if (phase !== 'failed' && phase !== 'unresponsive') return;
    this.recovering = (async () => {
      if (phase === 'unresponsive') {
        try { await this.request({ action: 'status' }, 2000); this.rendererHealth.ready(); return; }
        catch { this.rendererHealth.report('unresponsive', undefined, true); }
      }
      this.rejectPending('Folia 页面正在恢复，之前命令的结果未知，不会自动重放。');
      this.rendererReady = false;
      this.rendererHealth.start();
      this.publish({ connected: false, paused: true });
      // Explicit open recovers only Folia's page, keeping its persisted queue/accounts/settings.
      // No play/next/enqueue command is replayed and the Harbour backend/window is untouched.
      this.runtime.getMainWindow().webContents.reload();
      const deadline = Date.now() + 30_000;
      while (!this.rendererReady && Date.now() < deadline && !this.closing) await new Promise(resolve => setTimeout(resolve, 50));
      if (!this.rendererReady) {
        this.rendererHealth.report('unresponsive', undefined, true); this.publish();
        throw new Error('Folia 页面恢复失败；请关闭音乐模块后再打开。聊天、曲库和账号未删除。');
      }
    })().catch(error => {
      this.rendererReady = false;
      if (this.rendererHealth.snapshot().phase !== 'failed') this.rendererHealth.report('unresponsive', undefined, true);
      this.publish();
      throw error;
    }).finally(() => { this.recovering = null; });
    return this.recovering;
  }
  async close() {
    if (this.closing) return this.closing;
    ++this.generation;
    this.requestedMode = 'closed';
    this.closing = (async () => {
      if (this.starting) await this.starting.catch(() => {});
      if (this.recovering) await this.recovering.catch(() => {});
      this.hide();
      this.rejectPending('音乐模块已关闭');
      try { await this.runtime?.dispose(); } finally {
        this.host?.dispose(); this.host = null; this.runtime = null; this.rendererReady = false;
        this.rendererHealth.close();
        this.mode = 'closed'; this.publish({ loaded: false, paused: true, currentTrackId: '', tracks: [], shuffleAvailable: false, playNextAvailable: false, playbackModeAvailable: false });
      }
      return this.status();
    })().finally(() => { this.closing = null; });
    return this.closing;
  }
}

module.exports = { FoliaController, scaledFoliaBounds };
