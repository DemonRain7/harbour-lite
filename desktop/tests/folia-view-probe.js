const { app, BrowserWindow, WebContentsView } = require('electron');
app.whenReady().then(async () => {
  const music = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  const host = new BrowserWindow({ show: false });
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } });
  Object.defineProperty(music, 'webContents', { value: view.webContents });
  music.contentView.addChildView(view);
  await music.webContents.loadURL('data:text/html,<body>Folia view probe<script>window.marker=42</script>');
  music.contentView.removeChildView(view);
  host.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  if (await music.webContents.executeJavaScript('window.marker') !== 42) throw new Error('state lost');
  host.contentView.removeChildView(view);
  music.contentView.addChildView(view);
  if (await music.webContents.executeJavaScript('window.marker') !== 42) throw new Error('state lost on return');
  console.log('FOLIA_VIEW_PROBE_OK');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
