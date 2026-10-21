// Actual shared Web/Electron renderer; isolated fixture API, hidden windows, no model calls.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createServer } = require("node:http");
const { WebSocketServer } = require("ws");

const root = path.resolve(__dirname, "../..");
const webRoot = path.join(root, "web");
const outputDir = path.join(root, "assets/reports/settings-layout");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "harbour-settings-layout-")));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.on("window-all-closed", () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (win, code) => win.webContents.executeJavaScript(code);
const agent = { name: "main-fixture", description: "UI 验收 · 不调用模型", taskType: "main", tools: [], skills: [] };
const model = { modelRef: "codex-app-server/gpt-6-astra", model: "gpt-6-astra", modelName: "gpt-6-astra", modelLabel: "GPT-6 Astra",
  providerLabel: "OpenAI", contextWindow: 1000000, defaultCompactTokens: 800000, effortOptions: [{ effort: "medium" }, { effort: "high" }] };
const connections = [
  { id: "fixture-primary", runtimeId: "claude-agent", configured: true, label: "主连接 · Fixture", providerLabel: "DeepSeek", providerAccent: "#5B80DB",
    model: "deepseek-v4-flash", runtimeLabel: "Claude SDK", transportLabel: "Anthropic Messages", authLabel: "API Key", models: [] },
  { id: "fixture-backup", runtimeId: "claude-agent", configured: true, label: "备用连接 · Fixture", providerLabel: "Moonshot", providerAccent: "#9E82C5",
    model: "kimi-for-coding", runtimeLabel: "Claude SDK", transportLabel: "Anthropic Messages", authLabel: "Coding API Key", models: [] },
  { id: "codex-harness", runtimeId: "codex-app-server", configured: true, ready: true, label: "OpenAI Codex · ChatGPT OAuth", providerLabel: "OpenAI", providerAccent: "#58BE96",
    providerIcon: "/assets/providers/openai.svg", model: "gpt-6-astra", runtimeLabel: "Codex Harness", transportLabel: "App Server · JSON-RPC", authLabel: "ChatGPT OAuth",
    models: Array.from({ length: 7 }, (_, i) => ({ id: `fixture-${i}`, available: true, enabled: true })), catalog: { updatedAt: "2026-09-06T15:33:46Z" } },
];

async function fixture() {
  const requests = [];
  let theme = {};
  let failedRefresh = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (value, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/api/")) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      requests.push({ method: req.method, path: url.pathname, body });
      if (req.method === "POST" && url.pathname === "/api/models/env" && body.action === "refresh-models" && body.id === "codex-harness") {
        await pause(150);
        if (!failedRefresh) { failedRefresh = true; return json({ error: "Fixture refresh unavailable" }, 503); }
        return json({ added: 0 });
      }
      if (req.method !== "GET") return json({ error: "fixture rejects other writes" }, 405);
      if (url.pathname === "/api/state") return json({ name: "Harbour", defaultAgent: agent.name, agents: [agent], uptimeMs: 16980000,
        backends: { mock: true, claudeAgent: { configured: true, label: "主后端", model: "deepseek-v4-flash" }, fallback: { configured: true, label: "备用后端", model: "kimi-for-coding" }, openrouter: {}, claudeCli: {} },
        control: {}, sessions: { enabled: true, sessions: 12, keys: 3 }, tools: ["read_file", "list_files", "write_file", "read_skill", "run_workflow", "spawn_subagent"].map(name => ({ name })) });
      if (url.pathname === "/api/models/env") return json({ slots: [], connections });
      if (url.pathname === "/api/models") return json({ models: [model] });
      if (url.pathname === "/api/agent-defaults") return json({ models: [model], agents: [{ ...agent, manifestModelRef: model.modelRef, effectiveModelRef: model.modelRef, manifestPermissionMode: "dontAsk", effectivePermissionMode: "dontAsk" }] });
      if (url.pathname === "/api/agents") return json({ agents: [agent] });
      if (url.pathname === "/api/asks") return json({ asks: [] });
      if (url.pathname === "/api/skills") return json({ skills: [] });
      if (url.pathname === "/api/cowork/devices") return json({ devices: [] });
      return json({});
    }
    const file = path.resolve(webRoot, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(webRoot + path.sep)) { res.writeHead(403); return res.end(); }
    try {
      let content = fs.readFileSync(file);
      if (path.basename(file) === "index.html") content = Buffer.from(content.toString().replace("<head>", `<head><script>
        localStorage.clear();
        localStorage.setItem('harbour-theme-cat',${JSON.stringify(theme.cat)});
        localStorage.setItem('harbour-theme-persona',${JSON.stringify(theme.persona)});
        localStorage.setItem('harbour-theme',${JSON.stringify(theme.theme)});
        window.__testErrors=[];
        window.addEventListener('error', e=>{if(e.error)window.__testErrors.push(String(e.error.stack||e.message));});
        window.addEventListener('unhandledrejection',e=>window.__testErrors.push(String(e.reason)));
      </script>`));
      const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime }); res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  const ws = new WebSocketServer({ server, path: "/ws" });
  ws.on("connection", socket => socket.send(JSON.stringify({ __harbour: "activity-snapshot", activeRunIds: [], serverEpoch: "settings-ui-fixture" })));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, requests, setTheme(next) { theme = next; },
    async close() { for (const socket of ws.clients) socket.terminate(); ws.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); } };
}

