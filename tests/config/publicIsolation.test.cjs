const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {initializeDesktopStorage}=require('../../desktop/companion/runtime-storage');
const root=path.resolve(__dirname,'../..');

test('public desktop starts with its own empty store instead of migrating legacy data',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'harbour-public-isolation-'));
  try{
    const repo=path.join(temp,'checkout'),appData=path.join(temp,'appdata');
    const old=path.join(appData,'HarbourPublic');
    fs.mkdirSync(repo,{recursive:true});fs.mkdirSync(old,{recursive:true});
    fs.writeFileSync(path.join(repo,'package.json'),JSON.stringify({name:'harbour'}));
    fs.writeFileSync(path.join(old,'private-cookie'),'do-not-import');
    const paths={userData:old,appData};
    const app={getPath:key=>paths[key],setPath:(key,value)=>paths[key]=value,getName:()=> 'HarbourPublic'};
    const env={LOCALAPPDATA:appData};
    const data=initializeDesktopStorage(app,{repoRoot:repo,env});
    assert.equal(data,path.join(repo,'data','runtime'));
    assert.equal(paths.userData,path.join(data,'electron'));
    assert.equal(fs.existsSync(path.join(paths.userData,'private-cookie')),false);
    assert.equal(fs.readFileSync(path.join(old,'private-cookie'),'utf8'),'do-not-import');
  }finally{
    assert.equal(path.dirname(temp),os.tmpdir());
    assert.ok(path.basename(temp).startsWith('harbour-public-isolation-'));
    fs.rmSync(temp,{recursive:true,force:true});
  }
});

test('only a neutral assistant ships, private packs are absent and theme styles remain',()=>{
  const names=fs.readdirSync(path.join(root,'agents')).filter(n=>fs.existsSync(path.join(root,'agents',n,'CLAUDE.md')));
  assert.deepEqual(names,['main-assistant']);
  for(const name of ['MASTER.md','PREFERENCE.md','MEMORY.md'])assert.equal(fs.existsSync(path.join(root,'agents/main-assistant',name)),false);
  for(const dir of ['workflows','mcp'])assert.equal(fs.existsSync(path.join(root,dir)),false);
  for(const file of ['web/themes.css','web/chat-composer.css','web/chat-hero.css','desktop/renderer/startup.css'])assert.ok(fs.statSync(path.join(root,file)).size>0);
  const env=fs.readFileSync(path.join(root,'.env.example'),'utf8');
  assert.match(env,/HARBOUR_MIGRATE_LEGACY=false/);assert.match(env,/MOCK_LLM=true/);
});
