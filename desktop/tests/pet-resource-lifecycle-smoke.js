"use strict";

// Real production pet windows/preload/IPC, local Live2D assets and dashboard. Only
// bootstrap (tray/services/owner profile) is excluded; no production backend or TTS.
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { WebSocketServer } = require("ws");
const { resolveCharacterHome } = require("../companion/platform-paths");
const { RemoteTtsClient } = require("../companion/remote-tts-client");
const { CompanionStateStore } = require("../companion/companion-state");
const { defaultManifest } = require("../companion/character-store");
const installedCharacters = resolveCharacterHome();
const root = path.resolve(__dirname, "../..");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-pet-resources-"));
const baseline = process.argv.includes("--baseline");
app.setPath("userData", fixture);
app.commandLine.appendSwitch("disable-background-networking");
process.env.HARBOUR_DATA_HOME = fixture;
process.env.HARBOUR_CHARACTER_HOME = path.join(fixture, "characters");
process.env.HARBOUR_CONFIG = path.join(fixture, "config.json");
process.env.HARBOUR_URL = "http://127.0.0.1:1";
process.env.HARBOUR_TOKEN = "";
process.env.HARBOUR_PET = "1";
process.env.HARBOUR_PETS = "elaina,aemeath";
process.env.HARBOUR_SPAWN = "0";
process.env.HARBOUR_LIVE2D_AUTO_INSTALL = "0";
fs.writeFileSync(process.env.HARBOUR_CONFIG, "{}");

