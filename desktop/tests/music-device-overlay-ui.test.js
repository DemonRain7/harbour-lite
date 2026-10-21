const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { JSDOM } = createRequire(path.resolve(__dirname, '../../vendor/folia/package.json'))('jsdom');
const web = name => fs.readFileSync(path.resolve(__dirname, '../../web', name), 'utf8');
const settle = () => new Promise(resolve => setTimeout(resolve, 35));

function fixture(music = false) {
  const dom = new JSDOM('<div id="content"><select id="simple"><option value="a">A</option><option value="b">B</option></select></div>', {
    url: 'https://harbour.test', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, calls = [], intervals = [];
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.Element.prototype.getAnimations = () => [];
  w.Element.prototype.getBoundingClientRect = function () {
    return { x: 100, y: this.id === 'musicStage' ? 200 : 100, left: 100, top: 100, right: 900, bottom: 150, width: 800, height: 50 };
  };
  w.setInterval = cb => { intervals.push(cb); return 1; };
  w.clearInterval = () => {};
  const source = web('app.js');
  // JSDOM's select Proxy silently ignores writes after an instance value setter
  // is installed. Exercise that real-browser bridge separately in Chromium;
  // keep native JSDOM value semantics for these lifecycle/race fixtures.
  w.eval(source.slice(source.indexOf('/* ── Harbour Select'), source.indexOf('function authToken()'))
    .replace('Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")', 'null'));
  const requests = [];
  const adapter = {
    open: anchor => new Promise((resolve, reject) => requests.push({ anchor, resolve, reject })),
    close: () => calls.push('close'), onError: () => calls.push('error'),
  };
  let dispose = () => {};
  if (music) {
    const state = { provider: 'folia', mode: 'embedded', connected: true, running: true, tracks: [], paused: false };
    w.harbourDesktop = {
      coworkDeviceId: 'local', foliaOpen: async () => state, foliaStatus: async () => state,
      foliaResize: (...args) => calls.push(['resize', ...args]), foliaHide: async () => calls.push('hide'),
      foliaDeviceMenu: req => adapter.open(req), foliaCloseDeviceMenu: adapter.close,
      foliaCommand: async req => calls.push(['command', req]),
    };
    w.eval(web('music.js'));
    dispose = w.HarbourMusicUI.mount(w.document.querySelector('#content'), {
      api: async () => ({ devices: [{ id: 'local', label: 'Desktop device', online: true, music: state }] }), esc: String,
    });
  } else w.document.querySelector('#simple').harbourMenu = () => adapter;
  w.initHarbourSelects();
  const select = w.document.querySelector(music ? '#musicDevice' : '#simple');
  const trigger = () => select.closest('.harbour-select').querySelector('.hs-trigger');
  return { w, calls, requests, select, trigger, intervals,
    close: () => { dispose(); dom.window.close(); } };
}

test('native select returns identity through original change handler; same device is a no-op', async () => {
  const f = fixture();
  try {
    let changes = 0; f.select.addEventListener('change', () => changes++);
    f.trigger().click(); await settle();
    assert.equal(f.trigger().getAttribute('aria-expanded'), 'true');
    assert.equal(f.select.closest('.harbour-select').querySelector('.hs-menu').style.display, 'none');
    f.requests[0].resolve({ value: 'a' }); await settle();
    assert.equal(changes, 0);
    f.trigger().click(); await settle();
    f.requests[1].resolve({ value: 'b' }); await settle();
    assert.equal(f.select.value, 'b'); assert.equal(changes, 1);
    assert.equal(f.trigger().getAttribute('aria-expanded'), 'false');
    assert.equal(f.w.document.activeElement, f.trigger());
  } finally { f.close(); }
});

test('late reply cannot affect a closed or newly reopened select', async () => {
  const f = fixture();
  try {
    f.trigger().click(); await settle();
    f.trigger().click(); f.trigger().click(); await settle();
    f.requests[0].resolve({ value: 'b' }); await settle();
    assert.equal(f.select.value, 'a');
    assert.equal(f.trigger().getAttribute('aria-expanded'), 'true');
    f.requests[1].resolve({ dismiss: 'escape' }); await settle();
    assert.equal(f.trigger().getAttribute('aria-expanded'), 'false');
  } finally { f.close(); }
});

test('unchanged polling preserves menu; changed/disabled options cancel stale native selection', async () => {
  const f = fixture();
  try {
    f.trigger().click(); await settle();
    f.select.value = 'a'; await settle();
    assert.equal(f.trigger().getAttribute('aria-expanded'), 'true');
    f.select.options[1].disabled = true; await settle();
    assert.equal(f.trigger().getAttribute('aria-expanded'), 'false');
    f.requests[0].resolve({ value: 'b' }); await settle();
    assert.equal(f.select.value, 'a');
    f.trigger().click(); await settle();
    f.select.disabled = true; await settle();
    assert.equal(f.trigger().getAttribute('aria-expanded'), 'false');
  } finally { f.close(); }
});

test('outside click, scroll, error and explicit route cleanup dismiss without hidden fallback', async () => {
  const f = fixture();
  try {
    for (const cancel of [
      () => f.w.document.body.dispatchEvent(new f.w.Event('pointerdown', { bubbles: true })),
      () => f.w.document.dispatchEvent(new f.w.Event('scroll')),
      () => f.select.dispatchEvent(new f.w.Event('harbour-menu-close')),
    ]) {
      f.trigger().click(); await settle(); cancel(); await settle();
      assert.equal(f.trigger().getAttribute('aria-expanded'), 'false');
    }
    f.trigger().click(); await settle(); f.requests.at(-1).reject(new Error('fail')); await settle();
    assert.equal(f.trigger().getAttribute('aria-expanded'), 'false');
    assert.ok(f.calls.includes('error'));
  } finally { f.close(); }
});

test('music native menu never resizes/hides/restarts Folia and uses compact options without markup', async () => {
  const f = fixture(true);
  try {
    await settle(); await settle();
    const before = JSON.stringify(f.calls);
    f.trigger().click(); await settle();
    const req = f.requests[0].anchor;
    assert.equal(req.items[0].label, 'Desktop device');
    assert.equal(req.items[0].value, 'local');
    assert.equal(req.items[0].selected, true);
    for (const poll of f.intervals) poll(); await settle();
    assert.equal(JSON.stringify(f.calls), before, 'opening/polling did not mutate player');
    f.requests[0].resolve({ value: 'local' }); await settle();
    assert.deepEqual(f.calls.slice(JSON.parse(before).length), ['close']);
    assert.equal(f.w.document.querySelector('#content').style.getPropertyValue('--music-device-menu-inset'), '');
    assert.doesNotMatch(web('music.css'), /music-device-menu-inset/);
  } finally { f.close(); }
});
