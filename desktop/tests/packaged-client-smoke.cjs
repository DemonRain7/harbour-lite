const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');

// Launch the actual application entry/preload, with an isolated HTTP fixture and
// userData. No backend, owner credentials, live model calls or production process.
async function run() {
  const desktop = path.resolve(__dirname, '..');
  const source = process.argv.includes('--source');
  const binary = source ? require('electron') : process.platform === 'darwin'
    ? path.join(desktop, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Harbour.app/Contents/MacOS/Harbour')
    : path.join(desktop, 'dist/win-unpacked/Harbour.exe');
  assert.ok(fs.existsSync(binary), `Missing application binary: ${binary}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-packaged-client-'));
  const reportPath = `/result-${randomUUID()}`;
  let finish, fail;
  const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const html = `<!doctype html><html><head><title>Harbour packaged fixture</title></head><body><h1>Packaged client check</h1><script>
    (async () => {
      const api = window.harbourDesktop;
      if (!api?.isElectron) throw new Error('Packaged preload is unavailable');
      api.onBeforeClose(() => true);
      const initial = await api.foliaStatus();
      if (!initial.available) throw new Error('Packaged Folia resources missing');
      const embedded = await api.foliaOpen('embedded', {x:10,y:60,width:800,height:500});
      if (embedded.mode !== 'embedded') throw new Error('Embedded presentation failed');
      const volume = await api.foliaCommand({action:'set_volume',volume:0});
      if (volume.volume !== 0) throw new Error('Packaged player bridge failed');
      const standalone = await api.foliaOpen('window');
      if (standalone.mode !== 'window') throw new Error('Standalone presentation failed');
      await api.foliaOpen('remote');
      await api.foliaCommand({action:'close'});
      const closed = await api.foliaStatus();
      if (closed.running) throw new Error('Packaged music did not close');
      return {ok:true, preload:true, folia:true, presentations:['embedded','window','remote']};
    })().then(result => fetch(${JSON.stringify(reportPath)}, {method:'POST',body:JSON.stringify(result)}))
      .catch(error => fetch(${JSON.stringify(reportPath)}, {method:'POST',body:JSON.stringify({ok:false,error:String(error.stack || error)})}));
  </script></body></html>`;
  const server = createServer((req, res) => {
    if (req.url === reportPath && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 16384) req.destroy(); });
      req.on('end', () => {
        try { const result = JSON.parse(body); result.ok ? finish(result) : fail(new Error(result.error)); }
        catch (error) { fail(error); }
        res.end('ok');
      });
      return;
    }
    if (req.url?.startsWith('/api/')) {
      res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true})); return;
    }
    res.writeHead(200, {'Content-Type':'text/html'}); res.end(html);
  });
  const ws = new WebSocketServer({server});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const config = path.join(temp, 'config.json');
  fs.writeFileSync(config, JSON.stringify({url,spawn:false,pet:false}));
  const env = {...process.env, HARBOUR_URL:url, HARBOUR_CONFIG:config, HARBOUR_DATA_HOME:path.join(temp,'data'),
    HARBOUR_SPAWN:'0', HARBOUR_PET:'0', HARBOUR_TOKEN:'', HARBOUR_LIVE2D_AUTO_INSTALL:'0'};
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, [...(source ? [desktop] : []), `--user-data-dir=${path.join(temp,'electron')}`],
    {cwd:temp,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output = '';
  const collect = chunk => { output = (output + chunk.toString()).slice(-20000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  child.once('error', fail);
  child.once('exit', (code, signal) => fail(new Error(`Application exited before completion: ${code ?? signal}`)));
  const deadline = setTimeout(() => fail(new Error('Packaged client startup timed out')), 90_000);
  try {
    const result = await completed;
    console.log(JSON.stringify({status:source ? 'SOURCE_CLIENT_ENTRY_OK' : 'PACKAGED_CLIENT_ENTRY_OK', platform:process.platform, arch:process.arch, ...result}));
  } catch (error) { console.error(output); throw error; }
  finally {
    clearTimeout(deadline);
    // Only terminate the child this fixture created; production apps are never enumerated.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    for (const socket of ws.clients) socket.terminate();
    ws.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
