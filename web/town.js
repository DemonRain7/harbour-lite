(function (global) {
  'use strict';
  const bridge = global.harbourDesktop;
  const restartHint = '当前客户端尚未加载小镇独立窗口功能。可先在此页使用；右键 Harbour 托盘图标 →「重启 Harbour 客户端」后即可打开独立窗口，无需重启后端。';
  let desktop = null, hostReady = false, hostProbe;
  let frame, portal, mounted, unregister, popup, popupWatch, transfer, returning = false;
  let nativeState = { mode: 'closed' };
  const town = () => frame?.contentWindow?.HarbourTown;
  function resolveHost() {
    if (hostReady) return Promise.resolve();
    // A source client's preload is reread on refresh, but main.js is not. Probe
    // the running main process before opening anything; method presence is not
    // evidence that its IPC handlers exist. Keep this choice for the page lifetime.
    if (!hostProbe) hostProbe = (async () => {
      if (['townStatus', 'townOpen', 'townHide', 'townResize', 'onTownState', 'onTownReturn'].every(key => typeof bridge?.[key] === 'function')) {
        try {
          const state = await bridge.townStatus();
          if (!state || !['closed', 'background', 'embedded', 'window'].includes(state.mode)) throw new Error('小镇客户端状态无效，请重启 Harbour 客户端。');
          desktop = bridge; nativeState = state;
          desktop.onTownState(next => { nativeState = next; mounted?.update(); });
          desktop.onTownReturn(() => {
            returning = true;
            if (location.hash !== '#town') location.hash = '#town';
            else void mounted?.embed();
          });
        } catch (error) {
          // Only a known absent read-only handler permits fallback. Never hide
          // authorization, load or unknown native-open failures with a second scene.
          if (!/No handler registered for ['"]desktop:town-status['"]/.test(String(error?.message))) throw error;
        }
      }
      hostReady = true;
    })().catch(error => { hostProbe = null; throw error; });
    return hostProbe;
  }
  function ensureFrame() {
    if (frame) return;
    portal = document.createElement('div'); portal.className = 'town-portal'; portal.hidden = true;
    frame = document.createElement('iframe'); frame.className = 'town-frame'; frame.title = 'Harbour 小镇';
    frame.src = '/town/index.html'; frame.allow = 'autoplay; fullscreen'; frame.allowFullscreen = true;
    portal.append(frame);
    // Never reparent the iframe on routing: even moving it in the DOM reloads it.
    (document.querySelector('.shell') || document.body).append(portal);
    frame.addEventListener('load', () => { mounted?.update(); if (!mounted) town()?.setVisible(false); });
    unregister = global.HarbourUnsavedChanges?.register('town-chat', {
      label: '小镇对话 / 未发送草稿（放弃会先停止正在进行的对话）',
      preserveOnPageChange: true, isActive: () => !!frame?.isConnected,
      isDirty: () => town()?.dirty() || false, discard: async () => await town()?.discard() !== false,
    });
  }
  function popupClosed() {
    if (!popup?.closed) return;
    popup = null; clearInterval(popupWatch); popupWatch = null; mounted?.update();
  }
  global.HarbourTownUI = {
    isVisible() { return !!portal && !portal.hidden; },
    takeTransfer() { const value = transfer; transfer = null; return value; },
    returnFromPopup(snapshot) { town()?.restore(snapshot); },
    popoutUnavailableReason() { return bridge?.isElectron && !desktop ? restartHint : ''; },
    popout() {
      if (bridge?.isElectron) throw new Error(restartHint);
      if (popup && !popup.closed) { popup.focus(); return true; }
      if (town()?.status().busy) return false;
      transfer = town()?.snapshot();
      popup = global.open('/town/index.html?standalone=1', 'harbour-town', 'popup,width=1280,height=860');
      if (!popup) { transfer = null; return false; }
      mounted?.update(); popupWatch = setInterval(popupClosed, 1000); return true;
    },
    mount(root) {
      const events = new AbortController(); let alive = true, ticking = 0, lastGeometry = '', opening = false, failure = '';
      const stage = document.createElement('div'); stage.className = 'town-stage';
      const placeholder = document.createElement('div'); placeholder.className = 'town-detached';
      const title = document.createElement('h2'), note = document.createElement('p');
      const open = document.createElement('button'), embed = document.createElement('button');
      open.textContent = '显示小镇窗口 ↗'; embed.textContent = '嵌回此页';
      title.textContent = '正在连接小镇…'; open.disabled = embed.disabled = true;
      const actions = document.createElement('div'); actions.append(open, embed); placeholder.append(title, note, actions); stage.append(placeholder); root.replaceChildren(stage);
      const sidebar = document.querySelector('#sidebar'), shell = root.closest('.shell');
      function geometry() {
        const r = stage.getBoundingClientRect();
        const nav = sidebar && getComputedStyle(sidebar).visibility !== 'hidden' ? sidebar.getBoundingClientRect() : null;
        const clipLeft = nav && nav.right > r.left && nav.left < r.right && nav.bottom > r.top && nav.top < r.bottom ? Math.max(0, Math.min(r.width, nav.right - r.left)) : 0;
        return { x: r.x, y: r.y, width: r.width, height: r.height, clipLeft };
      }
      const unblocked = () => !document.hidden && !document.querySelector('dialog[open], .md-modal, .login-overlay, .media-viewer-overlay, .harbour-select.open');
      function update() {
        if (!alive || !hostReady) return;
        const external = desktop ? nativeState.mode === 'window' : popup && !popup.closed;
        title.textContent = failure || nativeState.error || (external ? '小镇正在独立窗口中' : 'Harbour 小镇');
        note.textContent = external ? '切换左侧栏目不影响散步和对话。可以随时嵌回这里。' : '位置、视角与对话会保留，切换栏目无需重新载入。';
        placeholder.hidden = desktop ? nativeState.mode === 'embedded' && !nativeState.error && !failure : !external;
        open.textContent = external ? '显示小镇窗口 ↗' : '打开小镇窗口 ↗';
        embed.textContent = failure || nativeState.error ? '重新载入小镇' : '嵌回此页';
        const r = geometry(), visible = !external && unblocked() && r.width > 0 && r.height > 0;
        const key = JSON.stringify([r, visible]);
        if (desktop) { if (key !== lastGeometry && nativeState.mode === 'embedded') desktop.townResize(r, visible); }
        else {
          if (!portal) return;
          portal.hidden = !visible;
          Object.assign(portal.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px`, clipPath: r.clipLeft ? `inset(0 0 0 ${r.clipLeft}px)` : 'none' });
          town()?.setVisible(visible);
        }
        lastGeometry = key;
      }
      async function embedTown() {
        if (!alive || !hostReady || opening) return;
        returning = false; opening = true; failure = '';
        try {
          if (desktop) nativeState = await desktop.townOpen('embedded', geometry(), unblocked());
          else if (popup && !popup.closed) {
            if (popup.HarbourTown?.status().busy) { note.textContent = '请先等待独立窗口里的对话完成或停止，再嵌回。'; return; }
            town()?.restore(popup.HarbourTown?.snapshot());
            popup.HarbourTown?.prepareTransfer(); popup.close(); popupClosed();
          }
          lastGeometry = ''; update();
        } catch (error) { failure = error.message; update(); placeholder.hidden = false; }
        finally { opening = false; }
      }
      open.addEventListener('click', async () => {
        failure = '';
        try { if (desktop) nativeState = await desktop.townOpen('window'); else if (!global.HarbourTownUI.popout()) { note.textContent = '请允许此站点弹出小镇窗口。'; return; } update(); }
        catch (error) { failure = error.message; update(); }
      }, { signal: events.signal });
      embed.addEventListener('click', () => void (hostReady ? embedTown() : initialize()), { signal: events.signal });
      mounted = { update, embed: embedTown };
      const observer = new ResizeObserver(update); observer.observe(stage); if (sidebar) observer.observe(sidebar);
      const schedule = () => {
        if (ticking || !alive) return;
        ticking = requestAnimationFrame(() => { ticking = 0; update(); if (sidebar?.getAnimations().some(a => a.playState === 'running')) schedule(); });
      };
      for (const type of ['resize', 'scroll']) global.addEventListener(type, schedule, { signal: events.signal, capture: true });
      for (const type of ['transitionrun', 'transitionend', 'transitioncancel']) sidebar?.addEventListener(type, schedule, { signal: events.signal });
      document.addEventListener('visibilitychange', update, { signal: events.signal });
      // Observe only overlay/nav lifecycle, never high-frequency scene/trace DOM.
      const mutations = new MutationObserver(records => {
        if (records.some(r => r.target === document.body || r.target === shell || r.target === sidebar
          || (r.type === 'attributes' && r.target.matches('dialog,.harbour-select'))
          || [...r.addedNodes, ...r.removedNodes].some(n => n.nodeType === 1 && (n.matches('dialog,.md-modal,.login-overlay,.media-viewer-overlay') || n.querySelector('dialog[open],.md-modal,.login-overlay'))))) schedule();
      });
      mutations.observe(document.body, { attributes: true, attributeFilter: ['class', 'open', 'hidden'], childList: true, subtree: true });
      async function initialize() {
        open.disabled = embed.disabled = true;
        try {
          await resolveHost(); if (!alive) return;
          open.hidden = false; open.disabled = embed.disabled = false; embed.textContent = '嵌回此页';
          if (desktop) { if (nativeState.mode !== 'window' || returning) await embedTown(); else update(); }
          else { ensureFrame(); update(); }
        } catch (error) {
          if (!alive) return;
          title.textContent = '暂时无法连接小镇'; note.textContent = error.message;
          open.hidden = true; embed.disabled = false; embed.textContent = '重试连接';
        }
      }
      void initialize();
      return () => {
        alive = false; mounted = null; events.abort(); observer.disconnect(); mutations.disconnect(); cancelAnimationFrame(ticking);
        if (desktop) void desktop.townHide().catch(error => console.warn('小镇隐藏失败：', error.message));
        else if (portal) { portal.hidden = true; town()?.setVisible(false); }
      };
    },
    destroy() { unregister?.(); town()?.destroy(); portal?.remove(); frame = portal = null; clearInterval(popupWatch); },
  };
})(window);
