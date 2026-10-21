// Real pet HTML/CSS/JS and Electron preload, isolated events. No backend, model,
// TTS or user session is invoked; Live2D animation itself is outside this test.
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createServer } = require("node:http");
const { CompanionStateStore } = require("../companion/companion-state");
const { ConversationLink } = require("../companion/conversation-link");
const root = path.resolve(__dirname, "../..");
const webRoot = path.join(root, "web");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "harbour-pet-notification-")));
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.disableHardwareAcceleration();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (win, code) => win.webContents.executeJavaScript(code);
async function waitFor(win, code, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await evaluate(win, code)) return; await sleep(25); }
  throw new Error(`Timed out: ${code}`);
}
async function click(win, selector) {
  const point = await evaluate(win, `(() => { const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
  assert.equal(await evaluate(win, `!!document.elementFromPoint(${point.x},${point.y})?.closest(${JSON.stringify(selector)})`), true, "control must be visible and clickable");
  for (const type of ["mouseMove", "mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, ...point, button: "left", clickCount: 1 });
  await sleep(50);
}

app.whenReady().then(async () => {
  const store = new CompanionStateStore(), links = new ConversationLink();
  const opened = [], dismissed = [], regions = [];
  let win, dashboard;
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/api/asks") { res.setHeader("Content-Type", "application/json"); return res.end('{"asks":[]}'); }
    if (pathname === "/live2d-host.js") {
      res.setHeader("Content-Type", "text/javascript");
      return res.end('window.HarbourLive2D={async createHost(){return {ready:true,setState(){},resize(){},lookAt(){},destroy(){},resetPose(){},setMouthOpen(){}}}}');
    }
    if (pathname === "/dashboard") {
      res.setHeader("Content-Type", "text/html");
      return res.end('<html><body><script>window.opened=[];setTimeout(()=>window.harbourDesktop.onOpenConversation(t=>window.opened.push(t)),150);</script></body></html>');
    }
    const file = path.resolve(webRoot, "." + pathname);
    if (!file.startsWith(webRoot + path.sep)) { res.writeHead(403); return res.end(); }
    try {
      const body = fs.readFileSync(file);
      res.setHeader("Content-Type", { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json" }[path.extname(file)] || "application/octet-stream");
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const preferences = surface => ({ preload: path.join(__dirname, "../preload.js"), offscreen: true, contextIsolation: true, backgroundThrottling: false,
    additionalArguments: [`--harbour-surface=${surface}`, `--harbour-url=${base}`, ...(surface === "pet" ? ["--harbour-pet-id=elaina", "--harbour-pet-agent=main-elaina"] : [])] });
  ipcMain.handle("desktop:companion-character", () => ({ manifest: { displayName: "Elaina", visual: { live2d: { enabled: true, renderedWidth: 150, renderedHeight: 188 } } }, voiceEnabled: false }));
  ipcMain.handle("desktop:companion-state", () => store.snapshot());
  ipcMain.handle("desktop:companion-dismiss-bubble", (_e, pet, id) => { dismissed.push(id); return store.dismissBubble(pet, id); });
  ipcMain.on("desktop:pet-input-regions", (_e, _pet, value) => regions.push(value));
  ipcMain.on("desktop:conversation-ready", e => links.ready(e.sender));
  ipcMain.handle("desktop:open-conversation", async (_e, target) => {
    opened.push(target); links.enqueue(target);
    if (!dashboard) {
      dashboard = new BrowserWindow({ show: false, webPreferences: preferences("dashboard") });
      dashboard.webContents.on("did-finish-load", () => links.flush());
      await dashboard.loadURL(base + "/dashboard");
    }
    links.flush(); return true;
  });
  try {
    win = new BrowserWindow({ show: false, width: 232, height: 332, transparent: true, frame: false, webPreferences: preferences("pet") });
    store.on("change", snapshot => win.webContents.send("desktop:companion-state", snapshot));
    const send = (type, extra = {}) => {
      const event = { __harbour: type, agent: "main-elaina", runId: "reply", ...extra };
      store.consume(event); win.webContents.send("desktop:companion-event", event);
    };
    const reply = extra => send("companion:utterance", { text: "可以，用户。你的问题已经回复，点击这里查看完整对话。这里是用于检查长消息截断的补充文字，不应撑大通知。", sessionId: "cs-qq", createdAt: new Date().toISOString(), source: { platform: "qq" }, ...extra });
    await win.loadURL(base + "/desktop-pet.html");
    await waitFor(win, 'document.getElementById("desktopPet").dataset.live2d === "ready"');
    await sleep(100);
    reply();
    await waitFor(win, '!document.getElementById("petSpeech").hidden');
    send("channel-activity", { phase: "complete" });
    await sleep(250);
    const layout = await evaluate(win, `(() => {const b=petSpeech.getBoundingClientRect(),p=petStage.getBoundingClientRect();return {top:b.top,bottom:b.bottom,stage:p.top,images:petSpeech.querySelectorAll('img').length,dot:getComputedStyle(document.querySelector('.pet-speech-status i')).backgroundColor,lines:getComputedStyle(petSpeechText).webkitLineClamp};})()`);
    assert.ok(layout.top >= 8 && layout.bottom < layout.stage, JSON.stringify(layout));
    assert.equal(layout.images, 0); assert.equal(layout.lines, "3"); assert.equal(layout.dot, "rgb(118, 214, 161)");
    const output = path.join(root, "assets/reports/pet-notification");
    fs.mkdirSync(output, { recursive: true });
    win.webContents.invalidate();
    await evaluate(win, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await sleep(200);
    fs.writeFileSync(path.join(output, "notification.png"), (await win.webContents.capturePage()).toPNG());
    await click(win, "#petSpeechOpen");
    await waitFor(dashboard, 'window.opened?.length === 1');
    assert.deepEqual(opened, [{ sessionId: "cs-qq", agentName: "main-elaina" }]);
    assert.deepEqual(await evaluate(dashboard, "window.opened"), opened, "cold Dashboard must receive the exact link after it is ready");
    const snapshot = store.snapshot();
    await click(win, "#petSpeechDismiss");
    assert.equal(store.snapshot().characters.elaina.bubble, null);
    assert.equal(opened.length, 1, "close must not also navigate");
    assert.equal(dismissed.length, 1);
    win.webContents.send("desktop:companion-state", snapshot);
    send("channel-activity", { phase: "running", task: "发送回执尚未结束" });
    send("channel-activity", { phase: "complete" });
    await sleep(100);
    assert.equal(await evaluate(win, 'petSpeech.hidden && petActivity.hidden'), true, "late snapshots/terminal events must not resurrect the closed card");
    reply({ runId: "next", sessionId: "cs-web", text: "新的一条回复" });
    await waitFor(win, '!petSpeech.hidden');
    send("channel-activity", { runId: "other-task", phase: "running", task: "另一段会话仍在运行" });
    send("log", { msg: "loop:thinking", runId: "other-task" });
    await waitFor(win, 'petSpeech.hidden', 10_000);
    assert.equal(store.snapshot().characters.elaina.bubble, null);
    assert.equal(store.activities.size, 1, "auto-dismiss cannot cancel the other task");
    assert.equal(await evaluate(win, 'petActivity.hidden'), false);
    assert.ok(regions.length > 1, "click-through hit regions update on dismissal");
    // Old shell snapshot: renderer deadline guard, not only the main-process timer.
    win.webContents.send("desktop:companion-state", { characters: { elaina: { bubble: { text: "旧气泡", createdAt: Date.now() - 60_000 } } } });
    await sleep(100);
    assert.equal(await evaluate(win, 'petSpeech.hidden'), true);
    console.log("Pet notification smoke passed: actual pointer close/open, no sticker, independent expiry, concurrent task, cold Dashboard and stale snapshots.");
  } finally {
    store.dispose(); win?.destroy(); dashboard?.destroy();
    await new Promise(resolve => server.close(resolve)); app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
