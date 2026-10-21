// Read-only preview of real Spaces UI, with neutral local artwork and no live backend.
// node tests/web/spaces.preview.cjs
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../web');
const file = (id, name, caption, presentation) => ({ id: id.repeat(64) + '.svg', name, caption, presentation, mime: 'image/svg+xml', size: 1024 });
const entries = [
  { id: 'a'.repeat(32), title: '雨后的一只纸船', kind: 'comic', files: [file('1', 'panel-01.svg', '雨停了，她把纸船交给清晨的水流。'), file('2', 'panel-02.svg', '小船沿着河岸，慢慢漂向远方。')] },
  { id: 'b'.repeat(32), title: '夏日来信', kind: 'image', files: [file('3', 'summer.svg')] },
  { id: 'c'.repeat(32), title: '旧竖图 · 保留完整', kind: 'comic', files: [file('4', 'old-portrait.svg', '旧竖图不裁切、不拉伸；剧情文字独立显示。')] },
  { id: 'd'.repeat(32), title: '仅余拼版 · 存档兜底', kind: 'comic', files: [file('5', 'old-page.svg', undefined, 'comic-page')] },
].map(e => ({ ...e, status: 'completed', createdAt: '2026-09-29T09:00:00Z', updatedAt: '2026-09-29T09:00:00Z', favorite: false, revision: 1, collectionId: null }));
const bootstrap = `<script>
localStorage.setItem('harbour-theme-cat','anime'); localStorage.setItem('harbour-theme-persona','elaina'); localStorage.setItem('harbour-theme','anime-wisteria');
window.WebSocket = class extends EventTarget { static OPEN=1; readyState=1; send(){} close(){} };
</script>`;
const fixtures = { '/api/time-settings': { timeZone: 'America/New_York', revision: 1 }, '/api/asks': { asks: [] }, '/api/agents': { agents: [] }, '/api/conversations/explorer': { enabled: true, sessions: [] }, '/api/cowork/devices': { devices: [] } };
const artwork = id => {
  const h = id.startsWith('4') ? 900 : id.startsWith('5') ? 1200 : 600;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="${h}" viewBox="0 0 600 ${h}"><rect width="600" height="${h}" fill="#e2ded5"/><circle cx="440" cy="135" r="60" fill="#fff8de"/><path d="M0 290Q170 180 320 300T600 250V${h}H0" fill="#9faea5"/><path d="M0 360Q240 240 390 400T600 350V${h}H0" fill="#778e91"/><path d="M180 420L320 460L440 420L340 500L270 500Z" fill="#fff9e9"/><path d="M180 420L305 375L320 460M305 375L440 420" stroke="#d6ccbe" stroke-width="2" fill="#f3ecdd"/><text x="30" y="${h - 36}" fill="white" font-family="serif" font-size="23">Harbour · ${h === 600 ? 'Square' : 'Original aspect ratio'}</text><rect x="4" y="4" width="592" height="${h - 8}" rx="2" stroke="#fff9e9" fill="none" stroke-width="2"/></svg>`;
};
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method !== 'GET') { res.writeHead(405); return res.end('Read-only fixture'); }
  if (url.pathname.startsWith('/api/spaces/files/')) { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end(artwork(path.basename(url.pathname))); }
  if (url.pathname.startsWith('/api/')) {
    let result = fixtures[url.pathname] || {};
    if (url.pathname === '/api/spaces') {
      const list = entries.filter(e => (!url.searchParams.get('kind') || e.kind === url.searchParams.get('kind')) && e.title.includes(url.searchParams.get('q') || ''));
      result = { entries: list.map(({files,...e}) => ({...e, cover:files[0],fileCount:files.length})), total:list.length, hasMore:false, counts:{all:4,comic:3,image:1,document:0,file:0,favorite:0}, collections:[] };
    } else if (url.pathname.startsWith('/api/spaces/entries/')) result = entries.find(e => url.pathname.endsWith(e.id)) || {};
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(result));
  }
  let pathname; try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!target.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    let data = fs.readFileSync(target);
    if (target === path.join(root,'index.html')) data = data.toString().replace('<head>', '<head>' + bootstrap);
    const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2'};
    res.writeHead(200, {'Content-Type':mime[path.extname(target)] || 'application/octet-stream','Cache-Control':'no-store'}); res.end(data);
  } catch { res.writeHead(404); res.end(); }
}).listen(0, '127.0.0.1', function() { console.log(`Spaces preview: http://127.0.0.1:${this.address().port}/#spaces`); });
