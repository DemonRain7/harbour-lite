const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { FoliaRendererHealth } = require('../folia/renderer-health');
const { createFoliaCrashReporting } = require('../folia/crash-reporting');

// desktop/tests/folia-renderer-health.test.js
test('renderer health distinguishes stale snapshots, isolated visual failures and a dead player', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folia-health-test-'));
  let now = 20_000;
  const health = new FoliaRendererHealth(dir, () => now);
  assert.equal(health.snapshot().phase, 'closed');
  health.start(); assert.equal(health.snapshot().phase, 'starting');
  health.ready(); assert.equal(health.snapshot().phase, 'ready');
  now += 16_000; assert.equal(health.snapshot().phase, 'unresponsive');
  health.seen(); assert.equal(health.snapshot().phase, 'ready');
  health.report('visualizer', 'tempera'); assert.equal(health.snapshot().phase, 'ready');
  health.report('react-root', 'private song / secret URL', true);
  assert.equal(health.snapshot().phase, 'failed');
  health.seen(); assert.equal(health.snapshot().phase, 'failed', 'late state does not revive a failed root');
  const diagnostic = JSON.parse(fs.readFileSync(path.join(dir, 'renderer-health.json'), 'utf8'));
  assert.deepEqual(Object.keys(diagnostic).sort(), ['at', 'reason']);
  health.report('unknown', 'secret', true);
  assert.equal(health.snapshot().lastFailure.reason, 'react-root');
  health.start(); health.ready(); assert.equal(health.snapshot().phase, 'ready');
  health.close(); assert.equal(health.snapshot().phase, 'closed');
});

function fakeContents(url = 'file:///folia/dist/index.html') {
  const contents = new EventEmitter();
  let destroyed = false;
  contents.getURL = () => url;
  contents.isDestroyed = () => destroyed;
  contents.destroy = () => { destroyed = true; contents.emit('destroyed'); };
  return contents;
}

test('Folia crash reports only observed views, without installing global process listeners', () => {
  const processEvents = ['uncaughtException', 'unhandledRejection'];
  const original = processEvents.map(event => process.listeners(event));
  const localApp = new EventEmitter();
  const foreignApp = new EventEmitter();
  const owned = fakeContents();
  const foreign = fakeContents('file:///harbour/index.html');
  const reports = [];
  const scoped = createFoliaCrashReporting(localApp);
  scoped.install({ crashLog: { report: (...args) => reports.push(args) } });
  scoped.observe(owned);
  foreign.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 });
  foreignApp.emit('render-process-gone', {}, foreign, { reason: 'crashed' });
  localApp.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed' });
  assert.equal(reports.length, 0);
  owned.emit('render-process-gone', {}, { reason: 'oom', exitCode: 7 });
  assert.deepEqual(reports, [[
    'render-process-gone',
    'Reason     oom\nExit code  7\nURL        file:///folia/dist/index.html\nRecovered  false',
    { announceToUser: true },
  ]]);
  scoped.dispose();
  for (let index = 0; index < processEvents.length; index += 1) {
    assert.deepEqual(process.listeners(processEvents[index]), original[index]);
  }
});

test('moving one Folia view between shells does not multiply crash or recovery listeners', () => {
  const app = new EventEmitter();
  const contents = fakeContents();
  let healthReports = 0;
  const existingHealthListener = () => { healthReports += 1; };
  contents.on('render-process-gone', existingHealthListener);
  const reports = [];
  const scoped = createFoliaCrashReporting(app);
  const settings = { crashLog: { report: (...args) => reports.push(args) } };
  for (let count = 0; count < 20; count += 1) {
    scoped.install(settings);
    scoped.observe(contents);
  }
  assert.equal(contents.listenerCount('render-process-gone'), 2);
  contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  assert.equal(reports.length, 1);
  assert.equal(healthReports, 1);
  scoped.dispose();
  scoped.dispose();
  assert.deepEqual(contents.listeners('render-process-gone'), [existingHealthListener]);
  assert.equal(contents.listenerCount('destroyed'), 0);
  assert.equal(app.listenerCount('before-quit'), 0);
  assert.equal(app.listenerCount('will-quit'), 0);
  contents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(reports.length, 1);
  assert.equal(healthReports, 2, 'existing renderer-health ownership is not removed');
});

test('normal exit and wallpaper recovery keep upstream no-dialog policy', () => {
  const app = new EventEmitter();
  const player = fakeContents();
  const remote = fakeContents('file:///folia/dist/index.html?remote=1');
  const reports = [];
  const scoped = createFoliaCrashReporting(app);
  scoped.install({
    crashLog: { report: (...args) => reports.push(args) },
    isRendererCrashRecovered: (details, contents) => contents === player && details.reason === 'crashed',
  });
  scoped.observe(player);
  scoped.observe(remote);
  player.emit('render-process-gone', {}, { reason: 'clean-exit' });
  assert.equal(reports.length, 0);
  player.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.match(reports[0][1], /Recovered  true/);
  assert.equal(reports[0][2].announceToUser, false);
  remote.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(reports[1][2].announceToUser, true, 'Remote is not recovered by the main wallpaper handler');
  app.emit('before-quit');
  remote.emit('render-process-gone', {}, { reason: 'killed' });
  assert.equal(reports[2][2].announceToUser, false);
  scoped.dispose();
});

test('destroyed views and repeated module close/reopen release all scoped listeners', () => {
  const reports = [];
  for (let turn = 0; turn < 20; turn += 1) {
    const app = new EventEmitter();
    const contents = fakeContents();
    const scoped = createFoliaCrashReporting(app);
    scoped.install({ crashLog: { report: (...args) => reports.push(args) } });
    scoped.observe(contents);
    contents.emit('render-process-gone', {}, { reason: 'crashed' });
    assert.equal(reports[turn][2].announceToUser, true);
    contents.destroy();
    scoped.observe(contents);
    assert.equal(contents.listenerCount('render-process-gone'), 0);
    assert.equal(contents.listenerCount('destroyed'), 0);
    app.emit('will-quit');
    scoped.dispose();
    assert.equal(app.listenerCount('before-quit'), 0);
    assert.equal(app.listenerCount('will-quit'), 0);
  }
  assert.equal(reports.length, 20);
});
