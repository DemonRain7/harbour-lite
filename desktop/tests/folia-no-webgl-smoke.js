const { app, BrowserWindow } = require('electron');
const { build } = require('esbuild');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Mount the real Folia components with GPU support deliberately disabled in an
// isolated renderer. This never changes the owner's graphics settings/profile.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-folia-no-webgl-')));
app.commandLine.appendSwitch('disable-webgl');
app.on('window-all-closed', () => {});
const sourceRoot = path.resolve(__dirname, '../../vendor/folia');

app.whenReady().then(async () => {
  const bundle = await build({
    stdin: { resolveDir: sourceRoot, loader: 'tsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { motionValue } from 'framer-motion';
      import Latent from './src/components/visualizer/backgrounds/latent/LatentBackground';
      import Nomand from './src/components/visualizer/backgrounds/nomand/NomandBackgroundLayer';
      import Border from './src/components/app/overlays/now-playing-toast/PulsingBorderProgress';
      const theme = { backgroundColor: '#123456', primaryColor: '#abcdef', secondaryColor: '#fedcba', accentColor: '#654321' };
      const bands = { bass: motionValue(0), lowMid: motionValue(0), mid: motionValue(0), vocal: motionValue(0), treble: motionValue(0) };
      const progress = motionValue(40);
      window.advanceProgress = () => progress.set(75);
      createRoot(document.getElementById('root')).render(<>
        <section style={{position:'relative',width:320,height:160}}><Latent theme={theme} audioBands={bands} audioPower={motionValue(0)} staticMode={false} paused={false}/></section>
        <section style={{position:'relative',width:320,height:160}}><Nomand theme={theme} coverUrl="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'%3E%3Crect width='10' height='10' fill='pink'/%3E%3C/svg%3E"/></section>
        <Border progress={progress} width={320} height={100} baseColor="#abcdef"/>
      </>);
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' },
  });
  const win = new BrowserWindow({ show: false, width: 700, height: 600, webPreferences: { webgl: false, offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadURL('data:text/html,' + encodeURIComponent(`<style>body{background:#123456}.absolute{position:absolute}.inset-0{inset:0}.h-full{height:100%}.w-full{width:100%}.object-cover{object-fit:cover}</style><div id="root"></div>`));
    await win.webContents.executeJavaScript(`window.fixtureErrors=[];addEventListener('error',e=>fixtureErrors.push(e.message));addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason)));`);
    assert.equal(await win.webContents.executeJavaScript(`document.createElement('canvas').getContext('webgl2')===null`), true);
    await win.webContents.executeJavaScript(bundle.outputFiles[0].text);
    for (let i = 0; i < 100; i++) {
      if (await win.webContents.executeJavaScript(`document.querySelectorAll('[data-shader-fallback]').length===3`)) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('[data-shader-fallback]').length`), 3);
    await win.webContents.executeJavaScript('advanceProgress()');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-shader-fallback="progress"] rect[pathLength]').getAttribute('stroke-dashoffset')`), '0.25');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('canvas').length`), 0, 'unsupported shaders never mount a canvas');
    assert.deepEqual(await win.webContents.executeJavaScript('fixtureErrors'), []);
    const reportDir = path.resolve(__dirname, '../../assets/reports/folia');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'no-webgl-fallback.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
    console.log('FOLIA_NO_WEBGL_OK: real theme/cover fallbacks, live progress and zero renderer errors');
  } finally { win.destroy(); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
setTimeout(() => app.exit(2), 45_000).unref();
