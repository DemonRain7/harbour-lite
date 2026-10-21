// Actual Harbour dashboard in hidden Electron; loopback fixture APIs only.
// No production state, model/tool calls, visible windows, Chrome, or schedule mutations.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createServer } = require("node:http");
const { WebSocketServer } = require("ws");

const root = path.resolve(__dirname, "../..");
const webRoot = path.join(root, "web");
const outputDir = path.join(root, "assets/reports/time-zone");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "harbour-time-zone-ui-")));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.on("window-all-closed", () => {});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (win, script) => win.webContents.executeJavaScript(script);
const at = "2026-07-01T12:34:56.789Z";
const epoch = Date.parse(at);
const key = "web:default:main-elaina";
const agent = { name: "main-elaina", description: "隔离时区验收角色", taskType: "main", permissionMode: "dontAsk", tools: [], skills: [], contextBudget: "auto" };
const model = { modelRef: "mock/timezone-fixture", model: "测试模型", modelName: "fixture", modelLabel: "测试模型",
  providerLabel: "Fixture", backendKind: "claude-agent", contextWindow: 1000000, supportedEfforts: ["medium"] };
const options = [
  { value: "America/New_York", label: "美东时间 · 纽约（自动 EST / EDT）" },
  { value: "Asia/Shanghai", label: "中国时间 · 北京 / 上海（UTC+08:00）" },
  { value: "Etc/GMT+5", label: "固定 EST · UTC−05:00（无夏令时）" },
];
const draft = "这是一段尚未发送的输入草稿。切换时区必须逐字保留。\nNever call a model in this smoke.";
const session = { id: "timezone-session", key, channel: "web", agentName: agent.name, active: true,
  title: "时区同步 · 固定历史记录", messageCount: 2, createdAt: at, lastMessageAt: at, compactions: 0,
  permissionMode: "dontAsk", reasoningEffort: "medium", checkpoint: null, goal: null, contextTokens: 200,
  source: { app: "web", locationLabel: "Main Chat", actorRole: "owner" },
  messages: [{ role: "user", content: "只检查时间显示，不执行任何任务。" },
    { role: "assistant", content: "固定历史内容：时区改变时，这段文字与原始 instant 保持不变。" }],
  times: [at, at], durations: [null, 4200], traces: [[], [
    { msg: "loop:start", agent: agent.name, modelRef: model.modelRef, tools: [], time: epoch },
    { msg: "loop:final", agent: agent.name, answerPreview: "STORED_TRACE_FIXTURE", t: at },
  ]] };

