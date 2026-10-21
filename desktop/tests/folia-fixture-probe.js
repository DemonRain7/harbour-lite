const { app, BrowserWindow } = require('electron');

// desktop/tests/folia-fixture-probe.js
// Bounded diagnostics for isolated native fixtures; never retry a media command.
module.exports = function createFoliaFixtureProbe(name, getController, timeoutMs) {
  let phase = 'electron-ready';
  const started = Date.now();
  const bounded = async (work, label, limit = 15_000) => {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name}: ${label} timed out during ${phase}`)), limit); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const progress = label => {
    phase = label;
    console.log(`[${name}] ${label} (${Date.now() - started} ms)`);
  };
  const diagnostic = async () => {
    const controller = getController();
    const wc = controller?.runtime?.getMainWindow()?.webContents;
    const state = { phase, elapsedMs: Date.now() - started,
      mode: controller?.mode, starting: !!controller?.starting,
      rendererReady: !!controller?.rendererReady, health: controller?.rendererHealth.snapshot(),
      windows: BrowserWindow.getAllWindows().map(win => ({ visible: win.isVisible(), bounds: win.getBounds() })) };
    if (wc && !wc.isDestroyed()) {
      state.rendererCrashed = wc.isCrashed();
      state.renderer = await bounded(() => wc.executeJavaScript(`({
        ready:document.readyState,lang:document.documentElement.lang,
        splash:!!document.querySelector('#app-splash'),lattice:!!document.querySelector('.lattice-root'),
        bridge:!!window.harbourFolia,buttons:[...document.querySelectorAll('button')].slice(0,15).map(b=>b.title||b.innerText),
        audio:[...document.querySelectorAll('audio')].map(a=>({readyState:a.readyState,paused:a.paused,currentTime:a.currentTime,error:a.error?.code}))
      })`), 'diagnostic renderer', 1500).catch(error => error.message);
    }
    console.error(`[${name} diagnostic]`, JSON.stringify(state));
  };
  const watchdog = setTimeout(() => {
    console.error(`[${name}] hard deadline exceeded during ${phase}`);
    void diagnostic().finally(() => app.exit(2));
  }, timeoutMs);
  watchdog.unref();
  app.on('web-contents-created', (_event, contents) => {
    contents.on('render-process-gone', (_event, details) => {
      console.error(`[${name}] render-process-gone`, JSON.stringify({ phase, reason: details.reason, exitCode: details.exitCode }));
    });
  });
  app.on('child-process-gone', (_event, details) => {
    console.error(`[${name}] child-process-gone`, JSON.stringify({ phase, type: details.type, reason: details.reason, exitCode: details.exitCode }));
  });
  return {
    progress,
    async step(label, work, limit) { progress(label); return bounded(work, label, limit); },
    js(wc, code, userGesture = true) { return bounded(() => wc.executeJavaScript(code, userGesture), 'renderer script'); },
    async fail(error) { clearTimeout(watchdog); console.error(error); await diagnostic(); app.exit(1); },
    complete() { clearTimeout(watchdog); progress('complete'); },
  };
};