const mainPath = path.join(root, "desktop/main.js");
const source = fs.readFileSync(mainPath, "utf8");
const bootstrapBoundary = source.indexOf("// Desktop bootstrap entry");
assert.ok(bootstrapBoundary > 0);
const cleanupBoundary = source.indexOf("async function cleanupDesktop()");
assert.ok(cleanupBoundary > bootstrapBoundary);
const production = new Module(mainPath, module);
production.filename = mainPath;
production.paths = Module._nodeModulePaths(path.dirname(mainPath));
production._compile(source.slice(0, bootstrapBoundary) + source.slice(cleanupBoundary) + `
module.exports = {
  createPetWindow, createDashboardWindow, registerCharacterProtocol, petWindows, petRuntime,
  sendToPets, startPetCursorTracking, petPositionPath,
  closePetWindow: typeof closePetWindow === 'function' ? closePetWindow : null,
  get cursorTracking() { return petCursorTimer !== null; },
  get focus() { return audioFocus; },
  set focus(value) { audioFocus = value; },
  install(url, characters, tts, state) {
    cfg.url = url; characterStore = characters; ttsClient = tts; companionState = state;
    musicStore = {}; qqMusicBridge = {}; stickerStore = {};
  },
  installFolia(value) { folia = value; },
};`, mainPath);
const runtime = production.exports;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 15000) {
  const until = Date.now() + timeout;
  do { if (await check()) return; await pause(50); } while (Date.now() < until);
  throw new Error(`Timeout: ${label}`);
}
const manifests = new Map();
for (const id of ["elaina", "aemeath"]) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(installedCharacters, id, "manifest.json"), "utf8")); }
  catch { manifest = defaultManifest({ id, agentName: `main-${id}`, displayName: id }); }
  manifests.set(id, manifest);
}
const useLive2d = manifests.get("elaina").visual?.live2d?.enabled === true;
const states = new CompanionStateStore();
let pendingTts = 0, totalTts = 0;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/api/companion/tts" && req.method === "POST") {
    pendingTts++; totalTts++;
    res.once("close", () => pendingTts--);
    return; // Deliberately pending until the client cancels, never calls a provider.
  }
  if (url.pathname.startsWith("/api/")) {
    const agent = { name: "main-elaina", taskType: "main", tools: [], skills: [] };
    const payload = url.pathname === "/api/companion/tts/status" ? { configured: true }
      : url.pathname === "/api/state" ? { agents: [agent], backends: { mock: true }, defaultAgent: agent.name }
      : url.pathname === "/api/agents" ? { agents: [agent] }
      : url.pathname === "/api/asks" ? { asks: [] } : {};
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(payload)); return;
  }
  const web = path.join(root, "web"), file = path.resolve(web, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
  if (!file.startsWith(web + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    res.writeHead(200, { "Content-Type": ({ ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" })[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
const ws = new WebSocketServer({ server, path: "/ws" });
ws.on("connection", socket => socket.send(JSON.stringify({ __harbour: "activity-snapshot", activeRunIds: [] })));
const samples = [];
async function sample(label) {
  app.getAppMetrics(); await pause(2200);
  const rows = app.getAppMetrics().map(m => ({ pid: m.pid, type: m.type,
    workingSetMiB: +(m.memory.workingSetSize / 1024).toFixed(1),
    privateBytesMiB: typeof m.memory.privateBytes === "number" ? +(m.memory.privateBytes / 1024).toFixed(1) : null,
    cpuPercent: +m.cpu.percentCPUUsage.toFixed(2) }));
  const data = { label, windows: BrowserWindow.getAllWindows().length, pets: runtime.petWindows.size,
    cursorTracking: runtime.cursorTracking, pendingTts,
    workingSetSumMiB: +rows.reduce((total, row) => total + row.workingSetMiB, 0).toFixed(1),
    privateBytesSumMiB: rows.every(row => row.privateBytesMiB !== null) ? +rows.reduce((total, row) => total + row.privateBytesMiB, 0).toFixed(1) : null,
    processes: rows };
  samples.push(data); console.log(JSON.stringify(data)); return data;
}
let tts, folia;
const watchdog = setTimeout(() => { console.error("Pet resources smoke timed out"); app.exit(1); }, 120000);
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: /^https?:/.test(request.url) && !request.url.startsWith(url + "/") }));
  tts = new RemoteTtsClient({ baseUrl: url });
  runtime.install(url, { readCharacter: id => ({ manifest: manifests.get(id) }), voiceEnabled: () => true,
    appearance: () => ({ alwaysOnTop: false, followDashboard: false }), characterDir: id => path.join(installedCharacters, id) }, tts, states);
  runtime.registerCharacterProtocol();
  const dashboard = await runtime.createDashboardWindow();
  dashboard.hide(); // Real dashboard remains loaded; the test does not need to take focus.
  const js = code => dashboard.webContents.executeJavaScript(code);
  await sample("dashboard-only");
  const first = await runtime.createPetWindow("elaina");
  await waitFor(async () => await first.webContents.executeJavaScript("document.querySelector('#desktopPet').dataset.live2d !== undefined"), "pet assets");
  if (useLive2d) assert.equal(await first.webContents.executeJavaScript("document.querySelector('#desktopPet').dataset.live2d"), "ready", "real installed model must load");
  const firstContents = first.webContents;
  const beforeId = firstContents.id;
  await sample("dashboard-plus-pet");
  runtime.focus = { petId: "elaina", requestId: "resource-test", acquiredAt: Date.now() };
  void firstContents.executeJavaScript("window.harbourDesktop.synthesizeCompanionSpeech({requestId:'resource-test',text:'local fixture',source:{platform:'web'}}).catch(()=>null)").catch(() => {});
  await waitFor(() => pendingTts === 1, "local pending speech");
  first.setContentBounds({ x: 210, y: 210, width: 232, height: 332 });
  const lastPosition = first.getContentBounds();
  await js("window.harbourDesktop.hidePet('elaina')");
  if (baseline) {
    assert.equal(first.isDestroyed(), false);
    assert.equal(first.isVisible(), false);
    await sample("pet-hidden-old-behavior");
    tts.cancelAll(); first.destroy();
  } else {
    assert.equal(first.isDestroyed(), true);
    assert.equal(firstContents.isDestroyed(), true);
    await waitFor(() => pendingTts === 0, "closed pet cancels speech");
    assert.equal(runtime.focus, null);
    assert.equal(runtime.petWindows.size, 0);
    assert.equal(runtime.petRuntime.size, 0);
    assert.equal(runtime.cursorTracking, false);
    const savedPosition = JSON.parse(fs.readFileSync(runtime.petPositionPath("elaina"), "utf8"));
    assert.equal(savedPosition.x, lastPosition.x);
    assert.equal(savedPosition.y, lastPosition.y);
    await sample("pet-closed-released");
    const requestsAfterClose = totalTts;
    runtime.sendToPets("desktop:companion-event", { __harbour: "companion:utterance", companionId: "elaina", agent: "main-elaina", text: "must not speak", runId: "closed-pet" });
    await pause(250);
    assert.equal(totalTts, requestsAfterClose, "closed pets cannot receive utterances or synthesize speech");
    const next = await runtime.createPetWindow("elaina");
    assert.notEqual(next.webContents.id, beforeId);
    assert.equal(next.getContentBounds().x, lastPosition.x);
    assert.equal(next.getContentBounds().y, lastPosition.y);
    const second = await runtime.createPetWindow("aemeath");
    await js("window.harbourDesktop.hidePet('elaina')");
    assert.equal(next.isDestroyed(), true);
    assert.equal(second.isDestroyed(), false, "closing one pet preserves another");
    assert.equal(runtime.cursorTracking, true);
    await js("window.harbourDesktop.hidePet()");
    assert.equal(second.isDestroyed(), true);
    assert.equal(runtime.cursorTracking, false);
    // Close while loadFile is pending; late reveal/load callbacks must not resurrect it.
    const opening = runtime.createPetWindow("elaina");
    const pendingWindow = runtime.petWindows.get("elaina");
    runtime.closePetWindow("elaina"); // Same production function, before loadFile can settle.
    await opening;
    assert.equal(pendingWindow.isDestroyed(), true);
    await pause(1700);
    assert.equal(runtime.petWindows.size, 0);
    assert.equal(runtime.cursorTracking, false);
    await sample("repeated-open-close");
  }
  if (process.argv.includes("--folia")) {
    const { FoliaController } = require("../folia/controller");
    folia = new FoliaController({ offline: true }); runtime.installFolia(folia);
    await folia.open("embedded", dashboard, { x: 20, y: 100, width: 1180, height: 650 });
    await sample("dashboard-plus-folia-empty-library");
    const player = folia.runtime.getMainWindow().webContents;
    await runtime.createPetWindow("elaina");
    await js("window.harbourDesktop.hidePet('elaina')");
    assert.equal(folia.runtime.getMainWindow().webContents, player, "pet close preserves Folia renderer");
    assert.equal(player.isDestroyed(), false);
    await folia.close();
    await sample("folia-closed");
  }
  const reports = path.join(root, "assets/reports/desktop-memory"); fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(path.join(reports, baseline ? "pet-baseline.json" : "pet-lifecycle.json"), JSON.stringify({
    observedAt: new Date().toISOString(), source: "isolated real Electron, fixture backend; not live owner session",
    electron: process.versions.electron, platform: process.platform, live2d: useLive2d,
    notes: "Private bytes are committed memory, not resident RAM. Working-set sums can double-count shared pages. Empty Folia library is not a full music workload.", samples }, null, 2));
  console.log(baseline ? "PET_BASELINE_OK" : "PET_LIFECYCLE_OK");
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  clearTimeout(watchdog); tts?.stop(); states.dispose();
  if (folia) await folia.close();
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  for (const socket of ws.clients) socket.terminate(); ws.close(); server.closeAllConnections(); server.close();
  // The test intentionally omits production bootstrap/tray/services, so bypass app quit's editor preflight.
  app.exit(process.exitCode || 0);
});
