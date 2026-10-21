// Real dashboard, native text/mouse input, hidden Electron, loopback-only fixtures.
// No production Agent/Memory reads, model calls, proposal application or external writes.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createServer } = require("node:http");
const { WebSocketServer } = require("ws");
const { previewAgentConfig } = require("tsx/cjs/api").require("../../src/config/agentConfigEditor.ts", __filename);

const root = path.resolve(__dirname, "../..");
const webRoot = path.join(root, "web");
const outputDir = path.join(root, "assets/reports/unsaved-editors");
// Optional narrowing for a quick local reproduction; the default runs every suite/theme.
const suite = process.env.HARBOUR_UNSAVED_SUITE || "all";
const onlyTheme = process.env.HARBOUR_UNSAVED_THEME || "";
assert.ok(["all", "agent", "capabilities", "memory"].includes(suite), "unknown HARBOUR_UNSAVED_SUITE");
assert.ok(["", "premium", "elaina"].includes(onlyTheme), "unknown HARBOUR_UNSAVED_THEME");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "harbour-unsaved-editors-")));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.on("window-all-closed", () => {});
// A regression must fail with evidence, never leave an invisible Electron indefinitely.
const deadline = setTimeout(() => { console.error("FAIL unsaved editor smoke exceeded 180 seconds"); app.exit(1); }, 180000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (win, code) => win.webContents.executeJavaScript(code);
const lf = text => text.replace(/\r\n?/g, "\n");
const crlf = text => text.replace(/\n/g, "\r\n");
const AGENT = "fixture-unsaved", OTHER = "fixture-other";
const RAW = '#faDocToggle [data-doc-view="raw"]';
const STAY = '[data-dialog-kind="leave"] .harbour-dialog-cancel';
const DISCARD = '[data-dialog-kind="leave"] .harbour-dialog-discard';
const SAVE = '[data-dialog-kind="leave"] .harbour-dialog-confirm';
const agent = { name: AGENT, description: "Unsaved editor fixture", folder: true,
  taskType: "research", permissionMode: "dontAsk", tools: [], skills: [], contextBudget: "auto", maxSteps: 8 };
const other = { ...agent, name: OTHER };
const files = [
  { file: "CLAUDE.md", group: "persona", content: crlf(`---\nname: ${AGENT}\ndescription: Unsaved editor fixture\ncontextBudget: auto\nmaxSteps: 8\n---\n\n# CRLF fixture\n\nOpening or cancelling is not an edit.\n`) },
  { file: "tools/index.md", group: "index", content: crlf("---\ntools: []\n---\n\n# CRLF tool fixture\n") },
];
const capabilityContent = Object.fromEntries(["skill", "workflow", "mcp"].flatMap(kind => {
  const base = `${kind === "mcp" ? "mcp" : kind + "s"}/fixture-${kind}`;
  return [[`${base}/${kind.toUpperCase()}.md`, crlf(`---\nname: fixture-${kind}\ndescription: CRLF fixture\n---\n\n# ${kind} fixture\n`)],
    [`${base}/references/notes.md`, crlf(`# ${kind} notes\n\nSecond CRLF file.\n`)]];
}));
const packages = ["skill", "workflow", "mcp"].map(kind => ({ kind, name: `fixture-${kind}`, description: `${kind} fixture only`,
  valid: true, mountedBy: [], files: Object.keys(capabilityContent).filter(file => file.includes(`/fixture-${kind}/`))
    .map(file => ({ path: file, relativePath: file.split(`/fixture-${kind}/`)[1] })) }));
const memoryContent = {
  "fixture/one.md": crlf("---\ntitle: First fixture\ntype: Concept\n---\n\n# First fixture\n\nMemory CRLF baseline.\n"),
  "fixture/two.md": crlf("---\ntitle: Second fixture\ntype: Concept\n---\n\n# Second fixture\n"),
};

async function fixture(theme) {
  const requests = [], controls = { failSaves: false };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (body, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname.startsWith("/api/")) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
      catch { return json({ error: "invalid fixture request" }, 400); }
      const request = { method: req.method, path: url.pathname, body };
      requests.push(request);
      if (/^\/api\/agent-config\/[^/]+\/preview$/.test(url.pathname) && req.method === "POST") {
        try { return json(previewAgentConfig(body.source, body.patch)); }
        catch (error) { return json({ error: error.message }, 400); }
      }
      if (req.method === "POST" && (url.pathname === `/api/agent-files/${AGENT}` || url.pathname === "/api/governance/proposals")) {
        request.fixtureStatus = controls.failSaves ? 503 : 201;
        return controls.failSaves ? json({ error: "Fixture save unavailable; unsaved text must stay" }, 503)
          : json({ proposal: { id: `fixture-proposal-${requests.length}`, status: "pending" } }, 201);
      }
      if (req.method !== "GET") return json({ error: `forbidden fixture mutation: ${url.pathname}` }, 405);
      if (url.pathname === "/api/state") return json({ defaultAgent: AGENT, agents: [agent, other], tools: [], backends: { mock: true }, uptimeMs: 90000 });
      if (url.pathname === "/api/agents") return json({ agents: [agent, other] });
      if (url.pathname === `/api/agents/${AGENT}`) return json({ agent });
      if (url.pathname === `/api/agents/${OTHER}`) return json({ agent: other });
      if (url.pathname === `/api/agent-files/${AGENT}`) return json({ files });
      if (url.pathname === `/api/agent-files/${OTHER}`) return json({ files: [{ ...files[0], content: crlf(`---\nname: ${OTHER}\ncontextBudget: auto\nmaxSteps: 8\n---\n# Other original\n`) }] });
      if (url.pathname === "/api/agent-defaults") return json({ models: [], agents: [] });
      if (url.pathname === "/api/capabilities") return json({ packages, counts: { skill: 1, workflow: 1, mcp: 1 } });
      if (url.pathname === "/api/capabilities/file") return json({ content: capabilityContent[url.searchParams.get("path")] });
      if (url.pathname.startsWith("/api/workflow-graphs/")) return json({ error: "Contract-only workflow fixture" }, 404);
      if (url.pathname === "/api/memory") return json({ total: 2, byType: { Concept: 2 }, pages: Object.keys(memoryContent).map((file, i) => ({
        path: file, name: file.split("/").at(-1), dir: "fixture", title: `Memory fixture ${i + 1}`, type: "Concept", description: "Synthetic CRLF document" })) });
      if (url.pathname === "/api/memory/file") return json({ content: memoryContent[url.searchParams.get("path")] });
      if (url.pathname === "/api/asks") return json({ asks: [] });
      if (url.pathname === "/api/skills") return json({ skills: [] });
      if (url.pathname === "/api/models") return json({ models: [] });
      if (url.pathname === "/api/governance") return json({ proposals: [] });
      if (url.pathname === "/api/cowork/devices") return json({ devices: [] });
      return json({ error: `unknown fixture endpoint: ${url.pathname}` }, 404);
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
        window.__testErrors=[]; window.__nativeDialogs=[];
        window.addEventListener('error',e=>{if(e.error)window.__testErrors.push(String(e.error.stack||e.message))});
        window.addEventListener('unhandledrejection',e=>window.__testErrors.push(String(e.reason)));
        window.confirm=message=>{window.__nativeDialogs.push(message);return false};
        window.harbourDesktop={isElectron:true,petsEnabled:false};
      </script>`));
      res.writeHead(200, { "Content-Type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" }[path.extname(file)] || "application/octet-stream" });
      res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  const ws = new WebSocketServer({ server, path: "/ws" });
  ws.on("connection", socket => socket.send(JSON.stringify({ __harbour: "activity-snapshot", activeRunIds: [], serverEpoch: "fixture-unsaved" })));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, controls, requests,
    async close() { for (const socket of ws.clients) socket.terminate(); ws.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); } };
}

async function waitFor(win, code, label = code) {
  for (let i = 0; i < 160; i++) { if (await evaluate(win, code)) return; await pause(30); }
  throw new Error(`timeout: ${label}`);
}
async function click(win, selector) {
  let point, previous = "", stable = 0;
  for (let i = 0; i < 50; i++) {
    await pause(35);
    point = await evaluate(win, `(() => {
      const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('Missing click target: '+${JSON.stringify(selector)});
      el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
      const r=el.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
      return {x,y,hit:r.height>0&&el.contains(document.elementFromPoint(x,y)),disabled:el.disabled};
    })()`);
    const current = JSON.stringify(point);
    stable = point.hit && !point.disabled && current === previous ? stable + 1 : 0;
    previous = current;
    if (stable >= 3) break;
  }
  assert.ok(stable >= 3, `native mouse target must be stable/visible/enabled: ${selector} ${JSON.stringify(point)}`);
  for (const type of ["mouseMove", "mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, x: point.x, y: point.y, button: "left", clickCount: 1 });
  await pause(65);
}
async function input(win, selector, value) {
  await click(win, selector);
  assert.ok(await evaluate(win, `(() => {const e=document.querySelector(${JSON.stringify(selector)});e.select();return document.activeElement===e&&!e.readOnly&&!e.disabled})()`));
  await win.webContents.insertText(value);
  await waitFor(win, `document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(value)}`, "native input captured");
}
const value = (win, selector) => evaluate(win, `document.querySelector(${JSON.stringify(selector)}).value`);
async function noDialog(win, label) {
  await pause(120);
  assert.equal(await evaluate(win, "document.querySelectorAll('.harbour-dialog-layer').length"), 0, label);
}
async function dialog(win) {
  await waitFor(win, "document.querySelectorAll('.harbour-dialog-layer').length===1", "one immediate themed confirmation");
  assert.ok(await evaluate(win, "!!document.querySelector('.harbour-dialog [aria-modal]') || !!document.querySelector('.harbour-dialog[aria-modal=true]')"));
}
async function decision(win, selector) {
  await click(win, selector);
  await waitFor(win, "!document.querySelector('.harbour-dialog-layer')", "confirmation resolved");
}
async function page(win, name) {
  if (!await evaluate(win, "document.querySelector('.shell').classList.contains('nav-open')")) await click(win, "#navToggle");
  if (await evaluate(win, `!!document.querySelector('#navSecondary [data-route="${name}"]') && !document.querySelector('#navMore').open`)) await click(win, "#navMore summary");
  await click(win, `.nav-item[data-route="${name}"]`);
}
async function screenshot(win, filename) {
  // The shared modal has a 400 ms entrance animation. Capture its settled theme,
  // not an intentionally translucent intermediate animation frame.
  await pause(450);
  win.webContents.invalidate();
  await evaluate(win, "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  fs.writeFileSync(path.join(outputDir, filename), (await win.webContents.capturePage()).toPNG());
}
async function cleanLeave(win, label) {
  // Renderer side of Electron's close/quit handshake. Actual main-process lifecycle
  // is tested independently; never pretend this synthetic request is a real OS quit.
  const result = await evaluate(win, "Promise.race([window.HarbourUnsavedChanges.requestLeave({reason:'quit'}),new Promise(resolve=>setTimeout(()=>resolve('unexpected unsaved confirmation'),1200))])");
  assert.equal(result, true, label);
  await noDialog(win, label);
}
async function openAgentFiles(win) {
  if (await evaluate(win, "document.querySelector('#agentCatalog') && !document.querySelector('#agentCatalog').hidden")) await click(win, `[data-agent="${AGENT}"]`);
  await waitFor(win, "!!document.querySelector('#faDocs .fa-ta') && !document.querySelector('[data-ac-context]')?.disabled", "Agent ready");
  if (await evaluate(win, "document.querySelector('#faFiles').hidden")) await click(win, '[data-fa-tab="files"]');
  await click(win, RAW);
}

async function testAgent(win, f, report) {
  await openAgentFiles(win);
  assert.equal(await value(win, "#faDocs .fa-ta"), lf(files[0].content));
  assert.equal(await evaluate(win, "document.querySelector('#faDraftStatus').textContent"), "无未提交修改", "CRLF loads clean");
  await click(win, "#faCancel"); await noDialog(win, "enter edit then cancel is clean");
  await cleanLeave(win, "CRLF cancel leaves no phantom beforeunload/quit draft");
  await click(win, RAW);
  const draft = lf(files[0].content) + "\nUnsaved native input.\n";
  await input(win, "#faDocs .fa-ta", draft);
  // Undo to the baseline must not count as dirty (even with CRLF API data).
  await input(win, "#faDocs .fa-ta", lf(files[0].content));
  await cleanLeave(win, "reverted manual input is clean");
  await input(win, "#faDocs .fa-ta", draft);
  await click(win, '#faTree [data-sel="tools/index.md"]'); await dialog(win);
  assert.equal(await evaluate(win, "document.querySelector('#faTree .active').dataset.sel"), "CLAUDE.md", "selection unchanged before choice");
  assert.equal(await value(win, "#faDocs .fa-ta"), draft);
  assert.equal(await evaluate(win, "document.activeElement.classList.contains('harbour-dialog-cancel')"), true, "default focus is the non-destructive stay action");
  await screenshot(win, `${report.theme}-agent-confirm.png`);
  // Repeated queued activation of the now-covered target cannot stack dialogs.
  await evaluate(win, "document.querySelector('#faTree [data-sel=\"tools/index.md\"]').click();document.querySelector('#faTree [data-sel=\"tools/index.md\"]').click()");
  await pause(100); assert.equal(await evaluate(win, "document.querySelectorAll('.harbour-dialog-layer').length"), 1);
  await decision(win, STAY);
  assert.equal(await value(win, "#faDocs .fa-ta"), draft, "stay preserves exact draft");
  await click(win, '#agentBack'); await dialog(win);
  for (const type of ["keyDown", "keyUp"]) win.webContents.sendInputEvent({ type, keyCode: "Escape" });
  await waitFor(win, "!document.querySelector('.harbour-dialog-layer')", "Escape cancels navigation");
  assert.equal(await evaluate(win, "document.querySelector('#agentsList .active').dataset.agent"), AGENT);
  await page(win, "memory"); await dialog(win);
  assert.equal(await evaluate(win, "document.body.dataset.panel"), "agents", "page DOM stays mounted until decision");
  await decision(win, STAY);
  assert.equal(await evaluate(win, "location.hash"), "#agents", "rejected page change restores URL");
  assert.equal(await value(win, "#faDocs .fa-ta"), draft);
  f.controls.failSaves = true;
  await click(win, "#faSubmit");
  await waitFor(win, "!document.querySelector('#faSubmit').disabled", "failed direct save returned");
  assert.equal(await value(win, "#faDocs .fa-ta"), draft, "failed save retains text");
  await click(win, '#faTree [data-sel="tools/index.md"]'); await dialog(win);
  await click(win, SAVE); await pause(180);
  assert.equal(await evaluate(win, "document.querySelector('#faTree .active').dataset.sel"), "CLAUDE.md", "save failure cannot authorize navigation");
  assert.equal(await value(win, "#faDocs .fa-ta"), draft);
  if (await evaluate(win, "!!document.querySelector('.harbour-dialog-layer')")) await decision(win, STAY);
  f.controls.failSaves = false;
  await click(win, '#faTree [data-sel="tools/index.md"]'); await dialog(win); await decision(win, DISCARD);
  await waitFor(win, "document.querySelector('#faTree .active').dataset.sel==='tools/index.md'");
  await click(win, '#faTree [data-sel="CLAUDE.md"]'); await noDialog(win, "discarded file has no phantom draft");
  assert.equal(await value(win, "#faDocs .fa-ta"), lf(files[0].content));
  await input(win, "#faDocs .fa-ta", draft);
  await click(win, "#faCancel"); await dialog(win); await decision(win, ".harbour-dialog-confirm");
  await cleanLeave(win, "dirty cancel fully clears draft");
  await click(win, '[data-fa-tab="settings"]');
  await waitFor(win, "!document.querySelector('#ac-maxSteps').disabled");
  await input(win, "#ac-maxSteps", "9");
  await input(win, "#ac-maxSteps", "8");
  await cleanLeave(win, "configuration reverted to original is clean");
  await input(win, "#ac-maxSteps", "9");
  await click(win, '#agentBack'); await dialog(win); await decision(win, STAY);
  assert.equal(await value(win, "#ac-maxSteps"), "9");
  await click(win, "[data-ac-reset]"); await dialog(win); await decision(win, ".harbour-dialog-confirm");
  await waitFor(win, "document.querySelector('#ac-maxSteps')?.value==='8'&&!document.querySelector('#ac-maxSteps').disabled");
  await cleanLeave(win, "cancelled configuration leaves no phantom dirty state");
  await openAgentFiles(win); await input(win, "#faDocs .fa-ta", draft);
  await click(win, '#faTree [data-sel="tools/index.md"]'); await dialog(win); await decision(win, SAVE);
  await waitFor(win, "document.querySelector('#faTree .active').dataset.sel==='tools/index.md'", "confirmed successful save permits exact requested navigation");
  await cleanLeave(win, "acknowledged Agent proposal is clean");
  assert.equal(f.requests.filter(r => r.path === `/api/agent-files/${AGENT}` && r.method === "POST").at(-1).body.content, draft);
  report.agent = "CRLF, edit/cancel/undo, file/Agent/page guards, repeated activation, failed saves, configuration cancel";
}

async function capability(win, kind) {
  await click(win, `[data-cap-kind="${kind}"]`);
  const packageSelector = `[data-capability="${kind}:fixture-${kind}"]`;
  await waitFor(win, `!!document.querySelector(${JSON.stringify(packageSelector)})`);
  await click(win, packageSelector);
  if (kind === "workflow") await click(win, '[data-workflow-tab="files"]');
  await waitFor(win, "document.querySelector('#capViewerBody')?.textContent.includes('fixture') && !document.querySelector('#capEdit')?.disabled");
}
async function testCapabilities(win, f, report) {
  await page(win, "capabilities");
  for (const kind of ["skill", "workflow", "mcp"]) {
    await capability(win, kind);
    const [first, second] = packages.find(p => p.kind === kind).files.map(file => file.path);
    await click(win, "#capEdit");
    assert.equal(await value(win, "#capEditorText"), lf(capabilityContent[first]));
    await cleanLeave(win, `${kind}: merely entering edit is clean`);
    await click(win, "#capEditCancel"); await noDialog(win, `${kind}: unchanged cancel is clean`);
    await click(win, "#capEdit");
    const draft = lf(capabilityContent[first]) + `\n${kind} unsaved fixture text.\n`;
    await input(win, "#capEditorText", draft);
    await click(win, `[data-cap-file="${second}"]`); await dialog(win);
    assert.equal(await evaluate(win, "document.querySelector('#capFiles .active').dataset.capFile"), first);
    await decision(win, STAY); assert.equal(await value(win, "#capEditorText"), draft);
    await screenshot(win, `${report.theme}-${kind}-draft.png`);
    f.controls.failSaves = true; await click(win, "#capEditSubmit");
    await waitFor(win, "!document.querySelector('#capEditSubmit').disabled");
    assert.equal(await evaluate(win, "document.body.dataset.panel"), "capabilities");
    assert.equal(await value(win, "#capEditorText"), draft, `${kind}: failed save stays editable`);
    f.controls.failSaves = false;
    const targetKind = kind === "mcp" ? "skill" : "mcp";
    await click(win, `[data-cap-kind="${targetKind}"]`); await dialog(win); await decision(win, STAY);
    assert.equal(await evaluate(win, "capView.sel"), `${kind}:fixture-${kind}`);
    await page(win, "memory"); await dialog(win); await decision(win, STAY);
    assert.equal(await value(win, "#capEditorText"), draft);
    await click(win, `[data-cap-file="${second}"]`); await dialog(win); await decision(win, DISCARD);
    await waitFor(win, `document.querySelector('#capFilePath')?.textContent===${JSON.stringify(second)}`);
    await click(win, `[data-cap-file="${first}"]`); await noDialog(win, `${kind}: discarded draft does not come back`);
    await click(win, "#capEdit"); assert.equal(await value(win, "#capEditorText"), lf(capabilityContent[first]));
    await input(win, "#capEditorText", draft);
    await click(win, "#capEditCancel"); await dialog(win); await decision(win, ".harbour-dialog-confirm");
    await cleanLeave(win, `${kind}: explicit dirty cancel clears draft`);
    if (kind === "skill") {
      await click(win, "#capEdit"); await input(win, "#capEditorText", draft);
      await click(win, `[data-cap-file="${second}"]`); await dialog(win); await decision(win, SAVE);
      await waitFor(win, `document.querySelector('#capFilePath')?.textContent===${JSON.stringify(second)}`);
      assert.equal(await evaluate(win, "document.body.dataset.panel"), "capabilities", "save-and-leave honors requested file, not unsolicited Governance navigation");
      await cleanLeave(win, "acknowledged capability proposal clears draft");
    }
  }
  report.capabilities = "Skill, Workflow contract, MCP: CRLF, cancel, file/package/page guards, failed saves, discard baselines";
}

async function testMemory(win, f, report) {
  await page(win, "memory");
  await click(win, '[data-mem-file="fixture/one.md"]');
  await waitFor(win, "document.querySelector('#memViewerBody')?.textContent.includes('Memory CRLF baseline')");
  const original = lf(memoryContent["fixture/one.md"]), draft = original + "\nUnsaved memory fixture.\n";
  await click(win, "#memEdit"); await cleanLeave(win, "Memory CRLF enter edit stays clean");
  await click(win, "#memEditCancel"); await noDialog(win, "Memory clean cancel has no confirmation");
  await click(win, "#memEdit"); await input(win, "#memEditorText", draft);
  await click(win, '#memBack'); await dialog(win);
  assert.equal(await evaluate(win, "document.querySelector('#memDetailView').hidden"), false);
  await screenshot(win, `${report.theme}-memory-confirm.png`);
  await decision(win, STAY); assert.equal(await value(win, "#memEditorText"), draft);
  await page(win, "agents"); await dialog(win); await decision(win, STAY);
  assert.equal(await evaluate(win, "location.hash"), "#memory");
  assert.equal(await value(win, "#memEditorText"), draft);
  f.controls.failSaves = true; await click(win, "#memEditSubmit");
  await waitFor(win, "!document.querySelector('#memEditSubmit').disabled");
  assert.equal(await value(win, "#memEditorText"), draft);
  f.controls.failSaves = false;
  await evaluate(win, "window.__quitResult='pending';window.HarbourUnsavedChanges.requestLeave({reason:'quit'}).then(value=>window.__quitResult=value);void 0");
  await dialog(win); await decision(win, STAY);
  await waitFor(win, "window.__quitResult===false");
  assert.equal(await value(win, "#memEditorText"), draft, "renderer quit cancellation keeps data");
  await evaluate(win, "window.__quitResult='pending';window.HarbourUnsavedChanges.requestLeave({reason:'quit',phase:'check'}).then(value=>window.__quitResult=value);void 0");
  await dialog(win); await decision(win, DISCARD); await waitFor(win, "window.__quitResult===true");
  assert.equal(await value(win, "#memEditorText"), draft, "desktop preflight never discards before all windows agree");
  assert.equal(await evaluate(win, "window.HarbourUnsavedChanges.requestLeave({reason:'quit',phase:'cancel'})"), true);
  assert.equal(await value(win, "#memEditorText"), draft, "another window cancelling quit preserves this draft");
  await evaluate(win, "window.__quitResult='pending';window.HarbourUnsavedChanges.requestLeave({reason:'quit',phase:'check'}).then(value=>window.__quitResult=value);void 0");
  await dialog(win); await decision(win, DISCARD); await waitFor(win, "window.__quitResult===true");
  assert.equal(await evaluate(win, "window.HarbourUnsavedChanges.requestLeave({reason:'quit',phase:'commit'})"), true);
  assert.equal(await value(win, "#memEditorText"), draft, "multi-window quit commit defers destructive discard until actual close");
  await evaluate(win, "window.HarbourUnsavedChanges.requestLeave({reason:'quit',phase:'cancel'})");
  assert.equal(await value(win, "#memEditorText"), draft, "aborted quit transaction still retains exact text");
  await evaluate(win, "window.__quitResult='pending';window.HarbourUnsavedChanges.requestLeave({reason:'quit'}).then(value=>window.__quitResult=value);void 0");
  await dialog(win); await decision(win, DISCARD); await waitFor(win, "window.__quitResult===true");
  await cleanLeave(win, "renderer discard-quit clears dirty data");
  await click(win, "#memEdit"); assert.equal(await value(win, "#memEditorText"), original);
  await input(win, "#memEditorText", draft); await click(win, "#memEditCancel"); await dialog(win); await decision(win, ".harbour-dialog-confirm");
  await cleanLeave(win, "Memory dirty cancel clears phantom state");
  await click(win, '#memBack'); await noDialog(win, "Memory navigation is clean after cancellation");
  await click(win, '[data-mem-file="fixture/two.md"]');
  await waitFor(win, "document.querySelector('#memViewerBody').textContent.includes('Second fixture')");
  await click(win, "#memEdit"); await input(win, "#memEditorText", lf(memoryContent["fixture/two.md"]) + "\nSaved fixture draft.\n");
  await click(win, '#memBack'); await dialog(win); await decision(win, SAVE);
  await waitFor(win, "!document.querySelector('#memCatalog').hidden");
  await click(win, '[data-mem-file="fixture/one.md"]');
  await waitFor(win, "document.querySelector('#memViewerBody').textContent.includes('Memory CRLF baseline')");
  assert.equal(await evaluate(win, "document.body.dataset.panel"), "memory", "Memory save-and-leave honors requested file");
  await cleanLeave(win, "acknowledged Memory proposal clears draft");
  report.memory = "CRLF, clean/dirty cancel, file/page guards, failed save, renderer quit stay/check/cancel/commit handshake";
}

app.whenReady().then(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const reports = [];
  for (const theme of [
    { id: "premium", cat: "premium", persona: "neutral", theme: "premium-champagne" },
    { id: "elaina", cat: "anime", persona: "elaina", theme: "anime-wisteria" },
  ].filter(theme => !onlyTheme || theme.id === onlyTheme)) {
    const f = await fixture(theme), report = { theme: theme.id, suite, hidden: true };
    const win = new BrowserWindow({ show: false, width: 1440, height: 1000,
      webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest((details, done) => done({
      cancel: /^(https?|wss?):/.test(details.url) && new URL(details.url).host !== new URL(f.base).host,
    }));
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    try {
      await win.loadURL(f.base + "/#agents");
      await waitFor(win, "!!window.HarbourUnsavedChanges?.requestLeave", "shared unsaved editor guard ready");
      if (suite === "all" || suite === "agent") { await testAgent(win, f, report); console.log(`PASS ${theme.id} Agent unsaved navigation`); }
      if (suite === "all" || suite === "capabilities") { await testCapabilities(win, f, report); console.log(`PASS ${theme.id} Skill/Workflow/MCP unsaved navigation`); }
      if (suite === "all" || suite === "memory") { await testMemory(win, f, report); console.log(`PASS ${theme.id} Memory and renderer quit guard`); }
      assert.equal(win.isVisible(), false, "no visible fixture windows");
      assert.deepEqual(await evaluate(win, "window.__testErrors"), [], "no renderer errors");
      assert.deepEqual(await evaluate(win, "window.__nativeDialogs"), [], "no native confirm fallbacks");
      const writes = f.requests.filter(r => r.method !== "GET");
      assert.ok(writes.every(r => /^\/api\/agent-config\/[^/]+\/preview$/.test(r.path)
        || r.path === `/api/agent-files/${AGENT}` || r.path === "/api/governance/proposals"), "only fixture preview/proposals are permitted");
      report.proposals = writes.filter(r => r.fixtureStatus).map(r => ({ path: r.path, status: r.fixtureStatus, body: r.body }));
      reports.push(report);
      fs.writeFileSync(path.join(outputDir, `report${suite === "all" ? "" : "-" + suite}${onlyTheme ? "-" + onlyTheme : ""}.json`), JSON.stringify(reports, null, 2));
    } catch (error) { await screenshot(win, `${theme.id}-failure.png`).catch(() => {}); throw error; }
    finally { win.destroy(); await f.close(); }
  }
  clearTimeout(deadline);
  console.log(`Unsaved editor real-DOM smoke passed. Evidence: ${outputDir}`);
  app.quit();
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
