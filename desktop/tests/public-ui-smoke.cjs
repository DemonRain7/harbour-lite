"use strict";
// Regression of the original renderer, hidden and isolated from the user's desktop profile.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const origin = "http://127.0.0.1:7799";
const report = path.resolve(__dirname, "../../.local/qa-original");
fs.mkdirSync(report, { recursive: true });
app.setPath("userData", path.join(report, "electron-profile"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  let win;
  try {
    const health = await fetch(origin + "/api/health").then(r=>r.json());
    assert.equal(health.mock,true,"Never run this against a live provider");
    const errors=[];
    win = new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    const wc=win.webContents;
    wc.on("console-message",(_event,details)=>{if(details.level==='error')errors.push(details.message)});
    wc.session.webRequest.onBeforeRequest((details,cb)=>cb({cancel:/^https?:/.test(details.url)&&new URL(details.url).origin!==origin}));
    await win.loadURL(origin+"/#chat");
    for(let i=0;i<100;i++) {
      if(await wc.executeJavaScript("!!document.querySelector('#chatInput') && !document.querySelector('#chatInput').disabled"))break;
      await delay(50);
    }
    assert.equal(await wc.executeJavaScript("!!document.querySelector('#chatInput')"),true);
    assert.equal(await wc.executeJavaScript("document.body.dataset.theme"),'anime-wisteria');
    const metrics=await wc.executeJavaScript(`(() => {
      const composer=document.querySelector('#chatInput').closest('.chat-composer') || document.querySelector('#chatInput').parentElement;
      return {brand:document.querySelector('.brand-name').textContent, sheets:[...document.styleSheets].map(s=>s.href), input:document.querySelector('#chatInput').getAttribute('placeholder'), navMore:document.querySelector('#navMore').open, bodyWidth:document.documentElement.scrollWidth, viewport:innerWidth};
    })()`);
    assert.equal(metrics.brand,'Harbour');
    assert.ok(metrics.sheets.some(s=>s.endsWith('/themes.css'))&&metrics.sheets.some(s=>s.endsWith('/chat-composer.css')));
    assert.ok(!metrics.input,"No text placeholder restored by export");
    assert.equal(metrics.navMore,false);
    assert.ok(metrics.bodyWidth<=metrics.viewport+1);
    await delay(450);wc.invalidate();await delay(200);
    fs.writeFileSync(path.join(report,'main-chat-desktop.png'),(await wc.capturePage()).toPNG());
    await wc.executeJavaScript("location.hash='agents'");await delay(650);
    assert.equal(await wc.executeJavaScript("document.body.innerText.includes('main-assistant')"),true);
    wc.invalidate();await delay(150);fs.writeFileSync(path.join(report,'agents-desktop.png'),(await wc.capturePage()).toPNG());
    await wc.executeJavaScript("location.hash='settings'");await delay(650);
    wc.invalidate();await delay(150);fs.writeFileSync(path.join(report,'settings-desktop.png'),(await wc.capturePage()).toPNG());
    await wc.executeJavaScript("location.hash='chat'");await delay(400);
    win.setSize(1100,760);await delay(300);wc.invalidate();await delay(150);
    fs.writeFileSync(path.join(report,'main-chat-compact.png'),(await wc.capturePage()).toPNG());
    assert.equal(await wc.executeJavaScript("document.documentElement.scrollWidth <= innerWidth+1"),true);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({ok:true,renderer:'original',sizes:['1440x1000','1100x760'],errors,metrics}));
    win.destroy();app.exit(0);
  } catch(error) {console.error(error);win?.destroy();app.exit(1)}
});
