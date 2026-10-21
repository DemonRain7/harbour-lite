// Isolated real-dashboard fixture. No models, production API, credentials or user sessions.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const webRoot = path.resolve(__dirname, '../../web');
const agent = { name: 'main-elaina', taskType: 'main', description: '进度界面验收', tools: [], skills: [] };
const model = { modelRef: 'mock/fixture', model: 'fixture', modelLabel: '界面测试 · 不调用模型', contextWindow: 128000 };
const session = { id: 'trace-fixture', key: 'web:default:main-elaina', channel: 'web', agentName: agent.name,
  title: '执行进度 · 隔离验收', active: true, createdAt: new Date().toISOString(), lastMessageAt: new Date().toISOString(), messageCount: 0,
  source: { app: 'web', locationLabel: 'Main Chat', actorRole: 'owner' }, messages: [], traces: [] };
let tick = Date.now();
const ev = (msg, data = {}) => ({ level: 30, runId: 'progress-fixture', time: ++tick, agent: agent.name, traceId: 'main-loop', msg, ...data });
const progress = { id: 'plan-fixture', scope: 'task', owner: agent.name, revision: 1, title: '让小镇的互动更自然', steps: [
  { n: 1, title: '梳理现有交互与动画', detail: '复用已有角色动作与场景事件，不新建一套控制逻辑。', status: 'completed' },
  { n: 2, title: '调整动作衔接与界面反馈', detail: '实现轻量交互，保留画面的安静感。', status: 'in_progress' },
  { n: 3, title: '验证两套主题与移动窗口', status: 'pending' },
  { n: 4, title: '检查结果并交付', status: 'pending' },
] };
const local = { id: 'local-fixture', scope: 'workflow', source: 'preview-check', owner: agent.name, revision: 1, title: '界面验证', steps: [
  { n: 1, title: '打开预览', status: 'completed' }, { n: 2, title: '核对主题与布局', status: 'in_progress' }, { n: 3, title: '保存测试证据', status: 'pending' },
] };
const records = [ev('loop:start', { modelRef: model.modelRef, tools: ['update_progress'] }),
  ev('spawn_subagent', { from: agent.name, to: 'orchestrator' }),
  ev('loop:start', { agent: 'orchestrator', traceId: 'planner', parentTraceId: 'main-loop' }),
  ev('progress:updated', { agent: 'orchestrator', traceId: 'planner', parentTraceId: 'main-loop', progress: structuredClone(progress) }),
  ev('loop:final', { agent: 'orchestrator', traceId: 'planner', parentTraceId: 'main-loop', answerPreview: '计划已提交；开始实施与验证。' }),
  ev('loop:end', { agent: 'orchestrator', traceId: 'planner', parentTraceId: 'main-loop', status: 'completed' }),
  ev('progress:updated', { progress: local }),
  ev('loop:tool-calls', { step: 3, calls: ['bash'] }),
  ev('loop:tool-result', { tool: 'bash', resultPreview: 'npm run test:town — 18 tests passed' }),
  ev('spawn_subagent', { from: agent.name, to: 'browser_controller' }),
  ev('loop:start', { agent: 'browser_controller', traceId: 'browser-1', parentTraceId: 'main-loop' }),
  ev('loop:tool-calls', { agent: 'browser_controller', traceId: 'browser-1', parentTraceId: 'main-loop', step: 1, calls: ['opencli_browser'] }),
  ev('loop:tool-result', { agent: 'browser_controller', traceId: 'browser-1', parentTraceId: 'main-loop', tool: 'opencli_browser', resultPreview: '页面已打开 · 检查角色动作与窗口布局' }),
  ev('spawn_subagent', { from: agent.name, to: 'trajectory-checker' }),
  ev('loop:start', { agent: 'trajectory-checker', traceId: 'research-1', parentTraceId: 'main-loop' }),
  ev('loop:tool-calls', { agent: 'trajectory-checker', traceId: 'research-1', parentTraceId: 'main-loop', step: 1, calls: ['read_file'] }),
  ev('loop:tool-result', { agent: 'trajectory-checker', traceId: 'research-1', parentTraceId: 'main-loop', tool: 'read_file', resultPreview: '已核对动画配置 · 保留现有资源来源' }),
];
let finished = false;
const activity = () => ({ __harbour: 'channel-activity', phase: 'running', runId: 'progress-fixture', sessionId: session.id, sessionKey: session.key,
  agent: agent.name, startedAt: tick - 32_000, source: { platform: 'web', actorRole: 'owner' }, input: '帮我优化小镇的动作和互动，顺便核对一下布局。', detail: '正在执行 · 独立界面样例', canStop: false });
