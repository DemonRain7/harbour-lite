const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Real shared Dashboard select and Electron hit testing; device responses are fixtures.
module.exports = async ({ win, js, waitFor, pause, themes, root, setDevices }) => {
  const selector = '[data-hs-for="musicDevice"]';
  const click = async suffix => {
    const target = suffix.startsWith('#') ? suffix : selector + ' ' + suffix;
    const point = await js(`(() => { const r=document.querySelector(${JSON.stringify(target)}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    // Hidden test surfaces can defer rAF; a frame flush matches the visible app.
    await win.webContents.capturePage();
    await pause(250);
  };
  const inspect = () => js(`(() => {
    const wrap=document.querySelector('${selector}'), menu=wrap.querySelector('.hs-menu'), r=menu.getBoundingClientRect(), option=menu.querySelector('.hs-option'), name=option?.querySelector('.hs-option-text');
    return { open:wrap.classList.contains('open'), width:r.width, left:r.left, right:r.right, bottom:r.bottom, viewport:innerWidth, height:innerHeight, scroll:menu.scrollHeight-menu.clientHeight, count:menu.querySelectorAll('.hs-option').length,
      name:name?.textContent, nameOverflow:name ? name.scrollWidth-name.clientWidth : 0, description:option?.querySelector('.hs-option-description')?.textContent,
      hit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('.hs-menu')===menu, hitElement:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.outerHTML.slice(0,260) };
  })()`);
  await waitFor(`document.querySelector('${selector} .hs-value')?.textContent === 'Desktop device · 本机'`);
  const reports = path.join(root, 'assets/reports/folia/device-menu');
  fs.mkdirSync(reports, { recursive: true });
  for (const theme of themes) {
    await js(`applyTheme(...${JSON.stringify(theme)})`);
    for (const width of [520, 860, 1400, 1920]) {
      win.setSize(width, 940); await pause(100);
      await click('.hs-trigger');
      await waitFor(`getComputedStyle(document.querySelector('${selector} .hs-menu')).visibility === 'visible' && document.querySelector('${selector} .hs-menu').style.width !== ''`);
      const layout = await inspect();
      assert.ok(layout.open && layout.width >= 270 && layout.left >= 0 && layout.right <= layout.viewport && layout.bottom <= layout.height, JSON.stringify({theme,width,layout}));
      assert.equal(layout.count, 1, 'placeholder must not masquerade as another device');
      assert.equal(layout.scroll, 0, 'one device must not have a pointless scrollbar');
      assert.equal(layout.name, 'Desktop device'); assert.equal(layout.description, '本机 · 在线');
      assert.equal(layout.nameOverflow, 0); assert.ok(layout.hit, JSON.stringify({theme,width,layout}));
      if (width === 1400 && ['anime-wisteria','premium-champagne'].includes(theme[2])) {
        fs.writeFileSync(path.join(reports, `${theme[2]}.png`), (await win.webContents.capturePage()).toPNG());
      }
      await click('.hs-trigger');
    }
  }
  await js(`applyTheme('anime','elaina','anime-wisteria')`);
  win.setSize(1400, 940); await pause(500);
  await click('.hs-trigger');
  await waitFor(`document.querySelector('${selector}').classList.contains('open') && document.querySelector('${selector} .hs-menu').style.visibility === 'visible'`);
  await js(`document.querySelector('${selector} .hs-option').focus(); window.__deviceFocus=document.activeElement; window.__deviceChanges=0; document.querySelector('#musicDevice').addEventListener('change',()=>window.__deviceChanges++);`);
  assert.ok(await js('window.__deviceFocus.matches(".hs-option")'), await js('document.activeElement.outerHTML.slice(0,300)'));
  await pause(2800);
  assert.ok(await js('document.activeElement===window.__deviceFocus'), 'periodic status refresh must retain the focused option');
  await click('.hs-option');
  assert.equal(await js('window.__deviceChanges'), 0, 'selecting the current device is a no-op');

  const longName = '用户 的 MacBook Pro · 客厅音乐工作站 / LongDeviceNameWithoutSpaces0123456789';
  setDevices([{ id:'music-test', label:longName }, ...Array.from({length:10},(_,i)=>({id:`remote-${i}`,label:`远端音乐设备 ${i+1}`}))]);
  await waitFor(`document.querySelector('#musicDevice').options.length===12`);
  await click('.hs-trigger');
  const many = await inspect();
  assert.equal(many.count, 11); assert.equal(many.name, longName); assert.equal(many.nameOverflow, 0); assert.ok(many.scroll>0);
  await js(`document.querySelector('${selector} .hs-option').focus()`);
  assert.ok(await js('document.activeElement.matches(".hs-option")'));
  win.webContents.focus();
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'End'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'End'});
  await pause(80);
  assert.equal(await js('document.activeElement.dataset.hsIndex'), '11', await js('document.activeElement.outerHTML.slice(0,300)'));
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await pause(80);
  assert.equal((await inspect()).open, false);
  assert.ok(await js(`document.activeElement.matches('${selector} .hs-trigger')`));
  await click('.hs-trigger');
  await click('#navToggle');
  assert.equal((await inspect()).open, false, 'outside click closes the list');
  await click('#navToggle');
  setDevices([{ id:'music-test', label:'Desktop device' }]);
  await waitFor(`document.querySelector('#musicDevice').options.length===2`);
  console.log('FOLIA_DEVICE_MENU_OK: 7 themes x 4 widths; names, scroll, polling focus, keyboard, same-device no-op');
};
