"use strict";
// Full HTTP/WS + real Dashboard preload and native splash IPC. Only loopback
// fixtures; no real userData, Harbour service, Bot, tools or model calls.
const { app, BrowserWindow, ipcMain } = require("electron");
const { startFixture, waitFor, evaluate } = require("./session-browsing-smoke");
const { StartupSplash } = require("../companion/startup-splash");
const assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = path.resolve(__dirname, "../../assets/reports/harbour-startup");
if (process.argv.includes("--reduced-motion")) app.commandLine.appendSwitch("force-prefers-reduced-motion");
const failures = [];
let currentSplash, currentDashboard;
ipcMain.on("desktop:startup-context",event=>{
  event.returnValue=!!(currentSplash?.active && event.sender===currentDashboard?.webContents && event.senderFrame===event.sender.mainFrame);
});
for (const name of ["cowork-device", "companion-state", "companion-set-appearance", "folia-status", "music-provider-get", "town-status"])
  ipcMain.handle("desktop:" + name, () => null);
function instrument(win) {
  win.webContents.on("preload-error", (_e,_p,error) => failures.push(String(error)));
  return win;
}
async function capture(win, name) {
  fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,name+".png"),(await win.webContents.capturePage()).toPNG());
}
async function runCase(testCase) {
  const fixture = await startFixture(testCase);
  let theatre, reveals = 0, dismissals = 0;
  const dashboard = instrument(new BrowserWindow({ show:false, width:1280, height:860,
    webPreferences: { preload:path.resolve(__dirname,"../preload.js"), nodeIntegration:false, contextIsolation:true,
      offscreen:true, backgroundThrottling:false, additionalArguments:["--harbour-surface=dashboard","--harbour-startup=1","--harbour-pet-enabled=0", "--harbour-url="+encodeURIComponent(fixture.base)] } }));
  dashboard.showInactive = () => { reveals++; };
  dashboard.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url) && !details.url.startsWith(fixture.base)}));
  const splash = new StartupSplash({ BrowserWindow: function(options) {
    theatre = instrument(new BrowserWindow({ ...options, webPreferences:{ ...options.webPreferences,offscreen:true,backgroundThrottling:false } }));
    theatre.showInactive = () => {};
    return theatre;
  }, ipcMain, minSceneMs:0, onDismiss:()=>dismissals++ });
  try {
    currentSplash=splash;currentDashboard=dashboard;
    splash.start(); splash.attachDashboard(dashboard,fixture.base+"/");
    await dashboard.loadFile(path.resolve(__dirname,"../renderer/backend-offline.html"));
    assert.equal(await evaluate(dashboard,"window.harbourDesktop.startup"),false,"offline load cannot consume first launch");
    assert.equal(splash.active,true); assert.equal(reveals,0);
    await dashboard.loadURL(fixture.base+"/#history");
    await waitFor(dashboard,"!!document.querySelector('#chatInput') && state.chat.models.length===2 && state.chat.sessions.length>0 && !routePending","real Main Chat prepared");
    assert.equal(await evaluate(dashboard,"location.hash"),"#chat","cold launch never lands on an old route");
    assert.equal(await evaluate(dashboard,"state.chat.landing && state.chat.sessionId===null && !!document.querySelector('#chatStream .chat-welcome') && !document.querySelector('#chatStream .chat-msg') && state.chat.mode==='main'"),true);
    assert.equal(reveals,0,"HTTP + rendered UI still waits for WS snapshot");
    assert.equal(splash.finishing,undefined);
    await evaluate(dashboard,"refreshSessionList()");
    fixture.emit({__harbour:"channel-activity",phase:"running",runId:"fixture-other-run",agent:"main-elaina",sessionId:"A",sessionKey:"web:default:main-elaina",input:"旧任务继续",startedAt:Date.now(),source:{platform:"web"}});
    await sleep(100);
    assert.equal(await evaluate(dashboard,"state.chat.sessionId===null && state.chat.messages.length===0 && !state.chat.running"),true,"background task cannot occupy the landing");
    assert.equal(fixture.requests.some(r=>r.method!=="GET"),false,"no create/switch/read receipts on opening");
    fixture.disconnect(); await sleep(100);
    testCase.holdSnapshot = false;
    await waitFor(dashboard,"sessionStorage.getItem('harbour-startup-entered')==='1'","genuine snapshot handoff");
    assert.equal(reveals,1);
    if (!process.argv.includes("--reduced-motion")) {
      await sleep(330); await capture(theatre,"handoff-"+testCase.id);
    }
    await splash.finishPromise;
    assert.equal(dismissals,1); assert.equal(splash.active,false);
    const endpoint = await evaluate(dashboard,"(()=>{const r=document.querySelector('.chat-workbench').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()");
    for (const key of ["x","y","width","height"]) assert.ok(Math.abs(splash.state.target[key]-endpoint[key])<1, key+" must land on the final layout");
    assert.match(await evaluate(dashboard,"document.querySelector('#chatStream').textContent"),/今天，想一起做点什么/);
    await capture(dashboard,"landing-"+testCase.id);
    // Existing history is still there and is selected only on explicit action.
    await evaluate(dashboard,"switchChatSession('B')");
    await waitFor(dashboard,"state.chat.sessionId==='B' && !state.chat.landing","explicit history selection");
    assert.match(await evaluate(dashboard,"document.querySelector('#chatStream').textContent"),/B ONLY ANSWER/);
    assert.equal(fixture.requests.filter(r=>r.path==='/api/conversations/new').length,0);
    await dashboard.reload();
    await waitFor(dashboard,"typeof state!=='undefined' && state.chat.sessionId==='B' && !routePending","F5 keeps normal history");
    assert.equal(await evaluate(dashboard,"window.harbourDesktop.startup"),false);
    assert.equal(reveals,1,"reload never replays the animation");
    assert.deepEqual(await evaluate(dashboard,"window.__testErrors"),[]);
    assert.equal(fixture.requests.some(r=>r.path==='/api/run'),false);
    // Sending from an unselected canvas uses the existing lazy-create boundary.
    await evaluate(dashboard,"state.chat.sessionId=null;state.chat.selectedSessionKey='';state.chat.messages=[];state.chat.landing=true;renderChatMessages();document.querySelector('#chatInput').value='fixture first send';void executeChat();");
    await waitFor(dashboard,"state.chat.sessionId==='N' && !!state.chat.activeRunId","explicit first send");
    assert.equal(fixture.requests.filter(r=>r.path==='/api/conversations/new').length,1);
    fixture.finish();
    await waitFor(dashboard,"!state.chat.running","fake response settles");
    assert.equal(fixture.sessions.A.messages.length,2); assert.equal(fixture.sessions.B.messages.length,2);
    console.log("STARTUP_HANDOFF_OK",testCase.id);
  } finally { splash.dispose(); dashboard.destroy(); currentSplash=null;currentDashboard=null;await fixture.close(); }
}
const watchdog=setTimeout(()=>{console.error("startup handoff timeout");app.exit(1);},45000);
app.whenReady().then(async()=>{
  for (const testCase of [{id:"elaina",cat:"anime"},{id:"aemeath",cat:"anime",persona:"aemeath"},{id:"dark",cat:"premium",theme:"premium-tungsten"}])
    await runCase({...testCase,nativePreload:true,holdSnapshot:true});
  assert.deepEqual(failures,[]);
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{clearTimeout(watchdog);app.exit(process.exitCode||0);});
