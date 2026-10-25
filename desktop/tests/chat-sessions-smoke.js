// One actual Dashboard, two concurrent HTTP/WS fixture tasks. No real models or user data.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startFixture, waitFor, click, evaluate } = require('./session-browsing-smoke');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'assets/reports/chat-sessions');
fs.mkdirSync(output, { recursive: true });
let fixture, win;
app.whenReady().then(async () => {
  for (const theme of ['anime', 'premium']) {
    fixture = await startFixture({ cat: theme, web: true, parallel: true });
    win = new BrowserWindow({ show: false, width: 1440, height: 960,
      webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    let popups = 0;
    win.webContents.setWindowOpenHandler(() => { popups++; return { action: 'deny' }; });
    win.webContents.session.webRequest.onBeforeRequest((details, cb) => cb({ cancel: /^https?:/.test(details.url) && !details.url.startsWith(fixture.base) }));
    const send = async text => {
      await evaluate(win, `document.querySelector('#chatInput').value=${JSON.stringify(text)}`);
      await click(win, '#chatSend');
      await waitFor(win, 'state.chat.running && !!state.chat.activeRunId', 'local execution submitted');
      const id = await evaluate(win, 'state.chat.activeRunId');
      for (let i = 0; !fixture.parallelRuns.has(id) && i < 150; i++) await new Promise(r => setTimeout(r, 30));
      assert.ok(fixture.parallelRuns.has(id)); return id;
    };
    const select = async id => {
      await click(win, `[data-session-switch="${id}"]`);
      await waitFor(win, `state.chat.sessionId===${JSON.stringify(id)} && !state.chat.switchingSession && !state.chat.inspection`, 'selected exact writable session');
    };
    await win.loadURL(fixture.base + '/#chat?session=A&agent=main-elaina');
    await waitFor(win, 'state.chat.sessionId==="A" && !routePending', 'A loaded');
    const a = await send('A PARALLEL INPUT');
    await evaluate(win, `document.querySelector('#chatInput').value='A UNSENT DRAFT'; state.chat.attachments=[{kind:'image',name:'A-DRAFT.png',url:'/uploads/A.png'}];renderChatAttachments()`);
    await click(win, '#chatNewSession');
    await waitFor(win, 'state.chat.sessionId==="N1" && !state.chat.switchingSession', 'plus created a session in this page');
    assert.equal(popups, 0); assert.equal(fixture.active.size, 1);
    assert.equal(fixture.requests.filter(r => r.path === '/api/conversations/new').length, 1);
    assert.equal(fixture.requests.filter(r => r.path === '/api/run').length, 1);
    assert.equal(await evaluate(win, 'state.chat.messages.length===0 && !state.chat.running && !state.chat.intakeRunning && !state.chat.attachments.length && !document.querySelector("#chatInput").value'), true);
    assert.match(win.webContents.getURL(), /session=N1/);
    const b = await send('B PARALLEL INPUT');
    assert.equal(fixture.active.size, 2);
    await evaluate(win, `document.querySelector('#chatInput').value='B UNSENT DRAFT'`);
    fixture.emit({ runId: a, agent: 'main-elaina', msg: 'loop:thinking', preview: 'A BACKGROUND TRACE' });
    fixture.emit({ runId: b, agent: 'main-elaina', msg: 'loop:thinking', preview: 'B FOREGROUND TRACE' });
    await waitFor(win, 'state.chat.trace.some(e=>e.text.includes("B FOREGROUND TRACE"))', 'B trace');
    assert.equal(await evaluate(win, 'state.chat.trace.some(e=>e.text.includes("A BACKGROUND TRACE"))'), false);
    await waitFor(win, 'document.querySelector("#chatStream").innerText.includes("B PARALLEL INPUT")', 'B is actually rendered');
    await new Promise(resolve => setTimeout(resolve, 250)); // let the hidden compositor paint the checked DOM
    fs.writeFileSync(path.join(output, `${theme}-parallel.png`), (await win.webContents.capturePage()).toPNG());

    await select('A');
    assert.equal(await evaluate(win, 'document.querySelector("#chatInput").value'), 'A UNSENT DRAFT');
    assert.equal(await evaluate(win, 'state.chat.attachments[0].name'), 'A-DRAFT.png');
    await waitFor(win, 'document.querySelector("#chatStream").innerText.includes("A BACKGROUND TRACE")', 'A live history restored');
    assert.doesNotMatch(await evaluate(win, 'document.querySelector("#chatStream").innerText'), /B PARALLEL INPUT|B FOREGROUND TRACE/);
    // The footer stops the visible run, not the last locally submitted task (B).
    await click(win, '#chatStop');
    await waitFor(win, 'document.querySelector("#chatStream").innerText.includes("A STOPPED ONLY")', 'A stopped and saved');
    assert.equal(fixture.parallelRuns.get(b).status, 'running');
    const stops = fixture.requests.filter(r => r.path.endsWith('/abort'));
    assert.equal(stops.length, 1); assert.equal(stops[0].body.sessionId, 'A');
    await select('N1');
    assert.equal(await evaluate(win, 'document.querySelector("#chatInput").value'), 'B UNSENT DRAFT');
    assert.equal(await evaluate(win, 'state.chat.attachments.length'), 0);
    // A settles while another live view is selected; no stale local cleanup may steal it.
    await new Promise(r => setTimeout(r, 3300));
    assert.equal(await evaluate(win, 'state.chat.sessionId'), 'N1');
    assert.equal(fixture.parallelRuns.get(b).status, 'running');
    assert.equal(await evaluate(win, 'document.querySelector("#chatInput").value'), 'B UNSENT DRAFT');
    fixture.finishParallel(b);
    await waitFor(win, 'document.querySelector("#chatStream").innerText.includes("N1 FINISHED ONLY")', 'B final belongs to B');
    assert.doesNotMatch(await evaluate(win, 'document.querySelector("#chatStream").innerText'), /A PARALLEL INPUT|A STOPPED ONLY/);
    await win.reload();
    await waitFor(win, 'state.chat.sessionId==="N1" && !routePending && document.querySelector("#chatStream").innerText.includes("N1 FINISHED ONLY")', 'refresh retains B without replay');
    assert.equal(fixture.requests.filter(r => r.path === '/api/run').length, 2);
    await select('Q');
    assert.equal(await evaluate(win, 'state.chat.readOnlyMirror && document.querySelector("#chatInput").disabled'), true);
    await click(win, '#chatNewSession');
    await waitFor(win, 'state.chat.sessionId==="N2" && !state.chat.switchingSession && !state.chat.readOnlyMirror', 'plus leaves mirror for fresh Web session');
    await click(win, '#chatNewWindow'); assert.equal(popups, 1, 'explicit window action retained');
    assert.equal(fixture.requests.filter(r => r.path === '/api/conversations/new').length, 2, 'window action itself never creates a session');
    assert.deepEqual(await evaluate(win, 'window.__testErrors'), []);
    win.destroy(); win = null; await fixture.close(); fixture = null;
  }
  console.log('PASS real same-page UI: + creates without popup, concurrent tasks, exact traces/replies/STOP, drafts, refresh and mirror boundaries; Anime + Premium; no models');
}).catch(async error => {
  console.error(error); process.exitCode = 1;
  if (win && !win.isDestroyed()) console.error(await evaluate(win, `({session:state.chat.sessionId,running:state.chat.running,intake:state.chat.intakeRunning,errors:window.__testErrors,text:document.querySelector('#content').innerText.slice(-4000)})`));
}).finally(async () => {
  if (win && !win.isDestroyed()) win.destroy();
  await fixture?.close(); app.exit(process.exitCode || 0);
});
