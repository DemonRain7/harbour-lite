// Real Main Chat DOM in hidden, offscreen Electron windows. The HTTP/WS fixtures
// are read-only and never start Harbour, a model, desktop workers, or Chrome.
// Run from the repository root: node desktop/node_modules/electron/cli.js desktop/tests/composer-resize-smoke.js
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createServer } = require("node:http");
const { WebSocketServer } = require("ws");

const root = path.resolve(__dirname, "../..");
const webRoot = path.join(root, "web");
const outputDir = path.join(root, "assets", "reports", "composer-resize");
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-composer-resize-"));
app.setPath("userData", profileDir);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.on("window-all-closed", () => {});

const cases = [
  { id: "premium-main", cat: "premium", persona: "neutral", variant: "premium-champagne", width: 1440, height: 960 },
  { id: "premium-web", cat: "premium", persona: "neutral", variant: "premium-champagne", width: 1440, height: 960, plainWeb: true },
  { id: "anime-main", cat: "anime", persona: "elaina", variant: "anime-wisteria", width: 1440, height: 960 },
  { id: "anime-narrow", cat: "anime", persona: "elaina", variant: "anime-sky", width: 430, height: 1100 },
];
const agent = { name: "main-elaina", description: "输入框交互测试角色", taskType: "main", permissionMode: "dontAsk", tools: [], skills: [], contextBudget: 80000 };
const model = { modelRef: "claude-agent/kimi-for-coding", modelName: "kimi-for-coding", modelLabel: "Kimi Code", model: "Kimi · Kimi Code", providerLabel: "Kimi", backendKind: "claude-agent", contextWindow: 262144, defaultEffort: "medium", supportedEfforts: ["low", "medium", "high"], effortOptions: ["low", "medium", "high"].map((effort) => ({ effort })) };
const draft = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行：拖动输入框时，这份长草稿和光标选择不能丢失。`).join("\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixtureSession() {
  return {
    id: "fixture-main-session", key: "web:default:main-elaina", channel: "web", agentName: agent.name,
    title: "长文编辑 · 输入框拖动测试", active: true, readOnlyMirror: false, messageCount: 2,
    createdAt: "2026-09-05T12:00:00.000Z", updatedAt: "2026-09-05T12:00:00.000Z", lastMessageAt: "2026-09-05T12:00:00.000Z",
    compactions: 0, contextTokens: 4320, contextWindow: 262144, systemTokens: 2400, bodyTokens: 1920,
    modelRef: model.modelRef, reasoningEffort: "high", permissionMode: "dontAsk",
    source: { app: "web", locationLabel: "Main Chat", accountLabel: "Harbour", actorRole: "owner" },
    messages: [
      { role: "user", content: "我想临时把输入框拉高，检查一段比较长的文字。" },
      { role: "assistant", content: "拖动输入区顶部的横线即可调整高度。编辑时消息区仍然保留，发送按钮和模型工具栏也保持可用。" },
    ],
    traces: [], goal: null, checkpoint: null,
  };
}

function fixtureInputs(sessionId) {
  // Pending receipts exercise the real status UI without marking this fixture
  // busy, starting any work, or changing the original resize/locking scenarios.
  return {
    sessionId, mode: "steer", busy: false, readOnly: false, revision: "fixture-inputs-1",
    records: [
      { id: "fixture-paused", state: "paused", mode: "queue", delivery: "pending", updatedAt: "2026-09-05T12:01:00.000Z",
        messages: [{ input: "这段待办仍保留在原会话中。" }, { input: "打开详情不能挤压正在编辑的输入区。", attachments: [{ kind: "image" }] }] },
      { id: "fixture-unknown", state: "unknown", mode: "steer", delivery: "unknown", isolated: true, updatedAt: "2026-09-05T12:02:00.000Z",
        messages: [{ input: "此消息需要先核对回执，不能自动重复执行。" }], error: "测试回执：交付状态待核对。" },
    ],
  };
}

function bootstrap(testCase) {
  // Do not clear storage on reload: that would hide accidental resize persistence.
  return `<script>
    localStorage.setItem("harbour-chat-mode", "main");
    localStorage.setItem("harbour-theme-cat", ${JSON.stringify(testCase.cat)});
    localStorage.setItem("harbour-theme-persona", ${JSON.stringify(testCase.persona)});
    localStorage.setItem("harbour-theme", ${JSON.stringify(testCase.variant)});
    window.__resizeSmokeErrors = [];
    window.addEventListener("error", (e) => { if (e.error) window.__resizeSmokeErrors.push(String(e.error.stack || e.message)); });
    window.addEventListener("unhandledrejection", (e) => window.__resizeSmokeErrors.push(String(e.reason)));
    document.addEventListener("pointerdown", (e) => { window.__resizeSmokePointer = { id: e.pointerId, x: e.clientX, y: e.clientY }; }, true);
    ${testCase.plainWeb ? "" : `window.harbourDesktop = { isElectron: true, petsEnabled: false, getCoworkDevice: async () => ({ deviceId: "fixture-origin", label: "隐藏测试设备", hostname: "fixture-controller" }) };`}
  </script><style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>`;
}

async function startFixture(testCase) {
  const requests = [];
  const session = fixtureSession();
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const json = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/api/")) {
      requests.push(`${req.method} ${url.pathname}`);
      if (req.method !== "GET") return json({ error: "resize fixtures are read-only" }, 405);
      if (url.pathname === "/api/agents") return json({ agents: [agent] });
      if (url.pathname === "/api/state") return json({ defaultAgent: agent.name, agents: [agent], backends: { mock: true }, uptimeMs: 90000 });
      if (url.pathname === "/api/skills") return json({ skills: [] });
      if (url.pathname === "/api/agent-defaults") return json({ models: [model], agents: [{ name: agent.name, effectiveModelRef: model.modelRef, effectivePermissionMode: "dontAsk", defaultReasoningEffort: "high" }] });
      if (url.pathname === "/api/asks") return json({ asks: [] });
      if (url.pathname === "/api/cowork/devices") return json({ devices: [] });
      if (url.pathname === "/api/conversations/explorer") return json({ enabled: true, sessions: [session] });
      if (url.pathname === `/api/conversations/${session.id}/inputs`) return json(fixtureInputs(session.id));
      if (url.pathname === `/api/conversations/${session.id}`) return json({ session });
      return json({ error: `unknown fixture endpoint: ${url.pathname}` }, 404);
    }
    let target;
    try { target = path.resolve(webRoot, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)); }
    catch { res.writeHead(400); return res.end(); }
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
  return { base: `http://127.0.0.1:${server.address().port}`, requests, close: async () => {
    for (const socket of wss.clients) socket.terminate();
    wss.close(); server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  } };
}

