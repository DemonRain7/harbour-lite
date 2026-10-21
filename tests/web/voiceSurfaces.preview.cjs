// Manual CUA/browser visual fixture. No model, real config, credentials or paid synthesis.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { OrbController } = require('../../desktop/companion/orb-controller');
const root = path.resolve(__dirname, '../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-voice-preview-'));
const orb = new OrbController({ dataDir: dir, deviceId: 'isolated-voice-preview', screen: new EventEmitter(), agents: ['elaina','aemeath'].map(id => ({ id, agentName: `main-${id}`, displayName: id === 'elaina' ? 'Elaina' : 'Aemeath' })),
  getConfig: () => ({ url: 'http://127.0.0.1:1' }), getAppearance: () => ({ theme: 'anime-wisteria', persona: 'elaina' }) });
orb.enabled = true; orb.expanded = true; orb.pinned = true; orb.connection = 'open';
orb.layout = { expanded: true, panel: { x: 12, y: 10, width: 560, height: 620 }, ball: { x: 580, y: 600, width: 48, height: 48 } };
const snapshot = orb.snapshot(); snapshot.chat.title = '音色选择 · 隔离测试';
const catalogue = { selections: {}, voices: [
  { id:'auto', label:'跟随默认服务', group:'默认', available:true, description:'原有主服务 → 腾讯精品备用' },
  { id:'tencent:101001', label:'智瑜', group:'腾讯 · 精品', available:true, description:'中文女声 · 低成本备用' },
  { id:'tencent:501004', label:'月华', group:'腾讯 · 大模型', available:true, description:'聊天女声 · 使用大模型额度' },
  { id:'tencent:402000', label:'云晓芙', group:'腾讯 · 超自然大模型', available:true, description:'聊天女声 · 使用超自然大模型额度' },
  { id:'custom:aemeath', label:'Aemeath · 专属声线', group:'自定义与角色声线', available:false },
  { id:'custom:elaina', label:'Elaina · 专属声线', group:'自定义与角色声线', available:false },
] };
const shim = `(() => {
 const state = ${JSON.stringify(snapshot)}; let listener;
 const choice = input => fetch('/fixture/choice', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}).then(r=>r.json());
 window.harbourOrb = {onState:fn=>{listener=fn;},onNotice(){},onLayout(){},onMusic(){},invoke:async input=>{
   if(input.action==='state') return state;
   if(input.action==='voice-choice') return choice({action:input.choice,companionId:input.agent.replace(/^main-/,''),voiceId:input.voiceId});
   if(input.action==='agent') {state.agent=input.agent;state.stateRevision++;listener(state);return state;}
   return {};
 }};
 window.harbourDesktop = {voiceChoice:choice,getCompanionState:async()=>({connection:'open'}),onCompanionState(){}};
})();`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/fixture/shim.js') { res.setHeader('Content-Type','application/javascript'); res.end(shim); return; }
  if (url.pathname === '/fixture/choice' && req.method === 'POST') {
    let data=''; for await (const chunk of req) data+=chunk;
    const body=JSON.parse(data); if(body.action==='select') catalogue.selections[body.companionId]=body.voiceId;
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(catalogue)); return;
  }
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, ''), file = path.resolve(root, relative);
  if (!(file.startsWith(path.join(root,'web')+path.sep) || file.startsWith(path.join(root,'desktop/renderer')+path.sep)) || !/\.(js|css|html|png|jpg|svg)$/.test(file)) { res.writeHead(404).end(); return; }
  try {
    let data=fs.readFileSync(file); const ext=path.extname(file);
    res.setHeader('Content-Type', {'.js':'application/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'}[ext]);
    // Only this isolated HTTP fixture uses fetch in place of Electron IPC.
    if (ext==='.html') data=data.toString().replace("connect-src 'none'", "connect-src 'self'").replace('</head>', '<script src="/fixture/shim.js"></script></head>');
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
server.listen(0,'127.0.0.1',()=>console.log(`Voice fixtures: http://127.0.0.1:${server.address().port}/desktop/renderer/orb.html and /desktop/renderer/voice-call.html`));
function cleanup() { orb.dispose(); server.close(); fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
process.on('SIGINT',()=>{cleanup();process.exit();}); process.on('SIGTERM',()=>{cleanup();process.exit();});
