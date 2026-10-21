const { app, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { FoliaController } = require('../folia/controller');
const { SCHEMES } = require('../folia/host');
const createFixtureProbe = require('./folia-fixture-probe');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-folia-empty-')));
protocol.registerSchemesAsPrivileged(SCHEMES);
app.on('window-all-closed', () => {});
let controller;
const probe = createFixtureProbe('folia-empty', () => controller, 100_000);
app.whenReady().then(async () => {
  require('./folia-fixture-locale').prepare();
  controller = new FoliaController({ offline: true });
  try {
    await probe.step('cold window startup', () => controller.open('window'), 40_000);
    const window = controller.runtime.getMainWindow();
    window.show(); window.focus();
    const wc = window.webContents;
    // Fresh profile, no song or audio fixture. Reproduce the supported launch-to-player setting.
    probe.progress('seed empty-player startup preference');
    await probe.js(wc, `localStorage.setItem('folia_app_language','zh-CN');localStorage.setItem('folia_startup_view','player');localStorage.setItem('folia_last_seen_guide_version',${JSON.stringify(require('../../vendor/folia/package.json').version)});`);
    await probe.step('reload empty-player document', () => new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer); wc.off('did-finish-load', loaded); wc.off('did-fail-load', failed);
        if (error) reject(error); else resolve();
      };
      const loaded = () => finish();
      const failed = (_event, code, description, _url, mainFrame) => {
        if (mainFrame) finish(new Error(`Empty-player reload failed: ${code} ${description}`));
      };
      const timer = setTimeout(() => finish(new Error('Empty-player did-finish-load timed out')), 15_000);
      wc.once('did-finish-load', loaded); wc.on('did-fail-load', failed);
      wc.reload();
    }), 17_000);
    await require('./folia-player-panel-checks')(controller, { empty: true, probe });
    console.log('FOLIA_EMPTY_PLAYER_OK');
  } finally { await probe.step('close player', () => controller.close(), 15_000); }
  probe.complete();
  app.exit(0);
}).catch(async error => { fs.writeSync(2, String(error?.stack || error) + '\n'); await probe.fail(error); });
