const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");

async function waitFor(win, expression, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await win.webContents.executeJavaScript(expression)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function interactionState(win) {
  return win.webContents.executeJavaScript(`(() => {
    const host = document.getElementById("desktopPet");
    return {
      state: host.dataset.interactionState,
      active: host.classList.contains("is-interacting"),
      label: document.getElementById("petState").textContent,
      source: document.getElementById("petSource").textContent,
      calls: window.__petInteractionCalls,
    };
  })()`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 232,
    height: 332,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  try {
    await win.loadFile(path.join(__dirname, "pet-interaction-feedback-smoke.html"));
    assert.equal(await waitFor(win, 'document.getElementById("desktopPet")?.dataset.live2d === "ready"'), true,
      "desktop pet did not initialise its Live2D host");

    await win.webContents.executeJavaScript('document.getElementById("petInteract").click()');
    const buttonImmediate = await interactionState(win);
    assert.deepEqual(buttonImmediate, { state: "pending", active: true, label: "回应你啦", source: "轻触互动", calls: 1 });
    await new Promise((resolve) => setTimeout(resolve, 520));
    assert.equal((await interactionState(win)).state, "active", "interaction button did not complete its delayed adapter call");
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    assert.equal((await interactionState(win)).state, "idle", "interaction feedback did not restore after its animation window");

    await win.webContents.executeJavaScript('document.getElementById("petInteractionZone").click()');
    const modelImmediate = await interactionState(win);
    assert.deepEqual(modelImmediate, { state: "pending", active: true, label: "回应你啦", source: "轻触互动", calls: 2 });
    await new Promise((resolve) => setTimeout(resolve, 520));
    assert.equal((await interactionState(win)).state, "active", "model hotspot did not complete its delayed adapter call");
    console.log("desktop pet interaction feedback smoke test passed");
  } finally {
    win.destroy();
    app.quit();
  }
}).catch((error) => { console.error(error); app.exit(1); });
