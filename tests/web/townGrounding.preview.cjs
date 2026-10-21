// Local-only manual visual QA. Serves existing assets; no backend, LLM or saved state.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const web = path.resolve(__dirname, '../../web');
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  if (name === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><title>Harbour · 脚步接地验收</title>
      <style>body{margin:0;background:#171722;color:#faf6f1;font:14px system-ui}canvas{display:block;width:100vw;height:100vh}
      header{position:fixed;top:16px;left:16px;max-width:620px;padding:16px 20px;background:#201f30dd;border-radius:16px}h1{font-size:18px;margin:0 0 10px}
      button,select{font:inherit;padding:7px 12px;margin:4px;border:0;border-radius:8px}output{display:block;white-space:pre-wrap;margin-top:8px}</style>
      <header><h1>Harbour · 咖啡厅门口往返验收</h1><select aria-label="测试角色"><option value="main-aemeath">爱弥斯</option><option value="main-elaina">伊蕾娜</option><option value="chisa">千咲</option></select>
      <button id="run" disabled>往返测试</button><button id="play" disabled>播放散步</button><button id="save" disabled>保存测试画面</button><output>正在加载地图与模型…</output></header><canvas></canvas>
      <script type="importmap">{"imports":{"three":"/town/lib/three/build/three.module.js","three/addons/":"/town/lib/three/examples/jsm/"}}</script>
      <script type="module" src="/qa.js"></script>`); return;
  }
  const file = name === '/qa.js' ? path.join(__dirname, 'townGrounding.preview.js') : path.resolve(web, '.' + decodeURIComponent(name));
  if (name !== '/qa.js' && !file.startsWith(web + path.sep)) { res.writeHead(403).end(); return; }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg' })[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
server.listen(0, '127.0.0.1', () => console.log(`Town grounding QA: http://127.0.0.1:${server.address().port}`));
