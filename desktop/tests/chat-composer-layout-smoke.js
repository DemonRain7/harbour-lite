"use strict";
// Real renderer and loopback-only fixtures, hidden windows, isolated userData.
// No user sessions, backend restart, model calls, uploads or microphone access.
const { app, BrowserWindow } = require("electron");
const { startFixture, waitFor, click, evaluate } = require("./session-browsing-smoke");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const output = path.resolve(__dirname, "../../assets/reports/chat-composer-layout");
const scale = process.argv.find(value => value.startsWith("--scale="))?.slice(8) || "1";
const settle = win => evaluate(win, "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
async function shot(win, name) {
  win.webContents.invalidate(); await settle(win);
  await evaluate(win, "Promise.all(document.getAnimations().filter(a=>Number.isFinite(a.effect.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})))");
  fs.writeFileSync(path.join(output, `${name}-${scale}x.png`), (await win.webContents.capturePage()).toPNG());
}
async function layout(win) {
  return evaluate(win, `(() => {
    const rect = el => { const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
    const toolbar=document.querySelector('.chat-toolbar'),input=document.querySelector('#chatInput');
    const controls=[...toolbar.querySelectorAll('#chatAttach,.hs-trigger,#chatRunPicker > button,#chatInputMode summary,#chatMic,#chatSend,#chatStop')]
      .filter(el=>el.getBoundingClientRect().width && el.getBoundingClientRect().height && getComputedStyle(el).visibility==='visible')
      .map(el=>({id:el.id||el.className,rect:rect(el),label:el.getAttribute('aria-label'),text:el.innerText,disabled:el.disabled}));
    return {controls,input:rect(input),toolbar:rect(toolbar),composer:rect(document.querySelector('.chat-compose')),
      workbench:rect(document.querySelector('.chat-workbench')),placeholder:input.placeholder,inputBackground:getComputedStyle(input).backgroundColor,
      documentWidth:document.documentElement.scrollWidth,viewport:innerWidth,draft:input.value,errors:window.__testErrors};
  })()`);
}
function assertLayout(data, name) {
  assert.equal(data.placeholder, "", `${name}: no input placeholder`);
  assert.equal(data.inputBackground, "rgba(0, 0, 0, 0)", `${name}: one unified input surface`);
  assert.ok(data.composer.left - data.workbench.left >= 11, `${name}: left breathing room`);
  assert.ok(data.workbench.right - data.composer.right >= 11, `${name}: right breathing room`);
  assert.ok(data.documentWidth <= data.viewport + 1, `${name}: no horizontal page overflow`);
  assert.ok(data.toolbar.top >= data.input.bottom, `${name}: every control sits below the writing area`);
  assert.ok(data.input.width >= data.composer.width - 52, `${name}: full-width writing area`);
  for (const control of data.controls) {
    assert.ok(control.label, `${name}: icon ${control.id} has an accessible name`);
    assert.ok(control.rect.left >= data.composer.left && control.rect.right <= data.composer.right + 1,
      `${name}: ${control.id} remains in the composer`);
    assert.ok(control.rect.top >= data.input.bottom && control.rect.bottom <= data.composer.bottom,
      `${name}: ${control.id} stays on the bottom rail`);
  }
  for (let a=0;a<data.controls.length;a++) for (let b=a+1;b<data.controls.length;b++) {
    const one=data.controls[a],two=data.controls[b];
    const overlaps=Math.min(one.rect.right,two.rect.right)-Math.max(one.rect.left,two.rect.left)>1 &&
      Math.min(one.rect.bottom,two.rect.bottom)-Math.max(one.rect.top,two.rect.top)>1;
    assert.equal(overlaps,false,`${name}: ${one.id} / ${two.id} do not overlap`);
  }
  for (const control of data.controls.filter(control=>!control.id.includes("rp-model"))) {
    assert.equal(control.text.trim(),"",`${name}: ${control.id} is icon-only`);
  }
  assert.deepEqual(data.errors, [], `${name}: no renderer errors`);
}
async function runCase(testCase) {
  const fixture=await startFixture({...testCase,web:true});
  const win=new BrowserWindow({show:false,width:testCase.width,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest((details,done)=>done({cancel:/^https?:/.test(details.url)&&!details.url.startsWith(fixture.base)}));
  try {
    await win.loadURL(fixture.base+"/#chat");
    await waitFor(win,"typeof state!=='undefined' && state.chat.sessionId==='A' && !!document.querySelector('#chatInputMode summary') && !routePending","composer mounted");
    await evaluate(win, `(() => {
      state.chat.landing=true;state.chat.sessionId=null;state.chat.selectedSessionKey='';state.chat.messages=[];state.chat.displayedReply=null;
      syncChatSourceMode(null);renderChatMessages();renderSessionList();updateChatContextRing();
      for(const model of state.chat.modelRows) model.modelLabel='DeepSeek V4.1 Flash · Claude SDK';
      syncChatRunPicker();
    })()`);
    await settle(win);
    await waitFor(win,"document.querySelector('.chat-welcome')?.getBoundingClientRect().height>0","visible welcome");
    assertLayout(await layout(win),testCase.id);
    assert.equal(await evaluate(win,"state.chat.sessionId"),null,"welcome does not create or select a session");
    assert.equal(await evaluate(win,"(() => { const welcome=document.querySelector('.chat-welcome');renderChatMessages();return welcome===document.querySelector('.chat-welcome'); })()"),true,"background updates do not replay the welcome animation");
    await shot(win,testCase.id+"-welcome");
    await evaluate(win,"document.querySelector('#chatInput').value='保留我的草稿';applyPersonaVisuals()");
    for (const selector of ['[data-hs-for="chatAgent"] .hs-trigger','[data-hs-for="chatSkill"] .hs-trigger']) {
      await click(win,selector); await settle(win);
      const popup=await evaluate(win,`(() => { const p=openHarbourSelect.menu.getBoundingClientRect();return {left:p.left,right:p.right,top:p.top,bottom:p.bottom,w:innerWidth,h:innerHeight,open:openHarbourSelect.trigger.getAttribute('aria-expanded')}; })()`);
      assert.equal(popup.open,'true'); assert.ok(popup.left>=0&&popup.right<=popup.w+1&&popup.top>=0&&popup.bottom<=popup.h+1,'icon select menu stays onscreen');
      await evaluate(win,"closeHarbourSelect()");
    }
    await click(win,'#chatInputMode summary'); await settle(win);
    assert.equal(await evaluate(win,"document.querySelector('#chatInputModePopover').hidden"),false,'send mode still opens');
    await click(win,'#chatInputMode summary');
    await click(win,'#chatRunPicker .rp-model'); await settle(win);
    assert.equal(await evaluate(win,"chatRunPicker.popup.hidden"),false,'model and effort settings remain available');
    await click(win,'#chatRunPicker .rp-mode'); await settle(win);
    assert.equal(await evaluate(win,"chatRunPicker.view"),'mode','wrapped permission trigger is not obscured by the model popup');
    await evaluate(win,"chatRunPicker.close()");
    await evaluate(win,`state.chat.landing=false;state.chat.sessionId='A';state.chat.messages=[{role:'user',content:'测试消息'},{role:'assistant',content:'测试回复'}];renderChatMessages();updateChatContextRing()`);
    assert.equal(await evaluate(win,"!!document.querySelector('.chat-welcome')"),false,'welcome disappears when messages exist');
    assert.equal((await layout(win)).draft,'保留我的草稿','opening menus/rendering messages preserves the draft');
    await evaluate(win,"state.chat.running=true;syncChatControlLocks();setChatSendMode(true)");
    await settle(win); assertLayout(await layout(win),testCase.id+"-running");
    assert.equal(await evaluate(win,"document.querySelector('[data-hs-for=chatAgent] .hs-trigger').disabled && document.querySelector('[data-hs-for=chatSkill] .hs-trigger').disabled && !document.querySelector('#chatStop').hidden && !!document.querySelector('#chatSend svg')"),true,'locked config, independent send and stop icons');
    await shot(win,testCase.id+"-running");
    await evaluate(win,"state.chat.running=false;syncChatSourceMode({channel:'qq',readOnlyMirror:true,source:{locationLabel:'QQ 私聊'}});setChatSendMode(false)");
    assert.equal(await evaluate(win,"document.querySelector('#chatInput').placeholder==='' && document.querySelector('#chatInput').disabled && !document.querySelector('#chatSourceBanner').hidden && document.querySelector('#chatSend').disabled"),true,'read-only mirror remains explained by its banner, not a placeholder');
    assert.deepEqual(await evaluate(win,"window.__testErrors"),[]);
    assert.equal(fixture.requests.some(request=>request.path==='/api/run'||request.path==='/api/conversations/new'),false,'layout changes never generate or create sessions');
    assert.equal(win.isVisible(),false);
    console.log('CHAT_COMPOSER_LAYOUT_OK',testCase.id,scale);
  } catch(error) { await shot(win,testCase.id+'-failure').catch(()=>{}); throw error; }
  finally { win.destroy();await fixture.close(); }
}
app.whenReady().then(async()=>{
  fs.mkdirSync(output,{recursive:true});
  for(const testCase of [
    {id:'elaina',cat:'anime',width:1440},
    {id:'aemeath',cat:'anime',persona:'aemeath',theme:'anime-snowfleece',width:1080},
    {id:'dark',cat:'premium',theme:'premium-tungsten',width:1440},
    {id:'narrow',cat:'anime',width:390},
  ]) await runCase(testCase);
  app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
