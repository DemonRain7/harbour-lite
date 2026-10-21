"use strict";
// Real renderer/pointer capture/preload/IPC, entirely isolated from live apps.
const { app, BrowserWindow, Menu, ipcMain, nativeImage } = require("electron");
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { EventEmitter } = require("node:events");
const { OrbController } = require("../companion/orb-controller");
const { RESIZE_EDGES } = require("../companion/orb-geometry");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-orb-resize-"));
app.setPath("userData", dir); app.disableHardwareAcceleration();
const scale = Number(process.argv.find(a => a.startsWith("--scale="))?.slice(8) || 1);
app.commandLine.appendSwitch("force-device-scale-factor", String(scale)); app.on("window-all-closed", () => {});
let c, win, cursor = { x: 300, y: 180 }, area = { x: 0, y: 0, width: 1440, height: 1000 };
let appearance = { theme: "anime-wisteria" }, historyLoads = 0;
const errors = [], sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = path.resolve(__dirname, "../../assets/reports/harbour-orb");
const js = code => win.webContents.executeJavaScript(code, true);
async function until(code) {
  for (let i = 0; i < 100; i++) { if (await js(code)) return; await sleep(20); }
  throw new Error("Timed out: " + code);
}
async function synced() {
  await until(`Math.abs(innerWidth-${c.layout.bounds.width})<=1 && Math.abs(innerHeight-${c.layout.bounds.height})<=1 && Math.abs(document.querySelector('#panel').getBoundingClientRect().width-${c.layout.panel.width})<1`);
  await sleep(40);
}
async function begin(edge) {
  const point = await js(`(() => {const r=document.querySelector('[data-resize="${edge}"]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  cursor = { x: c.layout.bounds.x + point.x, y: c.layout.bounds.y + point.y };
  win.webContents.sendInputEvent({ type: "mouseMove", ...point });
  win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
  await until(`document.body.dataset.resizing==='${edge}'`);
}
async function move(dx, dy) {
  cursor = { x: cursor.x + dx, y: cursor.y + dy };
  win.webContents.sendInputEvent({ type: "mouseMove", button: "left", buttons: ["left"], x: Math.round(cursor.x - c.layout.bounds.x), y: Math.round(cursor.y - c.layout.bounds.y) });
  await sleep(60); await synced();
}
async function finish(cancel = false) {
  if (cancel) win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  else win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: Math.round(cursor.x - c.layout.bounds.x), y: Math.round(cursor.y - c.layout.bounds.y) });
  await until("document.body.dataset.resizing==='none'"); await synced();
}
async function capture(name) {
  fs.mkdirSync(report, { recursive: true }); await sleep(220);
  fs.writeFileSync(path.join(report, `${name}-${scale}x.png`), (await win.webContents.capturePage()).toPNG());
}
async function assertAgentRowSpacing(label) {
  const spacing = await js(`(() => {
    const row = document.querySelector('.conversation-tools').getBoundingClientRect();
    const buttons = [...document.querySelectorAll('#agents .agent')].map(button => button.getBoundingClientRect());
    return buttons.map(button => ({ top: button.top - row.top, bottom: row.bottom - button.bottom,
      center: button.top + button.height / 2 }));
  })()`);
  assert.equal(spacing.length, 2, label);
  for (const button of spacing) {
    assert.ok(button.top >= 7.75 && button.bottom >= 7.75, `${label}: persona highlights need breathing room: ${JSON.stringify(button)}`);
    assert.ok(Math.abs(button.top - button.bottom) <= 1.25, `${label}: balanced insets including the 1px divider`);
  }
  assert.ok(Math.abs(spacing[0].center - spacing[1].center) <= .5, `${label}: persona labels stay aligned`);
}
function prepareController(options) {
  const controller = new OrbController(options);
  controller.chat.load = async () => { historyLoads++; return controller.chat.snapshot(controller.agent); };
  controller.chat.refreshAsks = async () => {};
  return controller;
}
const watchdog = setTimeout(() => { console.error("resize smoke timed out"); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  const screen = Object.assign(new EventEmitter(), { getPrimaryDisplay: () => ({ workArea: area }),
    getDisplayNearestPoint: () => ({ workArea: area }), getCursorScreenPoint: () => cursor });
  const options = { BrowserWindow, screen, Menu, dataDir: dir, hidden: true, deviceId: "resize-fixture",
    getConfig: () => ({ url: "http://127.0.0.1:1" }), getAppearance: () => appearance,
    agents: [{ agentName: "main-elaina", displayName: "Elaina" }, { agentName: "main-aemeath", displayName: "Aemeath" }],
    getAvatar: agent => nativeImage.createFromPath(path.resolve(__dirname, "../../web/assets", agent === "main-elaina" ? "elaina-avatar.png" : "orb/aemeath-avatar-v4.png")).toDataURL() };
  c = prepareController(options); c.anchor = { x: 300, y: 180 };
  ipcMain.handle("desktop:orb-action", (event, data) => c.action(event, data));
  await c.start(); win = c.win;
  win.webContents.on("console-message", d => { if (d.level === "error") errors.push(d.message); });
  c.setConnection("open"); await c.expand(true, false); await synced();
  await assertAgentRowSpacing("default panel");
  const row = c.chat.row(c.agent); row.sessionId = "fixture-session"; row.runId = "fixture-run";
  row.messages = [{ role: "user", content: "把聊天框调到适合阅读的大小。" }, { role: "assistant", content: "可以直接拖动边缘或四角。下次打开时，也会保留你喜欢的尺寸。" }];
  c.publish(); await until("document.querySelector('#messages').textContent.includes('下次打开')");
  await js("document.querySelector('#input').value='这条草稿要保留';document.querySelector('#input').dispatchEvent(new Event('input',{bubbles:true}));window.messageNode=document.querySelector('#messages').firstElementChild;window.arrival=document.querySelector('#panel').getAnimations()[0]");
  const before = historyLoads;
  for (const edge of RESIZE_EDGES) {
    c.panelSize = { width: 420, height: 440 }; c.panelPlacement = null; c.anchor = { x: 440, y: 190 }; c.dock = null; c.reflow(); await synced();
    const old = { ...c.layout.panel };
    await begin(edge); await move(edge.includes("w") ? -60 : 60, edge.includes("n") ? -35 : 35);
    assert.equal(c.layout.panel.width, old.width + (/[ew]/.test(edge) ? 60 : 0), edge);
    assert.equal(c.layout.panel.height, old.height + (/[ns]/.test(edge) ? 35 : 0), edge);
    c.publish(); await finish();
    assert.equal(c.pinned, true); assert.equal(row.runId, "fixture-run");
    assert.equal(await js("document.querySelector('#input').value"), "这条草稿要保留");
    assert.equal(await js("messageNode===document.querySelector('#messages').firstElementChild"), true);
  }
  assert.equal(historyLoads, before, "resizing never reloads the conversation");
  assert.equal(await js("arrival===document.querySelector('#panel').getAnimations()[0]"), true, "release cannot replay the entrance animation");
  const chosen = { ...c.panelSize };
  await begin("se"); await move(60, 20); await finish(true); assert.deepEqual(c.panelSize, chosen);
  await js("document.querySelector('[data-resize=se]').focus()");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
  await until(`document.querySelector('#panel').getBoundingClientRect().width===${chosen.width + 10}`);
  const saved = { ...c.panelSize };
  await capture("resize-expanded");
  await c.expand(false); await c.expand(true, true); await synced();
  assert.equal(c.layout.panel.width, saved.width); assert.equal(c.layout.panel.height, saved.height);
  for (const edge of ["left", "right", "top", "bottom"]) {
    c.panelPlacement = null; c.dock = edge; c.anchor = { x: 720, y: 500 }; c.reflow(); await synced();
    const direction = { left: "e", right: "w", top: "s", bottom: "n" }[edge];
    await begin(direction); await move(direction === "w" ? -20 : 20, direction === "n" ? -20 : 20); await finish();
    assert.equal(c.dock, edge, "resizing away from the attached edge preserves docking");
  }
  const preference = { ...c.panelSize };
  c.dock = null; c.panelPlacement = null; c.panelSize = { width: 320, height: 360 }; c.anchor = { x: 250, y: 180 };
  c.reflow(); await synced();
  await assertAgentRowSpacing("minimum panel");
  await capture("resize-minimum");
  const compact = await js("Object.fromEntries(['.orb-header','.conversation-tools','#currentSession','#conversation','#composer','#progress'].map(s=>[s,document.querySelector(s).getBoundingClientRect().height]))");
  assert.ok(compact['#conversation'] >= 45, "minimum size still leaves a readable message area: " + JSON.stringify(compact));
  assert.equal(await js("document.querySelector('.brand').getBoundingClientRect().right<=document.querySelector('.header-actions').getBoundingClientRect().left"), true);
  c.dock = "bottom"; c.panelSize = preference; c.reflow();
  appearance = { theme: "premium-tungsten" }; c.publish();
  area = { x: -360, y: -100, width: 360, height: 440 }; c.onDisplayChange(); await synced();
  await assertAgentRowSpacing("small dark panel");
  assert.deepEqual(c.panelSize, preference);
  assert.equal(await js("document.querySelector('#composer').getBoundingClientRect().bottom<=innerHeight"), true);
  assert.equal(await js("document.documentElement.scrollWidth<=innerWidth && document.documentElement.scrollHeight<=innerHeight"), true);
  await capture("resize-small-dark");
  c.dispose(); c = prepareController(options); await c.start(); win = c.win; await c.expand(true, true); await synced();
  assert.deepEqual(c.panelSize, preference, "fresh controller restores size from disk, not renderer memory");
  area = { x: 0, y: 0, width: 1440, height: 1000 }; c.onDisplayChange(); await synced();
  assert.equal(c.layout.panel.width, preference.width); assert.equal(c.layout.panel.height, preference.height);
  await c.expand(false); await until("document.querySelector('#panelResize').hidden");
  await until("document.body.dataset.retracting==='false' && document.body.dataset.docked==='true'");
  assert.equal(c.layout.bounds.width, 108, "bottom peek size did not inherit chat dimensions");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, scale, handles: 8, nativePointerCapture: true, savedAfterRelaunch: true,
    fourDocks: true, smallDisplay: true, draftAndTaskIntact: true, backendCalls: 0, report }));
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  clearTimeout(watchdog); c?.dispose();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Isolated Electron cache may still be held. */ }
  app.exit(process.exitCode || 0);
});
