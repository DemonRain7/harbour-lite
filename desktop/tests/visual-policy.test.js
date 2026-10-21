const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { VisualPolicy } = require('../companion/visual-policy');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

function surface({ visible = true, focused = true } = {}) {
  const win = new EventEmitter();
  Object.assign(win, { visible, focused, minimized: false, destroyed: false, sent: [],
    isVisible: () => win.visible, isFocused: () => win.focused,
    isMinimized: () => win.minimized, isDestroyed: () => win.destroyed });
  win.webContents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => win.destroyed,
    send: (topic, state) => win.sent.push({ topic, state }) });
  return win;
}

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let busy = false, calls = 0, loads = 0;
  const changes = [], warnings = [], power = new EventEmitter();
  const policy = new VisualPolicy({ platform: 'win32', powerMonitor: power,
    probeFactory: () => { loads++; return () => { calls++; return busy; }; },
    onChange: state => changes.push(state), logger: { warn: (...args) => warnings.push(args) }, ...options });
  policy.start(); t.after(() => policy.dispose());
  return { policy, power, changes, warnings, busy: value => { busy = value; }, calls: () => calls, loads: () => loads };
}

test('auto detects fullscreen only for unfocused visible surfaces and publishes only changes', t => {
  const f = fixture(t), main = surface(), pet = surface({ focused: false });
  f.policy.register(main); f.policy.register(pet);
  assert.equal(f.loads(), 0, 'focused Harbour must not scan');
  f.busy(true); main.focused = false; main.emit('blur');
  assert.equal(f.loads(), 1); assert.equal(f.policy.snapshot(pet).paused, true);
  const sent = pet.sent.length;
  t.mock.timers.tick(6000);
  assert.equal(pet.sent.length, sent, 'unchanged native state sends no IPC');
  f.busy(false); t.mock.timers.tick(2000);
  assert.equal(f.policy.snapshot(pet).paused, false);
  main.focused = true; main.emit('focus'); const calls = f.calls();
  t.mock.timers.tick(10000); assert.equal(f.calls(), calls);
  main.visible = pet.visible = false; main.emit('hide'); pet.emit('hide');
  assert.equal(f.policy.snapshot(pet).reason, 'hidden');
  t.mock.timers.tick(10000); assert.equal(f.calls(), calls, 'no probe for invisible surfaces');
});

test('quiet/normal modes, lock and resume never change windows or task/audio state', t => {
  const f = fixture(t), win = surface(); f.policy.register(win);
  f.policy.setMode('quiet'); assert.equal(f.policy.snapshot(win).paused, true);
  assert.equal(win.visible, true, 'visual policy does not hide or close the UI');
  f.policy.setMode('normal'); assert.equal(f.policy.snapshot(win).paused, false);
  f.power.emit('lock-screen'); f.power.emit('suspend'); f.power.emit('resume');
  assert.equal(f.policy.snapshot(win).reason, 'locked', 'resume must not undo screen lock');
  f.power.emit('unlock-screen'); assert.equal(f.policy.snapshot(win).paused, false);
  win.minimized = true; win.emit('minimize'); assert.equal(f.policy.snapshot(win).paused, true);
  win.minimized = false; win.emit('restore'); assert.equal(f.policy.snapshot(win).paused, false);
  assert.equal(f.loads(), 0);
  assert.ok(win.sent.every(entry => entry.topic === 'desktop:visual-policy'));
});

test('native failure is one-shot and manual quiet remains usable on all platforms', t => {
  const f = fixture(t, { probeFactory: () => { throw new Error('optional native binary absent'); } });
  const win = surface({ focused: false }); f.policy.register(win);
  for (let i = 0; i < 4; i++) { f.policy.refresh(); t.mock.timers.tick(10000); }
  assert.equal(f.warnings.length, 1); assert.equal(f.policy.snapshot(win).paused, false);
  f.policy.setMode('quiet'); assert.equal(f.policy.snapshot(win).paused, true);
  f.policy.dispose(); assert.equal(f.power.listenerCount('suspend'), 0);
  assert.equal(win.listenerCount('hide'), 0);
  const other = new VisualPolicy({ platform: 'darwin', probeFactory: () => assert.fail('Windows-only') });
  t.after(() => other.dispose()); other.register(surface({ focused: false })); other.setMode('quiet');
  assert.equal(other.quiet, true);
});

test('initial state IPC accepts only registered main frames; reload replays latest state', t => {
  const { policy } = fixture(t), win = surface(); policy.register(win);
  policy.start(); assert.equal(policy.powerMonitor.listenerCount('suspend'), 1, 'start is idempotent');
  assert.equal(policy.forSender({ sender: win.webContents, senderFrame: win.webContents.mainFrame }).paused, false);
  assert.throws(() => policy.forSender({ sender: win.webContents, senderFrame: {} }), /Unknown/);
  assert.throws(() => policy.forSender({ sender: surface().webContents }), /Unknown/);
  policy.setMode('quiet'); const sent = win.sent.length;
  win.webContents.emit('did-finish-load'); assert.equal(win.sent.length, sent + 1);
  assert.equal(win.sent.at(-1).state.paused, true);
});

test('device-local preference survives relaunch and invalid values do not overwrite it', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-visual-policy-'));
  const file = path.join(dir, 'visual-policy.json');
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(dir); });
  const { policy } = fixture(t, { file }); policy.setMode('quiet');
  assert.throws(() => policy.setMode('delete'), /Unknown/);
  const next = new VisualPolicy({ file }); t.after(() => next.dispose());
  assert.equal(next.mode, 'quiet');
});
