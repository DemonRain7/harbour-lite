const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// Reproduce source-client skew: real new preload, old main without Town IPC.
// The real scene runs in an isolated, never-shown window. No user profile/LLM.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-town-compat-')));
app.on('window-all-closed', () => {});
app.on('browser-window-created', (_event, win) => {
  for (const method of ['show', 'showInactive', 'focus', 'restore', 'moveTop']) win[method] = () => {};
});
let server, dashboard, phase = 'setup', requests = 0, runs = 0, opens = 0, hides = 0, resizes = 0;
const errors = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 90000) {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw new Error(`Timed out: ${phase}`); await wait(50); }
}
async function cleanup() { if (dashboard && !dashboard.isDestroyed()) dashboard.destroy(); server?.closeAllConnections(); server?.close(); }
app.whenReady().then(async () => {
  const root = path.resolve(__dirname, '../../web');
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/run') runs++;
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ enabled: true, activeId: null, asks: [] })); return;
    }
    if (url.pathname === '/host') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><meta charset="utf-8"><title>Town compatibility fixture</title><link rel="stylesheet" href="/town-host.css"><style>html,body{height:100%;margin:0}#root{height:100%;display:flex}</style><main id="root"></main><script src="/town.js"></script>'); return;
    }
    if (url.pathname === '/town/index.html') requests++;
    const file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/host`;
  dashboard = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
    preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
  } });
  const wc = dashboard.webContents, evaluate = code => wc.executeJavaScript(code);
  wc.on('console-message', details => { if (details.level === 'error' && /TypeError|Uncaught|Unhandled|WebGL|shader/.test(details.message)) errors.push(details.message); });
  const mount = () => evaluate('window.dispose=HarbourTownUI.mount(document.getElementById("root")); void 0');
  const release = () => evaluate('dispose(); HarbourTownUI.destroy(); document.getElementById("root").replaceChildren(); void 0');
  await dashboard.loadURL(url);
  assert.equal(await evaluate('typeof harbourDesktop.townOpen'), 'function', 'new preload is present');
  await assert.rejects(evaluate('harbourDesktop.townStatus()'), /No handler registered for 'desktop:town-status'/);
  // Trap forbidden mutations; the absent read-only status handler stays absent.
  ipcMain.handle('desktop:town-open', () => { opens++; throw new Error('unexpected native open'); });
  ipcMain.handle('desktop:town-hide', () => { hides++; });
  ipcMain.on('desktop:town-resize', () => { resizes++; });
  phase = 'old main / new preload fallback';
  // A never-shown Dashboard would correctly hide its iframe with display:none,
  // which Chromium also suspends during shader compilation. Give the host a
  // foreground visibility signal for layout only; never show the OS window.
  // Real Page Visibility / rendering are covered by townBrowser.test.cjs.
  await evaluate('Object.defineProperty(document,"hidden",{get:()=>false}); void 0');
  await mount();
  const world = 'document.querySelector("iframe")?.contentWindow';
  await until(() => evaluate(`!!${world}?.HarbourTown`));
  await evaluate(`Object.defineProperty(${world}.document,"hidden",{get:()=>false}); ${world}.document.dispatchEvent(new Event("visibilitychange")); void 0`);
  await until(() => evaluate(`!!${world}?.HarbourTown?.status().ready`));
  assert.equal(await evaluate('document.querySelector(".town-detached").hidden'), true);
  assert.equal(requests, 1); assert.equal(opens, 0);
  await evaluate(`window.retainedTown=${world}.HarbourTown; ${world}.document.getElementById('popout').click(); void 0`);
  await until(() => evaluate(`${world}.document.getElementById('notice').textContent.includes('重启 Harbour 客户端')`));
  assert.match(await evaluate(`${world}.document.getElementById('popout').textContent`), /需重启/);
  assert.ok(!(await evaluate('document.body.textContent')).includes('No handler'));
  await evaluate('dispose(); document.getElementById("root").replaceChildren(); void 0');
  await mount();
  await until(() => evaluate('document.querySelector(".town-detached").hidden'));
  assert.equal(await evaluate(`${world}.HarbourTown===retainedTown`), true, 'same scene survives route switches');
  assert.equal(requests, 1); assert.equal(opens + hides + resizes, 0, 'no native writes after missing-handler fallback');
  await release();

  phase = 'authorization error must not fall back';
  let probes = 0;
  ipcMain.handle('desktop:town-status', () => { probes++; throw new Error('invalid dashboard'); });
  await dashboard.loadURL(url); await mount();
  await until(() => evaluate('document.querySelector(".town-detached p").textContent.includes("invalid dashboard")'));
  assert.equal(await evaluate('document.querySelector("iframe")===null'), true);
  assert.equal(requests, 1); assert.equal(opens, 0);
  await evaluate('document.querySelector(".town-detached button:last-child").click()');
  await until(() => probes === 2);
  await release(); ipcMain.removeHandler('desktop:town-status');

  phase = 'route departure during capability probe';
  let reply;
  ipcMain.handle('desktop:town-status', () => new Promise(resolve => { reply = resolve; }));
  await dashboard.loadURL(url); await mount(); await until(() => !!reply);
  assert.equal(await evaluate('[...document.querySelectorAll(".town-detached button")].every(b=>b.disabled)'), true);
  await evaluate('dispose(); document.getElementById("root").replaceChildren(); void 0');
  reply({ mode: 'closed' }); await wait(100);
  assert.equal(opens, 0); assert.equal(requests, 1, 'late probe does not start a scene');
  ipcMain.removeHandler('desktop:town-status');

  phase = 'native open failure must not start a duplicate iframe';
  ipcMain.handle('desktop:town-status', () => ({ mode: 'closed' }));
  await dashboard.loadURL(url); await mount();
  await until(() => opens === 1);
  await until(() => evaluate('document.querySelector(".town-detached h2").textContent.includes("unexpected native open")'), 5000);
  await evaluate('window.dispatchEvent(new Event("resize"))'); await wait(100);
  assert.match(await evaluate('document.querySelector(".town-detached h2").textContent'), /unexpected native open/, 'layout updates retain the real error');
  assert.equal(requests, 1); assert.equal(await evaluate('document.querySelector("iframe")===null'), true);
  assert.equal(runs, 0); assert.deepEqual(errors, []);
  assert.ok(BrowserWindow.getAllWindows().every(win => !win.isVisible()));
  await cleanup(); console.log('TOWN_HOST_COMPAT_OK', JSON.stringify({ cases: 4, sceneLoads: requests, llmCalls: runs, foregroundWindows: 0 })); app.exit(0);
}).catch(async error => {
  console.error('TOWN_HOST_COMPAT_FAIL', phase, error.stack || error);
  if (dashboard && !dashboard.isDestroyed()) console.error('FIXTURE_STATE', await dashboard.webContents.executeJavaScript('({host:document.querySelector(".town-stage")?.textContent,loading:document.querySelector("iframe")?.contentDocument?.getElementById("loading")?.textContent})').catch(() => null));
  await cleanup(); app.exit(1);
});
setTimeout(() => { console.error('TOWN_HOST_COMPAT_TIMEOUT', phase); void cleanup().finally(() => app.exit(1)); }, 150000).unref();
