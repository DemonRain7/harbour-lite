const { app, BrowserWindow, net, protocol } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { resolveCharacterHome } = require("../companion/platform-paths");

protocol.registerSchemesAsPrivileged([{
  scheme: "harbour-smoke",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

async function waitForResult(win) {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const result = await win.webContents.executeJavaScript("window.__harbourLive2dSmoke");
    if (result?.ready || result?.error) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { ready: false, error: "Live2D smoke test timed out" };
}

app.whenReady().then(async () => {
  const modelRoot = path.resolve(process.env.HARBOUR_LIVE2D_MODEL_ROOT
    || path.join(resolveCharacterHome(), "elaina", "live2d", "elaina-lss"));
  const modelFile = String(process.env.HARBOUR_LIVE2D_MODEL_FILE || "LSS.model3.json");
  const coreFile = path.resolve(process.env.HARBOUR_LIVE2D_CORE
    || path.join(resolveCharacterHome(), "elaina", "live2d", "live2dcubismcore.min.js"));
  if (!fs.existsSync(path.join(modelRoot, modelFile)) || !fs.existsSync(coreFile)) {
    console.log("desktop Live2D smoke test skipped (no local character pack)");
    app.quit();
    return;
  }
  protocol.handle("harbour-smoke", (request) => {
    const url = new URL(request.url);
    if (url.hostname === "runtime") return net.fetch(pathToFileURL(coreFile).toString());
    if (url.hostname !== "model") return new Response("not found", { status: 404 });
    const requested = path.resolve(modelRoot, decodeURIComponent(url.pathname).replace(/^[/\\]+/, ""));
    if (requested !== modelRoot && !requested.startsWith(`${modelRoot}${path.sep}`)) return new Response("forbidden", { status: 403 });
    if (!fs.existsSync(requested)) return new Response("not found", { status: 404 });
    return net.fetch(pathToFileURL(requested).toString());
  });
  const win = new BrowserWindow({
    show: false,
    width: 220,
    height: 280,
    transparent: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  try {
    await win.loadFile(path.join(__dirname, "live2d-smoke.html"), {
      query: {
        model: modelFile,
        scenario: process.env.HARBOUR_LIVE2D_SCENARIO || "full",
        captureDelay: process.env.HARBOUR_LIVE2D_CAPTURE_DELAY || "",
      },
    });
    const result = await waitForResult(win);
    assert.equal(result.ready, true, result.error);
    assert.equal(result.interacted, true, "Live2D interaction did not return a result");
    assert.equal(result.interactionActive, true, "Live2D interaction did not enter its transient state");
    assert.equal(result.interactionGesture, "happy", "Live2D tap did not select the visible happy response");
    assert.equal(result.restoredInteractionActive, false, "Live2D interaction did not release its transient state");
    assert.equal(result.restoredGesture, "idle", "Live2D interaction did not restore the semantic idle pose");
    assert.equal(result.buttonInteracted, true, "toolbar interaction did not return a result");
    assert.equal(result.buttonInteractionActive, true, "toolbar interaction did not enter its transient state");
    assert.equal(result.buttonGesture, "tap", "toolbar interaction must use the deterministic tap action");
    assert.ok(Math.abs(result.buttonPose?.bodyAngleX || 0) > 0.1,
      `toolbar interaction did not visibly animate the model: ${JSON.stringify(result.buttonPose)}`);
    assert.ok((result.buttonFace?.eyeLOpen ?? 1) < .2,
      `toolbar interaction did not visibly wink: ${JSON.stringify(result.buttonFace)}`);
    assert.ok((result.buttonFace?.eyeROpen ?? 0) > .55,
      `toolbar interaction closed both eyes instead of winking: ${JSON.stringify(result.buttonFace)}`);
    assert.ok((result.buttonFace?.mouthOpen || 0) > .25,
      `toolbar interaction did not show the cheerful open-mouth response: ${JSON.stringify(result.buttonFace)}`);
    assert.ok((result.buttonProceduralOffsets?.browLYValue || 0) < -.1
      && (result.buttonProceduralOffsets?.browRYValue || 0) < -.05,
    `wink did not keep both brows softly lowered: ${JSON.stringify(result.buttonProceduralOffsets)}`);
    assert.ok(Math.abs(result.buttonProceduralOffsets?.angleX || 0) < .001
      && Math.abs(result.buttonProceduralOffsets?.angleY || 0) < .001
      && Math.abs(result.buttonProceduralOffsets?.angleZ || 0) < .001
      && Math.abs(result.buttonProceduralOffsets?.bodyY || 0) < .001,
    `toolbar interaction must not fake cuteness by stretching or tilting the neck: ${JSON.stringify(result.buttonProceduralOffsets)}`);
    assert.equal(result.buttonActiveAfterRefresh, true, "a repeated state snapshot cancelled the toolbar interaction");
    assert.equal(result.buttonGestureAfterRefresh, "tap", "a repeated state snapshot replaced the toolbar interaction");
    assert.ok((result.buttonRecoveryOffsets?.eyeLOpenValue || 0) > (result.buttonProceduralOffsets?.eyeLOpenValue || 0) + .25,
      `wink eyelid did not reopen gradually: ${JSON.stringify({ closed: result.buttonProceduralOffsets, recovery: result.buttonRecoveryOffsets })}`);
    assert.ok(Math.abs((result.buttonRecoveryOffsets?.browLYValue || 0) - (result.buttonProceduralOffsets?.browLYValue || 0)) < .015
      && Math.abs((result.buttonRecoveryOffsets?.browRYValue || 0) - (result.buttonProceduralOffsets?.browRYValue || 0)) < .015,
    `wink brow moved while the eyelid was half open: ${JSON.stringify({ closed: result.buttonProceduralOffsets, recovery: result.buttonRecoveryOffsets })}`);
    assert.ok((result.buttonLateRecoveryOffsets?.eyeLOpenValue || 0) > .95
      && Math.abs((result.buttonLateRecoveryOffsets?.browLYValue || 0) - (result.buttonProceduralOffsets?.browLYValue || 0)) < .015
      && Math.abs((result.buttonLateRecoveryOffsets?.browRYValue || 0) - (result.buttonProceduralOffsets?.browRYValue || 0)) < .015,
    `wink brow did not stay lowered until the eye was fully open: ${JSON.stringify({ closed: result.buttonProceduralOffsets, late: result.buttonLateRecoveryOffsets })}`);
    assert.ok((result.buttonBrowReleaseOffsets?.eyeLOpenValue || 0) > .99
      && (result.buttonBrowReleaseOffsets?.browLYValue || 0) > (result.buttonLateRecoveryOffsets?.browLYValue || 0) + .08
      && (result.buttonBrowReleaseOffsets?.browLYValue || 0) < 0,
    `wink brow did not release smoothly after the eye opened: ${JSON.stringify({ late: result.buttonLateRecoveryOffsets, release: result.buttonBrowReleaseOffsets })}`);
    assert.equal(result.buttonRestoredActive, false, "toolbar interaction did not release its transient state");
    assert.equal(result.buttonRestoredGesture, "scribe", "toolbar interaction did not restore the latest deferred task state");
    assert.ok(result.leftFocus < -0.1, `left gaze was not mapped correctly: ${result.leftFocus}`);
    assert.ok(result.rightFocus > 0.1, `right gaze was not mapped correctly: ${result.rightFocus}`);
    assert.ok(Math.abs(result.returnedFocus) < 0.1, `idle gaze did not return to centre: ${result.returnedFocus}`);
    assert.equal(result.draggingGesture, "dragging", "native drag did not select its movement gesture");
    assert.equal(result.dragResetGesture, "idle", "drag release did not restore the semantic idle gesture");
    assert.ok(Math.abs(result.dragResetFocus?.x || 0) < 0.01 && Math.abs(result.dragResetFocus?.targetX || 0) < 0.01,
      `drag release did not centre Live2D focus: ${JSON.stringify(result.dragResetFocus)}`);
    for (const [name, value] of Object.entries(result.dragResetProceduralOffsets || {})) {
      assert.ok(Math.abs(value) < 0.001, `drag release left procedural ${name} offset at ${value}`);
    }
    if ((process.env.HARBOUR_LIVE2D_SCENARIO || "full") === "full") {
      assert.equal(result.workingGesture, "working", "task state did not select the continuous working gesture");
      assert.equal(result.scribeGesture, "scribe", "write tools did not select the scribe gesture");
      assert.equal(result.scryGesture, "scry", "browser tools did not select the scry gesture");
      assert.ok(Math.abs(result.activeFocus) < 0.1, `active task should centre gaze instead of following a distant cursor: ${result.activeFocus}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
    const image = await win.webContents.capturePage();
    assert.equal(image.isEmpty(), false);
    if (process.env.HARBOUR_LIVE2D_SMOKE_OUTPUT) {
      fs.writeFileSync(path.resolve(process.env.HARBOUR_LIVE2D_SMOKE_OUTPUT), image.toPNG());
    }
    const bitmap = image.toBitmap();
    let visiblePixels = 0;
    let minX = image.getSize().width;
    let minY = image.getSize().height;
    let maxX = -1;
    let maxY = -1;
    const size = image.getSize();
    for (let index = 3; index < bitmap.length; index += 4) {
      if (bitmap[index] <= 8) continue;
      const pixel = (index - 3) / 4;
      const x = pixel % size.width;
      const y = Math.floor(pixel / size.width);
      visiblePixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    assert.ok(visiblePixels > 500, `expected rendered model pixels, got ${visiblePixels}`);
    assert.ok(minY < size.height * .35, `rendered model is cropped below viewport: y=${minY}..${maxY}`);
    assert.ok(maxY > size.height * .65, `rendered model does not occupy the viewport: y=${minY}..${maxY}`);
    console.log(`desktop Live2D smoke test passed (${visiblePixels} visible pixels, bounds ${minX},${minY}..${maxX},${maxY})`);
  } finally {
    try { await win.webContents.executeJavaScript("window.__harbourLive2dHost?.destroy?.()") } catch { /* ignore */ }
    win.destroy();
    app.quit();
  }
}).catch((error) => { console.error(error); app.exit(1); });
