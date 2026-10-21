// Real Harbour dashboard in hidden/offscreen Electron against loopback-only fixtures.
// Never loads production Agent files, starts a model, applies proposals or opens Chrome.
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
const outputDir = path.join(root, "assets/reports/agent-editor");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "harbour-agent-editor-")));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.on("window-all-closed", () => {});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (win, script) => win.webContents.executeJavaScript(script);
const agent = { name: "fixture-editor", description: "手动编辑测试 Agent · 仅 fixture", folder: true,
  taskType: "research", permissionMode: "dontAsk", tools: [], skills: [], contextBudget: "auto", maxSteps: 8 };
const model = { modelRef: "mock/fixture", model: "测试模型", modelName: "fixture", modelLabel: "测试模型",
  providerLabel: "Fixture", backendKind: "claude-agent", contextWindow: 1000000, supportedEfforts: ["medium", "high"] };
const files = [
  { file: "CLAUDE.md", group: "persona", content: "---\nname: fixture-editor\ndescription: 手动编辑测试\ncontextBudget: auto\n---\n\n# Fixture rules\n\n这段内容只属于测试，不读取任何生产 Agent。\n" },
  { file: "tools/index.md", group: "index", content: "---\ntools: []\n---\n\n# Fixture tools\n\n本测试不运行工具或模型。\n" },
  { file: "skills/index.md", group: "index", content: "---\nskills: []\n---\n\n# Unchanged fixture\n" },
];
const editedClaude = files[0].content + "\n## 手动编辑验收\n\nManual draft stays intact across preview and file switches.\n";
const editedTools = files[1].content + "\n手动修改第二个文件；提交时应同时保存两个草稿为待审批提案。\n";
const reason = "Fixture: manually edit two files without AI";
const RAW = '#faDocToggle [data-doc-view="raw"]';
const PREVIEW = '#faDocToggle [data-doc-view="render"]';
const otherAgent = { ...agent, name: "fixture-other", description: "独立草稿测试 Agent" };

