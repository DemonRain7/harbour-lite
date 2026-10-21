// Real local Cubism model; isolated offscreen Electron, no production API/user profile writes.
const { app, BrowserWindow, protocol, net } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { resolveCharacterHome } = require("../companion/platform-paths");
const baseline = process.argv.includes("--baseline");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "harbour-live2d-perf-")));
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("force-device-scale-factor", "1.5");
protocol.registerSchemesAsPrivileged([{ scheme: "harbour-perf",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const characterRoot = resolveCharacterHome();
  const modelRoot = path.join(characterRoot, "elaina/live2d/elaina-lss");
  const core = path.join(characterRoot, "elaina/live2d/live2dcubismcore.min.js");
  if (!fs.existsSync(core) || !fs.existsSync(path.join(modelRoot, "LSS.model3.json"))) {
    console.log("SKIP live2d performance: local model/Core not installed"); app.quit(); return;
  }
  protocol.handle("harbour-perf", request => {
    const url = new URL(request.url);
    if (url.hostname === "runtime") return net.fetch(pathToFileURL(core).href);
    const file = path.resolve(modelRoot, "." + decodeURIComponent(url.pathname));
    if (url.hostname !== "model" || !file.startsWith(modelRoot + path.sep)) return new Response("forbidden", { status: 403 });
    return net.fetch(pathToFileURL(file).href);
  });
  const win = new BrowserWindow({ show: false, width: 220, height: 280, transparent: true,
    webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.setFrameRate(240);
  const evaluate = code => win.webContents.executeJavaScript(code);
  const metrics = () => app.getAppMetrics().map(m => ({ type: m.type,
    cpu: m.cpu.percentCPUUsage, workingMB: Math.round(m.memory.workingSetSize / 1024),
    privateMB: Math.round((m.memory.privateBytes || 0) / 1024) }));
  const sample = async label => {
    metrics();
    const before = await evaluate("({ time: performance.now(), draws: __drawCalls, render: host.diagnostics?.()?.rendering })");
    await pause(3000);
    const after = await evaluate("({ time: performance.now(), draws: __drawCalls, render: host.diagnostics?.()?.rendering })");
    const value = { label, drawCallsPerSecond: Math.round((after.draws - before.draws) * 1000 / (after.time - before.time)),
      fps: after.render && Math.round((after.render.frames - before.render.frames) * 1000 / (after.time - before.time)),
      maxFPS: after.render?.maxFPS, processes: metrics() };
    console.log(JSON.stringify(value)); return value;
  };
  try {
    await win.loadFile(path.join(__dirname, "live2d-performance-smoke.html"));
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const status = await evaluate("({ready:window.__ready,error:window.__error})");
      assert.ok(!status.error, status.error);
      if (status.ready) break;
      await pause(100);
    }
    assert.equal(await evaluate("window.__ready"), true, "model did not initialise");
    await pause(1500);
    const idle = await sample("idle");
    assert.ok(idle.drawCallsPerSecond > 0, "visible model must render");
    if (!baseline) {
      assert.equal(idle.maxFPS, 30);
      assert.ok(idle.fps <= 32, "idle render budget must not follow the 240 Hz display");
    }
    await evaluate("setTestVisibility(false)");
    await pause(200);
    const hidden = await sample("hidden");
    if (!baseline) assert.equal(hidden.drawCallsPerSecond, 0, "hidden model must stop drawing");
    await evaluate("setTestVisibility(true)");
    const restored = await sample("restored");
    assert.ok(restored.drawCallsPerSecond > 0, "model must render again after showing");
    await evaluate("host.pause();setTestVisibility(false);setTestVisibility(true)");
    if (!baseline) assert.equal((await sample("manual-pause-survives-visibility")).drawCallsPerSecond, 0);
    await evaluate("host.resume()");
    assert.equal(await evaluate("host.interact()"), true, "interactions still available");
    if (!baseline) assert.equal(await evaluate("host.diagnostics().rendering.maxFPS"), 60);
    await pause(350);
    assert.equal((await win.webContents.capturePage()).isEmpty(), false, "compositor capture still works");
    await evaluate("host.destroy();setTestVisibility(false);setTestVisibility(true)");
    assert.equal((await sample("destroyed")).drawCallsPerSecond, 0);
    console.log(`Live2D performance ${baseline ? "baseline" : "regression"} passed`);
  } finally { win.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
