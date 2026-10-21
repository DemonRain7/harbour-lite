/* A remote control for the existing local music owner, never an audio player.
 * Queue/time updates use a separate visible-only IPC stream. A bounded local
 * display clock smooths real Folia samples; no network or second audio owner. */
window.OrbMusic = class OrbMusic {
  constructor({ invoke, bridge, extras }) {
    Object.assign(this, { invoke, extras });
    this.lastVolume = new Map(); this.generation = 0;
    this.lyrics = new window.OrbLyrics({ invoke, open: async () => {
      try { await invoke("expand", { expanded: true, pinned: true }); await this.open(); } catch { /* Window is closing. */ }
    } });
    bridge.onMusic(state => this.accept(state));
    document.addEventListener("visibilitychange", () => this.tick());
    window.HarbourVisualActivity?.subscribe(() => this.tick());
    window.addEventListener("pagehide", () => clearTimeout(this.clockTimer));
  }
  shell(state) {
    this.enabled = state.enabled; this.overlay = state.lyricOverlay;
    this.tick();
  }
  tick() {
    clearTimeout(this.clockTimer);
    if (document.hidden || window.HarbourVisualActivity?.isActive() === false) return;
    const active = this.enabled && (this.root || this.overlay);
    if (!active) { this.lyrics.root.hidden = true; return; }
    const clock = window.OrbLyricClock.read(this.state);
    this.lyrics.paint(this.state, clock, this.overlay);
    if (this.root) {
      this.lyrics.paintPanel(this.$("lyrics"), this.state, clock);
      if (!this.seekTarget) {
        const seek = this.$("seek");
        seek.value = this.state?.durationMs ? String(Math.round(clock.positionMs / this.state.durationMs * 1000)) : "0";
        this.paintRange(seek); this.$("elapsed").textContent = this.time(clock.positionMs);
        seek.setAttribute("aria-valuetext", `${this.time(clock.positionMs)} / ${this.time(this.state?.durationMs)}`);
      }
    }
    if (!document.hidden && this.state?.clockRunning && !this.state.paused && !clock.stale)
      this.clockTimer = setTimeout(() => this.tick(), 200);
  }
  icon(name) { return `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`; }
  async open() {
    const root = document.createElement("div"); root.className = "orb-music-player";
    await this.extras.view("音乐陪伴", async () => [root], () => this.stop());
    if (!root.isConnected) return;
    this.root = root; this.pending = false; this.error = ""; this.queueKey = ""; this.seekTarget = null; this.volumeTarget = null;
    const generation = ++this.generation;
    this.build(); this.render();
    try {
      this.accept(await this.invoke("music-watch", { value: true }), generation);
      if (generation === this.generation && this.root) (this.$("toggle").disabled ? this.$("open") : this.$("toggle")).focus({ preventScroll: true });
    }
    catch (e) { if (generation === this.generation) { this.error = e.message; this.render(); } }
  }
  stop() {
    ++this.generation;
    if (this.root) void this.invoke("music-watch", { value: false }).catch(() => {});
    this.root = null; this.tick();
  }
  hide() { if (this.root) this.extras.close(); }
  $(name) { return this.root.querySelector(`[data-music="${name}"]`); }
  accept(state, generation = this.generation) {
    if (generation !== this.generation || !state || state.revision < (this.state?.revision ?? -1)) return;
    this.state = state;
    this.overlay = state.lyricOverlay;
    if (state.volume > 0) this.lastVolume.set(state.provider, state.volume);
    if (this.root) this.render(); else this.tick();
  }
  async command(action, args = {}) {
    if (!this.state || this.pending || this.state.busy) return;
    const generation = this.generation;
    this.pending = true; this.error = ""; this.render();
    try {
      const result = await this.invoke(action === "open-folia" ? action : "music-command", {
        command: { action, provider: this.state.provider, ...args },
      });
      this.accept(result, generation);
    } catch (e) { if (generation === this.generation) this.error = e.message; }
    finally { if (generation === this.generation) { this.pending = false; this.render(); } }
  }
  build() {
    const icon = name => this.icon(name);
    this.root.dataset.lyrics = "true";
    this.root.innerHTML = `
      <div class="music-caption"><span data-music="source"></span><button class="quiet" data-music="open" type="button">打开 Folia ${icon("open")}</button></div>
      <div class="music-song"><span class="music-disc" aria-hidden="true">${icon("music")}</span><div><strong data-music="title"></strong><small data-music="artist"></small></div></div>
      <section class="music-lyrics" data-music="lyrics" aria-label="同步歌词"><p data-lyric="previous"></p><p data-lyric="current"></p><p data-lyric="translation" hidden></p><p data-lyric="next"></p></section>
      <div class="music-timeline"><input data-music="seek" type="range" min="0" max="1000" step="1" value="0" aria-label="播放进度"><div><span data-music="elapsed">0:00</span><span data-music="duration">0:00</span></div></div>
      <div class="music-controls">
        <button type="button" class="icon music-mode" data-music="mode">${icon("sequence")}<small hidden>1</small></button>
        <button type="button" class="icon" data-music="previous" aria-label="上一首" title="上一首">${icon("previous")}</button>
        <button type="button" class="music-play" data-music="toggle">${icon("play")}</button>
        <button type="button" class="icon" data-music="next" aria-label="下一首" title="下一首">${icon("next")}</button>
        <button type="button" class="icon" data-music="queue-toggle" aria-label="播放队列" title="播放队列" aria-expanded="false">${icon("queue")}</button>
      </div>
      <div class="music-volume"><button type="button" class="icon" data-music="mute">${icon("volume")}</button><input data-music="volume" type="range" min="0" max="100" step="1" value="70" aria-label="音量"><output data-music="volume-value">70%</output></div>
      <div class="music-lyric-tools"><button type="button" data-music="lyrics-toggle" aria-pressed="true" title="切换歌词与音量面板">歌词</button><button type="button" data-music="lyric-overlay" aria-pressed="false" title="在小球或贴边探头旁显示歌词，展开后也保留">桌面歌词</button></div>
      <p class="music-feedback" data-music="feedback" role="status" hidden></p>
      <section class="music-queue" data-music="queue" hidden><div class="music-queue-heading"><span data-music="queue-label"></span><input type="search" data-music="search" placeholder="查找队列" aria-label="查找队列歌曲"></div><div data-music="tracks"></div><p data-music="queue-empty" class="music-feedback" hidden>没有匹配的歌曲</p><small data-music="queue-limit" hidden>这里只展示前 200 首，完整队列请在 Folia 查看。</small></section>`;
    this.$("open").onclick = () => this.command("open-folia");
    this.$("lyrics-toggle").onclick = () => {
      const visible = this.root.dataset.lyrics !== "true";
      this.root.dataset.lyrics = String(visible); this.$("lyrics").hidden = !visible;
      this.$("lyrics-toggle").setAttribute("aria-pressed", String(visible));
    };
    this.$("lyric-overlay").onclick = async () => {
      const generation = this.generation;
      try { this.accept(await this.invoke("lyric-overlay", { value: !this.overlay }), generation); }
      catch (e) { if (generation === this.generation) { this.error = e.message; this.render(); } }
    };
    for (const action of ["previous", "next"]) this.$(action).onclick = () => this.command(action);
    this.$("toggle").onclick = () => this.command(this.state.paused ? "resume" : "pause");
    this.$("mode").onclick = () => {
      const modes = ["off", "all", "one", "shuffle"];
      void this.command("set_playback_mode", { playbackMode: modes[(modes.indexOf(this.state.playbackMode) + 1) % 4] });
    };
    this.$("mute").onclick = () => this.command("set_volume", { volume: this.state.volume > 0 ? 0 : this.lastVolume.get(this.state.provider) || 70 });
    this.$("queue-toggle").onclick = () => {
      const open = this.$("queue").hidden;
      this.$("queue").hidden = !open; this.$("queue-toggle").setAttribute("aria-expanded", String(open));
      this.label("queue-toggle", open ? "返回播放控制" : "播放队列");
      if (open) this.$("search").focus({ preventScroll: true });
    };
    this.$("search").oninput = () => this.filterQueue();
    const seek = this.$("seek"), volume = this.$("volume");
    const target = () => ({ provider: this.state.provider, trackId: this.state.currentTrackId, durationMs: this.state.durationMs });
    seek.onpointerdown = () => { if (this.state) this.seekTarget = target(); };
    seek.oninput = () => {
      this.seekTarget ||= target(); this.paintRange(seek);
      this.$("elapsed").textContent = this.time(Number(seek.value) / 1000 * this.seekTarget.durationMs);
    };
    seek.onchange = () => {
      const saved = this.seekTarget || target(); this.seekTarget = null;
      void this.command("seek", { provider: saved.provider, trackId: saved.trackId, positionMs: Math.round(Number(seek.value) / 1000 * saved.durationMs) });
    };
    seek.onpointercancel = seek.onblur = () => { this.seekTarget = null; this.render(); };
    volume.onpointerdown = () => { if (this.state) this.volumeTarget = this.state.provider; };
    volume.oninput = () => {
      this.volumeTarget ||= this.state.provider; this.paintRange(volume); this.$("volume-value").textContent = `${volume.value}%`;
    };
    volume.onchange = () => {
      const provider = this.volumeTarget || this.state.provider; this.volumeTarget = null;
      void this.command("set_volume", { provider, volume: Number(volume.value) });
    };
    volume.onpointercancel = volume.onblur = () => { this.volumeTarget = null; this.render(); };
  }
  time(ms) { const seconds = Math.floor((ms || 0) / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
  paintRange(input) { input.style.setProperty("--fill", `${Number(input.value) / Number(input.max) * 100}%`); }
  label(name, text) { this.$(name).title = text; this.$(name).setAttribute("aria-label", text); }
  render() {
    if (!this.root) return;
    const s = this.state, busy = this.pending || s?.busy, can = action => !busy && s?.controls.includes(action);
    const current = s?.tracks.find(t => t.id === s.currentTrackId), playing = s?.loaded && !s.paused;
    this.root.dataset.playing = String(!!playing); this.root.setAttribute("aria-busy", String(!!busy));
    const provider = { folia: "Folia", local: "本地音乐", qqmusic: "QQ 音乐" }[s?.provider] || "音乐";
    this.$("source").textContent = `${provider} · ${!s ? "正在连接" : !s.ready ? "未连接" : !s.loaded ? "待选歌" : playing ? "正在播放" : "已暂停"}`;
    this.$("open").disabled = !!busy || !s || !s.supported;
    this.$("lyric-overlay").setAttribute("aria-pressed", String(!!this.overlay));
    this.$("lyric-overlay").disabled = !s?.supported;
    this.label("open", s?.provider === "folia" ? "打开 Folia 选歌与管理曲库" : "打开并切换到 Folia，暂停当前来源的音乐");
    this.$("title").textContent = current?.title || "给此刻配一首歌";
    this.$("title").title = current?.title || "";
    this.$("artist").textContent = current?.artist || (current ? "音乐陪伴" : can("resume") ? "点击播放，继续上次的音乐。" : "在 Folia 选择一首歌，回来继续听。");
    this.$("artist").title = current?.artist || "";
    for (const action of ["previous", "next"]) this.$(action).disabled = !can(action);
    this.$("toggle").disabled = !can(s?.paused ? "resume" : "pause");
    this.$("toggle").querySelector("use").setAttribute("href", playing ? "#i-pause" : "#i-play"); this.label("toggle", playing ? "暂停" : "播放");
    const mode = s?.playbackMode || "off", modeNames = { off: "顺序播放", all: "列表循环", one: "单曲循环", shuffle: "随机播放" };
    this.$("mode").disabled = !can("set_playback_mode");
    this.$("mode").querySelector("use").setAttribute("href", `#i-${{ off: "sequence", all: "repeat", one: "repeat", shuffle: "shuffle" }[mode]}`);
    this.$("mode").querySelector("small").hidden = mode !== "one";
    this.$("mode").setAttribute("aria-pressed", String(mode !== "off")); this.label("mode", `${modeNames[mode]} · 点击切换播放模式`);
    this.$("mute").disabled = !can("set_volume"); this.label("mute", s?.volume === 0 ? "恢复音量" : "静音");
    this.$("mute").querySelector("use").setAttribute("href", s?.volume === 0 ? "#i-mute" : "#i-volume");
    const seek = this.$("seek"), volume = this.$("volume");
    seek.disabled = !can("seek"); volume.disabled = !can("set_volume");
    if (!this.seekTarget) {
      seek.value = s?.durationMs ? String(Math.round(s.positionMs / s.durationMs * 1000)) : "0";
      this.paintRange(seek); this.$("elapsed").textContent = this.time(s?.positionMs);
      seek.setAttribute("aria-valuetext", `${this.time(s?.positionMs)} / ${this.time(s?.durationMs)}`);
    }
    this.$("duration").textContent = this.time(s?.durationMs);
    if (!this.volumeTarget) { volume.value = String(s?.volume ?? 70); this.paintRange(volume); this.$("volume-value").textContent = `${volume.value}%`; }
    const feedback = this.error || (busy ? "正在处理…" : s?.supported === false ? "请更新并重启 Harbour 桌面端以启用音乐控制。" : s?.reason);
    this.$("feedback").textContent = feedback || ""; this.$("feedback").hidden = !feedback;
    this.$("feedback").dataset.error = String(!!this.error);
    this.renderQueue(can("play"));
    this.tick();
  }
  renderQueue(canPlay) {
    const s = this.state, tracks = s?.tracks || [], key = JSON.stringify([tracks, s?.currentTrackId]);
    this.$("queue-label").textContent = `${s?.provider === "local" ? "本地曲目" : "播放队列"} · ${tracks.length}`;
    this.$("queue-limit").hidden = !s?.queueLimited;
    if (key !== this.queueKey) {
      this.queueKey = key; this.$("tracks").replaceChildren();
      tracks.forEach((track, index) => {
        const button = document.createElement("button"); button.type = "button"; button.className = "music-track";
        const order = document.createElement("span"), copy = document.createElement("span"), title = document.createElement("strong"), artist = document.createElement("small");
        button.dataset.current = String(track.id === s.currentTrackId); button.setAttribute("aria-current", button.dataset.current);
        button.title = `${track.title}${track.artist ? ` · ${track.artist}` : ""}`; button.dataset.search = button.title.toLocaleLowerCase();
        order.textContent = track.id === s.currentTrackId ? "♪" : String(index + 1).padStart(2, "0");
        title.textContent = track.title; artist.textContent = track.artist; copy.append(title, artist); button.append(order, copy);
        const provider = s.provider; button.onclick = () => this.command("play", { provider, trackId: track.id });
        this.$("tracks").append(button);
      });
      this.filterQueue();
    }
    for (const button of this.$("tracks").children) button.disabled = !canPlay;
  }
  filterQueue() {
    const query = this.$("search").value.trim().toLocaleLowerCase(); let count = 0;
    for (const row of this.$("tracks").children) { row.hidden = !row.dataset.search.includes(query); if (!row.hidden) count++; }
    this.$("queue-empty").hidden = count > 0;
  }
};
