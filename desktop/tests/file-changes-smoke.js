// Real dashboard DOM in hidden/offscreen Electron, with isolated HTTP/WS fixtures.
// No real Harbour server, models, private conversations, desktop workers or Chrome.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createServer } = require("node:http");
const { WebSocketServer } = require("ws");
const root = path.resolve(__dirname, "../..");
const webRoot = path.join(root, "web");
const outputDir = path.join(root, "assets/reports/file-changes");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "harbour-file-changes-")));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.on("window-all-closed", () => {});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (win, script) => win.webContents.executeJavaScript(script);
const clickDiagnostics = new WeakMap();
const agent = { name: "main-elaina", description: "文件回执测试角色", taskType: "main", permissionMode: "dontAsk", tools: [], skills: [], contextBudget: 80000 };
const model = { modelRef: "mock/fixture", model: "测试模型", modelName: "fixture", modelLabel: "测试模型", providerLabel: "Fixture", backendKind: "claude-agent", contextWindow: 128000, supportedEfforts: ["medium"], effortOptions: [{ effort: "medium" }] };
const key = "web:default:main-elaina";
const change = (id, filePath, kind = "modified", extra = {}) => ({ id, path: filePath, kind, location: "local", source: "tool", ...extra });
const changes = [
  change("permissions", "src/core/permissions.ts"),
  change("test", "tests/files/preview.test.ts", "created"),
  change("deleted", "src/core/legacyPreview.ts", "deleted"),
  change("renamed", "src/core/filePreview.ts", "renamed", { oldPath: "src/core/preview.ts" }),
  change("remote", "/workspace/notes.md", "modified", { deviceId: "fixture-device", deviceLabel: "远端工作站", location: "remote" }),
  change("binary", "assets/diagram.png", "created"),
  change("large", "data/large-fixture.txt"),
  change("unavailable", "outside/unavailable.txt"),
  change("slow", "src/core/slow-response.ts"),
  change("app", "web/app.js"),
];
const sampleCode = [
  '// 只读文件预览 · 保留 Harbour 的会话与权限边界',
  'export function canPreviewFile(sessionId: string, changeId: string) {',
  '  const session = sessions.get(sessionId);',
  '  const change = session?.fileChanges.find(file => file.id === changeId);',
  '  if (!change) return { status: "unavailable" };',
  '',
  '  // 路径从已确认记录解析，不接受任意客户端文件名',
  '  return previewCurrentFile(change);',
  '}',
  '',
  '// <script>window.__injected = true</script>',
].join("\n");
function makeSession(id) {
  return { id, key, channel: "web", agentName: agent.name, title: id === "A" ? "文件修改回执与预览" : "另一段会话 · 无文件改动", active: id === "A", messageCount: 3,
    createdAt: "2026-09-05T12:00:00.000Z", lastMessageAt: "2026-09-05T12:00:00.000Z", compactions: 0, contextTokens: 4320, contextWindow: 128000,
    modelRef: model.modelRef, permissionMode: "dontAsk", reasoningEffort: "medium", checkpoint: null, goal: null,
    source: { app: "web", locationLabel: "Main Chat", actorRole: "owner" },
    messages: [{ role: "user", content: "把修改文件回执放在回答下方，点击就能在右边查看文件。" },
      { role: "assistant", content: id === "A" ? "已完成文件预览的边界检查，并补充回归测试。可以从下面的文件列表检查当前内容。" : "这段会话没有修改文件。", ...(id === "A" ? { fileChanges: changes } : {}) },
      { role: "assistant", content: "没有修改文件的回答，不显示空的文件区。" }], traces: [] };
}
async function startFixture(testCase) {
  const sessions = { A: makeSession("A"), B: makeSession("B") };
  const requests = [];
  let delayMs = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/api/")) {
      let body = {};
      if (req.method !== "GET") { const chunks = []; for await (const chunk of req) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
      requests.push({ method: req.method, path: url.pathname, body });
      if (url.pathname === "/api/agents") return json({ agents: [agent] });
      if (url.pathname === "/api/state") return json({ defaultAgent: agent.name, agents: [agent], backends: { mock: true }, uptimeMs: 90000 });
      if (url.pathname === "/api/skills") return json({ skills: [] });
      if (url.pathname === "/api/agent-defaults") return json({ models: [model], agents: [{ name: agent.name, effectiveModelRef: model.modelRef, effectivePermissionMode: "dontAsk" }] });
      if (url.pathname === "/api/asks") return json({ asks: [] });
      if (url.pathname === "/api/cowork/devices") return json({ devices: [] });
      if (url.pathname === "/api/conversations/explorer") return json({ enabled: true, sessions: Object.values(sessions) });
      if (url.pathname === "/api/conversations/annotate") return json({ ok: true });
      if (url.pathname === "/api/conversations/switch") return json({ session: sessions[body.id] });
      if (url.pathname === "/api/run") {
        const files = [change("live", "src/core/live-completion.ts", "created")];
        sessions.A.messages.push({ role: "user", content: body.input }, { role: "assistant", content: "本轮完成：文件元数据来自运行回执。", fileChanges: files });
        sessions.A.messageCount = sessions.A.messages.length;
        return json({ answer: "本轮完成：文件元数据来自运行回执。", fileChanges: files, durationMs: 120, session: { id: "A", messageCount: sessions.A.messageCount, checkpoint: null, goal: null } });
      }
      const fileMatch = url.pathname.match(/^\/api\/conversations\/(A|B)\/files\/([^/]+)$/);
      if (fileMatch) {
        assert.equal(req.method, "GET");
        const file = sessions[fileMatch[1]].messages.flatMap((m) => m.fileChanges || []).find((f) => f.id === fileMatch[2]);
        if (!file) return json({ error: "not in this session" }, 404);
        if (file.id === "slow" && delayMs) await pause(delayMs);
        const status = ({ deleted: "deleted", remote: "remote_unavailable", binary: "binary", large: "too_large", unavailable: "unavailable" })[file.id] || "text";
        return json({ file, status, view: "current", ...(status === "text" ? { content: file.id === "app" ? fs.readFileSync(path.join(webRoot, "app.js"), "utf8") : sampleCode, language: "typescript" } : {}) });
      }
      const id = url.pathname.match(/^\/api\/conversations\/(A|B)$/)?.[1];
      if (id) return json({ session: sessions[id] });
      return json({ error: `unknown endpoint ${url.pathname}` }, 404);
    }
    const file = path.resolve(webRoot, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(webRoot + path.sep)) { res.writeHead(403); return res.end(); }
    try {
      let content = fs.readFileSync(file);
      if (path.basename(file) === "index.html") content = Buffer.from(content.toString().replace("<head>", `<head><script>
        localStorage.setItem('harbour-chat-mode','main');
        localStorage.setItem('harbour-theme-cat', ${JSON.stringify(testCase.cat)});
        localStorage.setItem('harbour-theme-persona', ${JSON.stringify(testCase.cat === "anime" ? "elaina" : "neutral")});
        localStorage.setItem('harbour-theme', ${JSON.stringify(testCase.cat === "anime" ? "anime-wisteria" : "premium-champagne")});
        window.__testErrors=[];
        window.addEventListener('error', e => { if(e.error) window.__testErrors.push(String(e.error.stack || e.message)); });
        window.addEventListener('unhandledrejection', e => window.__testErrors.push(String(e.reason)));
        ${testCase.web ? "" : "window.harbourDesktop={isElectron:true,petsEnabled:false};"}
      </script>`));
      const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" }[path.extname(file)] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": type }); res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket) => socket.send(JSON.stringify({ __harbour: "activity-snapshot", activeRunIds: [], serverEpoch: "fixture" })));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, requests, sessions, delay: (ms) => { delayMs = ms; },
    async close() { for (const socket of wss.clients) socket.terminate(); wss.close(); server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); } };
}
async function waitFor(win, expression, label) {
  for (let i = 0; i < 200; i++) { if (await evaluate(win, expression)) return; await pause(25); }
  throw new Error(`timeout: ${label}`);
}
async function click(win, selector, { afterFirstProbe } = {}) {
  // Opening/closing the preview changes the anime content width and can reflow/scroll the
  // chip list after the first scrollIntoView. Re-establish visibility on every probe; a
  // one-shot scroll followed by coordinate polling leaves a moved target below the viewport.
  // Keep native input and the stable hit-test assertion: a real overlay must still fail.
  let previous = "", stable = 0, hit;
  const probes = [];
  clickDiagnostics.set(win, { selector, probes });
  for (let i = 0; i < 50; i++) {
    await pause(40);
    hit = await evaluate(win, `(() => {
      const el=document.querySelector(${JSON.stringify(selector)});
      if(!el) throw new Error('missing click target');
      const before=el.getBoundingClientRect();
      el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
      const r=el.getBoundingClientRect(), point={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
      const actual=document.elementFromPoint(point.x,point.y), scrollParents=[];
      for(let parent=el.parentElement;parent;parent=parent.parentElement) {
        const style=getComputedStyle(parent);
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX+' '+style.overflowY)) {
          const rect=parent.getBoundingClientRect();
          scrollParents.push({id:parent.id,className:parent.className,top:rect.top,bottom:rect.bottom,
            scrollTop:parent.scrollTop,scrollHeight:parent.scrollHeight,clientHeight:parent.clientHeight,
            overflowX:style.overflowX,overflowY:style.overflowY});
        }
      }
      return {ok:el.contains(actual),actual:actual?.outerHTML.slice(0,500)||null,point,
        before:{x:before.x,y:before.y,width:before.width,height:before.height},
        rect:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},
        hitStack:document.elementsFromPoint(point.x,point.y).slice(0,6).map(node=>({tag:node.tagName,id:node.id,className:node.className})),
        scrollParents,previewHidden:document.querySelector('#filePreview')?.hidden};
    })()`);
    probes.push(hit);
    if (probes.length > 12) probes.shift();
    const current = JSON.stringify(hit.point);
    stable = hit.ok && current === previous ? stable + 1 : 0;
    previous = current;
    if (stable >= 3) break;
    if (i === 0 && afterFirstProbe) await afterFirstProbe();
  }
  assert.ok(hit.ok && stable >= 3, `hit target ${selector}: ${JSON.stringify(hit)}`);
  win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...hit.point });
  win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...hit.point });
  await pause(80);
}
async function screenshot(win, name) {
  await evaluate(win, "document.querySelectorAll('.toast').forEach(el=>el.remove())");
  win.webContents.invalidate();
  await evaluate(win, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await pause(150);
  fs.writeFileSync(path.join(outputDir, name), (await win.webContents.capturePage()).toPNG());
}
async function closePreview(win) { if (await evaluate(win, "document.querySelector('#filePreview')?.hidden===false")) await click(win, "#filePreviewClose"); }
async function assertLayout(win) {
  const layout = await evaluate(win, `(() => { const p=document.querySelector('#filePreview').getBoundingClientRect(); return { width:innerWidth, scroll:document.documentElement.scrollWidth, left:p.left, right:p.right, top:p.top, bottom:p.bottom, height:innerHeight }; })()`);
  assert.ok(layout.scroll <= layout.width + 2, JSON.stringify(layout));
  assert.ok(layout.left >= 0 && layout.right <= layout.width + 1 && layout.top >= 0 && layout.bottom <= layout.height + 1, JSON.stringify(layout));
  assert.equal(await evaluate(win, "getComputedStyle(document.querySelector('.harbour-hero')).display"), "none", "portrait cannot cover file content");
}
async function runCase(testCase) {
  const fixture = await startFixture(testCase);
  const win = new BrowserWindow({ show: false, width: testCase.width, height: 960, webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) && !details.url.startsWith(fixture.base) }));
  win.webContents.setWindowOpenHandler(() => { throw new Error("file preview must never open a browser window"); });
  const report = { id: testCase.id, hidden: true };
  try {
    await win.loadURL(fixture.base + "/#chat");
    await waitFor(win, "document.querySelectorAll('#chatStream [data-file-change]').length===10", "stored chips loaded");
    assert.equal(await evaluate(win, "document.querySelectorAll('#chatStream .message-file-changes').length"), 1, "no empty file frame on ordinary replies");
    await click(win, '[data-file-change="permissions"]');
    await waitFor(win, "document.querySelector('#filePreview .file-preview-line')", "code preview");
    assert.equal(await evaluate(win, "!!window.__injected || !!document.querySelector('#filePreview script')"), false);
    await assertLayout(win);
    await screenshot(win, `${testCase.id}-preview.png`);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await waitFor(win, "document.querySelector('#filePreview').hidden", "Escape closes");

    for (const [id, text] of [["deleted", "文件已不存在"], ["remote", "远端文件暂不可预览"], ["binary", "二进制文件"], ["large", "文件过大"], ["unavailable", "文件暂不可预览"]]) {
      await click(win, `[data-file-change="${id}"]`);
      await waitFor(win, `document.querySelector('#filePreview').innerText.includes(${JSON.stringify(text)})`, id);
      if (id === "remote") await screenshot(win, `${testCase.id}-remote.png`);
      await closePreview(win);
    }
    const started = Date.now();
    await click(win, '[data-file-change="app"]', testCase.width < 760 ? {
      // Reproduce the Intel CI failure deterministically: the first scroll succeeds, then
      // an asynchronous scroll moves the last chip outside the viewport before the click.
      afterFirstProbe: async () => {
        report.viewportShiftRegression = await evaluate(win, `new Promise(resolve => requestAnimationFrame(() => {
          const el=document.querySelector('[data-file-change="app"]');
          for(let parent=el.parentElement;parent;parent=parent.parentElement) parent.scrollTop=0;
          const rect=el.getBoundingClientRect(),point={x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};
          resolve({point,viewportHeight:innerHeight,hit:el.contains(document.elementFromPoint(point.x,point.y))});
        }))`);
        assert.equal(report.viewportShiftRegression.hit, false, "fixture must move the chip away from the initial native hit point");
        assert.ok(report.viewportShiftRegression.point.y >= report.viewportShiftRegression.viewportHeight,
          `fixture must reproduce an off-viewport chip: ${JSON.stringify(report.viewportShiftRegression)}`);
      },
    } : {});
    await waitFor(win, "document.querySelectorAll('#filePreview .file-preview-line').length>8000", "real web/app.js preview");
    report.largePreviewMs = Date.now() - started;
    report.largePreviewLines = await evaluate(win, "document.querySelectorAll('#filePreview .file-preview-line').length");
    await assertLayout(win);
    await screenshot(win, `${testCase.id}-app-js.png`);
    await closePreview(win);

    fixture.delay(600);
    await evaluate(win, "document.querySelector('[data-file-change=slow]').click(); document.querySelector('[data-file-change=test]').click()");
    await waitFor(win, "state.filePreview?.file.id==='test' && state.filePreview?.result.status==='text'", "latest click wins");
    await pause(700);
    assert.equal(await evaluate(win, "state.filePreview.file.id"), "test");
    await closePreview(win);
    await evaluate(win, "document.querySelector('[data-file-change=slow]').click(); switchChatSession('B')");
    await waitFor(win, "state.chat.sessionId==='B' && !state.chat.switchingSession", "session switch");
    await pause(700);
    assert.equal(await evaluate(win, "document.querySelector('#filePreview').hidden"), true, "late file response cannot reopen in another session");
    await evaluate(win, "switchChatSession('A')");
    await waitFor(win, "state.chat.sessionId==='A' && !state.chat.switchingSession", "return to A");
    await evaluate(win, "document.querySelector('#chatInput').value='Fixture live file change'; executeChat()");
    await waitFor(win, "!state.chat.running && document.querySelector('[data-file-change=live]')", "live completion chip");
    await click(win, '[data-file-change="live"]');
    await waitFor(win, "state.filePreview?.file.id==='live' && state.filePreview?.result.status==='text'", "live preview");
    await closePreview(win);
    await evaluate(win, "loadConversationMessages('A')");
    await waitFor(win, "document.querySelector('[data-file-change=live]')", "history replay retains live chip");
    await evaluate(win, "location.hash='history'");
    await waitFor(win, "document.querySelector('#histDetail [data-file-change=live]')", "History panel metadata");
    await click(win, '#histDetail [data-file-change="live"]');
    await waitFor(win, "state.filePreview?.panel==='history' && state.filePreview?.result.status==='text'", "History preview");
    assert.equal(await evaluate(win, "state.chat.sessionId"), "A");
    await evaluate(win, "document.querySelector('#histRefresh').click()");
    assert.equal(await evaluate(win, "document.querySelector('#filePreview').hidden"), true, "History refresh clears the previous file before async loading");
    assert.deepEqual(await evaluate(win, "window.__testErrors"), []);
    assert.equal(win.isVisible(), false);
    assert.ok(fixture.requests.filter((r) => r.path.includes("/files/")).every((r) => r.method === "GET"));
    report.requests = fixture.requests;
    fs.writeFileSync(path.join(outputDir, `${testCase.id}.json`), JSON.stringify(report, null, 2));
    console.log(`File changes ${testCase.id}: chips, live/history, read-only statuses, races, Escape, layout; app.js ${report.largePreviewLines} lines in ${report.largePreviewMs} ms (hidden=true)`);
  } catch (error) {
    await screenshot(win, `${testCase.id}-failure.png`).catch(() => {});
    fs.writeFileSync(path.join(outputDir, `${testCase.id}-failure.json`), JSON.stringify({ ...report, error: String(error.stack || error), click: clickDiagnostics.get(win), requests: fixture.requests, state: await evaluate(win, "({errors:window.__testErrors,preview:state.filePreview?.result.status,session:state.chat.sessionId,panel:document.body.dataset.panel})").catch(() => null) }, null, 2));
    throw error;
  } finally { win.destroy(); await fixture.close(); }
}
app.whenReady().then(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const testCase of [{ id: "premium-electron", cat: "premium", width: 1440 }, { id: "anime-web", cat: "anime", width: 1440, web: true }, { id: "anime-narrow", cat: "anime", width: 520, web: true }]) await runCase(testCase);
  console.log(`File changes DOM smoke passed. Screenshots: ${outputDir}`); app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
