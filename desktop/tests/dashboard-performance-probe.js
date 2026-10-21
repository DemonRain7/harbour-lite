// Explicit read-only probe of the local running dashboard. No user profile, API writes,
// model calls, or screen capture. Only aggregate timing/memory counters leave the renderer.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
let target = new URL(process.env.HARBOUR_PERF_URL || "http://127.0.0.1:7788/#chat");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "probe is local-only");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "harbour-dashboard-perf-")));
app.commandLine.appendSwitch("disable-background-networking");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function startFixture() {
  const { createServer } = require("node:http");
  const { WebSocketServer } = require("ws");
  const webRoot = path.resolve(__dirname, "../../web");
  const agent = { name: "main-elaina", taskType: "main", tools: [], skills: [] };
  const session = { id: "performance-fixture", key: "web:default:main-elaina", channel: "web",
    agentName: agent.name, title: "性能回归", active: true, source: { app: "web", actorRole: "owner" },
    createdAt: "2026-09-08T04:00:00Z", lastMessageAt: "2026-09-08T04:00:00Z", messageCount: 2,
    messages: [{ role: "user", content: "你好" }, { role: "assistant", content: "你好，有什么想聊的吗？" }], traces: [] };
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
    if (pathname.startsWith("/api/")) {
      const body = {
        "/api/state": { defaultAgent: agent.name, agents: [agent], backends: { mock: true }, uptimeMs: 10000 },
        "/api/agents": { agents: [agent] }, "/api/agent-defaults": { models: [], agents: [agent] },
        "/api/skills": { skills: [] }, "/api/asks": { asks: [] },
        "/api/conversations/explorer": { enabled: true, sessions: [session] },
        "/api/conversations/performance-fixture": { session }
      }[pathname] || {};
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); return;
    }
    const file = path.resolve(webRoot, "." + decodeURIComponent(pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(webRoot + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
        ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" }[path.extname(file)] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime }); res.end(fs.readFileSync(file));
    } catch { res.writeHead(404); res.end(); }
  });
  const ws = new WebSocketServer({ server, path: "/ws" });
  ws.on("connection", socket => socket.send(JSON.stringify({ __harbour: "activity-snapshot", activeRunIds: [], serverEpoch: "performance-fixture" })));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  target = new URL(`http://127.0.0.1:${server.address().port}/#chat`);
  return () => { for (const socket of ws.clients) socket.terminate(); ws.close(); server.closeAllConnections(); server.close(); };
}
app.whenReady().then(async () => {
  const closeFixture = process.argv.includes("--fixture") ? await startFixture() : () => {};
  const win = new BrowserWindow({ show: false, width: 1440, height: 950,
    webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.setFrameRate(60);
  let blockedWrites = 0;
  const sameHost = url => {
    try { const u = new URL(url); return u.hostname === target.hostname && u.port === target.port; } catch { return false; }
  };
  win.webContents.session.webRequest.onBeforeRequest((details, done) => {
    const write = !["GET", "HEAD", "OPTIONS"].includes(details.method);
    if (write) blockedWrites++;
    done({ cancel: write || (!sameHost(details.url) && !details.url.startsWith("data:")) });
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const evaluate = code => win.webContents.executeJavaScript(code);
  const start = Date.now();
  const watchdog = setTimeout(() => {
    console.error("Dashboard probe timed out; only the isolated test window is being stopped.");
    win.destroy(); app.exit(1);
  }, 40000);
  try {
    console.log("Loading read-only local dashboard");
    await win.loadURL(target.href);
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Performance.enable");
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !await evaluate("!!document.getElementById('chatInput')")) await pause(100);
    assert.equal(await evaluate("!!document.getElementById('chatInput')"), true, "chat input did not load");
    const readyMs = Date.now() - start;
    await pause(2000);
    const metrics = async () => Object.fromEntries((await win.webContents.debugger.sendCommand("Performance.getMetrics")).metrics.map(m => [m.name, m.value]));
    const before = await metrics();
    app.getAppMetrics();
    await pause(4000);
    const after = await metrics();
    console.log(JSON.stringify({ source: process.argv.includes("--fixture") ? "fixture" : "live-read-only", readyMs, blockedWrites,
      rendererBusyPercent: Math.round((after.TaskDuration - before.TaskDuration) / (after.Timestamp - before.Timestamp) * 1000) / 10,
      jsHeapMB: Math.round(after.JSHeapUsedSize / 1048576), nodes: after.Nodes,
      layoutSeconds: after.LayoutDuration - before.LayoutDuration,
      processes: app.getAppMetrics().map(m => ({ type: m.type, cpu: m.cpu.percentCPUUsage,
        workingMB: Math.round(m.memory.workingSetSize / 1024), privateMB: Math.round((m.memory.privateBytes || 0) / 1024) })),
      page: await evaluate("({images:document.images.length,loadedImages:[...document.images].filter(i=>i.complete&&i.naturalWidth>0).length,messages:document.querySelectorAll('.chat-msg').length,apiReads:performance.getEntriesByType('resource').filter(e=>new URL(e.name).pathname.startsWith('/api/')).length})")
    }));
  } finally { clearTimeout(watchdog); win.destroy(); closeFixture(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