async function waitFor(win, expression) {
  for (let i = 0; i < 160; i++) { if (await evaluate(win, expression)) return; await pause(30); }
  throw new Error(`Timed out: ${expression}`);
}
async function click(win, selector) {
  await evaluate(win, `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);
  await pause(180);
  const point = await evaluate(win, `(() => {const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect();
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),hit:el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})()`);
  assert.equal(point.hit, true, `visible native click target: ${selector}`);
  for (const type of ["mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, x: point.x, y: point.y, button: "left", clickCount: 1 });
  await pause(100);
}
async function shot(win, name) {
  await evaluate(win, "document.querySelectorAll('.toast').forEach(el=>el.remove())");
  win.webContents.invalidate();
  await pause(150);
  fs.writeFileSync(path.join(outputDir, name), (await win.webContents.capturePage()).toPNG());
}
async function assertSections(win) {
  const metrics = await evaluate(win, `(() => {
    const pane=document.querySelector('#settingsPane');
    return {pageWidth:document.documentElement.scrollWidth,width:innerWidth,paneWidth:pane.clientWidth,contentWidth:pane.scrollWidth,
      floatingBrand:document.querySelector('.hero-tag') !== null,
      headerBrand:document.querySelector('.topbar .brand-name')?.textContent.trim(),
      heroPointerEvents:getComputedStyle(document.querySelector('.harbour-hero')).pointerEvents,
      groups:[...pane.querySelectorAll(':scope > .settings-section')].map(group=>{
        const head=group.querySelector('.settings-section-head'),body=group.querySelector('.settings-section-body'),h=head.querySelector('h3');
        const hr=head.getBoundingClientRect(),br=body.getBoundingClientRect(),css=getComputedStyle(h);
        return {title:h.textContent,headBottom:hr.bottom,bodyTop:br.top,padding:parseFloat(getComputedStyle(body).paddingTop),font:parseFloat(css.fontSize),transform:css.transform,border:getComputedStyle(group).borderTopWidth};
      })};})()`);
  assert.ok(metrics.pageWidth <= metrics.width + 2 && metrics.contentWidth <= metrics.paneWidth + 2, `no horizontal overflow: ${JSON.stringify(metrics)}`);
  assert.equal(metrics.floatingBrand, false, "decorative corner brand must not overlay any workbench");
  assert.equal(metrics.headerBrand, "Harbour", "keep the brand in the existing header");
  assert.equal(metrics.heroPointerEvents, "none", "character artwork remains decorative, never intercepting controls");
  assert.ok(metrics.groups.length > 0);
  for (const group of metrics.groups) {
    assert.ok(group.bodyTop >= group.headBottom - 1 && group.padding >= 16 && group.font >= 16 && group.transform === "none" && parseFloat(group.border) >= 1, `clear section hierarchy: ${JSON.stringify(group)}`);
  }
  return metrics;
}

app.whenReady().then(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const f = await fixture();
  const reports = [];
  try {
    for (const testCase of [
      { id: "premium", cat: "premium", persona: "neutral", theme: "premium-champagne", width: 1440 },
      { id: "elaina", cat: "anime", persona: "elaina", theme: "anime-wisteria", width: 1440 },
      { id: "aemeath", cat: "anime", persona: "aemeath", theme: "anime-snowfleece", width: 1440 },
      { id: "premium-narrow", cat: "premium", persona: "neutral", theme: "premium-champagne", width: 520 },
      { id: "anime-narrow", cat: "anime", persona: "elaina", theme: "anime-wisteria", width: 520 },
    ]) {
      f.setTheme(testCase);
      const win = new BrowserWindow({ show: false, width: testCase.width, height: 960, webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
      win.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: /^(https?|wss?):/.test(details.url) && new URL(details.url).host !== new URL(f.base).host }));
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const report = { testCase };
      try {
        await win.loadURL(f.base + "/#settings");
        await waitFor(win, "!!document.querySelector('#setThemeVariant')");
        await evaluate(win, "document.fonts.ready");
        report.appearance = await assertSections(win);
        await shot(win, `${testCase.id}-appearance.png`);
        await click(win, '[data-set-nav="system"]');
        await waitFor(win, "!!document.querySelector('.settings-tools')");
        report.system = await assertSections(win);
        await evaluate(win, "document.querySelector('#settingsPane').scrollTop=0");
        await shot(win, `${testCase.id}-system.png`);
        await click(win, '[data-set-nav="models"]');
        await waitFor(win, "!!document.querySelector('[data-codex-catalog-refresh]')");
        report.models = await assertSections(win);
        await evaluate(win, "document.querySelector('#modelConnections').closest('.settings-section').scrollIntoView({block:'start',behavior:'instant'})");
        await pause(200);
        const layout = await evaluate(win, `(() => {
          const card=document.querySelector('[data-codex-catalog-refresh]').closest('article'),button=card.querySelector('button'),meta=card.querySelector('.model-catalog-meta');
          const r=button.getBoundingClientRect(),mr=meta.getBoundingClientRect(),cr=card.getBoundingClientRect();
          const range=document.createRange();range.selectNodeContents(button);
          return {card:{width:cr.width,left:cr.left,right:cr.right},button:{width:r.width,height:r.height,top:r.top,bottom:r.bottom},metadata:{top:mr.top,bottom:mr.bottom},
            textRects:range.getClientRects().length,nowrap:getComputedStyle(button).whiteSpace,
            overlap: r.x<mr.right && r.right>mr.x && r.top<mr.bottom && r.bottom>mr.top,
            fits:card.scrollWidth<=card.clientWidth+1 && r.right<=cr.right && r.left>=cr.left};})()`);
        assert.ok(layout.fits && !layout.overlap && layout.nowrap === "nowrap" && layout.textRects === 1, `OAuth footer cannot squash or overlap: ${JSON.stringify(layout)}`);
        report.oauth = layout;
        await shot(win, `${testCase.id}-connections.png`);
        await click(win, '[data-codex-catalog-refresh]');
        await waitFor(win, "!!document.querySelector('[data-codex-catalog-refresh]:not([disabled])')");
        if (testCase.id === "premium") {
          await click(win, '[data-codex-catalog-refresh]');
          await waitFor(win, "!!document.querySelector('[data-codex-catalog-refresh]:not([disabled])')");
        }
        assert.deepEqual(await evaluate(win, "window.__testErrors"), []);
        assert.equal(win.isVisible(), false);
        reports.push(report);
        console.log(`Settings ${testCase.id}: grouped hierarchy, responsive OAuth footer, refresh/retry, hidden=true`);
      } catch (error) { await shot(win, `${testCase.id}-failure.png`).catch(() => {}); throw error; }
      finally { win.destroy(); }
    }
    const writes = f.requests.filter(r => r.method !== "GET");
    assert.ok(writes.length >= 6 && writes.every(r => r.path === "/api/models/env" && r.body.action === "refresh-models" && r.body.id === "codex-harness"));
    fs.writeFileSync(path.join(outputDir, "report.json"), JSON.stringify({ reports, writes }, null, 2));
  } finally { await f.close(); }
  console.log(`Settings real-DOM smoke passed. Evidence: ${outputDir}`);
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
