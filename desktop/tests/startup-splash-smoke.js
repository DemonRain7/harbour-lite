"use strict";
// Actual local renderer, isolated offscreen; no credentials, model or network.
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { StartupSplash } = require("../companion/startup-splash");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-startup-smoke-"));
const scale = process.argv.find(arg => arg.startsWith("--scale="))?.slice(8) || "1";
const reduced = process.argv.includes("--reduced-motion");
const report = path.resolve(__dirname, "../../assets/reports/harbour-startup");
app.setPath("userData", temp); app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", scale);
if (reduced) app.commandLine.appendSwitch("force-prefers-reduced-motion");
app.on("window-all-closed", () => {});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let splash, win; const errors = [], requests = [];
const js = source => win.webContents.executeJavaScript(source, true);
async function until(predicate, label) {
  for (let i = 0; i < 150; i++) { if (await predicate()) return; await sleep(20); }
  throw new Error("Timed out: " + label);
}
function HiddenWindow(options) {
  win = new BrowserWindow({ ...options, webPreferences: { ...options.webPreferences, offscreen: true } });
  win.showInactive = () => {};
  win.webContents.on("preload-error", (_event, _path, error) => errors.push(String(error)));
  win.webContents.on("console-message", (_event, details) => { if (details.level === "error") errors.push(details.message); });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    requests.push(details.url); callback({ cancel: /^https?:/i.test(details.url) });
  });
  return win;
}
async function capture(name) {
  // Allow the offscreen compositor to paint the inspected/paused CSS frame.
  win.webContents.invalidate();
  await sleep(80);
  fs.mkdirSync(report, { recursive: true });
  fs.writeFileSync(path.join(report, name + ".png"), (await win.webContents.capturePage()).toPNG());
}
async function assertLayout() {
  const layout = await js("({ w:innerWidth,h:innerHeight,items:['.wordmark','.portal','.connection','footer','.elaina-visitor','.aemeath-visitor'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return {s,x:r.x,y:r.y,right:r.right,bottom:r.bottom};}) })");
  for (const item of layout.items) assert.ok(item.x>=0 && item.y>=0 && item.right<=layout.w && item.bottom<=layout.h, JSON.stringify(layout));
  assert.ok(layout.items[1].bottom < layout.items[2].y, "status below the card");
}
const watchdog = setTimeout(() => { console.error("startup smoke timeout", JSON.stringify({ presented:splash?.presented, phase:splash?.state.phase, active:splash?.active, finishing:splash?.finishing, sceneComplete:splash?.sceneComplete })); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  splash = new StartupSplash({ BrowserWindow: HiddenWindow, ipcMain,
    // Only this screenshot fixture retains the transparent window a little longer
    // so capture/geometry checks cannot race the native 900ms destruction timer.
    workArea: { x:0,y:0,width:1280,height:800 }, minSceneMs: 0, exitMs: 1600 });
  splash.start();
  await until(() => splash.presented, "first paint");
  await until(() => js("!!window.harbourStartup && document.readyState==='complete'"), "preload");
  await until(() => js("Array.from(document.querySelectorAll('.visitor-art')).every(e=>e.complete && e.naturalWidth===640 && e.naturalHeight===640)"), "bundled character art");
  await sleep(450);
  assert.equal(await js("typeof require"), "undefined");
  assert.deepEqual(await js("Object.keys(window.harbourStartup).sort()"), ["details","onState","skip"]);
  assert.equal(await js("matchMedia('(prefers-reduced-motion: reduce)').matches"), reduced);
  await assertLayout();
  const animationCount = await js("document.getAnimations().length");
  if (reduced) assert.equal(animationCount,0);
  else {
    assert.ok(animationCount >= 12);
    await js("Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))");
    assert.equal(await js("document.getAnimations().every(a=>a.playState!=='running')"),true);
    await js("delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))");
    await js("document.getAnimations().forEach(a=>{a.pause();a.currentTime=2400})");
    assert.equal(await js("Array.from(document.querySelectorAll('.ink')).every(e=>parseFloat(getComputedStyle(e).strokeDashoffset)===0)"),true,"all comic panels finish before the earliest handoff");
    assert.equal(await js("getComputedStyle(document.querySelector('.answer-copy')).opacity"),"1","reply is visible before the earliest handoff");
    for (const selector of [".elaina-visitor .visitor-float", ".aemeath-visitor .visitor-float", ".elaina-visitor .visitor-art", ".aemeath-visitor .visitor-art"]) {
      const differs=await js("(()=>{const e=document.querySelector("+JSON.stringify(selector)+"),a=e.getAnimations()[0],t=a.effect.getTiming();a.currentTime=t.delay;const initial=getComputedStyle(e).transform;a.currentTime=t.delay+t.duration*.5;return initial!==getComputedStyle(e).transform})()");
      assert.equal(differs,true, selector+" has subtle whole-illustration motion");
    }
    await js("document.getAnimations().forEach(a=>a.currentTime=2400)");
  }
  assert.equal(await js("Array.from(document.querySelectorAll('.visitor-art')).every(e=>getComputedStyle(e).objectFit==='contain' && e.draggable===false)"),true);
  assert.equal(await js("document.querySelectorAll('.illustration svg').length"),0,"no old vector faces under the new art");
  const alphas=await js("Array.from(document.querySelectorAll('.visitor-art')).map(e=>{const c=document.createElement('canvas');c.width=c.height=640;const ctx=c.getContext('2d');ctx.drawImage(e,0,0);const d=ctx.getImageData(0,0,640,640).data;let clear=0,edge=0;for(let y=0;y<640;y++)for(let x=0;x<640;x++){const a=d[(y*640+x)*4+3];if(a===0)clear++;if((x<24||y<24||x>=616||y>=616)&&a>2)edge++;}return {clear,edge};})");
  for(const alpha of alphas){assert.ok(alpha.clear>640*640*.15);assert.equal(alpha.edge,0,"hat/hair has transparent safety margin");}
  await capture(reduced ? "daily-reduced" : "daily-preview-"+scale+"x");
  splash.update({phase:"starting"}); await until(()=>js("document.getElementById('connectionText').textContent.includes('服务')"),"phase");
  splash.update({slow:true}); await until(()=>js("!document.getElementById('details').hidden"),"diagnostic action");
  win.setResizable(true); win.setSize(380,420);
  await until(()=>js("innerWidth===380 && innerHeight===420"),"compact");
  await sleep(120); await assertLayout(); await capture("daily-compact-"+scale+"x");
  // Probe the responsive seams too, not only a wide desktop and one tiny case.
  for(const [width,height] of [[700,640],[701,640],[800,800],[900,640],[901,640]]) {
    win.setSize(width,height);
    // Odd DIP widths round by one CSS pixel at 150% native scale on Windows.
    await until(()=>js("Math.abs(innerWidth-"+width+")<=1 && Math.abs(innerHeight-"+height+")<=1"),"responsive seam "+width+"x"+height);
    await sleep(60);
    await assertLayout();
  }
  win.setSize(1280,800); await until(()=>js("innerWidth===1280 && innerHeight===800"),"full");
  win.setResizable(false); await js("document.getAnimations().forEach(a=>a.play())");
  const done=splash.finish({target:{x:284,y:120,width:940,height:630,radius:26}, reducedMotion:reduced});
  if (!reduced) {
    await sleep(400); await capture("daily-morph-"+scale+"x");
    await sleep(370);
    const r=await js("(()=>{const r=document.getElementById('portal').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()");
    assert.ok(Math.abs(r.x-284)<2 && Math.abs(r.width-940)<2 && Math.abs(r.height-630)<2,JSON.stringify(r));
  }
  await done; assert.equal(win.isDestroyed(),true);
  for (const action of ["document.getElementById('skip').click()","window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))"]) {
    splash=new StartupSplash({BrowserWindow:HiddenWindow,ipcMain,minSceneMs:0}); splash.start();
    await until(()=>splash.presented,"skip paint"); await js(action);
    await until(()=>splash.state.quiet,"quiet");
    assert.equal(splash.active,true,"skip never exposes a connecting page");
    await splash.finish({target:{x:30,y:30,width:800,height:650,radius:20}});
    assert.equal(splash.active,false);
  }
  splash=new StartupSplash({BrowserWindow:HiddenWindow,ipcMain,attentionMs:10}); splash.start();
  await until(()=>splash.presented,"details paint");
  await until(()=>js("!document.getElementById('details').hidden"),"details visible");
  await js("document.getElementById('details').click()").catch(e=>{if(!win.isDestroyed())throw e;});
  await until(()=>!splash.active,"diagnostic escape");
  // Optional art failure must not block the ready handshake or expose a broken image.
  splash=new StartupSplash({BrowserWindow:HiddenWindow,ipcMain,minSceneMs:0}); splash.start();
  await until(()=>splash.presented,"asset error paint");
  await js("document.querySelector('.visitor-art').dispatchEvent(new Event('error'))");
  assert.equal(await js("getComputedStyle(document.querySelector('.elaina-visitor')).visibility"),"hidden");
  assert.equal(splash.active,true);
  await splash.finish({target:{x:30,y:30,width:800,height:650,radius:20},reducedMotion:true});
  assert.equal(splash.active,false);
  assert.deepEqual(errors,[]); assert.equal(requests.some(url=>/^https?:/i.test(url)),false);
  console.log(JSON.stringify({ok:true,scale,reducedMotion:reduced,animationCount,report}));
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{clearTimeout(watchdog);splash?.dispose();app.exit(process.exitCode||0);});
