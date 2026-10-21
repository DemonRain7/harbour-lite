"use strict";
// Hidden real Electron renderer / preload / IPC. Cursor + monitors are injected;
// no live profile, process, user mouse, backend, model or Bot is touched.
const { app, BrowserWindow, Menu, ipcMain, nativeImage } = require("electron");
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");
const { OrbController } = require("../companion/orb-controller");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-orb-dock-"));
const clippingOnly = process.argv.includes("--clipping-only");
const displayScale = Number(process.argv.find(arg => arg.startsWith("--scale="))?.slice(8) || 1);
assert.ok([1, 1.25, 1.5, 2].includes(displayScale));
app.setPath("userData", dir); app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", String(displayScale)); app.on("window-all-closed", () => {});
const report = path.resolve(__dirname, "../../assets/reports/harbour-orb");
let c, win, now = 0, loads = 0, cursor = { x: -9999, y: -9999 }, area = { x: 0, y: 0, width: 1280, height: 900 };
const sleep = ms => new Promise(r => setTimeout(r, ms)), errors = [];
const js = async code => {
  try { return await win.webContents.executeJavaScript(code, true); }
  catch (error) { throw new Error(`${error.message}\nFixture script: ${code}\n${errors.slice(-4).join("\n")}`); }
};
const tick = (delta = 300) => c.samplePointer(now += delta);
async function until(code) {
  for (let i = 0; i < 100; i++) { if (await js(code)) return; await sleep(20); }
  throw new Error(`Timed out: ${code}\n${await js("JSON.stringify({body:document.body.dataset,html:document.body.innerText})")}\n${errors.join("\n")}`);
}
const center = box => ({ x: c.layout.bounds.x + box.x + box.width / 2, y: c.layout.bounds.y + box.y + box.height / 2 });
const peekFile = persona => `${persona}-peek-${persona === "elaina" ? "v3" : "v5"}.png`;
const blinkFile = persona => `${persona}-peek-blink-${persona === "elaina" ? "v3" : "v5"}.png`;
const { checkLivingPortrait, checkBlinkRegistration } = require("./orb-living-checks");
const { sourceClearance, auditClipping } = require("./orb-clipping-checks");
function leave(delta = 200) { cursor = { x: -9999, y: -9999 }; tick(); tick(delta); }
async function hover() {
  leave(); cursor = center(c.layout.tab || c.layout.ball); tick(); tick();
  await until("!document.querySelector('#panel').hidden"); await sleep(230);
  await until("getComputedStyle(document.querySelector('.dock-peek')).opacity==='0'");
}
async function capture(name) {
  fs.mkdirSync(report, { recursive: true }); await sleep(230);
  win.webContents.invalidate(); await sleep(30);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(report, `${name}.png`), image.toPNG());
  return image;
}
async function checkMotion(persona, edge) {
  await until("document.body.dataset.peekMotion==='true' && document.querySelector('#dockLiving').dataset.blink==='true'");
  const sampled = await js(`(() => {
    const living=document.querySelector('#dockLiving'), open=document.querySelector('#dockPortrait'), closed=document.querySelector('#dockBlink');
    const life=living.getAnimations()[0], blink=closed.getAnimations()[0], clock=document.querySelector('#hairMotionClock');
    if(!life || !blink) throw new Error('missing breathing or blink animation');
    blink.pause(); blink.currentTime=blink.effect.getTiming().delay;
    const box=()=>JSON.stringify(document.querySelector('#dock').getBoundingClientRect().toJSON());
    const before=box(), frames=[]; life.pause();
    for(const fraction of [0,.25,.5,.75,1]) {
      life.currentTime=life.effect.getTiming().duration*fraction;
      const m=new DOMMatrixReadOnly(getComputedStyle(living).transform);
      frames.push({matrix:[m.a,m.b,m.c,m.d,m.e,m.f],eyes:[open,closed].map(e=>getComputedStyle(e).opacity)});
    }
    const eyes=[];
    // Sample inside each interval, not on a floating-point steps() boundary.
    for(const fraction of [0,.95,.965,.975,.985,1]) {
      blink.currentTime=blink.effect.getTiming().delay+blink.effect.getTiming().duration*fraction;
      eyes.push([getComputedStyle(open).opacity,getComputedStyle(closed).opacity]);
    }
    const timing=blink.effect.getTiming(); blink.currentTime=timing.delay;
    return {frames,eyes,firstBlinkMs:timing.duration*.96+timing.delay,closedMs:timing.duration*.02,
      stableHitTarget:before===box(),animation:life.animationName,
      animationCount:living.getAnimations({subtree:true}).length,
      filters:[living,...living.querySelectorAll('*')].map(e=>getComputedStyle(e).filter),
      clockParked:clock.animationsPaused()&&clock.getCurrentTime()===0};
  })()`);
  assert.equal(sampled.animation, "peek-breathe");
  assert.equal(sampled.animationCount, 2, "only whole-image breathing and the eye-only blink run");
  assert.ok(sampled.filters.every(filter => filter === "none"), "no hair displacement filter on hidden portraits");
  assert.equal(sampled.clockParked, true, "docking parks the free-orb hair clock at zero");
  for (const { matrix: [a, b, c, d, e, f], eyes } of sampled.frames) {
    assert.equal(a, d, "breathing preserves image proportions");
    assert.ok(a >= 1 && a <= 1.022, "breathing expands by at most 2.2%");
    assert.deepEqual([b, c, e, f], [0, 0, 0, 0], "no rotation, skew or sway");
    assert.deepEqual(eyes, ["1", "0"], "breathing leaves the face unchanged between blinks");
  }
  assert.deepEqual(sampled.eyes, [["1","0"],["1","0"],["1","1"],["1","1"],["1","0"],["1","0"]]);
  assert.ok(sampled.firstBlinkMs >= 1_000 && sampled.firstBlinkMs <= 1_600, "the first natural blink is visible promptly");
  assert.ok(sampled.closedMs >= 100 && sampled.closedMs <= 130, "closed eyes are brief, not a lingering expression switch");
  assert.notDeepEqual(sampled.frames[0], sampled.frames[2], `${persona}/${edge} breathes visibly`);
  assert.deepEqual(sampled.frames[0], sampled.frames[4], "breathing loops back smoothly");
  assert.equal(sampled.stableHitTarget, true);
  if (edge === "top") {
    const clearance = await js(`(() => {
      const tab=document.querySelector('#dock'), living=document.querySelector('#dockLiving'), life=living.getAnimations()[0];
      const bounds=tab.getBoundingClientRect(), hover=parseFloat(getComputedStyle(tab).getPropertyValue('--peek-y'));
      // Include both animation extremes, the inward hover peek and drop-shadow.
      // The native viewport must leave room for the entire hanging hair.
      const saved=life.currentTime, frames=[];
      for(const fraction of [0,.25,.5,.75,1]) {
        life.currentTime=life.effect.getTiming().duration*fraction;
        for(const id of ['dockPortrait','dockBlink']) {
          const r=document.getElementById(id).getBoundingClientRect();
          frames.push(Math.min(bounds.bottom,innerHeight)-r.bottom-hover-3);
        }
      }
      life.currentTime=saved;
      return Math.min(...frames);
    })()`);
    assert.ok(clearance >= 0, `${persona}: complete hanging hair + hover/breathing/shadow must fit (${clearance.toFixed(2)}px clearance)`);
  }
  await js("document.querySelector('#dockLiving').getAnimations()[0].currentTime=0");
  const exhale = await capture(`dock-${persona}-${edge}-exhale`);
  await js("(() => {const a=document.querySelector('#dockLiving').getAnimations()[0];a.currentTime=a.effect.getTiming().duration*.5})()");
  const inhale = await capture(`dock-${persona}-${edge}-inhale`);
  assert.deepEqual(exhale.getSize(), inhale.getSize(), "the native window must not move or resize to breathe");
  const a = exhale.toBitmap(), b = inhale.toBitmap(); let changed = 0;
  for (let i = 0; i < a.length; i += 4) if ([0, 1, 2, 3].some(k => Math.abs(a[i + k] - b[i + k]) > 5)) changed++;
  assert.ok(changed > 24, `${persona}/${edge}: breathing changes real visible pixels, not only an imperceptible CSS value (${changed})`);
  console.log(JSON.stringify({ breathing: `${persona}/${edge}`, changed, scale: sampled.frames[2].matrix[0] }));
  await checkBlinkRegistration({ win, js, sleep, persona, edge });
  await js("(() => {document.getAnimations().forEach(a=>a.pause());const a=document.querySelector('#dockBlink').getAnimations()[0];a.currentTime=a.effect.getTiming().delay+a.effect.getTiming().duration*.97})()");
  await capture(`dock-${persona}-${edge}-blink`);
  await js("document.querySelector('#dockLiving').getAnimations({subtree:true}).forEach(a=>{a.currentTime=0});document.getAnimations().forEach(a=>a.play())");
}
async function previewBoard() {
  // A contact sheet of actual renderer captures, not replacement UI mockups.
  const edges = ["left", "right", "top", "bottom"], names = ["左侧探头", "右侧探头", "顶部倒挂", "底部探头"];
  const rows = ["elaina", "aemeath"].map(persona => `<section><h2>${persona === "elaina" ? "Elaina · 伊蕾娜" : "Aemeath · 爱弥斯"}</h2><div class="poses">${edges.map((edge, i) => {
    const file = path.join(report, `dock-${persona === "elaina" ? "" : "aemeath-"}${edge}.png`);
    const size = nativeImage.createFromPath(file).getSize();
    return `<article><div class="stage ${edge}"><img style="width:${size.width * 1.5}px;height:${size.height * 1.5}px" src="data:image/png;base64,${fs.readFileSync(file).toString("base64")}"></div><small>${names[i]}</small></article>`;
  }).join("")}</div></section>`).join("");
  const board = new BrowserWindow({ width: 940, height: 626, show: false, frame: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  try {
    await board.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;padding:30px 38px;background:#f7f3ef;color:#51475e;font:14px "Segoe UI","Microsoft YaHei UI",sans-serif}
      header{display:flex;align-items:baseline;gap:16px;margin-bottom:24px}h1{font:italic 33px Georgia;margin:0}header span{color:#968699;font-size:13px}h2{font-size:13px;font-weight:600;margin:0 0 12px;letter-spacing:.04em}
      section+section{margin-top:24px}.poses{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}.stage{position:relative;height:166px;background:#fffcfa;overflow:hidden;border:1px solid #e8e1e9;border-radius:10px}
      section:nth-of-type(2) .stage{background:#302d3b;border-color:#403b4d}.stage img{position:absolute;max-width:none;max-height:none}.left img,.right img{width:72px;height:162px;top:2px}.left img{left:0}.right img{right:0}.top img{width:162px;height:auto;left:calc(50% - 81px);top:0}.bottom img{width:162px;height:90px;left:calc(50% - 81px);bottom:0}
      small{display:block;text-align:center;font-size:11px;color:#958497;margin-top:10px}footer{font-size:11px;color:#968699;margin-top:25px}
      </style><header><h1>Harbour</h1><span>屏幕边缘，留一点陪伴</span></header>${rows}<footer>真实界面截图 · 1.5 倍展示 · 悬停展开，移开收起 · 角色随所选 Main 切换</footer></html>`)}`);
    await board.webContents.executeJavaScript("Promise.all([...document.images].map(i=>i.decode()))");
    await sleep(80);
    fs.writeFileSync(path.join(report, "dock-peek-preview.png"), (await board.webContents.capturePage()).toPNG());
  } finally { board.destroy(); }
}
async function click(selector) {
  const p = await js(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`);
  cursor = { x: c.layout.bounds.x + p.x, y: c.layout.bounds.y + p.y };
  for (const type of ["mouseMove", "mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, ...p, button: "left", clickCount: 1 });
  await sleep(80);
}
async function dock(edge, point) {
  c.cancelRetraction(); c.expanded = c.pinned = false; c.dock = null;
  c.anchor = { x: area.x + area.width / 2, y: area.y + area.height / 2 }; c.reflow();
  cursor = { ...c.anchor }; c.startDrag(); cursor = point; c.moveDrag(); c.endDrag();
  assert.equal(c.dock, edge);
  await until(`document.body.dataset.edge===${JSON.stringify(edge)} && document.body.dataset.docked==='true'`);
  assert.equal(await js("document.querySelector('#orb').hidden && !document.querySelector('#dock').hidden"), true);
  // Chromium receives the native resize asynchronously, independently of IPC.
  await until(`Math.abs(innerWidth-${c.layout.bounds.width})<=1 && Math.abs(innerHeight-${c.layout.bounds.height})<=1`);
  assert.equal(await js("document.documentElement.scrollWidth<=innerWidth && document.documentElement.scrollHeight<=innerHeight"), true);
}
const watchdog = setTimeout(() => { console.error("dock smoke timed out"); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  for (const file of [peekFile("elaina"), peekFile("aemeath"), blinkFile("elaina"), blinkFile("aemeath")]) {
    const asset = nativeImage.createFromPath(path.resolve(__dirname, "../../web/assets/orb", file));
    const pixels = asset.toBitmap(); let transparent = 0, solid = 0;
    for (let i = 3; i < pixels.length; i += 4) { if (pixels[i] === 0) transparent++; if (pixels[i] > 240) solid++; }
    assert.ok(transparent > pixels.length / 4 * .15 && solid > pixels.length / 4 * .25,
      "actual alpha cutout with opaque character pixels, not a painted checkerboard");
  }
  const screen = Object.assign(new EventEmitter(), { getPrimaryDisplay: () => ({ workArea: area }),
    getDisplayNearestPoint: () => ({ workArea: area }), getCursorScreenPoint: () => cursor });
  c = new OrbController({ BrowserWindow, screen, Menu, dataDir: dir, hidden: true, deviceId: "dock-fixture",
    getConfig: () => ({ url: "http://127.0.0.1:1" }), getAppearance: () => ({ theme: "anime-wisteria" }),
    agents: [{ agentName: "main-elaina", displayName: "Elaina" }, { agentName: "main-aemeath", displayName: "Aemeath" }],
    getAvatar: name => nativeImage.createFromPath(path.resolve(__dirname, "../../web/assets", name === "main-elaina" ? "elaina-avatar.png" : "orb/aemeath-avatar-v4.png")).resize({ width: 128 }).toDataURL(),
    getExpressionAtlas: name => pathToFileURL(path.resolve(__dirname, "../../web/assets/orb", `${name.slice(5)}-expressions-${name === "main-aemeath" ? "v4" : "v2"}.png`)).href,
    getPeekAtlas: name => pathToFileURL(path.resolve(__dirname, "../../web/assets/orb", peekFile(name.slice(5)))).href,
    getPeekBlinkAtlas: name => pathToFileURL(path.resolve(__dirname, "../../web/assets/orb", blinkFile(name.slice(5)))).href,
    openConversation() {}, openDashboard() {}, openSettings() {} });
  c.chat.load = async agent => { loads++; return c.chat.snapshot(agent); }; c.chat.refreshAsks = async () => {};
  ipcMain.handle("desktop:orb-action", (event, data) => c.action(event, data));
  await c.start(); win = c.win; c.setConnection("open");
  win.webContents.on("console-message", details => { if (details.level === "error") errors.push(details.message); });
  // Emulate page visibility in the offscreen fixture; never show a test window
  // over the user's desktop. Exercise the real visibilitychange handler below.
  await js("window.fixtureVisible=true; Object.defineProperty(document,'hidden',{get:()=>!window.fixtureVisible}); document.dispatchEvent(new Event('visibilitychange'))");
  if (clippingOnly) {
    const source = [], samples = [], screenshotDir = path.join(report, "clipping-" + displayScale);
    for (const file of [peekFile("elaina"), peekFile("aemeath"), blinkFile("elaina"), blinkFile("aemeath")]) {
      source.push({ file, cells: sourceClearance(nativeImage, path.resolve(__dirname, "../../web/assets/orb", file)) });
    }
    assert.throws(() => sourceClearance(nativeImage, path.resolve(__dirname, "../../web/assets/orb/aemeath-peek-v4.png")),
      /hair touches source cut line/, "regression reproduces the old source-atlas clipping");
    for (const persona of ["elaina", "aemeath"]) {
      c.agent = "main-" + persona; c.publish();
      for (const [edge, point] of [["left", { x: 0, y: 450 }], ["right", { x: 1280, y: 450 }],
        ["top", { x: 640, y: 0 }], ["bottom", { x: 640, y: 900 }]]) {
        await dock(edge, point);
        await until("document.querySelector('#dockLiving').dataset.blink==='true' && document.querySelector('#dockPortrait').dataset.source.includes('" + peekFile(persona) + "')");
        samples.push(await auditClipping({ win, js, sleep, persona, edge, report: screenshotDir, scale: displayScale }));
      }
    }
    fs.writeFileSync(path.join(screenshotDir, "results.json"), JSON.stringify({ source, samples }, null, 2));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, clipping: true, displayScale, sourceCells: source.length * 4,
      samples: samples.reduce((sum, row) => sum + row.samples, 0), minimumClearance: Math.min(...samples.map(row => row.minimumClearance)),
      screenshots: screenshotDir, liveBackendCalls: 0 }));
    return;
  }
  await checkLivingPortrait({ c, win, js, sleep, until, capture, report });
  const row = c.chat.row(c.agent);
  row.messages = [{ role: "assistant", content: "我在这里。需要的时候，把鼠标移过来就好。" }];
  c.publish();
  for (const [edge, point] of [["left", { x: 0, y: 450 }], ["right", { x: 1280, y: 450 }],
    ["top", { x: 640, y: 0 }], ["bottom", { x: 640, y: 900 }]]) {
    await dock(edge, point);
    await until("!document.querySelector('#dockPortrait').hidden && document.querySelector('#dockFallback').hidden");
    assert.equal(await js("getComputedStyle(document.querySelector('#dock')).backgroundColor"), "rgba(0, 0, 0, 0)");
    assert.equal(await js("document.querySelector('#dockPortrait').dataset.frame"), edge);
    assert.equal(await js("getComputedStyle(document.querySelector('#dockPortrait')).transform"), "none", "top hair is drawn upside down, not rotated");
    assert.equal(await js("document.querySelector('#dockBlink').dataset.sourceRect===document.querySelector('#dockPortrait').dataset.sourceRect"), true);
    await checkMotion("elaina", edge);
    if (edge === "left") {
      await js("window.originalLife=document.querySelector('#dockLiving').getAnimations()[0]; window.originalBlink=document.querySelector('#dockBlink').getAnimations()[0]; window.resourcesBefore=performance.getEntriesByType('resource').length");
      for (let i = 0; i < 20; i++) c.publish();
      await sleep(80);
      assert.equal(await js("originalLife===document.querySelector('#dockLiving').getAnimations()[0] && originalBlink===document.querySelector('#dockBlink').getAnimations()[0] && document.querySelector('#dockLiving').getAnimations({subtree:true}).length===2"), true, "trace refresh does not restart breathing or blinking");
      assert.equal(await js("performance.getEntriesByType('resource').length===resourcesBefore"), true, "trace refresh does not reload pictures");
      await js("window.fixtureVisible=false; document.dispatchEvent(new Event('visibilitychange'))");
      assert.equal(await js("document.querySelector('#dockLiving').getAnimations({subtree:true}).length"), 0, "hidden page stops all peek animations");
      assert.equal(await js("getComputedStyle(document.querySelector('#dockPortrait')).opacity"), "1", "never leave eyes closed when stopped");
      assert.equal(await js("document.querySelector('#hairMotionClock').animationsPaused() && document.querySelector('#hairMotionClock').getCurrentTime()===0"), true, "hidden page parks the hair clock");
      await js("window.fixtureVisible=true; document.dispatchEvent(new Event('visibilitychange'))");
    }
    await capture(`dock-${edge}`);
    await hover(); assert.equal(c.pinned, false);
    const savedPosition = { ...c.anchor }; tick(2000); assert.equal(c.expanded, true, "original tab point remains a hover anchor");
    assert.equal(await js("document.querySelector('#dock').getAttribute('aria-expanded')"), "true");
    assert.equal(await js("document.querySelector('#orb').hidden"), false);
    assert.equal(await js("getComputedStyle(document.querySelector('.dock-peek')).opacity"), "0", "no duplicate portrait during preview");
    assert.equal(await js("document.querySelector('#dockLiving').getAnimations({subtree:true}).length"), 0, "expanded view stops peeking animation");
    // Transparency events alone cannot close a native-coordinate preview.
    await js("document.body.dispatchEvent(new PointerEvent('pointerleave'))"); tick(2000);
    assert.equal(c.expanded, true);
    if (edge === "left") await capture("dock-preview-wisteria");
    if (edge === "left") {
      leave(710); assert.equal(c.retracting, true);
      cursor = center(c.layout.tab); tick(20);
      assert.equal(c.expanded, true); assert.equal(c.retracting, false, "quick return reverses automatic retract");
    }
    leave(710); assert.equal(c.expanded, false); assert.equal(c.retracting, true);
    await until("document.body.dataset.docked==='true' && document.querySelector('#panel').hidden");
    assert.deepEqual(c.anchor, savedPosition);
    // Explicit click from a compact tab opens and pins; a click again closes.
    await click("#dock"); await until("document.body.dataset.pinned==='true'");
    leave(2000); assert.equal(c.expanded, true);
    await click("#dock"); await until("document.querySelector('#panel').hidden");
    tick(2000); assert.equal(c.expanded, false, "manual close never immediately reopens under its pointer");
  }
  // All four exact corners leave the OS corner reachable, choose one edge and
  // keep tab, avatar and the entire conversation inside the working area.
  for (const point of [{ x: 0, y: 0 }, { x: 1280, y: 0 }, { x: 0, y: 900 }, { x: 1280, y: 900 }]) {
    await dock(point.x === 0 ? "left" : "right", point); await hover();
    assert.equal(await js("(() => { const r=document.querySelector('#panel').getBoundingClientRect();return r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight })()"), true);
  }
  await dock("left", { x: 0, y: 400 }); await hover();
  // Reading a preview is transient. Interacting or editing fixes it in place.
  await click("#input");
  await js("document.querySelector('#input').value='还没写完的消息'; document.querySelector('#input').dispatchEvent(new Event('input',{bubbles:true}))");
  leave(2000); assert.equal(c.expanded, true); assert.equal(c.pinned, true);
  await click("#collapse"); await until("document.querySelector('#panel').hidden");
  await hover(); assert.equal(await js("document.querySelector('#input').value"), "还没写完的消息");
  // Selecting a file needs no model/backend and must keep the preview open.
  await js("void (document.querySelector('#filePicker').click=()=>{window.pickerOpened=true})");
  await click("#attach"); leave(2000);
  assert.equal(await js("window.pickerOpened"), true); assert.equal(c.expanded, true); assert.equal(c.pinned, true);
  await c.expand(false, false); await until("document.querySelector('#panel').hidden");
  const oldLoads = loads; c.unreadAgents.add("main-aemeath"); c.publish();
  await until("document.body.dataset.unread==='true'");
  assert.equal(loads, oldLoads, "background notification never opens a preview");
  await capture("dock-unread");
  c.agent = "main-aemeath"; c.publish();
  await until("!document.querySelector('#dockPortrait').hidden && document.querySelector('#dockPortrait').dataset.source.includes('aemeath-peek-v5')");
  await capture("dock-snowfleece");
  for (const [edge, point] of [["left", { x: 0, y: 450 }], ["right", { x: 1280, y: 450 }],
    ["top", { x: 640, y: 0 }], ["bottom", { x: 640, y: 900 }]]) {
    await dock(edge, point); await checkMotion("aemeath", edge); await capture(`dock-aemeath-${edge}`);
  }
  // Switching persona changes the actual illustrated asset; a missing optional
  // bundle falls back to that persona's own avatar and the handle still works.
  const active = c.agents.find(a => a.agentName === c.agent), savedAtlas = active.peekAtlas;
  active.peekAtlas = ""; c.publish();
  await until("document.querySelector('#dockPortrait').hidden && !document.querySelector('#dockFallback').hidden");
  assert.equal(await js("document.querySelector('#dockBlink').hidden"), true, "no orphan blink of a missing character");
  assert.ok(await js("document.querySelector('#dockFallback').style.backgroundImage.includes('data:image')"));
  active.peekAtlas = savedAtlas; c.publish();
  await until("!document.querySelector('#dockPortrait').hidden");
  const savedBlink = active.peekBlinkAtlas;
  active.peekBlinkAtlas = ""; c.publish();
  await until("document.querySelector('#dockBlink').hidden");
  assert.equal(await js("document.querySelector('#dockLiving').getAnimations({subtree:true}).length"), 1, "a missing blink frame leaves breathing intact");
  assert.equal(await js("getComputedStyle(document.querySelector('#dockPortrait')).opacity"), "1", "missing blink keeps the open-eye image");
  active.peekBlinkAtlas = savedBlink; c.publish();
  await until("!document.querySelector('#dockBlink').hidden");
  assert.equal(await js("document.querySelector('#dockLiving').getAnimations({subtree:true}).length"), 2, "restoring the frame restores blinking");
  await hover(); await capture("dock-preview-snowfleece");
  // Real Chromium pointer capture: dragging a tab into free space must not hide
  // the captured node early (which used to cancel this kind of gesture).
  await dock("left", { x: 0, y: 400 });
  const p = { x: 14, y: 44 }; cursor = center(c.layout.tab);
  win.webContents.sendInputEvent({ type: "mouseDown", ...p, button: "left", clickCount: 1 }); await sleep(40);
  assert.ok(c.drag);
  assert.equal(await js("document.querySelector('#dockLiving').getAnimations({subtree:true}).length"), 0, "holding the head stops motion before dragging starts");
  assert.equal(await js("document.querySelector('#hairMotionClock').animationsPaused()"), true, "dragging pauses hair too");
  cursor = { x: cursor.x + 170, y: cursor.y + 20 };
  win.webContents.sendInputEvent({ type: "mouseMove", x: 24, y: 50, button: "left" }); await sleep(90);
  assert.ok(c.drag, "drag survives native resize and tab disappearing visually");
  assert.equal(c.dock, null);
  win.webContents.sendInputEvent({ type: "mouseUp", x: 24, y: 50, button: "left", clickCount: 1 }); await sleep(100);
  assert.equal(c.drag, null); assert.equal(c.dock, null); assert.equal(c.expanded, false);
  await until("document.querySelector('#dock').hidden && !document.querySelector('#orb').hidden");
  // Menu/keyboard alternative is accessible and doesn't destroy the session.
  await dock("bottom", { x: 640, y: 900 }); await js("document.querySelector('#dock').focus()");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  await until("!document.querySelector('#panel').hidden && document.body.dataset.pinned==='true'");
  await js("window.harbourOrb.invoke({action:'undock'})"); assert.equal(c.dock, null);
  area = { x: -360, y: -100, width: 360, height: 460 }; screen.emit("display-removed");
  await dock("top", { x: -180, y: -100 }); await hover();
  assert.equal(await js("document.documentElement.scrollWidth<=innerWidth"), true);
  await capture("dock-small-display");
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  assert.equal(await js("getComputedStyle(document.querySelector('#panel')).animationName"), "none");
  assert.equal(await js("getComputedStyle(document.querySelector('.dock-peek')).transitionDuration"), "0s");
  await c.expand(false, false); await until("document.body.dataset.docked==='true'");
  assert.equal(await js("document.querySelector('#dockLiving').getAnimations({subtree:true}).length"), 0, "reduced motion keeps the head static and eyes open");
  assert.equal(await js("getComputedStyle(document.querySelector('#dockPortrait')).opacity"), "1");
  assert.equal(await js("getComputedStyle(document.querySelector('#dockBlink')).opacity"), "0");
  assert.equal(await js("document.querySelector('#hairMotionClock').animationsPaused()"), true, "reduced motion pauses the SVG clock, not just the CSS layer");
  win.webContents.debugger.detach();
  await c.setEnabled(false); await until("document.body.dataset.enabled==='false'");
  assert.equal(await js("document.querySelector('#dockLiving').getAnimations({subtree:true}).length"), 0, "tray hiding cancels animations");
  assert.deepEqual(errors, []);
  await previewBoard();
  console.log(JSON.stringify({ ok: true, edges: 4, corners: 4, hover: "native coordinates", controls: "mouse + keyboard + drag + file picker",
    reducedMotion: true, peekingMotion: "both personas, four directions; gentle breathing + eye-only blinking / no hair warp or sway / visibility / drag / missing assets / no reload; free-orb effects preserved",
    screenshots: report, liveBackendCalls: 0, liveModelCalls: 0 }));
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  clearTimeout(watchdog); c?.dispose();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Electron may still hold its temporary cache. */ }
  app.exit(process.exitCode || 0);
});