const evaluate = (win, script) => win.webContents.executeJavaScript(script);
async function settle(win) {
  await evaluate(win, "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await sleep(35);
}
async function waitForChat(win) {
  for (let i = 0; i < 120; i++) {
    if (await evaluate(win, "!!document.getElementById('chatResizeHandle') && state.chat.sessionId === 'fixture-main-session' && !!document.querySelector('#chatInputStatus .intake-status-trigger') && !!document.querySelector('.chat-workbench > .hb-marquee')")) {
      await evaluate(win, "document.fonts.ready");
      await settle(win);
      return;
    }
    await sleep(30);
  }
  throw new Error("real Main Chat with resize handle, pending message status and theme marquee did not finish rendering");
}
async function dimensions(win) {
  return evaluate(win, `(() => {
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right }; };
    const input = document.getElementById('chatInput'), handle = document.getElementById('chatResizeHandle');
    const workbench = document.querySelector('.chat-workbench');
    const box = (el) => { const style = getComputedStyle(el); return { id: el.id, className: el.className,
      rect: rect(el), display: style.display, position: style.position, flexShrink: style.flexShrink,
      marginTop: style.marginTop, marginBottom: style.marginBottom, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom }; };
    return { input: rect(input), handle: rect(handle), stream: rect(document.querySelector('.chat-stream-wrap')),
      composer: rect(document.querySelector('.chat-compose')), workbench: rect(document.querySelector('.chat-workbench')),
      resizeBudget: { clientHeight: workbench.clientHeight, workbench: box(workbench), children: [...workbench.children].map(box) },
      role: handle.getAttribute('role'), orientation: handle.getAttribute('aria-orientation'), tabIndex: handle.tabIndex,
      valueNow: Number(handle.getAttribute('aria-valuenow')), valueMin: Number(handle.getAttribute('aria-valuemin')), valueMax: Number(handle.getAttribute('aria-valuemax')),
      draft: input.value, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd,
      bodyCursor: document.body.style.cursor, bodySelect: document.body.style.userSelect,
      rootCursor: document.documentElement.style.cursor, rootSelect: document.documentElement.style.userSelect,
      computedCursor: getComputedStyle(document.body).cursor, computedSelect: getComputedStyle(document.body).userSelect,
      bodyDragging: document.body.classList.contains('chat-composer-resizing'), composerDragging: document.querySelector('.chat-compose').classList.contains('is-resizing'),
      running: state.chat.running, inputDisabled: input.disabled, agentDisabled: document.getElementById('chatAgent').disabled,
      width: innerWidth, height: innerHeight, errors: window.__resizeSmokeErrors.slice() };
  })()`);
}
async function storageSnapshot(win) {
  return evaluate(win, "JSON.stringify([Object.entries(localStorage).sort(), Object.entries(sessionStorage).sort()])");
}
async function pressKey(win, key) {
  await evaluate(win, `document.getElementById('chatResizeHandle').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`);
  await settle(win);
}
async function intakePopoverState(win) {
  return evaluate(win, `(() => {
    const trigger = document.querySelector('#chatInputStatus .intake-status-trigger');
    const popover = document.getElementById('chatIntakePopover');
    const rect = popover?.getBoundingClientRect();
    return { open: !!popover && !popover.hidden && getComputedStyle(popover).display !== 'none',
      parentIsBody: popover?.parentElement === document.body, role: popover?.getAttribute('role'),
      modal: popover?.getAttribute('aria-modal'), expanded: trigger?.getAttribute('aria-expanded'),
      controls: trigger?.getAttribute('aria-controls'), triggerFocused: document.activeElement === trigger,
      text: trigger?.textContent, content: popover?.textContent,
      rect: rect && { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom }, width: innerWidth, height: innerHeight };
  })()`);
}
async function openIntakePopover(win) {
  await evaluate(win, "document.querySelector('#chatInputStatus .intake-status-trigger').click()");
  await settle(win);
  const popover = await intakePopoverState(win);
  assert.equal(popover.open, true, "pending status opens a popover");
  assert.equal(popover.parentIsBody, true, "popover is portalled outside the composer layout");
  assert.equal(popover.role, "dialog", "message details have dialog semantics");
  assert.notEqual(popover.modal, "true", "details remain nonmodal so the resize handle stays interactive");
  assert.equal(popover.expanded, "true");
  assert.equal(popover.controls, "chatIntakePopover");
  assert.match(popover.text, /3\s*条/, "all pending messages remain represented by the compact status");
  assert.match(popover.content, /交付状态待核对/, "popover renders actual pending receipt details");
  assert.ok(popover.rect.x >= -1 && popover.rect.right <= popover.width + 1, "popover stays horizontally inside the viewport");
  assert.ok(popover.rect.y >= -1 && popover.rect.bottom <= popover.height + 1, "popover stays vertically inside the viewport");
  return popover;
}
function assertSameComposerGeometry(layout, baseline, label) {
  for (const field of ["input", "composer", "stream"]) assert.ok(Math.abs(layout[field].height - baseline[field].height) <= 1, `${label}: ${field} height must not change`);
  assert.equal(layout.valueMax, baseline.valueMax, `${label}: advertised resize maximum must not change`);
  assert.equal(layout.valueNow, baseline.valueNow, `${label}: accessible input height must not change`);
  assert.equal(layout.draft, baseline.draft, `${label}: preserve draft`);
  assert.equal(layout.selectionStart, baseline.selectionStart, `${label}: preserve selection start`);
  assert.equal(layout.selectionEnd, baseline.selectionEnd, `${label}: preserve selection end`);
}
async function beginDrag(win, expectPopoverOpen = false) {
  await evaluate(win, "document.getElementById('chatResizeHandle').scrollIntoView({ block: 'nearest' })");
  await settle(win);
  if (expectPopoverOpen) assert.equal((await intakePopoverState(win)).open, true, "popover stays open until native pointerdown on the handle");
  const layout = await dimensions(win);
  const point = { x: Math.round(layout.handle.x + layout.handle.width / 2), y: Math.round(layout.handle.y + layout.handle.height / 2) };
  assert.ok(point.x >= 0 && point.x < layout.width && point.y >= 0 && point.y < layout.height, "resize handle must be reachable");
  win.webContents.sendInputEvent({ type: "mouseMove", ...point });
  win.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
  await settle(win);
  if (expectPopoverOpen) assert.equal((await intakePopoverState(win)).open, false, "native resize pointerdown closes the popover without blocking the drag");
  return point;
}
async function moveDrag(win, point, delta) {
  const target = { x: point.x, y: Math.max(1, Math.round(point.y + delta)) };
  win.webContents.sendInputEvent({ type: "mouseMove", ...target, modifiers: ["leftButtonDown"] });
  await settle(win);
  return target;
}
async function endDrag(win, point) {
  win.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
  await settle(win);
}
async function drag(win, delta, expectPopoverOpen = false) {
  const origin = await beginDrag(win, expectPopoverOpen);
  const target = await moveDrag(win, origin, delta);
  await endDrag(win, target);
}
function assertCleanCursor(layout, baseline, label) {
  for (const field of ["bodyCursor", "bodySelect", "rootCursor", "rootSelect", "computedCursor", "computedSelect", "bodyDragging", "composerDragging"]) assert.equal(layout[field], baseline[field], `${label}: restore ${field}`);
}
function assertWithinBounds(layout, label) {
  assert.ok(layout.input.height >= 51.5, `${label}: textarea must not collapse below 52px`);
  assert.ok(layout.input.height <= layout.valueMax + 1, `${label}: textarea must respect advertised maximum`);
  assert.ok(Math.abs(layout.input.height - layout.valueNow) <= 1, `${label}: accessible height must match real layout`);
  assert.ok(layout.stream.height >= 119, `${label}: preserve at least 120px of messages; ${JSON.stringify({ streamHeight: layout.stream.height, inputHeight: layout.input.height, maximum: layout.valueMax, resizeBudget: layout.resizeBudget })}`);
  assert.ok(layout.composer.bottom <= layout.workbench.bottom + 1, `${label}: composer cannot be clipped by the workbench`);
}
async function screenshot(win, fileName) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { win.webContents.removeListener("paint", onPaint); reject(new Error("offscreen repaint timed out")); }, 5000);
    const onPaint = () => { clearTimeout(timer); resolve(); };
    win.webContents.once("paint", onPaint);
    win.webContents.startPainting(); win.webContents.invalidate();
  });
  const capture = await win.webContents.capturePage(undefined, { stayHidden: true });
  assert.equal(capture.isEmpty(), false);
  fs.writeFileSync(path.join(outputDir, fileName), capture.toPNG());
}
async function showComposerEnd(win) {
  // Main Chat already uses page scrolling on narrow screens. Verify the expanded
  // editor/actions remain reachable there instead of asserting a desktop layout.
  // Scroll the actual action into view. An expanded editor may be taller than
  // the viewport; aligning that whole container is not equivalent on macOS.
  await evaluate(win, "document.getElementById('chatSend').scrollIntoView({ block: 'center' })");
  let visible;
  // Native scrolling/compositing can settle after two frames on macOS. Wait for
  // the real reachability condition, not a fixed 35 ms; never alter page layout.
  for (let i = 0; i < 25; i++) {
    await settle(win);
    visible = await evaluate(win, "(() => { const r = document.getElementById('chatSend').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, right: r.right, width: innerWidth, height: innerHeight }; })()");
    if (visible.top >= 0 && visible.bottom <= visible.height + 1 && visible.right <= visible.width + 1) return;
  }
  assert.fail(`SEND remains unreachable after scrolling the narrow editor: ${JSON.stringify(visible)}`);
}

