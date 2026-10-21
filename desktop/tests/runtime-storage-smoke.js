// Isolated native Electron cold start: no production profile, network or visible window.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { initializeDesktopStorage } = require("../companion/runtime-storage");
const fixtures = path.resolve(__dirname, "../../data/runtime/test-fixtures");
fs.mkdirSync(fixtures, { recursive: true });
const base = fs.mkdtempSync(path.join(fixtures, "storage-native-"));
const oldRoot = path.join(base, "old"), repoRoot = path.join(base, "repo");
fs.mkdirSync(repoRoot); fs.mkdirSync(oldRoot);
fs.writeFileSync(path.join(repoRoot, "package.json"), '{"name":"harbour"}');
app.setName("harbour-storage-fixture"); app.setPath("appData", oldRoot);
const oldProfile = path.join(oldRoot, app.getName()); fs.mkdirSync(oldProfile);
fs.writeFileSync(path.join(oldProfile, "retained-note.txt"), "fixture retained");
app.setPath("userData", oldProfile); app.disableHardwareAcceleration();
delete process.env.HARBOUR_DATA_HOME;
process.env.LOCALAPPDATA = path.join(base, "legacy-local");
process.env.XDG_CONFIG_HOME = path.join(base, "legacy-config");
assert.equal(app.requestSingleInstanceLock(), true);
const dataRoot = initializeDesktopStorage(app, { repoRoot });
assert.equal(app.getPath("userData"), path.join(dataRoot, "electron"));
assert.equal(app.getPath("temp"), path.join(dataRoot, "tmp"));
assert.equal(fs.readFileSync(path.join(app.getPath("userData"), "retained-note.txt"), "utf8"), "fixture retained");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL("data:text/html,<p>Harbour storage fixture</p>");
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('p').textContent"), "Harbour storage fixture");
  console.log(JSON.stringify({ ok: true, isolatedNativeElectron: true, runtime: dataRoot }));
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
app.on("quit", () => {
  // Chromium may hold its final file handles until exit. Keep this tiny, ignored
  // fixture if cleanup is busy; never retry deletion against user profiles.
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* isolated fixture only */ }
});
