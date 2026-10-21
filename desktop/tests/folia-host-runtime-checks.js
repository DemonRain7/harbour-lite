const assert = require('node:assert/strict');

// Isolated real Dashboard + native Folia view: unrelated DOM traffic must not
// become player geometry work. Dialog/menu hit-testing must still be immediate.
module.exports = async function checkHostRuntime({ js, pause, folia, nativeFrames }) {
  await pause(800);
  await js(`(() => {
    const stage = document.querySelector('#musicStage');
    const measure = stage.getBoundingClientRect.bind(stage);
    window.__musicGeometryReads = 0;
    stage.getBoundingClientRect = () => { window.__musicGeometryReads++; return measure(); };
  })()`);
  const start = nativeFrames.length;
  await js(`new Promise(resolve => {
    const unrelated = document.createElement('div');
    document.body.append(unrelated);
    let frame = 0;
    const tick = () => {
      unrelated.className = 'unrelated-frame-' + frame;
      unrelated.textContent = String(frame);
      if (++frame < 120) requestAnimationFrame(tick);
      else { unrelated.remove(); requestAnimationFrame(resolve); }
    };
    requestAnimationFrame(tick);
  })`);
  const reads = await js('window.__musicGeometryReads');
  const beforeIdle = nativeFrames.length;
  await pause(5500); // At least two real status polls, with an unchanged layout.
  const idleResizes = nativeFrames.length - beforeIdle;
  console.log('FOLIA_HOST_RUNTIME', JSON.stringify({ domUpdates: 120, geometryReads: reads,
    idleResizes, nativeResizes: nativeFrames.length - start }));
  assert.equal(reads, 0, 'unrelated animation/log DOM updates must not measure the player');
  assert.equal(idleResizes, 0, 'unchanged status polls must not reset native geometry');

  // Adding/removing, opening/closing, and converting an existing element into
  // an overlay all matter. A filtered observer must not strand an input shield.
  for (const variant of ['added', 'class', 'dialog']) {
    await js(`(() => {
      const overlay = document.createElement(${JSON.stringify(variant === 'dialog' ? 'dialog' : 'div')});
      overlay.id = 'host-runtime-overlay';
      ${variant === 'added' ? "overlay.className = 'md-modal';" : ''}
      document.body.append(overlay);
    })()`);
    if (variant !== 'added') await js(variant === 'dialog'
      ? "document.querySelector('#host-runtime-overlay').open = true"
      : "document.querySelector('#host-runtime-overlay').className = 'md-modal'");
    await pause(100);
    assert.equal(folia.dock.view.getVisible(), false, `${variant}: modal must cover Folia`);
    await js(variant === 'dialog' ? "document.querySelector('#host-runtime-overlay').open = false"
      : variant === 'class' ? "document.querySelector('#host-runtime-overlay').className = ''"
      : "document.querySelector('#host-runtime-overlay').remove()");
    await pause(100);
    assert.equal(folia.dock.view.getVisible(), true, `${variant}: closing modal restores Folia`);
    await js("document.querySelector('#host-runtime-overlay')?.remove()");
  }
  await js("delete document.querySelector('#musicStage').getBoundingClientRect");
};
