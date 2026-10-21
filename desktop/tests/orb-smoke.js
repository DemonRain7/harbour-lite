"use strict";
// Real Electron renderer + sandboxed preload + native controller. HTTP is an isolated
// fixture: no owner data, live Harbour, model, Bot, desktop capture or paid API is used.
const { app, BrowserWindow, Menu, ipcMain, nativeImage } = require("electron");
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createServer } = require("node:http"), { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");
const { OrbController } = require("../companion/orb-controller");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-orb-smoke-"));
app.setPath("userData", dir); app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1"); app.on("window-all-closed", () => {});
const calls = [], sessions = new Map(), pending = new Map(), opened = [], consoleErrors = [], orbActions = [];
const previewBytes = fs.readFileSync(path.resolve(__dirname, "../../web/assets/elaina-avatar.png"));
let controller, win, sequence = 0, holdSettings = false, releaseSettings, rejectNextConfig = false, appearance = { theme: "anime-wisteria", font: "system" };
const json = (res, value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
const server = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : null, url = new URL(req.url, "http://fixture");
  calls.push({ path: url.pathname, method: req.method, body, auth: req.headers.authorization });
  if (url.pathname.startsWith("/uploads/") || url.pathname === "/api/img-proxy") {
    if (url.pathname.endsWith("missing.png")) { res.writeHead(404); res.end(); return; }
    assert.equal(req.headers.authorization, "Bearer fixture-secret");
    res.writeHead(200, { "Content-Type": "image/png" }); res.end(previewBytes); return;
  }
  if (url.pathname === "/api/conversations/new") {
    const session = { ...body, id: `session-${++sequence}`, messages: [], contextTokens: 200,
      contextLimit: 1000, contextWindow: 1000, compactAtTokens: 800, contextTokenSource: "harbour-estimate", contextModelRef: "mock/fixture" };
    sessions.set(session.id, session); return json(res, { session });
  }
  if (url.pathname === "/api/conversations") {
    const matching = [...sessions.values()].filter(s => s.key === url.searchParams.get("key"));
    return json(res, { enabled: true, activeId: matching.at(-1)?.id, sessions: matching });
  }
  if (url.pathname === "/api/conversations/switch") return json(res, { session: sessions.get(body.id) });
  if (url.pathname === "/api/conversations/explorer") return json(res, { enabled: true,
    sessions: [...sessions.values()].filter(s => s.agentName === url.searchParams.get("agentName")).reverse() });
  if (url.pathname.endsWith('/inputs')) {
    assert.equal(req.method, 'POST'); assert.ok(sessions.has(url.pathname.split('/')[3]));
    assert.ok(['queue', 'steer'].includes(body.mode)); assert.match(body.clientMessageId, /^orb-input-/);
    return json(res, { id: body.clientMessageId, state: 'waiting', mode: body.mode }, 202);
  }
  if (url.pathname.startsWith("/api/conversations/")) {
    const session = sessions.get(url.pathname.split("/").at(-1));
    if (req.method === "PATCH" && rejectNextConfig) { rejectNextConfig = false; return json(res, { error: "fixture unavailable" }, 503); }
    if (req.method === "PATCH") Object.assign(session, body, { contextModelRef: body.modelRef || session.contextModelRef });
    // Match api.ts: a model-only patch clears an incompatible saved effort.
    if (req.method === "PATCH" && body.modelRef === "mock/reasoner" && session.reasoningEffort === "low") delete session.reasoningEffort;
    return json(res, { session });
  }
  if (url.pathname === "/api/upload") return json(res, { attachment: { name: body.name, mime: body.mime, kind: body.kind, size: 4, url: `/uploads/inbound/fixture-${sequence}.png`, path: "private-path" } });
  if (url.pathname === "/api/agent-defaults") {
    const reply = () => json(res, { models: [
    { modelRef: "mock/fixture", model: "离线模型", effortOptions: [{ effort: "low" }, { effort: "high" }] },
    { modelRef: "mock/reasoner", model: "深度思考模型", effort: "medium", effortOptions: [{ effort: "medium" }, { effort: "high" }] },
    ], agents: ["main-elaina", "main-aemeath"].map(name => ({ name, effectiveModelRef: "mock/fixture", effectivePermissionMode: "dontAsk", defaultReasoningEffort: "low" })) });
    if (holdSettings) releaseSettings = reply; else reply(); return;
  }
  if (url.pathname === "/api/run") {
    sessions.get(body.session.id).messages.push({ role: "user", content: body.input, attachments: body.attachments });
    pending.set(body.runId, { body, res }); return;
  }
  if (url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/abort")) {
    const runId = url.pathname.split("/")[3]; assert.ok(pending.has(runId));
    json(res, { aborted: true }); json(pending.get(runId).res, { aborted: true }, 499); pending.delete(runId); return;
  }
  if (url.pathname === "/api/asks") return json(res, { asks: [] });
  if (url.pathname.startsWith("/api/asks/") && url.pathname.endsWith("/answer")) return json(res, { accepted: true });
  json(res, { error: "unexpected fixture request" }, 404);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = async code => {
  try { return await win.webContents.executeJavaScript(code, true); }
  catch (error) { throw new Error(`${error.message}\nRenderer script: ${code}\n${consoleErrors.join("\n")}`); }
};
async function until(code) {
  for (let i = 0; i < 150; i++) { if (await js(code)) return; await sleep(30); }
  throw new Error(`Timed out: ${code}\n${await js("JSON.stringify({body:document.body.innerText,state:document.body.dataset,portrait:document.querySelector('#orbExpression')?.outerHTML,inputs:window.orbInputs})")}\nnative: ${JSON.stringify({connection:controller.connection,revision:controller.stateRevision,loading:win.webContents.isLoadingMainFrame(),actions:orbActions.slice(-20)})}\n${consoleErrors.join("\n")}`);
}
async function click(selector) {
  // Native resize and renderer layout IPC are independent. Wait for Chromium's
  // viewport too, particularly after closing and immediately reopening images.
  await until(`innerWidth===${controller.layout.bounds.width} && innerHeight===${controller.layout.bounds.height}`);
  const point = await js(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
  assert.equal(await js(`!!document.elementFromPoint(${point.x},${point.y})?.closest(${JSON.stringify(selector)})`), true,
    `${selector} is hit-testable: ${await js(`JSON.stringify({point:${JSON.stringify(point)},hit:document.elementFromPoint(${point.x},${point.y})?.outerHTML.slice(0,300),dialog:document.querySelector('#imageViewer').open,panelScroll:document.querySelector('#panel').scrollTop,bodyScroll:document.body.scrollTop,htmlScroll:document.documentElement.scrollTop})`)}`);
  for (const type of ["mouseMove", "mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, ...point, button: "left", clickCount: 1 });
  await sleep(70);
}
async function input(text) {
  await js(`document.querySelector('#input').value=${JSON.stringify(text)}; document.querySelector('#input').dispatchEvent(new Event('input',{bubbles:true}));`);
}
async function enter(modifiers = {}) {
  return js(`(() => {const e=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...${JSON.stringify(modifiers)}});document.querySelector('#input').dispatchEvent(e);return e.defaultPrevented;})()`);
}
function finish(agent, answer) {
  const runId = controller.chat.row(agent).runId, request = pending.get(runId);
  assert.ok(request, "fixture owns the exact pending run");
  const session = sessions.get(request.body.session.id);
  session.messages.push({ role: "assistant", content: answer });
  Object.assign(session, { contextTokens: 700, contextTokenSource: "native-observed" });
  json(request.res, { answer, session }); pending.delete(runId);
}
const report = path.resolve(__dirname, "../../assets/reports/harbour-orb");
async function capture(name) {
  fs.mkdirSync(report, { recursive: true }); await sleep(120);
  fs.writeFileSync(path.join(report, `${name}.png`), (await win.webContents.capturePage()).toPNG());
}
const watchdog = setTimeout(() => { console.error("orb smoke timed out"); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const screen = new EventEmitter(); let area = { x: 0, y: 0, width: 1280, height: 900 }, cursor = { x: 1234, y: 504 };
  screen.getPrimaryDisplay = screen.getDisplayNearestPoint = () => ({ workArea: area });
  screen.getCursorScreenPoint = () => cursor;
  const hoverBall = () => {
    cursor = { x: -9999, y: -9999 }; controller.samplePointer(0); controller.samplePointer(200);
    const { bounds, ball } = controller.layout;
    cursor = { x: bounds.x + ball.x + ball.width / 2, y: bounds.y + ball.y + ball.height / 2 };
    controller.samplePointer(300); controller.samplePointer(600);
  };
  controller = new OrbController({ BrowserWindow, screen, Menu, dataDir: dir, hidden: true,
    getConfig: () => ({ url: `http://127.0.0.1:${server.address().port}`, token: "fixture-secret" }),
    deviceId: "orb-fixture", agents: [{ agentName: "main-elaina", displayName: "Elaina" }, { agentName: "main-aemeath", displayName: "Aemeath" }],
    getAvatar: agent => nativeImage.createFromPath(path.resolve(__dirname, "../../web/assets", agent === "main-aemeath" ? "orb/aemeath-avatar-v4.png" : "elaina-avatar.png")).resize({ width: 128 }).toDataURL(),
    getExpressionAtlas: agent => pathToFileURL(path.resolve(__dirname, "../../web/assets/orb", `${agent.slice(5)}-expressions-${agent === "main-aemeath" ? "v4" : "v2"}.png`)).href,
    desktopActions: { copy: text => { assert.ok(text); }, clipboard: () => ({ text: "A copied sentence." }),
      "capture-sources": () => [{ id: "window:fixture", name: "离线截图示例", preview: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1kAAAAASUVORK5CYII=" }],
      capture: () => ({ name: "capture.png", mime: "image/png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1kAAAAASUVORK5CYII=" }) },
    getAppearance: () => appearance, openConversation: target => opened.push(target), openDashboard: () => opened.push("dashboard"), openSettings: () => {} });
  ipcMain.handle("desktop:orb-action", (event, data) => { orbActions.push(data.action); return controller.action(event, data); });
  await controller.start(); win = controller.win;
  assert.equal(controller.enabled, true); assert.equal(controller.autoStart, true);
  const nativeTopCalls = [], nativeSetTop = win.setAlwaysOnTop.bind(win);
  win.setAlwaysOnTop = value => { nativeTopCalls.push(value); return nativeSetTop(value); };
  win.webContents.on("console-message", details => { if (details.level === "error") consoleErrors.push(details.message); });
  controller.setConnection("open");
  // Offscreen fixture: simulate viewing without showing/focusing a native window.
  await js("Object.defineProperty(document,'hidden',{get:()=>false}); document.hasFocus=()=>true; document.dispatchEvent(new Event('visibilitychange'))");
  await until("document.querySelector('#orbGlyph').textContent==='e'");
  await until("document.querySelector('#orbAvatar').complete && document.querySelector('#orbAvatar').naturalWidth===128");
  await until("!document.querySelector('#orbExpression').hidden && document.body.dataset.emotion==='idle'");
  const stale = { ...controller.snapshot(), stateRevision: 0, connection: "closed", enabled: false };
  win.webContents.send("orb:state", stale); await sleep(30);
  assert.equal(await js("document.body.dataset.online"), "true", "late initial snapshot cannot undo a newer status");
  assert.equal(await js("document.body.dataset.enabled"), "true");
  assert.equal(await js("document.querySelector('#orbAvatar').draggable"), false);
  assert.equal(await js("getComputedStyle(document.querySelector('#orbAvatar')).pointerEvents"), "none");
  assert.equal(await js(`(() => { const e=new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:new DataTransfer()}); document.querySelector('#orbAvatar').dispatchEvent(e); return e.defaultPrevented && e.dataTransfer.items.length===0; })()`), true, "avatar export to another app is blocked");
  assert.equal(await js("document.querySelector('#orbGlyph').hidden"), true);
  assert.equal(await js("typeof window.require"), "undefined");
  assert.equal(await js("typeof window.harbourDesktop"), "undefined", "no broad desktop bridge or credentials");
  assert.equal(calls.length, 0, "collapsed orb makes no model/history request");
  await capture("01-collapsed");
  // Native mouse clicks toggle both ways, including pinned panels. Moving the
  // pointer during the native resize must not immediately undo an explicit close.
  await click("#orb"); await until("document.querySelector('#orb').getAttribute('aria-expanded')==='true'");
  await until("document.querySelector('#runContext').dataset.tone==='unknown'");
  assert.equal(await js("document.querySelector('#runContext').hasAttribute('aria-valuenow')"), false, "unknown context is not a fake zero");
  assert.equal(await js("document.querySelector('#runContext').innerText.trim()"), "", "ring has no visible number or label");
  assert.equal(controller.pinned, true);
  assert.match(await js("document.querySelector('#orb').getAttribute('aria-label')"), /^收起 /);
  await input("保留未发送的草稿");
  await click("#orb"); await until("document.querySelector('#panel').hidden");
  assert.equal(controller.expanded, false); assert.equal(controller.pinned, false); assert.equal(controller.enabled, true);
  await js("document.querySelector('#orb').dispatchEvent(new PointerEvent('pointerenter'))"); await sleep(340);
  assert.equal(controller.expanded, false, "hover under the same pointer cannot bounce open");
  await click("#orb"); await until("!document.querySelector('#panel').hidden");
  assert.equal(await js("document.querySelector('#input').value"), "保留未发送的草稿");
  await input("");
  // A keyboard activation has click.detail=0 but must use the same toggle.
  await js("window.orbInputs=[]; for(const type of ['keydown','keyup','click']) document.addEventListener(type,e=>window.orbInputs.push([e.type,e.key,e.detail,e.target.id]),true)");
  await js("document.querySelector('#orb').focus()");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
  await until("document.querySelector('#panel').hidden");
  await js("document.querySelector('#orb').focus()");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  await until("!document.querySelector('#panel').hidden");
  await click("#collapse"); await until("document.querySelector('#panel').hidden");
  // Send actual Chromium mouse events, not just controller method calls. Avatar
  // movement must start native orb dragging and never Chromium's image drag/drop.
  await js("window.orbNativeDrags=0; document.addEventListener('dragstart',()=>window.orbNativeDrags++)");
  const beforeDrag = { ...controller.anchor }, ball = controller.layout.ball;
  const point = { x: Math.round(ball.x + ball.width / 2), y: Math.round(ball.y + ball.height / 2) };
  win.webContents.sendInputEvent({ type: "mouseMove", ...point });
  win.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 }); await sleep(50);
  assert.ok(controller.drag, "pointerdown reaches custom dragging");
  cursor = { x: cursor.x - 80, y: cursor.y - 10 };
  win.webContents.sendInputEvent({ type: "mouseMove", x: point.x - 15, y: point.y, button: "left" }); await sleep(50);
  win.webContents.sendInputEvent({ type: "mouseUp", x: point.x - 15, y: point.y, button: "left", clickCount: 1 }); await sleep(50);
  assert.equal(controller.drag, null); assert.ok(controller.anchor.x < beforeDrag.x);
  assert.equal(await js("window.orbNativeDrags"), 0, "dragging the avatar never exports an image/file");
  assert.equal(controller.expanded, false, "dragging never becomes a click-open");
  hoverBall();
  await until("!document.querySelector('#panel').hidden");
  assert.equal(controller.pinned, false, "hover opens without pinning/focusing");
  await click("#orb"); await until("document.querySelector('#panel').hidden");
  assert.equal(controller.expanded, false, "clicking a hover preview closes it instead of pinning it");
  hoverBall();
  await until("!document.querySelector('#panel').hidden");
  await capture("02-welcome");
  assert.equal(await js("document.querySelector('#composerHint').hidden && document.querySelector('#composerHint').textContent===''") , true, 'idle composer has no shortcut hint');
  await click("#pin"); assert.equal(controller.pinned, true);
  await click("#alwaysOnTop"); assert.equal(controller.alwaysOnTop, false); assert.equal(win.isAlwaysOnTop(), false);
  assert.equal(controller.pinned, true, "unpinning z-order does not collapse the panel");
  await click("#alwaysOnTop"); assert.equal(controller.alwaysOnTop, true);
  // A never-shown offscreen test window has no desktop z-order. Verify the real
  // native setter receives both values; do not claim cross-app topmost QA here.
  assert.deepEqual(nativeTopCalls, [false, true]);
  assert.equal(await js("document.querySelector('#alwaysOnTop').getAttribute('aria-pressed')"), "true");
  await input("输入法候选确认");
  await js("document.querySelector('#input').dispatchEvent(new CompositionEvent('compositionstart')); document.querySelector('#input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); document.querySelector('#input').dispatchEvent(new CompositionEvent('compositionend'));");
  for (const keys of [{ shiftKey: true }, { shiftKey: true, ctrlKey: true }, { altKey: true }, { keyCode: 229 }, { isComposing: true }]) {
    assert.equal(await enter(keys), false, 'newline/modifiers/IME belong to the input, not the sender');
  }
  assert.equal(await enter({ repeat: true }), true, 'long press is consumed without submitting');
  assert.equal(calls.some(c => c.path === '/api/run'), false, "IME confirmation does not send");
  await input("帮我把今天的安排理一理。"); assert.equal(await enter(), true);
  await until("!document.querySelector('#progress').hidden");
  assert.equal(await js("document.querySelector('#composerHint').hidden && document.querySelector('#composerHint').textContent===''") , true, 'running composer does not restore the shortcut hint');
  for (let i = 0; i < 100 && !pending.size; i++) await sleep(10);
  assert.equal(pending.size, 1);
  await until("document.body.dataset.emotion==='thinking' && !document.querySelector('#orbExpression').hidden && document.querySelector('#orbExpression').dataset.frame==='thinking'");
  assert.equal(await js("getComputedStyle(document.querySelector('#orbExpression')).backgroundSize"), "300% 200%", "thinking stays in the aligned atlas");
  assert.equal(await js("getComputedStyle(document.querySelector('#orbExpression')).backgroundPosition"), "50% 0%");
  const run = [...pending.values()][0].body;
  assert.deepEqual(Object.keys(run).sort(), ["agent", "input", "runId", "session"]);
  for (const [keys, mode] of [[{}, 'queue'], [{ctrlKey:true}, 'steer'], [{metaKey:true}, 'steer']]) {
    await input(`快捷补充 ${mode}`);
    await until("!document.querySelector('#send').disabled");
    const before = calls.filter(c => c.path.endsWith('/inputs')).length;
    assert.equal(await enter(keys), true);
    await until("document.querySelector('#input').value==='' && !document.querySelector('#notice').hidden");
    assert.equal(calls.filter(c => c.path.endsWith('/inputs')).length, before + 1);
    assert.equal(calls.filter(c => c.path.endsWith('/inputs')).at(-1).body.mode, mode);
    assert.equal(pending.size, 1, 'supplement never launches a parallel Main');
    assert.equal(controller.chat.row('main-elaina').localRunId, run.runId);
  }
  await capture("03-working");
  const childEvent = { runId: run.runId, traceId: "child-fixture", parentTraceId: "main-fixture", agent: "trajectory-checker", msg: "loop:end", status: "failed", time: 1000 };
  controller.consume(childEvent); await until("document.body.dataset.emotion==='failed'");
  await capture("15-child-failure");
  // Accelerate the display-only deadline, leaving the actual Main request running.
  controller.chat.row("main-elaina").feedback.entries.get("loop:child-fixture").at = Date.now() - 4800;
  controller.publish(); await until("document.body.dataset.emotion==='thinking'");
  assert.equal(pending.size, 1);
  controller.consume({ ...childEvent, status: "completed", time: 1100 });
  await click("#orb"); await until("document.querySelector('#panel').hidden");
  assert.equal(controller.expanded, false); assert.equal(pending.size, 1, "collapse never cancels the request");
  finish("main-elaina", "先把最重要的一件做完吧。\n\n我会在这里，陪你慢慢整理。需要完整日程时，我们再打开 Harbour。");
  await until("!document.querySelector('#unread').hidden");
  await until("document.body.dataset.emotion==='complete'");
  await capture("14-reply-ready");
  await controller.expand(true, true);
  await until("document.querySelectorAll('.turn').length===2 && document.querySelector('#unread').hidden");
  await until("document.querySelector('#runContext').getAttribute('aria-valuenow')==='70'");
  assert.equal(await js("document.querySelector('#runContext').dataset.tone"), "warm");
  await until("(() => {const e=document.querySelector('#conversation');return e.scrollHeight-e.scrollTop-e.clientHeight<3})()");
  await capture("04-elaina-chat");
  await click("#open"); assert.deepEqual(opened.at(-1), { sessionId: run.session.id, agentName: "main-elaina" });
  await controller.expand(false); controller.publish();
  assert.equal(controller.snapshot().unread, false, "reflow/publish does not make a read response unread again");
  await controller.expand(true, true);
  await until("!document.querySelector('#panel').hidden && innerWidth===410");
  await input("未发送的 Elaina 草稿"); await click("#agents .agent:nth-child(2)");
  await until("document.querySelector('#orbGlyph').textContent==='a'");
  await until("document.querySelector('#orbExpression').dataset.source.includes('aemeath-expressions') && !document.querySelector('#orbExpression').hidden");
  assert.equal(await js("document.querySelector('#input').value"), "");
  appearance = { theme: "anime-snowfleece", font: "rounded" }; controller.publish();
  await input("稍后陪我去小镇散步吧。"); await click("#send");
  await until("!document.querySelector('#progress').hidden");
  await until("document.body.dataset.emotion==='thinking' && !document.querySelector('#orbExpression').hidden && document.querySelector('#orbExpression').dataset.frame==='thinking' && document.querySelector('#orbExpression').dataset.source.includes('aemeath-expressions-v4')");
  await capture("16-aemeath-thinking");
  const row = controller.chat.row("main-aemeath");
  const ask = { id: "ask-fixture", channel: "web", sessionKey: row.key, question: "你想在哪里见面？", detail: "只是询问选择，不会自动执行操作。",
    options: [{ label: "咖啡厅", value: "cafe" }, { label: "车站", value: "station" }], expiresAt: new Date(Date.now() + 60000).toISOString() };
  controller.consume({ __harbour: "ask", kind: "new", ask });
  await until("!document.querySelector('#ask').hidden");
  await until("document.body.dataset.emotion==='waiting'");
  await capture("05-aemeath-ask");
  assert.equal(calls.some(c => c.path.endsWith("/answer")), false);
  await click("#ask button");
  assert.equal(calls.filter(c => c.path.endsWith("/answer")).length, 1);
  assert.deepEqual(calls.find(c => c.path.endsWith("/answer")).body, { answer: "cafe" });
  await until("document.querySelector('#ask').hidden");
  // A task on another persona must not disable the selected persona's independent draft.
  await click("#agents .agent:first-child");
  await until("document.querySelector('#input').value==='未发送的 Elaina 草稿'");
  assert.equal(await js("document.querySelector('#send').disabled"), false);
  finish("main-aemeath", "那就咖啡厅见，慢慢来。 ✦");
  await until("document.querySelector('#agents .agent:nth-child(2)').dataset.unread==='true'");
  await click("#agents .agent:nth-child(2)");
  await until("document.querySelectorAll('.turn').length===2");
  await capture("06-aemeath-chat");
  await click("#open"); assert.equal(opened.at(-1).agentName, "main-aemeath"); assert.equal(opened.at(-1).sessionId, row.sessionId);
  await click("#history"); await until("document.querySelector('.drawer-item')?.dataset.active==='true'"); await capture("10-history"); await click("#drawerClose");
  const settingsRuns = calls.filter(c => c.path === "/api/run").length;
  await input("设置不应吃掉这份草稿");
  await click("#runSettings");
  await until("!!document.querySelector('.rp-range') && !document.querySelector('.rp-range').disabled");
  const initialPatches = calls.filter(c => c.method === "PATCH").length;
  const effort = async value => {
    await js(`(() => {const s=document.querySelector('.rp-range');s.value=${value};s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await js("document.querySelector('.rp-range').dispatchEvent(new Event('change',{bubbles:true}))");
    await until("document.querySelector('.run-picker-popup').getAttribute('aria-busy')==='false' && !document.querySelector('.rp-range').disabled");
  };
  const chooseModel = async value => {
    await click(".rp-model-link"); await click(`.rp-option[data-value="${value}"]`);
    await until("document.querySelector('.run-picker-popup').dataset.view==='effort' && !document.querySelector('.rp-range').disabled");
  };
  await capture("29-picker-effort");
  assert.equal(calls.filter(c => c.method === "PATCH").length, initialPatches, "opening controls does not save defaults");
  await effort(0); await chooseModel("mock/reasoner");
  assert.equal(controller.chat.row('main-aemeath').config.reasoningEffort || "", "", "model change resets unsupported effort via the server receipt");
  assert.equal(await js("document.querySelector('.rp-range').max"), "1", "only two real model effort levels");
  await effort(1); await chooseModel("mock/fixture");
  assert.equal(controller.chat.row('main-aemeath').config.reasoningEffort, "high", "compatible effort survives a model change");
  await chooseModel("mock/reasoner");
  await click(".rp-model-link"); await capture("30-picker-models"); await click('[data-key="back"]');
  await click("#runMode"); await capture("11-settings");
  await click('.rp-option[data-value="plan"]'); await until("document.querySelector('.run-picker-popup').hidden");
  assert.equal(controller.chat.row('main-aemeath').config.permissionMode, 'plan');
  assert.deepEqual(calls.filter(c => c.method === "PATCH").at(-1), { path: `/api/conversations/${row.sessionId}`, method: "PATCH",
    body: { permissionMode: "plan" }, auth: "Bearer fixture-secret" });
  assert.equal(await js("document.querySelector('#runModel').textContent"), "深度思考模型");
  assert.equal(await js("document.querySelector('#input').value"), "设置不应吃掉这份草稿");
  await click("#runMode"); await until("!!document.querySelector('.rp-option[data-value=dontAsk]')");
  rejectNextConfig = true; await click('.rp-option[data-value="dontAsk"]');
  await until("document.querySelector('.rp-note').textContent.includes('503') && !document.querySelector('.rp-option').disabled");
  assert.equal(controller.chat.row('main-aemeath').config.permissionMode, 'plan', "failed save keeps displayed configuration");
  await click('.rp-option[data-value="dontAsk"]'); await until("document.querySelector('.run-picker-popup').hidden");
  assert.deepEqual(calls.filter(c => c.method === "PATCH").at(-1).body, { permissionMode: "dontAsk" }, "untouched model/effort never overwrite concurrent defaults");
  assert.equal(calls.filter(c => c.path === "/api/run").length, settingsRuns, "settings and context cost no model calls");
  holdSettings = true; await click("#runSettings");
  for (let i = 0; i < 100 && !releaseSettings; i++) await sleep(10);
  assert.equal(typeof releaseSettings, "function");
  await click("#agents .agent:first-child"); await until("document.querySelector('#orbGlyph').textContent==='e'");
  holdSettings = false; releaseSettings(); await sleep(70);
  assert.equal(await js("document.querySelector('.run-picker-popup').hidden"), true, "late settings response never reopens the old persona editor");
  await click("#agents .agent:nth-child(2)"); await until("document.querySelector('#orbGlyph').textContent==='a'");
  // Real paste event/FileReader/IPC/upload path; the image bytes are synthetic.
  await input("");
  await js(`(() => { const d=new DataTransfer(); d.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1kAAAAASUVORK5CYII='),c=>c.charCodeAt(0))], 'pasted.png',{type:'image/png'})); document.querySelector('#input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true})); })()`);
  await until("document.querySelector('.attachment-chip')?.dataset.status==='ready' && !document.querySelector('#send').disabled");
  await capture("12-pasted-image");
  await click("#agents .agent:first-child"); await until("document.querySelector('#orbGlyph').textContent==='e'");
  assert.equal(await js("document.querySelector('#attachments').hidden"), true, "Aemeath attachment stays out of Elaina draft");
  await click("#agents .agent:nth-child(2)"); await until("!document.querySelector('#attachments').hidden");
  await click("#send"); await until("!document.querySelector('#progress').hidden");
  await click("#runSettings"); await until("!!document.querySelector('.rp-range')");
  assert.equal(await js("document.querySelector('.rp-range').disabled && document.querySelector('.rp-reset').disabled"), true, "in-flight task settings are read-only");
  await click('.run-picker-popup [data-key="close"]');
  const attachmentRun = [...pending.values()][0].body;
  assert.equal(attachmentRun.agent, "main-aemeath"); assert.equal(attachmentRun.attachments[0].name, "pasted.png"); assert.equal(attachmentRun.attachments[0].path, undefined);
  await until("document.querySelector('#attachments').hidden");
  await input('图片后继续补充，不重复带图'); await until("!document.querySelector('#send').disabled");
  await enter({ctrlKey:true}); await until("document.querySelector('#input').value===''");
  assert.equal(calls.filter(c => c.path.endsWith('/inputs')).at(-1).body.attachments.length, 0, 'submitted image is not silently attached again');
  finish("main-aemeath", "图片已收到，这是离线回执。");
  await until("document.querySelector('#attachments').hidden && document.querySelector('#progress').hidden");
  await click("#capture"); await until("!!document.querySelector('.capture-source')"); await capture("13-capture-picker"); await click(".capture-source");
  await until("document.querySelector('.attachment-chip')?.dataset.status==='ready'");
  assert.equal(pending.size, 0, "capture is only a draft attachment, never auto-sends");
  await click(".remove-file"); await until("document.querySelector('#attachments').hidden");
  await click("#more"); await until("document.querySelectorAll('.drawer-item').length===6"); await click(".drawer-item:nth-child(4)");
  await until("document.querySelector('#input').value.includes('请翻译以下文字')"); assert.equal(pending.size, 0, "translation is a draft, not an implicit paid call");
  appearance = { theme: "premium-tungsten", font: "system" }; controller.publish(); await capture("07-dark");
  await input("中止这项测试任务"); await click("#send");
  await until("!document.querySelector('#progress').hidden"); await click("#stop");
  await until("document.querySelector('#notice').textContent.includes('已停止')");
  await until("document.body.dataset.emotion==='idle'");
  assert.equal(pending.size, 0); assert.equal(calls.filter(c => c.path.endsWith("/abort")).length, 1);
  await controller.setEnabled(false); await controller.setEnabled(true);
  assert.equal(controller.win, win, "hide/reopen reuses its renderer and chat lifetime");
  assert.equal(controller.layout.expanded, false); assert.equal(win.getBounds().width, 88);
  cursor = { ...controller.anchor }; controller.startDrag(); cursor = { x: 1280, y: 510 }; controller.moveDrag(); controller.endDrag();
  assert.equal(controller.dock, "right"); assert.equal(controller.layout.bounds.width, 68);
  await capture("08-docked");
  await controller.setEnabled(false); await controller.setEnabled(true);
  assert.equal(controller.dock, null); assert.equal(controller.layout.bounds.width, 88, "tray reopen reveals ball rather than edge tab");
  area = { x: -360, y: 0, width: 360, height: 460 }; screen.emit("display-removed");
  await controller.expand(true, true);
  await until("!document.querySelector('#panel').hidden && innerWidth===360");
  assert.equal(await js("document.documentElement.scrollWidth<=innerWidth"), true);
  assert.equal(await js("document.querySelector('#composer').getBoundingClientRect().bottom<=innerHeight"), true);
  assert.equal(await js("document.querySelector('.brand').getBoundingClientRect().right <= document.querySelector('.header-actions').getBoundingClientRect().left"), true, "top toggle fits even on a narrow screen");
  await click("#alwaysOnTop"); assert.equal(win.isAlwaysOnTop(), false);
  await capture("09-small-display");
  await click("#runSettings"); await until("!!document.querySelector('.rp-range')");
  await capture("28-settings-small-dark");
  const settingsFit = await js("(() => {const b=document.querySelector('.run-picker-popup'),d=b.getBoundingClientRect();return {top:d.top,right:d.right,bottom:d.bottom,width:innerWidth,height:innerHeight,scroll:b.scrollWidth,client:b.clientWidth};})()");
  assert.ok(settingsFit.top>=0 && settingsFit.right<=settingsFit.width && settingsFit.bottom<=settingsFit.height && settingsFit.scroll<=settingsFit.client, `settings fit a narrow, short screen: ${JSON.stringify(settingsFit)}`);
  await click('.run-picker-popup [data-key="close"]');
  win.close(); await sleep(50);
  assert.equal(win.isDestroyed(), false); assert.equal(controller.enabled, false);
  await until("document.body.dataset.enabled==='false'");
  assert.equal(await js("getComputedStyle(document.querySelector('.orb-aura')).animationPlayState"), "paused");
  await controller.setEnabled(true); await until("document.body.dataset.enabled==='true'");
  assert.equal(controller.win, win); assert.equal(win.isAlwaysOnTop(), false);
  controller.setConnection("closed"); await until("document.body.dataset.online==='false' && document.body.dataset.emotion==='idle'");
  controller.setConnection("open"); await until("document.body.dataset.emotion==='idle'");
  // OS reduced-motion preference disables the blink, not just the spinning ring.
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  assert.equal(await js("getComputedStyle(document.querySelector('#orbExpression')).animationName"), "none");
  win.webContents.debugger.detach();
  const person = controller.agents.find(a => a.agentName === controller.agent), atlas = person.expressionAtlas;
  person.expressionAtlas = person.avatar; controller.publish(); await sleep(100);
  assert.equal(await js("document.querySelector('#orbExpression').hidden && !document.querySelector('#orbAvatar').hidden"), true, "invalid tile layout falls back to original portrait");
  person.expressionAtlas = atlas; controller.publish(); await until("!document.querySelector('#orbExpression').hidden");
  // Age a fixture reply near its deadline so the actual renderer timer runs,
  // without waiting eight seconds or making a fresh model request.
  const originalPhase = row.phase, requestCount = calls.length;
  row.phase = "complete"; row.replyReadyAt = Date.now() - 7800;
  controller.publish(); await until("document.body.dataset.emotion==='complete'");
  await until("document.body.dataset.emotion==='idle'");
  assert.equal(calls.length, requestCount, "expression reset has no API/token cost");
  assert.equal(row.phase, "complete", "only the visual changes");
  await controller.setEnabled(false); await controller.setEnabled(true);
  await until("document.body.dataset.emotion==='idle'");
  assert.equal(controller.autoStart, true, "hiding does not change startup preference");
  row.phase = originalPhase; row.replyReadyAt = 0; controller.publish();
  // Confirmed final failure is different from offline/unknown; fixture HTTP still
  // owns its lifetime and no retry is triggered by the new expression projection.
  await controller.expand(true, true); await input("离线失败回执测试"); await click("#send");
  await until("document.body.dataset.busy==='true'");
  const failedId = row.runId;
  controller.consume({ __harbour: "channel-activity", runId: failedId, sessionId: row.sessionId, agent: row.agent, phase: "error" });
  json(pending.get(failedId).res, { error: "fixture task failed" }, 500); pending.delete(failedId);
  await until("document.body.dataset.emotion==='failed' && document.body.dataset.busy==='false'");
  await input("不能自动重试"); assert.equal(await js("document.querySelector('#send').disabled"), true);
  await capture("17-final-failure");
  await click("#new"); await until("document.body.dataset.emotion==='idle'");
  assert.equal(row.feedback.snapshot(), null);
  // Reply pictures go through the real, authenticated binary IPC route. Both
  // personas and restored history use the same bubble; no fixture model is paid.
  area = { x: 0, y: 0, width: 1280, height: 900 }; controller.anchor = { x: 1230, y: 830 }; controller.reflow();
  const picturesAnswer = "给你留了一张**小小的纪念**。\n\n![图片预览示例](/uploads/reply.png)\n\n点开就能放大看。";
  for (const [nth, persona, theme] of [[2, "main-aemeath", "anime-snowfleece"], [1, "main-elaina", "anime-wisteria"]]) {
    await click(`#agents .agent:nth-child(${nth})`); await until(`document.querySelector('#agents .agent:nth-child(${nth})').getAttribute('aria-pressed')==='true'`);
    await until("!document.querySelector('#new').disabled");
    await click("#new"); await until("!!document.querySelector('.welcome') && !document.querySelector('#new').disabled");
    appearance = { theme, font: "system" }; controller.publish();
    await input("给我看看图片吧。"); await click("#send"); await until("document.body.dataset.busy==='true'");
    finish(persona, picturesAnswer);
    await until("document.querySelector('.reply-image')?.dataset.state==='ready' && document.querySelector('.reply-picture').naturalWidth>0");
    assert.equal(await js("getComputedStyle(document.querySelector('.turn.assistant .reply-bubble')).borderTopLeftRadius"), "5px");
    assert.equal(await js("document.querySelector('.turn.assistant strong').textContent"), "小小的纪念");
    assert.equal(await js("document.querySelector('.reply-picture').src.startsWith('blob:')"), true);
    assert.equal(await js("document.body.innerHTML.includes('fixture-secret')"), false);
    const reads = calls.filter(c => c.path === "/uploads/reply.png").length;
    controller.publish(); controller.publish();
    await sleep(80);
    assert.equal(calls.filter(c => c.path === "/uploads/reply.png").length, reads, "ordinary progress/appearance refresh does not download again");
    await js("document.querySelector('.image-open').scrollIntoView({block:'center'})");
    await capture(`18-${persona}-image-bubble`);
    await click(".image-open"); await until("document.querySelector('#imageViewer').open && document.querySelector('#imageOriginal').naturalWidth>0");
    assert.equal(await js("document.querySelector('#imageOriginal').getBoundingClientRect().width <= document.querySelector('#imageViewer').clientWidth"), true);
    await click("#imageZoom"); assert.equal(await js("document.querySelector('#imageViewer').dataset.zoomed"), "true");
    await capture(`19-${persona}-image-zoom`);
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    assert.equal(await js("document.querySelector('#imageViewer').open"), false);
    assert.equal(controller.expanded, true, "first Esc closes only preview");
    await controller.expand(false); await until("document.querySelector('#panel').hidden");
    await controller.expand(true, true);
    await until("!document.querySelector('#panel').hidden && !document.querySelector('#new').disabled && document.querySelector('.reply-image')?.dataset.state==='ready'");
    assert.equal(calls.filter(c => c.path === "/uploads/reply.png").length, reads, "reopened history reuses bounded image cache");
    assert.equal(controller.chat.row(persona).messages.at(-1).content, picturesAnswer);
  }
  appearance = { theme: "premium-tungsten", font: "system" }; controller.publish(); await capture("20-dark-image-bubble");
  await input("坏图也不要把回复弄没了"); await click("#send"); await until("document.body.dataset.busy==='true'");
  finish("main-elaina", '![失效图片](/uploads/missing.png)\n<img src=x onerror="alert(1)">\n原回答仍然保留。');
  await until("document.querySelector('.turn:last-child .reply-image')?.dataset.state==='error'");
  assert.equal(await js("document.querySelectorAll('.turn:last-child img[src=x]').length"), 0, "reply HTML stays text");
  assert.equal(await js("document.querySelector('.turn:last-child').innerText.includes('原回答仍然保留')"), true);
  await js("document.querySelector('.turn:last-child .image-caption button').scrollIntoView({block:'center'})");
  await click(".turn:last-child .image-caption button");
  assert.equal(opened.at(-1).agentName, "main-elaina");
  assert.equal(opened.at(-1).sessionId, controller.chat.row("main-elaina").sessionId);
  await capture("21-image-error");
  // Main Chat continues the exact orb session. Its existing WS events must update
  // this renderer without sending a second /api/run or stealing a local handle.
  appearance = { theme: "anime-wisteria", font: "system" }; controller.publish();
  await input("球里的草稿要保留");
  const mirrorRow = controller.chat.row("main-elaina"), beforeMirrorRuns = calls.filter(c => c.path === "/api/run").length;
  const mirror = { __harbour: "channel-activity", agent: mirrorRow.agent, phase: "running", runId: "dashboard-mirror-1",
    sessionId: mirrorRow.sessionId, sessionKey: mirrorRow.key, source: { platform: "web", scope: "web" },
    startedAt: Date.now(), input: "在 Harbour 主窗口继续的这一问", task: "在 Harbour 主窗口继续的这一问" };
  await click("#runSettings"); await until("!!document.querySelector('.rp-range')");
  assert.equal(await js("document.querySelector('.rp-range').disabled"), false);
  controller.consume(mirror);
  await until("document.body.dataset.busy==='true' && document.querySelector('.turn:last-child').innerText.includes('在 Harbour 主窗口继续的这一问')");
  assert.equal(await js("document.querySelector('.rp-range').disabled"), true, "a Main Chat run locks an already open settings editor");
  await click('.run-picker-popup [data-key="close"]');
  await until("!document.querySelector('#send').disabled");
  assert.equal(await js("document.querySelector('#stop').disabled"), true);
  assert.equal(await js("document.querySelector('#input').value"), "球里的草稿要保留");
  await input('从球里补充主窗口的当前任务'); await enter({ctrlKey:true});
  await until("document.querySelector('#input').value==='' && !document.querySelector('#notice').hidden");
  assert.equal(calls.filter(c => c.path.endsWith('/inputs')).at(-1).path, `/api/conversations/${mirror.sessionId}/inputs`);
  assert.equal(calls.filter(c => c.path.endsWith('/inputs')).at(-1).body.mode, 'steer');
  await input('球里的草稿要保留');
  controller.consume({ runId: mirror.runId, agent: mirror.agent, msg: "loop:tool-calls", calls: ["read_file"], time: Date.now() });
  await until("document.querySelector('#phase').textContent.includes('read_file')");
  controller.consume({ runId: mirror.runId, agent: "browser_controller", msg: "loop:thinking", time: Date.now() });
  await until("document.querySelector('#phase').textContent.includes('browser_controller')");
  await capture("22-main-chat-live-sync");
  await click("#collapse"); await until("document.querySelector('#panel').hidden");
  sessions.get(mirror.sessionId).messages.push({ role: "user", content: mirror.input },
    { role: "assistant", content: "主窗口的回复也同步回来。\n![同步图片](/uploads/mirrored.png)", runRecord: { attemptId: mirror.runId, status: "answered" } });
  sessions.get(mirror.sessionId).contextTokens = 820;
  controller.consume({ ...mirror, phase: "complete" }); await mirrorRow.syncing;
  await until("!document.querySelector('#unread').hidden && document.body.dataset.busy==='false'");
  await click("#orb"); await until("!document.querySelector('#panel').hidden && document.querySelector('.turn:last-child .reply-image')?.dataset.state==='ready'");
  assert.equal(await js("document.querySelector('#runContext').dataset.tone"), "compact", "external reply refreshes the same session ring");
  assert.equal(await js("document.querySelector('#runContext').getAttribute('aria-valuenow')"), "82");
  assert.equal(await js("[...document.querySelectorAll('.turn.user')].filter(n=>n.innerText.includes('在 Harbour 主窗口继续的这一问')).length"), 1);
  assert.equal(await js("document.querySelector('#input').value"), "球里的草稿要保留");
  await capture("23-main-chat-reply-sync");
  controller.consume(mirror); await sleep(30);
  assert.equal(mirrorRow.runId, null, "replayed start never reopens a finished mirror task");
  assert.equal(calls.filter(c => c.path === "/api/run").length, beforeMirrorRuns, "mirroring never submits a model request");
  // Shared history: no private orb-only island, and no 40-message data loss.
  const historyRuns = calls.filter(c => c.path === "/api/run").length;
  sessions.set("shared-long", { id: "shared-long", agentName: "main-elaina", key: "web:default:main-elaina", channel: "web",
    title: "Main Chat 的长对话", summary: "更早内容的原有摘要", messages: Array.from({ length: 122 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user", content: `历史第 ${i} 条 · 仍在同一段对话中。`,
    })) });
  sessions.set("shared-qq", { id: "shared-qq", agentName: "main-elaina", key: "qq:bot:dm:owner", channel: "qq",
    title: "QQ 的旧对话", messages: [{ role: "assistant", content: "这条原渠道历史也能看到了。" }] });
  await click("#currentSession"); await until("!!document.querySelector('.history-search')");
  assert.equal(await js("!!document.querySelector('[data-session-id=shared-long]') && !!document.querySelector('[data-session-id=shared-qq]')"), true);
  assert.equal(await js("document.querySelector('[data-session-id=shared-qq] .session-source').textContent"), "QQ");
  await capture("24-shared-history");
  await js("const search=document.querySelector('.history-search'); search.value='长对话'; search.dispatchEvent(new Event('input'))");
  assert.equal(await js("document.querySelectorAll('.history-item').length"), 1);
  await click("[data-session-id=shared-long]");
  await until("document.querySelector('#drawer').hidden && document.querySelectorAll('.turn').length===40");
  assert.equal(await js("document.querySelector('#sessionTitle').textContent"), "Main Chat 的长对话");
  assert.equal(controller.chat.row("main-elaina").messages.length, 122);
  assert.equal(await js("document.querySelector('#runContext').dataset.tone"), "unknown", "a different history cannot inherit the previous context fill");
  assert.equal(await js("document.querySelector('#input').value"), "", "drafts do not leak into another session");
  await input("长对话的未发送草稿");
  await js("document.querySelector('#conversation').scrollTop=0"); await sleep(40);
  const anchorBefore = await js("document.querySelector('[data-message-index=\"82\"]').getBoundingClientRect().top");
  await click(".history-more"); await until("document.querySelectorAll('.turn').length===80");
  const anchorAfter = await js("document.querySelector('[data-message-index=\"82\"]').getBoundingClientRect().top");
  assert.ok(Math.abs(anchorAfter-anchorBefore)<3, `older messages preserve the reading position: ${anchorBefore} → ${anchorAfter}`);
  for (let i=0;i<2;i++) { await js("document.querySelector('#conversation').scrollTop=0"); await sleep(30); await click(".history-more"); }
  await until("document.querySelectorAll('.turn').length===122 && !document.querySelector('.history-more')");
  assert.match(await js("document.querySelector('.turn').textContent"), /历史第 0 条/);
  assert.match(await js("document.querySelector('.history-summary').textContent"), /更早内容的原有摘要/);
  await js("document.querySelector('#conversation').scrollTop=0"); await capture("25-complete-history");
  await click("#history"); await until("!!document.querySelector('[data-session-id=shared-qq]')");
  await click("[data-session-id=shared-qq]"); await until("document.querySelector('#sessionAccess').textContent==='只读' && document.querySelector('#drawer').hidden");
  assert.equal(await js("document.querySelector('#send').disabled && document.querySelector('#input').disabled && document.querySelector('#attach').disabled"), true);
  assert.equal(await js("document.querySelector('#runSettings').disabled"), true, "channel mirrors retain original configuration permissions");
  assert.equal(await js("document.querySelectorAll('.turn').length"), 1);
  await capture("26-channel-history-readonly");
  const qqRow = controller.chat.row('main-elaina');
  const qqRun = { __harbour: 'channel-activity', agent: qqRow.agent, sessionId: qqRow.sessionId,
    sessionKey: qqRow.key, source: { platform: 'qq' }, runId: 'qq-formal-fixture', phase: 'running',
    startedAt: Date.now(), input: 'QQ 正式任务' };
  controller.consume(qqRun); await qqRow.syncing;
  await until("document.body.dataset.busy==='true'");
  controller.consume({ ...qqRun, runId: 'qq-intake-fixture', phase: 'incoming', input: 'QQ 追加补充', startedAt: undefined });
  const { sessionId: qqId, ...qqHandoff } = qqRun;
  controller.consume({ ...qqHandoff, runId: 'qq-intake-fixture', phase: 'cancelled', intakeHandoff: true });
  assert.equal(qqRow.runId, qqRun.runId);
  await click('#collapse'); await until("document.querySelector('#panel').hidden");
  sessions.get(qqId).messages.push({ role: 'user', content: qqRun.input },
    { role: 'assistant', content: 'QQ 正式任务与补充已完成。', runRecord: { attemptId: qqRun.runId, status: 'answered' } });
  controller.consume({ ...qqRun, phase: 'complete' }); await qqRow.syncing;
  await until("document.body.dataset.busy==='false'");
  await click('#orb'); await until("!document.querySelector('#panel').hidden && document.querySelector('.turn:last-child').textContent.includes('QQ 正式任务与补充已完成')");
  assert.equal(qqRow.runId, null);
  assert.equal(await js("document.querySelector('#input').disabled"), true);
  await capture('27-channel-complete-after-supplement');
  await click("#history"); await until("!!document.querySelector('[data-session-id=shared-long]')");
  await click("[data-session-id=shared-long]"); await until("document.querySelector('#drawer').hidden && !document.querySelector('#input').disabled");
  assert.equal(await js("document.querySelector('#input').value"), "长对话的未发送草稿");
  assert.equal(calls.filter(c => c.path === "/api/run").length, historyRuns, "browsing/expanding history never runs a model");
  assert.ok(!calls.some(c => c.path === "/api/conversations/switch" && c.body?.id === "shared-qq"), "read-only browsing never changes the QQ active session");
  assert.equal(await js("document.documentElement.scrollWidth<=innerWidth"), true);
  assert.ok(calls.every(c => c.auth === "Bearer fixture-secret"));
  assert.ok(!JSON.stringify(controller.snapshot()).includes("fixture-secret"));
  assert.equal(consoleErrors.length, 0, consoleErrors.join("\n"));
  console.log("ORB_SMOKE_OK: compact settings/context ring, model-compatible effort, exact-session diff save, running lock/late-response isolation, narrow/dark settings; shared history/drafts/channel read-only, Main Chat mirror, toggle/hover, images, expressions, drag/topmost/docking, paste/upload, asks/abort; 0 live Harbour APIs/models");
}).then(() => cleanup(0), error => { console.error(error); cleanup(1); });
function cleanup(code) {
  clearTimeout(watchdog); controller?.dispose(); server.closeAllConnections(); server.close();
  // Only this test's mkdtemp-owned directory. Electron may still lock its cache on Windows.
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* OS reclaims the temporary cache later. */ }
  app.exit(code);
}
