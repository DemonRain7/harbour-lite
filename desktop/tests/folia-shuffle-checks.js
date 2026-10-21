const assert = require('node:assert/strict');
const { BrowserWindow } = require('electron');

// Real local queue/audio + production bridge, in the isolated local playback fixture.
module.exports = async (controller, tracks) => {
  const wc = controller.runtime.getMainWindow().webContents;
  const js = code => wc.executeJavaScript(code, true);
  await assert.rejects(controller.command({ action: 'shuffle' }), /至少需要 2 首/);
  for (const track of tracks.slice(1)) await controller.command({ action: 'enqueue', trackId: track.id });
  await new Promise(resolve => setTimeout(resolve, 120));
  const before = await controller.command({ action: 'queue' });
  assert.equal(before.shuffleAvailable, true);
  assert.equal(before.tracks.length, 5);
  const active = before.currentTrackId;
  // Fix only the fixture's RNG briefly so a valid identity permutation cannot flake this assertion.
  await js('window.__shuffleRandom=Math.random; Math.random=()=>0; void 0');
  let after;
  try { after = await controller.command({ action: 'shuffle' }); }
  finally { await js('Math.random=window.__shuffleRandom; delete window.__shuffleRandom; void 0'); }
  assert.equal(after.accepted, true);
  assert.equal(after.currentTrackId, active);
  assert.equal(after.tracks[0].id, active);
  assert.notDeepEqual(after.tracks.map(t => t.id), before.tracks.map(t => t.id));
  assert.deepEqual(after.tracks.map(t => t.id).sort(), before.tracks.map(t => t.id).sort());
  assert.equal(after.paused, false);
  assert.ok(after.positionMs >= before.positionMs, 'shuffle must not restart the current audio');
  for (const event of ['pause','emptied','error']) assert.equal(after.audioHealth.media.events[event] || 0, before.audioHealth.media.events[event] || 0);
  const dashboard = new BrowserWindow({ show: false, width: 1200, height: 800 });
  try {
    for (const mode of ['embedded', 'window', 'embedded']) {
      await controller.open(mode, dashboard, { x: 20, y: 80, width: 1160, height: 650 });
      const state = await controller.command({ action: 'queue' });
      assert.equal(controller.runtime.getMainWindow().webContents, wc);
      assert.deepEqual(state.tracks.map(t => t.id), after.tracks.map(t => t.id));
    }
    await controller.command({ action: 'next' });
    const nextDeadline = Date.now()+5000;
    let next;
    do {
      await new Promise(resolve => setTimeout(resolve, 50));
      next = await controller.command({ action: 'queue' });
    } while (next.currentTrackId === active && Date.now()<nextDeadline);
    assert.equal(next.currentTrackId, after.tracks[1].id, 'next uses the shuffled queue');
    await controller.command({ action: 'previous' });
    const deadline = Date.now()+5000;
    while ((await controller.command({ action: 'queue' })).currentTrackId !== active && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal((await controller.command({ action: 'queue' })).currentTrackId, active);
  } finally { controller.hide(); dashboard.destroy(); }
  console.log('FOLIA_SHUFFLE_OK: five real local tracks, unchanged current audio, same queue across host modes, next/previous follow actual order');
};
