const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Exercise the real Dashboard select; no searches or account/playback changes.
module.exports = async ({ win, js, waitFor, pause, themes, root, folia, commands }) => {
  const selector = '[data-hs-for="musicSource"]';
  const reports = path.join(root, 'assets/reports/folia/source-menu');
  fs.mkdirSync(reports, { recursive: true });
  const click = async suffix => {
    const target = suffix.startsWith('#') ? suffix : `${selector} ${suffix}`;
    const point = await js(`(() => { const r=document.querySelector(${JSON.stringify(target)}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
    const zoom = win.webContents.getZoomFactor();
    const position = { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) };
    win.webContents.sendInputEvent({ type:'mouseDown', ...position, button:'left', clickCount:1 });
    win.webContents.sendInputEvent({ type:'mouseUp', ...position, button:'left', clickCount:1 });
    await win.webContents.capturePage(); await pause(100);
  };
  const key = async keyCode => {
    win.webContents.sendInputEvent({type:'keyDown', keyCode});
    win.webContents.sendInputEvent({type:'keyUp', keyCode});
    await win.webContents.capturePage(); await pause(100);
  };
  const inspect = () => js(`(() => {
    const wrap=document.querySelector('${selector}'), menu=wrap.querySelector('.hs-menu');
    const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    return { open:wrap.classList.contains('open'), menu:rect(menu), drawer:rect(document.querySelector('#musicRemote')), stage:rect(document.querySelector('#musicStage')), viewport:{width:innerWidth,height:innerHeight},
      triggerOverflow:wrap.querySelector('.hs-value').scrollWidth-wrap.querySelector('.hs-value').clientWidth,
      scrollX:menu.scrollWidth-menu.clientWidth, scrollY:menu.scrollHeight-menu.clientHeight,
      options:[...menu.querySelectorAll('.hs-option')].map(option=>{const name=option.querySelector('.hs-option-text'), r=option.getBoundingClientRect();return {text:name.textContent,overflow:name.scrollWidth-name.clientWidth,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('.hs-option')===option};}) };
  })()`);
  const open = async () => {
    await click('.hs-trigger');
    await waitFor(`document.querySelector('${selector}').classList.contains('open') && document.querySelector('${selector} .hs-menu').style.visibility==='visible'`);
  };
  await click('#musicControlToggle');
  await waitFor(`!document.querySelector('#musicRemote').hidden`);
  await js(`document.querySelector('#musicQuery').value='保留搜索草稿'; window.__sourceChanges=0; document.querySelector('#musicSource').addEventListener('change',()=>window.__sourceChanges++);`);
  const commandCount = commands.length;
  const playerId = folia.runtime.getMainWindow().webContents.id;
  const layouts = [];
  for (const theme of themes) {
    await js(`applyTheme(...${JSON.stringify(theme)})`);
    for (const [width, height, zoom] of [[520,740,1], [860,940,1], [1400,940,1], [1920,1080,1.25]]) {
      win.setSize(width, height); win.webContents.setZoomFactor(zoom);
      await win.webContents.capturePage(); await pause(150);
      await open();
      const layout = await inspect();
      layouts.push({theme:theme[2],width,height,zoom,...layout});
      const detail = JSON.stringify(layouts.at(-1));
      assert.ok(layout.menu.width >= 224, detail);
      assert.equal(layout.triggerOverflow, 0, detail);
      assert.equal(layout.scrollX, 0, detail);
      assert.ok(layout.menu.left >= layout.drawer.left && layout.menu.right <= layout.drawer.right && layout.menu.top >= layout.drawer.top && layout.menu.bottom <= layout.drawer.bottom, detail);
      assert.ok(layout.menu.right <= layout.viewport.width && layout.menu.bottom <= layout.viewport.height, detail);
      assert.deepEqual(layout.options.map(option=>option.text), ['QQ 音乐','网易云','酷狗','本地曲库']);
      assert.ok(layout.options.every(option=>option.overflow===0), detail);
      if (width >= 1400) {
        assert.equal(layout.scrollY, 0, detail);
        assert.ok(layout.options.every(option=>option.hit), detail);
      }
      // The menu must remain in the drawer, outside the native Folia surface.
      const native = folia.dock.bounds;
      assert.ok(layout.menu.left*zoom >= native.x+native.width-1 || layout.menu.top*zoom >= native.y+native.height-1, detail);
      assert.equal(folia.dock.view.getVisible(), true);
      assert.equal(folia.runtime.getMainWindow().webContents.id, playerId);
      if ((width === 1400 || width === 520) && ['anime-wisteria','premium-champagne'].includes(theme[2])) {
        fs.writeFileSync(path.join(reports, `${theme[2]}-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
      if (layout.scrollY > 0) {
        await js(`(() => {const menu=document.querySelector('${selector} .hs-menu'); menu.scrollTop=menu.scrollHeight;})()`);
        await win.webContents.capturePage(); await pause(50);
        assert.equal((await inspect()).options.at(-1).hit, true, 'short panes must allow scrolling to the full final option');
      }
      await click('.hs-trigger');
    }
  }
  win.webContents.setZoomFactor(1); win.setSize(1400,940);
  await js(`applyTheme('anime','elaina','anime-wisteria')`); await pause(150);
  for (const [index, value] of ['qq','netease','kugou','local'].entries()) {
    await open(); await click(`.hs-option[data-hs-index="${index}"]`);
    assert.equal(await js(`document.querySelector('#musicSource').value`), value);
    assert.equal((await inspect()).open, false);
  }
  assert.equal(await js('window.__sourceChanges'), 3, 'same-value selection is a no-op');
  await js(`document.querySelector('${selector} .hs-trigger').focus()`);
  win.webContents.focus();
  await key('Down');
  await key('Home'); await key('Enter');
  assert.equal(await js(`document.querySelector('#musicSource').value`), 'qq');
  await key('Down'); await key('End'); await key('Escape');
  assert.equal(await js(`document.querySelector('#musicRemote').hidden`), false, 'Escape closes only the active menu, not its containing drawer');
  assert.equal((await inspect()).open, false);
  assert.ok(await js(`document.activeElement.matches('${selector} .hs-trigger')`));
  await open(); await click('#musicQuery');
  assert.equal((await inspect()).open, false, 'outside click closes the menu');
  assert.equal(await js(`document.querySelector('#musicQuery').value`), '保留搜索草稿');
  assert.equal(commands.length, commandCount, 'source selection must not search, enqueue or alter playback');
  fs.writeFileSync(path.join(reports, 'layouts.json'), JSON.stringify(layouts, null, 2));
  await js(`document.querySelector('${selector} .hs-trigger').focus()`);
  await key('Escape');
  assert.equal(await js(`document.querySelector('#musicRemote').hidden`), true, 'a closed selector must not consume Escape meant for its drawer');
  console.log('FOLIA_SOURCE_MENU_OK: 7 themes x 4 viewport/zoom cases; full names, clipping, native view, all sources, keyboard and no playback commands');
};
