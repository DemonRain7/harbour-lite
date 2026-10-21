"use strict";
// Isolated real Electron renderer/IPC; mocked music owner, no user playback/API/model.
const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const { EventEmitter } = require("node:events");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), assert = require("node:assert/strict");
const { OrbController } = require("../companion/orb-controller");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-orb-music-"));
const report = path.resolve(__dirname, "../../assets/reports/harbour-orb");
app.setPath("userData", temp); app.disableHardwareAcceleration(); app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.on("window-all-closed", () => {});
let c, win, fail = false, hold, finish, theme = "anime-wisteria", musicReads = 0;
const errors = [], commands = [], pushes = [];
const caps = ["play", "pause", "resume", "next", "previous", "seek", "set_volume", "set_playback_mode"];
const tracks = [{ id: "local:D:/fixture/summer.wav", title: "不散的夏之灯", artist: "夏夜 · 陪你一起听" },
  { id: "2", title: "风经过的地方", artist: "Harbour" }, { id: "3", title: "这里是一首非常非常长的曲名需要渐隐避免挤压播放按钮", artist: "星光下的旅人" }];
let music = { provider: "folia", running: false, connected: true, loaded: false, paused: true, tracks: [], volume: 70, providerCapabilities: caps };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = code => win.webContents.executeJavaScript(code, true);
const sel = name => `[data-music="${name}"]`;
async function until(code) {
  for (let i = 0; i < 160; i++) { if (await js(code)) return; await sleep(25); }
  throw new Error(`Timed out: ${code}\n${await js("document.body.innerText")}\n${errors}`);
}
async function click(selector) {
  await until(`innerWidth===${c.layout.bounds.width} && innerHeight===${c.layout.bounds.height}`);
  const point = await js(`(() => {const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!el.contains(document.elementFromPoint(x,y))) throw Error('Obscured: '+${JSON.stringify(selector)});return {x,y}})()`);
  for (const type of ["mouseMove", "mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, ...point, button: "left", clickCount: 1 });
  await sleep(80);
}
async function capture(name) {
  await sleep(220); fs.mkdirSync(report, { recursive: true });
  fs.writeFileSync(path.join(report, `${name}.png`), (await win.webContents.capturePage()).toPNG());
}
function publish(patch) { music = { ...music, ...patch }; c.signals.setMusic(music); c.publishMusic(); }
async function changeRange(name, value) {
  await js(`(() => {const e=document.querySelector(${JSON.stringify(sel(name))});e.value=${value};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until("!document.querySelector('.orb-music-player').matches('[aria-busy=true]')");
}
const watchdog = setTimeout(() => { console.error("orb music smoke timed out"); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  const screen = Object.assign(new EventEmitter(), { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 850 } }),
    getDisplayNearestPoint: () => screen.getPrimaryDisplay(), getCursorScreenPoint: () => ({ x: -9999, y: -9999 }) });
  c = new OrbController({ BrowserWindow, screen, Menu, hidden: true, dataDir: temp, deviceId: "music-fixture",
    agents: [{ agentName: "main-elaina", displayName: "伊蕾娜" }, { agentName: "main-aemeath", displayName: "爱弥斯" }],
    getConfig: () => ({ url: "http://127.0.0.1:1" }), getAppearance: () => ({ theme, persona: c?.agent === "main-aemeath" ? "aemeath" : "elaina" }),
    openDashboard() {}, openSettings() {}, openConversation() {}, music: {
      getState: () => { musicReads++; return music; },
      openFolia: async () => { commands.push({ action: "open", player: "folia" }); publish({ provider: "folia", running: true, loaded: false, connected: true }); },
      execute: async cmd => {
        commands.push(cmd);
        if (fail) throw new Error("Folia 回执超时，结果未知；请先查询状态，勿重放命令。");
        if (hold) await new Promise(resolve => { finish = resolve; });
        if (["pause", "resume"].includes(cmd.action)) publish({
          ...(!music.loaded && cmd.action === "resume" ? { running: true, loaded: true, tracks, currentTrackId: tracks[0].id } : {}),
          paused: cmd.action === "pause",
        });
        if (cmd.action === "play") publish({ currentTrackId: cmd.trackId, loaded: true, paused: false });
        if (cmd.action === "next" || cmd.action === "previous") {
          const i = tracks.findIndex(t => t.id === music.currentTrackId);
          publish({ currentTrackId: tracks[(i + (cmd.action === "next" ? 1 : 2)) % 3].id });
        }
        if (cmd.action === "set_volume") publish({ volume: cmd.volume });
        if (cmd.action === "seek") publish({ positionMs: cmd.positionMs });
        if (cmd.action === "set_playback_mode") publish({ playbackMode: cmd.playbackMode });
      },
    } });
  c.chat.load = async agent => c.chat.snapshot(agent); c.chat.refreshAsks = async () => {};
  c.chat.request = async () => { throw new Error("No backend calls in music fixture"); };
  ipcMain.handle("desktop:orb-action", (e, input) => c.action(e, input));
  await c.start(); win = c.win; win.webContents.on("console-message", e => { if (e.level === "error") errors.push(e.message); });
  const send = win.webContents.send.bind(win.webContents); win.webContents.send = (channel, ...data) => { pushes.push(channel); send(channel, ...data); };
  c.setConnection("closed"); await c.expand(true, true);
  await until("!document.querySelector('#panel').hidden");
  await js("document.querySelector('#input').value='草稿保留，不发送'");
  assert.equal(musicReads, 0); assert.deepEqual(commands, [], "orb does not start audio");
  await click("#music"); await until("document.querySelector('[data-music=open]')?.disabled===false");
  assert.equal(await js("document.querySelector('[data-music=toggle]').disabled"), false, "explicit cold resume is available");
  assert.equal(await js("document.querySelector('[data-music=seek]').disabled"), true);
  assert.deepEqual(commands, [], "even opening controls must not start audio");
  await capture("music-empty");
  await click(sel("toggle"));
  await until("document.querySelector('[data-music=title]').textContent==='不散的夏之灯'");
  assert.deepEqual(commands, [{ action: "resume" }], "one click resumes without opening Folia first");
  commands.length = 0;
  await click(sel("open")); assert.deepEqual(commands, [{ action: "open", player: "folia" }]);
  publish({ tracks, currentTrackId: tracks[0].id, loaded: true, paused: false, durationMs: 215000, positionMs: 72000, playbackModeAvailable: true, playbackMode: "off" });
  await until("document.querySelector('[data-music=title]').textContent==='不散的夏之灯'");
  await capture("music-playing");
  await click(sel("toggle")); assert.equal(commands.at(-1).action, "pause"); assert.equal(music.paused, true);
  await click(sel("toggle")); assert.equal(music.paused, false);
  await click(sel("next")); assert.equal(music.currentTrackId, "2");
  await click(sel("previous")); assert.equal(music.currentTrackId, tracks[0].id);
  await changeRange("seek", 500); assert.equal(music.positionMs, 107500);
  await click(sel("lyrics-toggle")); // volume remains available beside the lyric view
  await changeRange("volume", 36); assert.equal(music.volume, 36);
  await click(sel("mute")); assert.equal(music.volume, 0);
  await click(sel("mute")); assert.equal(music.volume, 36);
  await click(sel("lyrics-toggle"));
  for (const mode of ["all", "one", "shuffle", "off"]) { await click(sel("mode")); assert.equal(music.playbackMode, mode); }
  await click(sel("queue-toggle")); await until("!document.querySelector('[data-music=queue]').hidden");
  await js("document.querySelector('[data-music=search]').value='风';document.querySelector('[data-music=search]').dispatchEvent(new Event('input'))");
  assert.equal(await js("document.querySelectorAll('.music-track:not([hidden])').length"), 1);
  await click(".music-track:not([hidden])"); assert.equal(music.currentTrackId, "2");
  await js("document.querySelector('[data-music=search]').value='';document.querySelector('[data-music=search]').dispatchEvent(new Event('input'))");
  await capture("music-queue");
  await js("window.queueRow=document.querySelector('.music-track');window.scrollTop=document.querySelector('#drawerBody').scrollTop");
  pushes.length = 0; publish({ positionMs: 108000 });
  await until("document.querySelector('[data-music=elapsed]').textContent==='1:48'");
  assert.equal(await js("window.queueRow===document.querySelector('.music-track') && window.scrollTop===document.querySelector('#drawerBody').scrollTop"), true);
  assert.ok(pushes.includes("orb:music")); assert.equal(pushes.includes("orb:state"), false, "time updates do not copy chat history");
  await click(sel("queue-toggle"));
  // The saved seek target must not become a different song when playback advances mid-drag.
  await js("const seek=document.querySelector('[data-music=seek]');seek.dispatchEvent(new Event('pointerdown'));seek.value=200;seek.dispatchEvent(new Event('input'))");
  publish({ currentTrackId: "3" }); await until("document.querySelector('[data-music=title]').textContent.includes('非常')");
  const beforeSeek = commands.length;
  await js("document.querySelector('[data-music=seek]').dispatchEvent(new Event('change'))");
  await until("document.querySelector('[data-music=feedback]').textContent.includes('歌曲已切换')"); assert.equal(commands.length, beforeSeek);
  fail = true; const beforeFailure = commands.length;
  await click(sel("next")); await until("document.querySelector('[data-music=feedback]').textContent.includes('结果未知')");
  await sleep(180); assert.equal(commands.length, beforeFailure + 1, "failure never retries"); fail = false;
  hold = true; await click(sel("toggle")); assert.equal(c.musicBusy, true);
  assert.equal(await js("document.querySelector('[data-music=next]').disabled"), true); finish(); hold = false;
  await until("!document.querySelector('.orb-music-player').matches('[aria-busy=true]')");
  // QQ transport remains QQ; unsupported volume and seek stay visibly disabled.
  publish({ provider: "qqmusic", providerCapabilities: ["pause", "resume", "previous", "next"], playbackModeAvailable: false });
  await until("document.querySelector('[data-music=source]').textContent.includes('QQ')");
  assert.equal(await js("document.querySelector('[data-music=volume]').disabled && document.querySelector('[data-music=seek]').disabled && document.querySelector('[data-music=mode]').disabled"), true);
  await click(sel("open")); assert.equal(music.provider, "folia");
  publish({ providerCapabilities: caps, currentTrackId: tracks[0].id, loaded: true, paused: false, playbackModeAvailable: true });
  await click("#drawerClose"); await until("document.querySelector('#drawer').hidden");
  assert.equal(await js("document.querySelector('#input').value"), "草稿保留，不发送");
  musicReads = 0; pushes.length = 0; c.publishMusic(); assert.equal(musicReads, 0); assert.equal(pushes.length, 0);
  // Local music does not depend on the backend/chat connection or editable session.
  c.agent = "main-aemeath"; theme = "anime-snowfleece"; c.chat.row(c.agent).readOnly = true; c.publish();
  await click("#music"); await until("document.querySelector('[data-music=toggle]')?.disabled===false"); await capture("music-aemeath");
  theme = "premium-obsidian"; c.publish(); await until("document.body.dataset.theme==='premium-obsidian'"); await capture("music-dark");
  screen.getPrimaryDisplay = () => ({ workArea: { x: 0, y: 0, width: 800, height: 420 } });
  c.reflow(); await until(`innerHeight===${c.layout.bounds.height}`); await click(sel("queue-toggle")); await click(".music-track:last-child");
  assert.equal(music.currentTrackId, "3");
  assert.equal(await js("document.querySelector('#drawerBody').scrollWidth<=document.querySelector('#drawerBody').clientWidth"), true);
  await capture("music-short-screen");
  await c.expand(false); await until("document.querySelector('#drawer').hidden"); musicReads = 0; c.publishMusic(); assert.equal(musicReads, 0);
  await c.expand(true, true); await click("#music"); await until("document.querySelector('[data-music=open]')?.disabled===false");
  c.chat.history = async () => [];
  await click("#history"); await until("document.querySelector('#drawerTitle').textContent==='全部对话'");
  assert.equal(c.musicWatching, false, "another drawer unsubscribes music");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, controls: "open / play-pause / next-previous / seek / volume-mute / repeat-shuffle / queue", coldStartSideEffects: 0,
    hiddenMusicReads: 0, chatCalls: 0, themes: 3, shortScreen: true, errorAndSourceRaces: true, report }));
}).catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { clearTimeout(watchdog); c?.dispose(); app.exit(process.exitCode || 0); });
