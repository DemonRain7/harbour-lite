/* Full Folia lives in one native view. This panel owns presentation, not audio. */
window.HarbourMusicUI = (() => {
  const shapes = {
    note: '<path d="M9 18V5l12-2v13M9 8l12-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="18" cy="16" rx="3" ry="3"/>',
    device: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 21h8m-4-5v5"/>',
    embed: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18m-12 0v11"/>',
    window: '<path d="M14 3h7v7m0-7-9 9M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
    remote: '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="11" y="11" width="8" height="7" rx="1"/>',
    previous: '<path d="m19 5-10 7 10 7V5ZM5 5v14"/>',
    next: '<path d="m5 5 10 7-10 7V5Zm14 0v14"/>',
    play: '<path d="m8 5 11 7-11 7V5Z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    shuffle: '<path d="m18 14 4 4-4 4m0-20 4 4-4 4M2 18h2.5c6 0 5-12 11-12H22M2 6h2.5c2 0 3.2 1.3 4.4 3.1m6.2 5.8c1.2 1.8 2.4 3.1 4.4 3.1H22"/>',
    repeat: '<path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3"/>',
    repeatOne: '<path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3m7-6 2-1v5"/>',
    search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
    queue: '<path d="M4 6h16M4 12h11M4 18h8m5-4 4 4-4 4"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
  };
  const icon = name => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + shapes[name] + '</svg>';
  const playbackModes = Object.freeze({
    off: { label: '顺序播放', icon: 'queue', next: 'all' },
    all: { label: '列表循环', icon: 'repeat', next: 'one' },
    one: { label: '单曲循环', icon: 'repeatOne', next: 'shuffle' },
    shuffle: { label: '随机播放', icon: 'shuffle', next: 'off' },
  });
  function playbackModeState(music) {
    const id = music?.provider === 'folia' && Object.hasOwn(playbackModes, music.playbackMode) ? music.playbackMode : '';
    const available = !!id && music?.connected !== false && music?.running !== false && music?.playbackModeAvailable === true;
    const unavailableReason = available ? '' : !music || music.connected === false || music.running === false
      ? '请先连接播放设备并打开 Folia'
      : music.provider !== 'folia' ? '请切换到 Folia；外部播放器不支持此模式控制'
      : !id || typeof music.playbackModeAvailable !== 'boolean'
        ? 'Folia 尚未提供模式状态；若播放器已打开，请更新后关闭音乐模块再重新打开'
        : '当前播放源不支持队列模式；请退出私人 FM 或外部播放源后再切换';
    return { id, ...(playbackModes[id] || { label: '播放模式', icon: 'queue', next: '' }),
      available, unavailableReason };
  }
  function mount(root, { api, esc }) {
    const desktop = window.harbourDesktop;
    const local = !!desktop?.foliaOpen;
    let localId = desktop?.coworkDeviceId || '';
    const identifyLocal = async () => {
      if (local && !localId) localId = await window.HarbourMusicContext?.resolveLocalDeviceId(desktop) || '';
    };
    const events = new AbortController();
    let alive = true, embedding = false, deviceId = localStorage.getItem('harbour-music-device') || '';
    let devices = [], deviceOptions = '', polling = false, opening = false, revision = 0, queryRevision = 0, lastGeometry = '';
    let modeState = playbackModeState(null), changingMode = false, modeRevision = 0;
    let playNextMusic = null, pendingNext = null;
    root.innerHTML = `<section class="music-workspace">
      <header class="music-header"><div class="music-brand"><span class="music-mark">${icon('note')}</span><h1>Folia</h1><span class="music-mode" id="musicMode">MUSIC SPACE</span></div>
        <div class="music-tools"><label class="music-device-label" title="切换控制目标，不会自动开始播放">${icon('device')}<span>播放设备</span><select id="musicDevice" aria-label="播放设备" data-hs-menu-width="272" data-hs-menu-title="播放设备"></select></label>
        ${local ? `<div class="music-view-switch" role="group" aria-label="播放器显示位置"><button class="music-button" data-music="embedded" aria-label="嵌入此页" aria-pressed="false">${icon('embed')}<span>嵌入此页</span></button><button class="music-button" data-music="window" aria-label="独立窗口" aria-pressed="false">${icon('window')}<span>独立窗口</span></button></div><button class="music-button music-remote-button" data-music="remote" aria-label="Remote 小窗" title="打开迷你遥控窗：控制当前音乐，不会另起播放器">${icon('remote')}<span>Remote 小窗</span></button>` : ''}</div></header>
      <div class="music-body" id="musicBody">
        <div class="music-stage" id="musicStage"><div class="music-welcome"><span class="music-welcome-note">${icon('note')}</span><h2 id="musicWelcomeTitle">${local ? '让音乐留在这里' : '选择一台播放设备'}</h2><p id="musicWelcomeText">${local ? '完整曲库与歌词空间，保留 Folia 原生主题。' : '手机与网页发送控制，声音由你选定的电脑播放。'}</p>${local ? '<button class="music-button music-primary" data-music="embedded">打开 Folia</button>' : ''}</div></div>
        <aside class="music-remote" id="musicRemote" aria-label="搜索与播放队列" hidden>
          <header class="music-drawer-header"><div><small>QUICK CONTROL</small><h2>搜索与队列</h2></div><button class="music-button music-icon-button" id="musicControlClose" aria-label="收起搜索与队列">${icon('close')}</button></header>
          <form id="musicSearch"><label class="music-source-label">音源<select id="musicSource" aria-label="音源" data-hs-menu-width="224"><option value="qq">QQ 音乐</option><option value="netease">网易云</option><option value="kugou">酷狗</option><option value="local">本地曲库</option></select></label><div class="music-query-row"><input id="musicQuery" aria-label="搜索歌曲" placeholder="歌曲、歌手或专辑" maxlength="300" required><button class="music-button music-icon-button" type="submit" aria-label="搜索" title="搜索">${icon('search')}</button></div></form>
          <div class="music-results-heading"><span id="musicResultsLabel">播放队列</span><button class="music-button" id="musicQueue">${icon('queue')} 当前队列</button></div>
          <div class="music-results" id="musicResults" aria-live="polite"></div>
        </aside>
      </div>
      <footer class="music-footer"><div class="music-playing"><i id="musicDot"></i><div><span id="musicNow">尚未播放</span><div class="music-notice" role="status" id="musicNotice">${local ? '按需加载 · 离开页面不停止播放' : '选择在线桌面设备后即可控制'}</div></div></div>
        <div class="music-transport" role="group" aria-label="播放控制"><button class="music-button music-playback-mode-button" id="musicPlaybackMode" aria-label="播放模式暂不可用" disabled>${icon('queue')}<span>播放模式</span></button><button class="music-button music-icon-button" data-command="previous" aria-label="上一首" title="上一首">${icon('previous')}</button><button class="music-button music-play-button" id="musicPlay" data-command="resume" aria-label="播放" title="播放">${icon('play')}</button><button class="music-button music-icon-button" data-command="next" aria-label="下一首" title="下一首">${icon('next')}</button></div>
        <div class="music-footer-tools"><button class="music-button" id="musicControlToggle" aria-expanded="false" aria-controls="musicRemote">${icon('queue')}<span>搜索 / 队列</span></button>${local ? `<details class="music-more"><summary class="music-button music-icon-button" aria-label="更多音乐选项" title="更多音乐选项">${icon('more')}</summary><div class="music-more-menu"><small>兼容与管理</small><button class="music-button" id="musicLegacy">打开旧曲库文件夹</button><button class="music-button" id="musicLegacyPlayer">使用旧版播放器</button><button class="music-button" id="musicUnload">关闭音乐模块</button></div></details>` : ''}</div></footer>
    </section>`;
    const $ = selector => root.querySelector(selector);
    const stage = $('#musicStage'), notice = $('#musicNotice'), select = $('#musicDevice');
    const shell = root.closest('.shell'), sidebar = shell?.querySelector('#sidebar');
    let navFrame = 0, lastPresentation = '';
    const say = (message, error = false) => { if (alive) { notice.textContent = message; notice.title = message; notice.classList.toggle('error', error); } };
    function syncPlaybackMode(music) {
      if (arguments.length) modeState = playbackModeState(music);
      const button = $('#musicPlaybackMode');
      button.disabled = opening || changingMode || !modeState.available;
      button.setAttribute('aria-busy', String(changingMode));
      if (button.dataset.mode !== modeState.id) {
        button.dataset.mode = modeState.id;
        button.innerHTML = icon(modeState.icon) + `<span>${modeState.label}</span>`;
      }
      button.title = changingMode ? '正在切换播放模式…' : modeState.available
        ? `${modeState.label} · 点击切换为${playbackModes[modeState.next].label}；与 Folia 内部同步，当前歌曲不中断`
        : `${modeState.id ? modeState.label + ' · ' : ''}${modeState.unavailableReason}`;
      button.setAttribute('aria-label', button.title);
    }
    function syncPlayNext(music) {
      if (arguments.length) playNextMusic = music;
      const available = playNextMusic?.provider === 'folia' && playNextMusic.connected !== false
        && playNextMusic.running !== false && playNextMusic.playNextAvailable === true;
      root.querySelectorAll('[data-play-next]').forEach(button => {
        const isCurrent = button.dataset.playNext === playNextMusic?.currentTrackId;
        button.disabled = opening || !!pendingNext || !available || isCurrent;
        button.setAttribute('aria-busy', String(pendingNext?.trackId === button.dataset.playNext));
        button.title = pendingNext ? '正在安排下一首…' : isCurrent ? '当前曲目已在播放'
          : available ? '下一首播放 · 当前歌曲不中断'
          : playNextMusic?.playNextAvailable === false ? '请先播放普通队列中的歌曲；私人 FM 或外部播放源不支持下一首播放'
          : '下一首播放暂不可用；请更新并重新打开 Folia 音乐模块';
      });
    }
    function isLocal() { return local && (!deviceId || deviceId === localId); }
    const closeDeviceMenu = () => select.dispatchEvent(new Event('harbour-menu-close'));
    // A DOM z-index cannot cover Electron's live Folia view. Only this select
    // opts into a small native overlay; no music command or second player.
    select.harbourMenu = () => alive && embedding && desktop.foliaDeviceMenu ? {
      open: rect => {
        const style = getComputedStyle(root);
        const theme = Object.fromEntries(Object.entries({ panel: '--panel', fg: '--fg', dim: '--fg-dim', border: '--border', accent: '--accent', fontFamily: '--font-ui' })
          .map(([key, variable]) => [key, style.getPropertyValue(variable).trim()]));
        return desktop.foliaDeviceMenu({
          anchor: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, theme,
          items: [...select.options].filter(o => !o.hidden).map(o => ({ value: o.value, label: o.dataset.hsOptionLabel || o.textContent,
            description: o.dataset.hsDescription || '', disabled: o.disabled, selected: o.selected })),
        });
      },
      close: () => desktop.foliaCloseDeviceMenu(),
      onError: error => say(`设备菜单无法打开：${error.message}`, true),
    } : null;
    function bounds() {
      const r = stage.getBoundingClientRect();
      // Measure the current slide, including its closing animation. Only the
      // native clip moves; Folia keeps the original full-sized viewport.
      const nav = sidebar && getComputedStyle(sidebar).visibility !== 'hidden' ? sidebar.getBoundingClientRect() : null;
      const overlaps = nav && nav.bottom > r.top && nav.top < r.bottom;
      const clipLeft = overlaps ? Math.max(0, Math.min(r.width, nav.right - r.left)) : 0;
      return { x: r.x, y: r.y, width: r.width, height: r.height, clipLeft };
    }
    const resize = () => {
      if (!alive) return;
      if (!embedding) return;
      // Hit-testing/visibility must not wait on a background-throttled animation
      // frame. Identical geometry is deduplicated without delaying overlays.
      const obstructed = !!document.querySelector('dialog[open], .md-modal, .login-overlay, .media-viewer-overlay, .music-more[open]');
      const rect = bounds(), visible = !obstructed && !document.hidden && rect.width > 0 && rect.height > 0;
      const geometry = JSON.stringify([rect, visible]);
      if (geometry !== lastGeometry) { lastGeometry = geometry; desktop.foliaResize(rect, visible); }
    };
    const observer = new ResizeObserver(resize); observer.observe(stage);
    if (sidebar) observer.observe(sidebar);
    // Transforms do not notify ResizeObserver. Follow only the short active
    // transition, not a permanent animation/polling loop, and deduplicate IPC.
    const followSidebar = () => {
      navFrame = 0;
      if (!alive) return;
      resize();
      if (!document.hidden && sidebar?.getAnimations().some(a => a.transitionProperty === 'transform' && (a.playState === 'running' || a.pending))) {
        navFrame = requestAnimationFrame(followSidebar);
      }
    };
    const sidebarTransition = event => {
      if (event.target !== sidebar || event.propertyName !== 'transform') return;
      cancelAnimationFrame(navFrame); followSidebar();
    };
    for (const type of ['transitionrun', 'transitionend', 'transitioncancel']) sidebar?.addEventListener(type, sidebarTransition, { signal: events.signal });
    // Observe overlay lifecycle, not every log row, counter or animation in the
    // Dashboard. An unrelated DOM mutation must never force a player layout read.
    // oldValue also catches a modal whose class was removed in place.
    const overlayClasses = ['md-modal', 'login-overlay', 'media-viewer-overlay', 'music-more'];
    const overlaySelector = 'dialog, .' + overlayClasses.join(', .');
    const hasOverlay = node => node.nodeType === 1 && (node.matches(overlaySelector) || node.querySelector(overlaySelector));
    const overlays = new MutationObserver(records => {
      const relevant = records.some(record => {
        if (record.type === 'childList') return [...record.addedNodes, ...record.removedNodes].some(hasOverlay);
        const target = record.target;
        return target === sidebar || target === shell || target === document.body
          || target.matches(overlaySelector)
          || (record.attributeName === 'class' && (record.oldValue || '').split(/\s+/).some(name => overlayClasses.includes(name)));
      });
      if (relevant) resize();
    });
    overlays.observe(document.body, { attributes: true, subtree: true, childList: true, attributeFilter: ['class', 'open'], attributeOldValue: true });
    document.addEventListener('visibilitychange', resize);
    window.addEventListener('resize', resize, { signal: events.signal });
    function presentation(mode) {
      const key = `${mode}:${isLocal()}`;
      if (key === lastPresentation) return;
      closeDeviceMenu();
      lastPresentation = key;
      embedding = mode === 'embedded' && isLocal();
      stage.querySelector('.music-welcome').hidden = embedding;
      root.querySelectorAll('[data-music="embedded"], [data-music="window"]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.music === mode && isLocal())));
      $('#musicMode').textContent = ({ embedded: '此页播放', window: '独立窗口', background: '后台播放', closed: 'MUSIC SPACE' })[mode] || '远端控制';
      $('#musicWelcomeTitle').textContent = !isLocal() ? '遥控你的音乐空间' : mode === 'window' ? '音乐正在独立窗口中' : mode === 'background' ? '音乐仍在后台' : '让音乐留在这里';
      $('#musicWelcomeText').textContent = !isLocal() ? '搜索与播放指令仅发送到所选设备。' : ['window', 'background'].includes(mode) ? '切回此页会保留当前歌曲、队列和浏览位置。' : '完整曲库与歌词空间，保留 Folia 原生主题。';
      lastGeometry = ''; resize();
    }
    async function open(mode) {
      if (opening) return;
      const turn = ++revision; opening = true;
      syncPlaybackMode();
      syncPlayNext();
      select.disabled = true;
      root.querySelectorAll('[data-music]').forEach(b => { b.disabled = true; });
      say(mode === 'remote' ? '正在打开迷你遥控窗…' : '正在打开 Folia…');
      try {
        if (local && !localId) await identifyLocal();
        if (!alive || turn !== revision) return;
        if (!isLocal()) {
          say(localId ? '请选择本机来打开界面；远端设备可在搜索面板中控制。' : '暂时未能识别本机设备，请稍后重试。');
          return;
        }
        const state = await desktop.foliaOpen(mode, bounds());
        if (!alive || turn !== revision) return;
        presentation(state.mode);
        say(mode === 'embedded' ? '已嵌入 · 离开页面不停止播放' : mode === 'remote' ? 'Remote 已显示 · 与主播放器共用队列' : '已移入独立窗口 · 播放不中断');
      } catch (error) { if (turn === revision) say(error.message, true); }
      finally { if (alive) { opening = false; select.disabled = false; root.querySelectorAll('[data-music]').forEach(b => { b.disabled = false; }); syncPlaybackMode(); syncPlayNext(); } }
    }
    const command = async value => {
      const turn = revision;
      if (local && !localId) await identifyLocal();
      if (!alive || turn !== revision) throw new Error('音乐页面或控制设备已变更，未提交指令');
      if (isLocal()) return desktop.foliaCommand(value);
      if (!deviceId) throw new Error('请先选择播放设备');
      return (await api('/api/music/control', { method: 'POST', body: JSON.stringify({ ...value, player: 'folia', deviceId }) })).result;
    };
    function renderTracks(tracks = [], label = '播放队列') {
      $('#musicResultsLabel').textContent = `${label} · ${tracks.length}`;
      $('#musicResults').innerHTML = tracks.slice(0, 200).map(track => `<div class="music-result-row"><button class="music-result" data-track="${esc(track.id)}" aria-label="立即播放 ${esc(track.title)}"><span>${esc(track.title)}</span><small>${esc(track.artist || '')}</small>${icon('play')}</button><button class="music-button music-play-next" data-play-next="${esc(track.id)}" aria-label="下一首播放 ${esc(track.title)}" title="下一首播放" disabled>${icon('queue')}<span>下一首播放</span></button></div>`).join('') || '<p class="music-no-results">这里还没有曲目。<br>搜索歌曲，或在 Folia 中加入队列。</p>';
      syncPlayNext();
    }
    function showControls(show) {
      $('#musicRemote').hidden = !show;
      $('#musicBody').classList.toggle('has-controls', show);
      $('#musicControlToggle').setAttribute('aria-expanded', String(show));
      if (show) $('#musicQuery').focus(); else $('#musicControlToggle').focus();
      resize();
    }
    async function queue() {
      const turn = revision, query = ++queryRevision, stateStamp = modeRevision;
      const result = await command({ action: 'queue' });
      if (alive && turn === revision && query === queryRevision) {
        if (stateStamp === modeRevision) syncPlayNext(result);
        renderTracks(result.tracks); $('#musicResults').removeAttribute('aria-busy');
      }
    }
    async function refresh() {
      if (!alive || polling || document.hidden) return; polling = true;
      const turn = revision;
      try {
        if (local && !localId) await identifyLocal();
        if (!alive || turn !== revision) return;
        // Device polling only needs the current song. Full queues are fetched
        // explicitly by queue()/search and are never rebuilt by this heartbeat.
        const response = await api('/api/music/devices?summary=1');
        if (!alive || turn !== revision) return;
        devices = response.devices || [];
        const available = devices.map(d => ({ id: d.id, label: d.label, status: '在线' }));
        if (local && localId && !available.some(d => d.id === localId)) available.unshift({ id: localId, label: '本机', status: '服务连接中' });
        if (!deviceId && local) deviceId = localId;
        if (!deviceId && available.length === 1) deviceId = available[0].id;
        if (deviceId && !available.some(d => d.id === deviceId)) available.push({ id: deviceId, label: '已选设备', status: '离线' });
        const placeholder = available.length ? '<option value="" hidden="">选择设备</option>' : '<option value="" disabled="" data-hs-description="请先启动一台 Harbour 桌面客户端">暂无在线设备</option>';
        const html = placeholder + available.map(d => {
          const here = d.id === localId;
          const suffix = here && d.label !== '本机' ? ' · 本机' : d.status === '离线' ? ' · 离线' : '';
          return `<option value="${esc(d.id)}" data-hs-option-label="${esc(d.label)}" data-hs-description="${here ? '本机' : '远端设备'} · ${esc(d.status)}">${esc(d.label)}${suffix}</option>`;
        }).join('');
        if (deviceOptions !== html) { select.innerHTML = html; deviceOptions = html; }
        // Polling the same selection must not rebuild an open menu and steal
        // focus from somebody reading it or navigating with the keyboard.
        if (select.value !== deviceId) select.value = deviceId;
        const modeStamp = modeRevision;
        const music = isLocal() ? await desktop.foliaStatus() : devices.find(d => d.id === deviceId)?.music;
        if (!alive || turn !== revision) return;
        if (modeStamp === modeRevision) { syncPlaybackMode(music); syncPlayNext(music); }
        const track = music?.tracks?.find(t => t.id === music.currentTrackId);
        const nowText = track ? `${track.title}${track.artist ? ' · ' + track.artist : ''}` : '尚未播放';
        if ($('#musicNow').textContent !== nowText) $('#musicNow').textContent = nowText;
        const playing = !!music?.loaded && !music.paused;
        $('#musicDot').classList.toggle('playing', playing);
        const play = $('#musicPlay'), action = playing ? 'pause' : 'resume';
        if (play.dataset.command !== action) { play.dataset.command = action; play.innerHTML = icon(playing ? 'pause' : 'play'); play.title = playing ? '暂停' : '播放'; play.setAttribute('aria-label', play.title); }
        if (!opening) presentation(isLocal() ? music?.mode || 'closed' : 'remote');
      } catch (error) { if (alive && turn === revision) { syncPlaybackMode(null); syncPlayNext(null); if (!local) say(error.message, true); } }
      finally { polling = false; }
    }
    root.addEventListener('click', async event => {
      const button = event.target.closest('button'); if (!button) return;
      if (button.dataset.playNext) {
        if (button.disabled || opening || pendingNext) return;
        const operation = { trackId: button.dataset.playNext, turn: revision, query: queryRevision, stateStamp: modeRevision, previousMode: playNextMusic?.playbackMode };
        pendingNext = operation; syncPlayNext();
        try {
          const result = await command({ action: 'play_next', trackId: operation.trackId });
          if (!alive || operation.turn !== revision) return;
          if (result?.accepted !== true || !Array.isArray(result.tracks)) throw new Error('播放器未确认下一首播放；请查询当前队列，不要自动重试。');
          if (operation.stateStamp === modeRevision) { syncPlaybackMode(result); syncPlayNext(result); }
          // Use the player's committed queue, never an optimistic reorder or a replay.
          // A newer search/queue request keeps ownership of the result panel.
          if (operation.query === queryRevision) { ++queryRevision; renderTracks(result.tracks); }
          say(operation.previousMode === 'one' && result.playbackMode === 'all'
            ? '已设为下一首播放；单曲循环已切换为列表循环，当前歌曲不中断。'
            : '已设为下一首播放，当前歌曲不中断。');
          void refresh();
        } catch (error) { if (alive && operation.turn === revision) say(error.message, true); }
        finally { if (pendingNext === operation) { pendingNext = null; if (alive) syncPlayNext(); } }
        return;
      }
      if (button.id === 'musicPlaybackMode') {
        if (opening || changingMode || !modeState.available) return;
        const turn = revision, modeStamp = modeRevision, playbackMode = modeState.next; changingMode = true; syncPlaybackMode();
        try {
          const result = await command({ action: 'set_playback_mode', playbackMode });
          if (!alive || turn !== revision) return;
          // Modes are authoritative player state, not a second queue or an
          // optimistic icon flip. Do not refetch/rebuild the queue here.
          if (modeStamp === modeRevision) syncPlaybackMode(result);
          say(modeState.id ? `已切换为${modeState.label}，与 Folia 内部同步。` : '指令已送达，等待播放器回报模式。');
          void refresh();
        } catch (error) { if (alive && turn === revision) say(error.message, true); }
        finally { changingMode = false; if (alive) syncPlaybackMode(); }
        return;
      }
      try {
        if (button.dataset.music) return void open(button.dataset.music);
        if (button.dataset.command) { button.disabled = true; await command({ action: button.dataset.command }); say('播放控制已送达'); void refresh(); }
        if (button.dataset.track) { button.disabled = true; await command({ action: 'play', trackId: button.dataset.track }); say('已提交所选曲目'); void refresh(); }
        if (button.id === 'musicControlToggle') { const show = $('#musicRemote').hidden; showControls(show); if (show) await queue(); }
        if (button.id === 'musicControlClose') showControls(false);
        if (button.id === 'musicQueue') await queue();
        if (button.id === 'musicUnload') { ++revision; await command({ action: 'close' }); if (alive) presentation('closed'); say('音乐模块已关闭；曲库和账号设置已保留。'); }
        if (button.id === 'musicLegacy') { await desktop.foliaHide(); if (alive) presentation('background'); const result = await desktop.foliaLegacyLibrary(); say(`旧曲库已打开，共 ${result.tracks} 首。可在 Folia「本地」导入；原文件未移动。`); }
        if (button.id === 'musicLegacyPlayer') { await desktop.foliaHide(); if (alive) presentation('background'); await desktop.foliaLegacyLibrary('player'); say('已切回旧版播放器。'); }
      } catch (error) { say(error.message, true); }
      finally { if (alive && !button.dataset.music) { button.disabled = false; if (button.closest('.music-more')) $('.music-more').open = false; } }
    }, { signal: events.signal });
    root.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented) { if (!$('#musicRemote').hidden) showControls(false); if ($('.music-more')) $('.music-more').open = false; } }, { signal: events.signal });
    document.addEventListener('pointerdown', event => { if (alive && !event.target.closest('.music-more') && $('.music-more')) $('.music-more').open = false; }, { signal: events.signal });
    select.addEventListener('change', () => {
      ++revision; ++queryRevision; deviceId = select.value; localStorage.setItem('harbour-music-device', deviceId);
      syncPlaybackMode(null);
      pendingNext = null; syncPlayNext(null);
      if (embedding) void desktop.foliaHide(); presentation(isLocal() ? 'closed' : 'remote');
      showControls(true); renderTracks(); $('#musicResults').removeAttribute('aria-busy');
      say('已切换控制设备；不会自动在其它设备播放。'); void refresh();
    }, { signal: events.signal });
    $('#musicSearch').addEventListener('submit', async event => {
      event.preventDefault(); const turn = revision, query = ++queryRevision; say('正在搜索…');
      $('#musicResults').setAttribute('aria-busy', 'true');
      try {
        const result = await command({ action: 'search', query: $('#musicQuery').value, source: $('#musicSource').value });
        if (alive && turn === revision && query === queryRevision) { renderTracks(result.tracks, '搜索结果'); say('可立即播放或安排下一首；音源可用性取决于账号和地区。'); }
      } catch (error) { if (turn === revision && query === queryRevision) say(error.message, true); }
      finally { if (alive && query === queryRevision) $('#musicResults').removeAttribute('aria-busy'); }
    }, { signal: events.signal });
    const unsubscribeMode = local ? desktop.onCompanionState?.(state => {
      if (alive && isLocal()) { ++modeRevision; syncPlaybackMode(state.music); syncPlayNext(state.music); }
    }) : null;
    resize(); renderTracks(); syncPlaybackMode(); if (!local) showControls(true);
    void refresh(); const timer = setInterval(refresh, 2500);
    return () => { closeDeviceMenu(); delete select.harbourMenu; alive = false; ++revision; events.abort(); unsubscribeMode?.(); cancelAnimationFrame(navFrame); clearInterval(timer); observer.disconnect(); overlays.disconnect(); document.removeEventListener('visibilitychange', resize); if (local) void desktop.foliaHide().catch(() => {}); };
  }
  return { mount, icon, playbackModes, playbackModeState };
})();
