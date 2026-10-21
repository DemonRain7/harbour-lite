const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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
    await win.loadFile(path.join(__dirname, "pet-bubble-smoke.html"));
    await new Promise((resolve) => setTimeout(resolve, 180));
    const layout = await win.webContents.executeJavaScript(`(() => {
      const bubble = document.getElementById("petSpeech");
      const text = document.getElementById("petSpeechText");
      const stage = document.getElementById("petStage");
      const bubbleRect = bubble.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const style = getComputedStyle(text);
      return {
        top: bubbleRect.top,
        bottom: bubbleRect.bottom,
        height: bubbleRect.height,
        stageTop: stageRect.top,
        text: text.textContent,
        textScrollTop: text.scrollTop,
        textClientHeight: text.clientHeight,
        textScrollHeight: text.scrollHeight,
        lineClamp: style.webkitLineClamp,
      };
    })()`);
    assert.ok(layout.top >= 8, `completion card top border is clipped at ${layout.top}px`);
    assert.ok(layout.bottom < layout.stageTop, "completion card must remain above the Live2D model");
    assert.ok(Math.abs(layout.height - 88) < 1, `completion card must keep an 88px height, got ${layout.height}`);
    assert.match(layout.text, /^回复开头：/, "completion card must preserve the beginning of the reply");
    assert.equal(layout.textScrollTop, 0, "completion card must not scroll itself to the reply tail");
    assert.ok(layout.textScrollHeight > layout.textClientHeight, "smoke text must exercise overflow truncation");
    assert.equal(layout.lineClamp, "3", "reply card reserves a separate header and clamps its preview to three lines");
    const image = await win.webContents.capturePage();
    assert.equal(image.isEmpty(), false);
    if (process.env.HARBOUR_PET_BUBBLE_SMOKE_OUTPUT) {
      fs.writeFileSync(path.resolve(process.env.HARBOUR_PET_BUBBLE_SMOKE_OUTPUT), image.toPNG());
    }
    console.log(`desktop pet completion bubble smoke test passed (top ${layout.top}px, height ${layout.height}px)`);
  } finally {
    win.destroy();
    app.quit();
  }
}).catch((error) => { console.error(error); app.exit(1); });
