// Real mouse/keyboard and top-layer layout, using only the isolated fixture server.
const assert = require('node:assert/strict');
module.exports = async ({ win, fixture, evaluate, click, waitFor, screenshot, prefix }) => {
  const music = '.chat-music-collapse', appearance = '.chat-hero-picker > summary';
  const metrics = () => evaluate(win, `(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom }; };
    return { rail:rect('.chat-sessions'), chat:rect('.chat-workbench'), stream:rect('.chat-stream'), tabs:rect('.chat-mode-tabs'), tools:rect('.chat-tools'),
      viewport:innerWidth,height:innerHeight,docWidth:document.documentElement.scrollWidth,
      reserved:parseFloat(getComputedStyle(document.querySelector('.chat-stream')).paddingTop),
      anime:document.body.dataset.themeCat === 'anime', portrait:document.body.dataset.chatHeroHidden,
      draft:document.querySelector('#chatInput').value, session:state.chat.sessionId };
  })()`);
  const bounds = async selector => {
    const r = await evaluate(win, `(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,viewWidth:innerWidth,viewHeight:innerHeight}; })()`);
    assert.ok(r.width > 200 && r.height > 120, `panel has usable dimensions: ${JSON.stringify(r)}`);
    assert.ok(r.left >= 10 && r.top >= 10 && r.right <= r.viewWidth - 10 && r.bottom <= r.viewHeight - 10, `panel stays entirely in viewport: ${JSON.stringify(r)}`);
    return r;
  };
  const escape = async () => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  };
  await waitFor(win, "document.querySelector('#chatMusic').dataset.playing==='true'", 'music snapshot');
  // Initial persona decoration and the content's width transition settle asynchronously.
  await evaluate(win, "new Promise(resolve => setTimeout(resolve, 600))");
  await evaluate(win, "document.querySelector('#chatInput').value='草稿留在这里，不被工具面板打断。'");
  const base = await metrics();
  assert.equal(await evaluate(win, "!!document.querySelector('.chat-viewbar') || !!document.querySelector('.chat-workbench #chatMusic') || !!document.querySelector('.chat-stream-wrap #chatBgPicker')"), false, 'no reserved utility rows or floating background strip');
  assert.ok(base.docWidth <= base.viewport + 1, 'no page horizontal overflow');
  assert.ok(base.reserved <= 24, 'conversation no longer reserves 72px for background toolbar');
  if (base.viewport > 1120) assert.ok(Math.abs(base.rail.y - base.chat.y) < 2, 'conversation starts at the top of session rail');
  const intersects = (a, b) => Math.min(a.right, b.right) > Math.max(a.x, b.x) + 1 && Math.min(a.bottom, b.bottom) > Math.max(a.y, b.y) + 1;
  assert.equal(intersects(base.tabs, base.tools), false, 'mode tabs and utility buttons never overlap');
  assert.equal(await evaluate(win, "document.querySelector('.chat-music-content').hidden"), true);
  await screenshot(win, `tools-${prefix}-closed.png`);
  await click(win, music);
  await waitFor(win, "document.querySelector('.chat-music-content').matches(':popover-open')", 'music uses top layer');
  await bounds('.chat-music-content');
  assert.equal((await metrics()).chat.height, base.chat.height, 'music overlays without shrinking conversation');
  await screenshot(win, `tools-${prefix}-music.png`);
  await click(win, music);
  await waitFor(win, "document.querySelector('.chat-music-content').hidden", 'same icon toggles closed');
  await click(win, music); await escape();
  await waitFor(win, "document.querySelector('.chat-music-content').hidden && document.activeElement.matches('.chat-music-collapse')", 'Escape closes and restores focus');
  if (base.anime) {
    await click(win, music); await click(win, appearance);
    await waitFor(win, "document.querySelector('#chatHeroPopover').matches(':popover-open')", 'portrait uses top layer');
    assert.equal(await evaluate(win, "document.querySelector('.chat-music-content').hidden"), true, 'only one panel at a time');
    await bounds('#chatHeroPopover');
    await screenshot(win, `tools-${prefix}-appearance.png`);
    await click(win, '#chatBgPicker [data-bg="grid"]');
    assert.equal(await evaluate(win, "document.querySelector('.chat-stream-wrap').classList.contains('csw-grid')"), true);
    await click(win, '[data-hero-close]');
    await waitFor(win, "document.querySelector('#chatHeroPopover').hidden", 'appearance close button');
    await click(win, appearance);
    // On a phone-sized viewport, the panel can cover the composer: use its visible outer margin.
    const outside = await evaluate(win, '({x:innerWidth-3,y:Math.round(innerHeight/2)})');
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...outside, button: 'left', clickCount: 1 });
    await waitFor(win, "document.querySelector('#chatHeroPopover').hidden", 'outside click closes');
    assert.equal((await metrics()).draft, base.draft, 'opening settings never replaces draft');
    if (base.viewport > 600) {
      await click(win, '[data-hero-quick]');
      await waitFor(win, `document.body.dataset.chatHeroHidden !== ${JSON.stringify(base.portrait)}`, 'portrait quick hide');
      await click(win, '[data-hero-quick]');
      await waitFor(win, `document.body.dataset.chatHeroHidden === ${JSON.stringify(base.portrait)}`, 'portrait quick restore');
    } else {
      assert.equal(await evaluate(win, "getComputedStyle(document.querySelector('.harbour-hero')).display"), 'none', 'small screens reclaim the portrait column');
      assert.equal((await metrics()).portrait, base.portrait, 'responsive layout never rewrites portrait preference');
      assert.ok(base.chat.width >= base.viewport - 34, 'chat uses the narrow viewport');
    }
  }
  assert.equal(await evaluate(win, "document.querySelector('.chat-calendar-link').getAttribute('href')"), '#calendar');
  assert.match(await evaluate(win, "document.querySelector('#chatExecutionEnvironment').getAttribute('aria-label')"), /执行环境|环境设置/);
  assert.equal((await metrics()).session, base.session);
  assert.equal((await metrics()).draft, base.draft);
  assert.equal(fixture.requests.some(r => r.path === '/api/run' || r.path === '/api/music/control' || /abort|switch$/.test(r.path)), false, 'tool disclosure issues no model, playback, stop or session-switch commands');
  assert.deepEqual(await evaluate(win, 'window.__testErrors'), []);
  console.log(`CHAT_TOOLS_OK ${prefix}: compact layout, top layer, keyboard/outside dismissal, exclusive panels, preserved draft/session; no real backend`);
};
