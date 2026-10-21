"use strict";
// Real renderer/preload/IPC with isolated status fixtures. No live API, playback,
// model, userData, visible window or cursor is used.
const { app, BrowserWindow, Menu, ipcMain, nativeImage } = require("electron");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { OrbController } = require("../companion/orb-controller");
const { OrbSignals } = require("../companion/orb-signals");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-orb-signals-"));
const report = path.resolve(__dirname, "../../assets/reports/harbour-orb");
app.setPath("userData", temp); app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", process.argv.find(value => value.startsWith('--scale='))?.slice(8) || "1"); app.on("window-all-closed", () => {});
const agents = [{ agentName: "main-elaina", displayName: "Elaina" }, { agentName: "main-aemeath", displayName: "Aemeath" }];
const signals = new OrbSignals({ agents: agents.map(a => a.agentName) });
const music = { provider: "folia", connected: true, running: true, loaded: true, paused: false, currentTrackId: "summer",
  tracks: [{ id: "summer", title: "不散的夏之灯", artist: "伴你听歌" }] };
const activity = { __harbour: "channel-activity", agent: "main-elaina", runId: "web-task", phase: "running", sessionId: "main-session", sessionKey: "web:main",
  task: "把旅行资料整理进宝库", source: { platform: "web", locationName: "Main Chat" }, detail: "正在核对工具结果" };