async function startFixture(testCase) {
  const requests = [];
  let legacyBackend = !!testCase.legacyBackend;
  let time = { timeZone: "America/New_York", revision: 1, updatedAt: at, options,
    now: at, formattedNow: "fixture time", schedulePolicy: "fixed-existing", legacyScheduleTimeZone: "UTC" };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (value, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/api/")) {
      let body = {};
      if (req.method !== "GET") { const chunks = []; for await (const chunk of req) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
      requests.push({ method: req.method, path: url.pathname, body });
      if (url.pathname === "/api/time-settings") {
        if (legacyBackend) return json({ error: "未知接口: GET /api/time-settings" }, 404);
        if (req.method === "PUT") {
          if (!options.some((option) => option.value === body.timeZone)) return json({ error: "invalid fixture zone" }, 400);
          time = { ...time, timeZone: body.timeZone, revision: time.revision + 1 };
          emit({ type: "time-settings:changed", payload: time });
        }
        return json(time);
      }
      if (req.method !== "GET") return json({ error: `forbidden fixture mutation: ${url.pathname}` }, 405);
      if (url.pathname === "/api/state") return json({ defaultAgent: agent.name, agents: [agent], backends: { mock: true }, uptimeMs: 90000 });
      if (url.pathname === "/api/agents") return json({ agents: [agent] });
      if (url.pathname === "/api/agent-defaults") return json({ models: [model], agents: [{ name: agent.name, effectiveModelRef: model.modelRef, effectivePermissionMode: "dontAsk" }] });
      if (url.pathname === "/api/asks") return json({ asks: [] });
      if (url.pathname === "/api/skills") return json({ skills: [] });
      if (url.pathname === "/api/cowork/devices") return json({ devices: [] });
      if (url.pathname === "/api/conversations/explorer") return json({ enabled: true, sessions: [session] });
      if (url.pathname === "/api/conversations/timezone-session") return json({ session });
      return json({ error: `unknown fixture endpoint: ${url.pathname}` }, 404);
    }
    const file = path.resolve(webRoot, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(webRoot + path.sep)) { res.writeHead(403); return res.end(); }
    try {
      let content = fs.readFileSync(file);
      if (path.basename(file) === "index.html") content = Buffer.from(content.toString().replace("<head>", `<head><script>
        localStorage.clear(); localStorage.setItem('harbour-chat-mode','main');
        localStorage.setItem('harbour-theme-cat',${JSON.stringify(testCase.cat)});
        localStorage.setItem('harbour-theme-persona',${JSON.stringify(testCase.cat === "anime" ? "elaina" : "neutral")});
        localStorage.setItem('harbour-theme',${JSON.stringify(testCase.cat === "anime" ? "anime-wisteria" : "premium-champagne")});
        window.harbourDesktop={isElectron:true,petsEnabled:false}; window.__testErrors=[];
        window.addEventListener('error',e=>{if(e.error)window.__testErrors.push(String(e.error.stack||e.message));});
        window.addEventListener('unhandledrejection',e=>window.__testErrors.push(String(e.reason)));
      </script>`));
      const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" }[path.extname(file)] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": type }); res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  function emit(event) { for (const socket of wss.clients) if (socket.readyState === 1) socket.send(JSON.stringify(event)); }
  wss.on("connection", (socket) => socket.send(JSON.stringify({ __harbour: "activity-snapshot", activeRunIds: [], serverEpoch: "fixture-time-zone" })));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, requests, emit,
    upgradeBackend() { legacyBackend = false; },
    changeZone(zone) { time = { ...time, timeZone: zone, revision: time.revision + 1 }; emit({ type: "time-settings:changed", payload: time }); },
    async close() { for (const socket of wss.clients) socket.terminate(); wss.close(); server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); } };
}

