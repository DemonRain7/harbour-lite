const { contextBridge, ipcRenderer } = require('electron');
const arg = name => { try { return decodeURIComponent(process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3) || ''); } catch { return ''; } };
const expected = arg('town-url');
if (process.isMainFrame && location.href.split('#')[0] === expected) {
  const token = arg('town-token');
  if (token) { try { localStorage.setItem('harbour-token', token); } catch {} }
  let beforeClose, state;
  const listeners = new Set();
  ipcRenderer.on('town:state', (_event, next) => { state = next; for (const fn of listeners) fn(next); });
  ipcRenderer.on('desktop:before-close', async (_event, payload) => {
    if (!payload || typeof payload.requestId !== 'string' || !['close', 'quit', 'reload', 'navigate'].includes(payload.reason)) return;
    const reply = fields => ipcRenderer.send('desktop:before-close-result', { requestId: payload.requestId, ...fields });
    if (!beforeClose) { reply({ phase: 'unavailable' }); return; }
    reply({ phase: 'pending' });
    const timer = setInterval(() => reply({ phase: 'pending' }), 1000);
    try { reply({ phase: 'result', allowed: await beforeClose({ reason: payload.reason, phase: payload.phase }) === true }); }
    catch { reply({ phase: 'unavailable' }); }
    finally { clearInterval(timer); }
  });
  contextBridge.exposeInMainWorld('harbourTownHost', {
    status: () => ipcRenderer.invoke('town:status'),
    popout: () => ipcRenderer.invoke('town:popout'),
    fullscreen: () => ipcRenderer.invoke('town:fullscreen'),
    dock: () => ipcRenderer.invoke('town:dock'),
    onState: fn => { listeners.add(fn); if (state) fn(state); return () => listeners.delete(fn); },
    onBeforeClose: fn => { beforeClose = fn; },
  });
}
