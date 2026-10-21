"use strict";
// Actual renderer, native geometry and production state publisher; only the
// music source is a fixture. No user's player, account, backend or model calls.
const { app, BrowserWindow, Menu, ipcMain, nativeImage } = require("electron");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm"), assert = require("node:assert/strict");
const { OrbController } = require("../companion/orb-controller");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-orb-lyrics-"));
const report = path.resolve(__dirname, "../../assets/reports/harbour-orb");
app.setPath("userData", temp); app.disableHardwareAcceleration();
const scale = Number(process.argv.find(a => a.startsWith("--scale="))?.split("=")[1] || 1);
app.commandLine.appendSwitch("force-device-scale-factor", String(scale)); app.on("window-all-closed", () => {});
let c, win, appearance = { theme: "anime-wisteria", persona: "elaina" }, reads = 0;
const errors = [], pushes = [], outbound = [];
const text = ["让晚风慢慢经过", "星光落在你的肩头", "把这一刻轻轻收藏", "我们沿着灯火向前走"];
const lines = text.map((text, index) => ({ index, startMs: index * 4000, endMs: (index + 1) * 4000 - 1, text, translation: index === 1 ? "Let this little moment stay." : "" }));
let raw = { provider: "folia", running: false, loaded: false, paused: true, currentTrackId: "", tracks: [], volume: 60,
  providerCapabilities: ["pause", "resume", "seek", "set_volume"], lyrics: { status: "empty", trackId: "", clockMs: 0, lines: [] } };
