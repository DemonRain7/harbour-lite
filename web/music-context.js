/* Shared metadata/control availability: no audio, queue copying, polling or model calls. */
(function (root, factory) {
  const value = factory();
  if (typeof module === 'object' && module.exports) module.exports = value;
  else root.HarbourMusicContext = value;
})(typeof window === 'undefined' ? globalThis : window, () => {
  const deviceRequests = new WeakMap();
  // A window can predate the desktop bridge. Resolve its identity over trusted
  // IPC, never by guessing which online device is this computer.
  function resolveLocalDeviceId(desktop) {
    if (!desktop) return Promise.resolve('');
    if (desktop.coworkDeviceId) return Promise.resolve(desktop.coworkDeviceId);
    if (deviceRequests.has(desktop)) return deviceRequests.get(desktop);
    const read = desktop.getCoworkDeviceInfo || desktop.getCoworkDevice;
    if (typeof read !== 'function') return Promise.resolve('');
    let timer;
    const request = Promise.race([
      Promise.resolve().then(() => read.call(desktop)),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500); }),
    ]).then(info => {
      const id = info?.id || info?.deviceId;
      return typeof id === 'string' && /^[a-z0-9_-]{1,128}$/i.test(id) ? id : '';
    }).catch(() => '').then(id => {
      clearTimeout(timer);
      if (!id) deviceRequests.delete(desktop); // A not-yet-ready bridge is retryable.
      return id;
    });
    deviceRequests.set(desktop, request);
    return request;
  }
  function current(music) {
    if (music?.provider !== 'folia' || music.connected === false || music.running === false || music.loaded !== true) return null;
    const track = Array.isArray(music.tracks) ? music.tracks.find(row => row?.id === music.currentTrackId) : null;
    if (!track?.title) return null; // A queued song is not necessarily playing.
    return { id: track.id, title: String(track.title).slice(0, 240), artist: String(track.artist || '').slice(0, 160),
      paused: music.paused !== false, positionMs: Math.max(0, Number(music.positionMs) || 0) };
  }
  // Explicit resume may start the existing Folia owner in the background and
  // restore its persisted queue. It never selects another provider or song.
  function canResume(music) {
    return music?.provider === 'folia' && music.connected !== false
      && music.available !== false && music.providerAvailable !== false
      && !['failed', 'unresponsive'].includes(music.renderer?.phase);
  }
  function discussion(track, deviceId) {
    if (!track) return '';
    return '我想聊聊这首歌，你可以先介绍它，再推荐几首类似的。先不要切歌。\n'
      + '我选中的曲目（点击时的播放器元数据，不是音频或歌词）：'
      + JSON.stringify({ title: track.title, artist: track.artist, trackId: track.id, deviceId,
        positionSeconds: Math.floor(track.positionMs / 1000), paused: track.paused });
  }
  return { current, canResume, discussion, resolveLocalDeviceId };
});
