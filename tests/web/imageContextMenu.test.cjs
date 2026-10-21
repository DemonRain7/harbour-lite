const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.resolve(__dirname, "../../web/app.js"), "utf8");
const styles = fs.readFileSync(path.resolve(__dirname, "../../web/styles.css"), "utf8");
const main = fs.readFileSync(path.resolve(__dirname, "../../desktop/main.js"), "utf8");
const preload = fs.readFileSync(path.resolve(__dirname, "../../desktop/preload.js"), "utf8");

assert.match(app, /function initImageContextMenu\(\)/);
assert.match(app, /img\.att-img, img\.md-img-real/);
assert.match(app, /const png = fetchChatImageBlob\(image\)\.then\(imageBlobAsPng\);/);
assert.match(app, /new ClipboardItem\(\{ "image\/png": png \}\)/);
assert.match(app, /imageBlobAsPng\(await fetchChatImageBlob\(image\)\)/, "Electron must convert before IPC");
assert.match(app, /if \(!canCopyChatImageDirectly\(\)\) return;/, "insecure remote Web must retain its native menu");
assert.match(app, /initImageContextMenu\(\);/);

assert.match(styles, /\.image-context-menu\s*\{/);
assert.match(styles, /background: color-mix\(in srgb, var\(--panel\)/);
assert.match(styles, /\.att-img-link img \{ cursor: zoom-in;/);
assert.doesNotMatch(app, /window\.open\(chatImageOriginalUrl\(image\)/, "open image must stay inside Harbour");

assert.match(main, /\bclipboard\b/);
assert.match(main, /ipcMain\.handle\("desktop:copy-image"/);
assert.match(main, /mainWindow\.webContents !== event\.sender/);
assert.match(main, /\^data:image\\\/png;base64/);
assert.match(main, /clipboard\.writeImage\(image\)/);
assert.match(preload, /copyImage: \(dataUrl\) => ipcRenderer\.invoke\("desktop:copy-image", dataUrl\)/);

console.log("web image context-menu tests passed");
