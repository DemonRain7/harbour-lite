// Isolated UI fixture: serves real frontend assets, never the live backend.
// Edits are captured in memory as proposals; no capability files are written.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../web');
const description = '用于互联网调研、搜索和公开资料获取：查资料、搜平台、读文章、整理来源。支持按任务选择网页、社区、视频和研究资料。复杂任务按需读取对应的参考文件，保留来源与引用，不会在浏览详情时执行任何工具。说明、参数与示例都可以在下方文件区查看，修改仍需通过原有审批流程。'.repeat(3);
const markdown = `---\nname: research-companion\ndescription: >\n  ${description}\n---\n\n# Research companion\n\n帮助你找到可靠的信息，留下清晰的来源。\n\n## 什么时候使用\n\n- 查找资料和比较不同来源。\n- 阅读网页与研究报告。\n- 整理带有引用的简洁结论。\n\n## 使用方式\n\n先理解问题，再选择合适的参考文件。无需把全部资料一次性装入上下文。\n\n\`\`\`json\n{ "topic": "城镇设计", "sources": 3 }\n\`\`\`\n\n## 注意事项\n\n这是界面测试资料，所有提交仅保存在内存里。\n\n${Array.from({ length: 6 }, (_, i) => `### 参考条目 ${i + 1}\n\n阅读清晰的正文、代码与清单。支持查看原文与版本历史，编辑内容不会被预览改变。`).join('\n\n')}`;
const packages = [
  { kind: 'skill', name: 'research-companion', description, mountedBy: ['main-aemeath', 'main-elaina'], names: ['SKILL.md', 'LICENSE.txt', 'references/search.md', 'references/social.md', 'references/long-name-reference-guide.md', 'assets/options.json', 'references/unavailable.md'] },
  { kind: 'workflow', name: 'memory-ingestion', description: '将值得保存的片段整理为长期记忆，在审批后有序归档。', mountedBy: ['memory-keeper'], names: ['WORKFLOW.md', 'references/contract.md'] },
  { kind: 'mcp', name: 'browser-tools', description: '连接浏览器与外部资料，工具与权限按现有配置提供。', mountedBy: ['main-elaina'], names: ['MCP.md', 'README.md'] },
].map(({ names, ...item }) => ({ ...item, valid: true, files: names.map(relativePath => ({ relativePath, path: `${item.kind === 'skill' ? 'skills' : item.kind === 'workflow' ? 'workflows' : 'mcp'}/${item.name}/${relativePath}` })) }));
const writes = [];
const graph = { revision: 1, document: { positions: {}, notes: {}, settings: {} }, definition: { title: '记忆归档', description: '整理、校验与审批各司其职。', nodes: [
  { id: 'collect', title: '整理资料', summary: '理解与归类', detail: 'Agent 整理需要保存的信息。', kind: 'agent', phase: 'executor', x: 30, y: 60 },
  { id: 'check', title: '校验', summary: '路径与精确去重', detail: '脚本验证结构，不改写内容。', kind: 'code', phase: 'after', x: 340, y: 60 },
  { id: 'approve', title: '审批', summary: '确认后保存', detail: '保持原有审批边界。', kind: 'human', phase: 'after', x: 650, y: 60 },
], edges: [{ from: 'collect', to: 'check', label: '整理完成' }, { from: 'check', to: 'approve', label: '校验通过' }], settings: [] } };
const fixtures = {
  '/api/capabilities': { packages, counts: { skill: 1, workflow: 1, mcp: 1 } },
  '/api/time-settings': { timeZone: 'America/New_York', revision: 1 },
  '/api/asks': { asks: [] }, '/api/agents': { agents: [] },
  '/api/state': { defaultAgent: 'main-elaina' }, '/api/conversations/explorer': { enabled: true, sessions: [] },
  '/api/skills': { skills: [] }, '/api/models': { models: [] }, '/api/cowork/devices': { devices: [] },
  '/api/governance': { proposals: [] }, '/api/governance/history': { hasRepo: true, commits: [] },
};
const bootstrap = `<script>
if (!localStorage.getItem('harbour-theme')) {
  localStorage.setItem('harbour-theme-cat', 'anime'); localStorage.setItem('harbour-theme-persona', 'elaina'); localStorage.setItem('harbour-theme', 'anime-wisteria');
}
window.WebSocket = class extends EventTarget { static OPEN=1; readyState=1; send(){} close(){} };
</script>`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  if (url.pathname === '/__inspection') return json({ writes, original: markdown });
  if (req.method !== 'GET') {
    if (req.method !== 'POST' || url.pathname !== '/api/governance/proposals') return json({ error: 'Fixture rejects this mutation' }, 405);
    let body = ''; for await (const part of req) body += part;
    try { writes.push({ path: url.pathname, body: JSON.parse(body) }); } catch { return json({ error: 'Invalid JSON' }, 400); }
    return json({ id: 'fixture-proposal' });
  }
  if (url.pathname === '/api/capabilities/file') {
    const file = url.searchParams.get('path') || '';
    if (file.endsWith('unavailable.md')) return json({ error: '测试文件暂时不可用' }, 500);
    return json({ path: file, content: file.endsWith('SKILL.md') ? markdown : file.endsWith('.json') ? '{\n  "enabled": true,\n  "limit": 3\n}' : file.endsWith('.txt') ? 'Fixture license — for isolated UI testing.' : `---\nname: ${path.basename(file)}\n---\n\n# ${path.basename(file)}\n\n这是 ${file.includes('/mcp/') ? '插件' : '能力'}的说明文件。\n\n## 配置说明\n\n保留原有权限、参数和执行逻辑，只优化阅读与编辑体验。` });
  }
  if (url.pathname.startsWith('/api/workflow-graphs/')) return json(graph);
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
server.listen(0, '127.0.0.1', () => console.log(`Capability preview: http://127.0.0.1:${server.address().port}/#capabilities`));
