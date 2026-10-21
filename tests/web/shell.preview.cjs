// Real dashboard assets with isolated, read-only data and a fake Electron bridge.
// Run with `node tests/web/shell.preview.cjs`; it never contacts the live backend.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../web');
const fixtures = {
  '/api/time-settings': { timeZone: 'America/New_York', revision: 1 },
  '/api/asks': { asks: [] },
  '/api/calendar/status': { connected: true, configured: true },
  '/api/calendar/calendars': { calendars: [{ id: 'primary', summary: '界面验收 · 示例日历', primary: true, accessRole: 'owner', timeZone: 'America/New_York' }] },
  '/api/calendar/events': { events: [] },
  '/api/agents': { agents: [{ name: 'main-elaina', description: 'Elaina', skills: [] }] },
  '/api/state': { defaultAgent: 'main-elaina' },
  '/api/conversations/explorer': { enabled: true, sessions: [] },
  '/api/skills': { skills: [] },
  '/api/models': { models: [] },
  '/api/cowork/devices': { devices: [] },
};
const bootstrap = `<script>
if (!localStorage.getItem('harbour-theme')) {
  localStorage.setItem('harbour-theme-cat', 'anime');
  localStorage.setItem('harbour-theme-persona', 'elaina');
  localStorage.setItem('harbour-theme', 'anime-wisteria');
}
window.WebSocket = class extends EventTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
  readyState = 0;
  constructor() { super(); setTimeout(() => { this.readyState = 1; this.onopen?.(new Event('open')); }, 0); }
  send() {} close() { this.readyState = 3; }
};
let refreshes = 0;
window.harbourDesktop = {
  isElectron: new URLSearchParams(location.search).get('desktop') !== '0',
  petCatalog: [], setCompanionAppearance: async () => {}, getCompanionState: async () => ({}),
  reloadDashboard: async () => {
    document.getElementById('previewStatus').textContent = '刷新已触发 ' + (++refreshes) + ' 次 · 未操作真实客户端';
    return false;
  },
};
</script>`;
const badge = '<output id="previewStatus" style="position:fixed;bottom:8px;right:12px;z-index:2000;font:11px system-ui;color:var(--fg-dim);background:var(--bg-2);padding:6px 10px;border-radius:8px">隔离界面验收 · 无真实数据</output>';
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method !== 'GET') { res.writeHead(405); return res.end('Read-only fixture'); }
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(fixtures[url.pathname] || {}));
  }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    let data = fs.readFileSync(file);
    if (file === path.join(root, 'index.html')) data = data.toString().replace('<head>', '<head>' + bootstrap).replace('</body>', badge + '</body>');
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
server.listen(0, '127.0.0.1', () => console.log(`Shell preview: http://127.0.0.1:${server.address().port}/#calendar`));
