const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 232,
    height: 270,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  try {
    await win.loadFile(path.join(__dirname, "pet-work-prop-smoke.html"));
    await new Promise((resolve) => setTimeout(resolve, 450));
    const image = await win.webContents.capturePage();
    assert.equal(image.isEmpty(), false);
    const bitmap = image.toBitmap();
    let visiblePixels = 0;
    let translucentPixels = 0;
    for (let index = 3; index < bitmap.length; index += 4) {
      if (bitmap[index] > 8) visiblePixels += 1;
      if (bitmap[index] > 1) translucentPixels += 1;
    }
    if (process.env.HARBOUR_PET_PROP_SMOKE_OUTPUT) {
      fs.writeFileSync(path.resolve(process.env.HARBOUR_PET_PROP_SMOKE_OUTPUT), image.toPNG());
    }
    assert.ok(translucentPixels > 180, `expected a subtle ambient work effect, got ${translucentPixels} translucent pixels`);
    console.log(`desktop pet ambient-work smoke test passed (${visiblePixels} visible / ${translucentPixels} translucent pixels)`);
  } finally {
    win.destroy();
    app.quit();
  }
}).catch((error) => { console.error(error); app.exit(1); });
