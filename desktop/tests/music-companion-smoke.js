// Real Main Chat/pet DOM and production preload/IPC. Playback/backend are controlled
// fixtures: no owner player, session, account, model or audio output is touched.
const { app, BrowserWindow } = require('electron');
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const Module = require('node:module'), { createServer } = require('node:http'), { WebSocketServer } = require('ws');
const { CompanionStateStore } = require('../companion/companion-state');
const root = path.resolve(__dirname,'../..'), web = path.join(root,'web');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(),'harbour-music-companion-'));
app.setPath('userData',fixture);
Object.assign(process.env,{ HARBOUR_DATA_HOME:fixture,HARBOUR_CHARACTER_HOME:path.join(fixture,'characters'),HARBOUR_CONFIG:path.join(fixture,'config.json'),
  HARBOUR_URL:'http://127.0.0.1:1',HARBOUR_TOKEN:'',HARBOUR_PET:'1',HARBOUR_PETS:'elaina',HARBOUR_SPAWN:'0',HARBOUR_LIVE2D_AUTO_INSTALL:'0' });
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('force-device-scale-factor','1'); app.on('window-all-closed',()=>{});
const mainPath=path.join(root,'desktop/main.js'), source=fs.readFileSync(mainPath,'utf8');
const boundary=source.indexOf('// Desktop bootstrap entry'); assert.ok(boundary>0);
const production=new Module(mainPath,module); production.filename=mainPath; production.paths=Module._nodeModulePaths(path.dirname(mainPath));
production._compile(source.slice(0,boundary)+`
async function cleanupDesktop() {} // Test fixture teardown lives below, not production service shutdown.
module.exports={install(dashboard,pet,store,controller){ mainWindow=dashboard;petWindows.set('elaina',pet);companionState=store;folia=controller;
// Offscreen fixtures deliberately render as foreground surfaces; real background suspension has its own suite.
visualPolicy.mode='normal';visualPolicy.visible=()=>true;
musicStore={getProvider:()=> 'folia'};qqMusicBridge={};stickerStore={};characterStore={appearance:()=>({followDashboard:false}),readCharacter:()=>({manifest:{displayName:'Elaina',visual:{live2d:{enabled:true,renderedWidth:150,renderedHeight:188}}}}),voiceEnabled:()=>false};
ttsClient={status:async()=>({configured:false})};},detachPet(){petWindows.delete('elaina');}};`,mainPath);
const store=new CompanionStateStore(), commands=[], httpCommands=[];
let state={provider:'folia',connected:true,running:true,loaded:true,paused:false,currentTrackId:'b',shuffleAvailable:true,playbackMode:'one',playbackModeAvailable:true,
  tracks:[{id:'a',title:'队列中的歌'},{id:'b',title:'星河与晚风',artist:'测试歌手'}],positionMs:8000};
