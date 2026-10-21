const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const app = fs.readFileSync(path.join(__dirname, '../../web/app.js'), 'utf8');
const names = ['channelStopButtonHtml', 'stopChannelRun', 'channelRunMessages', 'handleChannelActivity', 'pushTraceEvent'];
const source = names.map(name => {
  const match = app.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^}`, 'm'));
  assert.ok(match, name); return match[0];
}).join('\n');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise, resolve, reject}; };
function fixture() {
  const chat = { channelRuns: {}, sessionId:'W', activeRunId:'local', running:true, inspection:{}, trace:[], abort:{abort(){throw new Error('must not abort local Web run');}} };
  let viewed = 'Q'; const renders=[], notices=[], reloads=[], calls=[];
  const ctx = vm.createContext({ state:{chat}, AbortSignal, Date, console, clearTimeout,
    viewedChatSessionId:()=>viewed, renderSelectedChannelRuns:()=>renders.push(viewed),
    inspectChatSession:async id=>reloads.push(id), loadConversationMessages:async id=>reloads.push(id),
    toast:message=>notices.push(message), esc:s=>String(s).replaceAll('"','&quot;'),
    updateChannelRunDom(){}, isCoworkTraceEvent:()=>false,
    appendRoutedTrace:(trace,subs,obj)=>{ const ev={tag:'THINK', text:obj.preview};trace.push(ev);return ev; },
    api:async(url,opts)=>{ calls.push({url,body:JSON.parse(opts.body)});return {status:'stopping',runId:'qq',sessionId:'Q'}; },
  });
  vm.runInContext(source,ctx);
  const emit=(id='qq',sessionId='Q',extra={})=>ctx.handleChannelActivity({runId:id,sessionId,phase:'running',source:{platform:'qq'},canStop:true,...extra});
  emit(); emit('discord','D');
  return {ctx,chat,renders,notices,reloads,calls,emit,view:(id)=>{viewed=id;}};
}
async function main(){
  let f=fixture();
  assert.match(f.ctx.channelStopButtonHtml('qq'), /data-channel-stop="qq"[\s\S]*data-stop-session="Q"/);
  f.emit('legacy','Q',{canStop:undefined}); assert.equal(f.ctx.channelStopButtonHtml('legacy'),'');
  await f.ctx.stopChannelRun('qq','D'); await f.ctx.stopChannelRun('discord','D'); assert.equal(f.calls.length,0);
  const gate=deferred();
  f.ctx.api=(url,opts)=>{f.calls.push({url,body:JSON.parse(opts.body)});return gate.promise;};
  const stop=f.ctx.stopChannelRun('qq','Q');
  await f.ctx.stopChannelRun('qq','Q');
  assert.equal(f.calls.length,1,'double click sends once'); assert.equal(f.chat.channelRuns.qq.stopPending,true);
  assert.match(f.ctx.channelStopButtonHtml('qq'), /disabled/);
  f.view('D'); const count=f.renders.length;
  gate.resolve({status:'stopping',runId:'qq',sessionId:'Q'}); await stop;
  assert.equal(f.renders.length,count,'late reply must not re-render a different session');
  assert.equal(f.chat.activeRunId,'local'); assert.equal(f.chat.running,true); assert.equal(f.chat.channelRuns.discord.stopping,undefined);
  assert.equal(f.chat.channelRuns.qq.stopping,true);
  assert.equal(f.calls[0].url,'/api/channel-runs/qq/abort'); assert.deepEqual(f.calls[0].body,{sessionId:'Q'});
  f.emit('qq','Q',{phase:'stopping'});
  f.ctx.pushTraceEvent({runId:'qq',agent:'main-fixture',msg:'loop:thinking',preview:'late child trace'});
  assert.equal(f.chat.channelRuns.qq.activity,'正在中止并保存断点…');
  assert.equal(f.ctx.channelRunMessages('Q').filter(m=>m.externalRunId==='qq').length,2,'stopping does not erase the live transcript');

  f=fixture();const raced=deferred();f.ctx.api=()=>raced.promise;
  const late=f.ctx.stopChannelRun('qq','Q'); f.ctx.handleChannelActivity({runId:'qq',phase:'cancelled'});
  raced.resolve({status:'stopping',runId:'qq',sessionId:'Q'});await late;
  assert.equal(f.chat.channelRuns.qq,undefined,'terminal before acknowledgement must not resurrect run');
  assert.deepEqual(f.reloads,['Q']);

  f=fixture();f.ctx.api=async()=>{throw Object.assign(new Error('not active'),{status:404,code:'RUN_NOT_ACTIVE'});};
  await f.ctx.stopChannelRun('qq','Q');assert.equal(f.chat.channelRuns.qq,undefined);assert.deepEqual(f.reloads,['Q']);
  f=fixture();f.ctx.api=async()=>{throw new Error('connection lost');};await f.ctx.stopChannelRun('qq','Q');
  assert.equal(f.chat.channelRuns.qq.stopPending,false); assert.equal(f.chat.channelRuns.qq.stopping,undefined);
  assert.match(f.chat.channelRuns.qq.activity,/尚未确认/);assert.doesNotMatch(f.ctx.channelStopButtonHtml('qq'),/disabled/);
  f.emit('qq','Q',{phase:'stopping'});assert.match(f.ctx.channelStopButtonHtml('qq'),/disabled/);
  f=fixture();f.ctx.api=async()=>({status:'stopping',runId:'other',sessionId:'D'});await f.ctx.stopChannelRun('qq','Q');
  assert.equal(f.chat.channelRuns.qq.stopping,undefined);assert.match(f.notices[0],/回执不匹配/);
  f=fixture();f.emit('web-resumed','Q',{source:{platform:'web'}});
  f.ctx.api=async(url,opts)=>{f.calls.push({url,body:JSON.parse(opts.body)});return {status:'stopping',runId:'web-resumed',sessionId:'Q'};};
  await f.ctx.stopChannelRun('web-resumed','Q');
  assert.equal(f.calls[0].url,'/api/runs/web-resumed/abort'); assert.equal(f.chat.channelRuns['web-resumed'].stopping,true);
  assert.equal(f.chat.activeRunId,'local','refreshed Web task STOP must not target a different local run');
  console.log('PASS channel UI stop: exact identity, cross-session/local-run isolation, duplicate clicks, late HTTP/WS, reconnect, errors, unavailable handles and receipt checks');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
