// Actual dashboard DOM + HTTP/WS in hidden Electron. Isolated fixtures only:
// no real Harbour server, models, desktop workers, Chrome, or user conversations.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createServer } = require("node:http");
const { WebSocketServer } = require("ws");
const root = path.resolve(__dirname, "../..");
const webRoot = path.join(root, "web");
const outputDir = path.join(root, "assets/reports/session-browsing");
app.setPath("userData", fs.mkdtempSync(path.join(process.env.HARBOUR_CHAT_TEST_ROOT || os.tmpdir(), "harbour-session-browsing-")));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("force-device-scale-factor", process.argv.find(value => value.startsWith('--scale='))?.slice(8) || "1");
app.on("window-all-closed", () => {});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (win, script) => win.webContents.executeJavaScript(script);
const agent = { name: "main-elaina", description: "会话切换测试角色", taskType: "main", permissionMode: "dontAsk", tools: [], skills: [], contextBudget: "auto" };
const model = { modelRef: "mock/fixture", model: "测试模型", modelName: "fixture", modelLabel: "测试模型", providerLabel: "Fixture", backendKind: "claude-agent", contextWindow: 1000000, defaultEffort: "medium", supportedEfforts: ["low", "medium", "high"], effortOptions: ["low", "medium", "high"].map((effort) => ({ effort })) };
const smallModel = { ...model, modelRef: "mock/small", model: "32K 测试模型", modelName: "small", modelLabel: "32K 测试模型", contextWindow: 32000 };
const key = "web:default:main-elaina";
function contextPolicy(chosen = model) {
  return { contextWindow: chosen.contextWindow, contextBudget: chosen.contextWindow, contextLimit: chosen.contextWindow * .95,
    contextBudgetMode: "auto", configuredContextBudget: null, reservedOutputTokens: chosen.contextWindow * .05,
    compactAtTokens: chosen.contextWindow * .8, compactRequestedTokens: chosen.contextWindow * .8, compactClamped: false, compactSource: "window-ratio",
    contextWindowSource: "catalog", contextModelRef: chosen.modelRef, modelRef: chosen.modelRef, systemTokens: 4000, toolTokens: 2000, bodyTokens: 34000 };
}
function makeSession(id, channel = "web") {
  return { id, key: channel === "web" ? key : "qq:fixture", channel, agentName: agent.name,
    title: { A: "A · 正在执行的设计任务", B: "B · 另一段历史会话", C: "C · 慢速响应竞态", Q: "QQ · 实时镜像" }[id],
    active: id === "A", readOnlyMirror: channel !== "web", messageCount: 2,
    createdAt: "2026-09-05T12:00:00.000Z", lastMessageAt: "2026-09-05T12:00:00.000Z",
    compactions: 0, contextTokens: id === "A" ? 40000 : 4320, ...contextPolicy(),
    permissionMode: "dontAsk", reasoningEffort: "high", checkpoint: null, goal: null,
    source: { app: channel, locationLabel: channel === "web" ? "Main Chat" : "QQ 私聊", accountLabel: "测试频道", actorRole: "owner" },
    messages: [{ role: "user", content: `${id} ONLY QUESTION · 这条问题只属于 ${id} 会话。` }, { role: "assistant", content: `${id} ONLY ANSWER · 原任务与浏览记录互不影响。` }], traces: [] };
}
async function startFixture(testCase) {
  const sessions = Object.fromEntries(["A", "B", "C", "Q"].map((id) => [id, makeSession(id, id === "Q" ? "qq" : "web")]));
  if (testCase.persona === 'aemeath') for (const id of ['A', 'B', 'C']) {
    Object.assign(sessions[id], { agentName: 'main-aemeath', key: 'web:default:main-aemeath' });
  }
  sessions.X = { ...makeSession("X", "qq"), agentName: "main-aemeath", key: "qq:aemeath", title: "爱弥斯 · 另一只桌宠的回复" };
  sessions.O = { ...makeSession("O"), agentName: "main-aemeath", key: "web:orb:0123456789abcdef:main-aemeath", title: "爱弥斯 · 悬浮助手会话", active: false };
  if (process.argv.includes("--orb")) sessions.W = { ...makeSession("W"), agentName: "main-aemeath", key: "web:default:main-aemeath", title: "爱弥斯 · Main Chat 共用会话", active: false };
  const requests = [], active = new Map();
  const queueEdit = process.argv.includes('--queue-edit');
  const chatShortcuts = process.argv.includes('--chat-shortcuts');
  let lostReceipt = false;
  let inputRevision = 1, inputRows = queueEdit ? ['image', 'layout', 'music', 'followup'].map((id, i) => ({ id, revision: 1, updatedAt: 1, state: 'waiting', mode: i === 3 ? 'steer' : 'queue',
    canWithdraw: true, canSteer: i !== 3, messages: [{ input: ['这张图的构图想改一下，其他细节保持不变。', '页面希望更简洁自然，稍后再检查一遍整体布局。', '加一个音乐控制入口，播放、暂停和切歌都方便一点。', '再补充一个要求：颜色跟随当前角色主题。'][i],
      ...(i === 0 ? { attachments: [{ kind: 'image', url: '/uploads/fixture.png', name: 'fixture.png' }] } : {}) }] })) : [];
  let heldRun = null;
  const parallelRuns = new Map();
  let newSessionNumber = 0;
  function finishParallel(runId, stopped = false) {
    const run = parallelRuns.get(runId); assert.ok(run); assert.equal(run.status, 'running');
    run.status = 'settled';
    const session = sessions[run.body.session.id];
    run.answer = `${session.id} ${stopped ? 'STOPPED' : 'FINISHED'} ONLY`;
    session.messages.push({ role: 'user', content: run.body.input }, { role: 'assistant', content: run.answer });
    session.messageCount = session.messages.length;
    active.delete(runId);
    emit({ __harbour: 'channel-activity', phase: stopped ? 'cancelled' : 'complete', runId, agent: run.body.agent, sessionId: session.id, source: { platform: 'web' } });
  }
  let rejectNextPatch = false;
  let rejectNextDelete = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (value, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/api/")) {
      let body = {};
      if (req.method !== "GET") { const chunks = []; for await (const chunk of req) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
      requests.push({ method: req.method, path: url.pathname, body });
      if ((queueEdit || chatShortcuts) && /^\/api\/conversations\/A\/inputs$/.test(url.pathname)) {
        if (req.method === 'GET') return json({ revision: inputRevision, mode: 'steer', busy: true, records: inputRows });
        if (req.method === 'PATCH' && body.action === 'withdraw') {
          const row = inputRows.find(r => r.id === body.id); assert.ok(row); assert.equal(body.revision, row.revision);
          inputRows = inputRows.filter(r => r !== row); inputRevision++;
          return json({ ok: true, id: row.id, state: 'withdrawn', mode: row.mode, messages: row.messages });
        }
        if (req.method === 'POST') {
          assert.match(body.clientMessageId, /^web-/); inputRevision++;
          if (!inputRows.some(r => r.id === body.clientMessageId)) inputRows.push({ id: body.clientMessageId, revision: 1, updatedAt: inputRevision, state: 'waiting', mode: body.mode || 'queue', canWithdraw: true, canSteer: true,
            messages: [{ input: body.input.replace(/^\/queue\s*/, ''), attachments: body.attachments }] });
          if (chatShortcuts && body.input === '回执丢失' && !lostReceipt) { lostReceipt = true; return json({error:'receipt lost'}, 503); }
          return json({ id: body.clientMessageId, state: 'waiting', mode: body.mode || 'queue' }, 202);
        }
      }
      if (url.pathname === "/api/agents") return json({ agents: [agent, { ...agent, name: "main-aemeath" }] });
      if (url.pathname === "/api/state") return json({ defaultAgent: agent.name, agents: [agent], backends: { mock: true }, uptimeMs: 90000 });
      if (url.pathname === "/api/skills") return json({ skills: [] });
      if (url.pathname === "/api/agent-defaults") return json({ models: [model, smallModel,
        ...(process.argv.includes('--run-picker') ? Array.from({ length: 10 }, (_, i) => ({ ...model, modelRef: `mock/search-${i}`, modelLabel: `检索示例 ${i + 1}`, connectionLabel: '搜索测试连接' })) : []),
      ], agents: [{ name: agent.name, effectiveModelRef: model.modelRef, effectivePermissionMode: "dontAsk", defaultReasoningEffort: "high" }] });
      if (url.pathname === "/api/asks") return json({ asks: [] });
      if ((testCase.nativePreload || testCase.parallel) && url.pathname === "/api/conversations/new") {
        const id = testCase.parallel ? `N${++newSessionNumber}` : 'N';
        Object.values(sessions).forEach(s => { if (s.key === body.key) s.active = false; });
        const session = sessions[id] = { ...makeSession(id), key: body.key, agentName: body.agentName, title: "显式发送才创建", messages: [], messageCount: 0, active: true };
        return json({ session });
      }
      if (process.argv.includes('--chat-tools') && url.pathname === '/api/music/devices') return json({ devices: [{ id: 'fixture-player', label: '本机测试播放器', music: {
        provider: 'folia', connected: true, running: true, loaded: true, paused: false, currentTrackId: 'fixture-song',
        tracks: [{ id: 'fixture-song', title: '月光下的散步', artist: '隔离测试 · 无音频' }], playbackMode: 'off', playbackModeAvailable: true,
      } }] });
      if (url.pathname === "/api/cowork/devices") return json({ devices: [] });
      if (url.pathname === "/api/conversations/explorer") return json({ enabled: true, sessions: Object.values(sessions).filter(s => s.agentName === url.searchParams.get("agentName")) });
      if (url.pathname === "/api/conversations/annotate") {
        const session = sessions[body.id];
        if (!session || body.key !== session.key) return json({ error: "wrong annotation target" }, 400);
        if (body.plan) session.plan = body.plan;
        return json({ ok: true });
      }
      if (url.pathname === "/api/conversations/switch") {
        const session = sessions[body.id];
        if (!session || session.key !== body.key) return json({ error: "wrong switch target" }, 400);
        Object.values(sessions).forEach((s) => { if (s.key === session.key) s.active = s.id === session.id; });
        return json({ session });
      }
      if (url.pathname === "/api/run") {
        if (testCase.parallel) {
          assert.equal(req.headers.prefer, 'respond-async');
          assert.ok(sessions[body.session.id]);
          assert.ok(![...active.values()].some(r => r.sessionId === body.session.id));
          parallelRuns.set(body.runId, { body, status: 'running' });
          const activity = { __harbour: 'channel-activity', phase: 'running', canStop: true, runId: body.runId, agent: body.agent,
            sessionId: body.session.id, sessionKey: body.session.key, input: body.input, startedAt: Date.now(), source: { platform: 'web' } };
          active.set(body.runId, activity); emit(activity);
          return json({ accepted: true, status: 'running', runId: body.runId, sessionId: body.session.id }, 202);
        }
        assert.equal(heldRun, null, "at most one local run");
        heldRun = { res, body };
        const activity = { __harbour: "channel-activity", phase: "running", runId: body.runId, agent: body.agent,
          sessionId: body.session.id, sessionKey: body.session.key, input: body.input, startedAt: Date.now(), source: { platform: "web" } };
        active.set(body.runId, activity); emit(activity);
        return;
      }
      const parallelMatch = testCase.parallel && url.pathname.match(/^\/api\/runs\/([^/]+)(\/abort)?$/);
      if (parallelMatch) {
        const run = parallelRuns.get(parallelMatch[1]);
        if (!run) return json({ error: 'not found' }, 404);
        assert.equal(parallelMatch[2] ? body.sessionId : url.searchParams.get('sessionId'), run.body.session.id);
        if (parallelMatch[2]) { finishParallel(parallelMatch[1], true); return json({ ok: true, status: 'stopping', runId: parallelMatch[1], sessionId: run.body.session.id }, 202); }
        return json({ ...run, body: undefined, runId: parallelMatch[1], sessionId: run.body.session.id, session: sessions[run.body.session.id], recovered: true });
      }
      const channelStop = url.pathname.match(/^\/api\/channel-runs\/([^/]+)\/abort$/);
      if (channelStop) {
        const run = active.get(channelStop[1]);
        if (!run) return json({ error: "not active", code: "RUN_NOT_ACTIVE" }, 404);
        assert.equal(run.sessionId, body.sessionId, "channel stop must bind original session");
        const stopping = { ...run, phase: "stopping" };
        active.set(run.runId, stopping); emit(stopping);
        await sleep(900); // Response arrives after the user browses another session.
        return json({ ok: true, status: "stopping", runId: run.runId, sessionId: run.sessionId }, 202);
      }
      if (/^\/api\/runs\/[^/]+\/abort$/.test(url.pathname)) {
        assert.equal(url.pathname, `/api/runs/${heldRun?.body.runId}/abort`, "stop must target original submitted run");
        return json({ ok: true }); // Test explicitly releases the held response after inspecting another session.
      }
      const id = url.pathname.match(/^\/api\/conversations\/([ABCQXOW]|N\d*)$/)?.[1];
      if (id) {
        if (req.method === "DELETE") {
          if (rejectNextDelete) { rejectNextDelete = false; return json({ error: "fixture delete failed" }, 503); }
          if ([...active.values()].some(run => run.sessionId === id)) return json({ error: "任务仍在运行" }, 409);
          delete sessions[id];
          emit({ __harbour: 'session-deleted', id });
          return json({ removed: id });
        }
        if (!sessions[id]) return json({ error: "会话不存在" }, 404);
        if (req.method === "PATCH" && rejectNextPatch) { rejectNextPatch = false; return json({ error: "fixture save failed" }, 503); }
        if (req.method === "PATCH" && Object.hasOwn(body, "modelRef")) {
          await sleep(180); // Observe the save lock in the actual DOM before the response.
          const chosen = body.modelRef === smallModel.modelRef ? smallModel : model;
          Object.assign(sessions[id], contextPolicy(chosen));
        }
        if (req.method === "PATCH") for (const field of ["title", "modelRef", "reasoningEffort", "permissionMode"]) {
          if (Object.hasOwn(body, field)) sessions[id][field] = body[field];
        }
        if (id === "C") await sleep(250); // Deliberately slower than a later B request.
        return json({ session: sessions[id] });
      }
      return json({ error: `unknown fixture endpoint ${url.pathname}` }, 404);
    }
    const file = path.resolve(webRoot, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (queueEdit && url.pathname === '/uploads/fixture.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+c7X8AAAAASUVORK5CYII=', 'base64')); }
    if (!file.startsWith(webRoot + path.sep)) { res.writeHead(403); return res.end(); }
    try {
      let content = fs.readFileSync(file);
      if (path.basename(file) === "index.html") {
        const bootstrap = `<script>
          localStorage.setItem('harbour-chat-mode', 'main');
          localStorage.setItem('harbour-theme-cat', ${JSON.stringify(testCase.cat)});
          localStorage.setItem('harbour-theme-persona', ${JSON.stringify(testCase.persona || (testCase.cat === "anime" ? "elaina" : "neutral"))});
          localStorage.setItem('harbour-theme', ${JSON.stringify(testCase.theme || (testCase.cat === "anime" ? "anime-wisteria" : "premium-champagne"))});
          window.__testErrors=[];
          window.addEventListener('error', e => { if (e.error) window.__testErrors.push(String(e.error.stack || e.message)); });
          window.addEventListener('unhandledrejection', e => window.__testErrors.push(String(e.reason)));
          ${testCase.web || testCase.nativePreload ? "" : "window.harbourDesktop={isElectron:true,petsEnabled:false,onOpenConversation(handler){window.__openPetConversation=handler;}};"}
        </script>`;
        content = Buffer.from(content.toString().replace("<head>", "<head>" + bootstrap));
      }
      const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" }[path.extname(file)] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": type }); res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  function emit(event) { for (const socket of wss.clients) if (socket.readyState === 1) socket.send(JSON.stringify(event)); }
  wss.on("connection", (socket) => {
    for (const event of active.values()) socket.send(JSON.stringify(event));
    if (!testCase.holdSnapshot) socket.send(JSON.stringify({ __harbour: "activity-snapshot", activeRunIds: [...active.keys()], serverEpoch: "fixture-epoch" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, requests, sessions, emit, active, parallelRuns, finishParallel,
    failNextPatch: () => { rejectNextPatch = true; },
    failNextDelete: () => { rejectNextDelete = true; },
    runId: () => heldRun?.body.runId,
    disconnect: () => { for (const socket of wss.clients) socket.terminate(); },
    finish(kind = "success") {
      assert.ok(heldRun); const { res, body } = heldRun; heldRun = null;
      const session = sessions[body.session.id];
      const answer = kind === "success" ? "A RUN FINISHED · 后台结果只回原任务" : `${kind} ORIGINAL A`;
      session.messages.push({ role: "user", content: body.input }, { role: "assistant", content: answer });
      session.messageCount = session.messages.length;
      if (kind !== "success") session.checkpoint = { id: "fixture-checkpoint", status: "interrupted", originalInput: body.input, completed: 1, replayable: 1 };
      active.delete(body.runId);
      emit({ __harbour: "channel-activity", phase: kind === "success" ? "complete" : "cancelled", runId: body.runId, agent: body.agent, sessionId: session.id, source: { platform: "web" } });
      res.writeHead(kind === "success" ? 200 : 499, { "Content-Type": "application/json" });
      res.end(JSON.stringify(kind === "success" ? { answer, durationMs: 1234, session: { id: session.id, messageCount: session.messageCount, goal: null, checkpoint: null } } : { error: "stopped", code: "RUN_ABORTED", session: { checkpoint: session.checkpoint } }));
    },
    async close() { for (const socket of wss.clients) socket.terminate(); wss.close(); server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); },
  };
}
async function waitFor(win, expression, label) {
  for (let i = 0; i < 150; i++) { if (await evaluate(win, expression)) return; await sleep(30); }
  throw new Error(`timeout: ${label}`);
}
async function click(win, selector) {
  await evaluate(win, `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest'})`);
  await sleep(180);
  const point = await evaluate(win, `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('missing click target');
    const r=el.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
  const hit = await evaluate(win, `(() => { const el=document.querySelector(${JSON.stringify(selector)}), actual=document.elementFromPoint(${point.x},${point.y});
    const ancestors=[]; for(let p=el;p;p=p.parentElement) ancestors.push({tag:p.tagName,cls:p.className,inert:p.inert,pointer:getComputedStyle(p).pointerEvents});
    return {ok:!!actual?.closest(${JSON.stringify(selector)}),actual:actual?.outerHTML?.slice(0,300),ancestors}; })()`);
  assert.ok(hit.ok, `actual mouse target must be visible and unobscured: ${selector} ${JSON.stringify({point,...hit})}`);
  win.webContents.sendInputEvent({ type: "mouseMove", ...point });
  win.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
  await sleep(30);
}
async function view(win) {
  return evaluate(win, `({ session:state.chat.sessionId, viewed:viewedChatSessionId(), running:state.chat.running, runId:state.chat.activeRunId,
    stream:document.querySelector('#chatStream').innerText, trace:state.chat.trace.map(x=>x.text).join(String.fromCharCode(10)),
    draft:document.querySelector('#chatInput').value, attachments:state.chat.attachments.map(x=>x.name),
    inspection:!!state.chat.inspection, text:document.querySelector('#chatInspectionBar').innerText,
    inputVisible:!!document.querySelector('#chatInput').getClientRects().length,
    enterEnabled:!document.querySelector('[data-inspection-enter]')?.disabled,
    errors:window.__testErrors.slice() })`);
}
async function screenshot(win, name) {
  await evaluate(win, "document.querySelectorAll('.toast').forEach(el=>el.remove())");
  win.webContents.invalidate();
  await evaluate(win, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await sleep(80); fs.writeFileSync(path.join(outputDir, name), (await win.webContents.capturePage()).toPNG());
}
async function runCase(testCase) {
  const fixture = await startFixture(testCase);
  const win = new BrowserWindow({ show: false, width: testCase.width, height: 960, webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) && !details.url.startsWith(fixture.base) }));
  const report = { testCase, checkpoints: {} };
  try {
    await win.loadURL(fixture.base + "/#chat");
    await waitFor(win, "state.chat.sessionId==='A' && !!document.querySelector('#chatAgent') && !!document.querySelector('[data-session-switch=\"B\"]')", "dashboard ready");
    await evaluate(win, "document.fonts.ready");
    await waitFor(win, "document.querySelector('#chatModel')?.querySelector('option[value=\"mock/small\"]') && !document.querySelector('#chatModel').disabled", "models ready");
    if (process.argv.includes('--mirror-config')) {
      fixture.sessions.A.reasoningEffort = 'medium';
      Object.assign(fixture.sessions.Q, { modelRef: 'mock/small', reasoningEffort: 'high', permissionMode: 'plan' });
      await evaluate(win, "loadConversationMessages('A')");
      await waitFor(win, "document.querySelector('#chatRunPicker .rp-effort-label').textContent==='Medium'", 'Web medium baseline');
      await click(win, '[data-session-switch="Q"]');
      await waitFor(win, "state.chat.sessionId==='Q' && !state.chat.switchingSession && state.chat.readOnlyMirror", 'QQ mirror');
      assert.equal(await evaluate(win, "document.querySelector('#chatRunPicker .rp-effort-label').textContent"), 'High');
      assert.equal(await evaluate(win, "document.querySelector('#chatRunPicker .rp-model-label').textContent"), '32K 测试模型');
      assert.equal(await evaluate(win, "state.chat.permissionMode"), 'plan');
      assert.equal(await evaluate(win, "document.querySelector('#chatRunPicker .rp-model').disabled && document.querySelector('#chatInput').disabled"), true);
      await screenshot(win, `${testCase.id}-qq-high-mirror.png`);
      // A later channel-side configuration refresh must also update this mirror.
      fixture.sessions.Q.reasoningEffort = 'low';
      await evaluate(win, "loadConversationMessages('Q')");
      assert.equal(await evaluate(win, "document.querySelector('#chatRunPicker .rp-effort-label').textContent"), 'Low');
      await click(win, '[data-session-switch="A"]');
      await waitFor(win, "state.chat.sessionId==='A' && !state.chat.switchingSession && !state.chat.readOnlyMirror", 'return to Web');
      assert.equal(await evaluate(win, "document.querySelector('#chatRunPicker .rp-effort-label').textContent"), 'Medium');
      assert.equal(await evaluate(win, "state.chat.model"), 'mock/fixture');
      assert.equal(await evaluate(win, "state.chat.permissionMode"), 'dontAsk');
      assert.equal(fixture.requests.some(r => r.path === '/api/run' || r.method === 'PATCH'
        || r.path === '/api/conversations/switch' && r.body.id === 'Q'), false);
      assert.deepEqual(await evaluate(win, "window.__testErrors"), []);
      console.log(`MIRROR_CONFIG_OK ${testCase.id}: QQ high, live config refresh, Web medium restored, channel stays read-only; 0 models`);
      return;
    }
    if (process.argv.includes('--chat-tools')) {
      await require('./chat-tools-checks')({ win, fixture, evaluate, click, waitFor, screenshot, prefix: testCase.id });
      return;
    }
    if (process.argv.includes('--run-picker')) {
      await require('./run-picker-checks')({ win, fixture, evaluate, click, waitFor, screenshot, prefix: testCase.id });
      return;
    }
    if (process.argv.includes('--chat-shortcuts')) {
      await waitFor(win, "state.chat.intakeRunning", 'running intake available');
      const put = text => evaluate(win, `document.querySelector('#chatInput').value=${JSON.stringify(text)}`);
      const enter = keys => evaluate(win, `(() => {const e=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...${JSON.stringify(keys || {})}});document.querySelector('#chatInput').dispatchEvent(e);return e.defaultPrevented;})()`);
      const posts = () => fixture.requests.filter(r => r.method === 'POST' && r.path.endsWith('/inputs'));
      await put('输入法确认不发送');
      await evaluate(win, "document.querySelector('#chatInput').dispatchEvent(new CompositionEvent('compositionstart'))");
      assert.equal(await enter({ctrlKey:true}), false);
      await evaluate(win, "document.querySelector('#chatInput').dispatchEvent(new CompositionEvent('compositionend'))");
      for (const keys of [{shiftKey:true}, {shiftKey:true,ctrlKey:true}, {altKey:true}, {isComposing:true}, {keyCode:229}]) assert.equal(await enter(keys), false);
      assert.equal(await enter({repeat:true}), true); assert.equal(posts().length, 0);
      await put('换行');
      await evaluate(win, "document.querySelector('#chatInput').focus(); document.querySelector('#chatInput').setSelectionRange(2,2)");
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter',modifiers:['shift']});
      win.webContents.sendInputEvent({type:'char',keyCode:'\r',modifiers:['shift']});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter',modifiers:['shift']});
      await waitFor(win, "document.querySelector('#chatInput').value.includes('\\n')", 'native Shift+Enter newline');
      assert.equal(posts().length, 0);
      for (const [keys, mode] of [[{},'queue'], [{ctrlKey:true},'steer'], [{metaKey:true},'steer']]) {
        await put(`本条 ${mode}`); assert.equal(await enter(keys), true);
        await waitFor(win, "!state.chat.inputSending && document.querySelector('#chatInput').value===''");
        assert.equal(posts().at(-1).body.mode, mode);
        assert.equal(await evaluate(win, 'HarbourChatIntake.get().mode'), 'steer', 'shortcut does not modify saved default');
      }
      await evaluate(win, "state.chat.attachments=[{kind:'image',url:'/uploads/fixture.png',name:'fixture.png'}]");
      await put(''); await enter();
      await waitFor(win, "!state.chat.inputSending && state.chat.attachments.length===0", 'attachment-only queue');
      assert.equal(posts().at(-1).body.mode, 'queue'); assert.equal(posts().at(-1).body.attachments[0].url, '/uploads/fixture.png');
      await put('回执丢失'); await enter();
      await waitFor(win, "!state.chat.inputSending && !!state.chat.inputRequest", 'retain uncertain request');
      const original = posts().at(-1).body;
      await evaluate(win, 'state.chat.intakeRunning=false;state.chat.running=false');
      await enter({ctrlKey:true});
      await waitFor(win, "!state.chat.inputSending && !state.chat.inputRequest", 'same request reconciled after task ends');
      assert.deepEqual(posts().at(-1).body, original, 'retry freezes ID and mode even with another shortcut');
      assert.equal(fixture.requests.filter(r => r.path === '/api/run' || r.method === 'PATCH').length, 0);
      assert.deepEqual(await evaluate(win, 'window.__testErrors'), []);
      console.log(`CHAT_SHORTCUTS_OK ${testCase.id}: Enter queue, Ctrl/Cmd steer, native newline, IME/repeat, attachments, stable retry`);
      return;
    }
    if (process.argv.includes('--queue-edit')) {
      await waitFor(win, "document.querySelectorAll('.intake-row').length===4", 'compact queue visible');
      assert.equal(await evaluate(win, "document.documentElement.scrollWidth <= innerWidth+1"), true);
      await screenshot(win, `${testCase.id}-queue.png`);
      assert.equal(await evaluate(win, "document.querySelector('#chatStream').clientHeight>=100"), true, 'queue retains the existing minimum chat area even on narrow layouts');
      if (testCase.width < 600) assert.equal(await evaluate(win, "document.querySelector('.intake-queue').clientHeight<=84"), true, 'narrow queue shows two rows with remaining rows scrollable');
      await click(win, '[data-queue-action="edit"][data-id="image"]');
      await waitFor(win, "document.querySelector('#chatInput').value.startsWith('/queue ')", 'withdraw to real composer');
      assert.deepEqual(await evaluate(win, "state.chat.attachments.map(a=>a.name)"), ['fixture.png']);
      assert.equal(fixture.requests.some(r => r.path === '/api/run' || r.method === 'POST' && r.path.endsWith('/inputs')), false, 'withdraw never starts a model');
      await evaluate(win, "document.querySelector('#chatInput').value='/queue 改成正方形，其他细节保留'; document.querySelector('#chatInput').dispatchEvent(new Event('input',{bubbles:true}))");
      await click(win, '#chatSend');
      await waitFor(win, "!state.chat.inputSending && document.querySelector('#chatInput').value===''", 'explicit edited send confirmed');
      const posted = fixture.requests.filter(r => r.method === 'POST' && r.path.endsWith('/inputs'));
      assert.equal(posted.length, 1); assert.equal(posted[0].body.input, '/queue 改成正方形，其他细节保留');
      assert.equal(posted[0].body.attachments[0].url, '/uploads/fixture.png');
      assert.notEqual(posted[0].body.clientMessageId, 'image');
      assert.deepEqual(await evaluate(win, "state.chat.attachments"), []);
      assert.deepEqual(await evaluate(win, "window.__testErrors"), []);
      console.log(`QUEUE_EDIT_DASHBOARD_OK ${testCase.id}: actual row click, full draft/attachment restore, new send ID, no auto-run`);
      return;
    }
    const automaticText = await evaluate(win, "document.querySelector('#chatCtx').innerText");
    assert.match(automaticText, /≈40K \/ 950K/); assert.match(automaticText, /自动限额.*模型 1000K/);
    assert.match(automaticText, /压缩 800K.*窗口 80%/);
    assert.match(await evaluate(win, "document.querySelector('#chatCtx').title"), /输出预留.*50,000/);
    assert.equal(await evaluate(win, "document.documentElement.scrollWidth <= innerWidth + 1"), true, "auto context causes no horizontal page overflow");
    report.checkpoints.automaticContext = { contextText: automaticText, title: await evaluate(win, "document.querySelector('#chatCtx').title") };
    await screenshot(win, `${testCase.id}-context-auto.png`);
    await evaluate(win, "document.querySelector('#chatModel').value='mock/small'; document.querySelector('#chatModel').dispatchEvent(new Event('change',{bubbles:true}))");
    await waitFor(win, "!!state.chat.modelSaving", "model save lock");
    assert.equal(await evaluate(win, "document.querySelector('#chatSend').disabled && document.querySelector('#chatModel').disabled"), true);
    await waitFor(win, "!state.chat.modelSaving && document.querySelector('#chatCtx').innerText.includes('模型 32K')", "smaller context rendered");
    const contextText = await evaluate(win, "document.querySelector('#chatCtx').innerText");
    assert.match(contextText, /40K \/ 30\.4K/); assert.match(contextText, /下次发送先压缩/);
    assert.equal(await evaluate(win, "(() => { const ring=document.querySelector('#chatCtx').getBoundingClientRect(), bar=document.querySelector('.chat-toolbar').getBoundingClientRect(); return ring.left>=bar.left-1 && ring.right<=bar.right+1 && ring.top>=bar.top-1 && ring.bottom<=bar.bottom+1 && ring.width<=24; })()"), true, "compact context ring stays inside the bottom toolbar, including wrapped layouts");
    assert.equal(fixture.requests.filter((r) => r.path === '/api/run').length, 0, "changing context never auto-starts the model");
    report.checkpoints.modelSwitch = { contextText, title: await evaluate(win, "document.querySelector('#chatCtx').title") };
    await screenshot(win, `${testCase.id}-context-switch.png`);
    await evaluate(win, "document.querySelector('#chatModel').value='mock/fixture'; document.querySelector('#chatModel').dispatchEvent(new Event('change',{bubbles:true}))");
    await waitFor(win, "!state.chat.modelSaving && document.querySelector('#chatCtx').innerText.includes('模型 1000K')", "larger context restored");
    await evaluate(win, "document.querySelector('#chatInput').value='Start A fixture task'");
    await click(win, "#chatSend");
    await waitFor(win, "state.chat.running && state.chat.activeRunId", "run started");
    for (let i = 0; i < 100 && !fixture.runId(); i++) await sleep(20);
    const runId = fixture.runId(); assert.ok(runId);
    await evaluate(win, `document.querySelector('#chatInput').value='A UNSENT DRAFT'; state.chat.attachments=[{kind:'file',name:'A-draft.txt',url:'/uploads/A-draft.txt',mime:'text/plain'}]; renderChatAttachments();`);
    if (!testCase.web) {
      await waitFor(win, "typeof window.__openPetConversation==='function'", "notification receiver ready");
      await evaluate(win, "window.__openPetConversation({sessionId:'Q',agentName:'main-elaina'})");
      await waitFor(win, "state.chat.inspection?.session?.id==='Q'", "notification opens exact QQ session");
      await evaluate(win, "window.__openPetConversation({sessionId:'X',agentName:'main-aemeath'})");
      await waitFor(win, "state.chat.inspection?.session?.id==='X'", "another pet opens its own reply without changing running agent");
      assert.match((await view(win)).stream, /X ONLY ANSWER/);
      assert.equal(await evaluate(win, "state.chat.agent"), agent.name);
      await evaluate(win, "window.__openPetConversation({sessionId:'C',agentName:'main-elaina'}); window.__openPetConversation({sessionId:'Q',agentName:'main-elaina'})");
      await waitFor(win, "state.chat.inspection?.session?.id==='Q' && !desktopConversationOpening", "latest notification beats delayed response");
      const notified = await view(win);
      assert.equal(notified.runId, runId); assert.equal(notified.running, true);
      assert.equal(notified.session, "A"); assert.equal(notified.draft, "A UNSENT DRAFT");
      assert.deepEqual(notified.attachments, ["A-draft.txt"]);
      assert.equal(fixture.requests.filter(r => r.path.endsWith('/abort') || r.path === '/api/conversations/switch').length, 0);
      await click(win, '[data-inspection-return]');
    }
    if (testCase.cat === "anime") {
      await click(win, ".chat-hero-picker > summary");
      await click(win, "[data-hero-visible]"); await sleep(450);
      const decorated = await view(win);
      assert.equal(decorated.runId, runId); assert.equal(decorated.running, true);
      assert.equal(decorated.draft, "A UNSENT DRAFT"); assert.deepEqual(decorated.attachments, ["A-draft.txt"]);
      assert.equal(fixture.requests.filter(r => r.path === "/api/run").length, 1, "hiding artwork never restarts the run");
      assert.equal(fixture.requests.filter(r => r.path.endsWith("/abort")).length, 0, "hiding artwork never cancels the run");
      await click(win, "[data-hero-visible]"); await sleep(450);
      await click(win, ".chat-hero-picker > summary");
    }
    // Explicit notification inspection remains read-only; sidebar navigation is
    // now independently covered by chat-sessions-smoke's same-page concurrency.
    await evaluate(win, "inspectChatSession('B')");
    await waitFor(win, "state.chat.inspection?.session?.id==='B'", "B view");
    let current = await view(win);
    assert.equal(current.session, "A"); assert.equal(current.viewed, "B");
    assert.match(current.stream, /B ONLY ANSWER/); assert.doesNotMatch(current.stream, /A ONLY|Start A/);
    assert.equal(current.inputVisible, false); assert.equal(current.enterEnabled, false);
    assert.equal(current.draft, "A UNSENT DRAFT"); assert.deepEqual(current.attachments, ["A-draft.txt"]);
    assert.equal(fixture.requests.filter((r) => r.path === "/api/conversations/switch").length, 0);
    await evaluate(win, "executeChat(); requestChatStop();");
    assert.equal(fixture.requests.filter((r) => r.path === "/api/run").length, 1);
    assert.equal(fixture.requests.filter((r) => r.path.endsWith("/abort")).length, 0);
    fixture.emit({ __harbour: "channel-activity", phase: "running", runId: "other-web-client", agent: agent.name, sessionId: "A", sessionKey: key, source: { platform: "web" } });
    fixture.emit({ runId: "other-web-client", agent: agent.name, msg: "loop:thinking", preview: "FOREIGN TRACE" });
    fixture.emit({ runId, agent: agent.name, msg: "loop:thinking", preview: "LOCAL TRACE" });
    fixture.emit({ runId, agent: agent.name, msg: "plan:submitted", plan: { goal: "Plan for A", steps: [{ n: 1, agent: agent.name, task: "inspect" }] } });
    await waitFor(win, "state.chat.trace.some(x=>x.text.includes('LOCAL TRACE'))", "local trace while browsing");
    current = await view(win); assert.equal(current.runId, runId); assert.doesNotMatch(current.trace, /FOREIGN TRACE/); assert.doesNotMatch(current.stream, /LOCAL TRACE|FOREIGN TRACE/);
    report.checkpoints.browsing = current;
    await screenshot(win, `${testCase.id}-browsing.png`);

    await click(win, '[data-session-switch="C"]');
    await click(win, '[data-session-switch="B"]');
    await sleep(350);
    assert.equal((await view(win)).viewed, "B"); assert.match((await view(win)).stream, /B ONLY ANSWER/);
    await click(win, "[data-inspection-return]");
    current = await view(win); assert.equal(current.inspection, false); assert.match(current.stream, /LOCAL TRACE/); assert.equal(current.draft, "A UNSENT DRAFT");

    // A live QQ notification view gets only its own stream and stays read-only.
    await evaluate(win, "inspectChatSession('Q')");
    await waitFor(win, "state.chat.inspection?.session?.id==='Q'", "QQ view");
    const qq = { __harbour: "channel-activity", phase: "running", runId: "qq-run", agent: agent.name, sessionId: "Q", sessionKey: "qq:fixture", input: "QQ LIVE QUESTION", startedAt: Date.now(), source: { platform: "qq" } };
    fixture.active.set(qq.runId, qq); fixture.emit(qq);
    fixture.emit({ runId: qq.runId, agent: agent.name, msg: "loop:thinking", preview: "QQ LIVE TRACE" });
    await waitFor(win, "document.querySelector('#chatStream').innerText.includes('QQ LIVE TRACE')", "QQ trace updates");
    assert.doesNotMatch((await view(win)).stream, /LOCAL TRACE/);
    fixture.sessions.Q.messages.push({ role: "assistant", content: "QQ RESULT DELIVERED" });
    fixture.active.delete(qq.runId);
    fixture.emit({ ...qq, phase: "complete" });
    await waitFor(win, "document.querySelector('#chatStream').innerText.includes('QQ RESULT DELIVERED')", "QQ completion reload");
    assert.equal((await view(win)).runId, runId);

    // Channel stop is an explicit exception to mirror read-only mode. It must
    // coexist with a local Web run and another channel task, never steal either.
    const stoppedQQ = { ...qq, runId: "qq-stop", canStop: true, input: "QQ · 可中止的独立测试任务" };
    const parallelQQ = { ...qq, runId: "qq-parallel", canStop: true, input: "QQ · 同时运行的另一条任务" };
    for (const event of [stoppedQQ, parallelQQ]) { fixture.active.set(event.runId, event); fixture.emit(event); }
    await waitFor(win, "document.querySelectorAll('[data-channel-stop]').length===2", "two exact channel stop buttons");
    assert.equal((await view(win)).inputVisible, false, "browsing a mirror cannot expose the local composer");
    await screenshot(win, `${testCase.id}-qq-stop-button.png`);
    await click(win, '[data-channel-stop="qq-stop"]');
    await evaluate(win, "document.querySelector('[data-channel-stop=\"qq-stop\"]')?.click()");
    await waitFor(win, "state.chat.channelRuns['qq-stop'].stopping", "authoritative channel stop");
    assert.equal(await evaluate(win, "document.querySelector('[data-channel-stop=\"qq-stop\"]').disabled"), true);
    assert.equal(await evaluate(win, "document.querySelector('[data-channel-stop=\"qq-parallel\"]').disabled"), false);
    assert.equal(await evaluate(win, "(() => {const b=document.querySelector('[data-channel-stop=\"qq-stop\"]'),r=b.getBoundingClientRect(),p=b.closest('.chat-bubble').getBoundingClientRect();return r.width>40&&r.height>=28&&r.right<=p.right&&r.left>=p.left;})()"), true, "stop control fits its bubble at narrow widths");
    fixture.emit({ runId: stoppedQQ.runId, agent: agent.name, msg: "loop:thinking", preview: "late child cleanup trace" });
    await screenshot(win, `${testCase.id}-qq-stopping.png`);
    await click(win, '[data-session-switch="B"]');
    await waitFor(win, "!state.chat.channelRuns['qq-stop'].stopPending", "late stop HTTP response");
    assert.equal((await view(win)).viewed, "B"); assert.equal((await view(win)).runId, runId);
    assert.equal(fixture.requests.filter(r => r.path === '/api/channel-runs/qq-stop/abort').length, 1);
    assert.equal(fixture.requests.filter(r => r.path === '/api/runs/' + runId + '/abort').length, 0);
    fixture.disconnect();
    await waitFor(win, "state.connection.awaitingReconnectSnapshot", "stop connection interrupted");
    await waitFor(win, "!state.connection.awaitingReconnectSnapshot && state.ws?.readyState===1", "stop snapshot restored");
    await click(win, '[data-session-switch="Q"]');
    await waitFor(win, "document.querySelector('[data-channel-stop=\"qq-stop\"]')?.disabled", "reconnected stop stays disabled");
    assert.match(await evaluate(win, "document.querySelector('[data-channel-activity=\"qq-stop\"]').textContent"), /正在中止/);
    fixture.sessions.Q.messages.push({ role: "assistant", content: "QQ TASK STOPPED · 断点已保留", runRecord: { status: "interrupted" } });
    fixture.active.delete(stoppedQQ.runId); fixture.emit({ ...stoppedQQ, phase: "cancelled" });
    await waitFor(win, "document.querySelector('#chatStream').innerText.includes('QQ TASK STOPPED')", "channel cancelled record");
    assert.equal(await evaluate(win, "!!document.querySelector('[data-channel-stop=\"qq-stop\"]')"), false);
    assert.equal(await evaluate(win, "!!document.querySelector('[data-channel-stop=\"qq-parallel\"]')"), true);
    fixture.active.delete(parallelQQ.runId); fixture.emit({ ...parallelQQ, phase: "complete" });

    // Disconnect and reconnect while viewing B: never re-submit or steal the execution session.
    await click(win, '[data-session-switch="B"]');
    fixture.disconnect();
    await waitFor(win, "state.connection.awaitingReconnectSnapshot", "WS disconnected");
    await waitFor(win, "!state.connection.awaitingReconnectSnapshot && state.ws?.readyState===1", "WS reconciled");
    assert.equal((await view(win)).session, "A");
    assert.equal(fixture.requests.filter((r) => r.path === "/api/run").length, 1);
    fixture.finish();
    await waitFor(win, "!state.chat.running", "background completion");
    current = await view(win);
    assert.equal(current.viewed, "B"); assert.match(current.stream, /B ONLY ANSWER/); assert.doesNotMatch(current.stream, /A RUN FINISHED/);
    assert.equal(current.enterEnabled, true); assert.match(current.text, /本轮已结束/);
    for (const request of fixture.requests.filter((r) => r.path === "/api/conversations/annotate")) assert.equal(request.body.id, "A");
    report.checkpoints.completedInBackground = current;
    await click(win, "[data-inspection-enter]");
    await waitFor(win, "state.chat.sessionId==='B' && !state.chat.switchingSession", "enter B");
    current = await view(win); assert.equal(current.draft, ""); assert.deepEqual(current.attachments, []); assert.equal(current.inputVisible, true);
    await evaluate(win, "document.querySelector('#chatInput').value='B UNSENT DRAFT'");
    await click(win, '[data-session-switch="A"]');
    await waitFor(win, "state.chat.sessionId==='A' && !state.chat.switchingSession", "return to A after adoption");
    current = await view(win); assert.equal(current.draft, "A UNSENT DRAFT"); assert.deepEqual(current.attachments, ["A-draft.txt"]); assert.match(current.stream, /A RUN FINISHED/);

    // A second run: stop on the origin, browse during stop, then recover its checkpoint only in A.
    await evaluate(win, "document.querySelector('#chatInput').value='Second A cancellable task'; state.chat.attachments=[]; renderChatAttachments()");
    await click(win, "#chatSend");
    await waitFor(win, "state.chat.running", "second local run");
    for (let i = 0; i < 100 && !fixture.runId(); i++) await sleep(20);
    const stopId = fixture.runId(); assert.notEqual(stopId, runId);
    assert.equal(await evaluate(win, "document.querySelector('#chatSend').disabled"), false, "running task still permits sending supplements");
    await click(win, "#chatStop");
    await waitFor(win, "state.chat.stopping", "stopping");
    await evaluate(win, "inspectChatSession('B')");
    await waitFor(win, "state.chat.inspection?.session?.id==='B'", "view during stop");
    fixture.finish("cancelled");
    await waitFor(win, "!state.chat.running", "cancelled background");
    current = await view(win); assert.equal(current.viewed, "B"); assert.doesNotMatch(current.stream, /cancelled ORIGINAL A/);
    await click(win, "[data-inspection-return]");
    await waitFor(win, "state.chat.checkpoint?.id==='fixture-checkpoint'", "original checkpoint");
    assert.deepEqual(fixture.requests.filter((r) => r.path.endsWith("/abort")).map((r) => r.path), ['/api/channel-runs/qq-stop/abort', `/api/runs/${stopId}/abort`]);
    await screenshot(win, `${testCase.id}-returned.png`);
    report.checkpoints.returned = await view(win);
    // Also cover the ordinary mirror (no local run and no inspection overlay).
    await click(win, '[data-session-switch="Q"]');
    await waitFor(win, "state.chat.sessionId==='Q' && !state.chat.switchingSession", "direct channel mirror");
    assert.equal(await evaluate(win, "state.chat.readOnlyMirror && document.querySelector('#chatSend').disabled"), true);
    const directQQ = { ...qq, runId: "qq-direct", canStop: true, input: "QQ · 直接查看渠道会话时中止" };
    fixture.active.set(directQQ.runId, directQQ); fixture.emit(directQQ);
    await waitFor(win, "!!document.querySelector('[data-channel-stop=\"qq-direct\"]')", "direct mirror stop visible");
    await screenshot(win, `${testCase.id}-direct-channel-stop.png`);
    await click(win, '[data-channel-stop="qq-direct"]');
    await waitFor(win, "state.chat.channelRuns['qq-direct'].stopping && !state.chat.channelRuns['qq-direct'].stopPending", "direct mirror stop acknowledged");
    fixture.active.delete(directQQ.runId); fixture.emit({ ...directQQ, phase: "cancelled" });
    await waitFor(win, "!document.querySelector('[data-channel-stop=\"qq-direct\"]')", "direct mirror stop settled");
    assert.equal(fixture.requests.filter(r => r.path === '/api/channel-runs/qq-direct/abort').length, 1);
    assert.equal(fixture.requests.filter(r => r.path === '/api/run').length, 2, "channel stop never sends another model request");
    if (!testCase.web) {
      // Actual leave modal: the notification must not bypass an unsaved file editor.
      await evaluate(win, "location.hash='capabilities'");
      await waitFor(win, "activePanelHash==='capabilities' && !routePending", "leave chat for document page");
      await evaluate(win, `window.__notificationDraft=true; window.__removeNotificationEditor=editorLeave.register('notification-fixture', {label:'未保存文件',isActive:()=>true,isDirty:()=>window.__notificationDraft,discard:()=>{window.__notificationDraft=false;return true;}}); window.__openPetConversation({sessionId:'B',agentName:'main-elaina'});`);
      await waitFor(win, "!!document.querySelector('[data-dialog-kind=\"leave\"]')", "notification displays unsaved changes prompt");
      await click(win, '[data-dialog-kind="leave"] .harbour-dialog-cancel');
      await waitFor(win, "!desktopConversationOpening", "stay on editor");
      assert.equal(await evaluate(win, "activePanelHash==='capabilities' && window.__notificationDraft"), true);
      await evaluate(win, "window.__openPetConversation({sessionId:'B',agentName:'main-elaina'})");
      await waitFor(win, "!!document.querySelector('[data-dialog-kind=\"leave\"]')", "notification can be retried");
      await click(win, '[data-dialog-kind="leave"] .harbour-dialog-discard');
      // Idle editable Web notifications now adopt the shared session; only busy
      // tasks/channel mirrors use inspection (covered above and by --orb).
      await waitFor(win, "state.chat.sessionId==='B' && !state.chat.inspection && !desktopConversationOpening", "discard then adopt exact editable notification session");
      assert.equal(await evaluate(win, "activePanelHash.startsWith('chat?') && !window.__notificationDraft"), true);
      await evaluate(win, "window.__removeNotificationEditor()");
      await click(win, '#navBack');
      await waitFor(win, "activePanelHash==='capabilities' && !routePending && !pageHistoryBusy", "native Electron page history back");
      await click(win, '#navForward');
      await waitFor(win, "activePanelHash.startsWith('chat?') && !routePending && !pageHistoryBusy", "native Electron page history forward");
      assert.equal(await evaluate(win, "state.chat.sessionId==='B'"), true, 'page history keeps the selected conversation');
    }
    assert.deepEqual((await view(win)).errors, []);
    assert.deepEqual(report.checkpoints.returned.errors, []);
    assert.equal(win.isVisible(), false);
    report.requests = fixture.requests;
    fs.writeFileSync(path.join(outputDir, `${testCase.id}.json`), JSON.stringify(report, null, 2));
    console.log(`Session browsing ${testCase.id} passed: live run, history/QQ views, races, WS reconnect, completion, exact stop and drafts (hidden=true)`);
  } catch (error) {
    await screenshot(win, `${testCase.id}-failure.png`).catch(() => {});
    report.error = String(error.stack || error); report.state = await view(win).catch(() => null); report.requests = fixture.requests;
    fs.writeFileSync(path.join(outputDir, `${testCase.id}-failure.json`), JSON.stringify(report, null, 2));
    throw error;
  } finally { win.destroy(); await fixture.close(); }
}
module.exports = { startFixture, waitFor, click, evaluate };
// Electron's main-module loader need not populate require.main like Node does.
// Keep direct smoke runs executable while allowing the startup fixture to import.
if (require.main === module || path.resolve(process.argv[1] || "") === __filename) app.whenReady().then(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  if (process.argv.includes("--orb")) {
    const fixture = await startFixture({ cat: "anime" });
    const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true } });
    win.webContents.session.webRequest.onBeforeRequest((details, cb) => cb({ cancel: /^https?:/.test(details.url) && !details.url.startsWith(fixture.base) }));
    try {
      await win.loadURL(fixture.base + "/#chat");
      await waitFor(win, "state.chat.sessionId==='A' && typeof window.__openPetConversation==='function'", "initial Elaina Main");
      await evaluate(win, "document.querySelector('#chatInput').value='Elaina unsent draft'; window.__openPetConversation({sessionId:'O',agentName:'main-aemeath'})");
      await waitFor(win, "state.chat.sessionId==='O' && !desktopConversationOpening", "orb adopts exact Aemeath session");
      assert.equal(await evaluate(win, "state.chat.agent==='main-aemeath' && !state.chat.inspection && !state.chat.readOnlyMirror && document.body.dataset.themePersona==='aemeath'"), true);
      assert.match(await evaluate(win, "document.querySelector('#chatStream').innerText"), /O ONLY ANSWER/);
      assert.equal(fixture.requests.some(r => r.path === "/api/run"), false, "opening a session does not call any model");
      await screenshot(win, "orb-aemeath-handoff.png");
      await evaluate(win, "window.__openPetConversation({sessionId:'W',agentName:'main-aemeath'})");
      await waitFor(win, "state.chat.sessionId==='W' && !desktopConversationOpening", "shared Web history is editable, not a separate mirror");
      assert.equal(await evaluate(win, "!state.chat.inspection && !state.chat.readOnlyMirror && document.body.dataset.themePersona==='aemeath'"), true);
      // During a task, the same notification only inspects: it cannot replace the run.
      await evaluate(win, "state.chat.running=true; state.chat.activeRunId='retained-run'; window.__openPetConversation({sessionId:'Q',agentName:'main-elaina'})");
      await waitFor(win, "state.chat.inspection?.session.id==='Q' && !desktopConversationOpening", "busy handoff stays read-only");
      assert.equal(await evaluate(win, "state.chat.agent==='main-aemeath' && state.chat.sessionId==='W' && state.chat.activeRunId==='retained-run'"), true);
      assert.deepEqual(await evaluate(win, "window.__testErrors"), []);
      console.log("ORB_DASHBOARD_HANDOFF_OK: correct Main, theme, exact editable session, busy-task isolation; 0 models");
    } finally { win.destroy(); await fixture.close(); }
    app.quit(); return;
  }
  for (const testCase of [{ id: "premium-electron", cat: "premium", width: 1440 }, { id: "anime-web", cat: "anime", width: 1440, web: true }, { id: "anime-narrow", cat: "anime", width: process.argv.includes('--run-picker') || process.argv.includes('--chat-tools') ? 390 : 520, web: true },
    ...(process.argv.includes('--chat-tools') ? [{ id: 'aemeath-web', cat: 'anime', persona: 'aemeath', theme: 'anime-snowfleece', width: 1440, web: true }, { id: 'premium-dark', cat: 'premium', theme: 'premium-tungsten', width: 1440 }, { id: 'anime-medium', cat: 'anime', width: 1000, web: true }] : []),
  ]) await runCase(testCase);
  console.log(`Real-DOM session browsing smoke passed. Evidence: ${outputDir}`); app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
