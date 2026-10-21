const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../renderer/music-player.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let active = true, stateListener, activityListener, command, providerReads = 0, providerPaints = 0, listWrites = 0;
  const nodes = {}, reports = [];
  const element = () => ({ value: '', classList: { toggle() {}, add() {}, remove() {} }, events: {},
    addEventListener(name, fn) { (this.events[name] ||= []).push(fn); },
    fire(name) { for (const fn of this.events[name] || []) fn(); } });
  const get = name => nodes[name] ||= element();
  const audio = Object.assign(get('audio'), { paused: true, ended: false, currentTime: 0, duration: 120, volume: 0.7,
    play: async () => { audio.paused = false; }, pause: () => { audio.paused = true; }, removeAttribute() {} });
  Object.defineProperty(get('trackList'), 'innerHTML', { set() { listWrites++; } });
  const document = { getElementById: get, querySelector: get, body: element(),
    querySelectorAll: () => { providerPaints++; return []; } };
  const desktop = { listMusic: async () => [{ id: 'song', title: 'Fixture', url: 'file:///unused' }],
    getMusicProvider: async () => { providerReads++; return { provider: 'local' }; },
    reportMusicState: state => reports.push(state), onMusicCommand: fn => { command = fn; },
    onCompanionState: fn => { stateListener = fn; return () => {}; } };
  const window = { harbourDesktop: desktop, addEventListener() {}, HarbourVisualActivity: { isActive: () => active,
    subscribe: fn => { activityListener = fn; return () => {}; } } };
  vm.runInNewContext(source, { window, document, setTimeout, clearTimeout,
    setInterval: () => assert.fail('renderer must not create a duplicate provider poll'), console });
  return { audio, nodes, reports, command: input => command(input), push: music => stateListener({ music }),
    quiet(value) { active = !value; activityListener(active); }, reads: () => providerReads,
    paints: () => providerPaints, writes: () => listWrites };
}

test('local report echoes do not rebuild library; quiet audio/commands/reporting continue', async t => {
  const f = fixture(t); await flush();
  const before = f.paints();
  for (let i = 0; i < 50; i++) f.push({ provider: 'local', positionMs: i * 1000 });
  assert.equal(f.paints(), before); assert.equal(f.reads(), 1); assert.equal(f.writes(), 1);
  await f.command({ action: 'play', trackId: 'song' });
  f.quiet(true); const paints = f.paints(), oldTime = f.nodes.time.textContent;
  f.audio.currentTime = 35; f.audio.fire('timeupdate'); t.mock.timers.tick(1000);
  assert.equal(f.audio.paused, false); assert.equal(f.nodes.time.textContent, oldTime);
  assert.equal(f.reports.at(-1).positionMs, 35000); assert.equal(f.paints(), paints);
  f.quiet(false); assert.equal(f.nodes.time.textContent, '00:35 / 02:00');
  await f.command({ action: 'pause' }); assert.equal(f.audio.paused, true);
});

test('QQ progress updates via push without replacing unchanged track list', async t => {
  const f = fixture(t); await flush();
  const state = { provider: 'qqmusic', connected: true, paused: false, durationMs: 120000,
    currentTrackId: 'qq', tracks: [{ id: 'qq', title: 'QQ fixture' }] };
  f.push(state); const writes = f.writes();
  f.push({ ...state, positionMs: 42000 });
  assert.equal(f.nodes.time.textContent, '00:42 / 02:00'); assert.equal(f.writes(), writes);
  assert.equal(f.reads(), 1);
});

test('provider switches cannot resurrect an obsolete async polling chain', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const main = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
  const code = main.slice(main.indexOf('function syncMusicProviderPolling()'), main.indexOf('\nasync function setMusicProvider'));
  let provider = 'qqmusic', calls = 0, resolve;
  const pending = new Promise(done => { resolve = done; });
  const context = vm.createContext({ musicProviderPollRevision: 0, musicProviderTimer: null, setTimeout, clearTimeout,
    currentMusicProvider: () => provider,
    refreshQQMusicState: () => { calls++; return calls <= 2 ? pending : Promise.resolve({ paused: false }); } });
  vm.runInContext(code, context);
  context.syncMusicProviderPolling(); provider = 'local'; context.syncMusicProviderPolling();
  provider = 'qqmusic'; context.syncMusicProviderPolling();
  resolve({ paused: false }); await flush();
  t.mock.timers.tick(5000); await flush(); assert.equal(calls, 3, 'only the latest chain schedules a successor');
  provider = 'local'; context.syncMusicProviderPolling(); t.mock.timers.tick(20000); await flush();
  assert.equal(calls, 3);
});
