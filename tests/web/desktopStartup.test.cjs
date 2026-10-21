const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname,'../../web/desktop-startup.js'),'utf8');
function fixture(startup=true) {
  const sent=[],status=[],frames=[],rect={x:270,y:100,width:900,height:650}; let entered;
  const window={harbourDesktop:{startup,startupReady:p=>sent.push(p),startupStatus:r=>status.push(r),onStartupEntered:fn=>{entered=fn;}},addEventListener(){}};
  const context=vm.createContext({window,document:{body:{dataset:{panel:'chat'}},querySelector:()=>({getBoundingClientRect:()=>rect}),getElementById:()=>({})},
    requestAnimationFrame:fn=>frames.push(fn),getComputedStyle:()=>({borderTopLeftRadius:'24px',backgroundColor:'rgb(255, 250, 252)',borderTopColor:'#eadfea'}),matchMedia:()=>({matches:false})});
  vm.runInContext(source,context);
  return {sent,status,frames,window,context,gate:window.HarbourStartupGate,enter:()=>entered(),paint:()=>{while(frames.length)frames.shift()();}};
}
test('all four independent acknowledgements and a painted layout are required',()=>{
  const f=fixture();
  for(const key of ['ui','models','sessions'])f.gate.mark(key);
  f.paint();assert.equal(f.sent.length,0);
  f.gate.mark('live');assert.equal(f.sent.length,0);f.paint();assert.equal(f.sent.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.sent[0].target)),{x:270,y:100,width:900,height:650,radius:24});
  f.gate.mark('live');f.paint();assert.equal(f.sent.length,1);
});
test('disconnect cancels queued readiness and can renegotiate until native handoff',()=>{
  const f=fixture();for(const key of ['ui','models','sessions','live'])f.gate.mark(key);
  f.gate.disconnected();f.paint();assert.equal(f.sent.length,0);
  f.gate.mark('live');f.paint();assert.equal(f.sent.length,1);
  f.gate.disconnected();f.gate.mark('live');f.paint();assert.equal(f.sent.length,2);
  f.enter();f.gate.disconnected();f.gate.mark('live');f.paint();assert.equal(f.sent.length,2);
});
test('authentication failure cannot be disguised as a generic error or ready',()=>{
  const f=fixture();f.gate.failed('auth');f.gate.failed('data');
  for(const key of ['ui','models','sessions','live'])f.gate.mark(key);
  f.paint();assert.equal(f.sent.length,0);assert.deepEqual(f.status,['auth','auth']);
});
test('normal browser/refresh is a no-op; non-chat routes cannot be presented as ready Main Chat',()=>{
  assert.equal(fixture(false).gate,undefined);
  const f=fixture();f.context.document.body.dataset.panel='history';
  for(const key of ['ui','models','sessions','live'])f.gate.mark(key);
  f.paint();assert.equal(f.sent.length,0);
});
