const { app, BrowserWindow, WebContentsView, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createCoverFixture } = require('./folia-cover-fixture.cjs');

// desktop/tests/folia-lattice-performance.js
// Opt-in, headed native-view measurement against the local dev gallery. No owner profile,
// playback, account or network music is used. Start Folia's Vite before running.
// FOLIA_PERF_URL/FOLIA_PERF_LABEL select serial baseline/upstream trials. Native display DPR stays
// untouched. FOLIA_PERF_COVERS=data retains the legacy data-URL workload; sized URLs are default.
const baseUrl = new URL(process.env.FOLIA_PERF_URL || 'http://127.0.0.1:4173');
assert.ok(['127.0.0.1', 'localhost'].includes(baseUrl.hostname), 'Only a local fixture server is allowed');
const runLabel = process.env.FOLIA_PERF_LABEL || 'current';
const sizedCovers = process.env.FOLIA_PERF_COVERS !== 'data';
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-lattice-perf-')));
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Lattice measurement timed out'); app.exit(1); }, 180_000);
app.whenReady().then(async () => {
  const covers = sizedCovers ? await createCoverFixture(nativeImage) : null;
  const win = new BrowserWindow({ width: 1500, height: 930, show: true, title: 'Folia performance fixture' });
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 20, y: 100, width: 1440, height: 750 });
  const wc = view.webContents;
  const js = code => wc.executeJavaScript(code);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.session.webRequest.onBeforeRequest((details, done) => {
    const url = new URL(details.url);
    done({ cancel: !['data:', 'blob:', 'devtools:'].includes(url.protocol)
      && ![baseUrl.origin, covers?.origin].includes(url.origin) });
  });
  try {
    await wc.loadURL(new URL('/dev-probe.html', baseUrl).href);
    const fixture = { story: process.env.FOLIA_PERF_PROBE || 'harbourLatticePerformance',
      props: { queueSize: 1200, bitmapCovers: !sizedCovers, coverBaseUrl: covers?.origin ?? '' } };
    await js(`localStorage.setItem('i18nextLng','en'); localStorage.setItem('static_mode','false'); window.mount(${JSON.stringify(fixture)})`);
    for (let i = 0; i < 100 && !await js("!!document.querySelector('.lattice-lyrics.is-ready canvas')"); i++) await pause(100);
    assert.equal(await js("!!document.querySelector('.lattice-lyrics.is-ready canvas')"), true);
    await pause(1600);
    const artwork = await js(`Array.from(document.querySelectorAll('.lattice-poster')).slice(0, 3).map(card => ({
      source: card.querySelector('img')?.getAttribute('src') ?? getComputedStyle(card).backgroundImage,
      loaded: card.querySelector('img')?.naturalWidth ?? null
    }))`);
    console.log('NATIVE_ARTWORK', JSON.stringify(artwork));
    if (covers) assert.ok(covers.report().uniqueVariants > 0, 'Scaled artwork fixture must actually load its local covers');
    wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Performance.enable');
    const metrics = async () => Object.fromEntries((await wc.debugger.sendCommand('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const reports = [];
    for (const [label, dx] of [['nearby', 1], ['cross-boundaries', 18], ['return', -18], ['fast-boundaries', 60]]) {
      await pause(1000);
      const before = await metrics();
      const sample = await js(`(async () => {
        const field = document.querySelector('.lattice-field'), world = field.querySelector('.lattice-world');
        const times=[], mounts=[], seen=new WeakSet(field.querySelectorAll('.lattice-poster'));
        window.__renderCounts = {};
        const observer = new MutationObserver(records => {
          for(const record of records) for(const node of record.addedNodes) if(node instanceof Element && node.matches('.lattice-poster') && !seen.has(node)) {
            seen.add(node); mounts.push({time:performance.now(),opacity:node.style.opacity,transform:node.style.transform});
          }
        });
        observer.observe(world,{childList:true});
        const origin = new DOMMatrix(getComputedStyle(world).transform);
        for(let i=0;i<180;i++) await new Promise(resolve => requestAnimationFrame(time => {
          times.push(time); field.dispatchEvent(new WheelEvent('wheel',{deltaX:${dx},deltaY:${dx / 6},bubbles:true,cancelable:true})); resolve();
        }));
        observer.disconnect();
        const frames=times.slice(1).map((time,i)=>({ms:time-times[i],mounts:mounts.filter(m=>m.time>=times[i]&&m.time<time).length}));
        const sorted=frames.map(f=>f.ms).sort((a,b)=>a-b);
        return {dpr:devicePixelRatio,width:innerWidth,height:innerHeight,scale:origin.a,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],max:sorted.at(-1),over25ms:frames.filter(f=>f.ms>25).length,
          newPosters:mounts.length,animatedMounts:mounts.filter(m=>m.opacity==='0').length,mounted:world.children.length,renders:window.__renderCounts,
          slowFrames:frames.filter(f=>f.ms>16).slice(0,10)};
      })()`);
      const after = await metrics();
      const report = { runLabel, label, covers: covers?.report() ?? { kind: 'data-url' }, ...sample, scriptMs: (after.ScriptDuration-before.ScriptDuration)*1000,
        layoutMs:(after.LayoutDuration-before.LayoutDuration)*1000,styleMs:(after.RecalcStyleDuration-before.RecalcStyleDuration)*1000 };
      reports.push(report); console.log('NATIVE_LATTICE', JSON.stringify(report));
    }
    console.log('NATIVE_GPU', JSON.stringify(app.getGPUFeatureStatus()));
    console.log('NATIVE_PROCESS_MEMORY', JSON.stringify(app.getAppMetrics().map(item => ({ type: item.type, memory: item.memory }))));
  } finally { clearTimeout(deadline); wc.close(); win.destroy(); await covers?.close(); app.quit(); }
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
