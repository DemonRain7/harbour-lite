const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../../web/visual-activity.js'), 'utf8');

function fixture(t, { hidden = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const docEvents = {}, events = {}, styles = [];
  let callback, reply, unsubscribed = 0;
  const document = { hidden, documentElement: { dataset: {} }, head: { appendChild: node => styles.push(node) },
    createElement: () => ({}), addEventListener: (name, fn) => { docEvents[name] = fn; } };
  const window = { addEventListener: (name, fn) => { events[name] = fn; }, harbourDesktop: {
    getVisualPolicy: () => new Promise(resolve => { reply = resolve; }),
    onVisualPolicy: fn => { callback = fn; return () => unsubscribed++; },
  } };
  vm.runInNewContext(source, { window, document, setTimeout, clearTimeout, console });
  return { api: window.HarbourVisualActivity, document, styles, events, reply: state => reply(state),
    policy: paused => callback({ paused }), hide: value => { document.hidden = value; docEvents.visibilitychange(); },
    unsubscribed: () => unsubscribed };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('hidden/quiet drops visual timers, resumes once, then disposes without resurrection', async t => {
  const f = fixture(t); let count = 0;
  const poll = f.api.poll(() => count++, 500); await flush(); assert.equal(count, 1);
  f.hide(true); t.mock.timers.tick(10000); await flush(); assert.equal(count, 1);
  f.policy(true); f.hide(false); assert.equal(f.api.isActive(), false);
  f.policy(false); await flush(); assert.equal(count, 2);
  t.mock.timers.tick(500); await flush(); assert.equal(count, 3);
  poll.dispose(); f.hide(true); f.hide(false); t.mock.timers.tick(10000); await flush(); assert.equal(count, 3);
  assert.match(f.styles[0].textContent, /animation-play-state:paused/);
});

test('slow async polling never overlaps; resume coalesces one catch-up and errors keep cadence', async t => {
  const f = fixture(t); let calls = 0, finish;
  const poll = f.api.poll(() => { calls++; return new Promise(resolve => { finish = resolve; }); }, 4000);
  t.mock.timers.tick(20000); await flush(); assert.equal(calls, 1);
  f.policy(true); f.policy(false); f.policy(true); f.policy(false); await poll.refresh();
  assert.equal(calls, 1); finish(); await flush(); assert.equal(calls, 2);
  poll.dispose(); finish(); await flush(); t.mock.timers.tick(20000); assert.equal(calls, 2);
  let errors = 0;
  const failed = f.api.poll(() => { throw new Error('network'); }, 500, { onError: () => errors++ });
  await flush(); t.mock.timers.tick(500); await flush(); assert.equal(errors, 2); failed.dispose();
});

test('late initial IPC cannot undo a newer quiet event and hidden initial page does no work', async t => {
  const f = fixture(t, { hidden: true }); let count = 0;
  const poll = f.api.poll(() => count++, 1000);
  f.policy(true); f.reply({ paused: false }); await flush(); f.hide(false); assert.equal(count, 0);
  f.policy(false); await flush(); assert.equal(count, 1);
  f.events.pagehide({ persisted: true }); assert.equal(f.unsubscribed(), 0, 'BFCache keeps native listener');
  f.events.pagehide({ persisted: false }); assert.equal(f.unsubscribed(), 1); poll.dispose();
});

test('main chat does not eagerly import chart engine; desktop resources ship the lifecycle', () => {
  const root = path.resolve(__dirname, '../..');
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'web/index.html'), 'utf8'), /src="\/vendor\/echarts/);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json'), 'utf8'));
  assert.ok(pkg.build.extraResources.find(row => row.to === 'web').filter.includes('visual-activity.js'));
});
