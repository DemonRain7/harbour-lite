const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { VisualPolicy, windowsPresentationProbe } = require('../companion/visual-policy');

// One hidden software-rendered page, silent synthetic audio, no Harbour server,
// real songs, credentials or task execution. The active UI clock is simulated.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-visual-smoke-'));
app.setPath('userData', directory);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.on('window-all-closed', () => {});
let win, policy;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('visual policy smoke timed out'); app.exit(1); }, 20000);

app.whenReady().then(async () => {
  if (process.platform === 'win32') assert.equal(typeof windowsPresentationProbe()(), 'boolean');
  policy = new VisualPolicy({ platform: 'test' });
  ipcMain.handle('desktop:visual-policy', event => policy.forSender(event));
  win = new BrowserWindow({ show: false, width: 300, height: 160, webPreferences: {
    preload: path.resolve(__dirname, '../preload.js'), backgroundThrottling: false,
    contextIsolation: true, nodeIntegration: false, sandbox: false,
  } });
  win.webContents.on('console-message', details => { if (details.level === 'error') console.error('renderer:', details.message); });
  win.webContents.on('preload-error', (_event, _file, error) => console.error('preload:', error));
  // Never call show/focus. Pretend this page is a visible presentation only for policy.
  win.isVisible = () => true;
  policy.register(win);
  await win.loadURL('data:text/html,' + encodeURIComponent('<title>Isolated visual policy test</title><style>@keyframes breathe{to{opacity:.3}}#dot{animation:breathe 1s infinite}</style><div id="dot">*</div>'));
  await win.webContents.executeJavaScript(fs.readFileSync(path.resolve(__dirname, '../../web/visual-activity.js'), 'utf8'));
  await win.webContents.executeJavaScript('window.pollCount=0;window.poll=HarbourVisualActivity.poll(()=>window.pollCount++,40);void 0');
  const wav = Buffer.alloc(44 + 16000);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(16000, 40);
  await win.webContents.executeJavaScript(`window.audio=new Audio('data:audio/wav;base64,${wav.toString('base64')}');audio.loop=true;audio.volume=0;audio.play();`);
  await wait(200);
  const initial = await win.webContents.executeJavaScript('pollCount'); assert.ok(initial > 1);
  policy.setMode('quiet'); await wait(80);
  const paused = await win.webContents.executeJavaScript('({count:pollCount,paused:audio.paused,css:getComputedStyle(document.getElementById("dot")).animationPlayState})');
  assert.equal(paused.paused, false); assert.equal(paused.css, 'paused');
  await wait(200); assert.equal(await win.webContents.executeJavaScript('pollCount'), paused.count);
  assert.equal(await win.webContents.executeJavaScript('audio.paused'), false);
  policy.setMode('normal'); await wait(180);
  assert.ok(await win.webContents.executeJavaScript('pollCount') > paused.count);
  assert.equal(await win.webContents.executeJavaScript('getComputedStyle(document.getElementById("dot")).animationPlayState'), 'running');
  await win.webContents.executeJavaScript('poll.dispose();audio.pause()');
  console.log('PASS native binding, real IPC, CSS pause/resume, non-overlapping visual clock and uninterrupted silent HTML audio');
  console.log(`Isolated test profile: ${directory}`);
}).then(() => { clearTimeout(deadline); policy?.dispose(); win?.destroy(); app.exit(0); })
  .catch(error => { console.error(error); clearTimeout(deadline); policy?.dispose(); win?.destroy(); app.exit(1); });
