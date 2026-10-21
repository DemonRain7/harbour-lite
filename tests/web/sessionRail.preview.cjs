// Real dashboard, isolated in-memory conversations. No production API, user data or LLM.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const root = path.resolve(__dirname, '../../web');
const agent = { name: 'main-elaina', description: '会话界面验收', taskType: 'main', tools: [], skills: [] };
const model = { modelRef: 'mock/fixture', model: 'fixture', modelLabel: '隔离界面 · 无模型调用', contextWindow: 128000 };
const now = Date.now();
const seeds = [
  ['web', '帮我把记忆与灵感整理进宝库', 'default'],
  ['web', '雨天的咖啡厅，聊聊我们的下一段旅途', 'town'],
  ['qq', '周末去哪里走走？一起想一个轻松的计划'],
  ['web', '让小镇的人物动作变得更加自然和轻快…', 'default'],
  ['discord', '查一下这一周的更新和任务进度'],
  ['web', '晚安，明天也在这里见', 'town'],
  ['wecom', '读书笔记与资料整理'],
  ['cron', '每日资料归档'],
  ['web', '继续桌面的界面回归', 'cowork'],
  ['web', '很短的标题', 'default'],
  ['cli', '本机维护记录'],
  ['web', '<安全转义> 长标题与 "引号" & 字符', 'default'],
  ...Array.from({ length: 24 }, (_, i) => [i % 3 ? 'web' : 'qq', `第 ${i + 1} 次对话 · 从熟悉的小事开始慢慢整理新的想法与生活灵感`, i % 4 ? 'default' : 'town']),
];
const sessions = seeds.map(([channel, title, kind], i) => ({ id: `rail-${i}`, channel,
  key: channel === 'web' ? `web:${kind}:main-elaina` : `${channel}:fixture`, agentName: agent.name,
  title, messageCount: i + 4, compactions: i === 3 ? 2 : 0, active: i === 0 || i === 8,
  replyRevision: 1, readReplyRevision: [1, 2, 4].includes(i) ? 0 : 1,
  lastMessageAt: new Date(now - i * 3600000).toISOString(), createdAt: new Date(now - (i + 1) * 86400000).toISOString(),
  source: { app: channel, accountLabel: channel === 'web' ? 'Harbour' : `Elaina · ${channel.toUpperCase()}`, locationLabel: channel === 'web' ? 'Main Chat' : '与 QQ 用户的私聊', actorRole: 'owner' },
  readOnlyMirror: channel !== 'web', modelRef: model.modelRef,
  ...(i === 3 ? { checkpoint: { status: 'interrupted' } } : {}),
  ...(kind === 'cowork' ? { cowork: { deviceId: 'server', cwd: 'D:/Fixture' } } : {}),
  messages: [{ role: 'user', content: title }, { role: 'assistant', content: '这是一条隔离的界面验收记录。只检查列表、来源、重命名与切换，不会调用模型，也不会写入真实会话。' }],
}));
const requests = [], writes = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  if (url.pathname === '/__inspection') return json({ requests, writes, sessions });
  if (url.pathname.startsWith('/api/')) {
    requests.push({ path: url.pathname, method: req.method });
    if (req.method !== 'GET') {
      let raw = ''; for await (const part of req) raw += part;
      const body = JSON.parse(raw || '{}');
      if (req.method === 'POST' && /^\/api\/conversations\/rail-\d+\/read$/.test(url.pathname)) {
        const session = sessions.find(s => s.id === url.pathname.split('/').at(-2));
        if (!session || body.key !== session.key || !Number.isSafeInteger(body.replyRevision) || body.replyRevision > session.replyRevision || body.replyRevision < 0)
          return json({ error: 'Invalid fixture receipt' }, 400);
        session.readReplyRevision = Math.max(session.readReplyRevision, body.replyRevision);
        const reading = { id: session.id, replyRevision: session.replyRevision, readReplyRevision: session.readReplyRevision };
        writes.push({ path: url.pathname, body });
        for (const ws of sockets.clients) ws.send(JSON.stringify({ __harbour: 'session-read', ...reading }));
        return json(reading);
      }
      if (req.method === 'PATCH' && /^\/api\/conversations\/rail-\d+$/.test(url.pathname)) {
        const session = sessions.find(s => s.id === url.pathname.split('/').pop());
        if (body.title === '保存失败测试') return json({ error: '隔离验收：保存失败，请重试。' }, 503);
        session.title = body.title; writes.push({ path: url.pathname, body }); return json({ session });
      }
      if (url.pathname === '/api/conversations/switch') {
        const session = sessions.find(s => s.id === body.id && s.key === body.key);
        writes.push({ path: url.pathname, body }); return session ? json({ session }) : json({ error: 'Invalid fixture selection' }, 400);
      }
      if (url.pathname === '/api/conversations/new') {
        const session = { ...sessions[0], id: `rail-${sessions.length}`, key: body.key, title: '新会话', messages: [], messageCount: 0, checkpoint: null, replyRevision: 0, readReplyRevision: 0 };
        sessions.unshift(session); writes.push({ path: url.pathname, body }); return json({ session });
      }
      return json({ error: 'Isolated fixture: no execution or other mutations allowed' }, 405);
    }
    if (/^\/api\/conversations\/rail-\d+$/.test(url.pathname)) return json({ session: sessions.find(s => s.id === url.pathname.split('/').pop()) });
    const fixtures = {
      '/api/conversations/explorer': { enabled: true, sessions }, '/api/state': { defaultAgent: agent.name, agents: [agent], backends: { mock: true } },
      '/api/agents': { agents: [agent] }, '/api/models': { models: [model] }, '/api/skills': { skills: [] }, '/api/asks': { asks: [] },
      '/api/agent-defaults': { models: [model], agents: [{ name: agent.name, effectiveModelRef: model.modelRef, effectivePermissionMode: 'dontAsk' }] },
      '/api/cowork/devices': { devices: [{ id: 'server', label: '测试服务端', online: true, platform: 'win32' }] },
      '/api/time-settings': { timeZone: 'America/New_York', revision: 1 },
    };
    return json(fixtures[url.pathname] || {});
  }
  let pathname; try { pathname = decodeURIComponent(url.pathname); } catch { return json({}, 400); }
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) return json({}, 403);
  try {
    let content = fs.readFileSync(file);
    if (file === path.join(root, 'index.html')) content = content.toString().replace('<head>', `<head><script>
      if (!localStorage.getItem('harbour-theme')) { localStorage.setItem('harbour-theme-cat','anime'); localStorage.setItem('harbour-theme-persona','elaina'); localStorage.setItem('harbour-theme','anime-wisteria'); }
    </script>`);
    res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  } catch { res.writeHead(404); res.end(); }
});
const sockets = new WebSocketServer({ server, path: '/ws' });
sockets.on('connection', ws => {
  ws.send(JSON.stringify({ __harbour: 'activity-snapshot', activeRunIds: ['fixture-qq-run'], serverEpoch: 'session-rail-preview' }));
  ws.send(JSON.stringify({ __harbour: 'channel-activity', phase: 'running', runId: 'fixture-qq-run', sessionId: 'rail-2', sessionKey: sessions[2].key,
    agent: agent.name, startedAt: now, source: { platform: 'qq', actorRole: 'owner' }, input: '准备周末出行计划', detail: '隔离样例 · 运行状态展示', canStop: false }));
});
server.listen(0, '127.0.0.1', () => console.log(`Session rail preview: http://127.0.0.1:${server.address().port}/#chat`));