async function startFixture(testCase) {
  const requests = [];
  let failedSecondProposal = false;
  let failedConfigSave = false;
  const pendingAi = [], pendingSaves = [], pendingDelegations = [];
  const controls = { holdSaves: false, readDelay: 0, failPath: "", holdDelegation: false, failDelegation: false, loseDelegationReply: false };
  const delegation = new Map();
  let modelOverride = null;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/api/")) {
      let body = {};
      if (req.method !== "GET") {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      }
      const request = { method: req.method, path: url.pathname, body };
      requests.push(request);
      if (testCase.delegation && req.method === "POST" && /^\/api\/agents\/[^/]+\/delegation$/.test(url.pathname)) {
        if (controls.failDelegation) return json({ error: "Fixture disk write failed" }, 503);
        const finish = () => {
          const name = decodeURIComponent(url.pathname.split("/")[3]);
          delegation.set(name, body.enabled);
          if (controls.loseDelegationReply) return json({ error: "Fixture reply lost after save" }, 503);
          json({ ok: true, agent: name, delegationEnabled: body.enabled });
        };
        if (controls.holdDelegation) pendingDelegations.push(finish); else finish();
        return;
      }
      const failRead = testCase.switching && controls.failPath === url.pathname;
      if (testCase.switching && /\/api\/(agent-defaults|agents\/|agent-files\/|agent-config\/)/.test(url.pathname)) {
        if (controls.readDelay) await pause(controls.readDelay);
        if (failRead) return json({ error: "Fixture read failed" }, 503);
      }
      if (/^\/api\/agent-config\/[^/]+\/preview$/.test(url.pathname) && req.method === "POST") {
        try { return json(previewAgentConfig(body.source, body.patch)); }
        catch (error) { return json({ error: error.message }, 400); }
      }
      if (testCase.aiRaces && req.method === "POST" && url.pathname === "/api/ai-edit") {
        pendingAi.push(content => json({ content })); return;
      }
      if (testCase.aiRaces && req.method === "POST" && url.pathname === "/api/agent-defaults") {
        modelOverride = body.modelRef; return json({});
      }
      if (url.pathname === `/api/agent-files/${agent.name}`) {
        if (req.method === "GET") return json({ files });
        if (req.method === "POST") {
          if (testCase.configEditor && !failedConfigSave) {
            failedConfigSave = true; request.fixtureStatus = 503;
            return json({ error: "Fixture config save failed; retry must preserve the draft" }, 503);
          }
          if (testCase.partialFailure && body.file === "tools/index.md" && !failedSecondProposal) {
            failedSecondProposal = true; request.fixtureStatus = 503;
            return json({ error: "Fixture second proposal temporarily unavailable" }, 503);
          }
          request.fixtureStatus = 201;
          if (testCase.aiRaces || controls.holdSaves) { pendingSaves.push(() => json({ proposal: { id: `fixture-proposal-${requests.length}`, status: "pending" } }, 201)); return; }
          return json({ proposal: { id: `fixture-proposal-${requests.length}`, status: "pending" } }, 201);
        }
      }
      // Every mutation other than creating fixture proposals fails closed, including AI/reindex/apply.
      if (req.method !== "GET") return json({ error: `forbidden fixture mutation: ${url.pathname}` }, 405);
      if (url.pathname === "/api/state") return json({ defaultAgent: agent.name, agents: [agent], backends: { mock: true }, uptimeMs: 90000 });
      if (url.pathname === "/api/agents") return json({ agents: testCase.aiRaces || testCase.configEditor || testCase.switching || testCase.delegation ? [agent, otherAgent] : [agent] });
      if (url.pathname === `/api/agents/${agent.name}`) return json({ agent });
      if (url.pathname === `/api/agents/${otherAgent.name}`) return json({ agent: otherAgent });
      if (url.pathname === `/api/agent-files/${otherAgent.name}`) return json({ files: [{ file: "CLAUDE.md", group: "persona", content: "---\nname: fixture-other\ncontextBudget: auto\n---\n# Other Agent\n\nUnrelated original." }] });
      if (url.pathname === "/api/agent-defaults") return json({ models: [model], agents: (testCase.delegation ? [agent, otherAgent] : [agent]).map(item => ({ name: item.name,
        delegationConfigurable: !!testCase.delegation, delegationEnabled: delegation.get(item.name) !== false,
        overrideModelRef: modelOverride, manifestModelRef: model.modelRef, manifestPermissionMode: "dontAsk", effectiveModelRef: model.modelRef, effectivePermissionMode: "dontAsk" })) });
      if (url.pathname === "/api/asks") return json({ asks: [] });
      if (url.pathname === "/api/skills") return json({ skills: [] });
      if (url.pathname === "/api/cowork/devices") return json({ devices: [] });
      if (url.pathname === "/api/governance") return json({ proposals: [] });
      return json({ error: `unknown fixture endpoint: ${url.pathname}` }, 404);
    }
    const file = path.resolve(webRoot, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(webRoot + path.sep)) { res.writeHead(403); return res.end(); }
    try {
      let content = fs.readFileSync(file);
      if (path.basename(file) === "index.html") content = Buffer.from(content.toString().replace("<head>", `<head><script>
        localStorage.clear();
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
  wss.on("connection", (socket) => socket.send(JSON.stringify({ __harbour: "activity-snapshot", activeRunIds: [], serverEpoch: "fixture-agent-editor" })));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, requests, pendingAi, pendingSaves, pendingDelegations, controls,
    async close() { for (const socket of wss.clients) socket.terminate(); wss.close(); server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); } };
}

async function waitFor(win, expression, label) {
  for (let i = 0; i < 200; i++) { if (await evaluate(win, expression)) return; await pause(25); }
  throw new Error(`timeout: ${label}`);
}

async function click(win, selector) {
  let hit, previous = "", stable = 0;
  for (let i = 0; i < 50; i++) {
    await pause(35);
    hit = await evaluate(win, `(() => {
      const el=document.querySelector(${JSON.stringify(selector)});
      if(!el) throw new Error('missing click target: '+${JSON.stringify(selector)});
      el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
      const r=el.getBoundingClientRect(),point={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
      const actual=document.elementFromPoint(point.x,point.y);
      return {ok:el.contains(actual),point,actual:actual?.outerHTML.slice(0,500),
        rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},viewport:{width:innerWidth,height:innerHeight}};
    })()`);
    const current = JSON.stringify(hit.point);
    stable = hit.ok && current === previous ? stable + 1 : 0;
    previous = current;
    if (stable >= 3) break;
  }
  assert.ok(hit.ok && stable >= 3, `native mouse target must be visible and unobscured: ${selector} ${JSON.stringify(hit)}`);
  win.webContents.sendInputEvent({ type: "mouseMove", ...hit.point });
  win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...hit.point });
  win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...hit.point });
  await pause(75);
}

async function enterText(win, selector, value) {
  await click(win, selector);
  const editable = await evaluate(win, `(() => {
    const el=document.querySelector(${JSON.stringify(selector)});
    const active=document.activeElement===el && !el.readOnly && !el.disabled && !el.hidden;
    el.select(); window.__nativeInputEvents=0;
    el.addEventListener('input', () => window.__nativeInputEvents++, {once:true});
    return active;
  })()`);
  assert.ok(editable, `${selector} must accept manual input`);
  await win.webContents.insertText(value);
  await waitFor(win, `document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(value)} && window.__nativeInputEvents>0`, "native text input");
}

async function inspectLayout(win, selector) {
  // Scroll on narrow screens; the desktop document and its actions must fit together.
  await evaluate(win, `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})`);
  await pause(80);
  const layout = await evaluate(win, `(() => {
    const el=document.querySelector(${JSON.stringify(selector)}), r=el.getBoundingClientRect();
    let top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);
    for(let p=el.parentElement;p;p=p.parentElement) {
      const css=getComputedStyle(p);
      if(/(auto|scroll|hidden|clip)/.test(css.overflowY)) { const pr=p.getBoundingClientRect(); top=Math.max(top,pr.top); bottom=Math.min(bottom,pr.bottom); }
    }
    return {viewportWidth:innerWidth,viewportHeight:innerHeight,pageWidth:document.documentElement.scrollWidth,
      left:r.left,right:r.right,width:r.width,height:r.height,visibleHeight:Math.max(0,bottom-top),
      actions: ['#faSubmit','#faCancel','#faAiToggle'].map(id=>{
        const el=document.querySelector(id),r=el.getBoundingClientRect();
        return {id,visible:r.height>0 && r.top>=0 && r.bottom<=innerHeight && r.left>=0 && r.right<=innerWidth};
      }),
      aiCollapsed:document.querySelector('#faAiPanel')?.hidden===true};
  })()`);
  assert.ok(layout.pageWidth <= layout.viewportWidth + 2, `no page horizontal overflow: ${JSON.stringify(layout)}`);
  assert.ok(layout.left >= -1 && layout.right <= layout.viewportWidth + 1 && layout.width >= 200,
    `document stays within viewport: ${JSON.stringify(layout)}`);
  assert.ok(layout.visibleHeight >= (layout.viewportWidth > 760 ? 300 : 200), `document must have substantial visible editing space: ${JSON.stringify(layout)}`);
  assert.equal(layout.aiCollapsed, true, "AI is optional and collapsed by default");
  assert.ok(layout.actions.every(action=>action.visible), `save, cancel and AI must be visible alongside the editor: ${JSON.stringify(layout)}`);
  return layout;
}

async function screenshot(win, name) {
  await evaluate(win, "document.querySelectorAll('.toast').forEach(el=>el.remove())");
  win.webContents.invalidate();
  await evaluate(win, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await pause(100);
  fs.writeFileSync(path.join(outputDir, name), (await win.webContents.capturePage()).toPNG());
}

async function testSwitching(win, fixture, testCase) {
  const editorRequestCount = () => fixture.requests.filter(request =>
    /^\/api\/(agents(?:\/|$)|agent-defaults$|agent-files\/|agent-config\/|tools$)/.test(request.path)
    || request.method !== "GET").length;
  const ready = name => `document.querySelector('#agentsDetail h3')?.textContent.includes(${JSON.stringify(name)}) && document.querySelector('[data-ac-field="maxSteps"] input')?.disabled===false`;
  await waitFor(win, ready(agent.name), "first config ready");
  fixture.controls.readDelay = 160;
  await evaluate(win, "window.__rows = [...document.querySelectorAll('#agentsList [data-agent]')]");
  await click(win, '#agentBack');
  await waitFor(win, "!document.querySelector('#agentCatalog').hidden && document.querySelector('#agentDetailView').hidden", "back shows catalog");
  assert.equal(await evaluate(win, "document.querySelector('#agentsDetail').children.length"), 0, "old editor is unmounted after a clean return");
  await click(win, `#agentsList [data-agent="${otherAgent.name}"]`);
  await waitFor(win, ready(otherAgent.name), "second config ready");
  assert.equal(await evaluate(win, "window.__rows.every((row,index)=>row===document.querySelectorAll('#agentsList [data-agent]')[index])"), true,
    "Opening and returning preserve catalog DOM and scroll position");
  await screenshot(win, `${testCase.id}-loaded.png`);

  // Returning during a delayed load invalidates the pending editor. A late response
  // cannot reopen it or overwrite a different Agent opened from the catalog.
  await click(win, '#agentBack');
  await click(win, `#agentsList [data-agent="${agent.name}"]`);
  await waitFor(win, "document.querySelector('#agentsDetail').inert", "loading prevents editing");
  await click(win, '#agentBack');
  await click(win, `#agentsList [data-agent="${otherAgent.name}"]`);
  await waitFor(win, ready(otherAgent.name) + " && !document.querySelector('#agentsDetail').inert", "latest selection wins");
  await pause(400);
  assert.equal(await evaluate(win, ready(otherAgent.name)), true, "Late previous read cannot replace the current Agent");

  fixture.controls.failPath = `/api/agent-files/${agent.name}`;
  await click(win, '#agentBack');
  await click(win, `#agentsList [data-agent="${agent.name}"]`);
  await waitFor(win, "document.querySelector('#agentDetailStatus')?.classList.contains('is-error')", "read failure is visible");
  assert.equal(await evaluate(win, `(() => {
    const status=document.querySelector('#agentDetailStatus'), rect=status.getBoundingClientRect();
    return !status.hidden && rect.top>=0 && rect.bottom<=innerHeight;
  })()`), true, "Failure and retry are visible without scrolling");
  assert.equal(await evaluate(win, "document.querySelector('#agentsDetail').inert && !document.querySelector('#agentsDetail h3')"), true,
    "Read failure cannot expose a stale editable Agent");
  await screenshot(win, `${testCase.id}-retry.png`);
  fixture.controls.failPath = "";
  await click(win, '#agentDetailStatus button');
  await waitFor(win, ready(agent.name) + " && !document.querySelector('#agentsDetail').inert", "retry succeeds");
  assert.ok(fixture.requests.filter(r=>r.method!=="GET").every(r=>r.path.startsWith('/api/agent-config/') && Object.keys(r.body.patch).length===0),
    "Catalog navigation only reads/validates; never invokes AI or saves a proposal");

  await click(win, '[data-fa-tab="files"]'); await click(win, RAW);
  await enterText(win, '#faDocs .fa-ta', editedClaude);
  const beforeLeave = editorRequestCount();
  await click(win, '#agentBack');
  await click(win, '[data-dialog-kind="leave"] .harbour-dialog-cancel');
  assert.equal(editorRequestCount(), beforeLeave, "Declining a dirty return does not start loading");
  assert.equal(await evaluate(win, "document.querySelector('#faDocs .fa-ta').value"), editedClaude);
  assert.equal(await evaluate(win, "document.querySelector('#agentCatalog').hidden"), true);
  assert.deepEqual(await evaluate(win, "window.__testErrors"), []);
  return { stableCards: true, latestWins: true, failureRetry: true, dirtyGuard: true };
}

