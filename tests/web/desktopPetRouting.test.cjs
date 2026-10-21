const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");

assert.match(html, /id="desktopPetQuick"[^>]*>桌面陪伴<\/button>/,
  "the initial desktop-pet control must be role-neutral");
assert.ok(html.indexOf('id="desktopPetQuick"') > html.indexOf('id="navMore"'),
  "desktop-pet access belongs to More, not a persistent topbar persona badge");
assert.doesNotMatch(html, /id="desktopPetQuick"[^>]*ELAINA/,
  "the dashboard shell must not hard-code Elaina");
assert.match(app, /function companionIdForAgent\(agent\)/);
assert.match(app, /function companionTargetForAgent\(agent\)/);
assert.match(app, /harbourDesktop\?\.petCatalog/,
  "custom future Main-to-pet mappings must come from Electron config rather than UI constants");
assert.match(app, /function syncDesktopPetQuick\(\)/);
assert.match(app, /button\.textContent = `桌面陪伴 · \$\{target\?\.label \|\| personaLabel\(agent\)\}`/);
assert.match(app, /showPet\(target\.petId\)/,
  "the quick control must open the active Main's own pet");
assert.match(app, /petVisible\(companionId\)/);
assert.match(app, /hidePet\(companionId\)/);
assert.match(app, /showPet\(companionId\)/);
assert.doesNotMatch(app, /Elaina 已回到桌面/,
  "desktop-pet feedback must follow the active role");

console.log("web desktop-pet role routing tests passed");
