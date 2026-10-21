// Actual Main Chat DOM in hidden/offscreen Electron, with isolated loopback
// HTTP/WS fixtures only. Never starts Harbour, a model, or user desktop tools.
// Run: node desktop/node_modules/electron/cli.js desktop/tests/chat-navigation-smoke.cjs
const { app, BrowserWindow, nativeImage } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("node:http");
const { WebSocketServer } = require("ws");

const root = path.resolve(__dirname, "../..");
const webRoot = path.join(root, "web");
const outputDir = path.join(root, "assets/reports/chat-navigation");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "harbour-chat-navigation-")));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.on("window-all-closed", () => {});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (win, script) => win.webContents.executeJavaScript(script);
const agent = { name: "main-elaina", description: "聊天媒体与滚动导航测试", taskType: "main", permissionMode: "dontAsk", tools: [], skills: [], contextBudget: "auto" };
const model = { modelRef: "mock/fixture", modelName: "fixture", model: "离线测试模型", modelLabel: "离线测试模型", providerLabel: "Fixture", backendKind: "claude-agent", contextWindow: 262144, defaultEffort: "medium", supportedEfforts: ["medium"], effortOptions: [{ effort: "medium" }] };
const sessionKey = "web:default:main-elaina";
const previous = '[data-media-viewer-action="previous"]';
const next = '[data-media-viewer-action="next"]';
const close = '[data-media-viewer-action="close"]';

function makeSession(id) {
  const messages = id === "A" ? Array.from({ length: 34 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `第 ${i + 1} 条 · 浏览历史与媒体导航\n\n${"保留正在阅读的位置，新的回复抵达后仍可随时回到最新消息。".repeat(3)}`,
  })) : [{ role: "assistant", content: "独立会话 B 的唯一图片。", attachments: [{ kind: "image", name: "B-only.png", url: "/uploads/b-only.png" }] }];
  if (id === "A") {
    messages[1].attachments = [{ kind: "image", name: "01-first.png", url: "/uploads/first.png" }];
    messages[15].attachments = [{ kind: "video", name: "02-middle.video.webm", url: "/uploads/middle.video.webm" }];
    // Include markdown media as well as incoming attachment cards in one gallery.
    messages[29].content += "\n\n![03-last.png](/uploads/last.png)";
  } else if (id === "C") {
    messages[0] = { role: "assistant", content: "独立会话 C 的唯一视频，用于原生播放器键盘导航。", attachments: [{ kind: "video", name: "C-only.video.webm", url: "/uploads/middle.video.webm" }] };
  }
  return { id, key: sessionKey, channel: "web", agentName: agent.name, title: id === "A" ? "A · 长会话与三项媒体" : `${id} · 单项媒体`,
    active: id === "A", readOnlyMirror: false, messageCount: messages.length,
    createdAt: "2026-09-17T12:00:00.000Z", updatedAt: "2026-09-17T12:00:00.000Z", lastMessageAt: "2026-09-17T12:00:00.000Z",
    contextTokens: 4320, systemTokens: 2400, bodyTokens: 1920, contextWindow: 262144, compactions: 0,
    modelRef: model.modelRef, reasoningEffort: "medium", permissionMode: "dontAsk", goal: null, checkpoint: null, traces: [], messages,
    source: { app: "web", locationLabel: "Main Chat", accountLabel: "离线测试", actorRole: "owner" } };
}

// All media is synthetic and generated in memory. The video is genuinely
// decodable, so paused/src assertions exercise playback teardown, not a stub.
function png(width, height, rgb) {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4, stripe = (Math.floor(x / 80) + Math.floor(y / 80)) % 2 ? 28 : 0;
    bitmap[offset] = Math.min(255, rgb[2] + stripe);
    bitmap[offset + 1] = Math.min(255, rgb[1] + stripe);
    bitmap[offset + 2] = Math.min(255, rgb[0] + stripe);
    bitmap[offset + 3] = 255;
  }
  return nativeImage.createFromBitmap(bitmap, { width, height }).toPNG();
}