async function testAiAndDrafts(win, fixture, testCase) {
  const read = () => evaluate(win, "document.querySelector('#faDocs .fa-ta').value");
  const releaseAi = async (content) => {
    assert.equal(fixture.pendingAi.length, 1, "one fixture rewrite is pending");
    fixture.pendingAi.shift()(content);
    await waitFor(win, "!document.querySelector('#faAiGo').disabled");
    await pause(150);
  };
  const beginAi = async () => {
    await enterText(win, '#faAiInput', '简化这段说明，保留事实');
    await click(win, '#faAiGo');
    await waitFor(win, "document.querySelector('#faAiGo').disabled");
  };
  await click(win, RAW);
  await enterText(win, '#faDocs .fa-ta', editedClaude);
  await click(win, '#faAiToggle');
  assert.equal(await evaluate(win, "document.querySelector('#faAiPanel').hidden"), false);
  await screenshot(win, `${testCase.id}-ai-panel.png`);
  await beginAi();
  const intervening = editedClaude + '\nManual edit while AI is pending.';
  await enterText(win, '#faDocs .fa-ta', intervening);
  await releaseAi('SHOULD NOT OVERWRITE MANUAL EDIT');
  assert.equal(await read(), intervening, 'late AI result cannot overwrite manual input');

  await beginAi();
  await click(win, '#faTree [data-sel="tools/index.md"]');
  await click(win, '.harbour-dialog-confirm');
  assert.equal(await evaluate(win, "document.querySelector('#faDocs .fa-doc').dataset.file"), 'CLAUDE.md', 'pending AI prevents a file switch');
  await releaseAi('# Rewritten Claude fixture\n\nAccepted AI draft.');
  assert.match(await read(), /Accepted AI draft/);
  assert.equal(fixture.requests.filter(r=>r.method==='POST' && r.path.includes('/api/agent-files')).length, 0, 'AI never auto-submits');

  await beginAi();
  await click(win, '#faCancel');
  await click(win, '.harbour-dialog-confirm');
  await releaseAi('SHOULD NOT RESTORE A CANCELLED DRAFT');
  assert.equal(await read(), files[0].content, 'discard invalidates pending AI, including preview transitions');
  await click(win, '#faAiToggle');
  await click(win, RAW);
  await enterText(win, '#faDocs .fa-ta', editedClaude);
  await click(win, '#faTree [data-sel="tools/index.md"]');
  await click(win, '[data-dialog-kind="leave"] .harbour-dialog-cancel');
  assert.equal(await read(), editedClaude, 'declined switch preserves the original file draft');
  await click(win, '#faTree [data-sel="tools/index.md"]');
  await click(win, '[data-dialog-kind="leave"] .harbour-dialog-discard');
  await enterText(win, '#faDocs .fa-ta', editedTools);
  await click(win, '#faCancel');
  await click(win, '.harbour-dialog-confirm');
  assert.equal(await read(), files[1].content);
  assert.equal(await evaluate(win, "document.querySelector('#faDraftStatus').textContent"), '无未提交修改', 'explicit discards leave no hidden drafts');
  await click(win, '#agentBack');
  await click(win, '[data-agent="fixture-other"]');
  await waitFor(win, "document.querySelector('#faSelPath')?.textContent.includes('fixture-other')");
  assert.match(await read(), /Unrelated original/);
  await click(win, '#agentBack');
  await click(win, '[data-agent="fixture-editor"]');
  await waitFor(win, "document.querySelector('#faSelPath')?.textContent.includes('fixture-editor')");
  assert.equal(await read(), files[0].content, 'switching Agents after discard restores the clean baseline');

  await click(win, '[data-fa-tab="settings"]');
  await screenshot(win, `${testCase.id}-runtime.png`);
  await click(win, '[data-fa-tab="files"]');
  await click(win, RAW);
  await enterText(win, '#faDocs .fa-ta', editedClaude);
  await click(win, '[data-fa-tab="settings"]');
  await click(win, '[data-dialog-kind="leave"] .harbour-dialog-cancel');
  const defaultsReads = fixture.requests.filter(r=>r.method==='GET' && r.path==='/api/agent-defaults').length;
  // A defaults response may arrive while the file workspace is visible. Invoke
  // the same existing change boundary without bypassing the unsaved navigation guard.
  await evaluate(win, `(() => {const s=document.querySelector('[data-agent-default-model]');s.value=${JSON.stringify(model.modelRef)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  for (let i=0;i<80 && fixture.requests.filter(r=>r.method==='GET' && r.path==='/api/agent-defaults').length<=defaultsReads;i++) await pause(25);
  assert.ok(fixture.requests.filter(r=>r.method==='GET' && r.path==='/api/agent-defaults').length>defaultsReads);
  await pause(100);
  assert.equal(await read(), editedClaude, 'saving runtime defaults does not erase a manual file draft');
  assert.equal(await evaluate(win, "document.querySelector('#faFiles').hidden"), false, 'runtime updates preserve the open workbench');
  await click(win, '#faFocus');
  assert.equal(await evaluate(win, "document.querySelector('#faFocus').getAttribute('aria-pressed')"), 'true');
  await click(win, RAW);
  await screenshot(win, `${testCase.id}-focus.png`);
  await click(win, '#faSubmit');
  await waitFor(win, "document.querySelector('#faSubmit').textContent==='提交中…'");
  const afterSaveStarted = editedClaude + '\nEdited after the save snapshot.';
  await enterText(win, '#faDocs .fa-ta', afterSaveStarted);
  assert.equal(fixture.pendingSaves.length, 1);
  fixture.pendingSaves.shift()();
  await waitFor(win, "!document.querySelector('#faSubmit').disabled");
  assert.equal(await read(), afterSaveStarted, 'save acknowledgement cannot clear newer input');
  await click(win, '#faSubmit');
  await waitFor(win, "document.querySelector('#faSubmit').textContent==='提交中…'");
  fixture.pendingSaves.shift()();
  await waitFor(win, "document.querySelector('#faDraftStatus').textContent==='提案待审批'");
  assert.deepEqual(fixture.requests.filter(r=>r.method==='POST' && r.path.includes('/api/agent-files')).map(r=>r.body.content), [editedClaude, afterSaveStarted]);
  assert.equal(await evaluate(win, "[...agentsView.fileDrafts.values()].some(d=>d.size)"), false, 'all retained drafts are cleared only after confirmed submission');
  assert.deepEqual(await evaluate(win, 'window.__testErrors'), []);
  assert.equal(win.isVisible(), false);
}

async function chooseConfig(win, path, value) {
  const row = `[data-ac-field="${path}"]`;
  const index = await evaluate(win, `Array.from(document.querySelector(${JSON.stringify(row)}).querySelector('select').options).findIndex(o=>o.value===${JSON.stringify(value)})`);
  assert.ok(index >= 0, `config option ${path}: ${value}`);
  await click(win, `${row} .hs-trigger`);
  await click(win, `${row} [data-hs-index="${index}"]`);
}

async function testConfiguration(win, fixture, testCase) {
  const contextInput = '[data-ac-field="contextBudget"] [data-ac-value]';
  await waitFor(win, "document.querySelector('[data-ac-context]') && !document.querySelector('[data-ac-context]').disabled", "configuration loaded");
  assert.equal(await evaluate(win, "document.querySelector('[data-ac-context]').value"), "auto");
  const geometry = await evaluate(win, `(()=>{const r=document.querySelector('.ac-scroll').getBoundingClientRect(),b=document.querySelector('[data-ac-save]').getBoundingClientRect();return {height:r.height,width:innerWidth,pageWidth:document.documentElement.scrollWidth,button:{top:b.top,bottom:b.bottom}}})()`);
  assert.ok(geometry.height >= 220 && geometry.pageWidth <= geometry.width + 2, JSON.stringify(geometry));
  assert.ok(geometry.button.top >= 0 && geometry.button.bottom <= (testCase.height || 960));
  await screenshot(win, `${testCase.id}-automatic.png`);
  await chooseConfig(win, "contextBudget", "manual");
  await enterText(win, contextInput, "12000");
  await chooseConfig(win, "reasoningEffort", "high");
  await enterText(win, '#ac-maxSteps', "256");
  // A dirty Agent switch now requires an explicit decision; Stay preserves all fields.
  await click(win, '#agentBack');
  await click(win, '[data-dialog-kind="leave"] .harbour-dialog-cancel');
  await waitFor(win, "document.querySelector('#faSelPath')?.textContent.includes('fixture-editor') && document.querySelector('[data-ac-context]')?.value==='manual'", "retained config");
  assert.equal(await evaluate(win, `document.querySelector(${JSON.stringify(contextInput)}).value`), "12000");
  await screenshot(win, `${testCase.id}-manual.png`);
  await click(win, '[data-ac-save]');
  await waitFor(win, "document.querySelector('[data-ac-status]').textContent.includes('Fixture config save failed') && !document.querySelector('[data-ac-save]').disabled", "failed save preserved");
  assert.equal(await evaluate(win, `document.querySelector(${JSON.stringify(contextInput)}).value`), "12000");
  await click(win, '[data-ac-save]');
  await waitFor(win, "document.querySelector('[data-ac-status]').textContent.includes('待审批提案') && document.querySelector('[data-ac-save]').disabled", "config proposal acknowledged");
  assert.equal(await evaluate(win, "document.querySelector('[data-ac-governance]').hidden"), false, "saved proposal exposes the approval action");
  let saves = fixture.requests.filter(r=>r.path===`/api/agent-files/${agent.name}` && r.method==='POST');
  assert.equal(saves.length, 2);
  assert.equal(saves[0].body.content, saves[1].body.content, "retry uses the same draft");
  const parsed = previewAgentConfig(saves.at(-1).body.content, {});
  assert.equal(parsed.config.contextBudget, 12000); assert.equal(parsed.config.maxSteps, 256); assert.equal(parsed.config.reasoningEffort, 'high');
  assert.ok(parsed.content.endsWith(files[0].content.slice(files[0].content.indexOf('\n---\n') + 5)), "persona body remains exact");
  // Reset-to-auto is a real explicit choice, not a second hidden numeric cap.
  await chooseConfig(win, 'contextBudget', 'auto');
  await click(win, '[data-ac-save]');
  await waitFor(win, "document.querySelector('[data-ac-save]').disabled && document.querySelector('[data-ac-status]').textContent.includes('待审批提案')", "auto saved");
  saves = fixture.requests.filter(r=>r.path===`/api/agent-files/${agent.name}` && r.method==='POST');
  assert.equal(previewAgentConfig(saves.at(-1).body.content, {}).config.contextBudget, 'auto');
  // A raw document edit after starting a form draft must not be overwritten by that older form.
  await enterText(win, '#ac-maxSteps', "99");
  await click(win, '[data-fa-tab="files"]');
  await click(win, '[data-dialog-kind="leave"] .harbour-dialog-cancel');
  assert.equal(await evaluate(win, "document.querySelector('#faSettings').hidden"), false, 'dirty workspace switch stays until explicitly resolved');
  const changedBody = saves.at(-1).body.content + '\nKEEP NEW BODY DRAFT\n';
  // Simulate a concurrent document update to retain lower-level stale-source
  // coverage now that native workspace navigation prevents creating this conflict.
  await evaluate(win, `(() => {const text=document.querySelector('#faDocs .fa-ta');text.value=${JSON.stringify(changedBody)};text.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click(win, '[data-ac-save]');
  await waitFor(win, "document.querySelector('[data-ac-status]').textContent.includes('文件草稿已改变')", "stale form blocked");
  assert.equal(fixture.requests.filter(r=>r.path===`/api/agent-files/${agent.name}` && r.method==='POST').length, 3);
  await click(win, '[data-ac-reset]'); await click(win, '.harbour-dialog-confirm');
  await waitFor(win, "!document.querySelector('[data-ac-context]').disabled && document.querySelector('#ac-maxSteps').value==='256'", "reload preserves raw body");
  await click(win, '[data-fa-tab="files"]');
  await click(win, '[data-dialog-kind="leave"] .harbour-dialog-confirm');
  await waitFor(win, "!document.querySelector('#faFiles').hidden", 'explicitly save concurrent body then inspect file');
  assert.equal(await evaluate(win, "document.querySelector('#faDocs .fa-ta').value"), changedBody);
  // A pending save now blocks Agent navigation. Its late acknowledgement must
  // still not clear newer input in the current editor or alter the document body.
  await click(win, '[data-fa-tab="settings"]');
  await enterText(win, '#ac-maxSteps', "77");
  fixture.controls.holdSaves = true;
  await click(win, '[data-ac-save]');
  await waitFor(win, "document.querySelector('[data-ac-save]').textContent==='提交中…'", "delayed config save");
  for (let i = 0; i < 80 && !fixture.pendingSaves.length; i++) await pause(25);
  assert.equal(fixture.pendingSaves.length, 1);
  await click(win, '#agentBack');
  await click(win, '.harbour-dialog-confirm');
  assert.ok(await evaluate(win, "document.querySelector('#faSelPath').textContent.includes('fixture-editor')"), 'pending save cannot unmount Agent');
  await enterText(win, '#ac-maxSteps', "88");
  fixture.pendingSaves.shift()(); fixture.controls.holdSaves = false;
  await pause(150);
  assert.equal(await evaluate(win, "document.querySelector('#ac-maxSteps').value"), "88");
  assert.equal(await evaluate(win, "agentsView.configDrafts.get('fixture-editor').edit.maxSteps.raw"), "88");
  assert.ok((await evaluate(win, "document.querySelector('#faDocs .fa-ta').value")).endsWith('KEEP NEW BODY DRAFT\n'));
  await click(win, '[data-ac-save]');
  await waitFor(win, "document.querySelector('[data-ac-status]').textContent.includes('待审批提案') && document.querySelector('[data-ac-save]').disabled", "newer draft saved");
  saves = fixture.requests.filter(r=>r.path===`/api/agent-files/${agent.name}` && r.method==='POST');
  assert.equal(previewAgentConfig(saves.at(-1).body.content, {}).config.maxSteps, 88);
  assert.ok(saves.at(-1).body.content.endsWith('KEEP NEW BODY DRAFT\n'));
  assert.deepEqual(await evaluate(win, "window.__testErrors"), []);
  assert.ok(fixture.requests.filter(r=>r.method==='POST').every(r=>r.path.startsWith('/api/agent-config/') || r.path===`/api/agent-files/${agent.name}`));
  return geometry;
}

async function testDelegation(win, fixture, testCase) {
  const toggle = '[data-agent-delegation]';
  const checked = value => `document.querySelector('${toggle}')?.getAttribute('aria-checked')==='${value}' && !document.querySelector('${toggle}').disabled`;
  await waitFor(win, checked(true), "delegation default enabled");
  await enterText(win, '#ac-maxSteps', '42');
  const draft = await evaluate(win, "document.querySelector('#faDocs .fa-ta').value");
  await click(win, toggle);
  await waitFor(win, checked(false), "pause confirmed");
  assert.equal(await evaluate(win, "document.querySelector('#ac-maxSteps').value"), '42', 'hot toggle must preserve unsaved config');
  assert.equal(await evaluate(win, "document.querySelector('#faDocs .fa-ta').value"), draft, 'hot toggle must not re-render the file workbench');
  const layout = await evaluate(win, `(() => {
    const el=document.querySelector('.agent-delegation-control'),r=el.getBoundingClientRect();
    const copy=el.querySelector('.adc-copy').getBoundingClientRect(),button=el.querySelector('button').getBoundingClientRect();
    return {width:innerWidth,pageWidth:document.documentElement.scrollWidth,left:r.left,right:r.right,copyRight:copy.right,buttonLeft:button.left,buttonWidth:button.width};
  })()`);
  assert.ok(layout.pageWidth <= layout.width+2 && layout.left >= 0 && layout.right <= layout.width+1, JSON.stringify(layout));
  assert.ok(layout.copyRight + 8 <= layout.buttonLeft && layout.buttonWidth >= 44, 'readable copy separated from accessible switch');
  await screenshot(win, `${testCase.id}.png`);
  await click(win, toggle); await waitFor(win, checked(true), 're-enable confirmed');
  fixture.controls.failDelegation = true;
  await click(win, toggle); await waitFor(win, checked(true), 'failed save stays enabled');
  fixture.controls.failDelegation = false;
  fixture.controls.loseDelegationReply = true;
  await click(win, toggle); await waitFor(win, checked(false), 'lost reply queries persisted state');
  fixture.controls.loseDelegationReply = false;
  assert.equal(fixture.requests.filter(r=>r.path.endsWith('/delegation')).length, 4, 'no automatic mutation replay on uncertain response');
  await click(win, '[data-ac-reset]'); await click(win, '.harbour-dialog-confirm');
  fixture.controls.holdDelegation = true;
  await click(win, toggle);
  await waitFor(win, `document.querySelector('${toggle}').disabled`, 'pending toggle disabled');
  await evaluate(win, `document.querySelector('${toggle}').click()`);
  assert.equal(fixture.pendingDelegations.length, 1, 'double click cannot submit twice');
  await click(win, '#agentBack');
  await click(win, '[data-agent="fixture-other"]');
  await waitFor(win, `document.querySelector('${toggle}')?.dataset.agentDelegation==='fixture-other'`, 'other Agent opened');
  fixture.pendingDelegations.shift()(); fixture.controls.holdDelegation = false;
  await pause(160);
  assert.ok(await evaluate(win, checked(true)), 'late response must not change the other Agent');
  await click(win, '#agentBack');
  await click(win, '[data-agent="fixture-editor"]'); await waitFor(win, checked(true), 'return reflects saved value');
  assert.deepEqual(await evaluate(win, 'window.__testErrors'), []);
  assert.ok(fixture.requests.filter(r=>r.method==='POST').every(r=>r.path.endsWith('/delegation') || r.path.startsWith('/api/agent-config/')), 'no Agent/persona proposal writes');
  return layout;
}

async function runCase(testCase) {
  const fixture = await startFixture(testCase);
  const win = new BrowserWindow({ show: false, width: testCase.width, height: testCase.height || 960,
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  const report = { testCase, hidden: true, checkpoints: {} };
  const externalRequests = [], popupRequests = [];
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const external = /^(https?|wss?):/.test(details.url) && new URL(details.url).host !== new URL(fixture.base).host;
    if (external) externalRequests.push(details.url);
    callback({ cancel: external });
  });
  win.webContents.setWindowOpenHandler((details) => { popupRequests.push(details.url); return { action: "deny" }; });
  try {
    await win.loadURL(fixture.base + "/#agents");
    await click(win, `[data-agent="${agent.name}"]`);
    await waitFor(win, "document.querySelector('#faDocs .fa-doc')?.dataset.file==='CLAUDE.md'", "Agent file editor");
    await evaluate(win, "document.fonts.ready");
    if (testCase.delegation) {
      report.delegation = await testDelegation(win, fixture, testCase);
      fs.writeFileSync(path.join(outputDir, `${testCase.id}.json`), JSON.stringify(report, null, 2));
      console.log(`Agent delegation ${testCase.id}: native click, layout, preserved draft, failed/lost replies, duplicate prevention, late response isolation`);
      return;
    }
    if (testCase.switching) {
      report.switching = await testSwitching(win, fixture, testCase);
      report.requests = fixture.requests;
      fs.writeFileSync(path.join(outputDir, `${testCase.id}.json`), JSON.stringify(report, null, 2));
      console.log(`Agent switching ${testCase.id}: catalog return, stable card DOM, latest response, retry, dirty guard; hidden Electron`);
      return;
    }
    if (testCase.configEditor) {
      report.config = await testConfiguration(win, fixture, testCase);
      report.requests = fixture.requests;
      fs.writeFileSync(path.join(outputDir, `${testCase.id}.json`), JSON.stringify(report, null, 2));
      console.log(`Agent config ${testCase.id}: auto/manual, per-Agent drafts, effort, steps, failed save retry, exact persona, stale form blocked`);
      return;
    }
    await click(win, '[data-fa-tab="files"]');
    assert.equal(await evaluate(win, "document.querySelector('#faSettings').hidden"), true, "runtime settings do not squeeze the file editor");
    assert.equal(await evaluate(win, "document.querySelector('#faDocs .fa-ta').hidden"), true, "default view is a preview");
    assert.equal(await evaluate(win, `document.querySelector(${JSON.stringify(RAW)}).textContent.trim()`), "手动编辑");
    assert.equal(await evaluate(win, `document.querySelector(${JSON.stringify(PREVIEW)}).textContent.trim()`), "预览");
    assert.match(await evaluate(win, "document.querySelector('#faDocs .fa-rend').innerText"), /Fixture rules/);
    report.checkpoints.preview = await inspectLayout(win, "#faDocs .fa-rend");
    await screenshot(win, `${testCase.id}-preview.png`);
    if (testCase.aiRaces) {
      await testAiAndDrafts(win, fixture, testCase);
      report.requests = fixture.requests;
      fs.writeFileSync(path.join(outputDir, `${testCase.id}.json`), JSON.stringify(report, null, 2));
      console.log(`Agent editor ${testCase.id}: AI races, discard, per-Agent drafts, runtime save, focus, in-flight save edits (fixture only)`);
      return;
    }

    await click(win, RAW);
    await enterText(win, "#faDocs .fa-ta", editedClaude);
    report.checkpoints.manual = await inspectLayout(win, "#faDocs .fa-ta");
    await screenshot(win, `${testCase.id}-manual.png`);
    await click(win, '#faCancel');
    await waitFor(win, "!!document.querySelector('.harbour-dialog')", "discard confirmation");
    await click(win, '.harbour-dialog-cancel');
    assert.equal(await evaluate(win, "document.querySelector('#faDocs .fa-ta').value"), editedClaude, "declining discard preserves the draft");
    await click(win, PREVIEW);
    await waitFor(win, "document.querySelector('#faDocs .fa-rend').innerText.includes('Manual draft stays intact')", "edited preview");
    await click(win, RAW);
    assert.equal(await evaluate(win, "document.querySelector('#faDocs .fa-ta').value"), editedClaude, "preview preserves exact textarea content");

    await enterText(win, "#faReason", reason);
    await click(win, '#faTree [data-sel="tools/index.md"]');
    await click(win, '[data-dialog-kind="leave"] .harbour-dialog-cancel');
    assert.equal(await evaluate(win, "document.querySelector('#faDocs .fa-ta').value"), editedClaude, "declining a file switch preserves the exact first draft");
    assert.equal(fixture.requests.filter((r) => r.method !== "GET" && !r.path.startsWith('/api/agent-config/')).length, 0, "declining a switch never saves or invokes AI");
    await click(win, '#faTree [data-sel="tools/index.md"]');
    await click(win, '[data-dialog-kind="leave"] .harbour-dialog-confirm');
    await waitFor(win, "document.querySelector('#faDocs .fa-doc')?.dataset.file==='tools/index.md'", "explicit save-and-switch opens second file");
    await enterText(win, "#faDocs .fa-ta", editedTools);
    await click(win, '#faTree [data-sel="CLAUDE.md"]');
    await click(win, '[data-dialog-kind="leave"] .harbour-dialog-cancel');
    assert.equal(await evaluate(win, "document.querySelector('#faDocs .fa-doc').dataset.file"), 'tools/index.md', "stay keeps selected dirty file");
    assert.equal(await evaluate(win, "document.querySelector('#faDocs .fa-ta').value"), editedTools, "stay keeps second draft");
    await screenshot(win, `${testCase.id}-second-draft.png`);
    await click(win, "#faSubmit");
    if (testCase.partialFailure) {
      await waitFor(win, "document.querySelector('#faDraftStatus')?.textContent.includes('1 个文件待提交') && !document.querySelector('#faSubmit')?.disabled", "partial failure releases submit and retains one draft");
      assert.equal(await evaluate(win, "location.hash"), "#agents", "partial failure stays in the editor");
      assert.equal(await evaluate(win, "document.querySelector('#faDocs .fa-ta').value"), editedTools, "failed file draft remains exactly intact");
      assert.equal(await evaluate(win, "document.querySelector('#faTree [data-sel=\"CLAUDE.md\"]').classList.contains('dirty')"), false, "successfully submitted file is no longer dirty");
      assert.equal(await evaluate(win, "document.querySelector('#faTree [data-sel=\"tools/index.md\"]').classList.contains('dirty')"), true, "failed file remains dirty");
      assert.deepEqual(fixture.requests.filter((r) => r.method === "POST" && !r.path.startsWith('/api/agent-config/')).map((r) => [r.body.file, r.fixtureStatus]),
        [["CLAUDE.md", 201], ["tools/index.md", 503]], "first attempt succeeds once then fails deterministically");
      report.checkpoints.partialFailure = { retainedDraft: editedTools, successfulFileDirty: false, failedFileDirty: true };
      await screenshot(win, `${testCase.id}-retry-ready.png`);
      await click(win, "#faSubmit");
    }
    await waitFor(win, "document.querySelector('#faSaveResult')?.textContent.includes('批准并应用后生效') && document.querySelector('#faSubmit').disabled", "confirmed proposal save stays in the editor");
    assert.equal(await evaluate(win, "location.hash"), "#agents", "saving does not unexpectedly leave the workbench");

    const writes = fixture.requests.filter((r) => r.method !== "GET" && !r.path.startsWith('/api/agent-config/'));
    assert.equal(writes.length, testCase.partialFailure ? 3 : 2, "explicitly saved files, and only failed attempts are retried");
    assert.ok(writes.every((r) => r.method === "POST" && r.path === `/api/agent-files/${agent.name}`), "use existing governed Agent file endpoint only");
    assert.deepEqual(writes.filter((r) => r.fixtureStatus === 201).map((r) => r.body.file), ["CLAUDE.md", "tools/index.md"],
      "each dirty file creates exactly one successful proposal, even after a partial failure");
    const submitted = Object.fromEntries(writes.map((r) => [r.body.file, r.body.content]));
    assert.deepEqual(submitted, { "CLAUDE.md": editedClaude, "tools/index.md": editedTools });
    assert.ok(writes.every((r) => r.body.reason === reason), "explicit reason is sent for all drafts");
    assert.equal(fixture.requests.filter((r) => /\/api\/(ai-edit|run)(?:\/|$)/.test(r.path)).length, 0, "manual editing never calls AI");
    await click(win, '#faSaveResult a');
    await waitFor(win, "location.hash==='#governance' && !!document.querySelector('#govList')", "explicit proposal handoff");
    assert.deepEqual(popupRequests, [], "no browser windows opened");
    assert.deepEqual(await evaluate(win, "window.__testErrors"), []);
    assert.equal(win.isVisible(), false, "Electron fixture remains hidden throughout");
    report.requests = fixture.requests; report.externalRequestsBlocked = externalRequests; report.submitted = submitted;
    fs.writeFileSync(path.join(outputDir, `${testCase.id}.json`), JSON.stringify(report, null, 2));
    console.log(`Agent editor ${testCase.id}: manual input, preview, explicit save-and-switch, governed submit, no AI (hidden=true)`);
  } catch (error) {
    await screenshot(win, `${testCase.id}-failure.png`).catch(() => {});
    report.error = String(error.stack || error); report.requests = fixture.requests;
    report.state = await evaluate(win, "({errors:window.__testErrors,hash:location.hash,file:document.querySelector('#faDocs .fa-doc')?.dataset.file,text:document.querySelector('#faDocs .fa-ta')?.value})").catch(() => null);
    fs.writeFileSync(path.join(outputDir, `${testCase.id}-failure.json`), JSON.stringify(report, null, 2));
    throw error;
  } finally { win.destroy(); await fixture.close(); }
}

app.whenReady().then(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const cases = [
    { id: "delegation-premium", cat: "premium", width: 1440, delegation: true },
    { id: "delegation-anime", cat: "anime", width: 1280, height: 800, delegation: true },
    { id: "delegation-narrow", cat: "anime", width: 520, delegation: true },
    { id: "switch-premium", cat: "premium", width: 1440, switching: true },
    { id: "switch-anime", cat: "anime", width: 1280, height: 800, switching: true },
    { id: "switch-anime-narrow", cat: "anime", width: 520, switching: true },
    { id: "premium-electron", cat: "premium", width: 1440 },
    { id: "anime-web", cat: "anime", width: 1440, web: true },
    { id: "anime-laptop", cat: "anime", width: 1280, height: 800, web: true },
    { id: "premium-narrow", cat: "premium", width: 520, web: true },
    { id: "anime-narrow", cat: "anime", width: 520, web: true },
    { id: "premium-partial-retry", cat: "premium", width: 1440, partialFailure: true },
    { id: "anime-ai-races", cat: "anime", width: 1440, aiRaces: true },
    { id: "config-premium", cat: "premium", width: 1440, configEditor: true },
    { id: "config-anime", cat: "anime", width: 1280, height: 800, configEditor: true },
    { id: "config-narrow", cat: "anime", width: 520, configEditor: true },
  ];
  for (const testCase of cases.filter(item => (!process.argv.includes('--switching-only') || item.switching) && (!process.argv.includes('--delegation-only') || item.delegation))) await runCase(testCase);
  console.log(`Agent editor real-DOM smoke passed. Evidence: ${outputDir}`);
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
