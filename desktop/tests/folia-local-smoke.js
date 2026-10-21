const { app, protocol, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { FoliaController } = require('../folia/controller');
const { SCHEMES } = require('../folia/host');
const { packagedFoliaRoot } = require('./packaged-folia-root');
const createFixtureProbe = require('./folia-fixture-probe');
// Real Folia import/playback with a generated WAV; only the OS folder picker is substituted.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-folia-audio-')));
protocol.registerSchemesAsPrivileged(SCHEMES);
app.on('window-all-closed', () => {}); // The test owns orderly async cleanup and exit.
const coldStart = process.argv.includes('--cold-start');
if (process.argv.includes('--background') || coldStart) {
  app.on('browser-window-created', (_event, win) => {
    for (const method of ['show', 'showInactive', 'focus', 'moveTop', 'restore']) win[method] = () => {};
  });
  app.on('web-contents-created', (_event, contents) => { contents.focus = () => {}; });
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let controller;
const probe = createFixtureProbe('folia-local', () => controller,
  process.argv.includes('--player-panel') || process.argv.includes('--visualizer-switch') || process.argv.includes('--tempera-workshop') ? 120_000 : 45_000);
app.whenReady().then(async () => {
  require('./folia-fixture-locale').prepare();
  controller = new FoliaController({ offline: true,
    root: process.argv.includes('--packaged') ? packagedFoliaRoot(path.resolve(__dirname, '..')) : undefined });
  await probe.step('cold window startup', () => coldStart ? controller.ensure() : controller.open('window'), 40_000);
  const wc = controller.runtime.getMainWindow().webContents;
  await probe.step('fixture locale', () => require('./folia-fixture-locale')(wc), 25_000);
  const js = code => probe.js(wc, code, !coldStart);
  probe.progress('library startup');
  // Wait for the actual library destination, not just the removed splash.
  const startupReady = '!document.querySelector("#app-splash") && !!document.querySelector("[data-folia-home]")';
  for (let i = 0; i < 100 && !await js(startupReady); i++) await pause(50);
  assert.equal(await js(startupReady), true, 'fresh Folia opens the library');
  assert.equal(await js('!!document.querySelector(".lattice-root")'), false);
  await controller.command({ action: 'set_volume', volume: 0 });
  probe.progress('write local WAV and lyric fixture');
  await js(`(async()=>{
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('Harbour Audio Test', {create:true});
    const file = await dir.getFileHandle('Harbour tone.wav', {create:true});
    const sampleRate=44100;
    const data = new ArrayBuffer(44+sampleRate*2*${process.argv.includes('--visualizer-switch') || process.argv.includes('--shuffle') || process.argv.includes('--tempera-workshop') ? 120 : 12}), view = new DataView(data);
    function str(at,s){for(let i=0;i<s.length;i++)view.setUint8(at+i,s.charCodeAt(i));}
    str(0,'RIFF'); view.setUint32(4,data.byteLength-8,true); str(8,'WAVE'); str(12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);str(36,'data');view.setUint32(40,data.byteLength-44,true);
    const writer=await file.createWritable();await writer.write(data);await writer.close();
    if (${process.argv.includes('--shuffle')}) for (let i=2;i<=5;i++) { const extra=await (await dir.getFileHandle('Harbour tone '+i+'.wav',{create:true})).createWritable();await extra.write(data);await extra.close(); }
    const lyric=await (await dir.getFileHandle('Harbour tone.lrc',{create:true})).createWritable();await lyric.write('[00:00.00]Folia visual test\\n[00:01.00]Music stays with you\\n[00:04.00]Harbour recording check\\n[00:08.00]End of the test');await lyric.close();
    window.showDirectoryPicker=async()=>dir;
    for(const b of document.querySelectorAll('button'))if(/开始使用|开始体验|知道了|关闭/.test(b.innerText))b.click();
    const local=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='本地'); local?.click();
  })()`);
  await pause(700);
  probe.progress('import local fixture');
  await js(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='导入文件夹').click()`);
  let songs;
  for (let attempt = 0; attempt < 80; attempt++) {
    songs = await controller.command({ action: 'search', query: 'Harbour tone', source: 'local' });
    if (songs.tracks?.length === (process.argv.includes('--shuffle') ? 5 : 1)) break;
    await pause(100);
  }
  assert.equal(songs.tracks.length, process.argv.includes('--shuffle') ? 5 : 1, await js('document.body.innerText'));
  probe.progress('enqueue and play local fixture');
  if (process.argv.includes('--shuffle')) await assert.rejects(controller.command({ action: 'shuffle' }), /至少需要 2 首/);
  await controller.command({ action: 'enqueue', trackId: songs.tracks[0].id });
  await pause(100);
  const queued = await controller.command({ action: 'queue' });
  assert.ok(queued.tracks.some(track => track.id === songs.tracks[0].id), 'local enqueue uses the original unified queue');
  await controller.command({ action: 'play', trackId: songs.tracks[0].id });
  // A single play request must advance real media time. Cold CoreAudio startup
  // on a busy Mac runner can exceed two seconds; poll the condition with a hard
  // deadline, never issue a second play/resume or substitute a synthetic clock.
  const playbackDeadline = Date.now() + 8000;
  let playing;
  do {
    await pause(150);
    playing = await controller.command({ action: 'queue' });
    if (!playing.paused && playing.positionMs > 300 && playing.audioHealth?.media?.currentTime > 0) break;
  } while (Date.now() < playbackDeadline);
  assert.equal(playing.paused, false, JSON.stringify(playing));
  assert.ok(playing.positionMs > 300, JSON.stringify(playing));
  assert.ok(playing.audioHealth?.media?.currentTime > 0, 'real renderer publishes media progress');
  assert.ok(playing.audioHealth.media.bufferAheadSeconds > 0, 'real buffered ranges are measured');
  assert.equal(playing.audioHealth.media.errorCode, null);
  assert.ok(playing.audioHealth.context?.sampleRate > 0, 'Web Audio context is measured, not assumed');
  if (coldStart) {
    assert.equal(await js('navigator.userActivation.hasBeenActive'), false, 'no Folia page gesture may unlock this test');
    assert.equal(playing.audioHealth.context?.state, 'running', 'cold external play starts the audio output graph');
    await controller.command({ action: 'pause' });
    await js(`localStorage.setItem('folia_auto_play_on_launch','false')`);
    console.log('FOLIA_COLD_EXTERNAL_PLAY_OK');
    probe.progress('resume as the very first command after unloading Folia');
    // No startup sleep, status polling, page gesture, or eager open(): the one
    // external resume must start Folia, restore its saved source, and play it.
    await controller.close();
    if (!wc.isDestroyed()) await probe.step('dispose old player', () => new Promise(resolve => wc.once('destroyed', resolve)), 5000);
    const coldResume = await controller.command({ action: 'resume' });
    assert.equal(coldResume.paused, false, JSON.stringify(coldResume));
    assert.equal(coldResume.currentTrackId, songs.tracks[0].id);
    assert.equal(controller.mode, 'background');
    const restoredWc = controller.runtime.getMainWindow().webContents;
    assert.notEqual(restoredWc, wc, 'the original renderer really was unloaded');
    assert.equal(await probe.js(restoredWc, 'navigator.userActivation.hasBeenActive', false), false);
    const advanceDeadline = Date.now() + 8000;
    let resumed;
    do {
      await pause(150);
      resumed = await controller.command({ action: 'queue' });
      if (resumed.positionMs > coldResume.positionMs + 300) break;
    } while (Date.now() < advanceDeadline);
    assert.equal(resumed.paused, false);
    assert.equal(resumed.audioHealth.context?.state, 'running');
    assert.ok(resumed.positionMs > coldResume.positionMs + 300, 'first cold resume advances real media time');
    assert.equal(resumed.audioHealth.media.errorCode, null);
    assert.ok(BrowserWindow.getAllWindows().every(win => !win.isVisible()), 'the Folia page never has to be shown');
    console.log('FOLIA_FIRST_COMMAND_RESUME_OK');
  }
  assert.ok(!JSON.stringify(playing.audioHealth).includes('Harbour tone'), 'health must not expose media paths');
  if (process.argv.includes('--shuffle')) await require('./folia-shuffle-checks')(controller, songs.tracks);
  if (process.argv.includes('--orb-music')) await require('./folia-orb-music-checks')(controller);
  if (process.argv.includes('--tempera-workshop')) {
    probe.progress('tempera workshop');
    await require('./folia-tempera-workshop-checks')(controller);
  }
  if (process.argv.includes('--nav-overlay')) {
    const dashboard = new BrowserWindow({ show: false, width: 1200, height: 850 });
    const bounds = { x: 20, y: 90, width: 1160, height: 650 };
    await controller.open('embedded', dashboard, bounds);
    const start = await controller.command({ action: 'queue' });
    for (const clipLeft of [0, 50, 120, 200, 220, 130, 60, 0, 180, 0]) {
      controller.resize(dashboard, { ...bounds, clipLeft }, true);
      await pause(80);
      assert.equal(controller.dock.view.getVisible(), true);
      assert.equal(controller.dock.view.getBounds().width, bounds.width);
    }
    const end = await controller.command({ action: 'queue' });
    assert.equal(controller.runtime.getMainWindow().webContents, wc);
    assert.equal(end.paused, false);
    assert.equal(end.currentTrackId, start.currentTrackId);
    assert.ok(end.audioHealth.media.currentTime > start.audioHealth.media.currentTime, 'actual audio keeps advancing during clipping');
    for (const event of ['pause','emptied','error']) assert.equal(end.audioHealth.media.events[event] || 0, start.audioHealth.media.events[event] || 0);
    controller.hide(); dashboard.destroy();
    console.log('FOLIA_NAV_AUDIO_OK: same real player/track, media time advances, no pause/emptied/error');
  }
  if (process.argv.includes('--transparency')) {
    const dashboard = new BrowserWindow({ show: false, width: 1200, height: 800 });
    const events = playing.audioHealth.media.events;
    for (const mode of ['embedded', 'window', 'embedded']) {
      await controller.open(mode, dashboard, { x: 230, y: 100, width: 900, height: 600 });
      await js('window.electron.setWindowTransparentMode(true)');
      await pause(120);
      await js('window.electron.setWindowTransparentMode(false)');
      await pause(120);
      const state = await controller.command({ action: 'queue' });
      assert.equal(controller.runtime.getMainWindow().webContents, wc);
      assert.equal(state.paused, false);
      assert.equal(state.currentTrackId, playing.currentTrackId);
      assert.ok(state.positionMs > playing.positionMs);
      for (const event of ['pause', 'emptied', 'error']) assert.equal(state.audioHealth.media.events[event] || 0, events[event] || 0);
    }
    controller.hide(); dashboard.destroy();
    console.log('FOLIA_TRANSPARENCY_AUDIO_OK: one player, no pause/emptied/error events');
  }
  await controller.command({ action: 'pause' });
  await pause(150);
  const paused = await controller.command({ action: 'queue' });
  assert.equal(paused.paused, true);
  await controller.command({ action: 'seek', positionMs: 4000 });
  const seek = await controller.command({ action: 'queue' });
  assert.ok(Math.abs(seek.positionMs - 4000) < 200);
  console.log(JSON.stringify({ status: 'FOLIA_REAL_AUDIO_OK', imported: songs.tracks[0].title, durationMs: playing.durationMs, positionMs: playing.positionMs, paused: paused.paused, seekMs: seek.positionMs }));
  if (process.argv.includes('--visualizer-switch')) {
    probe.progress('visualizer switch and renderer recovery');
    await require('./folia-visualizer-switch-checks')(controller);
  }
  if (process.argv.includes('--player-panel')) {
    // The panel fixture starts in the player deliberately. Cold library startup is checked
    // above; seed before reload so late welcome/navigation effects cannot obscure the panel.
    await pause(600);
    await js(`localStorage.setItem('folia_startup_view','player');localStorage.setItem('folia_last_seen_guide_version',${JSON.stringify(require('../../vendor/folia/package.json').version)});`);
    const loaded = new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { wc.off('did-finish-load', finish); reject(new Error('Panel fixture reload timed out')); }, 15000);
      wc.once('did-finish-load', finish);
    });
    wc.reload(); await loaded;
    await require('./folia-player-panel-checks')(controller);
  }
  if (process.argv.includes('--advanced')) {
    const waitFor = async (get, check, label) => {
      for (let i = 0; i < 180; i++) { const value = await get(); if (check(value)) return value; await pause(100); }
      throw new Error('Timed out: ' + label);
    };
    const dashboard = new BrowserWindow({ show: false, width: 1200, height: 800 });
    await dashboard.loadURL('data:text/html,<h1>Harbour host must not be recorded</h1>');
    await controller.open('embedded', dashboard, { x: 30, y: 80, width: 1120, height: 650 });
    await controller.open('remote');
    const remoteWindow = await waitFor(async () => [...controller.host.windows].find(w => w.webContents.getURL().includes('remote=1')),
      w => !!w, 'Remote window');
    const remote = code => remoteWindow.webContents.executeJavaScript(code, true);
    const snapshot = () => remote('window.electron.getRemoteControlSnapshot()');
    await waitFor(snapshot, s => s?.hasTrack, 'Remote track snapshot');
    await js(`window.__recordingDiagnostics=[];window.MediaRecorder=class extends MediaRecorder{constructor(stream,options){super(stream,options);window.__recordingDiagnostics.push({options,tracks:stream.getTracks().map(t=>({kind:t.kind,state:t.readyState,settings:t.getSettings()}))});this.addEventListener('error',e=>window.__recordingDiagnostics.push({name:e.error?.name,message:e.error?.message}));}};void 0`);
    await js(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='我知道了')?.click()`);
    const report = path.resolve(__dirname, '../../assets/reports/folia'); fs.mkdirSync(report, { recursive: true });
    // Only the OS path picker is replaced; capture, MediaRecorder and file writing are real.
    const originalSaveDialog = dialog.showSaveDialog;
    let outputPath;
    dialog.showSaveDialog = async (_win, options) => {
      outputPath = path.join(report, 'folia-recording-smoke' + path.extname(options.defaultPath));
      return { canceled: false, filePath: outputPath };
    };
    try {
      await remote(`window.electron.sendRemoteControlCommand({type:'start-export',preset:{id:'harbour-test',label:'Harbour test',width:640,height:360,orientation:'landscape'},startMode:'from-start'})`);
      const recording = await waitFor(snapshot, s => ['recording', 'error'].includes(s?.exportState?.status), 'recording begins');
      assert.equal(recording.exportState.status, 'recording', JSON.stringify({ state: recording.exportState, diagnostics: await js('window.__recordingDiagnostics') }));
      assert.equal(controller.mode, 'window', 'recording undocks only the Folia view');
      assert.equal(controller.dock, null);
      assert.equal(dashboard.isDestroyed(), false);
      await pause(1600);
      await remote(`window.electron.sendRemoteControlCommand({type:'stop-export'})`);
      const completed = await waitFor(snapshot, s => ['done', 'error'].includes(s?.exportState?.status), 'recording file written');
      assert.equal(completed.exportState.status, 'done', JSON.stringify(completed.exportState));
      assert.ok(fs.statSync(outputPath).size > 100, 'must produce a real media container');
      const media = await js(`new Promise((resolve,reject)=>{const v=document.createElement('video');v.onloadeddata=()=>{v.currentTime=.75;};v.onseeked=()=>{const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;const ctx=c.getContext('2d');ctx.drawImage(v,0,0);const pixels=ctx.getImageData(0,0,c.width,c.height).data;let min=255,max=0;for(let i=0;i<pixels.length;i+=4){min=Math.min(min,pixels[i]);max=Math.max(max,pixels[i]);}resolve({width:v.videoWidth,height:v.videoHeight,range:max-min,frame:c.toDataURL('image/png')});};v.onerror=()=>reject(new Error('recording decode failed'));v.src=${JSON.stringify(require('node:url').pathToFileURL(outputPath).href)};});`);
      assert.equal(media.width, 640); assert.equal(media.height, 360);
      assert.ok(media.range > 30, 'the decoded recording must not be a blank frame');
      fs.writeFileSync(path.join(report,'recording-frame.png'), Buffer.from(media.frame.split(',')[1],'base64'));
      delete media.frame;
      console.log(JSON.stringify({ status:'FOLIA_RECORDING_OK', bytes:fs.statSync(outputPath).size, media, file:outputPath }));
    } finally { dialog.showSaveDialog = originalSaveDialog; }
    remoteWindow.close(); await pause(200);
    assert.equal(wc.isDestroyed(), false, 'closing Remote keeps the player');
    assert.equal(dashboard.isDestroyed(), false);
    dashboard.destroy();
  }
  probe.progress('close player');
  await controller.close();
  if (process.argv.includes('--shuffle')) assert.equal(controller.status().shuffleAvailable, false, 'closed player cannot advertise a live shuffle queue');
  probe.complete();
  app.exit(0);
}).catch(error => probe.fail(error));
