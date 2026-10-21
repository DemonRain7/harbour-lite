const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { JSDOM } = createRequire(path.resolve(__dirname, '../../vendor/folia/package.json'))('jsdom');

// Pure DOM fixtures: no Electron, native windows, audio, accounts or network.
const settle = () => new Promise(resolve => setImmediate(resolve));
const copy = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const dom = new JSDOM('<main><div id="music"></div><div id="chat"></div></main>', { url: 'https://harbour.test', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom, listeners = new Set(), commands = [], intervals = new Set();
  let state = { provider: 'folia', connected: true, running: true, loaded: false, paused: true, tracks: [], playbackMode: 'off', playbackModeAvailable: true };
  let send = async command => { state = { ...state, playbackMode: command.playbackMode }; publish(state); return state; };
  let status = () => Promise.resolve(state);
  function publish(next) { state = next; for (const listener of listeners) listener({ music: next }); }
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.setInterval = callback => { intervals.add(callback); return callback; };
  window.clearInterval = callback => intervals.delete(callback);
  window.Element.prototype.getAnimations = () => [];
  const command = value => { commands.push(copy(value)); return send(value); };
  window.harbourDesktop = {
    coworkDeviceId: 'local', foliaOpen: async () => state, foliaHide: async () => {}, foliaResize() {},
    foliaStatus: () => status(), foliaCommand: command, controlCompanionMusic: command,
    getCompanionState: async () => ({ music: state }),
    onCompanionState: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  for (const file of ['music-context.js', 'music.js', 'chat-tools.js', 'chat-music.js']) window.eval(fs.readFileSync(path.resolve(__dirname, '../../web', file), 'utf8'));
  const api = async () => ({ devices: [{ id: 'local', label: 'Local', music: state }] });
  const disposeMusic = window.HarbourMusicUI.mount(window.document.querySelector('#music'), { api, esc: value => String(value) });
  const disposeChat = window.HarbourChatMusic.mount(window.document.querySelector('#chat'), { api, discuss() {} });
  return {
    window, commands, listeners,
    outer: () => window.document.querySelector('#musicPlaybackMode'),
    chat: () => window.document.querySelector('[data-music-action="set_playback_mode"]'),
    state: () => state, publish, setSend: next => { send = next; }, setStatus: next => { status = next; },
    poll: async () => { for (const callback of intervals) callback(); await settle(); },
    dispose() { disposeMusic(); disposeChat(); dom.window.close(); },
  };
}

test('both shells cycle the same four modes and react to an internal Folia change without polling', async () => {
  const f = fixture();
  try {
    await settle();
    assert.equal(f.outer().dataset.mode, 'off');
    assert.equal(f.chat().dataset.mode, 'off');
    assert.equal(f.outer().disabled, false, 'empty queue can configure its future mode');
    assert.equal(f.chat().disabled, false);
    for (const [button, expected] of [[f.outer, 'all'], [f.chat, 'one'], [f.outer, 'shuffle'], [f.chat, 'off']]) {
      button().click(); await settle();
      assert.deepEqual(f.commands.at(-1), { action: 'set_playback_mode', playbackMode: expected });
      assert.equal(f.outer().dataset.mode, expected);
      assert.equal(f.chat().dataset.mode, expected);
    }
    const before = f.commands.length;
    f.publish({ ...f.state(), playbackMode: 'shuffle' });
    assert.equal(f.outer().textContent, '随机播放');
    assert.match(f.chat().title, /随机播放/);
    assert.equal(f.commands.length, before, 'state sync never writes back to the player');
    assert.ok(f.commands.every(command => command.action === 'set_playback_mode'), 'mode changes do not load or reorder the queue');
  } finally { f.dispose(); }
  assert.equal(f.listeners.size, 0, 'route cleanup removes both state listeners');
});

test('unknown mode, unavailable playback source and disconnected states are not guessed', async () => {
  const f = fixture();
  try {
    await settle();
    for (const change of [{ playbackMode: undefined }, { playbackMode: 'invalid' }, { playbackModeAvailable: false }, { provider: 'qqmusic' }, { connected: false }, { running: false }]) {
      f.publish({ provider: 'folia', connected: true, running: true, loaded: false, tracks: [], playbackMode: 'off', playbackModeAvailable: true, ...change });
      assert.equal(f.outer().disabled, true);
      assert.equal(f.chat().disabled, true);
      f.outer().click(); f.chat().click();
    }
    assert.equal(f.commands.length, 0);
  } finally { f.dispose(); }
});

test('both shells explain missing renderer support separately from source restrictions and disconnection', async () => {
  const f = fixture();
  try {
    await settle();
    for (const [change, reason] of [
      [{ playbackMode: undefined, playbackModeAvailable: undefined }, /关闭音乐模块再重新打开/],
      [{ playbackModeAvailable: false }, /私人 FM/],
      [{ connected: false }, /连接播放设备/],
      [{ running: false }, /打开 Folia/],
      [{ provider: 'qqmusic' }, /外部播放器/],
    ]) {
      f.publish({ provider: 'folia', connected: true, running: true, playbackMode: 'off', playbackModeAvailable: true, tracks: [], ...change });
      for (const button of [f.outer(), f.chat()]) {
        assert.equal(button.disabled, true);
        assert.match(button.title, reason);
        assert.equal(button.getAttribute('aria-label'), button.title);
      }
    }
    assert.equal(f.commands.length, 0, 'explaining an unavailable mode never sends a command');
  } finally { f.dispose(); }
});

test('pending mode changes are guarded, uncertain failures never replay, and latest pushed mode beats a late status read', async () => {
  const f = fixture();
  try {
    await settle();
    let reject;
    f.setSend(() => new Promise((_yes, no) => { reject = no; }));
    f.outer().click(); f.outer().click();
    assert.equal(f.commands.length, 1);
    assert.equal(f.outer().getAttribute('aria-busy'), 'true');
    assert.equal(f.outer().dataset.mode, 'off', 'no optimistic mode mutation');
    reject(new Error('结果未知')); await settle();
    assert.match(f.window.document.querySelector('#musicNotice').textContent, /结果未知/);
    await f.poll();
    assert.equal(f.commands.length, 1, 'polling does not retry a failed write');
    let resolveStatus;
    f.setStatus(() => new Promise(resolve => { resolveStatus = resolve; }));
    await f.poll();
    f.publish({ ...f.state(), playbackMode: 'shuffle' });
    resolveStatus({ ...f.state(), playbackMode: 'off' }); await settle();
    assert.equal(f.outer().dataset.mode, 'shuffle');
    assert.equal(f.chat().dataset.mode, 'shuffle');
  } finally { f.dispose(); }
});

test('a newer internal mode is not overwritten by a delayed command acknowledgement', async () => {
  const f = fixture();
  try {
    await settle();
    let resolve;
    f.setSend(() => new Promise(yes => { resolve = yes; }));
    f.outer().click();
    f.publish({ ...f.state(), playbackMode: 'shuffle' });
    resolve({ ...f.state(), playbackMode: 'all' }); await settle();
    assert.equal(f.outer().dataset.mode, 'shuffle');
    assert.equal(f.chat().dataset.mode, 'shuffle');
    assert.equal(f.commands.length, 1);
  } finally { f.dispose(); }
});
