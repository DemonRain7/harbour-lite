const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FoliaController } = require('../folia/controller');

// desktop/tests/folia-play-next.test.js — stub IPC only; never starts Electron.
function fixture(state) {
  const controller = new FoliaController({ root: __dirname, dataDir: __dirname });
  const requests = [];
  controller.runtime = {};
  controller.ensure = async () => {};
  controller.rendererHealth.ready();
  controller.request = async command => {
    requests.push(command);
    return command.action === 'status' ? state : { accepted: true };
  };
  return { controller, requests };
}

test('play-next verifies fresh renderer support before forwarding exactly one insertion', async () => {
  const { controller, requests } = fixture({ playNextAvailable: true });
  assert.deepEqual(await controller.command({ action: 'play_next', trackId: 'B' }), { accepted: true });
  assert.deepEqual(requests, [{ action: 'status' }, { action: 'play_next', trackId: 'B' }]);
});

test('old and unavailable renderer capabilities reject without insertion or fallback', async () => {
  for (const state of [{}, { playNextAvailable: false }, { playNextAvailable: 'true' }]) {
    const { controller, requests } = fixture(state);
    controller.state.playNextAvailable = true;
    await assert.rejects(controller.command({ action: 'play_next', trackId: 'B' }), /不支持下一首播放/);
    assert.deepEqual(requests, [{ action: 'status' }]);
  }
});

test('closed or failed renderer never advertises play-next availability', () => {
  const { controller } = fixture({ playNextAvailable: true });
  controller.state.playNextAvailable = true;
  assert.equal(controller.status().playNextAvailable, true);
  controller.runtime = null;
  assert.equal(controller.status().playNextAvailable, false);
  controller.runtime = {};
  controller.rendererHealth.phase = 'failed';
  assert.equal(controller.status().playNextAvailable, false);
});