async function makeVideo() {
  const win = new BrowserWindow({ show: false, focusable: false, width: 320, height: 180,
    webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false, contextIsolation: true } });
  try {
    await win.loadURL("about:blank");
    const bytes = await evaluate(win, `(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const ctx = canvas.getContext('2d'); const stream = canvas.captureStream(0); const track = stream.getVideoTracks()[0];
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' }); const chunks = [];
      const done = new Promise((resolve, reject) => { recorder.ondataavailable = e => chunks.push(e.data); recorder.onerror = e => reject(e.error); recorder.onstop = resolve; });
      recorder.start();
      for (let i = 0; i < 12; i++) {
        ctx.fillStyle = i % 2 ? '#657ea8' : '#9380a5'; ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = '#ffffff'; ctx.font = '24px sans-serif'; ctx.fillText('Harbour fixture ' + i, 35, 100); track.requestFrame();
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      recorder.stop(); await done; track.stop();
      return Array.from(new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer()));
    })()`);
    assert.ok(bytes.length > 100, "synthetic video must contain encoded frames");
    assert.equal(win.isVisible(), false);
    return Buffer.from(bytes);
  } finally { win.destroy(); }
}

async function startFixture(testCase, video) {
  const sessions = { A: makeSession("A"), B: makeSession("B"), C: makeSession("C") }, requests = [];
  const media = {
    "/uploads/first.png": { type: "image/png", body: png(640, 360, [89, 123, 168]) },
    "/uploads/last.png": { type: "image/png", body: png(400, 600, [148, 111, 157]) },
    "/uploads/b-only.png": { type: "image/png", body: png(160, 90, [97, 156, 129]) },
    "/uploads/async.png": { type: "image/png", body: png(400, 700, [147, 138, 91]) },
    "/uploads/middle.video.webm": { type: "video/webm", body: video },
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const json = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/api/")) {
      let body = {};
      if (req.method !== "GET") { const chunks = []; for await (const chunk of req) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
      requests.push({ method: req.method, path: url.pathname, body });
      if (url.pathname === "/api/conversations/switch" && req.method === "POST") {
        const session = sessions[body.id];
        if (!session || body.key !== session.key) return json({ error: "wrong fixture session" }, 400);
        Object.values(sessions).forEach(s => { s.active = s.id === session.id; });
        return json({ session });
      }
      if (req.method !== "GET") return json({ error: "No model or unrelated writes allowed in navigation fixture" }, 405);
      if (url.pathname === "/api/agents") return json({ agents: [agent] });
      if (url.pathname === "/api/state") return json({ defaultAgent: agent.name, agents: [agent], backends: { mock: true }, uptimeMs: 90000 });
      if (url.pathname === "/api/skills") return json({ skills: [] });
      if (url.pathname === "/api/agent-defaults") return json({ models: [model], agents: [{ name: agent.name, effectiveModelRef: model.modelRef, effectivePermissionMode: "dontAsk", defaultReasoningEffort: "medium" }] });
      if (url.pathname === "/api/asks") return json({ asks: [] });
      if (url.pathname === "/api/cowork/devices") return json({ devices: [] });
      if (url.pathname === "/api/conversations/explorer") return json({ enabled: true, sessions: Object.values(sessions) });
      const id = url.pathname.match(/^\/api\/conversations\/([ABC])$/)?.[1];
      if (id) return json({ session: sessions[id] });
      return json({ error: `unknown fixture API ${url.pathname}` }, 404);
    }
    if (media[url.pathname]) {
      if (url.pathname === "/uploads/async.png") await sleep(180);
      const item = media[url.pathname]; res.writeHead(200, { "Content-Type": item.type, "Content-Length": item.body.length }); return res.end(item.body);
    }
    let file;
    try { file = path.resolve(webRoot, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)); }
    catch { res.writeHead(400); return res.end(); }
    if (!file.startsWith(webRoot + path.sep)) { res.writeHead(403); return res.end(); }
    try {
      let content = fs.readFileSync(file);
      if (path.basename(file) === "index.html") content = Buffer.from(content.toString().replace("<head>", `<head><script>
        localStorage.setItem('harbour-chat-mode', 'main');
        localStorage.setItem('harbour-theme-cat', ${JSON.stringify(testCase.cat)});
        localStorage.setItem('harbour-theme-persona', ${JSON.stringify(testCase.cat === "anime" ? "elaina" : "neutral")});
        localStorage.setItem('harbour-theme', ${JSON.stringify(testCase.cat === "anime" ? "anime-wisteria" : "premium-champagne")});
        window.__navigationErrors = [];
        window.addEventListener('error', e => { if (e.error) window.__navigationErrors.push(String(e.error.stack || e.message)); });
        window.addEventListener('unhandledrejection', e => window.__navigationErrors.push(String(e.reason)));
        ${testCase.web ? "" : "window.harbourDesktop={isElectron:true,petsEnabled:false};"}
      </script><style>*,*::before,*::after{animation:none!important;transition:none!important;}</style>`));
      res.writeHead(200, { "Content-Type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".svg": "image/svg+xml" }[path.extname(file)] || "application/octet-stream" });
      res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", socket => socket.send(JSON.stringify({ __harbour: "activity-snapshot", activeRunIds: [], serverEpoch: "navigation-fixture" })));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, requests, async close() {
    for (const socket of wss.clients) socket.terminate(); wss.close(); server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  } };
}

async function settle(win) {
  await evaluate(win, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await sleep(40);
}
async function waitFor(win, expression, label) {
  for (let i = 0; i < 160; i++) { if (await evaluate(win, expression)) { await settle(win); return; } await sleep(30); }
  throw new Error(`timeout: ${label}`);
}
async function click(win, selector) {
  await evaluate(win, `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest'})`);
  await settle(win);
  const point = await evaluate(win, `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('missing ${selector.replace(/'/g, "")}');
    const r=el.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
  assert.ok(await evaluate(win, `!!document.elementFromPoint(${point.x},${point.y})?.closest(${JSON.stringify(selector)})`), `click target is visible and unobscured: ${selector} ${JSON.stringify(point)}`);
  win.webContents.sendInputEvent({ type: "mouseMove", ...point });
  win.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
  await settle(win);
}
async function key(win, keyCode) {
  win.webContents.sendInputEvent({ type: "keyDown", keyCode });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode });
  await settle(win);
}
async function snapshot(win) {
  return evaluate(win, `(() => {
    const rect=el=>{const r=el?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}:null};
    const s=document.querySelector('#chatStream'),b=document.querySelector('#chatScrollBottom');
    return {session:state.chat.sessionId,top:s?.scrollTop,height:s?.scrollHeight,viewport:s?.clientHeight,
      distance:s?s.scrollHeight-s.clientHeight-s.scrollTop:null,hidden:b?.hidden,button:rect(b),wrap:rect(document.querySelector('.chat-stream-wrap')),composer:rect(document.querySelector('.chat-compose')),
      counter:document.querySelector('.media-viewer-counter')?.textContent,title:document.querySelector('.media-viewer-title')?.textContent,
      kind:document.querySelector('.media-viewer-stage')?.dataset.mediaKind,previousDisabled:document.querySelector('${previous}')?.disabled,nextDisabled:document.querySelector('${next}')?.disabled,
      errors:window.__navigationErrors.slice()};
  })()`);
}
async function screenshot(win, name) {
  win.webContents.startPainting(); win.webContents.invalidate(); await settle(win);
  const image = await win.webContents.capturePage(undefined, { stayHidden: true });
  assert.equal(image.isEmpty(), false); fs.writeFileSync(path.join(outputDir, name), image.toPNG());
}
function assertPosition(view, label) {
  assert.equal(view.hidden, false, `${label}: bottom arrow visible`);
  assert.ok(Math.abs(view.button.x + view.button.width / 2 - view.wrap.x - view.wrap.width / 2) < 2, `${label}: arrow centered in message column`);
  assert.ok(view.button.bottom <= view.composer.y + 1, `${label}: arrow remains above composer`);
  assert.ok(view.button.width >= 32 && view.button.height >= 32, `${label}: usable pointer target`);
}

async function runCase(testCase, video) {
  const fixture = await startFixture(testCase, video);
  const win = new BrowserWindow({ show: false, focusable: false, width: testCase.width, height: testCase.height, useContentSize: true, frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false, contextIsolation: true, partition: `navigation-${testCase.id}-${process.pid}` } });
  const external = [], report = { testCase, checkpoints: {} };
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(fixture.base + "/") || details.url.startsWith(fixture.base.replace("http:", "ws:") + "/") || /^(?:data:|blob:|about:)/.test(details.url);
    if (!allowed) external.push(details.url); callback({ cancel: !allowed });
  });
  const emulate = height => win.webContents.enableDeviceEmulation({ screenPosition: "desktop", screenSize: { width: testCase.width, height }, viewSize: { width: testCase.width, height }, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 1, scale: 1 });
  try {
    await win.loadURL(fixture.base + "/#chat"); emulate(testCase.height);
    await waitFor(win, "state.chat.sessionId==='A' && !!document.querySelector('#chatScrollBottom')", "Main Chat ready");
    await evaluate(win, "document.fonts.ready");
    await waitFor(win, "Array.from(document.querySelectorAll('#chatStream .att-img')).every(i=>i.complete&&i.naturalWidth)", "attachments loaded");
    await evaluate(win, "document.querySelector('#chatStream').scrollTop=document.querySelector('#chatStream').scrollHeight");
    await waitFor(win, "document.querySelector('#chatScrollBottom').hidden", "at bottom initially hides button");
    report.checkpoints.initial = await snapshot(win);
    await evaluate(win, "document.querySelector('#chatStream').scrollTop=180");
    await waitFor(win, "!document.querySelector('#chatScrollBottom').hidden", "scroll up reveals button");
    assertPosition(await snapshot(win), "scrolled up");
    await evaluate(win, "document.querySelector('#chatScrollBottom').scrollIntoView({block:'nearest'})"); await settle(win);
    await screenshot(win, `${testCase.id}-reading-history.png`);

    // Render the same real update path used for a completed incoming answer.
    const before = await snapshot(win);
    await evaluate(win, `state.chat.messages.push({role:'assistant',content:${JSON.stringify("ASYNC REPLY · 新回复不能拉走正在阅读的历史。\n\n".repeat(60))}});renderChatMessages();`);
    await settle(win);
    const incoming = await snapshot(win);
    assert.ok(Math.abs(incoming.top - before.top) <= 2, "new long answer preserves reading position");
    assert.ok(incoming.height > before.height + 100, "incoming fixture really grows content");
    assertPosition(incoming, "incoming answer"); report.checkpoints.incoming = incoming;

    // An actual delayed image load and stream child resize must be observed
    // without manually dispatching scroll or calling the new button helper.
    await evaluate(win, `(() => {const holder=document.createElement('div');holder.id='navigationAsync';holder.style.minHeight='20px';const img=document.createElement('img');img.style.width='240px';img.src='/uploads/async.png';holder.appendChild(img);document.querySelector('#chatStream').appendChild(holder);})()`);
    await waitFor(win, "document.querySelector('#navigationAsync img').naturalHeight>0", "delayed image decoded");
    assert.ok(Math.abs((await snapshot(win)).top - incoming.top) <= 2, "async image below reader does not force scroll");
    emulate(testCase.height - 120); await settle(win);
    assertPosition(await snapshot(win), "smaller viewport");
    emulate(testCase.height); await settle(win);
    await click(win, "#chatScrollBottom");
    await waitFor(win, "document.querySelector('#chatScrollBottom').hidden && document.querySelector('#chatStream').scrollHeight-document.querySelector('#chatStream').clientHeight-document.querySelector('#chatStream').scrollTop<9", "click reaches newest message");
    report.checkpoints.bottom = await snapshot(win);
    await evaluate(win, `(() => {const image=document.createElement('img');image.id='navigationSecondAsync';image.style.width='240px';image.src='/uploads/async.png?second';document.querySelector('#chatStream').appendChild(image);})()`);
    await waitFor(win, "document.querySelector('#navigationSecondAsync').naturalHeight>0 && !document.querySelector('#chatScrollBottom').hidden", "async growth recomputes hidden button without scroll event");
    await click(win, "#chatScrollBottom");
    await waitFor(win, "document.querySelector('#chatScrollBottom').hidden", "bottom after asynchronous growth");

    await click(win, '#chatStream [data-media-title="01-first.png"]');
    await waitFor(win, "document.querySelector('.media-viewer-counter')?.textContent.trim()==='1 / 3'", "first image opens gallery");
    let view = await snapshot(win); assert.equal(view.kind, "image"); assert.equal(view.previousDisabled, true); assert.equal(view.nextDisabled, false);
    await key(win, "Left"); assert.equal((await snapshot(win)).counter.trim(), "1 / 3", "left boundary never wraps");
    await screenshot(win, `${testCase.id}-image-first.png`);
    await click(win, next);
    await waitFor(win, "document.querySelector('.media-viewer-video')?.readyState>=2", "real video decodes");
    view = await snapshot(win); assert.equal(view.counter.trim(), "2 / 3"); assert.equal(view.kind, "video");
    await evaluate(win, "window.__oldVideo=document.querySelector('.media-viewer-video');window.__oldVideo.loop=true;window.__oldVideo.muted=true;window.__oldVideo.play()");
    await waitFor(win, "!window.__oldVideo.paused && window.__oldVideo.currentTime>0", "video genuinely playing");
    // Native video controls retain their seek keys; global navigation must not hijack them.
    await evaluate(win, "window.__oldVideo.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}))");
    assert.equal((await snapshot(win)).counter.trim(), "2 / 3");
    await screenshot(win, `${testCase.id}-video-middle.png`);
    await click(win, next);
    view = await snapshot(win); assert.equal(view.counter.trim(), "3 / 3"); assert.equal(view.kind, "image"); assert.equal(view.nextDisabled, true);
    assert.equal(await evaluate(win, "window.__oldVideo.paused && !window.__oldVideo.hasAttribute('src') && !window.__oldVideo.isConnected"), true, "switching item stops and releases old video");
    await key(win, "Right"); assert.equal((await snapshot(win)).counter.trim(), "3 / 3", "right boundary never wraps");
    await key(win, "Left"); assert.equal((await snapshot(win)).counter.trim(), "2 / 3", "keyboard previous follows message order");
    await key(win, "Left"); assert.equal((await snapshot(win)).counter.trim(), "1 / 3");
    await key(win, "Escape"); assert.equal(await evaluate(win, "!!document.querySelector('.media-viewer')"), false);
    // Opening a later actual thumbnail starts at its own index.
    await click(win, '#chatStream [data-media-title="03-last.png"]');
    assert.equal((await snapshot(win)).counter.trim(), "3 / 3");
    await click(win, previous); assert.equal((await snapshot(win)).counter.trim(), "2 / 3");
    await click(win, close);
    await click(win, '[data-session-switch="B"]');
    await waitFor(win, "state.chat.sessionId==='B' && !state.chat.switchingSession", "switch to separate session");
    await click(win, '#chatStream [data-media-title="B-only.png"]');
    assert.equal(await evaluate(win, "document.querySelector('[data-media-viewer-action=next]').hidden && document.querySelector('[data-media-viewer-action=previous]').hidden"), true, "single-item new session cannot navigate old gallery");
    await key(win, "Right"); assert.equal((await snapshot(win)).title, "B-only.png");
    await key(win, "Escape");
    if (testCase.width > 760) assert.equal((await snapshot(win)).hidden, true, "short session does not show bottom arrow");
    report.checkpoints.sessionB = await snapshot(win);

    // A native video's multiple internal controls share one document.activeElement
    // host. Real Tab input must enter those controls before the modal end guard
    // receives focus and wraps back to the close button.
    await click(win, '[data-session-switch="C"]');
    await waitFor(win, "state.chat.sessionId==='C' && !state.chat.switchingSession", "switch to singleton video");
    await click(win, '#chatStream [data-media-title="C-only.video.webm"]');
    await waitFor(win, "document.querySelector('.media-viewer-video')?.readyState>=2", "singleton video decoded");
    assert.equal(await evaluate(win, "document.querySelector('[data-media-viewer-action=next]').hidden && document.querySelector('[data-media-viewer-action=previous]').hidden"), true);
    // An offscreen, non-focusable OS window normally suppresses focusin events.
    // Emulate renderer focus only; the hidden BrowserWindow never takes OS focus.
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    await evaluate(win, `(() => {
      const viewer=document.querySelector('.media-viewer');window.__nativeFocusBoundaries=[];
      viewer.addEventListener('focusin',event=>{if(event.target.dataset.mediaFocusBoundary)window.__nativeFocusBoundaries.push(event.target.dataset.mediaFocusBoundary);},true);
      viewer.querySelector('video').focus();
    })()`);
    const focusState = () => evaluate(win, "({tag:document.activeElement?.tagName,action:document.activeElement?.dataset.mediaViewerAction,boundary:document.activeElement?.dataset.mediaFocusBoundary,inViewer:!!document.activeElement?.closest('.media-viewer')})");
    assert.equal((await focusState()).tag, "VIDEO", "native player is genuinely focused before Tab");
    await key(win, "Tab");
    const nativeTab = [await focusState()];
    assert.equal(nativeTab[0].tag, "VIDEO", "first Tab remains in native controls rather than jumping to close");
    for (let i = 0; i < 20 && nativeTab.at(-1).action !== "close"; i++) {
      await key(win, "Tab"); nativeTab.push(await focusState());
      assert.equal(nativeTab.at(-1).inViewer, true, "Tab never leaks to background chat");
    }
    assert.equal(nativeTab.at(-1).action, "close", "after native controls the end sentinel returns focus to modal start");
    const boundaries = await evaluate(win, "window.__nativeFocusBoundaries");
    report.checkpoints.nativeVideoTab = { nativeTab, boundaries };
    assert.ok(boundaries.includes("end"), "real native Tab traversal reaches the end focus sentinel");
    assert.equal(nativeTab.some(step => step.boundary), false, "focusin redirects immediately; sentinel must not wait for another Tab");
    await key(win, "Escape");
    await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: false });
    win.webContents.debugger.detach();

    // Route teardown/remount: detached controls must not drive the new stream.
    await evaluate(win, `(async()=>{window.__oldBottom=document.querySelector('#chatScrollBottom');PANELS.__navigation_smoke={id:'__navigation_smoke',async render(root){root.innerHTML='<p>Navigation teardown fixture</p>';}};history.replaceState(null,'','#__navigation_smoke');await route();history.replaceState(null,'','#chat');await route();})()`);
    await waitFor(win, "!!document.querySelector('#chatScrollBottom')", "chat remounted");
    await evaluate(win, "window.__oldBottom.click()"); await settle(win);
    await click(win, '[data-session-switch="A"]');
    await waitFor(win, "state.chat.sessionId==='A' && !state.chat.switchingSession", "long session restored");
    await evaluate(win, "document.querySelector('#chatStream').scrollTop=180");
    await waitFor(win, "!document.querySelector('#chatScrollBottom').hidden", "new mount observes scroll");
    const remountTop = (await snapshot(win)).top;
    await evaluate(win, "window.__oldBottom.click()"); await settle(win);
    assert.ok(Math.abs((await snapshot(win)).top - remountTop) <= 2, "detached button cannot scroll replacement stream");
    await click(win, "#chatScrollBottom");
    await waitFor(win, "document.querySelector('#chatScrollBottom').hidden", "new mount bottom action works");
    assert.deepEqual(await evaluate(win, "window.__navigationErrors"), [], "no dashboard runtime errors");
    assert.equal(win.isVisible(), false, "never show or focus the user's desktop");
    assert.deepEqual(fixture.requests.filter(r => r.method !== "GET" && r.path !== "/api/conversations/switch"), [], "navigation never calls model or mutating production APIs");
    report.requests = fixture.requests; report.blockedExternalRequests = external;
    fs.writeFileSync(path.join(outputDir, `${testCase.id}.json`), JSON.stringify(report, null, 2));
    console.log(`Chat navigation ${testCase.id}: real thumbnails, gallery boundaries/keyboard/video teardown/native Tab, bottom button, incoming/async resize, session isolation and remount passed (hidden=true)`);
  } catch (error) {
    await screenshot(win, `${testCase.id}-failure.png`).catch(() => {});
    report.error = String(error.stack || error); report.state = await snapshot(win).catch(() => null); report.requests = fixture.requests; report.blockedExternalRequests = external;
    fs.writeFileSync(path.join(outputDir, `${testCase.id}-failure.json`), JSON.stringify(report, null, 2)); throw error;
  } finally { win.destroy(); await fixture.close(); }
}

app.whenReady().then(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const video = await makeVideo();
  const cases = [{ id: "premium-electron", cat: "premium", width: 1440, height: 960 }, { id: "anime-web", cat: "anime", width: 1440, height: 960, web: true }, { id: "anime-narrow", cat: "anime", width: 520, height: 1100, web: true }];
  const only = process.argv.find(arg => arg.startsWith("--case="))?.slice(7);
  assert.ok(!only || cases.some(testCase => testCase.id === only), `unknown --case=${only}`);
  for (const testCase of cases.filter(testCase => !only || testCase.id === only)) await runCase(testCase, video);
  console.log(`Main Chat real-DOM navigation smoke passed. Evidence: ${outputDir}`); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
