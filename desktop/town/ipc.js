function registerTownIpc({ ipcMain, controller, dashboard }) {
  ipcMain.handle('desktop:town-status', event => { dashboard(event); return controller().status(); });
  ipcMain.handle('desktop:town-open', (event, mode, bounds, visible) => {
    const parent = dashboard(event); return controller().open(mode, parent, bounds, visible !== false);
  });
  ipcMain.on('desktop:town-resize', (event, bounds, visible) => { try { const parent = dashboard(event); controller().resize(parent, bounds, visible !== false); } catch {} });
  ipcMain.handle('desktop:town-hide', event => { const parent = dashboard(event); return controller().hide(parent); });
  for (const action of ['status', 'popout', 'fullscreen', 'dock']) ipcMain.handle(`town:${action}`, async event => {
    const town = controller();
    if (!town.owns(event)) throw new Error('无效的小镇窗口');
    if (action === 'status') return town.status();
    if (action === 'popout') return town.open('window');
    if (action === 'fullscreen') return town.fullscreen();
    await town.returnToDashboard(); return true;
  });
}
module.exports = { registerTownIpc };
