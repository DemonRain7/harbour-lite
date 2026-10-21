// Real dashboard + synthetic HTTP/WS trace, in a hidden Electron window.
// No production API, model calls, credentials or user's Electron profile.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const fixture = require('../../tests/web/traceProgress.preview.cjs');
const output = path.resolve(__dirname, '../../assets/reports/trace-progress');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-trace-progress-')));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = (win, source) => win.webContents.executeJavaScript(source).catch(error => { throw new Error(`${source.slice(0, 140)}: ${error.message}`); });
async function wait(win, source, description) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await run(win, source)) return; await pause(50); }
  throw new Error(`Timed out: ${description}`);
}
async function screenshot(win, name) {
  await run(win, `document.querySelector('.tp-board').scrollIntoView({block:'center',behavior:'instant'})`);
  await pause(160);
  fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG());
}
async function captureReview(win, name, selector = '.tp-review') {
  await pause(400); // Theme/portrait and completed-conversation layout settle first.
  await run(win, `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);
  await pause(400);
  const rect = await run(win, `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x)),y:Math.max(0,Math.floor(r.y)),width:Math.min(Math.ceil(r.width),innerWidth-Math.max(0,Math.floor(r.x))),height:Math.min(Math.ceil(r.height),innerHeight-Math.max(0,Math.floor(r.y)))};})()`);
  fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage(rect)).toPNG());
}

app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  await new Promise(resolve => fixture.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${fixture.server.address().port}`;
  const win = new BrowserWindow({ show: false, width: 1440, height: 1180,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level === 3 && !message.includes('404')) errors.push(message); });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(url) && !/^(data:|blob:|about:)/.test(details.url) && !details.url.startsWith(url.replace('http:', 'ws:')) }));
  try {
    await win.loadURL(`${url}/#chat`);
    await wait(win, `document.querySelectorAll('.tp-lane').length===4`, 'dashboard live trace');
    await pause(700); // Dashboard boot loads the selected conversation asynchronously.
    await run(win, `window.traceHost=document.querySelector('.has-trace-progress'); window.lane=id=>traceHost.querySelector('[data-lane-id="'+id+'"]');void 0`);
    const noOpPaints = await run(win, `(() => {
      const original = traceRowsHtml; let paints = 0;
      traceRowsHtml = events => { paints++; return original(events); };
      try { for (let i=0;i<100;i++) syncLiveTraceRows(traceHost,state.chat.channelRuns['progress-fixture'].trace); }
      finally { traceRowsHtml = original; }
      return paints;
    })()`);
    assert.equal(noOpPaints, 1, '100 unchanged refreshes build the trace only once');
    assert.equal(await run(win, `lane('main').classList.contains('is-waiting')`), true);
    assert.equal(await run(win, `lane('planner').querySelector('.tp-settled b').textContent`), '已完成');
    assert.equal(await run(win, `lane('planner').querySelector('.tp-feed-window')===null`), true);
    await run(win, `window.mainRing=lane('main').querySelector('.tp-orbit'); window.mainGlow=lane('main').querySelector('.tp-orbit-column'); window.glowAnimation=mainGlow.getAnimations({subtree:true}).find(a=>a.animationName==='tp-breathe');void 0`);
    assert.equal(await run(win, '!!glowAnimation'), true, 'parent has a real breathing animation');

    const child = { agent: 'browser_controller', traceId: 'browser-1', parentTraceId: 'main-loop' };
    const send = (msg, data) => fixture.send(fixture.ev(msg, { ...child, ...data }));
    const progress = (status, extra) => send('workflow:progress', { workflow: 'novelai-generation', jobId: 'fixture-job', status, completed: 0, total: 2, ...extra });
    progress('planned'); progress('planned'); progress('running');
    await wait(win, `lane('browser-1').querySelector('.is-latest')?.textContent.includes('running')`, 'live workflow status');
    await pause(500);
    assert.equal(await run(win, `[...lane('browser-1').querySelectorAll('.tp-feed-line')].filter(e=>e.textContent.includes('novelai-generation')).length`), 1);
    assert.equal(await run(win, `mainRing===lane('main').querySelector('.tp-orbit') && glowAnimation===mainGlow.getAnimations({subtree:true}).find(a=>a.animationName==='tp-breathe')`), true, 'child updates preserve parent DOM and animation');
    await run(win, `window.feed=lane('browser-1').querySelector('.tp-feed-window'); window.latest=feed.lastElementChild; window.feedChanges=0; window.feedObserver=new MutationObserver(list=>feedChanges+=list.length); feedObserver.observe(feed,{subtree:true,childList:true,attributes:true});`);
    progress('running');
    await pause(250);
    assert.equal(await run(win, 'feedChanges'), 0, 'unchanged poll makes no visual mutation');
    assert.equal(await run(win, `feed.lastElementChild===latest`), true);
    await run(win, 'feedObserver.disconnect()');

    // All raw evidence is retained, even though the live progress slot coalesces.
    assert.equal(await run(win, `[...traceHost.querySelectorAll('.tp-raw-list .ct-ev')].filter(e=>e.textContent.includes('novelai-generation')).length`), 4);
    for (let i = 0; i < 10; i++) send('loop:tool-result', { tool: 'bash', resultPreview: `核对界面 ${i + 1} · fixture，未执行真实指令` });
    await wait(win, `Math.abs(feed.scrollTop-(feed.lastElementChild.offsetTop+feed.lastElementChild.offsetHeight/2-feed.clientHeight/2))<1 && feed.querySelector('.is-current')===feed.lastElementChild`, 'wheel reaches live center after burst');
    await wait(win, `(()=>{const current=feed.querySelector('.is-current'),r=current.getBoundingClientRect(),v=feed.getBoundingClientRect();return current===feed.lastElementChild && Math.abs(r.y+r.height/2-v.y-v.height/2)<2 && getComputedStyle(current).transform==='matrix(1, 0, 0, 1, 0, 0)';})()`, 'live wheel transition settles on newest row');
    const focus = await run(win, `(()=>{const current=feed.querySelector('.is-current'),r=current.getBoundingClientRect(),v=feed.getBoundingClientRect(),near=feed.querySelector('.is-near');return {distance:Math.abs(r.y+r.height/2-v.y-v.height/2),scale:getComputedStyle(current).transform,nearScale:getComputedStyle(near).transform,blur:getComputedStyle(near).filter};})()`);
    assert.ok(focus.distance < 2, `latest centered: ${JSON.stringify(focus)}`);
    assert.notEqual(focus.scale, focus.nearScale);
    assert.notEqual(focus.blur, 'none');
    await run(win, `feed.dispatchEvent(new WheelEvent('wheel',{deltaY:-80}));feed.dispatchEvent(new Event('scroll'));`);
    assert.equal(await run(win, `lane('browser-1').querySelector('.tp-feed-latest').hidden`), false, 'first smooth-scroll frame at the old bottom must not resume auto-follow');
    await run(win, `lane('browser-1').querySelector('.tp-feed-latest').click()`);
    await screenshot(win, 'elaina-live.png');
    await run(win, `feed.scrollIntoView({block:'center',behavior:'instant'})`);
    await pause(250);
    const point = await run(win, `(()=>{const r=feed.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    assert.equal(await run(win, `feed.contains(document.elementFromPoint(${point.x},${point.y}))`), true, 'native wheel targets the visible feed, not a moving parent');
    // Electron native wheel delta is opposite to DOM WheelEvent.deltaY.
    win.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaY: 80, deltaX: 0, canScroll: true });
    await wait(win, `feed.querySelector('.is-current')!==feed.lastElementChild && !lane('browser-1').querySelector('.tp-feed-latest').hidden`, 'native wheel browses real history');

    // Keyboard browsing keeps the current row centered with smaller real history
    // above and below. New events never yank the user back to the live edge.
    await run(win, `feed.focus();feed.dispatchEvent(new KeyboardEvent('keydown',{key:'PageUp',bubbles:true}));`);
    await pause(550);
    await run(win, `window.reading=feed.querySelector('.is-current').dataset.eventKey; window.readingTop=feed.scrollTop;`);
    send('loop:tool-result', { tool: 'bash', resultPreview: '新事件到达 · 保留阅读位置' });
    await pause(450);
    assert.equal(await run(win, `feed.querySelector('.is-current').dataset.eventKey===reading && Math.abs(feed.scrollTop-readingTop)<2`), true);
    assert.equal(await run(win, `lane('browser-1').querySelector('.tp-feed-latest').hidden`), false);
    await screenshot(win, 'elaina-history-wheel.png');
    await run(win, `lane('browser-1').querySelector('.tp-feed-latest').click()`);
    await pause(550);
    assert.equal(await run(win, `feed.querySelector('.is-current')===feed.lastElementChild`), true);

    // Todo hover/click and complete log retain focus, expansion and reading position.
    await run(win, `window.planButton=lane('main').querySelector('[data-tp-plan]');planButton.click();window.raw=traceHost.querySelector('.tp-raw');raw.open=true;window.log=traceHost.querySelector('.tp-raw-list');void 0`);
    await pause(100);
    await run(win, `log.scrollTop=20;window.logTop=log.scrollTop;log.focus()`);
    progress('running', { completed: 1 });
    await pause(450);
    assert.equal(await run(win, `raw.open && document.activeElement===log && log.scrollTop===logTop`), true);
    assert.equal(await run(win, `!document.querySelector('.tp-popover').hidden && planButton===lane('main').querySelector('[data-tp-plan]')`), true);
    await run(win, `window.chip=lane('main').querySelector('.tp-scope[data-scope="task"]');chip.focus();chip.click()`);
    fixture.progress.revision++;
    fixture.progress.steps[1].status = 'completed'; fixture.progress.steps[2].status = 'in_progress';
    fixture.send(fixture.ev('progress:updated', { progress: structuredClone(fixture.progress) }));
    await wait(win, `lane('main').querySelector('.tp-count').textContent==='2/4'`, 'structured plan updates the ring');
    assert.equal(await run(win, `document.activeElement===chip && document.querySelector('.tp-popover [data-status="in_progress"]').textContent.includes('验证两套主题')`), true, 'exact focused scope and open Todo survive plan updates');
    await run(win, `HarbourTrace.closePlan();raw.open=false;applyTheme('anime','aemeath','anime-snowfleece')`);
    await screenshot(win, 'aemeath-live.png');

    win.setContentSize(500, 980);
    await pause(450);
    assert.equal(await run(win, `[...traceHost.querySelectorAll('.tp-lane')].every(el=>el.scrollWidth<=el.clientWidth+1)`), true, 'narrow lanes have no horizontal overflow');
    await screenshot(win, 'aemeath-narrow.png');
    win.setContentSize(1440, 1180);

    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await pause(120);
    send('loop:tool-result', { tool: 'bash', resultPreview: '减少动态效果 · 新事件' });
    await pause(120);
    assert.equal(await run(win, `traceHost.getAnimations({subtree:true}).length`), 0, 'reduced motion disables CSS and arrival animations');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    win.webContents.debugger.detach();

    send('loop:end', { status: 'failed' });
    fixture.send(fixture.ev('loop:end', { agent: fixture.records.find(e => e.traceId === 'research-1').agent, traceId: 'research-1', parentTraceId: 'main-loop', status: 'interrupted' }));
    await wait(win, `lane('browser-1').querySelector('.tp-settled b')?.textContent==='执行失败'`, 'failed child settles');
    assert.equal(await run(win, `lane('research-1').querySelector('.tp-settled b').textContent`), '已中止');
    assert.equal(await run(win, `lane('main').classList.contains('is-waiting')`), false);
    await screenshot(win, 'settled-states.png');
    // End through the actual dashboard history route, not just a standalone mock.
    send('loop:final', { answerPreview: 'BROWSER_RESULT {"status":"completed","chargeState":"not_charged"}' });
    const completedChild = { agent: 'browser_controller', traceId: 'browser-2', parentTraceId: 'main-loop' };
    const sendCompleted = (msg, data) => fixture.send(fixture.ev(msg, { ...completedChild, ...data }));
    sendCompleted('loop:start');
    sendCompleted('loop:tool-calls', { step: 1, calls: ['opencli_browser'] });
    sendCompleted('loop:tool-result', { tool: 'opencli_browser_verify_artifact_metadata', resultPreview: '{"session":"harbour-fixture","artifact":{"width":1024,"height":1024},"note":"<img src=x onerror=alert(1)>"}' });
    sendCompleted('loop:thinking', { preview: 'Completed, artifact 1024x1024 verified. Cost evidence remains in the saved tool receipt.' });
    sendCompleted('loop:final', { answerPreview: 'BROWSER_RESULT {"status":"completed","chargeState":"not_charged","artifacts":[]}' });
    sendCompleted('loop:end', { status: 'completed' });
    await run(win, `fetch('/fixture/finish').then(r=>r.json())`);
    await wait(win, `document.querySelector('details.chat-trace')`, 'completed trace disclosure');
    assert.equal(await run(win, `document.querySelector('details.chat-trace .tp-board') === null`), true, 'closed reviews do not construct hidden trace DOM');
    await run(win, `document.querySelector('details.chat-trace').open=true;void 0`);
    await wait(win, `document.querySelector('.tp-review') && document.querySelectorAll('.tp-review-lane').length===5`, 'completed trace is rendered as review');
    await run(win, `window.traceHost=document.querySelector('.tp-review').closest('.has-trace-progress');traceHost.closest('details').open=true;void 0`);
    assert.equal(await run(win, `traceHost.querySelectorAll('.is-waiting,.is-indeterminate').length`), 0);
    assert.equal(await run(win, `traceHost.querySelector('.tp-feed-window')===null`), true, 'history has no truncated live wheel');
    assert.equal(await run(win, `lane('main').querySelector('.tp-review-status').textContent`), '已结束');
    assert.equal(await run(win, `lane('browser-1').querySelector('.tp-review-status').textContent`), '执行失败', 'model JSON cannot turn a failed run green');
    assert.equal(await run(win, `lane('browser-2').querySelector('.tp-review-status').textContent`), '已完成');
    assert.equal(await run(win, `lane('browser-2').querySelector('.tp-review-summary').textContent.includes('BROWSER_RESULT')`), false);
    assert.equal(await run(win, `getComputedStyle(traceHost.querySelector('.tp-board')).whiteSpace`), 'normal', 'chat bubble pre-wrap must not inflate template indentation');
    assert.equal(await run(win, `lane('browser-2').getBoundingClientRect().height<170`), true, 'finished worker has a compact review row');
    await run(win, `applyTheme('anime','elaina','anime-wisteria')`);
    await captureReview(win, 'review-elaina.png');

    await run(win, `window.reviewDetails=lane('browser-2').querySelector('.tp-review-details');reviewDetails.querySelector('summary').scrollIntoView({block:'center',behavior:'instant'});reviewDetails.querySelector('summary').focus();void 0`);
    win.webContents.focus();
    assert.equal(await run(win, `document.activeElement===reviewDetails.querySelector('summary')`), true, 'disclosure receives keyboard focus');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await wait(win, 'reviewDetails.open', 'keyboard opens the saved process');
    assert.equal(await run(win, `reviewDetails.querySelector('.tp-event-heading code').textContent`), 'opencli_browser_verify_artifact_metadata');
    await run(win, `window.receipt=reviewDetails.querySelector('.tp-record');receipt.querySelector('summary').click();void 0`);
    assert.equal(await run(win, `receipt.open && receipt.querySelector('pre').textContent.includes('\\n  "session"')`), true, 'receipt is formatted and can be unfolded');
    assert.equal(await run(win, `reviewDetails.querySelector('img')===null`), true);
    assert.equal(await run(win, `getComputedStyle(receipt.querySelector('pre')).whiteSpace`), 'pre-wrap');
    assert.equal(await run(win, `getComputedStyle(reviewDetails.querySelector('.tp-timeline')).maxHeight`), 'none', 'normal page flow, no nested scroll trap');
    await captureReview(win, 'review-browser-details.png', '[data-lane-id="browser-2"]');

    // History rerenders preserve expanded receipts, keyboard focus and the Todo.
    await run(win, `window.reviewEvents=normalizeStoredTrace(${JSON.stringify(fixture.records)},'main-elaina');receipt.querySelector('summary').focus();window.receiptFocus=document.activeElement;void 0`);
    await run(win, `reviewEvents.push({msg:'loop:tool-result',cls:'result',tag:'bash',text:'追加的已保存记录',agent:'main-elaina',traceId:'main-loop',at:Date.now()});HarbourTrace.mount(traceHost,reviewEvents,{agent:'main-elaina',live:false,rowsHtml:traceRowsHtml});void 0`);
    assert.equal(await run(win, `reviewDetails.open && receipt.open && receipt.isConnected && document.activeElement===receiptFocus`), true);
    assert.equal(await run(win, `HarbourTrace.mount(traceHost,reviewEvents,{agent:'main-elaina',live:false,rowsHtml:traceRowsHtml})`), false);
    await run(win, `lane('main').querySelector('[data-tp-plan]').scrollIntoView({block:'center',behavior:'instant'})`);
    await pause(250);
    await run(win, `lane('main').querySelector('[data-tp-plan]').click()`);
    assert.equal(await run(win, `!document.querySelector('.tp-popover').hidden && !!document.querySelector('.tp-popover [data-status="pending"]')`), true, 'review still exposes truthful unfinished Todo');
    await run(win, `HarbourTrace.closePlan();reviewDetails.open=false;applyTheme('anime','aemeath','anime-snowfleece')`);
    await captureReview(win, 'review-aemeath.png');

    // Use the existing portrait toggle so a small window has a readable chat
    // column, instead of testing an artificial 130px sliver beside the portrait.
    await run(win, `if(document.body.dataset.chatHeroHidden!=='true')document.querySelector('[data-hero-quick]').click()`);
    win.setContentSize(500, 1520);
    await pause(450);
    await run(win, `reviewDetails.open=true;void 0`);
    assert.equal(await run(win, `traceHost.clientWidth>=300 && traceHost.clientWidth<500`), true, 'actual narrow reading column');
    assert.equal(await run(win, `[...traceHost.querySelectorAll('.tp-review-lane,.tp-event,.tp-record pre')].every(el=>el.scrollWidth<=el.clientWidth+1)`), true, 'review and wrapped JSON fit a narrow conversation');
    await captureReview(win, 'review-narrow.png', '[data-lane-id="browser-2"]');
    win.setContentSize(1440, 1180);

    // Old records without terminal metadata keep a neutral status, not fake success.
    await run(win, `HarbourTrace.mount(traceHost,[{cls:'result',tag:'opencli_browser',text:'← {"session":"harbour-fixture…',agent:'browser_controller',depth:1},{cls:'thinking',tag:'THINK',text:'Completed, artifact verified.',agent:'browser_controller',depth:1},{cls:'final',tag:'FINAL',text:'BROWSER_RESULT {"status":"completed"}',agent:'browser_controller',depth:1}],{agent:'main-elaina',live:false,rowsHtml:traceRowsHtml});void 0`);
    assert.equal(await run(win, `lane('legacy:browser_controller').querySelector('.tp-review-status').textContent`), '已结束');
    assert.equal(await run(win, `traceHost.querySelectorAll('[data-outcome="success"]').length`), 0);
    await captureReview(win, 'review-legacy.png');
    await run(win, `applyTheme('premium','neutral','premium-tungsten')`);
    await captureReview(win, 'review-dark.png');
    assert.equal(await run(win, `getComputedStyle(traceHost.querySelector('.tp-review-summary')).color!==getComputedStyle(traceHost.querySelector('.tp-board')).backgroundColor`), true);
    assert.equal(win.isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('Trace DOM smoke passed: dashboard/WS, snapshots, breathing, scroll/focus/Todo, both personas, reduced motion; real history, readable receipts, keyboard disclosure, narrow layout, legacy and truthful terminal states.');
    console.log(`Screenshots: ${output}`);
  } catch (error) {
    console.error('Trace state:', await run(win, `({connected:window.traceHost?.isConnected,feed:document.querySelector('[data-lane-id="browser-1"] .tp-feed')?.textContent,run:state.chat.channelRuns['progress-fixture']?.trace.length})`).catch(() => null));
    await screenshot(win, 'failure.png').catch(() => {});
    console.error('Renderer errors:', errors);
    throw error;
  } finally {
    win.destroy();
    for (const ws of fixture.sockets.clients) ws.terminate();
    await new Promise(resolve => fixture.server.close(resolve));
  }
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