async function waitFor(win, expression, label) {
  for (let i = 0; i < 180; i++) { if (await evaluate(win, expression)) return; await pause(30); }
  throw new Error(`timeout: ${label}`);
}
async function click(win, selector) {
  let hit, last = "", stable = 0;
  for (let i = 0; i < 50; i++) {
    hit = await evaluate(win, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('missing ${selector}');
      el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});const r=el.getBoundingClientRect();
      const p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};return {p,ok:el.contains(document.elementFromPoint(p.x,p.y))};})()`);
    const next = JSON.stringify(hit.p); stable = hit.ok && last === next ? stable + 1 : 0; last = next;
    if (stable >= 2) break;
    await pause(40);
  }
  assert.ok(hit.ok && stable >= 2, `visible unobscured mouse target ${selector}`);
  win.webContents.sendInputEvent({ type: "mouseMove", ...hit.p });
  win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...hit.p });
  win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...hit.p });
  await pause(70);
}
async function selectZone(win, zone) {
  // Use Harbour's actual visible select control, which forwards change to its native select.
  await click(win, '[data-hs-for="timeSettingsZone"] .hs-trigger');
  const index = options.findIndex((option) => option.value === zone);
  await click(win, `[data-hs-for="timeSettingsZone"] [data-hs-index="${index}"]`);
  await waitFor(win, `document.querySelector('#timeSettingsZone').value===${JSON.stringify(zone)} && !document.querySelector('#timeSettingsSave').disabled`, "select zone draft");
  await click(win, "#timeSettingsSave");
  await waitFor(win, `document.querySelector('#timeSettingsCurrent').textContent===${JSON.stringify(zone)} && document.querySelector('#timeSettingsSave').disabled`, "saved zone");
}
async function screenshot(win, name) {
  await evaluate(win, "document.querySelectorAll('.toast').forEach(el=>el.remove())");
  win.webContents.invalidate();
  await evaluate(win, "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  await pause(90);
  fs.writeFileSync(path.join(outputDir, name), (await win.webContents.capturePage()).toPNG());
}
async function layout(win) {
  const result = await evaluate(win, `(()=>{const el=document.querySelector('#timeSettingsForm'),r=el.getBoundingClientRect();
    return {width:innerWidth,pageWidth:document.documentElement.scrollWidth,left:r.left,right:r.right,
      selectWidth:document.querySelector('[data-hs-for="timeSettingsZone"]').getBoundingClientRect().width,
      current:document.querySelector('#timeSettingsCurrent').textContent,clock:document.querySelector('#timeSettingsNow').textContent};})()`);
  assert.ok(result.pageWidth <= result.width + 2 && result.left >= -1 && result.right <= result.width + 1, JSON.stringify(result));
  assert.ok(result.selectWidth > 160, "select has useful width");
  return result;
}

async function runCase(testCase) {
  const fixture = await startFixture(testCase);
  const win = new BrowserWindow({ show: false, width: testCase.width, height: 960,
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  const report = { testCase, hidden: true, settings: [] };
  const externalRequests = [], popups = [];
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const external = /^(https?|wss?):/.test(details.url) && new URL(details.url).host !== new URL(fixture.base).host;
    if (external) externalRequests.push(details.url); callback({ cancel: external });
  });
  win.webContents.setWindowOpenHandler((details) => { popups.push(details.url); return { action: "deny" }; });
  try {
    await win.loadURL(fixture.base + "/#settings");
    await waitFor(win, "!!document.querySelector('[data-set-nav=\"time\"]')", "settings navigation");
    await click(win, '[data-set-nav="time"]');
    if (testCase.legacyBackend) {
      await waitFor(win, "document.querySelector('#timeSettingsStatus')?.textContent.includes('重启或更新 Harbour 后端') && !document.querySelector('#timeSettingsRetry').disabled", "old backend diagnosis");
      assert.equal(await evaluate(win, "document.querySelector('#timeSettingsZone').disabled && document.querySelector('#timeSettingsSave').disabled"), true);
      await screenshot(win, `${testCase.id}-old-backend.png`);
      // Repeated failures remain retriable; simulate loading the new backend without a page reload or WS event.
      await click(win, "#timeSettingsRetry");
      await waitFor(win, "!document.querySelector('#timeSettingsRetry').disabled", "failed retry released");
      fixture.upgradeBackend();
      await click(win, "#timeSettingsRetry");
    }
    await waitFor(win, "document.querySelector('#timeSettingsCurrent')?.textContent==='America/New_York' && !document.querySelector('#timeSettingsZone').disabled", "initial NY settings");
    assert.equal(await evaluate(win, "document.querySelector('#timeSettingsRetry').hidden"), true, "successful load dismisses the connection error action");
    await evaluate(win, "document.fonts.ready");
    report.settings.push(await layout(win));
    await screenshot(win, `${testCase.id}-new-york.png`);
    for (const zone of ["Asia/Shanghai", "Etc/GMT+5"]) {
      await selectZone(win, zone);
      report.settings.push(await layout(win));
      await screenshot(win, `${testCase.id}-${zone === "Asia/Shanghai" ? "shanghai" : "fixed-est"}.png`);
    }
    await evaluate(win, "location.hash='#chat'");
    await waitFor(win, "document.querySelector('#chatStream .msg-time') && document.querySelector('.chat-trace .ct-time') && document.querySelector('#chatInput')", "real chat and stored trace");
    await click(win, ".chat-trace summary");
    await click(win, "#chatInput");
    await win.webContents.insertText(draft);
    await waitFor(win, `document.querySelector('#chatInput').value===${JSON.stringify(draft)}`, "native draft input");
    fixture.emit({ __harbour: "channel-activity", phase: "running", runId: "fixture-live-log", agent: agent.name,
      sessionId: session.id, sessionKey: key, source: { platform: "web" }, input: "另一客户端的假运行 · 无模型", startedAt: Date.now() });
    fixture.emit({ level: 30, time: epoch, runId: "fixture-live-log", agent: agent.name, msg: "loop:thinking", preview: "LIVE_LOG_FIXTURE" });
    await waitFor(win, "Array.from(document.querySelectorAll('.ct-ev')).some(el=>el.textContent.includes('LIVE_LOG_FIXTURE'))", "real WebSocket log");
    if (!await evaluate(win, "document.querySelector('.chat-trace').open")) await click(win, ".chat-trace summary");
    // Capture the actual nodes: broadcasts must update these same nodes, not rerender their forms.
    await evaluate(win, `window.__timeNodes=Array.from(document.querySelectorAll('#chatStream [data-harbour-time]'));
      window.__composer=document.querySelector('#chatInput');window.__chatText=state.chat.messages.map(m=>m.content).join('|');`);
    const inspect = () => evaluate(win, `({zone:HarbourTime.getTimeZone(),draft:document.querySelector('#chatInput').value,
      sameComposer:document.querySelector('#chatInput')===window.__composer,sameTimes:window.__timeNodes.every(el=>el.isConnected),
      chat:Array.from(document.querySelectorAll('.msg-time')).map(el=>el.textContent),
      stored:Array.from(document.querySelectorAll('.chat-trace .ct-time')).map(el=>el.textContent),
      live:Array.from(document.querySelectorAll('.chat-trace-live .ct-time')).map(el=>el.textContent),
      data:window.__timeNodes.map(el=>el.dataset.harbourTime),chatText:state.chat.messages.map(m=>m.content).join('|')})`);
    const before = await inspect();
    assert.equal(before.chat.length, 3);
    assert.ok(before.chat.slice(0, 2).every((value) => value.includes("07:34")), JSON.stringify(before));
    assert.ok(before.stored.every((value) => value === "07:34:56"), JSON.stringify(before));
    assert.ok(before.live.includes("07:34:56"), JSON.stringify(before));
    await screenshot(win, `${testCase.id}-chat-fixed-est.png`);
    fixture.changeZone("Asia/Shanghai");
    await waitFor(win, "HarbourTime.getTimeZone()==='Asia/Shanghai' && document.querySelector('.msg-time').textContent.includes('20:34')", "broadcast updates displayed timestamps");
    const after = await inspect();
    assert.equal(after.draft, draft); assert.equal(after.sameComposer, true); assert.equal(after.sameTimes, true);
    assert.deepEqual(after.data, before.data); assert.equal(after.chatText, before.chatText);
    assert.ok(after.chat.slice(0, 2).every((value) => value.includes("20:34")));
    assert.ok(after.stored.every((value) => value === "20:34:56"));
    assert.ok(after.live.includes("20:34:56"));
    await screenshot(win, `${testCase.id}-chat-shanghai.png`);
    await evaluate(win, "document.querySelector('.chat-trace-live').scrollIntoView({block:'nearest',behavior:'instant'})");
    await screenshot(win, `${testCase.id}-live-log-shanghai.png`);
    const writes = fixture.requests.filter((request) => request.method !== "GET");
    assert.deepEqual(writes.map((request) => [request.method, request.path, request.body]), [
      ["PUT", "/api/time-settings", { timeZone: "Asia/Shanghai" }], ["PUT", "/api/time-settings", { timeZone: "Etc/GMT+5" }],
    ], "only explicit Settings saves mutate the fixture; no schedules or model runs");
    assert.equal(win.isVisible(), false); assert.deepEqual(popups, []);
    assert.deepEqual(await evaluate(win, "window.__testErrors"), []);
    Object.assign(report, { before, after, requests: fixture.requests, externalRequestsBlocked: externalRequests });
    fs.writeFileSync(path.join(outputDir, `${testCase.id}.json`), JSON.stringify(report, null, 2));
    console.log(`Time zone ${testCase.id}: Settings saves + WS chat/stored trace/live log refresh + intact draft (hidden=true)`);
  } catch (error) {
    await screenshot(win, `${testCase.id}-failure.png`).catch(() => {});
    Object.assign(report, { error: String(error.stack || error), requests: fixture.requests,
      state: await evaluate(win, "({hash:location.hash,errors:window.__testErrors,text:document.body.innerText.slice(-5000)})").catch(() => null) });
    fs.writeFileSync(path.join(outputDir, `${testCase.id}-failure.json`), JSON.stringify(report, null, 2));
    throw error;
  } finally { win.destroy(); await fixture.close(); }
}

app.whenReady().then(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const testCase of [
    { id: "premium-wide", cat: "premium", width: 1440 }, { id: "anime-wide", cat: "anime", width: 1440 },
    { id: "premium-narrow", cat: "premium", width: 520 }, { id: "anime-narrow", cat: "anime", width: 520 },
    { id: "anime-old-backend", cat: "anime", width: 520, legacyBackend: true },
  ]) await runCase(testCase);
  console.log(`Time zone hidden Electron smoke passed. Evidence: ${outputDir}`);
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
