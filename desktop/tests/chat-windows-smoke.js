// Two real Dashboard renderers. HTTP/WS fixtures only; never touch production.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const scratchBase = path.join(root, 'data/runtime/test-fixtures');
fs.mkdirSync(scratchBase, { recursive: true });
const scratch = process.env.HARBOUR_CHAT_TEST_ROOT || fs.mkdtempSync(path.join(scratchBase, 'chat-windows-'));
process.env.HARBOUR_CHAT_TEST_ROOT = scratch;
const { startFixture, waitFor, click, evaluate } = require('./session-browsing-smoke');
const { chatWindowUrl } = require('../companion/chat-window');
const main = fs.readFileSync(path.join(root, 'desktop/main.js'), 'utf8');
const source = name => main.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^}`, 'm'))[0];
let fixture, win, popup;
const windows = [];
app.whenReady().then(async () => {
  fixture = await startFixture({ cat: 'anime', web: true, parallel: true });
  // Use the real Electron popup routing and lifecycle functions, with only
  // visibility/preload swapped for a fully isolated, hidden browser fixture.
  class HiddenWindow extends BrowserWindow {
    constructor(options) {
      super({ ...options, show: false, webPreferences: { ...options.webPreferences, preload: undefined, offscreen: true, backgroundThrottling: false } });
      windows.push(this); popup = this;
    }
  }
  const ctx = vm.createContext({ BrowserWindow: HiddenWindow, auxiliaryWindows: new Map(), cfg: { url: fixture.base, token: '' },
    chatWindowUrl, randomUUID, path, __dirname: path.join(root, 'desktop'), APP_ICON_PATH: '', remoteBridge: null,
    removeWindowMenu() {}, closeGuard: { register() {}, run: (_win, _reason, fn) => fn() }, shell: { openExternal() { throw new Error('unexpected external link'); } }, console });
  vm.runInContext([source('openDashboardLink'), source('createDashboardSurface')].join('\n'), ctx);
  win = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  windows.push(win);
  win.webContents.setWindowOpenHandler(ctx.openDashboardLink);
  win.webContents.session.webRequest.onBeforeRequest((details, cb) => cb({ cancel: /^https?:/.test(details.url) && !details.url.startsWith(fixture.base) }));
  const send = async (target, text) => {
    await evaluate(target, `document.querySelector('#chatInput').value=${JSON.stringify(text)}`);
    await click(target, '#chatSend');
    await waitFor(target, 'state.chat.running && !!state.chat.activeRunId', 'task submitted');
    const runId = await evaluate(target, 'state.chat.activeRunId');
    for (let i = 0; !fixture.parallelRuns.has(runId) && i < 150; i++) await new Promise(r => setTimeout(r, 30));
    assert.ok(fixture.parallelRuns.has(runId), 'HTTP admission completed');
    return runId;
  };
  await win.loadURL(fixture.base + '/#chat?session=A&agent=main-elaina');
  await waitFor(win, 'state.chat.sessionId==="A" && !routePending', 'exact A loaded');
  const aRun = await send(win, 'A PARALLEL INPUT');
  await click(win, '#chatNewSession'); // Busy plus now opens another window, not a locked toast.
  await waitFor(win, 'state.chat.running', 'original still running');
  for (let i = 0; !popup && i < 100; i++) await new Promise(r => setTimeout(r, 30));
  assert.ok(popup, 'real window.open handler created a separate Electron window');
  const second = popup;
  await waitFor(second, 'state.chat.landing && !state.chat.sessionId && !routePending', 'new window blank composer');
  assert.equal(fixture.requests.filter(r => r.path === '/api/conversations/new').length, 0);
  assert.equal(await evaluate(second, 'state.chat.messages.length'), 0);
  const bRun = await send(second, 'B PARALLEL INPUT');
  const bId = await evaluate(second, 'state.chat.sessionId');
  await waitFor(second, 'state.chat.running && Object.keys(state.chat.channelRuns).length>=1', 'local and remote tasks active at once');
  assert.equal(await evaluate(win, 'state.chat.running'), true);
  assert.equal(fixture.active.size, 2); assert.notEqual(aRun, bRun); assert.notEqual(bId, 'A');
  assert.match(second.webContents.getURL(), new RegExp(`session=${bId}`));
  assert.equal(fixture.requests.filter(r => r.path === '/api/run').length, 2);
  const output = path.join(root, 'assets/reports/chat-windows'); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'original-running.png'), (await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(output, 'second-running.png'), (await second.webContents.capturePage()).toPNG());
  // Refresh A after B changed the backend active pointer. Keep A; don't resubmit.
  await win.reload();
  await waitFor(win, 'state.chat.sessionId==="A" && !routePending && !!document.querySelector("[data-channel-stop]")', 'refresh restores A live run');
  assert.equal(fixture.requests.filter(r => r.path === '/api/run').length, 2);
  await click(win, '[data-channel-stop]');
  await waitFor(win, 'document.querySelector("#chatStream").innerText.includes("A STOPPED ONLY")', 'A stop persisted');
  assert.equal(fixture.parallelRuns.get(bRun).status, 'running', 'stop A leaves B running');
  const stops = fixture.requests.filter(r => r.path.endsWith('/abort'));
  assert.equal(stops.length, 1); assert.equal(stops[0].body.sessionId, 'A');
  fixture.finishParallel(bRun);
  await waitFor(second, `!state.chat.running && document.querySelector('#chatStream').innerText.includes('${bId} FINISHED ONLY')`, 'B completed in own window');
  assert.doesNotMatch(await evaluate(win, 'document.querySelector("#chatStream").innerText'), /B PARALLEL INPUT|N1 FINISHED ONLY/);
  assert.doesNotMatch(await evaluate(second, 'document.querySelector("#chatStream").innerText'), /A PARALLEL INPUT|A STOPPED ONLY/);
  // Close another running window, then reopen its URL: no stop or replay.
  await click(win, '#chatNewWindow');
  for (let i = 0; popup === second && i < 100; i++) await new Promise(r => setTimeout(r, 30));
  const third = popup;
  await waitFor(third, 'state.chat.landing && !routePending', 'third blank window');
  const cRun = await send(third, 'C CLOSE WINDOW INPUT');
  const cId = await evaluate(third, 'state.chat.sessionId');
  const cUrl = third.webContents.getURL(); third.destroy();
  assert.equal(fixture.parallelRuns.get(cRun).status, 'running');
  fixture.finishParallel(cRun);
  const reopened = await ctx.createDashboardSurface('chat', cUrl);
  await waitFor(reopened, `state.chat.sessionId==='${cId}' && !routePending`, 'reopened exact session');
  assert.match(await evaluate(reopened, 'document.querySelector("#chatStream").innerText'), new RegExp(`${cId} FINISHED ONLY`));
  assert.equal((await fetch(fixture.base + `/api/conversations/${cId}`, { method: 'DELETE' })).status, 200);
  await waitFor(reopened, 'state.chat.landing && !state.chat.sessionId && location.hash.includes("new=1")', 'deleted session retires pinned URL');
  // External channel history stays a read-only mirror in its own window.
  const mirror = await ctx.createDashboardSurface('chat', fixture.base + '/#chat?session=Q&agent=main-elaina');
  await waitFor(mirror, 'state.chat.sessionId==="Q" && state.chat.readOnlyMirror && !routePending', 'QQ authority unchanged');
  const otherPersona = await ctx.createDashboardSurface('chat', fixture.base + '/#chat?session=X&agent=main-aemeath');
  await waitFor(otherPersona, 'state.chat.sessionId==="X" && !routePending', 'explicit other persona window');
  assert.equal(await evaluate(otherPersona, 'state.chat.agent==="main-aemeath" && document.body.dataset.themePersona==="aemeath"'), true);
  assert.equal(await evaluate(win, 'state.chat.agent==="main-elaina"'), true, 'other window never changes this Agent');
  await evaluate(win, `document.querySelector('[data-session-switch="B"]').focus()`); // Reveal the focus-within action affordance.
  await click(win, '[data-session-actions="B"]');
  await click(win, '[data-session-window="B"]');
  for (let i = 0; popup === otherPersona && i < 100; i++) await new Promise(r => setTimeout(r, 30));
  await waitFor(popup, 'state.chat.sessionId==="B" && !routePending', 'menu opens exact existing conversation');
  for (const target of windows.filter(w => !w.isDestroyed())) assert.deepEqual(await evaluate(target, 'window.__testErrors'), []);
  assert.equal(fixture.requests.filter(r => r.path === '/api/run').length, 3);
  console.log('PASS real multi-window DOM: native popup, two concurrent tasks, exact refresh, isolated STOP/replies, close/reopen without replay, QQ read-only; no real models');
}).catch(async error => {
  console.error(error); process.exitCode = 1;
  for (const target of windows.filter(w => !w.isDestroyed())) console.error(await evaluate(target,
    `({url:location.href,session:state.chat.sessionId,landing:state.chat.landing,running:state.chat.running,runs:state.chat.channelRuns,
      errors:window.__testErrors,content:document.querySelector('#content').innerText.slice(-3000)})`));
}).finally(async () => {
  for (const target of windows) if (!target.isDestroyed()) target.destroy();
  await fixture?.close();
  // The Node launcher removes the scoped profile after Electron releases its locks.
  app.exit(process.exitCode || 0);
});
