const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Real Dashboard/preload/UI with controlled command acknowledgements; audio is tested separately.
module.exports = async ({ win, js, waitFor, pause, themes, root, commands, setStatus, setCommand, setDevices }) => {
  const tracks = [1,2,3,4,5].map(id => ({ id: String(id), title: `Test ${id}` }));
  const ready = { provider:'folia', connected:true, running:true, loaded:true, paused:false, mode:'background', playbackMode:'one', playbackModeAvailable:true, currentTrackId:'1', tracks };
  assert.equal(await js('document.querySelector("#musicPlaybackMode").disabled'), true);
  setStatus(ready);
  await waitFor('!document.querySelector("#musicPlaybackMode").disabled');
  let resolve, reject;
  setCommand(command => command.action === 'set_playback_mode' ? new Promise((yes, no) => { resolve = yes; reject = no; }) : Promise.resolve(ready));
  await js('document.querySelector("#musicPlaybackMode").click();document.querySelector("#musicPlaybackMode").click()');
  await waitFor('document.querySelector("#musicPlaybackMode").getAttribute("aria-busy")==="true"');
  await pause(100);
  assert.equal(commands.filter(c=>c.action==='set_playback_mode').length, 1, 'double click sends only one non-replayed action');
  assert.deepEqual(commands.at(-1), { action:'set_playback_mode', playbackMode:'shuffle' });
  assert.equal(await js('document.querySelector("#musicPlaybackMode").disabled'), true);
  const changed = { ...ready, playbackMode:'shuffle' };
  setStatus(changed); resolve({ accepted:true, ...changed });
  await waitFor('document.querySelector("#musicNotice").textContent.includes("已切换为随机播放")');
  assert.equal(await js('document.querySelector("#musicPlaybackMode").dataset.mode'), 'shuffle');
  assert.equal(await js('document.querySelectorAll("#musicResults [data-track]").length'), 0, 'mode change never rebuilds queue rows');
  await waitFor('!document.querySelector("#musicPlaybackMode").disabled');
  await js('document.querySelector("#musicPlaybackMode").click()'); await pause(100);
  reject(new Error('fixture command failed'));
  await waitFor('document.querySelector("#musicNotice").textContent.includes("fixture command failed")');
  await pause(2800);
  assert.equal(commands.filter(c=>c.action==='set_playback_mode').length, 2, 'failed command is not retried');
  // While a command is pending, switch the target. Its late result cannot replace this device's UI.
  setDevices([{ id:'music-test', label:'Desktop device' }, { id:'other-device', label:'Other device', music:{ connected:false, playbackModeAvailable:false, tracks:[] } }]);
  await waitFor('!!document.querySelector("#musicDevice option[value=other-device]")');
  await js('document.querySelector("#musicPlaybackMode").click()'); await pause(100);
  await js('(() => {const select=document.querySelector("#musicDevice");select.value="other-device";select.dispatchEvent(new Event("change",{bubbles:true}));})()');
  await waitFor('document.querySelector("#musicDevice").value==="other-device"');
  resolve({ accepted:true, ...changed }); await pause(150);
  assert.equal(await js('document.querySelector("#musicPlaybackMode").disabled'), true);
  assert.equal(await js('document.querySelector("#musicNotice").textContent.includes("已切换为随机播放")'), false);
  assert.equal(await js('document.querySelectorAll("#musicResults [data-track]").length'), 0);
  await js('(() => {const select=document.querySelector("#musicDevice");select.value="music-test";select.dispatchEvent(new Event("change",{bubbles:true}));})()');
  await waitFor('!document.querySelector("#musicPlaybackMode").disabled');
  await js('document.querySelector("#musicControlClose").click()');
  const report = path.join(root,'assets/reports/folia/shuffle'); fs.mkdirSync(report,{recursive:true});
  for (const theme of themes) {
    await js(`applyTheme(...${JSON.stringify(theme)})`);
    for (const width of [520,860,1400]) {
      win.setSize(width,940); await win.webContents.capturePage(); await pause(100);
      const bounds = await js(`(() => {const b=document.querySelector('#musicPlaybackMode'),r=b.getBoundingClientRect(),f=document.querySelector('.music-footer').getBoundingClientRect(); return {width:innerWidth,height:innerHeight,left:r.left,right:r.right,bottom:r.bottom,footerRight:f.right,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===b};})()`);
      assert.ok(bounds.left>=0 && bounds.right<=bounds.width && bounds.footerRight<=bounds.width && bounds.bottom<=bounds.height && bounds.hit, JSON.stringify({theme,width,bounds}));
      if (theme[2]==='anime-wisteria' && [520,1400].includes(width)) fs.writeFileSync(path.join(report,`shuffle-${width}.png`),(await win.webContents.capturePage()).toPNG());
    }
  }
  console.log('FOLIA_PLAYBACK_MODE_UI_OK: 7 themes x 3 widths, disabled/pending/error, duplicate-click guard, stale device response, authoritative mode without queue rewrite');
};
