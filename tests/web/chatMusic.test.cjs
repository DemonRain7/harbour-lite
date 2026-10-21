const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { JSDOM } = createRequire(path.resolve(__dirname, '../../vendor/folia/package.json'))('jsdom');

// DOM-only: no browser, audio, live API or model calls.
const preference = 'harbour-chat-music-collapsed';
const settle = () => new Promise(resolve => setImmediate(resolve));
const song = title => ({ provider: 'folia', connected: true, running: true, loaded: true, paused: false,
  currentTrackId: title, tracks: [{ id: title, title, artist: '测试歌手' }], playbackMode: 'off', playbackModeAvailable: true });
function fixture({ saved, local = false, storageBlocked = false, music = null } = {}) {
  const dom = new JSDOM('<main><div id="chatMusic"></div></main>', {
    url: 'https://harbour.test', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, listeners = new Set(), intervals = new Set(), writes = [], discussions = [];
  if (saved !== undefined) w.localStorage.setItem(preference, saved);
  if (storageBlocked) Object.defineProperty(w, 'localStorage', { get() { throw new Error('Storage unavailable'); } });
  w.setInterval = callback => { intervals.add(callback); return callback; };
  w.clearInterval = callback => intervals.delete(callback);
  if (local) w.harbourDesktop = {
    coworkDeviceId: 'local', getCompanionState: async () => ({ music }),
    onCompanionState: callback => { listeners.add(callback); return () => listeners.delete(callback); },
    controlCompanionMusic: async command => { writes.push(command); },
  };
  for (const file of ['music-context.js', 'music.js', 'chat-tools.js', 'chat-music.js']) {
    w.eval(fs.readFileSync(path.resolve(__dirname, '../../web', file), 'utf8'));
  }
  const root = w.document.querySelector('#chatMusic');
  const options = {
    api: async (url, options) => {
      if (options?.method) { writes.push({ url, ...JSON.parse(options.body) }); return {}; }
      return { devices: music ? [{ id: 'remote', label: '远端播放器', music }] : [] };
    },
    discuss: text => { discussions.push(text); return true; },
  };
  let dispose = w.HarbourChatMusic.mount(root, options);
  return { w, root, writes, discussions, listeners, intervals,
    button: () => root.querySelector('.chat-music-collapse'),
    content: () => root.querySelector('.chat-music-content'),
    publish(next) { music = next; for (const callback of listeners) callback({ music }); },
    async poll() { for (const callback of intervals) callback(); await settle(); },
    storage(value) {
      if (value === null) w.localStorage.removeItem(preference); else w.localStorage.setItem(preference, value);
      w.dispatchEvent(new w.StorageEvent('storage', { key: preference, newValue: value, storageArea: w.localStorage }));
    },
    remount() { dispose(); dispose = w.HarbourChatMusic.mount(root, options); },
    unmount() { dispose(); },
    close() { dispose(); dom.window.close(); },
  };
}

test('music starts as a compact icon; opening is transient and never starts a player', async () => {
  const f = fixture({ saved: '0' });
  try {
    await settle();
    assert.equal(f.button().getAttribute('aria-expanded'), 'false');
    assert.equal(f.w.document.getElementById(f.button().getAttribute('aria-controls')), f.content());
    assert.equal(f.content().hidden, true);
    assert.equal(f.root.querySelector('[data-music-action="toggle"]').disabled, true);
    f.button().focus(); f.button().click();
    assert.equal(f.content().hidden, false);
    assert.equal(f.button().getAttribute('aria-expanded'), 'true');
    f.button().click();
    assert.equal(f.content().hidden, true);
    assert.match(f.button().getAttribute('aria-label'), /音乐陪伴/);
    assert.equal(f.w.document.activeElement, f.button());
    assert.equal(f.w.localStorage.getItem(preference), '0', 'obsolete preference is left untouched');
    f.remount();
    assert.equal(f.content().hidden, true, 'closed synchronously, before any status request settles');
    f.button().click();
    assert.equal(f.content().hidden, false);
    f.remount();
    assert.equal(f.content().hidden, true);
    assert.equal(f.intervals.size, 1, 'remount does not leak polling timers');
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.discussions, []);
  } finally { f.close(); }
});

for (const local of [true, false]) test(`cold ${local ? 'desktop' : 'remote'} Folia resumes only after an explicit play click`, async () => {
  const f = fixture({ local, music: { provider: 'folia', connected: true, available: true, running: false, loaded: false, paused: true, tracks: [] } });
  try {
    await settle();
    assert.deepEqual(f.writes, []);
    f.button().click();
    assert.deepEqual(f.writes, [], 'opening controls must not start Folia');
    const toggle = f.root.querySelector('[data-music-action="toggle"]');
    assert.equal(toggle.disabled, false, 'resume can restore the previous session without opening Folia');
    assert.match(f.root.querySelector('.chat-music-meta').textContent, /点击播放/);
    assert.equal(f.root.querySelector('[data-music-action="next"]').disabled, true);
    toggle.click(); await settle();
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].action, 'resume');
    if (!local) assert.equal(f.writes[0].deviceId, 'remote');
    assert.equal(f.root.dataset.playing, 'false', 'receipt alone must not invent playback');
    f.publish({ provider: 'folia', connected: false }); await f.poll();
    assert.equal(toggle.disabled, true);
  } finally { f.close(); }
});