const sleep = ms => new Promise(r => setTimeout(r, ms)), js = code => win.webContents.executeJavaScript(code, true);
async function until(code) {
  for (let i = 0; i < 160; i++) { if (await js(code)) return; await sleep(25); }
  throw new Error(`Timeout ${code}\n${await js("document.body.innerText")}\n${errors}`);
}
async function click(selector) {
  await until(`innerWidth===${c.layout.bounds.width} && innerHeight===${c.layout.bounds.height}`);
  const point = await js(`(() => {const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('obscured '+${JSON.stringify(selector)});return {x,y}})()`);
  for (const type of ["mouseMove", "mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, ...point, button: "left", clickCount: 1 });
  await sleep(60);
}
async function capture(name) {
  await sleep(250); fs.mkdirSync(report, { recursive: true });
  fs.writeFileSync(path.join(report, `lyrics-${name}-${scale}x.png`), (await win.webContents.capturePage()).toPNG());
}
const source = fs.readFileSync(path.resolve(__dirname, "../main.js"), "utf8");
const production = { companionState: { setMusic: value => { production.companionState.music = value; } },
  orbSignals: { setMusic: value => c.signals.setMusic(value) }, get orb() { return c; }, remoteBridge: { updateMusicState: state => outbound.push(state) } };
vm.runInNewContext(source.slice(source.indexOf("function publishMusicState("), source.indexOf("function qqMusicStateForBridge(")) + ";this.publish=publishMusicState", production);
function emit(patch) { raw = { ...raw, ...patch, sampledAt: Date.now() }; production.publish(raw); }
const watchdog = setTimeout(() => { console.error("lyrics smoke timed out"); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  let area = { x: 0, y: 0, width: 1200, height: 900 };
  const screen = Object.assign(new EventEmitter(), { getPrimaryDisplay: () => ({ workArea: area }), getDisplayNearestPoint: () => ({ workArea: area }), getCursorScreenPoint: () => ({ x: -9999, y: -9999 }) });
  const asset = file => path.resolve(__dirname, "../../web/assets", file);
  c = new OrbController({ BrowserWindow, screen, Menu, hidden: true, dataDir: temp, deviceId: "lyrics-fixture",
    agents: [{ id: "elaina", agentName: "main-elaina", displayName: "伊蕾娜" }, { id: "aemeath", agentName: "main-aemeath", displayName: "爱弥斯" }],
    getConfig: () => ({ url: "http://127.0.0.1:1" }), getAppearance: () => appearance,
    getAvatar: agent => nativeImage.createFromPath(asset(agent === "main-elaina" ? "elaina-avatar.png" : "orb/aemeath-avatar-v4.png")).resize({ width: 128 }).toDataURL(),
    getPeekAtlas: agent => pathToFileURL(asset(`orb/${agent === "main-elaina" ? "elaina-peek-v3" : "aemeath-peek-v5"}.png`)).href,
    openDashboard() {}, openSettings() {}, openConversation() {},
    music: { getState: () => { reads++; return raw; }, execute: async cmd => emit({ paused: cmd.action === "pause", clockRunning: cmd.action === "resume" }), openFolia: async () => {} } });
  c.chat.load = async agent => c.chat.snapshot(agent); c.chat.refreshAsks = async () => {};
  c.chat.request = async () => { throw Error("No backend requests allowed"); };
  ipcMain.handle("desktop:orb-action", (event, input) => c.action(event, input));
  await c.start(); win = c.win;
  win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  const send = win.webContents.send.bind(win.webContents); win.webContents.send = (channel, ...data) => { pushes.push(channel); send(channel, ...data); };
  await c.expand(true, true); await until("!document.querySelector('#panel').hidden");
  await js("document.querySelector('#input').value='草稿不要丢失'");
  await click("#music"); await until("document.querySelector('[data-music=title]')?.textContent==='给此刻配一首歌'");
  // This enters from Folia, not a control response or a reopen/refresh.
  emit({ running: true, loaded: true, paused: false, clockRunning: true, durationMs: 16000, positionMs: 7000,
    currentTrackId: "fixture", tracks: [{ id: "fixture", title: "晚风手记", artist: "Harbour · 离线歌词样例" }],
    lyrics: { status: "ready", trackId: "fixture", clockMs: 7000, lines } });
  await until(`document.querySelector('[data-lyric=current]').textContent===${JSON.stringify(text[1])}`);
  await capture("panel");
  // Emulate foreground visibility for this intentionally hidden offscreen test.
  await js("Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'))");
  pushes.length = 0; await sleep(1100);
  await until("document.querySelector('[data-music=elapsed]').textContent==='0:08'");
  await until(`document.querySelector('[data-lyric=current]').textContent===${JSON.stringify(text[2])}`);
  assert.equal(pushes.includes("orb:state"), false, "clock never redraws chat");
  emit({ paused: true, clockRunning: false, positionMs: 4200, lyrics: { ...raw.lyrics, clockMs: 4200 } });
  await sleep(400); assert.equal(await js("document.querySelector('[data-music=elapsed]').textContent"), "0:04");
  await click("[data-music=lyric-overlay]"); await until("!document.querySelector('#lyricOverlay').hidden");
  assert.equal(JSON.parse(fs.readFileSync(c.statePath)).lyricOverlay, true);
  await capture("expanded");
  await c.expand(false); await until("document.querySelector('#panel').hidden && !document.querySelector('#lyricOverlay').hidden");
  assert.equal(c.musicWatching, false);
  emit({ paused: false, clockRunning: true, positionMs: 9000, lyrics: { ...raw.lyrics, clockMs: 9000 } });
  await until(`document.querySelector('#lyricLine').textContent===${JSON.stringify(text[2])}`);
  await capture("ball");
  for (const persona of ["elaina", "aemeath"]) {
    appearance = { persona, theme: persona === "elaina" ? "anime-wisteria" : "anime-snowfleece" }; c.syncAppearance(appearance);
    for (const edge of ["left", "right", "top", "bottom"]) {
      c.dock = edge; c.reflow(); await until(`document.body.dataset.docked==='true' && document.body.dataset.edge==='${edge}'`);
      await capture(`${persona}-${edge}`);
      assert.equal(await js("document.documentElement.scrollWidth<=innerWidth && document.documentElement.scrollHeight<=innerHeight"), true);
      const box = await js("JSON.parse(JSON.stringify(document.querySelector('#lyricOverlay').getBoundingClientRect()))");
      assert.ok(box.x >= 0 && box.y >= 0 && box.right <= c.layout.bounds.width + 1 && box.bottom <= c.layout.bounds.height + 1);
    }
  }
  appearance.theme = "premium-obsidian"; c.publish(); await capture("dark");
  await click("#lyricOpen"); await until("document.querySelector('[data-music=title]')?.textContent==='晚风手记'");
  area = { x: 0, y: 0, width: 360, height: 440 }; c.onDisplayChange(); await capture("small");
  emit({ currentTrackId: "second", tracks: [{ id: "second", title: "另一首歌" }] });
  await until("document.querySelector('[data-lyric=current]').textContent.includes('暂无歌词')");
  assert.doesNotMatch(await js("document.querySelector('#lyricLine').textContent"), new RegExp(text.join("|")));
  emit({ lyrics: { trackId: "second", status: "ready", clockMs: 2, lines: [{ index: 0, text: '<img src=x onerror=alert(1)>', startMs: 0, endMs: 9000 }] } });
  await until("document.querySelector('#lyricLine').textContent.includes('<img')");
  assert.equal(await js("document.querySelector('#lyricOverlay img')===null && document.querySelector('.music-lyrics img')===null"), true);
  emit({ loaded: false }); await until("document.querySelector('#lyricOverlay').hidden");
  emit({ loaded: true }); await until("!document.querySelector('#lyricOverlay').hidden");
  const snapshot = c.musicSnapshot(); win.webContents.send("orb:music", { ...snapshot, revision: snapshot.revision - 2, loaded: false });
  await sleep(100); assert.equal(await js("document.querySelector('#lyricOverlay').hidden"), false);
  await click("#lyricClose"); await until("document.querySelector('#lyricOverlay').hidden");
  assert.equal(JSON.parse(fs.readFileSync(c.statePath)).lyricOverlay, false);
  await click("#drawerClose");
  appearance = { persona: "elaina", theme: "anime-wisteria" }; c.syncAppearance(appearance);
  await until("document.body.dataset.persona==='main-elaina'");
  assert.equal(await js("document.querySelector('#input').value"), "草稿不要丢失");
  reads = 0; pushes.length = 0; emit({ positionMs: 13000 }); assert.equal(reads, 0); assert.equal(pushes.length, 0);
  assert.doesNotMatch(JSON.stringify(outbound), /lyrics|Let this little/); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, scale, liveFoliaPush: true, progressAndLyrics: true, docking: "both personas × 4 edges", staleSongCleared: true, hiddenReads: 0, report }));
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearTimeout(watchdog); c?.dispose(); app.exit(process.exitCode || 0); });
