const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow } = require('electron');

// Runs against the real, isolated local-song fixture, not the owner's player.
module.exports = async function checkPlayerPanel(controller, { empty = false, probe } = {}) {
  const player = controller.runtime.getMainWindow().webContents;
  const js = code => probe ? probe.js(player, code) : player.executeJavaScript(code, true);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const errors = [];
  const consoleError = details => { if (details.level === 'error') errors.push(details.message); };
  player.on('console-message', consoleError);
  const wait = async (expression, label) => {
    probe?.progress(label);
    for (let i = 0; i < 80; i++) { if (await js(expression)) return; await pause(50); }
    throw new Error(label + ': ' + JSON.stringify({ errors, body: await js('document.body.innerText'), styles: await js(`(() => {let e=document.querySelector('[data-testid=panel-toggle] button'),a=[];while(e){const s=getComputedStyle(e);a.push({tag:e.tagName,cls:e.className,opacity:s.opacity,display:s.display,visibility:s.visibility});e=e.parentElement;}return a;})()`) }));
  };
  const click = async selector => {
    await wait(`!!document.querySelector(${JSON.stringify(selector)})`, 'button exists ' + selector);
    const hover = await js(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    player.sendInputEvent({ type: 'mouseMove', ...hover });
    // Folia intentionally rests the small-screen toggle at opacity .6. That
    // is visible, unlike an entry/exit animation stuck at zero. Native hit
    // testing below still rejects overlays and offscreen controls.
    await wait(`(() => { let e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;
      while(e){const s=getComputedStyle(e);if(Number(s.opacity)<.5||s.visibility==='hidden'||s.display==='none')return false;e=e.parentElement;}return true;})()`, 'button must be painted ' + selector);
    await pause(250); // Finish geometry transitions before native hit testing.
    const hit = await js(`(() => {
      const e=document.querySelector(${JSON.stringify(selector)}); if(!e)return null;
      const r=e.getBoundingClientRect(), x=Math.round(r.x+r.width/2), y=Math.round(r.y+r.height/2);
      const top=document.elementFromPoint(x,y);
      return {x,y,width:innerWidth,height:innerHeight,reachable:e===top||e.contains(top),top:top?.outerHTML.slice(0,300)};
    })()`);
    assert.ok(hit?.reachable, 'Button blocked/offscreen: ' + selector + ' ' + JSON.stringify(hit));
    player.focus();
    player.sendInputEvent({ type: 'mouseMove', x: hit.x, y: hit.y });
    player.sendInputEvent({ type: 'mouseDown', x: hit.x, y: hit.y, button: 'left', clickCount: 1 });
    player.sendInputEvent({ type: 'mouseUp', x: hit.x, y: hit.y, button: 'left', clickCount: 1 });
  };
  const opened = '!!document.querySelector("[data-testid=unified-panel-surface]")';
  const toggle = '[data-testid="panel-toggle"] button';
  const emptyState = '!!document.querySelector("[data-testid=player-empty-state]")';
  const dashboard = new BrowserWindow({ show: false, width: 1200, height: 850 });
  await dashboard.loadURL('data:text/html,<h1>Panel regression host</h1>');
  // Only show the shell that currently owns Folia. An inactive test host can
  // occlude the player on Windows and suspend its requestAnimationFrame exits.
  controller.runtime.getMainWindow().show();
  controller.runtime.getMainWindow().focus();
  try {
    await js(`[...document.querySelectorAll('button')].find(b => b.innerText.trim() === '我知道了')?.click()`);
    await wait(`![...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='我知道了')`, 'initial guide has exited');
    await wait(`!!document.querySelector(${JSON.stringify(toggle)})`, 'player toggle mounted');
    // Reload restores a saved track asynchronously, after the empty player shell has mounted.
    await wait(empty ? emptyState : `!(${emptyState})`, 'expected song state has loaded');
    assert.equal(await js(emptyState), empty, 'empty state appears only without a current song');
    for (const mode of ['window', 'embedded', 'window', 'embedded']) {
      probe?.progress('reparent player to ' + mode);
      if (mode === 'embedded') { dashboard.show(); dashboard.focus(); }
      else dashboard.hide();
      await controller.open(mode, dashboard, { x: 20, y: 60, width: 940, height: 690 });
      // Reparenting changes the native view size before Chromium has painted the new layout.
      // Wait for presentation before measuring the animated control's hover coordinates.
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      if (await js(opened)) { await click(toggle); await wait('!' + opened, 'initial close'); }
      await click(toggle); await wait(opened, 'open panel ' + mode);
      assert.equal(await js(emptyState), false, 'empty card does not cover controls');
      await click('[data-testid="player-panel-close"]'); await wait('!' + opened, 'header close panel ' + mode);
      await click(toggle); await wait(opened, 'open for floating close ' + mode);
      await click(toggle); await wait('!' + opened, 'close panel ' + mode);
      await click(toggle); await wait(opened, 'reopen panel ' + mode);
      player.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      player.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await wait('!' + opened, 'Escape closes panel ' + mode);
      await click(toggle); await wait(opened, 'open for outside click ' + mode);
      player.sendInputEvent({ type: 'mouseDown', x: 80, y: 160, button: 'left', clickCount: 1 });
      player.sendInputEvent({ type: 'mouseUp', x: 80, y: 160, button: 'left', clickCount: 1 });
      await wait('!' + opened, 'outside click closes panel ' + mode);
      assert.equal(controller.mode, mode, 'panel never detaches the embedded player');
      assert.equal(await js(emptyState), empty);
      console.log('FOLIA_PLAYER_PANEL_OK:', mode, 'header/toggle/Escape/outside-click');
    }
    await click(toggle); await wait(opened, 'panel open during window move');
    await controller.open('window');
    dashboard.hide();
    await click(toggle); await wait('!' + opened, 'close after undock');
    dashboard.show(); dashboard.focus();
    await controller.open('embedded', dashboard, { x: 20, y: 60, width: 500, height: 440 });
    await click(toggle); await wait(opened, 'small panel open');
    await click(toggle); await wait('!' + opened, 'small panel close');
    // The same button also supports a left drag into the command palette.
    const p = await js(`(() => { const r=document.querySelector(${JSON.stringify(toggle)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    player.sendInputEvent({ type: 'mouseDown', ...p, button: 'left', clickCount: 1 });
    player.sendInputEvent({ type: 'mouseMove', x: p.x - 44, y: p.y, button: 'left' });
    player.sendInputEvent({ type: 'mouseUp', x: p.x - 44, y: p.y, button: 'left', clickCount: 1 });
    await wait('!!document.querySelector("[data-testid=command-palette-panel]")', 'drag opens command palette');
    player.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    player.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await wait('!document.querySelector("[data-testid=command-palette-panel]")', 'Escape dismisses command palette');
    await click(toggle); await wait(opened, 'small panel screenshot');
    await pause(500);
    const report = path.resolve(__dirname, '../../assets/reports/folia');
    fs.mkdirSync(report, { recursive: true });
    fs.writeFileSync(path.join(report, 'player-controls-panel.png'), (await player.capturePage()).toPNG());
    await click('[data-testid="player-panel-close"]'); await wait('!' + opened, 'close before return');
    if (empty) {
      await pause(300);
      fs.writeFileSync(path.join(report, 'player-empty-state.png'), (await player.capturePage()).toPNG());
      await click('[data-testid="player-empty-back"]');
      await wait(`!document.querySelector(${JSON.stringify(toggle)}) && !(${emptyState})`, 'return to library without playing a song');
      assert.ok(await js(`[...document.querySelectorAll('button')].some(b => b.innerText.trim() === '本地')`), 'real library navigation returned');
    }
    assert.equal(errors.length, 0, JSON.stringify(errors));
    console.log('FOLIA_PLAYER_PANEL_OK: open-panel reparent, small viewport, no renderer errors');
  } finally {
    player.off('console-message', consoleError);
    controller.hide(dashboard);
    dashboard.destroy();
  }
};