for (const local of [true, false]) test(`collapsed ${local ? 'desktop' : 'remote'} music keeps state current without controlling playback`, async () => {
  const f = fixture({ saved: '1', local, music: song('曲目一') });
  try {
    await settle();
    assert.equal(f.content().hidden, true);
    assert.equal(f.root.dataset.playing, 'true');
    f.publish(song('曲目二')); await f.poll();
    assert.equal(f.content().hidden, true, 'new songs must not force the strip open');
    assert.equal(f.root.querySelector('.chat-music-title').textContent, '曲目二');
    f.button().click();
    assert.equal(f.content().hidden, false);
    assert.equal(f.root.querySelector('.chat-music-link').getAttribute('href'), '#music');
    assert.deepEqual(f.writes, [], 'hide/show must not pause, close or reconnect the player');
    f.root.querySelector('.chat-music-discuss').click();
    assert.equal(f.discussions.length, 1);
    assert.match(f.discussions[0], /曲目二/);
    f.root.querySelector('[data-music-action="toggle"]').click(); await settle();
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].action, 'pause', 'existing transport still sends one deliberate command');
  } finally { f.close(); }
});

test('Escape restores focus, old window preferences do not open panels, cleanup stops listeners', async () => {
  const f = fixture({ local: true, music: song('曲目') });
  try {
    await settle();
    f.button().click();
    f.root.querySelector('.chat-music-link').focus();
    f.storage('1');
    assert.equal(f.content().hidden, false, 'another window cannot collapse this popup');
    f.w.document.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(f.content().hidden, true);
    assert.equal(f.w.document.activeElement, f.button());
    f.storage('0');
    assert.equal(f.content().hidden, true);
    f.storage('1'); f.storage(null);
    assert.equal(f.content().hidden, true);
    f.button().click();
    f.unmount();
    f.storage('1');
    f.button().click();
    assert.equal(f.content().hidden, true, 'disposed views close and cannot reopen');
    assert.equal(f.listeners.size, 0);
    assert.equal(f.intervals.size, 0);
    assert.deepEqual(f.writes, []);
  } finally { f.close(); }
});

test('blocked localStorage does not prevent opening or dismissing music controls', async () => {
  const f = fixture({ storageBlocked: true });
  try {
    await settle();
    f.button().click(); assert.equal(f.content().hidden, false);
    f.button().click(); assert.equal(f.content().hidden, true);
    assert.deepEqual(f.writes, []);
  } finally { f.close(); }
});
