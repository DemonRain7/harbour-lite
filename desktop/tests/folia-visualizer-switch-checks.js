const assert = require('node:assert/strict');
const { BrowserWindow } = require('electron');

// desktop/tests/folia-visualizer-switch-checks.js
// Switch the real player's modes via its picker while a local WAV is running.
module.exports = async function checkVisualizerSwitch(controller) {
  const musicWindow = controller.runtime.getMainWindow();
  musicWindow.show(); musicWindow.focus();
  const wc = musicWindow.webContents;
  const js = code => wc.executeJavaScript(code, true);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const errors = [];
  const onError = details => { if (details.level === 'error') errors.push(details.message); };
  wc.on('console-message', onError);
  const wait = async (expression, label) => {
    for (let i = 0; i < 120; i++) { if (await js(expression)) return; await pause(75); }
    throw new Error(label + ': ' + JSON.stringify({ errors, body: await js('document.body.innerText') }));
  };
  const dashboard = new BrowserWindow({ show: false, width: 1280, height: 850 });
  try {
    await wait('document.visibilityState === "visible"', 'foreground music window');
    await js(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='我知道了')?.click()`);
    await controller.command({ action: 'resume' });
    await wait('!!document.querySelector("[data-testid=panel-toggle] button")', 'player');
    await js('document.querySelector("[data-testid=panel-toggle] button").click()');
    await wait('!!document.querySelector("[data-testid=unified-panel-surface]")', 'controls panel');
    await js(`document.querySelector('[data-testid="unified-panel-surface"] button[aria-pressed][title="控制"]')?.click()`);
    const picker = 'button[aria-haspopup="listbox"][aria-label="歌词样式"]';
    // The picker is shared by all modes, not a test-only setting/store override.
    await wait(`!!document.querySelector(${JSON.stringify(picker)})`, 'visualizer picker');
    const before = await controller.command({ action: 'queue' });
    const waitForRestoredQueue = async () => {
      let snapshot;
      for (let attempt = 0; attempt < 80; attempt++) {
        snapshot = await controller.command({ action: 'queue' });
        if (snapshot.tracks.some(track => track.id === before.currentTrackId)) return snapshot;
        await pause(100);
      }
      assert.fail('persisted queue did not restore: ' + JSON.stringify({ snapshot, errors }));
    };
    for (const presentation of ['window', 'embedded']) {
      if (presentation === 'embedded') { dashboard.show(); dashboard.focus(); }
      else { dashboard.hide(); musicWindow.show(); musicWindow.focus(); }
      await controller.open(presentation, dashboard, { x: 20, y: 40, width: 1200, height: 740 });
      for (const label of ['凝彩', '流光', '凝彩', '流光', '商籁', '流光']) {
        await js(`document.querySelector(${JSON.stringify(picker)}).click()`);
        await wait(`!![...document.querySelectorAll('[role=option]')].find(e=>e.innerText.trim()===${JSON.stringify(label)})`, label);
        await js(`[...document.querySelectorAll('[role=option]')].find(e=>e.innerText.trim()===${JSON.stringify(label)}).click()`);
        await pause(900);
        const state = await controller.command({ action: 'queue' });
        assert.equal(state.paused, false);
        assert.equal(state.currentTrackId, before.currentTrackId);
        assert.ok(state.positionMs > before.positionMs);
        assert.equal(wc.isDestroyed(), false);
        assert.equal(state.audioHealth.media.errorCode, null);
        assert.equal(state.audioHealth.media.events.pause || 0, before.audioHealth.media.events.pause || 0);
        assert.equal(errors.length, 0, errors.join('\n'));
        console.log('FOLIA_VISUALIZER_SWITCH_OK', presentation, label, state.positionMs);
      }
    }
    let reloads = 0;
    const nativeReload = wc.reload.bind(wc);
    wc.reload = () => { reloads++; return nativeReload(); };
    controller.rendererHealth.lastSeenAt = Date.now() - 16_000;
    assert.equal(controller.status().renderer.phase, 'unresponsive');
    await controller.open('window');
    assert.equal(reloads, 0, 'stale heartbeat with a live bridge is probed, not reloaded');
    assert.equal(controller.status().renderer.phase, 'ready');
    // Fatal bridge reports are injected; the next check is a real renderer process crash.
    await js(`localStorage.setItem('harbour-health-fixture','preserved');window.harbourFolia.reportFailure('react-root')`);
    await pause(50);
    assert.equal(controller.status().renderer.phase, 'failed');
    await assert.rejects(controller.command({ action: 'next' }), /未提交/);
    await controller.open('window');
    assert.equal(controller.status().renderer.phase, 'ready');
    assert.equal(await js(`localStorage.getItem('harbour-health-fixture')`), 'preserved');
    await waitForRestoredQueue();

    const gone = new Promise(resolve => wc.once('render-process-gone', resolve));
    wc.forcefullyCrashRenderer();
    await gone;
    assert.equal(controller.status().renderer.phase, 'failed');
    await assert.rejects(controller.command({ action: 'next' }), /未提交/);
    reloads = 0;
    await Promise.all([controller.open('embedded', dashboard, { x: 20, y: 40, width: 1200, height: 740 }), controller.open('window')]);
    assert.equal(reloads, 1, 'concurrent opens coalesce one recovery');
    assert.equal(controller.status().renderer.phase, 'ready');
    assert.equal(await js(`localStorage.getItem('harbour-health-fixture')`), 'preserved');
    assert.equal(await js(`localStorage.getItem('visualizer_mode')`), 'classic');
    const recovered = await waitForRestoredQueue();
    assert.ok(recovered.tracks.some(track => track.id === before.currentTrackId), 'persisted queue survives page recovery');
    assert.equal(recovered.paused, true, 'recovery never replays a playback command');
    console.log('FOLIA_RENDERER_RECOVERY_OK: fatal report + actual crash, one reload, queue/settings preserved, no replay');
  } finally {
    wc.off('console-message', onError);
    controller.hide(dashboard); dashboard.destroy();
  }
};
