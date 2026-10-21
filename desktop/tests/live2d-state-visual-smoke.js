// Real installed LSS/Core, real profile, isolated hidden/offscreen Electron. No production writes.
// Run: npm --prefix desktop run build:companion
//      desktop/node_modules/.bin/electron desktop/tests/live2d-state-visual-smoke.js
// Missing proprietary local assets are an explicit CI skip. Artifacts stay in gitignored tmp/.
const { app, BrowserWindow, protocol, net, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { resolveCharacterHome } = require("../companion/platform-paths");

const repositoryRoot = path.resolve(__dirname, "../..");
const outputRoot = path.join(repositoryRoot, "tmp/l2d-state-qa");
const profileFile = path.resolve(__dirname, "../companion/profiles/elaina-lss.json");
const expressionNames = Array.from({ length: 14 }, (_, index) => `f${String(index).padStart(2, "0")}`);
const stateNames = ["idle", "study", "thinking", "scry", "verify", "waiting", "complete", "failed", "listening", "drinkTea"];
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "harbour-live2d-state-qa-")));
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
protocol.registerSchemesAsPrivileged([{ scheme: "harbour-state-qa",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function visiblePixels(image) {
  const bitmap = image.toBitmap();
  const { width, height } = image.getSize();
  let count = 0, minY = height, maxY = -1;
  for (let index = 3; index < bitmap.length; index += 4) {
    if (bitmap[index] <= 8) continue;
    count++;
    const y = Math.floor((index - 3) / 4 / width);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  assert.ok(count > 1_000, `model must have visible pixels, got ${count}`);
  assert.ok(minY < height * .35 && maxY > height * .65, `model cropped/outside viewport: ${minY}..${maxY}`);
  return { count, minY, maxY };
}

function pixelDifference(first, second) {
  const a = first.toBitmap(), b = second.toBitmap();
  assert.equal(a.length, b.length);
  let difference = 0;
  for (let index = 0; index < a.length; index += 4) {
    if (Math.max(Math.abs(a[index] - b[index]), Math.abs(a[index + 1] - b[index + 1]),
      Math.abs(a[index + 2] - b[index + 2]), Math.abs(a[index + 3] - b[index + 3])) > 20) difference++;
  }
  return difference;
}

function whiteEyePixels(image) {
  // LSS f10's Param2/Param7 switches render two large white comic eyes. Count their actual
  // visible pixels in a face-only crop, excluding the light hair, cup, and transparent backdrop.
  const bitmap = image.toBitmap();
  const { width, height } = image.getSize();
  let count = 0;
  for (let y = Math.floor(height * .35); y < height * .51; y++) {
    for (let x = Math.floor(width * .25); x < width * .75; x++) {
      const index = (y * width + x) * 4;
      if (bitmap[index + 3] > 230 && bitmap[index] > 233 && bitmap[index + 1] > 233 && bitmap[index + 2] > 233) count++;
    }
  }
  return count;
}

app.whenReady().then(async () => {
  const characterRoot = resolveCharacterHome();
  const modelRoot = path.join(characterRoot, "elaina/live2d/elaina-lss");
  const coreFile = path.join(characterRoot, "elaina/live2d/live2dcubismcore.min.js");
  if (!fs.existsSync(coreFile) || !fs.existsSync(path.join(modelRoot, "LSS.model3.json"))) {
    console.log("SKIP Live2D state visual regression: local LSS model/Cubism Core not installed (no downloads attempted)");
    app.quit(); return;
  }
  assert.ok(fs.existsSync(path.join(repositoryRoot, "web/harbour-cubism-adapter.js")),
    "build the adapter first: npm --prefix desktop run build:companion");
  const profile = JSON.parse(fs.readFileSync(profileFile, "utf8"));
  for (const state of stateNames) assert.ok(profile.visual.actions[state], `missing profile action ${state}`);
  fs.mkdirSync(outputRoot, { recursive: true });
  const fetchedExpressions = new Set();
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] },
    (_details, callback) => callback({ cancel: true }));
  protocol.handle("harbour-state-qa", request => {
    const url = new URL(request.url);
    if (url.hostname === "runtime" && url.pathname === "/core.js") return net.fetch(pathToFileURL(coreFile).href);
    if (url.hostname === "profile" && url.pathname === "/elaina-lss.json") return net.fetch(pathToFileURL(profileFile).href);
    const file = path.resolve(modelRoot, "." + decodeURIComponent(url.pathname));
    if (url.hostname !== "model" || !file.startsWith(modelRoot + path.sep)) return new Response("forbidden", { status: 403 });
    if (/^f\d+\.exp3\.json$/.test(path.basename(file))) fetchedExpressions.add(path.basename(file));
    return net.fetch(pathToFileURL(file).href);
  });
  const win = new BrowserWindow({ show: false, width: 320, height: 400, transparent: true,
    webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.setFrameRate(240);
  const evaluate = code => win.webContents.executeJavaScript(code);
  const report = { profileBehaviorVersion: profile.visual.behaviorVersion, expressions: {}, states: {}, lifecycle: {} };
  const captures = new Map();
  const captureCurrent = async name => {
    const diagnostic = await evaluate("host.pause(); host.diagnostics()");
    const image = await win.webContents.capturePage();
    assert.equal(image.isEmpty(), false, `${name} compositor capture empty`);
    const pixels = visiblePixels(image);
    fs.writeFileSync(path.join(outputRoot, `${name}.png`), image.toPNG());
    captures.set(name, { image, diagnostic });
    return { diagnostic, pixels };
  };
  const capture = async (name, state, action, delay = 1_500) => {
    await evaluate(`host.resume(); host.setState(${JSON.stringify(state)}, { action: ${JSON.stringify(action)} })`);
    await pause(delay);
    return captureCurrent(name);
  };
  const saveSheet = async (names, filename, columns) => {
    const frames = names.map(name => ({ name, url: captures.get(name).image.toDataURL(),
      detail: `${name.startsWith("expression-") ? "expression-only reference" : captures.get(name).diagnostic.expression?.applied || "none"} / ${captures.get(name).diagnostic.gesture}` }));
    const url = await evaluate(`makeContactSheet(${JSON.stringify(frames)}, ${columns})`);
    fs.writeFileSync(path.join(outputRoot, filename), Buffer.from(url.split(",")[1], "base64"));
  };
  const sampleDraws = async label => {
    await pause(150);
    const before = await evaluate("__drawCalls");
    await pause(700);
    const after = await evaluate("__drawCalls");
    const draws = after - before;
    report.lifecycle[label] = draws;
    return draws;
  };
  try {
    await win.loadFile(path.join(__dirname, "live2d-state-visual-smoke.html"));
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const status = await evaluate("({ ready: window.__ready, error: window.__error })");
      assert.ok(!status.error, status.error);
      if (status.ready) break;
      await pause(100);
    }
    assert.equal(await evaluate("window.__ready"), true, "local model did not initialise");
    assert.equal(win.isVisible(), false, "visual QA must never show an OS window");
    for (const expression of expressionNames) {
      if (expression !== "f00") {
        // Let f00 fully clear the preceding native expression (including rig props/large tilts)
        // before taking an independent reference of the next one.
        await evaluate("host.resume(); host.setState('idle', {action:'__probe_f00'})");
        await pause(1_250);
      }
      report.expressions[expression] = await capture(`expression-${expression}`, "idle", `__probe_${expression}`, 1_850);
      assert.equal(report.expressions[expression].diagnostic.expression?.applied, expression,
        `${expression} native expression did not finish applying`);
    }
    await saveSheet(expressionNames.map(name => `expression-${name}`), "expressions-contact.png", 4);
    await saveSheet(expressionNames.slice(0, 8).map(name => `expression-${name}`), "expressions-f00-f07.png", 4);
    await saveSheet(expressionNames.slice(8).map(name => `expression-${name}`), "expressions-f08-f13.png", 4);
    // These signals come from parameters captured at beforeModelUpdate, not merely a named spec.
    assert.ok(report.expressions.f03.diagnostic.face.mouthForm < -.7, "f03 expression was not applied to the real rendered model");
    assert.ok(report.expressions.f05.diagnostic.face.cheek > .7, "f05 cheek expression did not render");
    assert.ok(report.expressions.f05.diagnostic.face.eyeLSmile > .7, "f05 smiling eyes did not render");
    assert.ok(report.expressions.f13.diagnostic.face.mouthForm > .7, "f13 expression did not render");
    for (const expression of ["f03", "f05", "f13"]) {
      const changedPixels = pixelDifference(captures.get("expression-f00").image, captures.get(`expression-${expression}`).image);
      report.expressions[expression].changedPixelsFromNeutral = changedPixels;
      assert.ok(changedPixels > 100, `${expression} should be visually different from f00`);
    }
    if (process.argv.includes("--expressions-only")) {
      report.fetchedExpressions = [...fetchedExpressions].sort();
      report.passed = true;
      console.log(`Live2D native expression visual regression passed (${expressionNames.length} expressions; ${outputRoot})`);
      return;
    }
    for (const state of stateNames) {
      report.states[state] = await capture(state, state, state, ["complete", "failed"].includes(state) ? 2_000 : 1_500);
      const expected = state === "complete" ? "completeHold" : state === "failed" ? "errorHold" : profile.visual.actions[state].procedural;
      assert.equal(report.states[state].diagnostic.gesture, expected, `${state} did not use the real flat profile action`);
      assert.equal(report.states[state].diagnostic.expression?.applied, profile.visual.actions[state].expression,
        `${state} did not apply its flat profile expression`);
    }
    await saveSheet(stateNames, "states-contact.png", 5);
    const study = report.states.study.diagnostic, thinking = report.states.thinking.diagnostic;
    // Native breathing also moves the head; do not assert an exact absolute angle at wall time.
    assert.ok(["angleX", "angleY", "angleZ"].some(key => Math.abs(study.pose[key] - thinking.pose[key]) > .1),
      "reading and thinking need genuinely different rendered poses");
    assert.ok(study.proceduralOffsets.eyeY < 0 && thinking.proceduralOffsets.eyeY > 0,
      "study must look down and thinking must look up in the procedural pose");
    assert.ok(pixelDifference(captures.get("study").image, captures.get("thinking").image) > 100,
      "study and thinking captures should not be visually identical");

    // Trigger the production hair hotspot, not a test-only alias; its transient f10 face must
    // return to the latest continuous activity, with the native comic-eye rig switches cleared.
    assert.equal(profile.visual.actions.surprised.expression, "f10");
    report.hairInteraction = { before: await capture("study-before-hair", "working", "study") };
    const interacted = await evaluate(`(async () => {
      host.resume();
      const bounds = host.diagnostics().bounds;
      return host.interact({x:bounds.x + bounds.width * .5, y:bounds.y + bounds.height * .06});
    })()`);
    assert.equal(interacted, true, "real profile hair hotspot did not activate");
    // Cubism's native expression fade takes one second. Capture after full opacity, but before
    // the profile's 1.5-second interaction restore timer, not halfway through the crossfade.
    await pause(1_100);
    report.hairInteraction.active = await captureCurrent("surprised");
    assert.equal(report.hairInteraction.active.diagnostic.interactionActive, true);
    assert.equal(report.hairInteraction.active.diagnostic.expression.applied, "f10");
    await evaluate("host.resume()");
    await pause(2_300);
    report.hairInteraction.recovered = await captureCurrent("study-after-hair");
    assert.equal(report.hairInteraction.recovered.diagnostic.interactionActive, false);
    assert.equal(report.hairInteraction.recovered.diagnostic.gesture, "study");
    assert.equal(report.hairInteraction.recovered.diagnostic.expression.applied, "f00");
    const eyesBefore = whiteEyePixels(captures.get("study-before-hair").image);
    const eyesActive = whiteEyePixels(captures.get("surprised").image);
    const eyesRecovered = whiteEyePixels(captures.get("study-after-hair").image);
    report.hairInteraction.whiteEyePixels = { before: eyesBefore, active: eyesActive, recovered: eyesRecovered };
    await saveSheet(["study-before-hair", "surprised", "study-after-hair"], "hair-interaction-contact.png", 3);
    assert.ok(eyesActive > eyesBefore + 80,
      `f10 did not visibly switch to comic eyes: ${JSON.stringify(report.hairInteraction.whiteEyePixels)}`);
    assert.ok(eyesRecovered < eyesBefore + 50 && eyesRecovered < eyesActive * .4,
      `f10 comic eye switches remained after recovery: ${JSON.stringify(report.hairInteraction.whiteEyePixels)}`);

    // Repeated semantic snapshots must not restart the 1.6-second completion gesture.
    await evaluate("host.resume(); host.setState('idle', {action:'idle'})");
    await pause(250);
    await evaluate("host.setState('complete', {action:'complete'})");
    await pause(650);
    assert.equal(await evaluate("host.diagnostics().gesture"), "celebrate");
    const firstComplete = await evaluate("host.diagnostics()");
    for (let index = 0; index < 4; index++) {
      await evaluate("host.setState('complete', {action:'complete'})");
      await pause(300);
    }
    const repeated = await evaluate("host.diagnostics()");
    assert.equal(repeated.gesture, "completeHold", "repeated state restarted its entry animation");
    assert.equal(repeated.expression.requests, firstComplete.expression.requests,
      "repeated state reloaded its native expression");
    report.repeatedState = repeated;
    // A continuous activity's phase is observable too; snapshots must not reset its scan cycle.
    await evaluate("host.setState('working', {action:'study'})");
    await pause(400);
    const firstStudy = await evaluate("host.diagnostics()");
    await evaluate("host.setState('working', {action:'study'})");
    await pause(300);
    const repeatedStudy = await evaluate("host.diagnostics()");
    assert.ok(repeatedStudy.gestureElapsedMs >= firstStudy.gestureElapsedMs + 200,
      "repeated study state restarted its scan phase");
    assert.equal(repeatedStudy.expression.requests, firstStudy.expression.requests,
      "repeated study state reloaded its expression");
    report.repeatedContinuousState = repeatedStudy;
    assert.ok(await sampleDraws("visible") > 0, "visible model stopped rendering");
    await evaluate("setTestVisibility(false)");
    assert.equal(await sampleDraws("hidden"), 0, "hidden model must stop GL drawing");
    await evaluate("setTestVisibility(true)");
    assert.ok(await sampleDraws("restored") > 0, "showing model must resume drawing");
    await evaluate("host.pause(); setTestVisibility(false); setTestVisibility(true)");
    assert.equal(await sampleDraws("manualPauseSurvivesVisibility"), 0);
    await evaluate("host.resume(); host.destroy(); setTestVisibility(false); setTestVisibility(true)");
    assert.equal(await sampleDraws("destroyed"), 0, "destroyed model must stop GL drawing");
    for (const expression of expressionNames) assert.ok(fetchedExpressions.has(`${expression}.exp3.json`), `${expression} was never requested`);
    report.fetchedExpressions = [...fetchedExpressions].sort();
    report.passed = true;
    console.log(`Live2D state visual regression passed (profile v${profile.visual.behaviorVersion}; ${stateNames.length} states; ${outputRoot})`);
  } finally {
    fs.writeFileSync(path.join(outputRoot, "diagnostics.json"), JSON.stringify(report, null, 2) + "\n");
    try { await evaluate("host?.destroy()") } catch { /* window may already be gone */ }
    win.destroy(); app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
