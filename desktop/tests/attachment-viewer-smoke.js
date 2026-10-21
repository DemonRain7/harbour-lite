// Real Dashboard DOM + real isolated preload/IPC; no models, user's files or OS launches.
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createServer } = require("node:http");
const { WebSocketServer } = require("ws");
const { createFileOpener, authorizeFileSender } = require("../companion/file-opener");

const root = path.resolve(__dirname, "../.."), webRoot = path.join(root, "web");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (win, js) => win.webContents.executeJavaScript(js);
async function screenshot(win, file) {
  for (let i = 0; i < 4; i++) {
    win.webContents.invalidate();
    await evaluate(win, "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await delay(180);
    try { await fs.writeFile(file, (await win.webContents.capturePage()).toPNG()); return; }
    catch (error) { if (i === 3) throw error; }
  }
}
async function wait(win, expression) {
  for (let i = 0; i < 150; i++) { if (await evaluate(win, expression)) return; await delay(30); }
  throw new Error(`Timed out: ${expression}`);
}
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.on("window-all-closed", () => {});
let temporary, server, wss, win;

async function main() {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "harbour-attachment-ui-"));
  app.setPath("userData", temporary);
  await app.whenReady();
  const agent = { name: "main-elaina", description: "Fixture", taskType: "main", tools: [], skills: [], permissionMode: "dontAsk" };
  const source = "# Harbour · 附件预览\nfrom pathlib import Path\n\n# 点击 Python 文件只查看，不会执行\nprint('你好，世界')\n\n<script>window.__unsafe = true</script>\n";
  const files = [
    { kind: "file", name: "示例代码.py", url: "/uploads/example.py" },
    { kind: "file", name: "说明.txt", url: "/uploads/readme.txt" },
    { kind: "file", name: "项目报告.pdf", url: "/uploads/report.pdf" },
    { kind: "file", name: "已过期.txt", url: "/uploads/expired.txt", expired: true },
    { kind: "video", name: "不支持的编码.mp4", url: "/uploads/unsupported.mp4" },
  ];
  const session = { id: "A", key: "web:default:main-elaina", channel: "web", agentName: agent.name, title: "文件查看", active: true, messages: [
    { role: "user", content: "这些文件可以直接查看吗？", attachments: files },
    { role: "assistant", content: "可以。[打开代码](/uploads/example.py)，[打开文档](/uploads/report.pdf)。" },
  ], messageCount: 2, traces: [], checkpoint: null, goal: null, createdAt: new Date().toISOString(), lastMessageAt: new Date().toISOString() };
  const previews = [], launched = [], unexpected = [];
  server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost"), send = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/api/files/preview") {
      const file = url.searchParams.get("url"); previews.push(file);
      if (file === "/uploads/slow.txt") await delay(250);
      if (file === "/uploads/missing.txt") return send({ error: "附件已过期" }, 404);
      const pdf = file?.endsWith(".pdf");
      return send({ name: file?.split("/").pop(), status: pdf ? "unsupported" : "text", size: pdf ? 4000 : 240, language: "Python", encoding: "utf-8", ...(pdf ? {} : { content: source }) });
    }
    if (url.pathname.startsWith("/uploads/")) { res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end("fixture document bytes"); return; }
    if (url.pathname === "/api/agents") return send({ agents: [agent] });
    if (url.pathname === "/api/state") return send({ defaultAgent: agent.name, agents: [agent], backends: { mock: true } });
    if (url.pathname === "/api/skills") return send({ skills: [] });
    if (url.pathname === "/api/agent-defaults") return send({ models: [], agents: [{ name: agent.name }] });
    if (url.pathname === "/api/asks") return send({ asks: [] });
    if (url.pathname === "/api/cowork/devices") return send({ devices: [] });
    if (url.pathname === "/api/conversations/explorer") return send({ enabled: true, sessions: [session] });
    if (url.pathname === "/api/conversations") return send({ enabled: true, sessions: [session], activeId: "A" });
    if (url.pathname === "/api/conversations/A" || url.pathname === "/api/conversations/switch") return send({ session });
    if (url.pathname.startsWith("/api/")) return send({});
    const file = path.resolve(webRoot, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(webRoot + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      let bytes = await fs.readFile(file);
      if (path.basename(file) === "index.html") bytes = Buffer.from(bytes.toString().replace("<head>", `<head><script>
        localStorage.setItem('harbour-chat-mode','main');
        localStorage.setItem('harbour-theme-cat','anime');
        localStorage.setItem('harbour-theme-persona','elaina');
        localStorage.setItem('harbour-theme','anime-wisteria');
        window.__errors=[]; addEventListener('error',e=>{if(e.error)__errors.push(e.message)});
        addEventListener('unhandledrejection',e=>__errors.push(String(e.reason)));
      </script>`));
      res.writeHead(200, { "Content-Type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)] || "application/octet-stream" }); res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  wss = new WebSocketServer({ server, path: "/ws" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const open = createFileOpener({ getConfig: () => ({ url: base, token: "fixture-token" }), cacheRoot: path.join(temporary, "file-previews"), shell: {
    openPath: async file => { launched.push({ file, bytes: await fs.readFile(file, "utf8") }); return ""; }, showItemInFolder() {},
  } });
  ipcMain.handle("desktop:open-attachment", (event, input) => { assert.ok(authorizeFileSender(event, [win], base)); return open(input); });
  ipcMain.on("desktop:conversation-ready", () => {});
  ipcMain.handle("desktop:cowork-device", () => null);
  ipcMain.handle("desktop:orb-status", () => ({ enabled: false }));
  ipcMain.handle("desktop:is-pet-visible", () => false);
  ipcMain.handle("desktop:companion-state", () => ({}));
  ipcMain.handle("desktop:companion-set-appearance", () => ({}));
  win = new BrowserWindow({ width: 1200, height: 840, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, preload: path.join(root, "desktop/preload.js"), contextIsolation: true, nodeIntegration: false,
    additionalArguments: [`--harbour-url=${encodeURIComponent(base)}`, "--harbour-token=fixture-token", "--harbour-pet-enabled=0", "--harbour-surface=dashboard"] } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(base) && !details.url.startsWith(base.replace("http:", "ws:")) && !details.url.startsWith("data:") }));
  win.webContents.setWindowOpenHandler(({ url }) => { unexpected.push(url); return { action: "deny" }; });
  await win.loadURL(base + "/#chat");
  await wait(win, "!!document.querySelector('.att-file[data-file-name=\"示例代码.py\"]')");
  await evaluate(win, "document.querySelector('.att-file[data-file-name=\"示例代码.py\"]').click()");
  await wait(win, "!!document.querySelector('.attachment-reader-code')");
  assert.equal(await evaluate(win, "window.__unsafe"), undefined);
  assert.match(await evaluate(win, "document.querySelector('.attachment-reader-code').textContent"), /你好/);
  assert.equal(launched.length, 0);
  const reports = path.join(root, "assets/reports/attachment-viewer"); await fs.mkdir(reports, { recursive: true });
  win.webContents.invalidate(); await evaluate(win, "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  await screenshot(win, path.join(reports, "anime-code.png"));
  await evaluate(win, "document.body.dataset.themeCat='premium';document.body.dataset.theme='premium-champagne'");
  await delay(200); await screenshot(win, path.join(reports, "premium-code.png"));
  win.setSize(520, 720); await delay(150);
  assert.equal(await evaluate(win, "document.querySelector('.attachment-reader').getBoundingClientRect().right <= innerWidth"), true);
  await screenshot(win, path.join(reports, "narrow-code.png"));
  win.setSize(1200, 840);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await wait(win, "!document.querySelector('.attachment-reader')");
  await evaluate(win, "document.querySelector('.att-file[data-file-name=\"项目报告.pdf\"]').click()");
  await wait(win, "document.querySelector('.attachment-reader-footer')?.textContent.includes('默认应用打开')");
  assert.equal(launched.length, 1); assert.equal(launched[0].bytes, "fixture document bytes"); assert.equal(path.extname(launched[0].file), ".pdf");
  await evaluate(win, "HarbourFiles.close(); void HarbourFiles.open({url:'/uploads/slow.txt'}); HarbourFiles.close();");
  await delay(300); assert.equal(await evaluate(win, "!!document.querySelector('.attachment-reader')"), false);
  await evaluate(win, "void HarbourFiles.open({url:'/uploads/missing.txt'});");
  await wait(win, "document.querySelector('.attachment-reader-body')?.textContent.includes('已过期')");
  assert.equal(launched.length, 1, "404 must not start an application");
  await evaluate(win, "HarbourFiles.close(); document.querySelector('[data-media-kind=video][data-media-url]').click()");
  await wait(win, "!!document.querySelector('.media-viewer-native:not([hidden])')");
  // This intentionally invalid media fixture should invoke the native decoder fallback once.
  await wait(win, "document.querySelector('.media-viewer-stage.has-error') !== null");
  for (let i = 0; i < 100 && launched.length < 2; i++) await delay(30);
  assert.equal(launched.length, 2); assert.equal(path.extname(launched[1].file), ".mp4");
  assert.deepEqual(unexpected, [], "attachments must never open an external browser tab");
  assert.equal(await evaluate(win, "!!document.querySelector('.att-expired a')"), false);
  assert.deepEqual(await evaluate(win, "window.__errors"), []);
  console.log("Attachment UI passed: real preload/IPC, code/text, safe HTML, PDF fallback, video fallback, expired/404, cancellation, themes, narrow layout. Shell opens mocked.");
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