function send(event) { records.push(event); for (const ws of sockets.clients) ws.send(JSON.stringify(event)); }
const controls = `<div id="fixture-controls" style="position:fixed;right:12px;bottom:4px;z-index:1900;font:11px system-ui;background:var(--panel);padding:6px;border:1px solid var(--border);border-radius:8px"><span>隔离样例 · 无模型调用 </span><button id="fixture-next">推进阶段</button><button id="fixture-logs">追加日志</button><button id="fixture-finish">结束样例</button><button id="fixture-check">检查交互</button><output id="fixture-result"></output></div>
<script>
for (const action of ['next','logs','finish']) document.getElementById('fixture-'+action).onclick=()=>fetch('/fixture/'+action);
document.getElementById('fixture-check').onclick=()=>{
  const host=document.querySelector('.has-trace-progress'), raw=host.querySelector('.tp-raw');
  raw.open=true;const log=host.querySelector('.tp-raw-list');log.scrollTop=10;
  const keep=log.scrollTop;const unchanged=!syncLiveTraceRows(host,state.chat.channelRuns['progress-fixture'].trace);
  const retained=host.querySelector('.tp-raw').open && host.querySelector('.tp-raw-list').scrollTop===keep;
  document.getElementById('fixture-result').textContent=unchanged&&retained?'PASS · 无变化不重绘，日志位置保留':'FAIL';
};
</script>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname.startsWith('/fixture/')) {
    if (url.pathname === '/fixture/next') {
      progress.revision++; progress.steps[1].status = 'completed'; progress.steps[2].status = 'in_progress';
      send(ev('progress:updated', { progress: structuredClone(progress) }));
      send(ev('loop:tool-result', { tool: 'bash', resultPreview: '界面回归通过 · 待交付核对' }));
    } else if (url.pathname === '/fixture/logs') {
      for (let i = 0; i < 45; i++) send(ev('loop:tool-result', { tool: 'bash', resultPreview: '日志样例 '+i+' · 不执行任何指令' }));
    } else if (url.pathname === '/fixture/finish') {
      finished=true; send(ev('loop:end', { status: 'incomplete' }));
      session.messages=[{role:'user', content:activity().input},{role:'assistant', content:'这是隔离界面样例。阶段更新与运行结束分别显示，未完成的待办不会自动打勾。'}];
      session.traces=[null,records.slice()];
      for(const ws of sockets.clients)ws.send(JSON.stringify({...activity(),phase:'complete'}));
    }
    return json({ok:true});
  }
  if (url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return json({ error: 'Fixture rejects writes' }, 405);
    if (url.pathname === '/api/state') return json({ defaultAgent: agent.name, agents: [agent], backends: {mock:true}, uptimeMs: 90000 });
    if (url.pathname === '/api/agents') return json({ agents: [agent] });
    if (url.pathname === '/api/agent-defaults') return json({ models: [model], agents: [{name:agent.name,effectiveModelRef:model.modelRef,effectivePermissionMode:'dontAsk'}] });
    if (url.pathname === '/api/skills') return json({skills:[]});
    if (url.pathname === '/api/asks') return json({asks:[]});
    if (url.pathname === '/api/cowork/devices') return json({devices:[]});
    if (url.pathname === '/api/conversations/explorer') return json({enabled:true,sessions:[session]});
    if (url.pathname === '/api/conversations/trace-fixture') return json({session});
    return json({});
  }
  const file = path.resolve(webRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(webRoot + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    let content = fs.readFileSync(file);
    if (path.basename(file) === 'index.html') content = content.toString().replace('<head>', `<head><script>
      if(!localStorage.getItem('harbour-theme')){localStorage.setItem('harbour-theme-cat','anime');localStorage.setItem('harbour-theme-persona','elaina');localStorage.setItem('harbour-theme','anime-wisteria');}
    </script>`).replace('</body>', controls+'</body>');
    res.writeHead(200, {'Content-Type':{'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp'}[path.extname(file)]||'application/octet-stream'}); res.end(content);
  } catch { res.writeHead(404); res.end(); }
});
const sockets = new WebSocketServer({server,path:'/ws'});
sockets.on('connection', ws => {
  if (!finished) ws.send(JSON.stringify(activity()));
  ws.send(JSON.stringify({__harbour:'activity-snapshot',activeRunIds:finished?[]:['progress-fixture'],serverEpoch:'isolated-trace-preview'}));
  if (!finished) for (const event of records) ws.send(JSON.stringify(event));
});
module.exports = { server, sockets, send, ev, records, progress };
if (require.main === module) server.listen(0,'127.0.0.1',()=>console.log(`Trace UI fixture: http://127.0.0.1:${server.address().port}/#chat`));
