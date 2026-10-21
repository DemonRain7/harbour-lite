const assert = require('node:assert/strict');

// Actual Dashboard drawer + IPC + Folia renderer. No owner data or playback commands.
async function checkNavigation({ folia, win, player, js, pause, capture, themes, commands, nativeFrames, presentations, setMotion }) {
  await setMotion('no-preference');
  assert.equal(await js('matchMedia("(prefers-reduced-motion: reduce)").matches'), false);
  assert.ok(await js('getComputedStyle(document.querySelector("#sidebar")).transitionDuration.split(",").some(s=>parseFloat(s) >= .2)'), 'animation fixture must use real nonzero production transitions');
  const beforeCommands = commands.length, beforePresentations = presentations.length;
  const playerId = player.id;
  await player.executeJavaScript('window.__harbourNavIdentity = "same-player"; window.__navResizeCount = 0; window.addEventListener("resize", () => ++window.__navResizeCount)');
  const layout = () => js(`(() => {
    const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
    const nav=rect('#sidebar'), stage=rect('#musicStage');
    return {nav,stage,open:document.querySelector('.shell').classList.contains('nav-open'),
      transitioning:document.querySelector('#sidebar').getAnimations().some(a=>a.playState==='running'),
      clickable:!!document.elementFromPoint(nav.x+nav.width/2,nav.y+40)?.closest('#sidebar')};
  })()`);
  const viewport = () => player.executeJavaScript('({width:innerWidth,height:innerHeight})');
  const assertNavigation = async open => {
    await capture(win.webContents);
    let current;
    for (let i = 0; i < 40; i++) {
      current = await layout();
      const zoom = win.webContents.getZoomFactor(), frame = folia.dock.bounds, clip = folia.dock.clip.getBounds();
      if (!current.transitioning && current.open === open &&
          Math.abs(clip.x - (open ? Math.max(current.stage.x, current.nav.right) : current.stage.x) * zoom) <= 1 &&
          ['x','y','width','height'].every(key => Math.abs(frame[key] - current.stage[key]*zoom) <= 1)) break;
      await pause(50);
    }
    const zoom = win.webContents.getZoomFactor(), view = folia.dock.view.getBounds(), clip = folia.dock.clip.getBounds();
    const detail = JSON.stringify({ current, view, clip, zoom });
    assert.equal(current.open, open, detail);
    assert.equal(current.transitioning, false, detail);
    assert.equal(folia.dock.view.getVisible(), true, 'navigation never hides the player');
    assert.equal(folia.dock.clip.getVisible(), true, detail);
    assert.ok(Math.abs(clip.x - (open ? Math.max(current.stage.x, current.nav.right) : current.stage.x) * zoom) <= 1, detail);
    assert.ok(Math.abs(clip.x + view.x - current.stage.x*zoom) <= 1, 'child offset preserves screen X: ' + detail);
    assert.ok(Math.abs(clip.y + view.y - current.stage.y*zoom) <= 1, 'child offset preserves screen Y: ' + detail);
    for (const key of ['width','height']) assert.ok(Math.abs(view[key] - current.stage[key]*zoom) <= 1, detail);
    if (open) assert.ok(current.clickable && current.stage.x < current.nav.right, 'drawer overlays rather than pushes: ' + detail);
    assert.equal(folia.runtime.getMainWindow().webContents.id, playerId);
    assert.equal(await player.executeJavaScript('window.__harbourNavIdentity'), 'same-player');
    return current;
  };
  const toggle = () => js('document.querySelector("#navToggle").click()');
  const sampleSlide = async open => {
    // A shared VM cannot promise four compositor frames in a 240ms transition.
    // Advance real CSS transitions to known intermediate times instead. Keep
    // them running so production's rAF follower, IPC and native clip do the work;
    // never call resize or dispatch synthetic transition events from the test.
    const transitions = await js(`(() => {
      document.querySelector('#navToggle').click();
      window.__navTestTransitions = document.querySelector('#sidebar').getAnimations();
      for (const a of window.__navTestTransitions) { a.playbackRate=.001; a.currentTime=0; }
      return window.__navTestTransitions.map(a=>a.transitionProperty);
    })()`);
    assert.ok(transitions.includes('transform'), 'real transform transition must exist');
    try {
      for (const fraction of [.35, .55, .75]) {
        const start = nativeFrames.length;
        const previousX = folia.dock.clip.getBounds().x;
        await js(`(async () => {
          for (const a of window.__navTestTransitions) a.currentTime=a.effect.getComputedTiming().endTime*${fraction};
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        })()`);
        let current, clip, view, aligned = false;
        for (let i=0;i<40;i++) {
          current = await layout();
          clip = folia.dock.clip.getBounds(); view = folia.dock.view.getBounds();
          const expected = Math.max(current.stage.x, current.nav.right)*win.webContents.getZoomFactor();
          // Once the closing drawer is outside Folia, unchanged clipping is
          // deliberately deduplicated. Only changed geometry must send IPC.
          aligned = Math.abs(clip.x-expected) <= 1 &&
            (Math.abs(previousX-expected) <= 1 || nativeFrames.length > start);
          if (aligned) break;
          await pause(25);
        }
        assert.ok(aligned, 'native clip follows the actual intermediate DOM position: ' + JSON.stringify({open,fraction,current,clip,view}));
        assert.equal(folia.dock.view.getVisible(), true);
        assert.equal(clip.x+view.x, folia.dock.bounds.x);
      }
    } finally {
      await js('for (const a of window.__navTestTransitions) a.finish(); delete window.__navTestTransitions');
    }
    await assertNavigation(open);
  };
  const assertTogglePair = async () => {
    await assertNavigation(false);
    // Settle any preceding window/search/theme resize on the hidden child too,
    // before measuring the drawer-only interval (Dashboard capture excludes it).
    await capture(player);
    const baseline = (await layout()).stage, size = await viewport();
    await player.executeJavaScript('window.__navResizeCount = 0');
    const start = nativeFrames.length;
    await sampleSlide(true);
    assert.deepEqual((await layout()).stage, baseline, 'opening drawer must not relayout Folia');
    await sampleSlide(false);
    assert.deepEqual((await layout()).stage, baseline);
    assert.deepEqual(await viewport(), size);
    assert.equal(await player.executeJavaScript('window.__navResizeCount'), 0, 'no resize events from drawer toggling');
    const frames = nativeFrames.slice(start);
    if (new Set(frames.map(f => f.view.x)).size <= 3) {
      assert.fail('native clipping follows the actual slide, not just its endpoints: ' + JSON.stringify({
        frames, window: win.getBounds(), visible: win.isVisible(), focused: win.isFocused(),
        document: await js('({visible:document.visibilityState,animations:document.querySelector("#sidebar").getAnimations().map(a=>a.effect.getTiming())})'),
      }));
    }
    for (const f of frames) {
      assert.equal(f.visible, true);
      assert.equal(f.view.width, folia.dock.bounds.width);
      assert.equal(f.clip.x + f.view.x, folia.dock.bounds.x);
    }
  };
  // Also let an unmodified wall-clock transition finish normally. Its endpoint
  // and lifecycle are required; the VM's instantaneous FPS is not a contract.
  await toggle(); await assertNavigation(true);
  await toggle(); await assertNavigation(false);
  await assertTogglePair();
  await js('document.querySelector("#musicControlToggle").click(); document.querySelector("#musicQuery").value="保留搜索草稿"');
  await pause(150); await assertTogglePair();
  if (process.argv.includes('--themes')) {
    for (const theme of themes) {
      await js(`applyTheme(...${JSON.stringify(theme)})`);
      for (const width of [520,860,1400,1920]) {
        win.setSize(width,940); await assertTogglePair();
        assert.equal(await js('document.querySelector("#musicQuery").value'), '保留搜索草稿');
      }
    }
  }
  win.setSize(1400,940); await js('applyTheme("anime","elaina","anime-wisteria")');
  for (const zoom of [1.25,.9,1]) { win.webContents.setZoomFactor(zoom); await assertTogglePair(); }
  await toggle(); await assertNavigation(true);
  await js('window.navTestDialog=document.createElement("dialog"); document.body.append(navTestDialog); navTestDialog.showModal()'); await pause(100);
  assert.equal(folia.dock.view.getVisible(), false, 'real modal still owns input');
  assert.equal(folia.dock.clip.getVisible(), false);
  await js('navTestDialog.close(); navTestDialog.remove()'); await assertNavigation(true);
  await js('document.querySelector("#musicControlClose").click()'); await pause(150);
  for (let i=0;i<12;i++) { await toggle(); await pause(20); }
  await assertNavigation(true);
  await toggle(); await assertNavigation(false);
  const idleFrames = nativeFrames.length; await pause(500);
  assert.ok(nativeFrames.length - idleFrames <= 1, 'no perpetual per-frame IPC after slide ends');
  // Reduced motion is a separate accessibility case, not a failed animation:
  // verify final clipping and input without demanding artificial interim frames.
  await setMotion('reduce');
  assert.equal(await js('matchMedia("(prefers-reduced-motion: reduce)").matches'), true);
  const reducedSize = await viewport();
  await toggle(); await assertNavigation(true);
  await toggle(); await assertNavigation(false);
  assert.deepEqual(await viewport(), reducedSize);
  assert.equal(commands.length, beforeCommands+1, 'only opening search requests queue, never playback');
  assert.equal(presentations.length, beforePresentations, 'opening navigation is not a page leave/open');
  console.log('FOLIA_NAV_OVERLAY_OK: fixed viewport, animated clip, reduced motion, rapid reversal, zoom, modal, idle, one document');
}

module.exports = async options => {
  // Make both media preferences explicit rather than inherit the Mac CI image's
  // accessibility defaults. This affects only this isolated test webContents.
  const debuggerApi = options.win.webContents.debugger;
  const ownsDebugger = !debuggerApi.isAttached();
  if (ownsDebugger) debuggerApi.attach('1.3');
  const setMotion = value => debuggerApi.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value }],
  });
  console.log('FOLIA_FIXTURE_MOTION', await options.js('({reduced:matchMedia("(prefers-reduced-motion: reduce)").matches,duration:getComputedStyle(document.querySelector("#sidebar")).transitionDuration})'));
  try { await checkNavigation({ ...options, setMotion }); }
  finally {
    await debuggerApi.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    if (ownsDebugger) debuggerApi.detach();
  }
};
