(() => {
  const desktop = window.harbourDesktop;
  const audio = document.getElementById("audio");
  const list = document.getElementById("trackList");
  const search = document.getElementById("search");
  const progress = document.getElementById("progress");
  const volume = document.getElementById("volume");
  let localTracks = [];
  let currentId = "";
  let provider = "local";
  let providerState = null;
  let reportTimer = 0;
  let lastReportAt = 0;
  let providerBusy = false;
  let providerRevision = 0, listMarkup = "";
  const paintList = markup => { if (markup !== listMarkup) { listMarkup = markup; list.innerHTML = markup; } };

  const fmt = (seconds) => {
    const value = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
  };
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const isQQMusic = () => provider === "qqmusic";
  const currentLocal = () => localTracks.find((track) => track.id === currentId) || null;
  const currentQQ = () => providerState?.tracks?.find((track) => track.id === providerState.currentTrackId) || providerState?.tracks?.[0] || null;
  function renderLocalClock() {
    if (window.HarbourVisualActivity?.isActive() === false) return;
    progress.value = audio.duration ? String(Math.round(audio.currentTime / audio.duration * 1000)) : "0";
    document.getElementById("time").textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;
  }

  function renderProvider() {
    const qq = isQQMusic();
    document.querySelectorAll("[data-provider]").forEach((button) => button.classList.toggle("is-active", button.dataset.provider === provider));
    document.getElementById("importMusic").hidden = qq;
    document.getElementById("openQQMusic").hidden = !qq;
    document.getElementById("providerTitle").textContent = qq ? "QQ 音乐客户端" : "Harbour 本地曲库";
    document.getElementById("providerHint").textContent = qq
      ? "复用本机登录与会员；Harbour 不读取账号或 Cookie"
      : "音频与歌单只保存在当前电脑";
    search.disabled = qq;
    search.placeholder = qq ? "云端选歌请在 QQ 音乐客户端完成" : "搜索本机曲库";
    progress.disabled = qq;
    volume.disabled = qq;
    document.querySelector(".volume-label").textContent = qq ? "音量由 QQ 音乐管理" : "音量";
  }

  function render() {
    if (window.HarbourVisualActivity?.isActive() === false) return;
    renderProvider();
    if (isQQMusic()) {
      const state = providerState || {};
      const track = currentQQ();
      const connected = state.connected === true;
      const installed = state.providerAvailable !== false;
      const playing = !!track && state.paused === false;
      document.getElementById("count").textContent = connected ? "已连接" : installed ? "等待播放" : "未安装";
      document.getElementById("nowTitle").textContent = track?.title || (installed ? "等待 QQ 音乐" : "未检测到 QQ 音乐");
      document.getElementById("nowArtist").textContent = track
        ? `${track.artist || "未知歌手"}${track.album ? ` · ${track.album}` : ""}`
        : state.providerReason || "打开 QQ 音乐并选择一首歌，Elaina 就能接管播放控制。";
      document.getElementById("providerState").textContent = playing ? "● 正在播放" : connected ? "Ⅱ 已暂停" : "○ 未连接";
      document.getElementById("providerState").classList.toggle("is-online", connected);
      document.getElementById("toggle").textContent = playing ? "Ⅱ" : "▶";
      document.getElementById("time").textContent = `${fmt((state.positionMs || 0) / 1000)} / ${fmt((state.durationMs || track?.durationMs || 0) / 1000)}`;
      progress.value = state.durationMs ? String(Math.round((state.positionMs || 0) / state.durationMs * 1000)) : "0";
      paintList(track
        ? `<div class="item is-active qq-current"><span class="cover qq-cover">Q</span><div class="grow"><strong>${esc(track.title)}</strong><small>${esc(track.artist || "QQ 音乐")}${track.album ? ` · ${esc(track.album)}` : ""}</small></div><span class="source-badge">QQ MUSIC</span></div><div class="provider-note">Harbour 通过 Windows 媒体会话读取并控制当前曲目。搜索、歌单、会员与版权仍由已登录的 QQ 音乐客户端处理。</div>`
        : `<div class="empty">${esc(state.providerReason || "QQ 音乐尚未提供当前曲目。请打开客户端并选择一首歌。")}</div>`);
      document.body.classList.toggle("is-playing", playing);
      return;
    }

    const query = search.value.trim().toLowerCase();
    const shown = localTracks.filter((track) => `${track.title} ${track.artist || ""} ${track.album || ""}`.toLowerCase().includes(query));
    document.getElementById("count").textContent = `${localTracks.length} 首`;
    paintList(shown.length
      ? shown.map((track) => `<div class="item${track.id === currentId ? " is-active" : ""}" data-id="${esc(track.id)}"><span class="cover">♪</span><div class="grow"><strong>${esc(track.title)}</strong><small>${esc(track.artist || "本地音乐")} · ${esc(track.album || "Harbour Library")}</small></div><button class="btn icon track-action" data-remove="${esc(track.id)}" title="从本机曲库删除">×</button></div>`).join("")
      : `<div class="empty">${localTracks.length ? "没有匹配的歌曲" : "尚未导入音乐。这里的文件只保存在当前电脑。"}</div>`);
    const track = currentLocal();
    document.getElementById("nowTitle").textContent = track?.title || "还没有播放";
    document.getElementById("nowArtist").textContent = track ? `${track.artist || "本地音乐"} · ${track.album || "Harbour Library"}` : "把喜欢的歌留在本机，树莓派后端不会读取音频。";
    document.getElementById("providerState").textContent = track && !audio.paused ? "● 正在播放" : "○ 本地就绪";
    document.getElementById("providerState").classList.toggle("is-online", !!track);
    document.body.classList.toggle("is-playing", !!track && !audio.paused);
    document.getElementById("toggle").textContent = track && !audio.paused ? "Ⅱ" : "▶";
    renderLocalClock();
  }

  function snapshot() {
    return {
      provider: "local",
      connected: true,
      loaded: !!currentId,
      paused: audio.paused,
      volume: Math.round(audio.volume * 100),
      positionMs: Math.round((audio.currentTime || 0) * 1000),
      durationMs: Math.round((audio.duration || 0) * 1000),
      currentTrackId: currentId || undefined,
      providerAvailable: true,
      providerCapabilities: ["status", "search", "open", "play", "pause", "resume", "stop", "next", "previous", "set_volume"],
      tracks: localTracks.map(({ id, title, artist, album, durationMs }) => ({ id, title, artist, album, durationMs })),
    };
  }

  function report(immediate = false) {
    if (isQQMusic()) return;
    clearTimeout(reportTimer);
    const send = () => {
      reportTimer = 0;
      lastReportAt = Date.now();
      desktop?.reportMusicState?.(snapshot());
    };
    const remaining = Math.max(0, 1_000 - (Date.now() - lastReportAt));
    if (immediate || remaining === 0) send();
    else reportTimer = setTimeout(send, remaining);
  }

  async function loadLibrary() {
    localTracks = await desktop.listMusic();
    render();
    report(true);
  }

  async function refreshProviderState() {
    const revision = providerRevision;
    const payload = await desktop.getMusicProvider();
    if (revision !== providerRevision) return;
    provider = payload?.provider === "qqmusic" ? "qqmusic" : "local";
    providerState = payload?.state || null;
    render();
  }

  async function playLocal(id = currentId) {
    const track = localTracks.find((item) => item.id === id);
    if (!track) throw new Error("曲目不在本地曲库中");
    if (currentId !== track.id) {
      currentId = track.id;
      audio.src = track.url;
    }
    await audio.play();
    render(); report(true);
    return { playing: true, track: { id: track.id, title: track.title, artist: track.artist } };
  }

  function adjacent(delta) {
    if (!localTracks.length) return null;
    const index = Math.max(0, localTracks.findIndex((track) => track.id === currentId));
    return localTracks[(index + delta + localTracks.length) % localTracks.length];
  }

  async function localCommand(input) {
    const action = String(input?.action || "");
    if (action === "open") return { opened: true };
    if (action === "play") return playLocal(String(input.trackId || currentId));
    if (action === "pause") { audio.pause(); render(); report(true); return { paused: true }; }
    if (action === "resume") { if (!currentId && localTracks[0]) currentId = localTracks[0].id; return playLocal(currentId); }
    if (action === "stop") { audio.pause(); audio.currentTime = 0; currentId = ""; audio.removeAttribute("src"); render(); report(true); return { stopped: true }; }
    if (action === "next" || action === "previous") { const track = adjacent(action === "next" ? 1 : -1); return track ? playLocal(track.id) : { skipped: false }; }
    if (action === "set_volume") { audio.volume = Math.max(0, Math.min(1, Number(input.volume || 0) / 100)); volume.value = String(Math.round(audio.volume * 100)); report(true); return { volume: Math.round(audio.volume * 100) }; }
    throw new Error(`不支持的音乐命令：${action}`);
  }

  async function qqCommand(action) {
    if (providerBusy) return null;
    providerBusy = true;
    document.body.classList.add("is-provider-busy");
    try {
      const payload = await desktop.controlQQMusic(action);
      providerState = payload?.state || providerState;
      render();
      return payload?.result;
    } catch (error) {
      providerState = { ...(providerState || {}), providerReason: error instanceof Error ? error.message : String(error) };
      render();
      throw error;
    } finally {
      providerBusy = false;
      document.body.classList.remove("is-provider-busy");
    }
  }

  document.getElementById("providerTabs").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-provider]");
    if (!button || providerBusy || button.dataset.provider === provider) return;
    providerBusy = true;
    try {
      if (provider === "local" && !audio.paused) { audio.pause(); report(true); }
      const payload = await desktop.setMusicProvider(button.dataset.provider);
      provider = payload.provider;
      providerState = payload.state;
      render();
    } finally {
      providerBusy = false;
    }
  });
  document.getElementById("importMusic").addEventListener("click", async () => { await desktop.importMusic(); await loadLibrary(); });
  document.getElementById("openQQMusic").addEventListener("click", () => { void qqCommand("open"); });
  document.getElementById("toggle").addEventListener("click", () => {
    if (isQQMusic()) return void qqCommand(providerState?.paused === false ? "pause" : "resume");
    if (!currentId && localTracks[0]) return void playLocal(localTracks[0].id);
    if (audio.paused) void playLocal(); else { audio.pause(); render(); report(true); }
  });
  document.getElementById("previous").addEventListener("click", () => {
    if (isQQMusic()) return void qqCommand("previous");
    const track = adjacent(-1); if (track) void playLocal(track.id);
  });
  document.getElementById("next").addEventListener("click", () => {
    if (isQQMusic()) return void qqCommand("next");
    const track = adjacent(1); if (track) void playLocal(track.id);
  });
  search.addEventListener("input", render);
  list.addEventListener("click", async (event) => {
    if (isQQMusic()) return;
    const remove = event.target.closest("[data-remove]");
    if (remove) { event.stopPropagation(); if (await desktop.removeMusic(remove.dataset.remove)) { if (currentId === remove.dataset.remove) await localCommand({ action: "stop" }); await loadLibrary(); } return; }
    const item = event.target.closest("[data-id]"); if (item) void playLocal(item.dataset.id);
  });
  progress.addEventListener("input", () => { if (!isQQMusic() && Number.isFinite(audio.duration)) audio.currentTime = audio.duration * Number(progress.value) / 1000; });
  volume.addEventListener("input", () => { if (!isQQMusic()) { audio.volume = Number(volume.value) / 100; report(); } });
  audio.addEventListener("timeupdate", () => {
    if (isQQMusic()) return;
    renderLocalClock();
    report();
  });
  ["play", "pause", "loadedmetadata", "ended", "error"].forEach((name) => audio.addEventListener(name, () => {
    if (name === "ended") { const track = adjacent(1); if (track) void playLocal(track.id); }
    render(); report(true);
  }));
  desktop?.onMusicCommand?.((input) => localCommand(input));
  // The main process is the one provider clock. UI state is pushed, not polled again.
  const unsubscribe = desktop.onCompanionState?.(snapshot => {
    if (!snapshot.music) return;
    const previous = provider;
    ++providerRevision; provider = snapshot.music.provider || provider;
    providerState = snapshot.music;
    // Local timeupdate is already authoritative here. Its own report echo must
    // not filter/map the full library again, nor should unrelated pet events.
    if (previous !== provider || isQQMusic()) render();
  });
  const removeVisualListener = window.HarbourVisualActivity?.subscribe(active => { if (active) render(); });
  window.addEventListener("pagehide", () => { unsubscribe?.(); removeVisualListener?.(); });

  Promise.all([loadLibrary(), refreshProviderState()]).catch((error) => {
    list.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  });
})();
