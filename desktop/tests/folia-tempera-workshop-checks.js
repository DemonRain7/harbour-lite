const assert = require('node:assert/strict');
const { BrowserWindow } = require('electron');

// desktop/tests/folia-tempera-workshop-checks.js
// Runs only in the isolated, muted local-song fixture. Uses the built Folia and real host reparenting.
module.exports = async function checkTemperaWorkshop(controller) {
  const musicWindow = controller.runtime.getMainWindow();
  musicWindow.show(); musicWindow.focus();
  const wc = musicWindow.webContents;
  const js = code => wc.executeJavaScript(code, true);
  const wait = async (expression, label) => {
    for (let i = 0; i < 150; i++) {
      if (await js(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Workshop timed out: ' + label + '\n' + await js(`JSON.stringify({
      visibility:document.visibilityState, focus:document.hasFocus(),
      panels:[...document.querySelectorAll('.tempera-workshop-panel,[data-folia-keyboard-window]')].map(e=>({
        opacity:getComputedStyle(e).opacity,display:getComputedStyle(e).display,rect:e.getBoundingClientRect().toJSON()
      })),body:document.body.innerText
    })`));
  };
  const key = (keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    // Native Enter includes a character event; sendInputEvent does not synthesize it for us.
    if (keyCode === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r' });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  const click = async selector => {
    await wait(`(() => {const e=document.querySelector(${JSON.stringify(selector)});return e && !e.disabled;})()`, selector);
    const point = await js(`(() => {
      const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});
      const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
      return {x,y,reachable:e.contains(document.elementFromPoint(x,y))};
    })()`);
    assert.equal(point.reachable, true, 'workshop control must be reachable ' + selector);
    wc.focus();
    wc.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  };
  const opened = '!!document.querySelector(".tempera-workshop-panel")';
  const open = async () => {
    // New releases can show their guide after the fixture has already started playback.
    // Dismiss the actual welcome action, without disabling the production guide or editor.
    await wait('(() => {const welcome=[...document.querySelectorAll("button")].find(b=>b.innerText.trim()==="我知道了"); if(!welcome)return true; welcome.click(); return false;})()', 'welcome dismissed');
    wc.focus();
    key('K', [process.platform === 'darwin' ? 'meta' : 'control']);
    await wait('!!document.querySelector("[data-testid=command-palette-panel] input")', 'palette');
    await js('document.querySelector("[data-testid=command-palette-panel] input").focus()');
    await wc.insertText('凝彩素材工坊');
    await wait('[...document.querySelectorAll("[data-testid=command-palette-panel] button")].some(b=>b.innerText.includes("凝彩素材工坊"))', 'workshop command');
    await js('[...document.querySelectorAll("[data-testid=command-palette-panel] button")].find(b=>b.innerText.includes("凝彩素材工坊")).click()');
    await wait(opened + ' && getComputedStyle(document.querySelector(".tempera-workshop-panel")).opacity === "1"', 'editor painted');
  };
  const before = await controller.command({ action: 'queue' });
  const originalMode = await js('localStorage.getItem("visualizer_mode")');
  const dashboard = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { backgroundThrottling: false } });
  await dashboard.loadURL('data:text/html,<h1>Isolated workshop host</h1>');
  // The reparented editor must actually be visible to receive compositor frames,
  // including Windows occlusion tracking; use its real content-area dimensions.
  try {
    await wait('document.visibilityState === "visible"', 'foreground music window');
    await open();
    await js(`(() => {
      const files=new DataTransfer();
      files.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="240" height="300"><rect x="20" y="20" width="200" height="260" rx="80" fill="#ad99e8"/></svg>'],'Workshop fixture.svg',{type:'image/svg+xml'}));
      const input=document.querySelector('.tempera-workshop-panel input[multiple]');input.files=files.files;
      input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await wait('!!document.querySelector("[data-testid=tempera-preview-image]")', 'uploaded preview');
    const [hostWidth, hostHeight] = dashboard.getContentSize();
    dashboard.show(); dashboard.focus();
    await controller.open('embedded', dashboard, { x: 20, y: 65, width: hostWidth - 40, height: hostHeight - 90 });
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(controller.runtime.getMainWindow().webContents, wc);
    await click('.tempera-workshop-grid button[aria-label="顶部 · 偏左"]');
    await click('.tempera-workshop-panel button[aria-label="移除图片"]');
    // Undo this whole draft with the visible Cancel action; no settings or media mutation.
    await js('[...document.querySelectorAll(".tempera-workshop-panel button")].find(b=>b.innerText==="取消编辑").click()');
    await wait('!(' + opened + ')', 'cancel');
    await open();
    await wait('[...document.querySelectorAll(".tempera-workshop-panel input")].some(e=>e.type==="range")', 'frequency');
    await js('document.querySelector(".tempera-workshop-panel input[type=range]").focus()');
    key('Home');
    await js('[...document.querySelectorAll(".tempera-workshop-panel button")].find(b=>b.innerText==="保存并应用").focus()');
    key('Enter');
    await wait('!(' + opened + ')', 'keyboard save');
    assert.equal(await js('JSON.parse(localStorage.getItem("tempera_tuning")).layerImageFrequency'), 0);
    assert.equal(await js('localStorage.getItem("visualizer_mode")'), originalMode);
    const after = await controller.command({ action: 'queue' });
    assert.equal(after.currentTrackId, before.currentTrackId);
    assert.equal(after.paused, false);
    assert.ok(after.positionMs > before.positionMs, 'real media time advances during editing');
    for (const event of ['pause', 'emptied', 'error']) assert.equal(after.audioHealth.media.events[event] || 0, before.audioHealth.media.events[event] || 0);
    console.log('FOLIA_TEMPERA_WORKSHOP_OK: built editor, upload, placement, cancel/save, native reparenting, uninterrupted real audio');
  } finally {
    await controller.open('window');
    dashboard.destroy();
  }
};
