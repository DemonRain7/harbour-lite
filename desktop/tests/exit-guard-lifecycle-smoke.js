"use strict";

// Real Electron lifecycle + the production preload/IPC coordinator. No Harbour main,
// single-instance lock, services, credentials or real userData are loaded by this fixture.
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("node:http");
const { createCloseGuard } = require("../companion/close-guard");

app.setPath("userData", fs.mkdtempSync(path.join(process.env.HARBOUR_CHAT_TEST_ROOT || os.tmpdir(), "harbour-exit-guard-")));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.on("window-all-closed", () => {});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (win, source) => win.webContents.executeJavaScript(source);
const safetyTimer = setTimeout(() => { console.error("exit guard smoke timed out"); app.exit(1); }, 30_000);
let cleanupCount = 0;
let fallbackCount = 0;
let fallbackResponse = 0;
let finalQuit = false;
const fixturePages = new Map();
const server = createServer((req, res) => {
  const html = fixturePages.get(req.url);
  res.writeHead(html ? 200 : 404, { "Content-Type": "text/html" });
  res.end(html || "missing fixture");
});

const guard = createCloseGuard({
  app, ipcMain, timeoutMs: 1_400,
  // Keep fixture windows hidden; exercise the actual IPC/native close machinery only.
  showWindow() {},
  dialog: { async showMessageBox(_win, options) {
    fallbackCount += 1;
    assert.equal(options.cancelId, 0);
    assert.equal(options.defaultId, 0);
    assert.match(options.message, /未保存/);
    return { response: fallbackResponse };
  }, showMessageBoxSync(_win, options) {
    fallbackCount += 1;
    assert.equal(options.cancelId, 0);
    return fallbackResponse;
  } },
  cleanup() { cleanupCount += 1; },
});

async function waitFor(check, label) {
  for (let i = 0; i < 150; i += 1) {
    if (await check()) return;
    await pause(20);
  }
  throw new Error(`Timed out: ${label}`);
}

async function createFixture({ handler = true, required = true } = {}) {
  const win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.resolve(__dirname, "../preload.js"), contextIsolation: true,
    nodeIntegration: false, sandbox: false,
  } });
  guard.register(win, { required });
  const route = `/fixture-${win.id}`;
  fixturePages.set(route, `<!doctype html><html><body><input id="draft" value="saved"><script>
    window.dirty = false;
    window.decision = false;
    window.events = [];
    window.deferCheck = false;
    window.deferCommit = false;
    window.commitAllowed = true;
    window.addEventListener('beforeunload', event => { if (window.dirty) { event.preventDefault(); event.returnValue = ''; } });
    ${handler ? `window.harbourDesktop.onBeforeClose(async ({ reason, phase }) => {
      window.events.push({ reason, phase });
      if (phase === 'cancel') return true;
      if (phase === 'commit') return window.deferCommit
        ? new Promise(resolve => { window.resolveCommit = resolve; }) : window.commitAllowed;
      if (window.deferCheck) return new Promise(resolve => { window.resolveCheck = resolve; });
      return !window.dirty || window.decision;
    });` : ""}
  </script></body></html>`);
  await win.loadURL(`http://127.0.0.1:${server.address().port}${route}`);
  return win;
}

