// Hidden, muted Chromium verifies actual MP4 decoding, seeking and failure UX.
// All profiles/screenshots are local and ignored; no live models or user clipboard.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.local/qa-showcase');

if (!process.versions.electron) {
  fs.mkdirSync(output, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(output, 'profile-'));
  const env = { ...process.env, HARBOUR_SHOWCASE_PROFILE: scratch }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('../../desktop/node_modules/electron'), [__filename, ...process.argv.slice(2)],
    { cwd: root, env, windowsHide: true, stdio: 'inherit' });
  child.once('error', error => { console.error(error); process.exitCode = 1; });
  child.once('close', code => {
    assert.equal(path.dirname(path.resolve(scratch)), output);
    assert.ok(path.basename(scratch).startsWith('profile-'));
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    process.exitCode = code || 0;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const { createServer } = require('node:http');
  app.setPath('userData', process.env.HARBOUR_SHOWCASE_PROFILE);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-background-networking');
  app.on('window-all-closed', () => {});
  let win, server, failVideo = false;
  const live = process.argv.includes('--live');
  const allowed = new Map([
    ['', ['index.html', 'text/html; charset=utf-8']], ['showcase.css', ['showcase.css', 'text/css']],
    ['showcase.js', ['showcase.js', 'text/javascript']],
    ['media/harbour-story.mp4', ['media/harbour-story.mp4', 'video/mp4']],
    ['media/harbour-story-poster.png', ['media/harbour-story-poster.png', 'image/png']],
  ]);
  const safety = setTimeout(() => { console.error('Showcase test exceeded 60s'); app.exit(1); }, 60000);
  app.whenReady().then(async () => {
    let url = 'https://demonrain7.github.io/harbour-lite/';
    if (!live) {
      server = createServer((req, res) => {
        const key = new URL(req.url, 'http://localhost').pathname.replace(/^\/harbour-lite\//, '');
        const entry = allowed.get(key);
        if (!entry || (failVideo && entry[1] === 'video/mp4')) { res.writeHead(404); return res.end(); }
        const file = path.join(root, 'docs', entry[0]), size = fs.statSync(file).size;
        let start = 0, end = size - 1;
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        if (range) { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
        if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
        res.writeHead(range ? 206 : 200, { 'Content-Type': entry[1], 'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store', 'Content-Length': end - start + 1,
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
        if (req.method === 'HEAD') return res.end();
        const stream = fs.createReadStream(file, { start, end }); stream.pipe(res);
        res.on('close', () => stream.destroy());
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${server.address().port}/harbour-lite/`;
    }
    win = new BrowserWindow({ show: false, width: 1280, height: 1100,
      webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.setAudioMuted(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const origin = new URL(url).origin, errors = [];
    win.webContents.session.webRequest.onBeforeRequest((details, cb) => cb({ cancel: /^https?:/.test(details.url) && new URL(details.url).origin !== origin }));
    win.webContents.on('console-message', event => { if (event.level === 'error' && !/404|Failed to load resource/.test(event.message)) errors.push(event.message); });
    const evaluate = source => win.webContents.executeJavaScript(source, true);
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const wait = async (condition, label) => {
      for (let i = 0; i < 240; i++) { if (await evaluate(condition)) return; await pause(50); }
      throw new Error('Timed out: ' + label + ' ' + JSON.stringify(await evaluate('({status:document.querySelector("#player-status")?.textContent,error:document.querySelector("#film")?.error?.message})')));
    };
    await win.loadURL(url);
    await wait('document.querySelector("#film").readyState >= 2', 'metadata + decoded first frame');
    const metadata = await evaluate('(() => { const v=document.querySelector("#film"); return {width:v.videoWidth,height:v.videoHeight,duration:v.duration,paused:v.paused,controls:v.controls,autoplay:v.autoplay}; })()');
    assert.equal(metadata.width, 1920); assert.equal(metadata.height, 1080);
    assert.ok(metadata.duration >= 78 && metadata.duration < 79);
    assert.equal(metadata.paused, true); assert.equal(metadata.autoplay, false); assert.equal(metadata.controls, true);
    await evaluate('document.querySelector("#play-film").click()');
    await wait('document.querySelector("#film").currentTime > 1 && document.querySelector("#film").webkitDecodedFrameCount > 0', 'actual playback');
    await evaluate('document.querySelector("#film").pause(); document.querySelector("#film").currentTime=39');
    await wait('!document.querySelector("#film").seeking && document.querySelector("#film").currentTime >= 39 && document.querySelector("#film").readyState >= 2', 'seek into middle');
    await pause(200);
    fs.writeFileSync(path.join(output, live ? 'live-desktop.png' : 'desktop.png'), (await win.webContents.capturePage()).toPNG());
    await evaluate('document.querySelector("#film").currentTime=75');
    await wait('!document.querySelector("#film").seeking && document.querySelector("#film").currentTime >= 75', 'seek near end');
    win.setSize(390, 860); await pause(150);
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'no mobile horizontal overflow');
    fs.writeFileSync(path.join(output, live ? 'live-mobile.png' : 'mobile.png'), (await win.webContents.capturePage()).toPNG());
    await evaluate('Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{window.__copied=text;}}}); document.querySelector("#copy-prompt").click()');
    await wait('!!window.__copied', 'copy handler');
    assert.match(await evaluate('window.__copied'), /docs\/AGENT-SETUP\.md/);
    await evaluate('Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async()=>{throw Error("blocked");}}});document.querySelector("#copy-prompt").click()');
    await wait('document.querySelector("#prompt-details").open', 'manual copy fallback');
    if (!live) {
      failVideo = true;
      await evaluate('document.querySelector("#film source").src="media/harbour-story.mp4?failure-fixture";document.querySelector("#film").load()');
      await wait('!document.querySelector("#player-error").hidden', 'real media failure UX');
      failVideo = false;
      await evaluate('document.querySelector("#retry").click()');
      await wait('document.querySelector("#film").readyState >= 2 && document.querySelector("#player-error").hidden', 'retry recovery');
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, live, metadata, played: true, seek: [39, 75], mobile: true, copy: true, failureRecovery: !live }));
  }).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    clearTimeout(safety); win?.destroy(); server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    app.exit(process.exitCode || 0);
  });
}
