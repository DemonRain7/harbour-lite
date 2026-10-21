const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.resolve(__dirname, "../../web/app.js"), "utf8");
const styles = fs.readFileSync(path.resolve(__dirname, "../../web/styles.css"), "utf8");

// 去掉注释后，Web/Electron 共用前端不应再调用 Windows 原生三件套。
const codeOnly = app
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");
const nativeCalls = codeOnly.match(/(?<![\w$])(?:window\.)?(?:confirm|alert|prompt)\s*\(/g) || [];
assert.deepEqual(nativeCalls, [], `native dialogs remain: ${nativeCalls.join(", ")}`);

assert.match(app, /function showHarbourDialog\(options = \{\}\)/);
assert.match(app, /function harbourConfirm\(/);
assert.match(app, /function harbourPrompt\(/);
assert.match(app, /async function harbourAlert\(/);
assert.ok((app.match(/await harbourConfirm\(/g) || []).length >= 10, "destructive confirmations must use Harbour Dialog");
assert.ok((app.match(/await harbourPrompt\(/g) || []).length >= 4, "Bot setup prompts must use Harbour Dialog");

assert.match(styles, /\.harbour-dialog-layer\s*\{/);
assert.match(styles, /body\[data-theme-cat="premium"\] \.md-card\.harbour-dialog/);
assert.match(styles, /body\[data-theme-cat="anime"\] \.md-card\.harbour-dialog/);
assert.match(styles, /\.harbour-dialog\.tone-danger \.harbour-dialog-confirm/);
assert.match(styles, /\.chat-speech-status\[hidden\]\s*\{\s*display:\s*none\s*!important;/, "empty speech status must not leave a bordered shell");

console.log("web themed dialog tests passed");
