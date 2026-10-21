// Real dashboard rendering against an in-memory fixture API. No live Harbour, model,
// desktop worker, Chrome window, or user profile is used by this test.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createServer } = require("node:http");
const { WebSocketServer } = require("ws");

const root = path.resolve(__dirname, "../..");
const webRoot = path.join(root, "web");
const outputDir = path.join(root, "assets", "reports", "cowork-ui");
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-cowork-ui-smoke-"));
app.setPath("userData", profileDir);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
// All windows are intentionally hidden; closing one case must not quit the suite.
app.on("window-all-closed", () => {});
const cases = [
  { id: "anime-light", cat: "anime", persona: "elaina", variant: "anime-wisteria", width: 1440, height: 960, deviceId: "fixture-laptop" },
  { id: "premium-dark", cat: "premium", persona: "neutral", variant: "premium-champagne", width: 1440, height: 960, deviceId: "fixture-laptop", running: true },
  { id: "anime-narrow", cat: "anime", persona: "elaina", variant: "anime-sky", width: 430, height: 1100, deviceId: "fixture-offline" },
];
const devices = [
  { id: "server", label: "Harbour 服务端", platform: "linux", arch: "arm64", hostname: "harbour", tools: ["read_file", "bash", "opencli_browser"], cwd: "/srv/harbour", online: true, lastSeenAt: 1,
    environment: { osRelease: "6.8.0", nodeVersion: "24.1.0", shell: { name: "Bash", version: "5.2.21", executable: "/bin/bash", available: true } } },
  { id: "fixture-laptop", label: "用户 · 工作电脑", platform: "win32", arch: "x64", hostname: "rain-laptop", tools: ["read_file", "write_file", "bash"], cwd: "D:\\Work\\Harbour", online: true, lastSeenAt: 1,
    environment: { osRelease: "10.0.26100", nodeVersion: "24.1.0", shell: { name: "PowerShell 7", version: "7.4.6", executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", available: true } } },
  { id: "fixture-offline", label: "MacBook · 家里", platform: "darwin", arch: "arm64", hostname: "home-macbook", tools: ["read_file", "bash"], cwd: "/Users/rain/Projects", online: false, lastSeenAt: 1,
    environment: { osRelease: "24.1.0", nodeVersion: "24.1.0", shell: { name: "Bash", version: "3.2.57", executable: "/bin/bash", available: true } } },
];
const agent = { name: "main-elaina", description: "Cowork 视觉测试角色", taskType: "main", permissionMode: "dontAsk", tools: [], skills: [], contextBudget: 80000 };
const model = { modelRef: "claude-agent/kimi-for-coding", modelName: "kimi-for-coding", modelLabel: "Kimi Code", model: "Kimi · Kimi Code", providerLabel: "Kimi", backendKind: "claude-agent", contextWindow: 262144, defaultEffort: "medium", supportedEfforts: ["low", "medium", "high"], effortOptions: ["low", "medium", "high"].map((effort) => ({ effort })) };

function fixtureSession(testCase) {
  return {
    id: "fixture-cowork-session", key: "web:cowork:main-elaina", channel: "web", agentName: agent.name,
    title: "项目检查 · Cowork UI 测试", active: true, readOnlyMirror: false, messageCount: 2,
    createdAt: "2026-09-03T02:00:00.000Z", updatedAt: "2026-09-03T02:00:00.000Z", lastMessageAt: "2026-09-03T02:00:00.000Z",
    compactions: 0, contextTokens: 4320, contextWindow: 262144, systemTokens: 2400, bodyTokens: 1920,
    modelRef: model.modelRef, reasoningEffort: "high", permissionMode: "dontAsk",
    cowork: { deviceId: testCase.deviceId, cwd: testCase.deviceId === "fixture-offline" ? "/Users/rain/Projects" : "D:\\Work\\Harbour" },
    source: { app: "web", locationLabel: "Cowork", accountLabel: "Harbour", actorRole: "owner" },
    messages: [
      { role: "user", content: "看看目标设备里的项目结构，然后告诉我可以从哪里开始。" },
      { role: "assistant", content: "可以。你可以在上方选择执行设备和工作目录，模型与权限仍由同一套 Harbour 配置控制。\n\n当前会话会记住自己的目标；设备离线时会保留选择，不会自动换机。" },
    ],
    traces: [null, [{ msg: "cowork:tool:complete", runId: "fixture-previous", agent: agent.name, deviceId: "fixture-laptop", deviceLabel: "用户 · 工作电脑", op: "list_files", message: "已读取项目目录" }]],
    goal: null, checkpoint: null,
  };
}

function bootstrap(testCase) {
  return `<script>
    localStorage.clear();
    localStorage.setItem("harbour-chat-mode", "cowork");
    localStorage.setItem("harbour-theme-cat", ${JSON.stringify(testCase.cat)});
    localStorage.setItem("harbour-theme-persona", ${JSON.stringify(testCase.persona)});
    localStorage.setItem("harbour-theme", ${JSON.stringify(testCase.variant)});
    window.__coworkSmokeErrors = [];
    window.addEventListener("error", (event) => { if (event.error) window.__coworkSmokeErrors.push(String(event.error.stack || event.message)); });
    window.addEventListener("unhandledrejection", (event) => window.__coworkSmokeErrors.push(String(event.reason)));
    window.harbourDesktop = { isElectron: true, petsEnabled: false, getCoworkDevice: async () => ({ deviceId: "fixture-origin", label: "此设备 · 控制台", hostname: "fixture-controller" }) };
  </script><style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>`;
}

async function startFixture(testCase) {
  const requests = [];
  const writes = [];
  const session = fixtureSession(testCase);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const json = (body, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname.startsWith("/api/")) {
      requests.push(`${req.method} ${url.pathname}`);
      if (req.method === "PATCH" && url.pathname === `/api/conversations/${session.id}`) {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        writes.push({ path: url.pathname, body });
        session.cowork = body.cowork;
        return json({ session });
      }
      if (req.method !== "GET") return json({ error: "smoke fixtures are read-only" }, 405);
      if (url.pathname === "/api/agents") return json({ agents: [agent] });
      if (url.pathname === "/api/state") return json({ defaultAgent: agent.name, agents: [agent], backends: { mock: true }, uptimeMs: 90000 });
      if (url.pathname === "/api/skills") return json({ skills: [{ name: "code-review", description: "检查代码与项目结构" }] });
      if (url.pathname === "/api/agent-defaults") return json({ models: [model], agents: [{ name: agent.name, effectiveModelRef: model.modelRef, effectivePermissionMode: "dontAsk", defaultReasoningEffort: "high" }] });
      if (url.pathname === "/api/asks") return json({ asks: [] });
      if (url.pathname === "/api/cowork/devices") return json({ devices });
      if (url.pathname === "/api/conversations/explorer") return json({ enabled: true, sessions: [session] });
      if (url.pathname === `/api/conversations/${session.id}`) return json({ session });
      return json({ error: `unknown fixture endpoint: ${url.pathname}` }, 404);
    }
    const target = path.resolve(webRoot, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!target.startsWith(webRoot + path.sep)) { res.writeHead(403); return res.end(); }
    try {
      let content = fs.readFileSync(target);
      if (path.basename(target) === "index.html") content = Buffer.from(content.toString("utf8").replace("<head>", "<head>" + bootstrap(testCase)));
      const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" }[path.extname(target)] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": type }); res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket) => socket.send(JSON.stringify({ __harbour: "activity-snapshot", activeRunIds: [], serverEpoch: "fixture" })));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, requests, writes, close: async () => {
    for (const socket of wss.clients) socket.terminate();
    wss.close(); server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  } };
}

