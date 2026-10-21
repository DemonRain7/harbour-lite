const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

let child;
let stopping = false;
const port = Number(process.env.HARBOUR_LITE_DESKTOP_PORT || 7799);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid desktop port');
const origin = `http://127.0.0.1:${port}`;
async function health() {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(700) });
    const result = await response.json();
    return result.app === 'harbour-lite' && result.ok;
  } catch {
    return false;
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      // Desktop always uses its own loopback address. It never alters another application's service.
      if (!(await health())) {
        child = spawn(process.execPath, [path.resolve(__dirname, '../dist/server.js')], {
          cwd: path.resolve(__dirname, '..'),
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            HARBOUR_LITE_PORT: String(port),
            HARBOUR_LITE_HOST: '127.0.0.1',
          },
        });
        child.on('error', () => {});
        child.stderr.on('data', () => {});
        let ready = false;
        for (let attempt = 0; attempt < 60 && child.exitCode === null; attempt++) {
          if (await health()) {
            ready = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!ready) {
          dialog.showErrorBox(
            'Harbour Lite 未能启动',
            '请先运行 npm run build，并检查端口 7799 是否被占用。没有停止其他程序。',
          );
          app.quit();
          return;
        }
      }
      const window = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 760,
        minHeight: 620,
        show: process.env.HARBOUR_LITE_TEST_HIDDEN !== '1',
        title: 'Harbour Lite',
        backgroundColor: '#f6f5ef',
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          backgroundThrottling: true,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, url) => {
        if (new URL(url).origin !== origin) event.preventDefault();
      });
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      window.webContents.session.setPermissionCheckHandler(() => false);
      window.loadURL(origin);
    })
    .catch(() => {
      dialog.showErrorBox(
        'Harbour Lite',
        '桌面端启动失败。可使用 npm start 后在浏览器访问工作台。',
      );
      app.quit();
    });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (!child || child.exitCode !== null || stopping) return;
    event.preventDefault();
    stopping = true;
    // Only stop the exact process created here, never an existing browser-mode server.
    child.once('exit', () => app.quit());
    child.kill('SIGTERM');
    setTimeout(() => app.quit(), 3000).unref();
  });
}
