/* Local Folia metadata and narrow transport only. The pet owns no player/timer. */
window.HarbourPetMusic = (() => {
  function mount({ desktop, changed }) {
    const root = document.getElementById('petMusicBar'), toggle = document.getElementById('petMusic');
    const title = root.querySelector('.pet-music-title'), subtitle = root.querySelector('.pet-music-subtitle');
    const play = root.querySelector('[data-pet-music="toggle"]');
    let music = null, suppressed = false, collapsed = false, pending = false, error = '', alive = true, renderKey = '';
    const events = new AbortController(), key = `harbour-pet-music-collapsed:${desktop?.petContext?.id || 'pet'}`;
    try { collapsed = localStorage.getItem(key) === '1'; } catch { /* optional UI preference */ }
    function render() {
      const track = window.HarbourMusicContext.current(music);
      const key = JSON.stringify([track?.id, track?.title, track?.artist, track?.paused, suppressed, collapsed, pending, error]);
      if (key === renderKey) return; renderKey = key;
      const visible = !!track && !suppressed && !collapsed;
      root.hidden = !visible;
      toggle.hidden = !desktop?.controlCompanionMusic;
      toggle.setAttribute('aria-pressed', String(!collapsed && !!track));
      toggle.title = track ? collapsed ? '显示音乐条' : '收起音乐条' : '打开 Folia 音乐';
      title.textContent = track?.title || '';
      title.parentElement.title = track ? `${track.title} · ${track.artist}\n打开 Folia` : '打开 Folia';
      subtitle.textContent = error || (track ? [track.paused ? '已暂停' : '一起听', track.artist].filter(Boolean).join(' · ') : '');
      subtitle.title = subtitle.textContent;
      play.textContent = track?.paused ? '▶' : 'Ⅱ';
      play.title = track?.paused ? '继续播放' : '暂停'; play.setAttribute('aria-label', play.title);
      root.querySelectorAll('[data-pet-music]').forEach(button => { button.disabled = pending || !track; });
      root.setAttribute('aria-busy', String(pending));
      changed();
    }
    function collapse(value) {
      collapsed = value;
      try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* no persistence available */ }
      render();
    }
    async function open() {
      try { await desktop?.openCompanionWindow?.('music'); }
      catch (failure) { error = failure.message || '无法打开音乐'; if (alive) render(); }
    }
    toggle.addEventListener('click', () => {
      if (window.HarbourMusicContext.current(music)) collapse(!collapsed); else void open();
    }, { signal: events.signal });
    root.querySelector('.pet-music-open').addEventListener('click', open, { signal: events.signal });
    root.querySelector('.pet-music-hide').addEventListener('click', () => collapse(true), { signal: events.signal });
    root.addEventListener('click', async event => {
      const button = event.target.closest('[data-pet-music]'), track = window.HarbourMusicContext.current(music);
      if (!button || pending || !track) return;
      const action = button.dataset.petMusic === 'toggle' ? track.paused ? 'resume' : 'pause' : button.dataset.petMusic;
      pending = true; error = ''; render();
      try { await desktop.controlCompanionMusic({ action }); }
      catch (failure) { error = failure.message || '播放状态未知，请打开 Folia 检查'; }
      finally { pending = false; if (alive) render(); }
    }, { signal: events.signal });
    return { update(value, hide) { music = value; suppressed = hide; render(); }, dispose() { alive = false; events.abort(); } };
  }
  return { mount };
})();