let c, win; const errors = [], opened = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(code, true);
async function until(code) {
  for (let i = 0; i < 100; i++) { if (await js(code)) return; await sleep(20); }
  throw new Error(`Timed out: ${code}\n${await js("JSON.stringify(document.body.dataset)")}`);
}
async function capture(name) {
  await checkHandleHints(name);
  await sleep(320); fs.mkdirSync(report, { recursive: true });
  fs.writeFileSync(path.join(report, `${name}.png`), (await win.webContents.capturePage()).toPNG());
}
async function checkHandleHints(stage) {
  const hints = await js(`['orb','dock'].map(id => {
    const el=document.getElementById(id);
    return {id,title:el.getAttribute('title'),label:el.getAttribute('aria-label'),description:el.getAttribute('aria-description'),
      nestedTitles:el.querySelectorAll('[title]').length};
  })`);
  for (const hint of hints) {
    assert.equal(hint.title, null, `${stage}: ${hint.id} cannot create an OS tooltip that outlives the transparent window`);
    assert.equal(hint.nestedTitles, 0, `${stage}: portraits cannot reintroduce native tooltip text`);
    assert.match(hint.label, /(?:展开|收起).*悬浮助手/, `${stage}: accessible action and status remain`);
    assert.match(hint.description, /悬停预览.*拖动贴边/, `${stage}: instructions remain available to assistive technology`);
  }
}
async function checkBottomClearance(persona) {
  // Real painted pixels, not the atlas's transparent rectangle. Exercise the
  // largest signal group while the head breathes and briefly peeks on hover.
  const windowBounds = win.getBounds();
  await js("document.getAnimations().forEach(a=>a.pause());document.querySelector('.dock-peek').style.transition='none'");
  try {
    for (const hover of [false, true]) for (const fraction of [0, .5]) {
      const layout = await js(`(() => {
        const peek=document.querySelector('.dock-peek'), living=document.querySelector('#dockLiving'), badge=document.querySelector('.dock-indicators');
        const style=getComputedStyle(document.querySelector('#dock')), life=living.getAnimations()[0];
        life.currentTime=life.effect.getTiming().duration*${fraction};
        peek.style.transform=${hover}?'translate('+style.getPropertyValue('--peek-x')+','+style.getPropertyValue('--peek-y')+')':'none';
        const b=badge.getBoundingClientRect();badge.style.visibility='hidden';
        return {bottom:b.bottom,left:b.left,right:b.right,dpr:devicePixelRatio};
      })()`);
      win.webContents.invalidate(); await sleep(35);
      const picture = await win.webContents.capturePage(), { width, height } = picture.getSize(), pixels = picture.toBitmap();
      let firstPaintedRow = height;
      for (let y = 0; y < height && firstPaintedRow === height; y++) for (let x = 0; x < width; x++) {
        if (pixels[(y * width + x) * 4 + 3] > 64) { firstPaintedRow = y; break; }
      }
      await js("document.querySelector('.dock-indicators').style.visibility=''");
      await capture(`signals-${persona}-bottom-${hover ? 'hover' : 'rest'}-${fraction ? 'inhale' : 'exhale'}`);
      assert.ok(firstPaintedRow < height, 'the actual portrait must be painted');
      const clearance = firstPaintedRow / layout.dpr - layout.bottom;
      assert.ok(clearance >= 3, `${persona}/bottom/${hover ? 'hover' : 'rest'}/${fraction}: signals need clear space above the portrait, not on the face (gap=${clearance})`);
      assert.deepEqual(win.getBounds(), windowBounds, 'status placement must not resize the native window or move its hit target');
    }
  } finally {
    await js("document.querySelector('.dock-indicators').style.visibility='';document.querySelector('.dock-peek').style.transform='';document.querySelector('.dock-peek').style.transition='';document.getAnimations().forEach(a=>a.play())");
  }
}
async function click(selector) {
  const point = await js(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  for (const type of ["mouseMove", "mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, ...point, button: "left", clickCount: 1 });
  await sleep(90);
}
async function board() {
  const picture = name => `data:image/png;base64,${fs.readFileSync(path.join(report, `${name}.png`)).toString("base64")}`;
  const states = [["signals-idle", "安静陪伴"], ["signals-work-music", "执行中 · 听歌"], ["signals-waiting", "等你确认"], ["signals-reply", "新回复"], ["signals-failed", "执行异常"]];
  const page = new BrowserWindow({ width: 860, height: 562, show: false, frame: false, webPreferences: { offscreen: true, contextIsolation: true, sandbox: true } });
  try {
    await page.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;background:#faf7f2;color:#51475e;padding:26px 32px;font:12px "Segoe UI","Microsoft YaHei UI",sans-serif}
      header{display:flex;gap:16px;align-items:baseline}h1{font:italic 31px Georgia;margin:0}header span{color:#8f8098}
      .states{display:flex;justify-content:space-between;margin:17px 0 22px}figure{margin:0;text-align:center;width:126px}.states img{width:100px;height:100px;object-fit:contain}figcaption{font-size:11px;color:#8f8098}
      .details{display:flex;gap:24px}aside{width:360px}.docks{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:17px 0}.edge{height:100px;background:#302d3b;border-radius:12px;position:relative;overflow:hidden}
      .edge img{position:absolute}.left img{left:0;top:0;height:108px}.right img{right:0;top:0;height:108px}.top img{top:0;left:calc(50% - 54px);width:108px}.bottom img{bottom:0;left:calc(50% - 54px);width:108px}
      h2{font-size:13px;font-weight:500;margin:0}p{line-height:1.8;color:#948499;font-size:11px}.panel{width:400px;height:298px;object-fit:contain;object-position:top center}
      </style><header><h1>Harbour</h1><span>少一点打扰，多一点默契</span></header><div class="states">${states.map(([name, label]) => `<figure><img src="${picture(name)}"><figcaption>${label}</figcaption></figure>`).join("")}</div>
      <div class="details"><aside><h2>贴边，也能知道她在忙什么</h2><div class="docks">${["left", "right", "top", "bottom"].map(edge => `<div class="edge ${edge}"><img src="${picture(`signals-${edge}`)}"></div>`).join("")}</div><p>细环 · 执行　绿点 · 新回复　音律 · 播放<br>真实界面截图；歌名与任务详情只在展开后显示。</p></aside><img class="panel" src="${picture("signals-panel")}"></div>`)}`);
    await page.webContents.executeJavaScript("Promise.all([...document.images].map(i=>i.decode()))"); await sleep(100);
    fs.writeFileSync(path.join(report, "signals-preview.png"), (await page.webContents.capturePage()).toPNG());
  } finally { page.destroy(); }
}
const watchdog = setTimeout(() => { console.error("orb signals smoke timed out"); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  const screen = Object.assign(new EventEmitter(), {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 900 } }),
    getDisplayNearestPoint: () => screen.getPrimaryDisplay(), getCursorScreenPoint: () => ({ x: -9999, y: -9999 }) });
  c = new OrbController({ BrowserWindow, screen, Menu, dataDir: temp, agents, signals, hidden: true, deviceId: "fixture",
    getConfig: () => ({ url: "http://127.0.0.1:1" }), getAppearance: () => ({ theme: "anime-wisteria", persona: "elaina" }),
    getAvatar: agent => nativeImage.createFromPath(path.resolve(__dirname, "../../web/assets", agent === "main-elaina" ? "elaina-avatar.png" : "orb/aemeath-avatar-v4.png")).resize({ width: 128 }).toDataURL(),
    getPeekAtlas: agent => pathToFileURL(path.resolve(__dirname, "../../web/assets/orb", `${agent.slice(5)}-peek-${agent === "main-elaina" ? "v3" : "v5"}.png`)).href,
    getPeekBlinkAtlas: agent => pathToFileURL(path.resolve(__dirname, "../../web/assets/orb", `${agent.slice(5)}-peek-blink-${agent === "main-elaina" ? "v3" : "v5"}.png`)).href,
    openConversation: async target => opened.push(target), openMusic: async () => opened.push("music"),
    music: { getState: () => music, openFolia: async () => opened.push("folia"), execute: async () => { throw new Error("No playback allowed in status fixture"); } },
    openDashboard() {}, openSettings() {} });
  c.chat.load = async agent => c.chat.snapshot(agent); c.chat.refreshAsks = async () => {};
  c.chat.request = async () => { throw new Error("No backend calls allowed in status fixture"); };
  ipcMain.handle("desktop:orb-action", (event, data) => c.action(event, data));
  await c.start(); win = c.win;
  win.webContents.on("console-message", detail => { if (detail.level === "error") errors.push(detail.message); });
  c.setConnection("open");
  await js("window.fixtureVisible=true; Object.defineProperty(document,'hidden',{get:()=>!window.fixtureVisible}); document.dispatchEvent(new Event('visibilitychange'))");
  await until("document.body.dataset.taskState==='idle'"); await capture("signals-idle");
  c.consume(activity); signals.setMusic(music);
  await until("document.body.dataset.taskState==='working' && document.body.dataset.music==='playing'");
  for (let i = 0; i < 20; i++) c.publish();
  await until(`document.body.dataset.persona==='${c.agent}' && document.querySelector('#orb').getAttribute('aria-label').includes('不散的夏之灯')`);
  await checkHandleHints("repeated status updates");
  assert.equal(await js("getComputedStyle(document.querySelector('.orb-activity')).animationName"), "signal-orbit");
  assert.equal(await js("getComputedStyle(document.querySelector('.orb-music i')).animationName"), "signal-note");
  const bounds = win.getBounds(); await sleep(100);
  assert.deepEqual(win.getBounds(), bounds, "animation never moves the window or hit target");
  assert.equal(c.chat.row(c.agent).sessionId, null, "observing Main Chat never changes the orb conversation");
  await capture("signals-work-music");
  await c.expand(true, true); await until("!document.querySelector('#taskSignal').hidden");
  assert.match(await js("document.querySelector('#taskSignal').title"), /旅行资料/);
  assert.equal(await js("getComputedStyle(document.querySelector('#taskSignal')).borderTopWidth"), "0px");
  assert.equal(await js("getComputedStyle(document.querySelector('#taskSignal')).backgroundColor"), "rgba(0, 0, 0, 0)");
  await click("#musicSignal"); await until("!!document.querySelector('[data-music=title]')");
  assert.deepEqual(opened, [], "opening controls never starts a player");
  await click("#drawerClose"); await click("#taskSignal");
  assert.deepEqual(opened, [{ sessionId: "main-session", agentName: "main-elaina" }]);
  assert.equal(c.chat.row(c.agent).runId, null);
  await capture("signals-panel");
  await c.expand(false, false);
  c.consume({ __harbour: "ask", kind: "new", ask: { id: "confirm-fixture", agent: c.agent, sessionKey: activity.sessionKey, expiresAt: new Date(Date.now() + 60000).toISOString() } });
  await until("document.body.dataset.taskState==='waiting'");
  assert.equal(await js("getComputedStyle(document.querySelector('.orb-activity')).animationName"), "none");
  await capture("signals-waiting");
  c.consume({ ...activity, phase: "complete", replyRevision: 1, readReplyRevision: 0 }); await until("document.body.dataset.signalAlert==='reply'");
  assert.equal(await js("document.querySelector('#unread').hidden"), false); await capture("signals-reply");
  await c.expand(true, true); await click("#taskSignal");
  assert.equal(await js("document.body.dataset.signalAlert"), "reply", "window navigation is not a read receipt");
  c.consume({ __harbour: "session-read", id: activity.sessionId, replyRevision: 1, readReplyRevision: 1 });
  await until("document.body.dataset.signalAlert==='none'"); await c.expand(false, false);
  c.consume({ ...activity, runId: "fail-fixture", phase: "error", detail: "本轮执行失败" });
  await until("document.body.dataset.signalAlert==='failed'"); await capture("signals-failed");
  signals.acknowledge(c.agent, "fail-fixture");
  for (const persona of ['elaina', 'aemeath']) {
    c.agent = `main-${persona}`; c.unreadAgents.add(c.agent); c.publish();
    c.consume({ ...activity, agent: c.agent, runId: `town-task-${persona}`, sessionId: 'town-session', sessionKey: 'web:town', source: { platform: 'web', locationName: '小镇' } });
    for (const [edge, anchor] of [["left", { x: 0, y: 400 }], ["right", { x: 1280, y: 400 }], ["top", { x: 640, y: 0 }], ["bottom", { x: 640, y: 900 }]]) {
      c.dock = edge; c.anchor = anchor; c.reflow();
      await until(`document.body.dataset.docked==='true' && document.body.dataset.edge==='${edge}' && document.body.dataset.persona==='main-${persona}' && document.body.dataset.signalAlert==='reply' && document.querySelector('#dockLiving').dataset.blink==='true' && !document.querySelector('#dockPortrait').hidden && innerWidth===${c.layout.bounds.width}`);
      assert.equal(await js("getComputedStyle(document.querySelector('.dock-ring')).animationName"), "signal-orbit");
      assert.equal(await js("getComputedStyle(document.querySelector('.orb-activity')).animationPlayState"), "paused");
      assert.equal(await js("(() => {const a=document.querySelector('#dock').getBoundingClientRect(),b=document.querySelector('.dock-indicators').getBoundingClientRect();return b.x>=a.x&&b.y>=a.y&&b.right<=a.right&&b.bottom<=a.bottom})()"), true);
      if (edge !== 'bottom') {
        const offsets = await js("(() => {const s=getComputedStyle(document.querySelector('.dock-indicators'));return {left:s.left,right:s.right,bottom:s.bottom}})()");
        assert.equal(offsets.bottom, edge === 'top' ? '2px' : '5px', `${edge} retains its existing vertical placement`);
        assert.equal(edge === 'right' ? offsets.left : offsets.right, edge === 'top' ? '9px' : '4px', `${edge} retains its existing horizontal placement`);
      }
      await capture(persona === 'aemeath' ? `signals-${edge}` : `signals-${persona}-${edge}`);
      if (edge === 'bottom') await checkBottomClearance(persona);
    }
  }
  signals.setMusic({ ...music, paused: true }); await until("document.body.dataset.music==='paused'");
  assert.equal(await js("getComputedStyle(document.querySelector('.dock-indicators .signal-music i')).animationName"), "none");
  c.setConnection("closed"); await until("document.body.dataset.taskState==='unknown' && document.body.dataset.taskBusy==='false'");
  assert.equal(await js("getComputedStyle(document.querySelector('.dock-ring')).display"), "none");
  c.setConnection("open"); signals.setMusic(music);
  await js("window.fixtureVisible=false; document.dispatchEvent(new Event('visibilitychange'))");
  assert.equal(await js("getComputedStyle(document.querySelector('.dock-indicators .signal-music i')).animationName"), "none");
  await js("window.fixtureVisible=true; document.dispatchEvent(new Event('visibilitychange'))");
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  for (const selector of [".dock-ring", ".dock-indicators .signal-music i"]) {
    assert.equal(await js(`getComputedStyle(document.querySelector('${selector}')).animationName`), "none");
  }
  win.webContents.debugger.detach(); signals.setMusic({ ...music, loaded: false });
  await until("document.body.dataset.music==='none'");
  await c.setEnabled(false); await until("document.body.dataset.visualMotion==='false'");
  await checkHandleHints("disabled");
  assert.deepEqual(errors, []); await board();
  console.log(JSON.stringify({ ok: true, statuses: "idle / work + music / waiting / reply / failure / offline", bothPersonas: true,
    dockEdges: 4, bottomPortraitClearance: true, nativeHandleTooltips: false, accessibleStatus: true, IPC: "exact task + existing music panel", reducedMotion: true, backendCalls: 0, modelCalls: 0,
    screenshot: path.join(report, "signals-preview.png") }));
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  clearTimeout(watchdog); c?.dispose();
  if (path.dirname(temp) === os.tmpdir() && path.basename(temp).startsWith("harbour-orb-signals-")) {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* Chromium may still hold its isolated cache. */ }
  }
  app.exit(process.exitCode || 0);
});
