/* Main Chat is a remote control, not a second player. Dispose on every route change. */
window.HarbourChatMusic = (() => {
  let mountId = 0;
  function mount(root, { api, discuss }) {
    const desktop = window.harbourDesktop, context = window.HarbourMusicContext;
    let localId = desktop?.coworkDeviceId || '';
    const local = !!desktop?.controlCompanionMusic;
    const identifyLocal = async () => {
      if (local && !localId) localId = await context.resolveLocalDeviceId(desktop);
    };
    const events = new AbortController(), { icon, playbackModes, playbackModeState } = window.HarbourMusicUI;
    let alive = true, polling = false, pending = false, revision = 0, snapshotRevision = 0;
    let deviceId = '', deviceLabel = '', devices = [], music = null, localMusic = null, track = null, notice = '', renderKey = '';
    const contentId = `chat-music-content-${++mountId}`;
    root.innerHTML = `<div class="chat-music-bar" aria-label="音乐陪伴">
      <button type="button" class="chat-tool-button chat-music-collapse" aria-controls="${contentId}" aria-expanded="false" aria-label="音乐陪伴">
        ${icon('note')}<span class="chat-music-indicator" aria-hidden="true"></span><span class="chat-tool-label">音乐陪伴</span>
      </button>
      <section class="chat-music-content chat-tool-popover" id="${contentId}" aria-label="音乐陪伴" hidden>
      <header class="chat-tool-heading"><span>音乐陪伴</span><button type="button" data-chat-tool-close aria-label="收起音乐陪伴，不影响播放"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
      <a class="chat-music-link" href="#music" title="打开 Folia · 搜索歌曲或选择播放设备">${icon('note')}<span><b class="chat-music-title">音乐陪伴</b><small class="chat-music-meta">打开 Folia，边听边聊</small></span></a>
      <div class="chat-music-actions" role="group" aria-label="当前音乐快捷控制">
        <button type="button" data-music-action="set_playback_mode" aria-label="播放模式暂不可用" title="播放模式暂不可用">${icon('queue')}</button>
        <button type="button" data-music-action="previous" aria-label="上一首" title="上一首">${icon('previous')}</button>
        <button type="button" data-music-action="toggle" aria-label="继续播放" title="继续播放">${icon('play')}</button>
        <button type="button" data-music-action="next" aria-label="下一首" title="下一首">${icon('next')}</button>
        <button type="button" class="chat-music-discuss" title="把当前曲目放进输入框，由你确认发送">聊聊这首</button>
      </div><span class="chat-music-notice" role="status" hidden></span>
      <a class="chat-music-open" href="#music">打开 Folia <span aria-hidden="true">↗</span></a></section></div>`;
    const $ = selector => root.querySelector(selector);
    // Utility disclosure is transient presentation, never a saved auto-open preference.
    const popup = window.HarbourChatTools.popover({
      trigger: $('.chat-music-collapse'), panel: $('.chat-music-content'), container: root,
    });
    const here = () => local && deviceId === localId;
    function selection() {
      let saved = ''; try { saved = localStorage.getItem('harbour-music-device') || ''; } catch { /* local-only */ }
      const next = saved || deviceId || localId || (devices.length === 1 ? devices[0].id : '');
      if (next !== deviceId) { deviceId = next; ++revision; notice = ''; music = null; }
      deviceLabel = here() ? '本机' : devices.find(d => d.id === deviceId)?.label || (deviceId ? '已选设备' : '');
      music = here() ? localMusic : devices.find(d => d.id === deviceId)?.music || null;
    }
    function render() {
      if (!alive || window.HarbourVisualActivity?.isActive() === false) return;
      track = context.current(music);
      const playback = playbackModeState(music);
      const resumable = context.canResume(music);
      const key = JSON.stringify([track?.id, track?.title, track?.artist, track?.paused, resumable, deviceLabel, deviceId, devices.length, music?.connected, playback.id, playback.available, playback.unavailableReason, pending, notice]);
      if (key === renderKey) return; renderKey = key;
      $('.chat-music-title').textContent = track ? track.title : '音乐陪伴';
      $('.chat-music-meta').textContent = track
        ? [track.paused ? '已暂停' : '正在播放', track.artist, deviceLabel].filter(Boolean).join(' · ')
        : notice || (!deviceId && devices.length > 1 ? '多台设备在线 · 在 Folia 选择播放设备'
          : music?.connected === false ? '播放状态不可用 · 打开 Folia 检查'
          : deviceId && !here() && !music ? '已选设备离线 · 不会切换到其它设备'
          : resumable ? '点击播放，继续上次的音乐' : '打开 Folia，边听边聊');
      $('.chat-music-link').title = track ? `${track.title} · ${track.artist}\n打开 Folia` : '打开 Folia · 搜索歌曲或选择播放设备';
      root.dataset.playing = String(!!track && !track.paused);
      root.dataset.loaded = String(!!track);
      $('.chat-music-collapse').setAttribute('aria-label', track ? `音乐陪伴 · ${track.paused ? '已暂停' : '正在播放'} · ${track.title}` : '音乐陪伴 · 打开播放控制');
      $('.chat-tool-label').textContent = track ? `${track.paused ? '已暂停' : '正在播放'} · ${track.title}` : '音乐陪伴';
      const toggle = $('[data-music-action="toggle"]'), action = !track || track.paused ? '继续播放' : '暂停';
      toggle.innerHTML = icon(!track || track.paused ? 'play' : 'pause'); toggle.setAttribute('aria-label', action); toggle.title = action;
      const modeButton = $('[data-music-action="set_playback_mode"]');
      modeButton.innerHTML = icon(playback.icon);
      modeButton.dataset.mode = playback.id;
      modeButton.title = playback.available ? `${playback.label} · 点击切换为${playbackModes[playback.next].label}` : `${playback.id ? playback.label + ' · ' : ''}${playback.unavailableReason}`;
      modeButton.setAttribute('aria-label', modeButton.title);
      root.querySelectorAll('[data-music-action]').forEach(button => {
        button.disabled = pending || (button.dataset.musicAction === 'set_playback_mode' ? !playback.available : button.dataset.musicAction === 'toggle' ? !track && !resumable : !track);
      });
      $('.chat-music-discuss').disabled = !track;
      $('.chat-music-actions').setAttribute('aria-busy', String(pending));
      $('.chat-music-notice').textContent = notice;
      $('.chat-music-notice').title = notice;
      $('.chat-music-notice').hidden = !notice || !track;
    }
    async function refresh() {
      if (!alive || polling || document.hidden || window.HarbourVisualActivity?.isActive() === false) return;
      polling = true; let stamp = revision;
      try {
        if (local && !localId) await identifyLocal();
        if (!alive) return;
        selection(); render();
        if (here()) return; // Desktop state already arrives on the shared IPC bridge.
        stamp = revision;
        const result = await api('/api/music/devices?summary=1', { signal: events.signal });
        if (!alive || stamp !== revision) return;
        devices = result.devices || []; selection(); render();
      } catch (error) {
        if (!alive || stamp !== revision) return;
        devices = []; music = null; notice = '音乐设备状态暂不可用'; render();
      } finally { polling = false; }
    }
    async function control(action) {
      const origin = revision;
      if (local && !localId) await identifyLocal();
      if (!alive || origin !== revision) return;
      selection(); track = context.current(music);
      const playback = playbackModeState(music), modeChange = action === 'set_playback_mode';
      if (pending || (modeChange ? !playback.available : action === 'toggle' ? !track && !context.canResume(music) : !track)) { render(); return; }
      if (action === 'toggle') action = !track || track.paused ? 'resume' : 'pause';
      const stamp = revision; pending = true; notice = ''; render();
      const command = { action, ...(modeChange ? { playbackMode: playback.next } : {}) };
      try {
        if (here()) await desktop.controlCompanionMusic(command);
        else await api('/api/music/control', { method: 'POST', body: JSON.stringify({ ...command, player: 'folia', deviceId }), signal: events.signal });
        // Do not optimistically flip playback or replay an uncertain command.
        if (alive && stamp === revision) { notice = '已发送，播放状态以设备回报为准'; await refresh(); }
      } catch (error) { if (alive && stamp === revision) notice = error.message || '音乐控制失败'; }
      finally { if (alive) { pending = false; render(); } }
    }
    root.addEventListener('click', event => {
      const button = event.target.closest('[data-music-action]');
      if (button) void control(button.dataset.musicAction);
      if (event.target.closest('.chat-music-discuss')) {
        selection(); const current = context.current(music);
        if (current) { notice = discuss(context.discussion(current, deviceId)) === false ? '当前会话不能编辑，未添加曲目' : '已放入输入框，未发送、未切歌'; render(); }
      }
    }, { signal: events.signal });
    const unsubscribe = local ? desktop.onCompanionState?.(state => {
      ++snapshotRevision; localMusic = state.music; selection(); if (here() && notice === '已发送，播放状态以设备回报为准') notice = ''; render();
    }) : null;
    if (local) {
      const stamp = snapshotRevision;
      desktop.getCompanionState().then(state => {
        if (alive && stamp === snapshotRevision) { localMusic = state.music; selection(); render(); }
      }).catch(() => {});
    }
    document.addEventListener('visibilitychange', refresh, { signal: events.signal });
    window.addEventListener('storage', event => {
      if (event.key === 'harbour-music-device' || event.key === null) void refresh();
    }, { signal: events.signal });
    const timer = window.HarbourVisualActivity?.poll(refresh, 5000);
    const fallbackTimer = timer ? null : setInterval(refresh, 5000);
    if (!timer) void refresh();
    const removeVisualListener = window.HarbourVisualActivity?.subscribe(active => { if (active) { selection(); render(); } });
    return () => { alive = false; ++revision; popup.destroy(); events.abort(); timer?.dispose(); clearInterval(fallbackTimer); removeVisualListener?.(); unsubscribe?.(); };
  }
  return { mount };
})();
