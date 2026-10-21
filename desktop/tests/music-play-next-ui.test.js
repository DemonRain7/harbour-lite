const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { JSDOM } = createRequire(path.resolve(__dirname, '../../vendor/folia/package.json'))('jsdom');

// desktop/tests/music-play-next-ui.test.js — isolated DOM, no Electron/audio/network.
const settle = () => new Promise(resolve => setImmediate(resolve));
const copy = value => JSON.parse(JSON.stringify(value));
const song = id => ({ id, title: `Song ${id}`, artist: 'Fixture' });
function fixture() {
  const dom = new JSDOM('<main id="music"></main>', { url: 'https://harbour.test', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom, commands = [], listeners = new Set();
  let state = { provider: 'folia', connected: true, running: true, loaded: true, paused: false, currentTrackId: 'A',
    tracks: [song('A'), song('C'), song('B')], playbackMode: 'off', playbackModeAvailable: true, playNextAvailable: true };
  const remoteState = { ...state, currentTrackId: 'X', tracks: [song('X'), song('Y')] };
  let next = async command => ({ ...state, accepted: true, tracks: [song('A'), song(command.trackId), song('C')] });
  const execute = async (command, device = 'local') => {
    commands.push({ device, ...copy(command) });
    if (command.action === 'play_next') return next(command);
    if (command.action === 'queue') return device === 'local' ? state : remoteState;
    if (command.action === 'search') return { tracks: [song('D')] };
    return { accepted: true, ...state };
  };
  window.ResizeObserver = class { observe() {} disconnect() {} };
  window.setInterval = () => 0;
  window.clearInterval = () => {};
  window.Element.prototype.getAnimations = () => [];
  window.harbourDesktop = {
    coworkDeviceId: 'local', foliaOpen: async () => state, foliaHide: async () => {}, foliaResize() {},
    foliaStatus: async () => state, foliaCommand: command => execute(command),
    onCompanionState: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  for (const file of ['music-context.js', 'music.js']) window.eval(fs.readFileSync(path.resolve(__dirname, '../../web', file), 'utf8'));
  const api = async (url, options) => url.startsWith('/api/music/devices')
    ? { devices: [{ id: 'local', label: 'Local', music: state }, { id: 'remote', label: 'Remote', music: remoteState }] }
    : { result: await execute(JSON.parse(options.body), JSON.parse(options.body).deviceId) };
  const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const dispose = window.HarbourMusicUI.mount(window.document.querySelector('#music'), { api, esc });
  const $ = selector => window.document.querySelector(selector);
  return {
    window, commands, $, state: () => state,
    button: id => $(`[data-play-next="${id}"]`),
    notice: () => $('#musicNotice').textContent,
    ids: () => [...window.document.querySelectorAll('[data-track]')].map(button => button.dataset.track),
    setNext: handler => { next = handler; },
    publish: patch => { state = { ...state, ...patch }; listeners.forEach(listener => listener({ music: state })); },
    async queue() { $('#musicQueue').click(); await settle(); },
    async search() { $('#musicQuery').value = 'fixture'; $('#musicSearch').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle(); },
    async select(id) { $('#musicDevice').value = id; $('#musicDevice').dispatchEvent(new window.Event('change')); await settle(); },
    dispose() { dispose(); dom.window.close(); },
  };
}

test('queue rows expose distinct accessible play-now and play-next actions; receipt updates the queue without playing', async () => {
  const f = fixture();
  try {
    await settle(); await f.queue();
    assert.equal(f.button('A').disabled, true, 'current song cannot insert itself');
    assert.equal(f.button('B').getAttribute('aria-label'), '下一首播放 Song B');
    assert.match(f.button('B').title, /下一首播放/);
    assert.equal(f.button('B').closest('[data-track]'), null, 'actions are sibling buttons');
    f.commands.length = 0;
    f.button('B').click(); await settle();
    assert.deepEqual(f.commands, [{ device: 'local', action: 'play_next', trackId: 'B' }]);
    assert.deepEqual(f.ids(), ['A', 'B', 'C']);
    assert.equal(f.state().currentTrackId, 'A');
    assert.match(f.notice(), /已设为下一首播放/);
    f.$('[data-track="B"]').click(); await settle();
    assert.equal(f.commands.at(-1).action, 'play', 'the existing explicit play action is unchanged');
  } finally { f.dispose(); }
});

test('search results can play next and explain a confirmed repeat-one transition', async () => {
  const f = fixture();
  try {
    await settle(); f.publish({ playbackMode: 'one' }); await f.search();
    assert.deepEqual(f.ids(), ['D']);
    f.setNext(async () => ({ ...f.state(), accepted: true, playbackMode: 'all', tracks: [song('A'), song('D'), song('C')] }));
    f.commands.length = 0;
    f.button('D').click(); await settle();
    assert.deepEqual(f.commands, [{ device: 'local', action: 'play_next', trackId: 'D' }]);
    assert.deepEqual(f.ids(), ['A', 'D', 'C']);
    assert.match(f.$('#musicResultsLabel').textContent, /^播放队列/);
    assert.match(f.notice(), /单曲循环已切换为列表循环/);
  } finally { f.dispose(); }
});

test('unknown, unavailable and disconnected capabilities fail closed without sending a command', async () => {
  const f = fixture();
  try {
    await settle(); await f.queue(); f.commands.length = 0;
    for (const patch of [{ playNextAvailable: undefined }, { playNextAvailable: false }, { playNextAvailable: true, connected: false }, { connected: true, provider: 'qqmusic' }]) {
      f.publish(patch);
      assert.equal(f.button('B').disabled, true);
      f.button('B').click();
    }
    assert.deepEqual(f.commands, []);
  } finally { f.dispose(); }
});

test('pending insertion is single-flight and failures never optimistically reorder or replay', async () => {
  const f = fixture();
  try {
    await settle(); await f.queue();
    let reject;
    f.setNext(() => new Promise((_, failed) => { reject = failed; }));
    f.commands.length = 0;
    f.button('B').click(); f.button('B').click(); f.button('C').click();
    assert.equal(f.button('B').getAttribute('aria-busy'), 'true');
    assert.equal(f.commands.length, 1);
    assert.deepEqual(f.ids(), ['A', 'C', 'B']);
    reject(new Error('回执超时，结果未知')); await settle();
    assert.deepEqual(f.ids(), ['A', 'C', 'B']);
    assert.match(f.notice(), /结果未知/);
    assert.equal(f.commands.length, 1);
    assert.equal(f.button('B').disabled, false);
    f.setNext(async () => ({ accepted: true }));
    f.button('B').click(); await settle();
    assert.match(f.notice(), /未确认/);
    assert.deepEqual(f.ids(), ['A', 'C', 'B']);
  } finally { f.dispose(); }
});

test('a newer search keeps its results when an older insertion receipt arrives', async () => {
  const f = fixture();
  try {
    await settle(); await f.queue();
    let resolve;
    f.setNext(() => new Promise(done => { resolve = done; }));
    f.button('B').click(); await f.search();
    resolve({ ...f.state(), accepted: true, tracks: [song('A'), song('B'), song('C')] }); await settle();
    assert.deepEqual(f.ids(), ['D']);
    assert.match(f.$('#musicResultsLabel').textContent, /^搜索结果/);
  } finally { f.dispose(); }
});

test('late old-device receipt cannot affect the newly selected device, notice or queue', async () => {
  const f = fixture();
  try {
    await settle(); await f.queue();
    let resolve;
    f.setNext(() => new Promise(done => { resolve = done; }));
    f.button('B').click(); await f.select('remote'); await f.queue();
    const notice = f.notice();
    resolve({ ...f.state(), accepted: true, tracks: [song('A'), song('B'), song('C')] }); await settle();
    assert.deepEqual(f.ids(), ['X', 'Y']);
    assert.equal(f.notice(), notice);
    assert.equal(f.button('Y').disabled, false);
    f.setNext(async () => ({ ...f.state(), accepted: true, currentTrackId: 'X', tracks: [song('X'), song('Y')] }));
    f.button('Y').click(); await settle();
    assert.deepEqual(f.commands.at(-1), { device: 'remote', action: 'play_next', trackId: 'Y', player: 'folia', deviceId: 'remote' });
  } finally { f.dispose(); }
});
