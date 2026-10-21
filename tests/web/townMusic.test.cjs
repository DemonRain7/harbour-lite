const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('../../vendor/folia/node_modules/playwright');
const { townAudioFixture } = require('./town-audio-fixture.cjs');
const web = path.resolve(__dirname, '../../web');
const song = path.join(web, 'town/audio/local/lingering-summer-light.m4a');
let server, browser, url;
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/test') return res.setHeader('Content-Type', 'text/html').end(`<!doctype html><button id="play">play</button><script type="module">
      import { withTownMusic } from '/town/background-music.js';
      window.elements=[]; window.revoked=[]; window.loops=[]; window.failure=''; window.playAttempts=0;
      const RealAudio=window.Audio, revoke=URL.revokeObjectURL;
      window.Audio=function(){const el=new RealAudio(); elements.push(el);
        if(window.denyPlay) el.play=()=>{playAttempts++;return Promise.reject(new DOMException('blocked','NotAllowedError'));};
        return el;};
      URL.revokeObjectURL=u=>{revoked.push(u);revoke.call(URL,u)};
      window.ambient={muted:true,context:null,start(){this.context ||= new AudioContext();return this.context.resume();},loop(name){loops.push(name)}};
      window.audio=withTownMusic(ambient,{suppressCafeMusic:true});
      document.querySelector('#play').onclick=async()=>{try{await audio.start();audio.muted=false;audio.resumeMedia();}catch(e){failure=e.message}};
    </script>`);
    const file = path.resolve(web, '.' + new URL(req.url, 'http://local').pathname);
    if (!file.startsWith(web + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : 'audio/mp4');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--mute-audio'],
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined) });
});
after(async () => { await browser?.close(); server?.closeAllConnections(); server?.close(); });
async function pageFor(t) {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.goto(url + '/test'); await page.waitForFunction(() => !!window.audio); return page;
}

test('one authenticated track, preserved playhead, mute/hidden pause and disposal', async t => {
  const page = await pageFor(t), requests = [];
  await page.route('**/town/audio/local/*', route => {
    requests.push({ url: route.request().url(), headers: route.request().headers() });
    return route.fulfill({ contentType: 'audio/wav', body: townAudioFixture(8) });
  });
  assert.equal(requests.length, 0, 'no music download before sound is enabled');
  await page.evaluate(() => localStorage.setItem('harbour-token', 'test-only'));
  await page.locator('#play').click();
  await page.waitForFunction(() => audio.mediaStatus().playing === 1 && audio.mediaStatus().musicTime > .2);
  assert.equal(requests.length, 1); assert.equal(requests[0].headers['x-harbour-token'], 'test-only');
  assert.ok(!requests[0].url.includes('test-only'));
  assert.deepEqual(await page.evaluate(() => ({ title:audio.mediaStatus().music, count:elements.length, loop:elements[0].loop })), { title: '不散的夏之灯', count: 1, loop: true });
  await page.evaluate(async () => { audio.pauseMedia(); await audio.context.suspend(); });
  const position = await page.evaluate(() => audio.mediaStatus().musicTime);
  await page.waitForTimeout(180);
  assert.equal(await page.evaluate(() => audio.mediaStatus().playing), 0);
  assert.ok(Math.abs(await page.evaluate(() => audio.mediaStatus().musicTime) - position) < .02);
  await page.evaluate(async () => { audio.resumeMedia(); await audio.context.resume(); });
  await page.waitForFunction(p => audio.mediaStatus().musicTime > p + .15, position);
  await page.evaluate(() => { audio.muted = true; });
  assert.equal(await page.evaluate(() => audio.mediaStatus().playing), 0);
  await page.evaluate(() => { audio.muted = false; });
  await page.waitForFunction(() => audio.mediaStatus().playing === 1);
  await page.locator('#play').click(); assert.equal(requests.length, 1);
  await page.evaluate(() => { audio.loop('cafeMusic', {}); audio.loop('wind', {}); audio.disposeMedia(); audio.disposeMedia(); });
  assert.deepEqual(await page.evaluate(() => loops), ['wind']);
  assert.deepEqual(await page.evaluate(() => ({ playing:audio.mediaStatus().playing, revoked:revoked.length, src:elements[0].getAttribute('src') })), { playing: 0, revoked: 1, src: null });
});

test('missing assets fail clearly; a later explicit activation may retry', async t => {
  const page = await pageFor(t); let count = 0;
  await page.route('**/town/audio/local/*', route => ++count === 1 ? route.fulfill({ status:404 }) : route.fulfill({ contentType:'audio/wav', body:townAudioFixture() }));
  await page.locator('#play').click(); await page.waitForFunction(() => failure.includes('404'));
  await page.waitForTimeout(100); assert.equal(count, 1);
  assert.equal(await page.evaluate(() => audio.context.state), 'suspended', 'failed startup does not leave background audio processing');
  await page.locator('#play').click(); await page.waitForFunction(() => audio.mediaStatus().playing === 1);
  assert.equal(count, 2);
});

test('late loading cannot start a disposed scene', async t => {
  const page = await pageFor(t); let release;
  await page.route('**/town/audio/local/*', async route => { await new Promise(resolve => { release=resolve; }); await route.fulfill({ contentType:'audio/wav', body:townAudioFixture() }).catch(() => {}); });
  // Activate the document's audio context without starting the music request yet.
  await page.locator('#play').evaluate(el => { el.onclick=()=>ambient.start(); }); await page.locator('#play').click();
  await page.evaluate(() => { window.starting=audio.start().catch(e => { failure=e.name; }); });
  const deadline = Date.now() + 5000;
  while (!release && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(release, 'music request began');
  await page.evaluate(() => { audio.pauseMedia(); audio.disposeMedia(); }); release();
  await page.waitForFunction(() => !!failure);
  assert.equal(await page.evaluate(() => audio.mediaStatus().playing), 0);
  assert.equal(await page.evaluate(() => elements.length), 0);
});

test('autoplay refusal is not retried on repeated lifecycle signals', async t => {
  const page = await pageFor(t);
  await page.route('**/town/audio/local/*', route => route.fulfill({ contentType:'audio/wav', body:townAudioFixture() }));
  await page.evaluate(() => { window.denyPlay=true; }); await page.locator('#play').click();
  await page.waitForFunction(() => audio.mediaStatus().musicError);
  await page.evaluate(() => { for(let i=0;i<30;i++) audio.resumeMedia(); });
  assert.equal(await page.evaluate(() => playAttempts), 1);
});

test('invalid audio reports a decode error and releases its blob', async t => {
  const page = await pageFor(t);
  await page.route('**/town/audio/local/*', route => route.fulfill({ contentType:'audio/mp4', body:'not an audio file' }));
  await page.locator('#play').click(); await page.waitForFunction(() => failure.includes('无法解码'));
  assert.equal(await page.evaluate(() => revoked.length), 1);
  assert.equal(await page.evaluate(() => audio.mediaStatus().playing), 0);
});

test('local original is unchanged and Chrome decodes and loops the complete 5:13 song', { skip: !fs.existsSync(song) }, async t => {
  const bytes=fs.readFileSync(song);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '903a17474ff305effcb4ae26bbea21cf3a829a1eadc0cd6db903ac154cc2a20e');
  assert.deepEqual(bytes, fs.readFileSync(path.resolve(web, '../assets/town/local/music/lingering-summer-light/original.m4a')));
  const page=await pageFor(t); await page.locator('#play').click();
  await page.waitForFunction(() => audio.mediaStatus().playing === 1 && audio.mediaStatus().musicTime > .1);
  const duration=await page.evaluate(() => audio.mediaStatus().musicDuration);
  assert.ok(duration > 312 && duration < 314, String(duration));
  await page.evaluate(() => { elements[0].currentTime=elements[0].duration-.15; });
  await page.waitForFunction(() => audio.mediaStatus().musicTime < 1 && audio.mediaStatus().playing === 1);
});