async function runCase(testCase) {
  const fixture = await startFixture(testCase);
  const win = new BrowserWindow({
    show: false, focusable: false, width: testCase.width, height: testCase.height, useContentSize: true, frame: false,
    backgroundColor: testCase.cat === "premium" ? "#100f0d" : "#fffefa",
    webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false, contextIsolation: true, partition: `composer-resize-${testCase.id}-${process.pid}` },
  });
  const externalRequests = [];
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(fixture.base + "/") || details.url.startsWith(fixture.base.replace("http:", "ws:") + "/") || /^(?:data:|blob:|about:)/.test(details.url);
    if (!allowed) externalRequests.push(details.url);
    callback({ cancel: !allowed });
  });
  const report = { id: testCase.id, checkpoints: {} };
  try {
    await win.loadURL(fixture.base);
    const emulate = (height) => win.webContents.enableDeviceEmulation({ screenPosition: "desktop", screenSize: { width: testCase.width, height }, viewSize: { width: testCase.width, height }, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 1, scale: 1 });
    emulate(testCase.height);
    await waitForChat(win);
    assert.equal(await evaluate(win, "!!window.harbourDesktop"), !testCase.plainWeb, "plain Web must exercise the dashboard without an Electron bridge");
    const baseline = await dimensions(win);
    report.checkpoints.baseline = baseline;
    assert.equal(baseline.role, "separator");
    assert.equal(baseline.orientation, "horizontal");
    assert.ok(baseline.tabIndex >= 0, "resize handle must be keyboard reachable");
    assert.deepEqual(baseline.errors, []);
    const storageBefore = await storageSnapshot(win);
    await evaluate(win, `(() => { const input = document.getElementById('chatInput'); input.value = ${JSON.stringify(draft)}; input.setSelectionRange(12, 38); })()`);

    // Exercise the real pending-message UI against the resize budget: opening
    // details must never consume composer space or shrink the message stream.
    await evaluate(win, "document.getElementById('chatResizeHandle').scrollIntoView({ block: 'nearest' })");
    await settle(win);
    const beforePopover = await dimensions(win);
    report.checkpoints.intakePopover = await openIntakePopover(win);
    assertSameComposerGeometry(await dimensions(win), beforePopover, "open message details");
    await screenshot(win, `${testCase.id}-message-status.png`);
    await evaluate(win, "document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
    await settle(win);
    const closedPopover = await intakePopoverState(win);
    assert.equal(closedPopover.open, false, "Escape dismisses message details");
    assert.equal(closedPopover.expanded, "false");
    assert.equal(closedPopover.triggerFocused, true, "Escape returns focus to the status trigger");
    assertSameComposerGeometry(await dimensions(win), beforePopover, "close message details");
    await openIntakePopover(win);
    assertSameComposerGeometry(await dimensions(win), beforePopover, "reopen message details");
    assert.deepEqual(fixture.requests.filter((request) => !request.startsWith("GET ")), [], "opening and dismissing message details must not write to any API");

    await drag(win, -120, true);
    const grown = await dimensions(win);
    const expectedGrownHeight = Math.min(beforePopover.input.height + 120, beforePopover.valueMax);
    assert.ok(grown.input.height > beforePopover.input.height, "dragging upward must enlarge the real input within its available budget");
    assert.ok(Math.abs(grown.input.height - expectedGrownHeight) <= 1, "upward dragging must apply the exact requested height or advertised maximum");
    assert.equal(grown.draft, draft);
    assert.equal(grown.selectionStart, 12); assert.equal(grown.selectionEnd, 38);
    assertCleanCursor(grown, baseline, "pointerup");
    assertWithinBounds(grown, "upward drag");
    report.checkpoints.expanded = grown;
    if (testCase.width <= 760) await showComposerEnd(win);
    await screenshot(win, `${testCase.id}-expanded.png`);
    await drag(win, 48);
    assert.ok((await dimensions(win)).input.height < grown.input.height - 20, "dragging downward must shrink the input");

    await pressKey(win, "Home");
    assert.ok(Math.abs((await dimensions(win)).input.height - baseline.input.height) <= 1, "Home restores default height");
    await pressKey(win, "ArrowUp");
    const keyboard = await dimensions(win);
    assert.ok(Math.abs(keyboard.input.height - baseline.input.height - 24) <= 1, "ArrowUp grows by 24px");
    await pressKey(win, "ArrowDown");
    assert.ok(Math.abs((await dimensions(win)).input.height - baseline.input.height) <= 1, "ArrowDown shrinks by 24px");
    await pressKey(win, "ArrowUp");
    await evaluate(win, "document.getElementById('chatResizeHandle').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
    await settle(win);
    assert.ok(Math.abs((await dimensions(win)).input.height - baseline.input.height) <= 1, "double-click restores default height");
    await pressKey(win, "ArrowUp");
    await pressKey(win, "Enter");
    assert.ok(Math.abs((await dimensions(win)).input.height - baseline.input.height) <= 1, "Enter restores default height without submitting");
    await evaluate(win, "for (let i = 0; i < 80; i++) document.getElementById('chatResizeHandle').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));");
    await settle(win);
    assert.ok(Math.abs((await dimensions(win)).input.height - 52) <= 1, "minimum height clamps at 52px");

    for (const cleanup of ["pointercancel", "blur"]) {
      const origin = await beginDrag(win);
      const target = await moveDrag(win, origin, -45);
      const active = await dimensions(win);
      assert.equal(active.bodyDragging, true, "native pointerdown activates the global resize cursor");
      assert.equal(active.composerDragging, true, "native pointerdown highlights the handle");
      await evaluate(win, cleanup === "blur" ? "window.dispatchEvent(new Event('blur'))" : `(() => { const p = window.__resizeSmokePointer; document.getElementById('chatResizeHandle').dispatchEvent(new PointerEvent('pointercancel', { pointerId: p.id, clientX: p.x, clientY: p.y, bubbles: true })); })()`);
      await settle(win);
      const stopped = await dimensions(win);
      assertCleanCursor(stopped, baseline, cleanup);
      await moveDrag(win, origin, -80);
      assert.ok(Math.abs((await dimensions(win)).input.height - stopped.input.height) <= 1, `${cleanup} must stop resizing`);
      await endDrag(win, target);
    }

    // Run locking is independent from this purely local layout adjustment.
    await pressKey(win, "Home");
    await pressKey(win, "ArrowDown");
    await evaluate(win, "state.chat.running = true; state.chat.activeRunId = 'fixture-run'; syncChatControlLocks();");
    await settle(win);
    const beforeRunningResize = await dimensions(win);
    await pressKey(win, "ArrowUp");
    const running = await dimensions(win);
    assert.equal(running.running, true); assert.equal(running.agentDisabled, true);
    assert.ok(running.input.height > beforeRunningResize.input.height, "running chat retains presentation-only resizing within the locked toolbar budget");
    assert.ok(Math.abs(running.input.height - Math.min(beforeRunningResize.input.height + 24, beforeRunningResize.valueMax)) <= 1, "running chat respects the available resize budget");
    assertWithinBounds(running, "running chat resize");
    assert.equal(running.draft, draft);
    await evaluate(win, "state.chat.running = false; state.chat.activeRunId = null; syncChatControlLocks();");

    // Large keyboard requests exercise clamp math without moving outside a hidden window.
    await evaluate(win, "for (let i = 0; i < 80; i++) document.getElementById('chatResizeHandle').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));");
    await settle(win);
    const maximum = await dimensions(win);
    assertWithinBounds(maximum, "maximum expansion");
    report.checkpoints.maximum = maximum;
    // A late toolbar/theme row can shrink the stream without resizing either
    // the workbench or composer. Reproduce that independently of motion timers.
    await evaluate(win, `(() => {
      const row = document.createElement('div'); row.id = 'resizeSmokeDynamicRow'; row.setAttribute('aria-hidden', 'true');
      row.style.cssText = 'height:24px;flex:0 0 24px';
      document.querySelector('.chat-workbench').insertBefore(row, document.querySelector('.chat-stream-wrap'));
    })()`);
    await settle(win);
    const withDynamicRow = await dimensions(win);
    assertWithinBounds(withDynamicRow, "late workbench sibling");
    assert.equal(withDynamicRow.valueMax, maximum.valueMax - 24, "late workbench sibling reduces the resize budget by its exact height");
    assert.ok(Math.abs(withDynamicRow.input.height - maximum.input.height + 24) <= 1, "late sibling reclamps an already expanded input");
    await evaluate(win, "document.getElementById('resizeSmokeDynamicRow').remove()");
    await settle(win);
    const afterDynamicRow = await dimensions(win);
    assertWithinBounds(afterDynamicRow, "removed workbench sibling");
    assert.equal(afterDynamicRow.valueMax, maximum.valueMax, "removing the late sibling restores the resize budget");
    assert.ok(Math.abs(afterDynamicRow.input.height - maximum.input.height) <= 1, "removing the late sibling restores the requested input height");
    report.checkpoints.dynamicSibling = withDynamicRow;
    emulate(testCase.height - 180);
    await settle(win);
    const shrunk = await dimensions(win);
    assertWithinBounds(shrunk, "smaller viewport");
    assert.ok(shrunk.input.height <= maximum.input.height + 1, "shrinking the viewport cannot enlarge textarea");
    if (testCase.width > 1120) assert.ok(shrunk.input.height < maximum.input.height - 40, "desktop viewport shrink reclamps the input");
    report.checkpoints.smallerViewport = shrunk;
    if (testCase.width <= 760) await showComposerEnd(win);
    await screenshot(win, `${testCase.id}-short-viewport.png`);
    emulate(testCase.height);
    await settle(win);
    await pressKey(win, "Home");
    await pressKey(win, "ArrowUp");
    await pressKey(win, "ArrowUp");
    const beforeRemount = await dimensions(win);
    assert.equal(await storageSnapshot(win), storageBefore, "resizing must not write localStorage or sessionStorage");

    // Leave during an active drag; route() must remove global hooks and release
    // stale DOM references before a fresh Main Chat mount is installed.
    const remountPointer = await beginDrag(win);
    await evaluate(win, `(async () => {
      window.__resizeSmokeOldHandle = document.getElementById('chatResizeHandle');
      window.__resizeSmokeOldInput = document.getElementById('chatInput');
      PANELS.__resize_smoke = { id: '__resize_smoke', async render(root) { root.innerHTML = '<p id="resizeSmokeAway">Away from Main Chat</p>'; } };
      history.replaceState(null, '', '#__resize_smoke'); await route();
    })()`);
    const away = await evaluate(win, "({ bodyCursor: document.body.style.cursor, bodySelect: document.body.style.userSelect, rootCursor: document.documentElement.style.cursor, rootSelect: document.documentElement.style.userSelect, computedCursor: getComputedStyle(document.body).cursor, computedSelect: getComputedStyle(document.body).userSelect, bodyDragging: document.body.classList.contains('chat-composer-resizing'), composerDragging: window.__resizeSmokeOldHandle.closest('.chat-compose').classList.contains('is-resizing') })");
    assertCleanCursor(away, baseline, "route teardown");
    await evaluate(win, "(async () => { history.replaceState(null, '', '#chat'); await route(); })()");
    await waitForChat(win);
    const remounted = await dimensions(win);
    assert.ok(Math.abs(remounted.input.height - beforeRemount.input.height) <= 1, "temporary height survives same-page remount");
    await evaluate(win, `(() => {
      const old = window.__resizeSmokeOldHandle, p = window.__resizeSmokePointer;
      old.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      old.dispatchEvent(new PointerEvent('pointermove', { pointerId: p.id, clientY: p.y - 100, bubbles: true }));
      document.dispatchEvent(new PointerEvent('pointermove', { pointerId: p.id, clientY: p.y - 150, bubbles: true }));
    })()`);
    await settle(win);
    assert.ok(Math.abs((await dimensions(win)).input.height - remounted.input.height) <= 1, "detached listeners cannot mutate the replacement composer");
    await pressKey(win, "Home");
    const beforeRemountedKey = await dimensions(win);
    assert.ok(beforeRemountedKey.valueMax >= beforeRemountedKey.input.height + 24, "remounted keyboard test needs room for a complete increment");
    await pressKey(win, "ArrowUp");
    assert.ok(Math.abs((await dimensions(win)).input.height - beforeRemountedKey.input.height - 24) <= 1, "remounted handle has exactly one keyboard handler");
    assert.equal(await storageSnapshot(win), storageBefore, "remount must not persist presentation state");
    assert.deepEqual((await dimensions(win)).errors, [], "interactions must not emit runtime errors before reload");
    await endDrag(win, remountPointer);
    await new Promise((resolve) => { win.webContents.once("did-finish-load", resolve); win.webContents.reload(); });
    await waitForChat(win);
    const reloaded = await dimensions(win);
    assert.ok(Math.abs(reloaded.input.height - baseline.input.height) <= 1, "page reload resets temporary height");
    assert.deepEqual(reloaded.errors, [], "no dashboard runtime errors");
    assert.equal(win.isVisible(), false, "smoke must never show or focus the window");
    assert.deepEqual(fixture.requests.filter((request) => !request.startsWith("GET ")), [], "resize must not write to any API");
    report.checkpoints.reloaded = reloaded;
    report.fixtureRequests = fixture.requests; report.blockedExternalRequests = externalRequests;
    fs.writeFileSync(path.join(outputDir, `${testCase.id}.json`), JSON.stringify(report, null, 2));
    console.log(`Composer resize ${testCase.id}: message popover, drag, keyboard, cancellation, running, clamp, remount and reload passed (${testCase.width} × ${testCase.height}, hidden=true)`);
  } catch (error) {
    try { await screenshot(win, `${testCase.id}-failure.png`); report.failureLayout = await dimensions(win); } catch { /* Keep the original assertion. */ }
    report.error = String(error.stack || error);
    report.fixtureRequests = fixture.requests; report.blockedExternalRequests = externalRequests;
    fs.writeFileSync(path.join(outputDir, `${testCase.id}-failure.json`), JSON.stringify(report, null, 2));
    throw error;
  } finally { win.destroy(); await fixture.close(); }
}

app.whenReady().then(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const testCase of cases) await runCase(testCase);
  console.log(`Main Chat real-DOM resize smoke passed. Screenshots: ${outputDir}`);
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
