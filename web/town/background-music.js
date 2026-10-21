// One local music player per map, independent of day/night. The original
// soundscape still owns wind, footsteps, birds and positional effects.
export const TOWN_MUSIC = Object.freeze({
  title: '不散的夏之灯',
  artist: '鸣潮先约电台 / Minase / chelly',
  url: '/town/audio/local/lingering-summer-light.m4a',
});

export function withTownMusic(ambience, { track = TOWN_MUSIC, suppressCafeMusic = false } = {}) {
  const audio = Object.create(ambience), life = new AbortController();
  let element, source, gain, blobUrl, loading, context;
  let active = false, disposed = false, pending = false, blocked = false, error = '';
  const wanted = () => !disposed && active && !ambience.muted && context?.state === 'running';
  function sync() {
    if (!element || !source) return;
    const playing = wanted();
    gain.gain.setTargetAtTime(playing ? .38 : 0, context.currentTime, .15);
    if (!playing) { element.pause(); return; }
    if (!element.paused || pending || blocked) return;
    pending = true;
    element.play().catch(reason => {
      if (disposed || reason.name === 'AbortError') return;
      blocked = true; error = '背景音乐未能播放，请关闭声音后再开启。';
    }).finally(() => {
      pending = false;
      // A hidden-page/mute request can arrive while play() is still pending.
      if (!wanted()) element?.pause();
      else if (!blocked) sync();
    });
  }
  async function load() {
    if (source) return;
    if (new URL(track.url, location.href).origin !== location.origin) throw new Error('小镇音乐只从当前 Harbour 加载本机资源。');
    let token = '';
    try { token = localStorage.getItem('harbour-token') || ''; } catch {}
    const signal = AbortSignal.any([life.signal, AbortSignal.timeout(20000)]);
    const response = await fetch(track.url, { signal, headers: token ? { 'x-harbour-token': token } : {} });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
      ? '请先登录 Harbour，再开启小镇音乐。' : `背景音乐文件不可用（${response.status}），请检查本机音乐资源。`);
    if (Number(response.headers.get('content-length')) > 20 * 1024 * 1024) throw new Error('小镇音乐文件过大。');
    const blob = await response.blob(); signal.throwIfAborted();
    if (!blob.size || blob.size > 20 * 1024 * 1024) throw new Error('小镇音乐文件大小无效。');
    element = new Audio(); element.loop = true; element.preload = 'auto';
    blobUrl = URL.createObjectURL(blob);
    try {
      await new Promise((resolve, reject) => {
        const done = failure => {
          element.removeEventListener('loadedmetadata', ready); element.removeEventListener('error', failed);
          signal.removeEventListener('abort', aborted);
          failure ? reject(failure) : resolve();
        };
        const ready = () => done(), failed = () => done(new Error('小镇音乐文件无法解码。'));
        const aborted = () => done(signal.reason);
        element.addEventListener('loadedmetadata', ready); element.addEventListener('error', failed);
        signal.addEventListener('abort', aborted, { once: true });
        element.src = blobUrl;
      });
      signal.throwIfAborted();
      source = context.createMediaElementSource(element);
      gain = context.createGain(); gain.gain.value = 0;
      source.connect(gain).connect(context.destination);
      element.addEventListener('error', () => { blocked = true; error = '背景音乐播放失败，请检查本机音乐文件。'; element.pause(); }, { signal: life.signal });
    } catch (reason) {
      element.pause(); element.removeAttribute('src'); element.load();
      URL.revokeObjectURL(blobUrl); blobUrl = null;
      throw reason;
    }
  }
  audio.start = async () => {
    life.signal.throwIfAborted();
    await ambience.start();
    if (!ambience.context) throw new Error('浏览器暂未允许声音，请再点击一次。');
    if (!context) {
      context = ambience.context;
      context.addEventListener('statechange', sync, { signal: life.signal });
    }
    blocked = false; error = '';
    loading ||= load().finally(() => { loading = null; });
    try { await loading; }
    catch (reason) {
      error = reason.message;
      if (ambience.muted && context.state === 'running') await context.suspend();
      throw reason;
    }
    sync();
  };
  Object.defineProperty(audio, 'muted', {
    get: () => ambience.muted,
    set(value) { ambience.muted = value; sync(); },
  });
  audio.pauseMedia = () => { active = false; ambience.pauseMedia?.(); sync(); };
  audio.resumeMedia = () => { active = true; ambience.resumeMedia?.(); sync(); };
  audio.mediaStatus = () => ({ playing: element && !element.paused ? 1 : 0, music: track.title,
    musicTime: element?.currentTime || 0, musicDuration: Number.isFinite(element?.duration) ? element.duration : 0,
    musicError: error });
  audio.disposeMedia = () => {
    if (disposed) return;
    disposed = true; active = false; life.abort();
    element?.pause(); source?.disconnect(); gain?.disconnect();
    if (element) { element.removeAttribute('src'); element.load(); }
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    ambience.disposeMedia?.();
  };
  if (suppressCafeMusic) {
    // Do not layer the station's synthesized music box underneath the song.
    // Its other positional sounds and the imported source remain untouched.
    audio.loop = (name, options) => name === 'cafeMusic' ? undefined : ambience.loop(name, options);
  }
  return audio;
}