async function renderCase(testCase) {
  const fixture = await startFixture(testCase);
  const win = new BrowserWindow({
    show: false, focusable: false, width: testCase.width, height: testCase.height, useContentSize: true,
    frame: false, backgroundColor: testCase.cat === "premium" ? "#100f0d" : "#fffefa",
    webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false, contextIsolation: true, partition: `cowork-smoke-${testCase.id}-${process.pid}` },
  });
  const externalRequests = [];
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(fixture.base + "/") || details.url.startsWith(fixture.base.replace("http:", "ws:") + "/") || /^(?:data:|blob:|about:)/.test(details.url);
    if (!allowed) externalRequests.push(details.url);
    callback({ cancel: !allowed });
  });
  try {
    assert.equal(win.isVisible(), false);
    await win.loadURL(fixture.base);
    win.webContents.enableDeviceEmulation({
      screenPosition: "desktop", screenSize: { width: testCase.width, height: testCase.height },
      viewSize: { width: testCase.width, height: testCase.height }, viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 1, scale: 1,
    });
    for (let i = 0; i < 100; i++) {
      if (await win.webContents.executeJavaScript(`!!document.querySelector('#coworkTarget') && state.chat.sessionId === 'fixture-cowork-session'`)) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('coworkDisclosure').open`), false, "chat environment starts compact");
    await win.webContents.executeJavaScript(`document.querySelector('#coworkDisclosure > summary').click()`);
    await win.webContents.executeJavaScript(`(async () => {
      if (state.chat.sessionId !== 'fixture-cowork-session') throw new Error('real chat render did not complete');
      await loadCoworkDevices(); await loadCoworkOrigin(); renderCoworkBar();
      ${testCase.running ? `state.chat.running = true; state.chat.activeRunId = 'fixture-run'; state.runningAgent = state.chat.agent;
        state.chat.messages.push({ role: 'assistant', agent: state.chat.agent, content: '', pending: true, activity: '用户 · 工作电脑 · 读取项目结构', at: new Date().toISOString(), runStartedAt: Date.now() });
        state.chat.trace = [{ cls: 'call', tag: 'COWORK', text: '用户 · 工作电脑 · read_file · 执行中', agent: state.chat.agent, depth: 0 }];
        renderChatMessages(); setChatSendMode(true);` : ""}
      syncChatControlLocks(); stopCoworkPolling();
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // A long reply can push its leading trace header above a narrow viewport
      // when scrolled to the end. Verify the header is reachable by scrolling,
      // not that the entire reply must fit; keep the real composer/layout checks.
      ${testCase.width <= 760 ? `const stream = document.getElementById('chatStream'); stream.scrollTop = stream.scrollHeight;
        Array.from(stream.querySelectorAll('.chat-trace > summary')).at(-1)?.scrollIntoView({ block: 'nearest', behavior: 'instant' });` : ""}
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    // Hidden offscreen windows can retain their initial compositor frame even
    // after the real DOM has settled. Invalidate and await an actual repaint.
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { win.webContents.removeListener("paint", onPaint); reject(new Error("offscreen repaint timed out")); }, 5000);
      const onPaint = () => { clearTimeout(timeout); resolve(); };
      win.webContents.once("paint", onPaint);
      win.webContents.startPainting();
      win.webContents.invalidate();
    });
    const layout = await win.webContents.executeJavaScript(`(() => {
      const ids = ['coworkBar', 'coworkTarget', 'coworkCwd', 'coworkOrigin', 'coworkRename', 'chatInput', 'chatAgent', 'chatModel', 'chatEffort', 'chatPermMode', 'chatSkill'];
      const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      const targets = Object.fromEntries(ids.map((id) => { const el = document.getElementById(id); return [id, { ...rect(el), disabled: el.disabled, value: el.value, text: el.textContent }]; }));
      const hero = document.querySelector('.harbour-hero');
      const heroStyle = hero && getComputedStyle(hero);
      const sessions = document.querySelector('.chat-sessions');
      const content = document.querySelector('.content');
      const stream = document.getElementById('chatStream');
      const traceHeaderLabels = Array.from(document.querySelectorAll('.chat-trace > summary .ct-sum-tag'), (el) => {
        const style = getComputedStyle(el);
        const textRange = document.createRange();
        textRange.selectNodeContents(el);
        const textRects = Array.from(textRange.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
        return { ...rect(el), whiteSpace: style.whiteSpace, writingMode: style.writingMode,
          textLineCount: new Set(textRects.map((r) => Math.round(r.top))).size };
      });
      return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight,
        theme: document.body.dataset.theme, origin: document.getElementById('coworkOrigin').textContent, target: state.chat.cowork.deviceId,
        offline: document.getElementById('coworkStatus').classList.contains('is-offline'), targets, errors: window.__coworkSmokeErrors,
        hero: hero && { ...rect(hero), visible: heroStyle.display !== 'none' && heroStyle.visibility !== 'hidden' && Number(heroStyle.opacity) > 0 && hero.getClientRects().length > 0 },
        sessions: sessions && rect(sessions), traceHeaderLabels,
        content: { clientWidth: content.clientWidth, scrollWidth: content.scrollWidth },
        stream: { ...rect(stream), clientWidth: stream.clientWidth, scrollWidth: stream.scrollWidth,
          clientHeight: stream.clientHeight, scrollTop: stream.scrollTop, scrollHeight: stream.scrollHeight },
        visibleSelect: rect(document.querySelector('[data-hs-for="coworkTarget"]')) };
    })()`);
    assert.deepEqual(layout.errors, [], `${testCase.id}: dashboard runtime errors`);
    assert.equal(layout.theme, testCase.variant);
    assert.equal(layout.target, testCase.deviceId);
    assert.equal(layout.origin, "此设备 · 控制台");
    assert.ok(layout.targets.coworkBar.width > 200, "real Cowork bar must be visible");
    assert.ok(layout.visibleSelect.width > 100, "the real Harbour Select must be rendered");
    assert.ok(layout.targets.coworkBar.right <= layout.width + 1, "Cowork bar cannot overflow horizontally");
    assert.ok(layout.visibleSelect.right <= layout.width + 1, "target selector cannot overflow the viewport");
    assert.ok(layout.targets.coworkCwd.right <= layout.width + 1, "directory input cannot overflow the viewport");
    if (testCase.width <= 760) {
      assert.ok(layout.hero, "narrow fixture must contain the real dashboard hero element");
      assert.equal(layout.hero.visible, false, "narrow Cowork must hide the decorative hero");
      assert.ok(layout.targets.coworkBar.width >= layout.width - 50, "narrow Cowork must reclaim the full content width");
      assert.ok(layout.sessions && layout.sessions.height > 0 && layout.sessions.height <= 145, "narrow session list must remain visible and compact");
      assert.ok(layout.documentWidth <= layout.width + 1, "narrow dashboard cannot overflow horizontally");
      for (const section of [layout.content, layout.stream]) assert.ok(section.scrollWidth <= section.clientWidth + 1, "narrow content and messages cannot scroll horizontally");
      assert.ok(layout.targets.chatInput.bottom < layout.height, "narrow composer must remain reachable in the viewport");
      assert.ok(layout.traceHeaderLabels.length > 0, "narrow fixture must render real completed-trace header labels");
      for (const label of layout.traceHeaderLabels) {
        assert.equal(label.whiteSpace, "nowrap", "trace header labels must not wrap one character per line");
        assert.equal(label.writingMode, "horizontal-tb", "trace header labels must use horizontal writing");
        assert.equal(label.textLineCount, 1, "trace header label text must occupy one rendered line");
        assert.ok(label.width > label.height, "trace header labels must remain horizontal rather than a vertical strip");
        assert.ok(label.y >= layout.stream.y && label.bottom <= layout.stream.bottom,
          `the latest reply trace header must be visible inside the real scrollable stream: ${JSON.stringify({ label, stream: layout.stream, case: testCase.id })}`);
      }
    }
    assert.equal(layout.targets.coworkCwd.disabled, !!testCase.running);
    for (const id of ["coworkTarget", "coworkRename", "chatAgent", "chatModel", "chatEffort", "chatPermMode", "chatSkill"]) {
      assert.equal(layout.targets[id].disabled, !!testCase.running, `${id} must follow the actual run lock`);
    }
    assert.equal(layout.offline, testCase.deviceId === "fixture-offline");
    assert.equal(win.isVisible(), false, "the test must never show or focus a window");
    const screenshot = await win.webContents.capturePage(undefined, { stayHidden: true });
    assert.equal(screenshot.isEmpty(), false);
    assert.deepEqual(screenshot.getSize(), { width: testCase.width, height: testCase.height });
    fs.writeFileSync(path.join(outputDir, `${testCase.id}.png`), screenshot.toPNG());
    if (testCase.width <= 760) {
      const mainLayout = await win.webContents.executeJavaScript(`(() => { state.chat.mode = 'main'; renderCoworkBar(); return { heroDisplay: getComputedStyle(document.querySelector('.harbour-hero')).display, sessionsMaxHeight: getComputedStyle(document.querySelector('.chat-sessions')).maxHeight }; })()`);
      if (testCase.width <= 600) assert.equal(mainLayout.heroDisplay, "none", "small Main Chat windows also reclaim decorative portrait space");
      else assert.notEqual(mainLayout.heroDisplay, "none", "Cowork compact layout must not hide Main Chat artwork on wider screens");
      assert.equal(mainLayout.sessionsMaxHeight, "176px", "Main Chat must retain its existing session-list layout");
      await win.webContents.executeJavaScript(`state.chat.mode = 'cowork'; renderCoworkBar();`);
    }
    // Navigate via the real chat shortcut, not a standalone mock settings component.
    await win.webContents.executeJavaScript(`document.getElementById('chatExecutionEnvironment').click()`);
    for (let i = 0; i < 100; i++) {
      if (await win.webContents.executeJavaScript(`!!document.getElementById('settingsCoworkTarget')`)) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const settingsLayout = await win.webContents.executeJavaScript(`(async () => {
      await loadCoworkDevices(); await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const pane = document.getElementById('settingsPane');
      return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, paneWidth: pane.clientWidth, paneScrollWidth: pane.scrollWidth,
        activeNav: document.querySelector('[data-set-nav="devices"].active')?.textContent,
        target: document.getElementById('settingsCoworkTarget').value, cwd: document.getElementById('settingsCoworkCwd').value,
        disabled: document.getElementById('settingsCoworkTarget').disabled,
        cards: Array.from(document.querySelectorAll('[data-execution-device]'), el => el.textContent), errors: window.__coworkSmokeErrors };
    })()`);
    assert.deepEqual(settingsLayout.errors, []);
    assert.match(settingsLayout.activeNav, /设备与执行环境/);
    assert.equal(settingsLayout.target, testCase.deviceId);
    assert.equal(settingsLayout.disabled, !!testCase.running);
    assert.equal(settingsLayout.cards.length, 3);
    assert.match(settingsLayout.cards[0], /HARBOUR 后端[\s\S]*Linux[\s\S]*Bash · 5.2.21/);
    assert.match(settingsLayout.cards[1], /COWORK 执行端[\s\S]*Windows[\s\S]*PowerShell 7 · 7.4.6/);
    assert.match(settingsLayout.cards[2], /离线 · 上次信息[\s\S]*macOS[\s\S]*Bash · 3.2.57/);
    assert.ok(settingsLayout.documentWidth <= settingsLayout.width + 1, "settings must not overflow viewport");
    assert.ok(settingsLayout.paneScrollWidth <= settingsLayout.paneWidth + 1, "settings fields and paths must wrap");
    const settingsScreenshot = await win.webContents.capturePage(undefined, { stayHidden: true });
    fs.writeFileSync(path.join(outputDir, `${testCase.id}-settings.png`), settingsScreenshot.toPNG());
    const settingsLocks = await win.webContents.executeJavaScript(`(() => {
      state.chat.running = true; syncChatControlLocks();
      const running = document.getElementById('settingsCoworkTarget').disabled && document.getElementById('settingsCoworkCwd').disabled;
      state.chat.running = false; state.chat.readOnlyMirror = true; syncChatControlLocks();
      const mirror = document.getElementById('settingsCoworkTarget').disabled;
      state.chat.readOnlyMirror = false; state.chat.mode = 'main'; renderCoworkDeviceList();
      const main = { target: document.getElementById('settingsCoworkTarget').value, disabled: document.getElementById('settingsCoworkTarget').disabled };
      state.chat.mode = 'cowork'; renderCoworkDeviceList();
      return { running, mirror, main };
    })()`);
    assert.deepEqual(settingsLocks, { running: true, mirror: true, main: { target: "server", disabled: true } });
    assert.equal(fixture.writes.length, 0, "viewing environments never changes execution location");
    const saved = await win.webContents.executeJavaScript(`(async () => {
      const select = document.getElementById('settingsCoworkTarget'); select.value = 'fixture-offline'; select.dispatchEvent(new Event('change'));
      while (state.chat.coworkSaving) await new Promise(resolve => setTimeout(resolve, 10));
      return { target: state.chat.cowork.deviceId, cwd: document.getElementById('settingsCoworkCwd').value };
    })()`);
    assert.deepEqual(saved, { target: "fixture-offline", cwd: "" });
    assert.deepEqual(fixture.writes, [{ path: "/api/conversations/fixture-cowork-session", body: { cowork: { deviceId: "fixture-offline" } } }]);
    await win.webContents.executeJavaScript(`location.hash = 'chat'`);
    for (let i = 0; i < 100; i++) {
      if (await win.webContents.executeJavaScript(`!!document.getElementById('coworkTarget') && document.getElementById('coworkTarget').value === 'fixture-offline'`)) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('coworkTarget').value`), "fixture-offline", "Settings and Chat share the exact session target");
    await win.webContents.executeJavaScript(`stopCoworkPolling()`);
    // Exercise the actual server-specific rename guard without writing to any API.
    const renameGuard = await win.webContents.executeJavaScript(`(() => { state.chat.running = false; state.chat.cowork = { deviceId: 'server' }; renderCoworkBar(); return document.getElementById('coworkRename').disabled; })()`);
    assert.equal(renameGuard, true);
    fs.writeFileSync(path.join(outputDir, `${testCase.id}.json`), JSON.stringify({ ...layout, settingsLayout, settingsLocks, fixtureRequests: fixture.requests, fixtureWrites: fixture.writes, blockedExternalRequests: externalRequests }, null, 2));
    console.log(`Cowork UI ${testCase.id}: ${layout.width} × ${layout.height}, target=${layout.target}, hidden=true`);
  } finally { win.destroy(); await fixture.close(); }
}

app.whenReady().then(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const testCase of cases) await renderCase(testCase);
  console.log(`Cowork real-dashboard offscreen smoke passed. Screenshots: ${outputDir}`);
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
