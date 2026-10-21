const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { JSDOM } = createRequire(path.resolve(__dirname, '../../vendor/folia/package.json'))('jsdom');
const { resolveLocalDeviceId } = require('../../web/music-context');

// Reproduce a Dashboard created before the desktop bridge: its immutable
// preload ID is empty, while the authenticated backend already sees this PC.
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture({ selected = 'local', identity = async () => ({ deviceId: 'local' }) } = {}) {
  const dom = new JSDOM('<main><div id="music"></div><div id="chat"></div></main>', {
    url: 'https://harbour.test', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, calls = [], polls = [], state = {
    provider: 'folia', mode: 'background', running: true, connected: true, loaded: true, paused: true,
    currentTrackId: 'song', tracks: [{ id: 'song', title: 'Fixture' }], playbackMode: 'off', playbackModeAvailable: true,
  };
  let identityCalls = 0;
  if (selected) w.localStorage.setItem('harbour-music-device', selected);
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.Element.prototype.getAnimations = () => [];
  w.setInterval = fn => { polls.push(fn); return fn; };
  w.clearInterval = () => {};
  w.harbourDesktop = {
    coworkDeviceId: null,
    getCoworkDeviceInfo: () => { identityCalls++; return identity(); },
    foliaOpen: async mode => { calls.push(['open', mode]); state.mode = mode; return state; },
    foliaStatus: async () => state, foliaResize() {}, foliaHide: async () => {},
    foliaCommand: async cmd => { calls.push(['local', cmd]); return state; },
    controlCompanionMusic: async cmd => { calls.push(['local', cmd]); return state; },
    getCompanionState: async () => ({ music: state }), onCompanionState: () => () => {},
  };
  for (const file of ['music-context.js', 'music.js', 'chat-tools.js', 'chat-music.js']) w.eval(fs.readFileSync(path.resolve(__dirname, '../../web', file), 'utf8'));
  const api = async (url, options) => {
    if (url === '/api/music/control') { calls.push(['remote', JSON.parse(options.body)]); return { result: state }; }
    return { devices: [{ id: 'local', label: 'This PC', music: state }, ...(selected === 'remote' ? [{ id: 'remote', label: 'Other PC', music: state }] : [])] };
  };
  const disposeMusic = w.HarbourMusicUI.mount(w.document.querySelector('#music'), { api, esc: value => String(value) });
  const disposeChat = w.HarbourChatMusic.mount(w.document.querySelector('#chat'), { api, discuss() {} });
  return { w, calls, identityCalls: () => identityCalls,
    open: () => w.document.querySelector('[data-music="embedded"]').click(),
    poll: async () => { polls.forEach(fn => fn()); await settle(); },
    close() { disposeMusic(); disposeChat(); dom.window.close(); },
  };
}

test('empty preload ID resolves over trusted IPC and restores local open/control in both surfaces', async () => {
  const f = fixture();
  try {
    await settle();
    assert.equal(f.identityCalls(), 1, 'two surfaces share the pending/successful identity lookup');
    assert.match(f.w.document.querySelector('#musicDevice option:checked').textContent, /本机/);
    f.open(); await settle();
    assert.deepEqual(f.calls[0], ['open', 'embedded']);
    assert.equal(f.w.document.querySelector('.music-welcome').hidden, true);
    f.w.document.querySelector('[data-music-action="toggle"]').click(); await settle();
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1))), ['local', { action: 'resume' }]);
    assert.equal(f.w.localStorage.getItem('harbour-music-device'), 'local');
  } finally { f.close(); }
});

test('a first visit with one device must not turn this computer into a remote player', async () => {
  const f = fixture({ selected: '' });
  try { await settle(); f.open(); await settle(); assert.deepEqual(f.calls, [['open', 'embedded']]); }
  finally { f.close(); }
});

test('explicit remote selection stays remote and is never silently redirected locally', async () => {
  const f = fixture({ selected: 'remote' });
  try {
    await settle(); f.open(); await settle();
    assert.deepEqual(f.calls, []);
    assert.match(f.w.document.querySelector('#musicNotice').textContent, /请选择本机/);
    f.w.document.querySelector('[data-music-action="toggle"]').click(); await settle();
    assert.equal(f.calls[0][0], 'remote');
    assert.equal(f.calls[0][1].deviceId, 'remote');
    assert.equal(f.w.localStorage.getItem('harbour-music-device'), 'remote');
  } finally { f.close(); }
});

test('click during identity lookup is deduplicated and leaving the page cancels the pending open', async () => {
  let resolve;
  const f = fixture({ identity: () => new Promise(done => { resolve = done; }) });
  await settle(); f.open(); f.open();
  f.close(); resolve({ id: 'local' }); await settle();
  assert.deepEqual(f.calls, [], 'no native window opens after navigation');
});

test('missing/failed identity is retryable; no online-device list is used as identity proof', async () => {
  let ready = false;
  const f = fixture({ identity: async () => ready ? { id: 'local' } : null });
  try {
    await settle(); f.open(); await settle();
    assert.deepEqual(f.calls, []);
    assert.match(f.w.document.querySelector('#musicNotice').textContent, /识别本机/);
    ready = true; await f.poll(); f.open(); await settle();
    assert.deepEqual(f.calls, [['open', 'embedded']]);
  } finally { f.close(); }
});

test('resolver uses immutable valid IDs without IPC and retries failed IPC', async () => {
  assert.equal(await resolveLocalDeviceId({ coworkDeviceId: 'known', getCoworkDeviceInfo() { assert.fail('unnecessary IPC'); } }), 'known');
  let count = 0;
  const desktop = { getCoworkDevice: async () => { if (!count++) throw new Error('not ready'); return { deviceId: 'recovered' }; } };
  assert.equal(await resolveLocalDeviceId(desktop), '');
  assert.equal(await resolveLocalDeviceId(desktop), 'recovered');
});
