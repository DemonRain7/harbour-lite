// Shared Web/Electron renderer in an isolated, hidden Electron window. No live
// server, user data, models, image-generation service, or uploaded attachments.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createServer } = require("node:http");
const { WebSocketServer } = require("ws");
const root = path.resolve(__dirname, "../..");
const webRoot = path.join(root, "web");
const outputDir = path.join(root, "assets/reports/chat-hero");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "harbour-chat-hero-")));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.on("window-all-closed", () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (win, code) => win.webContents.executeJavaScript(code);
const agent = { name: "main-elaina", description: "立绘布局验收", taskType: "main", tools: [], skills: [] };
const model = { modelRef: "mock/fixture", model: "fixture", modelLabel: "界面测试 · 不调用模型", contextWindow: 128000 };
const session = { id: "hero-fixture", key: "web:default:main-elaina", channel: "web", agentName: agent.name,
  title: "聊天阅读空间", active: true, createdAt: "2026-09-07T12:00:00Z", lastMessageAt: "2026-09-07T12:00:00Z",
  messageCount: 2, contextTokens: 2400, contextWindow: 128000, contextLimit: 121600, compactAtTokens: 102400,
  source: { app: "web", locationLabel: "Main Chat", actorRole: "owner" }, traces: [],
  messages: [{ role: "user", content: "今天想整理一下读书笔记，帮我想个舒服的阅读计划吧。" },
    { role: "assistant", content: "可以先选一本想读的书，留出半小时慢慢看。遇到喜欢的段落，记下当时想到的事就好。\n\n阅读不必赶进度；把聊天立绘收起来，也能给笔记多留一点空间。" }] };

async function fixture() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (value, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/api/")) {
      requests.push({ path: url.pathname, method: req.method });
      if (req.method !== "GET") return json({ error: "UI fixture rejects writes" }, 405);
      if (url.pathname === "/api/state") return json({ defaultAgent: agent.name, agents: [agent], backends: { mock: true }, uptimeMs: 90000 });
      if (url.pathname === "/api/agents") return json({ agents: [agent] });
      if (url.pathname === "/api/agent-defaults") return json({ models: [model], agents: [{ name: agent.name, effectiveModelRef: model.modelRef, effectivePermissionMode: "dontAsk" }] });
      if (url.pathname === "/api/skills") return json({ skills: [] });
      if (url.pathname === "/api/asks") return json({ asks: [] });
      if (url.pathname === "/api/cowork/devices") return json({ devices: [] });
      if (url.pathname === "/api/conversations/explorer") return json({ enabled: true, sessions: [session] });
      if (url.pathname === "/api/conversations/hero-fixture") return json({ session });
      return json({});
    }
    const file = path.resolve(webRoot, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(webRoot + path.sep)) { res.writeHead(403); return res.end(); }
    try {
      let content = fs.readFileSync(file);
      if (path.basename(file) === "index.html") content = Buffer.from(content.toString().replace("<head>", `<head><script>
        if (!localStorage.getItem('harbour-theme')) {
          localStorage.setItem('harbour-theme-cat','anime');
          localStorage.setItem('harbour-theme-persona','elaina');
          localStorage.setItem('harbour-theme','anime-wisteria');
        }
        window.harbourDesktop={isElectron:true,petsEnabled:false};
        window.__testErrors=[];
        window.addEventListener('error',e=>{if(e.error)window.__testErrors.push(String(e.error.stack||e.message));});
        window.addEventListener('unhandledrejection',e=>window.__testErrors.push(String(e.reason)));
      </script>`));
      const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" }[path.extname(file)] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime }); res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  const ws = new WebSocketServer({ server, path: "/ws" });
  ws.on("connection", socket => socket.send(JSON.stringify({ __harbour: "activity-snapshot", activeRunIds: [], serverEpoch: "hero-fixture" })));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, requests,
    async close() { for (const socket of ws.clients) socket.terminate(); ws.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); } };
}
async function waitFor(win, expression) {
  for (let i = 0; i < 200; i++) { if (await evaluate(win, expression)) return; await pause(30); }
  throw new Error(`Timed out: ${expression}`);
}
async function click(win, selector) {
  win.webContents.invalidate();
  await pause(180); // Let popover/menu rAF positioning settle before a real hit test.
  const point = await evaluate(win, `(() => {const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing target: '+${JSON.stringify(selector)});const r=el.getBoundingClientRect();
    const actual=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),hit:el.contains(actual),actual:actual?.outerHTML.slice(0,300)};})()`);
  assert.equal(point.hit, true, `visible mouse target: ${selector} ${JSON.stringify(point)}`);
  for (const type of ["mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, x: point.x, y: point.y, button: "left", clickCount: 1 });
  await pause(30);
}
async function reload(win) {
  await new Promise(resolve => { win.webContents.once("did-finish-load", resolve); win.reload(); });
  await waitFor(win, "state.chat.sessionId==='hero-fixture' && !!document.querySelector('[data-hero-gallery]')");
  await pause(400);
}
async function key(win, keyCode) {
  win.webContents.sendInputEvent({ type: "keyDown", keyCode });
  // sendInputEvent does not synthesize the character event between keydown/up.
  // Chromium activates a focused native button on Enter's keypress.
  if (keyCode === "Enter") win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode });
  await pause(250);
}
async function shot(win, name) {
  win.webContents.invalidate(); await pause(80);
  fs.writeFileSync(path.join(outputDir, name + ".png"), (await win.webContents.capturePage()).toPNG());
}
async function metrics(win) {
  return evaluate(win, `(() => {
    const hero=document.querySelector('.harbour-hero'),content=document.querySelector('#content'),picker=document.querySelector('.chat-hero-picker');
    const popup=picker.querySelector('section').getBoundingClientRect(),css=getComputedStyle(hero);
    return {theme:document.body.dataset.theme,hidden:document.body.dataset.chatHeroHidden,
      padding:parseFloat(getComputedStyle(content).paddingRight),width:document.querySelector('.chat-workbench').getBoundingClientRect().width,
      opacity:parseFloat(css.opacity),visibility:css.visibility,src:hero.getAttribute('src'),naturalWidth:hero.naturalWidth,
      docWidth:document.documentElement.scrollWidth,viewport:innerWidth,viewportHeight:innerHeight,
      popup:{left:popup.left,right:popup.right,top:popup.top,bottom:popup.bottom},pickerVisible:!document.querySelector('#chatHeroControls').hidden,
      draft:document.querySelector('#chatInput').value,session:state.chat.sessionId,errors:window.__testErrors.slice()};})()`);
}
async function calendarLayout(win, label, keyboard = false) {
  const layout = await evaluate(win, `(() => {
    const links=document.querySelectorAll('.chat-calendar-link'),link=links[0],bar=document.querySelector('.chat-sessions'),
      actions=document.querySelector('.chat-tools'),tabs=document.querySelector('.chat-mode-tabs'),hero=document.querySelector('#chatHeroControls');
    const rect=el=>{if(!el)return null;const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    return {count:links.length,tag:link?.tagName,href:link?.getAttribute('href'),ariaLabel:link?.getAttribute('aria-label'),title:link?.title,
      text:link?.innerText.trim(),tabIndex:link?.tabIndex,svg:!!link?.querySelector('svg'),
      grouped:!!actions&&link?.parentElement===actions&&hero?.parentElement===actions,
      theme:document.body.dataset.theme,hidden:document.body.dataset.chatHeroHidden,viewport:innerWidth,docWidth:document.documentElement.scrollWidth,
      link:rect(link),bar:rect(bar),actions:rect(actions),tabs:rect(tabs),hero:hero&&!hero.hidden?rect(hero):null};})()`);
  const context = `${label}: ${JSON.stringify(layout)}`;
  assert.equal(layout.count, 1, `one calendar entry; ${context}`);
  assert.equal(layout.tag, "A", `calendar remains a semantic link; ${context}`);
  assert.equal(layout.href, "#calendar", `calendar route unchanged; ${context}`);
  assert.match(layout.ariaLabel || "", /日历|日程/, `calendar has an accessible name when icon-only; ${context}`);
  assert.ok(layout.svg && layout.tabIndex >= 0, `calendar keeps its accessible icon and native keyboard focus; ${context}`);
  assert.equal(layout.grouped, true, `calendar and portrait controls share the rail utility group; ${context}`);
  assert.ok(layout.docWidth <= layout.viewport + 1, `toolbar does not cause page overflow; ${context}`);
  assert.ok(layout.actions.right <= layout.bar.right + 1 && layout.actions.left >= layout.bar.left - 1, `utilities stay in the session rail; ${context}`);
  assert.ok(layout.link.height >= 32 && layout.link.width >= 32, `calendar remains a usable pointer target; ${context}`);
  const controls = [layout.tabs, layout.link, layout.hero].filter(Boolean);
  for (const control of controls) {
    assert.ok(control.left >= layout.bar.left - 1 && control.right <= layout.bar.right + 1 &&
      control.top >= layout.bar.top - 1 && control.bottom <= layout.bar.bottom + 1, `toolbar control contained after wrapping; ${context}`);
  }
  const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
  for (let a = 0; a < controls.length; a++) for (let b = a + 1; b < controls.length; b++) {
    assert.equal(overlaps(controls[a], controls[b]), false, `tabs/calendar/portrait controls do not overlap; ${context}`);
  }
  if (layout.hero && Math.abs(layout.link.top - layout.hero.top) <= 2) {
    assert.ok(layout.hero.left - layout.link.right >= -1 && layout.hero.left - layout.link.right <= 100,
      `calendar, environment and portrait controls form one compact group; ${context}`);
  }
  assert.ok(layout.link.width <= 42, `calendar stays icon-only in all layouts; ${context}`);
  if (keyboard) {
    const before = await evaluate(win, `(() => {
      document.querySelector('.chat-music-collapse').focus({preventScroll:true});
      return {hash:location.hash,session:state.chat.sessionId,draft:document.querySelector('#chatInput').value};})()`);
    await key(win, "Tab");
    const after = await evaluate(win, `({focused:document.activeElement===document.querySelector('.chat-calendar-link'),
      hash:location.hash,session:state.chat.sessionId,draft:document.querySelector('#chatInput').value})`);
    assert.equal(after.focused, true, `native Tab reaches calendar after music; ${context}`);
    assert.deepEqual({ hash: after.hash, session: after.session, draft: after.draft }, before,
      "focusing calendar does not navigate, change session or touch the draft");
  }
  return { label, ...layout };
}
async function theme(win, persona, variant) {
  await evaluate(win, `applyTheme(${JSON.stringify(persona === "neutral" ? "premium" : "anime")},${JSON.stringify(persona)},${JSON.stringify(variant)})`);
  await pause(500);
}
async function choose(win, value) {
  const selector = value === "auto" ? "[data-hero-reset]" : `[data-hero-choice="${value}"]`;
  await evaluate(win, `document.querySelector(${JSON.stringify(selector)}).click()`);
  await pause(350);
}
async function upload(win, { name = "local-test.png", color = "#d3b9ee", width = 32, invalid = false, bytes = 0, type = "image/png" } = {}) {
  await evaluate(win, `(async () => {
    const canvas=document.createElement('canvas');canvas.width=${width};canvas.height=48;
    const ctx=canvas.getContext('2d');ctx.fillStyle=${JSON.stringify(color)};ctx.fillRect(0,0,canvas.width,canvas.height);
    const blob=${bytes ? `new Blob([new Uint8Array(${bytes})])` : invalid ? "new Blob(['not an image'])" : "await new Promise(resolve=>canvas.toBlob(resolve))"};
    const file=new File([blob],${JSON.stringify(name)},{type:${JSON.stringify(type)}}),transfer=new DataTransfer();transfer.items.add(file);
    const input=document.querySelector('[data-hero-file]');input.dataset.persona=document.body.dataset.themePersona;input.files=transfer.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
}

app.whenReady().then(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const f = await fixture();
  const win = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: /^(https?|wss?):/.test(details.url) && new URL(details.url).host !== new URL(f.base).host }));
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const report = { themes: [], sizes: [], calendarLayouts: [] };
  try {
    await win.loadURL(f.base + "/#chat");
    await waitFor(win, "state.chat.sessionId==='hero-fixture' && !!document.querySelector('[data-hero-gallery]')");
    await evaluate(win, "document.fonts.ready"); await pause(500);
    await theme(win, "neutral", "premium-champagne");
    const premium = await metrics(win);
    assert.equal(premium.pickerVisible, false);
    report.calendarLayouts.push(await calendarLayout(win, "premium-wide", true));
    await shot(win, "calendar-premium-wide");
    for (const [persona, variant] of [["elaina", "anime-wisteria"], ["elaina", "anime-sky"], ["aemeath", "anime-snowfleece"], ["aemeath", "anime-stardust"], ["aemeath", "anime-neon"]]) {
      await theme(win, persona, variant);
      await evaluate(win, "document.querySelector('#chatInput').value='保留这份未发送草稿';window.__streamNode=document.querySelector('#chatStream');window.__streamText=__streamNode.innerText");
      const visible = await metrics(win);
      assert.equal(visible.pickerVisible, true); assert.equal(visible.hidden, "false"); assert.ok(visible.naturalWidth > 0);
      assert.ok(visible.width < premium.width - 100);
      assert.match(visible.src, new RegExp(variant.replace("anime-", "hero-")));
      report.calendarLayouts.push(await calendarLayout(win, `${variant}-visible`, variant === "anime-wisteria"));
      if (variant === "anime-wisteria") await shot(win, "calendar-anime-wide");
      await click(win, ".chat-hero-picker > summary");
      await click(win, "[data-hero-visible]");
      let mid;
      // Offscreen Chromium can delay its first paint. Sample real frames instead
      // of assuming the transition has started at a fixed wall-clock instant.
      for (let frame = 0; frame < 20; frame++) {
        win.webContents.invalidate(); await pause(20);
        mid = await metrics(win);
        if (mid.padding < visible.padding - 1 && mid.padding > premium.padding + 1) break;
      }
      await pause(450);
      const collapsed = await metrics(win);
      assert.ok(mid.padding > collapsed.padding + 1 && mid.padding < visible.padding - 1, `animated expansion: ${JSON.stringify({ visible, mid, collapsed })}`);
      assert.equal(collapsed.visibility, "hidden"); assert.equal(collapsed.opacity, 0);
      assert.ok(Math.abs(collapsed.width - premium.width) < 2, "hidden portrait uses premium chat width");
      assert.equal(collapsed.draft, "保留这份未发送草稿"); assert.equal(collapsed.session, "hero-fixture");
      assert.equal(await evaluate(win, "__streamNode===document.querySelector('#chatStream') && __streamText===__streamNode.innerText"), true, "no message DOM replacement");
      assert.ok(collapsed.docWidth <= collapsed.viewport + 1);
      report.calendarLayouts.push(await calendarLayout(win, `${variant}-hidden`));
      report.themes.push({ variant, visible, mid, collapsed });
      if (variant === "anime-wisteria") await shot(win, "elaina-hidden-settings");
      await click(win, "[data-hero-visible]"); await pause(500);
      await click(win, ".chat-hero-picker > summary");
    }
    console.log("All five anime themes: animated hide/show, premium-width chat, preserved session/draft/DOM");
    await theme(win, "elaina", "anime-wisteria");
    // The split button is a real one-click shortcut, not another settings step.
    await click(win, "[data-hero-quick]"); await pause(450);
    assert.equal((await metrics(win)).hidden, "true");
    assert.equal(await evaluate(win, "document.querySelector('.chat-hero-picker').open"), false);
    assert.equal(await evaluate(win, "document.querySelector('[data-hero-quick]').getAttribute('aria-pressed')"), "false");
    assert.equal((await metrics(win)).draft, "保留这份未发送草稿");
    assert.equal(await evaluate(win, "__streamNode===document.querySelector('#chatStream') && __streamText===__streamNode.innerText"), true);
    await click(win, "[data-hero-quick]"); await pause(450);
    assert.equal((await metrics(win)).hidden, "false");
    assert.equal(await evaluate(win, "document.querySelector('[data-hero-quick]').getAttribute('aria-pressed')"), "true");
    await click(win, ".chat-hero-picker > summary");
    await waitFor(win, "document.querySelector('.chat-hero-picker > summary').getAttribute('aria-expanded')==='true'");
    await evaluate(win, "window.__selectedTile=document.querySelector('[data-hero-choice=\"anime-sky\"]')");
    // Choose through the actual visual gallery, without the old nested select.
    await click(win, '[data-hero-choice="anime-sky"]');
    await waitFor(win, "document.querySelector('.harbour-hero').src.includes('hero-sky')");
    assert.equal(await evaluate(win, "document.activeElement===__selectedTile && __selectedTile===document.querySelector('[data-hero-choice=\"anime-sky\"]')"), true, "selection preserves the focused tile instead of rebuilding the gallery");
    assert.equal((await metrics(win)).theme, "anime-wisteria", "picture choice never changes palette");
    await click(win, "[data-hero-close]");
    assert.equal(await evaluate(win, "document.querySelector('.chat-hero-picker').open"), false);
    assert.equal(await evaluate(win, "document.activeElement.matches('.chat-hero-picker > summary')"), true);
    assert.equal(await evaluate(win, "document.querySelector('.chat-hero-picker > summary').getAttribute('aria-expanded')"), "false");
    await key(win, "Space");
    await waitFor(win, "document.querySelector('.chat-hero-picker').open");
    await click(win, "[data-hero-reset]");
    await waitFor(win, "document.querySelector('.harbour-hero').src.includes('hero-wisteria')");
    assert.equal(await evaluate(win, "document.querySelector('[data-hero-reset]').getAttribute('aria-pressed')"), "true");
    // Keyboard selection uses the same native button path as mouse selection.
    await evaluate(win, "document.querySelector('[data-hero-choice=\"anime-sky\"]').focus()");
    assert.equal(await evaluate(win, "document.activeElement.dataset.heroChoice"), "anime-sky");
    await key(win, "Enter");
    await waitFor(win, "document.querySelector('.harbour-hero').src.includes('hero-sky')");
    await click(win, "#chatInput");
    assert.equal(await evaluate(win, "document.querySelector('.chat-hero-picker').open"), false, "outside click dismisses without stealing input focus");
    assert.equal(await evaluate(win, "document.activeElement.id"), "chatInput");
    assert.equal((await metrics(win)).draft, "保留这份未发送草稿");
    console.log("Quick toggle, gallery focus, explicit close, keyboard selection and outside dismissal passed");
    await reload(win); await waitFor(win, "document.querySelector('.harbour-hero')?.src.includes('hero-sky') && document.querySelector('[data-hero-choice=\"anime-sky\"]')?.getAttribute('aria-pressed')==='true'");
    await click(win, ".chat-hero-picker > summary");
    await upload(win);
    await waitFor(win, "document.querySelector('[data-hero-message]').textContent.includes('已保存到本机')");
    assert.ok((await metrics(win)).src.startsWith("blob:")); assert.equal((await metrics(win)).naturalWidth, 32);
    await reload(win); await waitFor(win, "document.querySelector('.harbour-hero')?.src.startsWith('blob:') && document.querySelector('.harbour-hero').naturalWidth===32 && document.querySelector('[data-hero-choice=\"custom\"]')?.getAttribute('aria-pressed')==='true'");
    await click(win, ".chat-hero-picker > summary");
    const saved = (await metrics(win)).src;
    for (const file of [{ name: "bad.svg", type: "image/svg+xml", invalid: true }, { invalid: true }, { bytes: 10 * 1024 * 1024 + 1 }]) {
      await upload(win, file);
      await waitFor(win, "document.querySelector('[data-hero-message]').classList.contains('is-error') && !document.querySelector('[data-hero-upload]').disabled");
      assert.equal((await metrics(win)).src, saved, "invalid upload preserves previous image");
    }
    await theme(win, "aemeath", "anime-snowfleece");
    assert.ok(!(await metrics(win)).src.startsWith("blob:"), "separate persona image");
    await upload(win, { name: "aemeath-local.png", width: 40, color: "#f1c5d8" });
    await waitFor(win, "document.querySelector('.harbour-hero').naturalWidth===40");
    await theme(win, "elaina", "anime-sky");
    assert.equal((await metrics(win)).naturalWidth, 32, "custom image follows persona, not variant");
    // Hold only blob decoding to reproduce switching/resetting during an upload.
    await evaluate(win, `window.__nativeDecode=Image.prototype.decode;Image.prototype.decode=function(){if(!this.src.startsWith('blob:'))return __nativeDecode.call(this);return new Promise((resolve,reject)=>{window.__releaseImage=()=>__nativeDecode.call(this).then(resolve,reject);});};undefined`);
    await upload(win, { name: "discarded.png", width: 50 });
    await waitFor(win, "!!window.__releaseImage");
    await click(win, "[data-hero-reset]");
    await evaluate(win, "Image.prototype.decode=__nativeDecode;__releaseImage()");
    await pause(350); await choose(win, "custom");
    assert.equal((await metrics(win)).naturalWidth, 32, "reset cancels stale upload without replacing saved custom image");
    await theme(win, "aemeath", "anime-neon");
    assert.equal((await metrics(win)).naturalWidth, 40);
    await evaluate(win, "applyTheme('anime','elaina','anime-sky');applyTheme('anime','aemeath','anime-stardust');applyTheme('anime','elaina','anime-wisteria')");
    await pause(500); assert.equal((await metrics(win)).naturalWidth, 32, "latest theme wins rapid switching");
    await choose(win, "auto"); await click(win, ".chat-hero-picker > summary");
    await shot(win, "elaina-visible");
    await click(win, ".chat-hero-picker > summary"); await shot(win, "elaina-picture-picker");
    // Persist visibility across refresh, category and persona changes.
    await click(win, "[data-hero-visible]"); await pause(500);
    await reload(win); await waitFor(win, "document.querySelector('[data-hero-visible]') && document.body.dataset.chatHeroHidden==='true'");
    await theme(win, "neutral", "premium-tungsten"); assert.equal((await metrics(win)).pickerVisible, false);
    await theme(win, "aemeath", "anime-neon"); assert.equal((await metrics(win)).hidden, "true");
    await click(win, ".chat-hero-picker > summary"); await click(win, "[data-hero-visible]"); await pause(500);
    await choose(win, "auto"); await shot(win, "aemeath-picture-picker");
    console.log("Local image upload/validation/reload, per-persona storage, latest-choice races and global visibility passed");
    await click(win, ".chat-hero-picker > summary");
    for (const width of [900, 520, 360]) {
      win.setSize(width, 960); await pause(500);
      await click(win, ".chat-hero-picker > summary");
      const before = await metrics(win);
      report.calendarLayouts.push(await calendarLayout(win, `anime-${width}-visible`));
      assert.ok(before.popup.left >= 8 && before.popup.right <= width - 8 && before.popup.bottom <= 960, `popup within viewport at ${width}: ${JSON.stringify(before)}`);
      await click(win, "[data-hero-visible]"); await pause(500);
      const after = await metrics(win);
      report.calendarLayouts.push(await calendarLayout(win, `anime-${width}-hidden`));
      assert.ok((width <= 600 ? Math.abs(after.width - before.width) < 2 : after.width > before.width + 30) && after.docWidth <= width + 1,
        'narrow screens already reclaim portrait width without altering stored preferences');
      report.sizes.push({ width, before, after });
      await shot(win, `aemeath-${width}-hidden`);
      await click(win, "[data-hero-visible]"); await pause(500);
      await click(win, ".chat-hero-picker > summary");
      report.calendarLayouts.push(await calendarLayout(win, `anime-${width}-keyboard`, true));
      await shot(win, `calendar-anime-${width}`);
    }
    for (const [width, height] of [[900, 580], [360, 640]]) {
      win.setSize(width, height); await pause(500);
      await click(win, ".chat-hero-picker > summary"); await pause(250);
      const compact = await metrics(win);
      report.calendarLayouts.push(await calendarLayout(win, `anime-${width}x${height}-short`));
      assert.ok(compact.popup.left >= 8 && compact.popup.right <= compact.viewport - 8 && compact.popup.bottom <= compact.viewportHeight - 8,
        `short viewport contains panel: ${JSON.stringify(compact)}`);
      // Decoration has pointer-events:none, so ordinary hit tests alone can
      // miss a portrait visibly painting over the panel. Include it for this
      // stacking probe, then immediately restore the actual behavior.
      assert.equal(await evaluate(win, `(() => {
        const hero=document.querySelector('.harbour-hero'),close=document.querySelector('[data-hero-close]'),r=close.getBoundingClientRect();
        const saved=hero.style.pointerEvents;hero.style.pointerEvents='auto';
        try{return close.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}
        finally{hero.style.pointerEvents=saved;}
      })()`), true, "portrait cannot paint over the panel or its close control");
      const body = await evaluate(win, `(() => {const el=document.querySelector('.hero-picker-body'),r=el.getBoundingClientRect();return {scroll:el.scrollHeight,client:el.clientHeight,x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      assert.ok(body.scroll > body.client + 30, "only the panel body scrolls when vertical space is limited");
      // Electron's native wheel delta is opposite to DOM WheelEvent.deltaY.
      win.webContents.sendInputEvent({ type: "mouseWheel", x: Math.round(body.x), y: Math.round(body.y), deltaY: -800, canScroll: true });
      await waitFor(win, "document.querySelector('.hero-picker-body').scrollTop > 20"); await pause(350);
      // The appearance panel now includes backgrounds and can contain a second
      // row of saved portraits. Continue a real wheel scroll until upload is visible.
      for (let attempt = 0; attempt < 8; attempt++) {
        if (await evaluate(win, `(() => {const el=document.querySelector('[data-hero-upload]'),r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`)) break;
        win.webContents.sendInputEvent({ type: "mouseWheel", x: Math.round(body.x), y: Math.round(body.y), deltaY: -300, canScroll: true });
        await pause(250);
      }
      assert.equal(await evaluate(win, `(() => {const button=document.querySelector('[data-hero-upload]'),r=button.getBoundingClientRect();return button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`), true,
        "upload remains reachable by scrolling, not clipped below the window");
      await shot(win, `aemeath-${width}x${height}-scroll`);
      await click(win, "[data-hero-close]");
      assert.equal(await evaluate(win, "document.querySelector('.chat-hero-picker').open"), false);
      await key(win, "Space"); await waitFor(win, "document.querySelector('.chat-hero-picker').open");
      assert.equal(await evaluate(win, "document.querySelector('.hero-picker-body').scrollTop"), 0, "reopening begins at the current picture");
      await key(win, "Escape");
      assert.equal(await evaluate(win, "document.querySelector('.chat-hero-picker').open"), false);
      report.sizes.push({ width, height, compact, scrollBody: body });
    }
    console.log("Narrow/short windows: clamped panel, native wheel scrolling, reachable upload/close and reopen position passed");
    await theme(win, "neutral", "premium-champagne");
    for (const width of [900, 520, 360]) {
      win.setSize(width, 960); await pause(500);
      report.calendarLayouts.push(await calendarLayout(win, `premium-${width}`, true));
      await shot(win, `calendar-premium-${width}`);
    }
    await theme(win, "aemeath", "anime-neon");
    console.log("Calendar utility rail: compact grouping, premium/anime/hidden/narrow layout, semantic route and native Tab focus passed");
    win.setSize(1440, 960); await pause(500);
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await click(win, ".chat-hero-picker > summary"); await click(win, "[data-hero-visible]");
    assert.ok(parseFloat(await evaluate(win, "getComputedStyle(document.querySelector('#content')).transitionDuration")) <= .001, "reduced motion is immediate (shared CSS may use a minimal nonzero duration)");
    assert.equal((await metrics(win)).visibility, "hidden");
    await evaluate(win, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    assert.equal(await evaluate(win, "document.querySelector('.chat-hero-picker').open"), false);
    assert.equal(await evaluate(win, "document.activeElement.matches('.chat-hero-picker > summary')"), true);
    win.webContents.debugger.detach();
    assert.deepEqual((await metrics(win)).errors, []);
    assert.deepEqual(f.requests.filter(r => r.method !== "GET"), [], "appearance changes send no attachment, chat, or API writes");
    assert.deepEqual(f.requests.filter(r => r.path.startsWith("/api/calendar")), [], "calendar entry layout/focus never reads calendar data");
    report.requests = f.requests;
    fs.writeFileSync(path.join(outputDir, "results.json"), JSON.stringify(report, null, 2));
    console.log(`Chat portrait real-DOM tests passed. Evidence: ${outputDir}`);
  } catch (error) { await shot(win, "failure"); console.error(error); process.exitCode = 1; }
  finally { win.destroy(); await f.close(); app.exit(process.exitCode || 0); }
}).catch(error => { console.error(error); app.exit(1); });
