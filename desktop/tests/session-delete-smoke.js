// Real, hidden Electron renderer against a disposable HTTP/WS fixture only.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFixture, waitFor, click, evaluate } = require('./session-browsing-smoke');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-session-delete-preview-'));
async function openMenu(win, id) {
  await evaluate(win, `document.querySelector('[data-session-actions="${id}"]').focus()`);
  await click(win, `[data-session-actions="${id}"]`);
  await waitFor(win, "!!document.querySelector('.cs-menu')", 'session menu opens');
}
async function requestDelete(win, id) {
  await openMenu(win, id);
  await click(win, `[data-session-delete="${id}"]`);
  await waitFor(win, "!!document.querySelector('.harbour-dialog-layer')", 'delete confirmation');
}
async function runCase(testCase) {
  const fixture = await startFixture(testCase);
  const win = new BrowserWindow({ show: false, width: testCase.width, height: 900,
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, cb) => cb({ cancel: /^https?:/.test(details.url) && !details.url.startsWith(fixture.base) }));
  const deletes = () => fixture.requests.filter(r => r.method === 'DELETE');
  try {
    await win.loadURL(fixture.base + '/#chat');
    await waitFor(win, "state.chat.sessionId==='A' && !!document.querySelector('[data-session-actions=\"B\"]')", 'loaded');
    await openMenu(win, 'B');
    assert.equal(await evaluate(win, "state.chat.sessionId"), 'A', 'opening menu never switches session');
    const bounds = await evaluate(win, `(() => {const r=document.querySelector('.cs-menu').getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight};})()`);
    assert.ok(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= bounds.w && bounds.bottom <= bounds.h);
    fs.writeFileSync(path.join(output, `${testCase.id}-menu.png`), (await win.webContents.capturePage()).toPNG());
    await evaluate(win, 'renderSessionList()');
    assert.equal(await evaluate(win, "document.querySelector('[data-session-actions=\"B\"]').getAttribute('aria-expanded')"), 'true', 'menu survives background rail refresh');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'DOWN' });
    await waitFor(win, "document.activeElement?.dataset.sessionDelete==='B'", 'arrow moves to delete');
    assert.equal(await evaluate(win, "document.activeElement.dataset.sessionDelete"), 'B');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESCAPE' });
    await waitFor(win, "!document.querySelector('.cs-menu')", 'Escape dismisses');
    assert.equal(await evaluate(win, 'document.activeElement.dataset.sessionActions'), 'B');
    await openMenu(win, 'B');
    await click(win, '#chatInput');
    await waitFor(win, "!document.querySelector('.cs-menu')", 'click outside closes without stale overlay');
    await openMenu(win, 'B');
    await click(win, '[data-session-rename="B"]');
    await waitFor(win, "document.activeElement.classList.contains('cs-rename-input')", 'rename still accessible');
    await evaluate(win, "document.activeElement.value='B · 新名字'; document.activeElement.form.requestSubmit()");
    await waitFor(win, "!document.querySelector('.renaming') && state.chat.sessions.find(s=>s.id==='B').title==='B · 新名字'", 'rename saved');
    await requestDelete(win, 'B');
    await waitFor(win, "document.activeElement.classList.contains('harbour-dialog-cancel')", 'safe default focus');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'RETURN' });
    await waitFor(win, "!document.querySelector('.harbour-dialog-layer')", 'Enter on cancel does not delete');
    assert.equal(deletes().length, 0);
    fixture.failNextDelete();
    await requestDelete(win, 'B');
    await click(win, '.harbour-dialog-confirm');
    await waitFor(win, '!state.chat.deletingSessionId', 'failure settled');
    assert.ok(fixture.sessions.B);
    assert.equal(await evaluate(win, "state.chat.sessionId==='A' && state.chat.sessions.some(s=>s.id==='B')"), true, 'failed DELETE preserves row and selection');
    // A live run may inspect/delete B without interrupting A or clearing A's draft.
    await evaluate(win, "state.chat.running=true; state.chat.activeRunId='retained-run'; document.querySelector('#chatInput').value='未发送的草稿'; state.chat.attachments=[{kind:'image',name:'draft.png',url:'/uploads/draft.png'}]; switchChatSession('B')");
    await waitFor(win, "state.chat.inspection?.session?.id==='B'", 'inspect B');
    await openMenu(win, 'A');
    assert.equal(await evaluate(win, "document.querySelector('[data-session-delete=\"A\"]').getAttribute('aria-disabled')"), 'true');
    await click(win, '[data-session-delete="A"]');
    assert.equal(deletes().length, 1, 'running target is protected without HTTP mutation');
    await requestDelete(win, 'B');
    await click(win, '.harbour-dialog-confirm');
    await waitFor(win, "!state.chat.deletingSessionId && !state.chat.sessions.some(s=>s.id==='B')", 'B deleted');
    assert.equal(await evaluate(win, "!state.chat.inspection && state.chat.sessionId==='A' && state.chat.running && state.chat.activeRunId==='retained-run' && state.chat.attachments[0].name==='draft.png' && document.querySelector('#chatInput').value==='未发送的草稿'"), true);
    assert.equal(fixture.requests.some(r=>r.path.endsWith('/abort')), false, 'delete never stops another run');
    await evaluate(win, "state.chat.running=false; state.chat.activeRunId=''; syncChatControlLocks(); setChatSendMode(false)");
    await requestDelete(win, 'A');
    await evaluate(win, "document.querySelectorAll('.toast').forEach(node=>node.remove()); new Promise(resolve=>setTimeout(resolve,350))");
    fs.writeFileSync(path.join(output, `${testCase.id}-confirm.png`), (await win.webContents.capturePage()).toPNG());
    await click(win, '.harbour-dialog-confirm');
    await waitFor(win, "!state.chat.deletingSessionId && !state.chat.sessionId && state.chat.landing", 'delete current returns welcome');
    assert.equal(await evaluate(win, "!!document.querySelector('.chat-welcome') && document.querySelector('#chatInput').value==='未发送的草稿' && state.chat.attachments.length===1"), true);
    assert.equal(fixture.requests.some(r=>r.path==='/api/conversations/new'), false, 'no automatic empty session');
    await evaluate(win, 'refreshSessionList()');
    assert.equal(await evaluate(win, 'state.chat.sessionId'), null, 'refresh does not adopt another active session');
    await requestDelete(win, 'Q');
    assert.match(await evaluate(win, "document.querySelector('.harbour-dialog-detail').textContent"), /不会撤回原渠道的消息/);
    // A remote task starts while the dialog is open: the second check prevents deletion.
    await evaluate(win, "state.chat.channelRuns.remote={sessionId:'Q'}");
    await click(win, '.harbour-dialog-confirm');
    await waitFor(win, "!document.querySelector('.harbour-dialog-layer')", 'race confirmation closes');
    assert.ok(fixture.sessions.Q);
    await evaluate(win, 'state.chat.channelRuns={}');
    await requestDelete(win, 'Q');
    await click(win, '.harbour-dialog-confirm');
    await waitFor(win, "!state.chat.deletingSessionId && !state.chat.sessions.some(s=>s.id==='Q')", 'QQ local memory deletion');
    await requestDelete(win, 'C');
    await click(win, '.harbour-dialog-confirm');
    await waitFor(win, "!state.chat.deletingSessionId && state.chat.sessions.length===0", 'last session deleted');
    assert.equal(await evaluate(win, "state.chat.landing && !state.chat.sessionId && !!document.querySelector('.chat-welcome') && !document.querySelector('[data-session-actions]')"), true);
    assert.deepEqual(await evaluate(win, 'window.__testErrors'), []);
    assert.equal(win.isVisible(), false);
    console.log(`PASS ${testCase.id}: menu, keyboard, rename, cancel, failure, live/inspection isolation, draft retention, welcome, mirror and race`);
  } finally { win.destroy(); await fixture.close(); }
}
app.whenReady().then(async () => {
  for (const testCase of [{ id:'elaina', cat:'anime', width:1440 }, { id:'premium', cat:'premium', width:1440 }, { id:'narrow', cat:'anime', width:520, web:true }]) await runCase(testCase);
  console.log(`Screenshots: ${output}`); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
