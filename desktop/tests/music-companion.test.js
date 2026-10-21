const { test } = require('node:test');
const assert = require('node:assert/strict');
const { current, discussion } = require('../../web/music-context');
const { musicTransport } = require('../companion/music-transport');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../web/pet-core.js'), 'utf8'), sandbox);
const feedback = sandbox.window.HarbourPetCore.deriveFeedback;
const music = { provider:'folia', connected:true, running:true, loaded:true, paused:false, currentTrackId:'b', positionMs:5000,
  tracks:[{id:'a',title:'Not playing'}, {id:'b',title:'Current song',artist:'Singer'}] };
test('only the actual loaded track can be discussed', () => {
  assert.equal(current(music).title, 'Current song');
  for (const change of [{loaded:false},{connected:false},{running:false},{currentTrackId:null},{currentTrackId:'missing'},{provider:'local'}]) assert.equal(current({...music,...change}),null);
});
test('discussion captures metadata and device, not the full queue or hidden lyrics', () => {
  const text = discussion(current(music), 'device-b');
  assert.match(text,/Current song/); assert.match(text,/device-b/); assert.match(text,/先不要切歌/);
  assert.doesNotMatch(text,/Not playing/); assert.equal(discussion(null,'b'),'');
});
test('local transport cannot open, search, inject args or switch providers', () => {
  assert.deepEqual(musicTransport({action:'pause',script:'bad'},'folia',music),{action:'pause'});
  for (const action of ['open','close','play','search','shell','set_volume']) assert.throws(()=>musicTransport({action},'folia',music));
  for (const state of [{...music,loaded:false},{...music,running:false}]) {
    assert.deepEqual(musicTransport({action:'resume',url:'ignored'},'folia',state), {action:'resume'});
    assert.throws(()=>musicTransport({action:'next'},'folia',state));
  }
  for (const patch of [{connected:false},{available:false},{providerAvailable:false},{renderer:{phase:'failed'}},{renderer:{phase:'unresponsive'}}]) {
    assert.throws(()=>musicTransport({action:'resume'},'folia',{...music,...patch}));
  }
  assert.throws(()=>musicTransport({action:'next'},'qqmusic',music));
  assert.throws(()=>musicTransport({action:'shuffle'},'folia',music));
  assert.deepEqual(musicTransport({action:'shuffle'},'folia',{...music,shuffleAvailable:true}),{action:'shuffle'});
});
test('music never overrides asks, work, speech, failures, or dragging', () => {
  assert.equal(feedback({music}).state,'listening');
  assert.equal(feedback({music:{...music,connected:false}}).state,'idle');
  assert.equal(feedback({music:{...music,running:false}}).state,'idle');
  assert.equal(feedback({music,speechActive:true}).state,'speaking');
  assert.equal(feedback({music,asks:[{id:'ask'}]}).state,'waiting');
  assert.equal(feedback({music,activities:[{status:'running'}]}).state,'working');
  assert.equal(feedback({music,activities:[{status:'error'}]}).state,'failed');
  assert.equal(feedback({music,dragDirection:'left'}).state,'dragging');
});

test('playback modes use explicit validated values and allow an empty Folia queue', () => {
  const state = { ...music, loaded: false, tracks: [], playbackModeAvailable: true };
  for (const playbackMode of ['off', 'all', 'one', 'shuffle']) {
    assert.deepEqual(musicTransport({ action: 'set_playback_mode', playbackMode, script: 'ignored' }, 'folia', state), { action: 'set_playback_mode', playbackMode });
  }
  for (const playbackMode of [undefined, null, 'random', '', 1, {}]) assert.throws(() => musicTransport({ action: 'set_playback_mode', playbackMode }, 'folia', state), /playbackMode/);
  for (const patch of [{ playbackModeAvailable: false }, { playbackModeAvailable: undefined }, { connected: false }, { running: false }]) {
    assert.throws(() => musicTransport({ action: 'set_playback_mode', playbackMode: 'shuffle' }, 'folia', { ...state, ...patch }));
  }
  assert.throws(() => musicTransport({ action: 'set_playback_mode', playbackMode: 'shuffle' }, 'qqmusic', state));
});
test('packaged pets include the same shared metadata and control scripts', () => {
  const config = require('../package.json');
  const webAssets = config.build.extraResources.find(row=>row.from==='../web').filter;
  for (const file of ['pet-music.js','music-context.js']) assert.ok(webAssets.includes(file));
});