app.on("will-quit", () => {
  try {
    assert.equal(finalQuit, true, "only the final approved quit should reach will-quit");
    assert.equal(BrowserWindow.getAllWindows().length, 0, "cleanup runs after real windows close");
    assert.equal(cleanupCount, 1, "service cleanup is committed exactly once");
    clearTimeout(safetyTimer);
    server.close();
    console.log("PASS: real close/reload/quit IPC; cancel preserves windows and services; repeated quit dedup; multi-window commit failure/new window; stale/iframe replies; missing/hung fallback; actual approved app exit");
  } catch (error) { console.error(error); app.exit(1); }
});

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const first = await createFixture();
  await evaluate(first, "window.dirty = true; document.querySelector('#draft').value = 'unsaved';");
  first.close();
  await waitFor(async () => (await evaluate(first, "window.events.length")) === 1, "close veto");
  await pause(60);
  assert.equal(first.isDestroyed(), false);
  assert.equal(cleanupCount, 0);
  assert.equal(await evaluate(first, "document.querySelector('#draft').value"), "unsaved");

  const deniedReload = await guard.run(first, "reload", () => first.loadURL(first.webContents.getURL()));
  assert.equal(deniedReload, false);
  assert.equal(await evaluate(first, "document.querySelector('#draft').value"), "unsaved");
  await evaluate(first, "window.decision = true");
  assert.equal(await guard.run(first, "reload", () => first.loadURL(first.webContents.getURL())), true);
  assert.equal(await evaluate(first, "document.querySelector('#draft').value"), "saved");

  // Renderer-initiated reload bypasses main's keyboard route. Native beforeunload must
  // still get a visible decision and the retried reload must not loop forever.
  await evaluate(first, "window.dirty = true; window.decision = true; document.querySelector('#draft').value = 'native reload'; location.reload();");
  await waitFor(async () => (await evaluate(first, "document.querySelector('#draft').value")) === "saved", "native reload fallback");

  const legacy = await createFixture({ handler: false });
  const beforeLegacy = fallbackCount;
  legacy.close();
  await waitFor(() => fallbackCount > beforeLegacy, "old renderer fallback");
  assert.equal(legacy.isDestroyed(), false, "native fallback defaults to stay");
  fallbackResponse = 1;
  legacy.close();
  await waitFor(() => legacy.isDestroyed(), "explicit legacy close approval");
  fallbackResponse = 0;

  // Optional companion pages normally have no draft manager. A future native editor
  // there must never get blanket permission just because that manager is absent.
  const optional = await createFixture({ handler: false, required: false });
  await evaluate(optional, "window.dirty = true");
  const beforeOptional = fallbackCount;
  optional.close();
  await waitFor(() => fallbackCount > beforeOptional, "optional page native veto");
  assert.equal(optional.isDestroyed(), false);
  fallbackResponse = 1;
  optional.close();
  await waitFor(() => optional.isDestroyed(), "optional page explicit native approval");
  fallbackResponse = 0;

  const second = await createFixture();
  let latestSecondRequest = null;
  ipcMain.on("desktop:before-close-result", (event, payload) => {
    if (event.sender === second.webContents && payload.phase === "pending") latestSecondRequest = payload.requestId;
  });
  await evaluate(first, "window.dirty = true; window.decision = true; window.events = [];");
  await evaluate(second, "window.dirty = true; window.deferCheck = true; window.events = [];");
  app.quit();
  app.quit();
  await waitFor(async () => await evaluate(second, "typeof window.resolveCheck === 'function'"), "quit modal pending");
  // A wrong frame or request ID must not resolve a real pending lifecycle request.
  ipcMain.emit("desktop:before-close-result", {
    sender: second.webContents, senderFrame: {},
  }, { requestId: latestSecondRequest, phase: "result", allowed: true });
  ipcMain.emit("desktop:before-close-result", {
    sender: first.webContents, senderFrame: first.webContents.mainFrame,
  }, { requestId: latestSecondRequest, phase: "result", allowed: true });
  ipcMain.emit("desktop:before-close-result", {
    sender: second.webContents, senderFrame: second.webContents.mainFrame,
  }, { requestId: "stale-request-id", phase: "result", allowed: true });
  await pause(1_650); // Longer than timeout: production preload's heartbeat keeps the modal alive.
  assert.equal(fallbackCount, beforeOptional + 2);
  assert.equal(await evaluate(second, "window.events.filter(event => event.phase === 'check').length"), 1);
  await evaluate(second, "window.resolveCheck(false); window.deferCheck = false;");
  await waitFor(async () => (await evaluate(first, "window.events.some(event => event.phase === 'cancel')")), "multi-window cancellation");
  assert.equal(cleanupCount, 0);
  assert.equal(first.isDestroyed(), false);
  assert.equal(second.isDestroyed(), false);

  // A late failure while committing (for example, saving a governance proposal) must
  // keep the complete application alive, even after another window approved discard.
  await evaluate(second, "window.decision = true; window.commitAllowed = false; window.events = [];");
  assert.equal(await guard.requestQuit(), false);
  assert.equal(cleanupCount, 0);
  assert.equal(await evaluate(second, "window.events.some(event => event.phase === 'cancel')"), true);

  // A dashboard opened while another window saves during commit is outside the
  // approved window snapshot. Cancel, retain it, and require a new quit request.
  await evaluate(second, "window.commitAllowed = true; window.deferCommit = true; window.events = [];");
  const interruptedQuit = guard.requestQuit();
  await waitFor(async () => await evaluate(second, "typeof window.resolveCommit === 'function'"), "quit commit pending");
  const lateWindow = await createFixture();
  await evaluate(lateWindow, "window.dirty = true; document.querySelector('#draft').value = 'unapproved new window';");
  await evaluate(second, "window.resolveCommit(true); window.deferCommit = false;");
  assert.equal(await interruptedQuit, false);
  assert.equal(cleanupCount, 0);
  assert.equal(lateWindow.isDestroyed(), false);
  assert.equal(await evaluate(lateWindow, "window.events.length"), 0);
  assert.equal(await evaluate(lateWindow, "document.querySelector('#draft').value"), "unapproved new window");
  assert.equal(await evaluate(second, "window.events.some(event => event.phase === 'cancel')"), true);
  await evaluate(lateWindow, "window.decision = true;");

  // No heartbeat means a genuinely stuck renderer, not an undecided user.
  const stuck = await createFixture();
  // Block only this fixture's renderer after preload installs the request listener.
  void evaluate(stuck, "while (true) {}").catch(() => {});
  await pause(100);
  const beforeStuck = fallbackCount;
  assert.equal(await guard.run(stuck, "close", () => stuck.close()), false);
  assert.equal(fallbackCount, beforeStuck + 1);
  assert.equal(cleanupCount, 0);
  // Test-only termination of the isolated deliberately hung fixture, never user windows.
  stuck.destroy();

  await evaluate(first, "window.decision = true; window.commitAllowed = true;");
  await evaluate(second, "window.decision = true; window.commitAllowed = true;");
  finalQuit = true;
  app.quit();
}).catch((error) => { console.error(error); clearTimeout(safetyTimer); app.exit(1); });