let gate=null, failure=false, remoteOnline=true;
const controller={status:()=>state,setVisualQuiet(){}, async command(command){ commands.push(command);
  if(gate) await gate.promise;
  if(failure) throw new Error('fixture 回执超时，结果未知；请先查询状态，勿重放命令');
  if(command.action==='pause') state={...state,paused:true};
  if(command.action==='resume') state={...state,paused:false};
  if(command.action==='set_playback_mode') state={...state,playbackMode:command.playbackMode};
  publish(state); return state;
}};
let dashboard,pet,plain;
function publish(value){state=value;store.setMusic(value);}
const agent={name:'main-elaina',description:'fixture',taskType:'main',permissionMode:'dontAsk',tools:[],skills:[]};
const session={id:'fixture-session',key:'web:default:main-elaina',channel:'web',agentName:agent.name,title:'音乐陪伴测试',messages:[],traces:[],source:{app:'web',actorRole:'owner'}};
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1'),json=value=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(url.pathname.startsWith('/api/')){
    if(req.method==='POST') {let body='';for await(const chunk of req)body+=chunk;httpCommands.push({path:url.pathname,body:JSON.parse(body||'{}')});return json({result:{accepted:true}});}
    if(url.pathname==='/api/music/devices')return json({devices:remoteOnline?[{id:'remote-fixture',label:'远端 Mac',music:state}]:[]});
    if(url.pathname==='/api/agents')return json({agents:[agent]});
    if(url.pathname==='/api/state')return json({agents:[agent],defaultAgent:agent.name,backends:{},uptimeMs:1000});
    if(url.pathname==='/api/skills')return json({skills:[]});
    if(url.pathname==='/api/asks')return json({asks:[]});
    if(url.pathname==='/api/cowork/devices')return json({devices:[]});
    if(url.pathname==='/api/agent-defaults')return json({models:[],agents:[{name:agent.name,effectivePermissionMode:'dontAsk'}]});
    if(url.pathname==='/api/conversations/explorer')return json({enabled:true,sessions:[session]});
    if(url.pathname===`/api/conversations/${session.id}`)return json({session});
    return json({});
  }
  if(url.pathname==='/live2d-host.js'){res.setHeader('Content-Type','text/javascript');return res.end('window.__live2dStateCalls=0;window.HarbourLive2D={async createHost(){return {ready:true,setState(){window.__live2dStateCalls++},resize(){},lookAt(){},destroy(){}}}}');}
  const file=path.resolve(web,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
  if(!file.startsWith(web+path.sep)){res.writeHead(403);return res.end();}
  try{res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'});res.end(fs.readFileSync(file));}
  catch{res.writeHead(404);res.end();}
});
const ws=new WebSocketServer({server,path:'/ws'}); ws.on('connection',s=>s.send(JSON.stringify({__harbour:'activity-snapshot',activeRunIds:[]})));
const sleep=ms=>new Promise(r=>setTimeout(r,ms)), js=(w,code)=>w.webContents.executeJavaScript(code,true);
async function until(w,code){for(let i=0;i<200;i++){if(await js(w,code))return;await sleep(30)}console.error(await js(w,'document.body.innerText.slice(0,3500)'));console.error(await js(w,`(async()=>({id:window.harbourDesktop?.coworkDeviceId,local:typeof window.harbourDesktop?.controlCompanionMusic,state:await window.harbourDesktop?.getCompanionState().catch(e=>e.message),saved:localStorage.getItem('harbour-music-device')}))()`));throw new Error('Timeout '+code)}
async function click(w,selector){const r=await js(w,`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  assert.equal(await js(w,`!!document.elementFromPoint(${r.x},${r.y})?.closest(${JSON.stringify(selector)})`),true,selector+' is hit-testable');
  for(const type of ['mouseMove','mouseDown','mouseUp'])w.webContents.sendInputEvent({type,...r,button:'left',clickCount:1});await sleep(70);
}
const watchdog=setTimeout(()=>{console.error('music companion smoke timed out');app.exit(1)},90000);
app.whenReady().then(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  const prefs=surface=>({preload:path.join(root,'desktop/preload.js'),offscreen:true,backgroundThrottling:false,contextIsolation:true,
    additionalArguments:[`--harbour-surface=${surface}`,`--harbour-url=${base}`,'--harbour-cowork-device=local-fixture','--harbour-pet-id=elaina','--harbour-pet-agent=main-elaina']});
  dashboard=new BrowserWindow({show:false,width:1440,height:960,webPreferences:prefs('dashboard')});
  dashboard.webContents.on('console-message',details=>{if(details.level==='error'||details.level==='warning')console.log('dashboard:',details.message)});
  pet=new BrowserWindow({show:false,width:232,height:332,transparent:true,frame:false,webPreferences:prefs('pet')});
  production.exports.install(dashboard,pet,store,controller);
  store.on('change',value=>{for(const win of [dashboard,pet])if(win&&!win.isDestroyed())win.webContents.send('desktop:companion-state',value)});publish(state);
  await dashboard.loadURL(base+'/#chat');await pet.loadURL(base+'/desktop-pet.html');
  await until(dashboard,`document.querySelector('.chat-music-title')?.textContent==='星河与晚风'`);
  await click(dashboard,'.chat-music-collapse');
  await until(pet,`document.querySelector('#desktopPet').dataset.petState==='listening' && !document.querySelector('#petMusicBar').hidden`);
  assert.equal(commands.length,0,'opening Chat/pet must never command playback');
  const warmState={...state};
  publish({...state,running:false,loaded:false,paused:true,tracks:[],currentTrackId:''});
  await until(dashboard,`document.querySelector('[data-music-action="previous"]').disabled && !document.querySelector('[data-music-action="toggle"]').disabled`);
  assert.equal(commands.length,0,'a cold status alone never starts Folia');
  await click(dashboard,'[data-music-action="toggle"]');
  assert.deepEqual(commands,[{action:'resume'}],'the first Main Chat click reaches the production IPC without opening Folia');
  assert.equal(await js(dashboard,`document.querySelector('#chatMusic').dataset.playing`), 'false', 'a receipt alone is not playback');
  commands.length=0;publish(warmState);
  await until(dashboard,`document.querySelector('.chat-music-title')?.textContent==='星河与晚风'`);
  await until(dashboard,`document.querySelector('[data-music-action="set_playback_mode"]').dataset.mode==='one'`);
  await click(dashboard,'[data-music-action="set_playback_mode"]');
  await until(dashboard,`document.querySelector('[data-music-action="set_playback_mode"]').dataset.mode==='shuffle'`);
  assert.deepEqual(commands.pop(),{action:'set_playback_mode',playbackMode:'shuffle'});
  publish({...state,playbackMode:'all'});
  await until(dashboard,`document.querySelector('[data-music-action="set_playback_mode"]').dataset.mode==='all'`);
  const poseCalls = await js(pet,'window.__live2dStateCalls');
  for(let tick=0;tick<60;tick++){publish({...state,positionMs:9000+tick*100});await sleep(10);}
  await sleep(100);
  assert.equal(await js(pet,'window.__live2dStateCalls'),poseCalls,'progress telemetry must not reapply the Live2D pose');
  assert.equal(store.snapshot().music.positionMs,14900,'progress is still current for snapshots and music controls');
  console.log('MUSIC_PET_TELEMETRY_OK: 60 progress updates, 0 redundant pose updates');
  await js(dashboard,`document.querySelector('#chatInput').value='保留我的草稿';`);
  await click(dashboard,'.chat-music-discuss');
  const draft=await js(dashboard,`document.querySelector('#chatInput').value`);
  assert.match(draft,/保留我的草稿/);assert.match(draft,/星河与晚风/);assert.match(draft,/local-fixture/);assert.doesNotMatch(draft,/队列中的歌/);
  assert.equal(httpCommands.length,0,'discuss only creates a draft, never sends a chat');
  gate={};gate.promise=new Promise(r=>gate.resolve=r);
  await click(dashboard,'[data-music-action="toggle"]');
  await js(dashboard,`document.querySelector('[data-music-action="toggle"]').click()`);
  assert.equal(commands.length,1,'double clicks dispatch once');gate.resolve();gate=null;
  await until(dashboard,`document.querySelector('[data-music-action="toggle"]').getAttribute('aria-label')==='继续播放'`);
  await until(pet,`document.querySelector('#desktopPet').dataset.petState==='idle'`);
  await click(pet,'[data-pet-music="toggle"]');
  await until(dashboard,`document.querySelector('[data-music-action="toggle"]').getAttribute('aria-label')==='暂停'`);
  assert.equal(commands.at(-1).action,'resume');
  await click(pet,'.pet-music-hide');assert.equal(await js(pet,`document.querySelector('#petMusicBar').hidden`),true);
  assert.equal(state.paused,false,'hiding the card must not pause');
  await js(pet,`document.querySelector('#petMusic').click()`); // Hover-only toolbar, keyboard activation.
  store.consume({__harbour:'channel-activity',companionId:'elaina',agent:'main-elaina',runId:'work',phase:'running'});
  await until(pet,`document.querySelector('#desktopPet').dataset.petState==='working'`);
  assert.equal(await js(pet,`document.querySelector('#petMusicBar').hidden`),true,'work wins music space');
  store.consume({__harbour:'activity-snapshot',activeRunIds:[]});
  await until(pet,`!document.querySelector('#petMusicBar').hidden`);
  publish({...state,connected:false});
  await until(dashboard,`document.querySelector('[data-music-action="toggle"]').disabled`);
  await until(pet,`document.querySelector('#petMusicBar').hidden && document.querySelector('#desktopPet').dataset.petState==='idle'`);
  publish({...state,connected:true});
  failure=true;await click(dashboard,'[data-music-action="next"]');
  await until(dashboard,`document.querySelector('.chat-music-notice').textContent.includes('结果未知')`);
  const count=commands.length;await sleep(200);assert.equal(commands.length,count,'no retry after uncertain result');failure=false;
  await assert.rejects(js(pet,`window.harbourDesktop.controlCompanionMusic({action:'open'})`),/不支持/);
  const report=path.join(root,'assets/reports/music-companion');fs.mkdirSync(report,{recursive:true});
  publish({...state,title:undefined});
  for(const theme of [['premium','neutral','premium-champagne'],['premium','neutral','premium-tungsten'],['anime','elaina','anime-wisteria'],['anime','elaina','anime-sky'],['anime','aemeath','anime-snowfleece'],['anime','aemeath','anime-stardust'],['anime','aemeath','anime-neon']]){
    await js(dashboard,`applyTheme(...${JSON.stringify(theme)})`);
    for(const width of [520,1440]){dashboard.setSize(width,process.argv.includes('--compact-height')?680:1060);await sleep(100);
      // Anime reserves portrait space with a padding transition; inspect its
      // settled narrow layout on both animated and reduced-motion desktops.
      await until(dashboard,`!document.querySelector('#content').getAnimations().some(a=>a.playState==='running')`);
      const bounds=await js(dashboard,`(()=>{const bar=document.querySelector('.chat-music-bar'),b=bar.getBoundingClientRect(),panel=document.querySelector('.chat-music-content'),r=panel.getBoundingClientRect();return {w:innerWidth,vh:innerHeight,l:r.left,r:r.right,t:r.top,b:r.bottom,h:r.height,compactHeight:b.height,open:!panel.hidden,
        parts:[...panel.children].map(e=>{const r=e.getBoundingClientRect();return {class:e.className,x:r.x,y:r.y,w:r.width,h:r.height}}).filter(p=>p.w>0&&p.h>0)}})()`);
      if(theme[2]==='anime-wisteria'&&width===520) console.log('MUSIC_CHAT_NARROW_LAYOUT',JSON.stringify(bounds));
      // The compact trigger owns a separate popup, not a full-width music strip.
      // Keep its actual controls/error notice inside the viewport without overlap.
      const fits=bounds.open&&bounds.compactHeight<=48&&bounds.r<=bounds.w+1&&bounds.l>=-1&&bounds.t>=0&&bounds.b<=bounds.vh+1
        &&bounds.parts.every(p=>p.x>=bounds.l&&p.x+p.w<=bounds.r+1&&p.y>=bounds.t&&p.y+p.h<=bounds.b+1);
      const overlap=bounds.parts.some((a,i)=>bounds.parts.slice(i+1).some(b=>Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)>1&&Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)>1));
      if(!fits||overlap) fs.writeFileSync(path.join(report,'failed-chat-layout.png'),(await dashboard.webContents.capturePage()).toPNG());
      assert.ok(fits&&!overlap,JSON.stringify({theme,width,bounds}));
    }
  }
  await js(dashboard,`applyTheme('anime','elaina','anime-wisteria')`);await sleep(1200);
  fs.writeFileSync(path.join(report,'main-chat.png'),(await dashboard.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(report,'pet-music.png'),(await pet.webContents.capturePage()).toPNG());
  const before=commands.length;
  // Remounting Chat must detach previous IPC listeners and never start playback.
  await js(dashboard,`location.hash='history'`);await until(dashboard,`document.body.dataset.panel==='history'`);
  await js(dashboard,`location.hash='chat'`);await until(dashboard,`!!document.querySelector('.chat-music-discuss')`);await sleep(150);
  assert.equal(commands.length,before);
  // Plain web uses the same exact-device API, with no Electron player.
  plain=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{offscreen:true,backgroundThrottling:false}});
  await plain.loadURL(base+'/#chat');await until(plain,`document.querySelector('.chat-music-title')?.textContent==='星河与晚风'`);
  await click(plain,'.chat-music-collapse');
  await click(plain,'[data-music-action="next"]');
  assert.equal(httpCommands.at(-1).body.deviceId,'remote-fixture');
  assert.equal(httpCommands.at(-1).body.action,'next');
  assert.equal(commands.length,before,'web command must not fall back to the local player');
  remoteOnline=false;await js(plain,`window.dispatchEvent(new Event('storage'))`);
  await until(plain,`document.querySelector('[data-music-action="next"]').disabled`);
  await js(plain,`document.querySelector('[data-music-action="next"]').click()`);
  assert.equal(httpCommands.length,1);
  production.exports.detachPet();pet.destroy();publish({...state,paused:false});await sleep(100);
  assert.equal(BrowserWindow.getAllWindows().length,2,'music does not resurrect a closed pet');
  console.log('MUSIC_COMPANION_UI_OK: real Chat/pet/preload/IPC, draft, sync, priority, uncertain result, web exact-device, seven themes × two widths');
}).catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{
  clearTimeout(watchdog);store.dispose();for(const win of BrowserWindow.getAllWindows())win.destroy();
  for(const socket of ws.clients)socket.terminate();ws.close();server.closeAllConnections();server.close();app.exit(process.exitCode||0);
});
