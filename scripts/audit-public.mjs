import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024}).split('\0'))]
  .filter(p=>p&&fs.existsSync(path.join(root,p))&&fs.statSync(path.join(root,p)).isFile());
const findings=[];
for(const file of files){
  if(/^(?:data|assets|\.local|\.claude|\.codex|node_modules)\//.test(file)
    ||/(?:^|\/)(?:MASTER|PREFERENCE|MEMORY)\.md$/i.test(file)
    ||/^(?:agents\/[^/]+\/inbox\/|\.env$|desktop\/(?:config|startup\.config)\.json$)/.test(file)){
    findings.push({file,reason:'private runtime path'});continue;
  }
  if(!/\.(?:[cm]?js|ts|tsx|jsx|json|html|css|md|yaml|yml|txt|toml)$/.test(file)||file.endsWith('lock.json'))continue;
  // Third-party fixtures retain their own sample names and licensing. Check them separately.
  if(file.startsWith('vendor/'))continue;
  const text=fs.readFileSync(path.join(root,file),'utf8');
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))findings.push({file,reason:'private key material'});
  if(/C:[\\/]+Users[\\/]+\d{5,}[\\/]+/i.test(text))findings.push({file,reason:'personal absolute home path'});
  if(/\b(?:sk-ant-api\d{2}-|AIza)[A-Za-z0-9_-]{24,}/.test(text))findings.push({file,reason:'possible API credential'});
}
const privateRoots=['assets/Memory','assets/sessions','assets/uploads','agents/main-elaina','agents/main-aemeath','agents/main-winefox','workflows','mcp'];
for(const dir of privateRoots){
  if(files.some(file=>file.startsWith(dir+'/')))findings.push({file:dir,reason:'unexpected private capability or state'});
}
console.log(JSON.stringify({checkedFiles:files.length,findings,note:'Pattern checks are not a complete security or licensing review.'},null,2));
if(findings.length)process.exitCode=1;
