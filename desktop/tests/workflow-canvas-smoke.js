// 真正的 Web/Electron DOM；隔离 fixture API，不连接生产、不生成图片。
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { WebSocketServer } = require("ws");
const ts = require("../../node_modules/typescript");
const root = path.resolve(__dirname, "../.."), webRoot = path.join(root, "web");
const out = path.join(root, "assets/reports/workflow-canvas");
const moduleFixture = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, "src/core/workflows/workflowGraphCatalog.ts"), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
  { exports: moduleFixture.exports, module: moduleFixture });
// Match the actual capability browser: retired compatibility executors have no
// public contract and must not keep masking a missing unified canvas in this test.
const graphs = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(moduleFixture.exports.WORKFLOW_GRAPHS)
  .filter(([name]) => fs.existsSync(path.join(root, "workflows", name, "WORKFLOW.md"))))));
const primary = "novelai-generation", primaryNodeCount = graphs[primary].nodes.length;
const documents = {};
for (const [name, graph] of Object.entries(graphs)) documents[name] = { version: 1, executor: name, positions: {}, notes: {},
  settings: Object.fromEntries(graph.settings.map(s => [s.key, s.default])) };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-workflow-ui-"));
app.setPath("userData", temp); app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking"); app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.on("window-all-closed", () => {});
const pause = ms => new Promise(r => setTimeout(r, ms));
const evaluate = (win, code) => win.webContents.executeJavaScript(code);
async function waitFor(win, code) {
  for (let i = 0; i < 160; i++) { if (await evaluate(win, code)) return; await pause(40); }
  throw new Error(`Timeout: ${code}`);
}
async function click(win, selector) {
  await evaluate(win, `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);
  await pause(110);
  const point = await evaluate(win, `(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})()`);
  assert.ok(point.hit, `visible native input: ${selector}`);
  for (const type of ["mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, x: point.x, y: point.y, button: "left", clickCount: 1 });
  await pause(90);
}
async function input(win, selector, value) {
  await click(win, selector);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
  await win.webContents.insertText(value); await pause(60);
}
async function shot(win, name) {
  win.webContents.invalidate(); await pause(140);
  fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG());
}
async function detailBounds(win) {
  return evaluate(win, `(()=>{const e=document.querySelector('.cap-detail'),r=e.getBoundingClientRect(),s=getComputedStyle(e);
    return {x:r.x,width:r.width,paddingLeft:parseFloat(s.paddingLeft),paddingRight:parseFloat(s.paddingRight)};})()`);
}
function sameDetailBounds(actual, expected, label) {
  for (const key of ["x", "width", "paddingLeft", "paddingRight"]) assert.ok(Math.abs(actual[key] - expected[key]) <= 1,
    `${label}: ${key} changed ${expected[key]} -> ${actual[key]}`);
}
async function dragNode(win, id, dx, dy) {
  const before = await evaluate(win, `(()=>{const e=document.querySelector('[data-node="${id}"]'),r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),left:parseFloat(e.style.left),top:parseFloat(e.style.top)};})()`);
  win.webContents.sendInputEvent({ type: "mouseDown", x: before.x, y: before.y, button: "left", clickCount: 1 });
  for (let i = 1; i <= 5; i++) { win.webContents.sendInputEvent({ type: "mouseMove", x: before.x + Math.round(dx*i/5), y: before.y + Math.round(dy*i/5), button: "left" }); await pause(30); }
  win.webContents.sendInputEvent({ type: "mouseUp", x: before.x + dx, y: before.y + dy, button: "left", clickCount: 1 }); await pause(80);
  const after = await evaluate(win, `({left:parseFloat(document.querySelector('[data-node="${id}"]').style.left),top:parseFloat(document.querySelector('[data-node="${id}"]').style.top)})`);
  assert.ok(after.left > before.left && after.top > before.top, `pointer drag should move: ${JSON.stringify({before,after})}`);
  return after;
}
async function fixture() {
  let theme = {}, failSave = true, unavailable = false, delayed = false;
  const requests = [];
  const packages = Object.keys(graphs).map(name => ({ kind: "workflow", name, description: graphs[name].description, valid: true,
    mountedBy: ["main-fixture"],
    files: [{ path: `workflows/${name}/WORKFLOW.md`, relativePath: "WORKFLOW.md" }] }));
  packages.push({ kind: "skill", name: "fixture-skill", description: "Knowledge fixture", valid: true, mountedBy: [], files: [{ path: "skills/fixture-skill/SKILL.md", relativePath: "SKILL.md" }] });
  const agent = { name: "main-fixture", description: "fixture", tools: [], skills: [], taskType: "main" };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"), json = (body, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname.startsWith("/api/")) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      requests.push({ method: req.method, path: url.pathname, body });
      const graph = url.pathname.match(/^\/api\/workflow-graphs\/([a-z-]+)(?:\/(source|proposals))?$/);
      if (graph) {
        const name = graph[1], action = graph[2];
        if (unavailable && !action) return json({ error: "fixture old backend" }, 404);
        if (action === "proposals") {
          await pause(120);
          if (failSave) { failSave = false; return json({ error: "Fixture: 网络暂时失败，草稿保留" }, 503); }
          return json({ proposal: { id: "gp-fixture", status: "pending" }, applied: false }, 201);
        }
        if (action === "source") return json({ path: "src/core/workflows/comicGeneration.ts", startLine: 195, endLine: 196,
          totalLines: 399, content: "// <script> must be text\nasync function runRemaining() {}", readOnly: true });
        if (delayed && name === "memory-ingestion") await pause(700);
        return json({ definition: graphs[name], document: documents[name], revision: "rev-fixture",
          contractPath: `workflows/${name}/WORKFLOW.md`, targetPath: `workflows/${name}/GRAPH.json` });
      }
      if (req.method !== "GET") return json({ error: "fixture forbids execution" }, 405);
      if (url.pathname === "/api/capabilities") return json({ packages, counts: { workflow: Object.keys(graphs).length, skill: 1, mcp: 0 } });
      if (url.pathname === "/api/capabilities/file") return json({ content: "---\nname: fixture\nexecutor: comic-generation\n---\n# 调用契约\n此 MD 是接口说明，执行步骤在 TypeScript 中。" });
      if (url.pathname === "/api/state") return json({ name: "Harbour", agents: [agent], defaultAgent: agent.name, uptimeMs: 3600000, backends: { mock: true }, tools: [], control: {}, sessions: {} });
      if (url.pathname === "/api/agents") return json({ agents: [agent] });
      if (url.pathname === "/api/asks") return json({ asks: [] });
      if (url.pathname === "/api/models") return json({ models: [] });
      if (url.pathname === "/api/skills") return json({ skills: [] });
      return json({});
    }
    const file = path.resolve(webRoot, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(webRoot + path.sep)) { res.writeHead(403); return res.end(); }
    try {
      let content = fs.readFileSync(file);
      if (path.basename(file) === "index.html") content = Buffer.from(content.toString().replace("<head>", `<head><script>
        localStorage.clear(); localStorage.setItem('harbour-theme-cat',${JSON.stringify(theme.cat)});
        localStorage.setItem('harbour-theme-persona',${JSON.stringify(theme.persona)}); localStorage.setItem('harbour-theme',${JSON.stringify(theme.theme)});
        window.__testErrors=[];window.addEventListener('error',e=>{if(e.error)window.__testErrors.push(String(e.error.stack||e.message))});
        window.addEventListener('unhandledrejection',e=>window.__testErrors.push(String(e.reason)));
        ${theme.electron ? "window.harbourDesktop={isElectron:true};" : ""}</script>`));
      res.writeHead(200, { "Content-Type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)] || "application/octet-stream" });
      res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  const ws = new WebSocketServer({ server, path: "/ws" });
  ws.on("connection", socket => socket.send(JSON.stringify({ __harbour: "activity-snapshot", activeRunIds: [], serverEpoch: "workflow-ui-fixture" })));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, requests, setTheme(t) { theme = t; },
    setUnavailable(v) { unavailable = v; }, setDelayed(v) { delayed = v; },
    async close() { for (const socket of ws.clients) socket.terminate(); ws.close(); server.closeAllConnections?.(); await new Promise(r => server.close(r)); } };
}
app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true }); const f = await fixture(), reports = [];
  try {
    for (const t of [
      { id: "elaina", cat: "anime", persona: "elaina", theme: "anime-wisteria", width: 1920, electron: true },
      { id: "premium", cat: "premium", persona: "neutral", theme: "premium-champagne", width: 1440 },
      { id: "aemeath", cat: "anime", persona: "aemeath", theme: "anime-aemeath-snowfleece", width: 1600 },
      { id: "narrow", cat: "anime", persona: "elaina", theme: "anime-wisteria", width: 560 },
      { id: "short", cat: "premium", persona: "neutral", theme: "premium-champagne", width: 1440, height: 780 },
    ]) {
      f.setTheme(t); f.setUnavailable(false); f.setDelayed(false);
      const win = new BrowserWindow({ show: false, width: t.width, height: t.height || 1080, webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
      win.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: /^(https?|wss?):/.test(details.url) && new URL(details.url).host !== new URL(f.base).host }));
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      try {
        await win.loadURL(f.base + "/#capabilities");
        await waitFor(win, `!!document.querySelector('[data-capability="workflow:${primary}"]')`);
        await click(win, '[data-cap-kind="skill"]');
        await click(win, '[data-capability="skill:fixture-skill"]');
        const skillBounds = await detailBounds(win);
        await shot(win, `${t.id}-skill-width`);
        await click(win, '[data-cap-kind="workflow"]');
        await click(win, `[data-capability="workflow:${primary}"]`);
        await waitFor(win, `document.querySelectorAll('.wf-node').length===${primaryNodeCount}`); await pause(220);
        sameDetailBounds(await detailBounds(win), skillBounds, `${t.id} Skill -> Workflow graph`);
        await shot(win, `${t.id}-workflow-width`);
        await click(win, '[data-workflow-tab="files"]');
        sameDetailBounds(await detailBounds(win), skillBounds, `${t.id} Workflow files`);
        await click(win, '[data-workflow-tab="graph"]');
        sameDetailBounds(await detailBounds(win), skillBounds, `${t.id} Workflow files -> graph`);
        await click(win, '[data-wf="focus"]');
        if (t.width > 1120) assert.ok((await detailBounds(win)).width > skillBounds.width + 100, "only explicit expand changes width");
        await click(win, '[data-workflow-tab="files"]');
        sameDetailBounds(await detailBounds(win), skillBounds, `${t.id} leaving expanded canvas restores width`);
        await click(win, '[data-workflow-tab="graph"]');
        sameDetailBounds(await detailBounds(win), skillBounds, `${t.id} returning to canvas must not auto-expand`);
        assert.equal(await evaluate(win, "document.querySelector('[data-wf=focus]').textContent"), "展开画布");
        await click(win, '[data-cap-kind="skill"]');
        await click(win, '[data-capability="skill:fixture-skill"]');
        sameDetailBounds(await detailBounds(win), skillBounds, `${t.id} Workflow -> Skill`);
        await click(win, '[data-cap-kind=""]');
        await click(win, `[data-capability="workflow:${primary}"]`);
        await waitFor(win, `document.querySelectorAll('.wf-node').length===${primaryNodeCount}`);
        sameDetailBounds(await detailBounds(win), skillBounds, `${t.id} repeated switch`);
        assert.equal(await evaluate(win, "document.querySelector('.wf-summary h4').textContent"), "NovelAI · 创作与生成");
        for (const id of ["artist", "director", "skill"]) {
          assert.ok(await evaluate(win, `document.querySelector('[data-node="${id}"]').textContent.includes('Workflow 内')`), `${id} must be inside Workflow`);
        }
        await click(win, '[data-wf="focus"]');
        await click(win, '[data-wf="fit"]');
        await shot(win, `${t.id}-graph`);
        assert.equal(await evaluate(win, "document.querySelectorAll('.wf-node[data-kind=knowledge]').length"), 1);
        const metrics = await evaluate(win, `({width:innerWidth,scroll:document.documentElement.scrollWidth,stage:document.querySelector('.wf-stage').clientWidth,
          nodes:document.querySelectorAll('.wf-node').length,edges:document.querySelectorAll('.wf-edge').length})`);
        assert.ok(metrics.scroll <= metrics.width + 2, JSON.stringify(metrics));
        assert.ok(await evaluate(win, "document.querySelector('.wf-foot').getBoundingClientRect().bottom <= document.querySelector('.cap-detail').getBoundingClientRect().bottom"), "短窗口不能裁掉画布底部，应由外层滚动");
        // 在 fit 后用真实指针选择节点，输入参数/备注并检查保存失败重试。
        await click(win, '[data-node="batch"]');
        await waitFor(win, "!!document.querySelector('[data-setting=batchSize]')");
        await input(win, '[data-setting="batchSize"]', "2");
        await input(win, '.wf-note', "仅画布备注 <script>，不进入 LLM");
        await shot(win, `${t.id}-inspector`);
        if (t.id === "elaina") {
          await click(win, '[data-wf="fit"]');
          await dragNode(win, "batch", 25, 20);
          await click(win, '[data-node="batch"]');
          await click(win, '[data-wf="source"]'); await waitFor(win, "!!document.querySelector('.wf-source pre')");
          assert.ok(await evaluate(win, "document.querySelector('.wf-source pre').textContent.includes('<script>')"));
          assert.equal(await evaluate(win, "document.querySelectorAll('.wf-source script').length"), 0);
          await click(win, '[data-workflow-tab="files"]');
          await click(win, '[data-dialog-kind="leave"] .harbour-dialog-cancel');
          assert.equal(await evaluate(win, "document.querySelector('#capWorkflowCanvas').hidden"), false, "未保存画布切换须先确认，继续编辑保留画布");
          assert.equal(await evaluate(win, "document.querySelector('.wf-note').value"), "仅画布备注 <script>，不进入 LLM");
          await click(win, '[data-wf="save"]'); await waitFor(win, "document.querySelector('.wf-notice').textContent.includes('网络暂时失败')");
          assert.equal(await evaluate(win, "document.querySelector('[data-wf=save]').disabled"), false);
          await click(win, '[data-wf="save"]'); await waitFor(win, "document.querySelector('.wf-notice').textContent.includes('尚未应用')");
          assert.equal(await evaluate(win, "document.querySelector('[data-wf=save]').disabled"), true);
          await click(win, '[data-workflow-tab="files"]'); assert.equal(await evaluate(win, "document.querySelector('#capWorkflowCanvas').hidden"), true);
          await click(win, '[data-workflow-tab="graph"]'); assert.equal(await evaluate(win, "document.querySelector('.wf-note').value"), "仅画布备注 <script>，不进入 LLM");
          assert.equal(await evaluate(win, "window.HarbourUnsavedChanges.hasChanges()"), false, "已确认保存的画布提案不能留下幽灵草稿");
          const post = f.requests.filter(r => r.path.endsWith("/proposals")).at(-1);
          assert.equal(post.body.document.settings.batchSize, 2); assert.ok(post.body.document.notes.batch.includes("<script>"));
          assert.equal(Object.keys(post.body.document.positions).length, primaryNodeCount, "拖动冻结完整布局，调整窗口不串位");
          // 草稿切换隔离、慢请求不能覆盖新选择。
          f.setDelayed(true);
          sameDetailBounds(await detailBounds(win), skillBounds, "saved canvas returns at normal width");
          await click(win, '[data-capability="workflow:memory-ingestion"]');
          await click(win, '[data-capability="workflow:pricing-refresh"]');
          await waitFor(win, "document.querySelector('.wf-summary h4')?.textContent==='模型目录与计价刷新'"); await pause(800);
          assert.equal(await evaluate(win, "document.querySelector('.wf-summary h4').textContent"), "模型目录与计价刷新");
          assert.equal(await evaluate(win, "document.querySelectorAll('.wf-node[data-kind=agent]').length"), 0);
          await click(win, '[data-capability="skill:fixture-skill"]');
          assert.equal(await evaluate(win, "document.querySelector('#capWorkflowCanvas')"), null);
          await click(win, `[data-capability="workflow:${primary}"]`);
          await waitFor(win, "!!document.querySelector('.wf-notice a[href=\"#governance\"]')");
        } else if (t.id === "premium") {
          await input(win, '[data-setting="batchSize"]', "9");
          const before = f.requests.filter(r => r.method === "POST").length;
          await click(win, '[data-wf="save"]');
          assert.equal(f.requests.filter(r => r.method === "POST").length, before, "非法值不提交");
          // 键盘移动同样能保存，不需要鼠标精确拖动。
          const oldLeft = await evaluate(win, "parseFloat(document.querySelector('[data-node=batch]').style.left)");
          await evaluate(win, "document.querySelector('[data-node=batch]').focus({preventScroll:true})");
          win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
          win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" }); await pause(80);
          assert.equal(await evaluate(win, "parseFloat(document.querySelector('[data-node=batch]').style.left)"), oldLeft + 10);
          await click(win, '[data-wf="reset"]');
          assert.equal(await evaluate(win, "parseFloat(document.querySelector('[data-node=batch]').style.left)"), oldLeft);
        } else if (t.id === "aemeath") {
          f.setUnavailable(true); await click(win, '[data-wf="focus"]');
          await click(win, '[data-capability="workflow:pricing-refresh"]');
          await click(win, '[data-dialog-kind="leave"] .harbour-dialog-discard');
          await waitFor(win, "!!document.querySelector('.wf-unavailable')");
          const beforeRetry = f.requests.length;
          f.setUnavailable(false);
          await click(win, '[data-wf="retry"]');
          await waitFor(win, "document.querySelector('.wf-summary h4')?.textContent==='模型目录与计价刷新'");
          assert.ok(f.requests.slice(beforeRetry).every(request => request.method === "GET"), "retry must remain read-only");
          await click(win, '[data-workflow-tab="files"]'); assert.equal(await evaluate(win, "document.querySelector('.cap-workbench').hidden"), false);
        }
        assert.deepEqual(await evaluate(win, "window.__testErrors"), []); assert.equal(win.isVisible(), false);
        reports.push({ theme: t.id, ...metrics, detailBounds: skillBounds, stableCapabilityWidth: true }); console.log(`PASS workflow UI ${t.id}: graph, themed inspector, stable Skill/Workflow widths, navigation, hidden=true`);
      } catch (error) { await shot(win, `${t.id}-failure`).catch(() => {}); throw error; }
      finally { win.destroy(); }
    }
    assert.ok(f.requests.filter(r => r.method === "POST").every(r => r.path.startsWith("/api/workflow-graphs/") && r.path.endsWith("/proposals")), "no generation/run writes");
    fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(reports, null, 2));
  } finally { await f.close(); }
  console.log(`Workflow canvas UI passed. Evidence: ${out}`); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
