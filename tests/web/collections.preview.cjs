// Isolated Memory / Agents UI fixture. Real frontend and config parser; no real user data,
// LLM calls, disk writes, proposal application, or connection to the production backend.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { previewAgentConfig } = require('tsx/cjs/api').require('../../src/config/agentConfigEditor.ts', __filename);
const root = path.resolve(__dirname, '../../web');
const pages = [
  ['index.md', '记忆库导航', 'Page', '从这里找到知识、人物与值得收藏的事。'],
  ['entities/index.md', '人物与事物', 'Entity', '人物、项目与重要事物的目录。'],
  ['entities/companions/index.md', '熟悉的伙伴', 'Entity', '每一个名字，都有属于自己的故事。'],
  ['entities/companions/elaina.md', '伊蕾娜', 'Entity', '灰之魔女，旅途中的故事与约定。'],
  ['entities/companions/aemeath.md', '爱弥斯', 'Entity', '关于她的记忆，慢慢积累在这里。'],
  ['entities/places/cafes/harbour.md', '小镇咖啡厅', 'Entity', '靠窗的位置、温暖的灯，还有熟悉的音乐。'],
  ['concepts/index.md', '概念与方法', 'Concept', '整理反复使用的知识与思考方法。'],
  ['concepts/design.md', '让界面安静一些', 'Concept', '先看内容，再看操作；让每种信息有清晰的位置。'],
  ['treasury/index.md', '宝库', 'Treasure', '用户 喜欢的，或认为值得保存的东西。'],
  ['treasury/prompts/index.md', '提示词与模板', 'Treasure', '收藏的提示词，保留来源和原文。'],
  ['treasury/prompts/station.md', '樱花车站场景', 'Treasure', '一份搭建 Web 小镇场景的创作提示词。'],
  ['treasury/prompts/web-scenes/autumn-station/presentation-notes/lighting-and-environment-guides/reference.md', '长路径显示测试', 'Treasure', '目录选择器应完整显示多层路径，不截断名称。'],
  ['treasury/resources/index.md', '资料与工具', 'Treasure', '值得再次打开的资料与实用工具。'],
  ['journals/autumn.md', '九月的一天', 'Journal', '保留当时的想法与发生的小事。'],
  ['sources/reference.md', '阅读参考', 'Source', '来源、摘录与清晰的出处。'],
  ['outputs/interface.md', '界面方案', 'Output', '经过整理，可以再次使用的输出。'],
  ['concepts/unavailable.md', '读取失败测试', 'Concept', '确认读取失败时不会误把空白内容提交。'],
].map(([file, title, type, description]) => ({ path: file, name: path.posix.basename(file), dir: path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file), title, type, description }));
const bodies = Object.fromEntries(pages.map(page => [page.path, `---\r\ntitle: ${page.title}\r\ntype: ${page.type}\r\ndescription: ${page.description}\r\n---\r\n\r\n# ${page.title}\r\n\r\n${page.description}\r\n\r\n## 这里保存什么\r\n\r\n这是一份隔离界面测试资料，不包含真实用户数据。\r\n\r\n- 清楚的标题和完整的来源。\r\n- 保留现有内容，不因预览而重写。\r\n- 编辑仍然通过原有审批流程。\r\n\r\n\`\`\`json\r\n{ "path": "${page.path}", "fixture": true }\r\n\`\`\`\r\n` ]));
const agents = [
  ['main-elaina', '灰之魔女，陪你梳理想法，协调任务与日常。', 'research'],
  ['main-aemeath', '小镇里的另一位伙伴，倾听、陪伴与协作。', 'research'],
  ['main-winefox', '酒狐 Wine Fox，面向 Minecraft 联机的清爽陪玩 Main：陪聊、协作建议和游戏解说。', 'research'],
  ['orchestrator', '复杂任务的规划与分工，让每一步都清楚。', 'critical'],
  ['memory-keeper', '整理值得留下的记忆，保存来源并等待审批。', 'writing'],
  ['browser-controller', '浏览页面、搜集资料与核对操作回执。', 'research'],
  ['legacy-helper', '兼容旧式扁平文件配置的助手。', 'classify'],
  ['unavailable-agent', '详情加载失败时，仍可返回列表或重试。', 'critical'],
].map(([name, description, taskType]) => ({ name, description, taskType, folder: name !== 'legacy-helper', tools: [], skills: [], permissionMode: 'dontAsk', contextBudget: 'auto', maxSteps: 20, systemPrompt: 'This is a neutral interface fixture.' }));
const filesFor = agent => [
  { file: 'CLAUDE.md', group: 'persona', content: `---\r\nname: ${agent.name}\r\ndescription: ${agent.description}\r\ntaskType: ${agent.taskType}\r\ncontextBudget: auto\r\nmaxSteps: 20\r\n---\r\n\r\n# ${agent.name}\r\n\r\n保留完整原文与规则。只作为界面测试，不执行任何任务。\r\n` },
  { file: 'SOUL.md', group: 'persona', content: '# 角色与语气\n\n自然、简洁地说明重点。\n' },
  { file: 'MEMORY.md', group: 'persona', content: '# 记忆\n\n只保留长期有价值的信息。\n' },
  { file: 'HEARTBEAT.md', group: 'schedule', content: '---\ntasks: []\n---\n\n# 定时自检\n' },
  ...['tools', 'skills', 'workflows', 'subagents', 'mcp'].map(kind => ({ file: `${kind}/index.md`, group: 'index', content: `---\n${kind === 'mcp' ? 'servers' : kind}: []\n---\n\n# 挂载索引\n\n此处修改继续走原有审批。\n` })),
];
const models = [
  { modelRef: 'preview/default', backend: 'preview', providerLabel: 'DeepSeek', connectionLabel: 'DeepSeek · DSH', model: 'DeepSeek · DSH · DeepSeek V4.1 Flash · DSH', modelLabel: 'DeepSeek V4.1 Flash · DSH', contextWindow: 200000, supportedEfforts: ['off', 'low', 'high', 'max'] },
  { modelRef: 'preview/sdk', backend: 'preview', providerLabel: 'DeepSeek', connectionLabel: '主后端', modelLabel: 'DeepSeek V4.1 Flash · Claude SDK', contextWindow: 200000, supportedEfforts: ['off', 'low', 'medium', 'high', 'max'] },
];
const bootstrap = `<script>
if (!localStorage.getItem('harbour-theme')) {
  localStorage.setItem('harbour-theme-cat', 'anime'); localStorage.setItem('harbour-theme-persona', 'elaina'); localStorage.setItem('harbour-theme', 'anime-wisteria');
}
window.WebSocket = class extends EventTarget { static OPEN=1; readyState=1; send(){} close(){} };
</script>`;
function createPreviewServer() {
  const requests = [], writes = [];
  const defaults = agents.map(agent => ({ name: agent.name, manifestPermissionMode: 'dontAsk', manifestModelRef: 'preview/default', effectiveModelRef: 'preview/default' }));
  const fixtures = {
    '/api/memory': { pages, total: pages.length, byType: pages.reduce((counts, page) => { counts[page.type] = (counts[page.type] || 0) + 1; return counts; }, {}) },
    '/api/agents': { agents }, '/api/tools': { tools: [] }, '/api/models': { models },
    '/api/agent-defaults': { models, agents: defaults },
    '/api/time-settings': { timeZone: 'America/New_York', revision: 1 }, '/api/asks': { asks: [] },
    '/api/state': { defaultAgent: 'main-elaina' }, '/api/conversations/explorer': { enabled: true, sessions: [] },
    '/api/skills': { skills: [] }, '/api/cowork/devices': { devices: [] },
    '/api/governance': { proposals: [] }, '/api/governance/history': { hasRepo: true, commits: [] },
  };
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/__inspection') return json({ requests, writes, bodies, files: filesFor(agents[0]) });
    if (url.pathname.startsWith('/api/')) requests.push({ path: url.pathname, query: url.search, method: req.method });
    if (req.method !== 'GET') {
      let text = ''; for await (const part of req) text += part;
      let body; try { body = JSON.parse(text || '{}'); } catch { return json({ error: 'Invalid JSON' }, 400); }
      if (req.method === 'POST' && /^\/api\/agent-config\/[^/]+\/preview$/.test(url.pathname)) {
        try { return json(previewAgentConfig(body.source, body.patch)); } catch (error) { return json({ error: error.message }, 400); }
      }
      if (req.method === 'POST' && url.pathname === '/api/agent-defaults') {
        const entry = defaults.find(item => item.name === body.agent);
        if (!entry) return json({ error: 'Unknown fixture Agent' }, 404);
        if ('modelRef' in body) { entry.overrideModelRef = body.modelRef; entry.effectiveModelRef = body.modelRef || entry.manifestModelRef; }
        if ('permissionMode' in body) entry.overridePermissionMode = body.permissionMode;
        writes.push({ path: url.pathname, body });
        return json({ ok: true, agents: defaults, models });
      }
      if (req.method === 'POST' && (url.pathname === '/api/governance/proposals' || /^\/api\/agent-files\/[^/]+$/.test(url.pathname))) {
        writes.push({ path: url.pathname, body }); return json({ id: 'fixture-proposal', proposal: { id: 'fixture-proposal', status: 'pending' } });
      }
      return json({ error: 'Fixture rejects this mutation' }, 405);
    }
    if (url.pathname === '/api/memory/file') {
      const file = url.searchParams.get('path');
      if (file?.endsWith('unavailable.md') || !bodies[file]) return json({ error: '测试文件暂时无法读取，请返回列表后重试。' }, 500);
      return json({ content: bodies[file] });
    }
    if (/^\/api\/(?:agents|agent-files)\//.test(url.pathname)) {
      const name = decodeURIComponent(url.pathname.split('/').pop()), agent = agents.find(item => item.name === name);
      if (!agent || name === 'unavailable-agent') return json({ error: '隔离测试：Agent 暂时不可用' }, 503);
      return json(url.pathname.includes('agent-files') ? { files: filesFor(agent) } : { agent });
    }
    if (url.pathname.startsWith('/api/')) return json(fixtures[url.pathname] || {});
    let pathname; try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    try {
      let data = fs.readFileSync(file);
      if (file === path.join(root, 'index.html')) data = data.toString().replace('<head>', '<head>' + bootstrap);
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
}
module.exports = { createPreviewServer };
if (require.main === module) {
  const server = createPreviewServer();
  server.listen(0, '127.0.0.1', () => console.log(`Collections preview: http://127.0.0.1:${server.address().port}/#memory`));
}
