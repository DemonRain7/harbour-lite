const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('../../vendor/folia/node_modules/playwright');
const web = path.resolve(__dirname, '../../web');
let server, browser, url;

// The real TownPlayer and browser Pointer Lock, without loading the town/GPU,
// models, backend, account, or the user's current browser/window.
const fixture = `<!doctype html><meta charset="utf-8"><style>body{margin:0}canvas{display:block;width:700px;height:450px;background:#eee}</style>
<script type="importmap">{"imports":{"three":"/town/lib/three/build/three.module.js"}}</script>
<canvas tabindex="0"></canvas><input aria-label="聊天" />
<script type="module">
import { PerspectiveCamera } from 'three';
import { TownPlayer } from '/town/player.js';
window.lifetime = new AbortController(); window.states = [];
window.player = new TownPlayer(new PerspectiveCamera(), document.querySelector('canvas'), { groundHeight: () => 0, resolve() {} }, { x0: -100, x1: 100, z0: -100, z1: 100 }, lifetime.signal, state => states.push(state));
player.enabled = true;
</script>`;

before(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(fixture); return; }
    const file = path.resolve(web, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'application/javascript'); fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined) });
});
after(async () => { await browser?.close(); server?.closeAllConnections(); await new Promise(resolve => server?.close(resolve)); });

async function pageFor(t) {
  const context = await browser.newContext({ viewport: { width: 900, height: 600 } });
  t.after(() => context.close());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(url); await page.waitForFunction(() => !!window.player);
  return page;
}

test('Alt releases real pointer lock, clears movement, and waits for a click to resume', async t => {
  const page = await pageFor(t);
  await page.locator('canvas').click();
  await page.waitForFunction(() => player.pointerLocked);
  await page.keyboard.down('w');
  assert.equal(await page.evaluate(() => player.keys.has('KeyW')), true);
  await page.keyboard.press('Alt');
  await page.waitForFunction(() => !document.pointerLockElement && player.cursorReleased && !player.pointerLocked);
  await page.keyboard.up('w');
  await page.mouse.move(698, 200); await page.mouse.move(1, 200);
  await page.keyboard.press('w');
  assert.deepEqual(await page.evaluate(() => { player.applyEdgeLook(1); return { look: player.look, keys: [...player.keys], last: states.at(-1) }; }),
    { look: { dx: 0, dy: 0 }, keys: [], last: { locked: false, released: true } });
  await page.locator('canvas').click();
  await page.waitForFunction(() => player.pointerLocked && !player.cursorReleased);
  await page.mouse.move(600, 250);
  assert.notEqual(await page.evaluate(() => player.look.dx), 0);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.pointerLockElement && player.cursorReleased);
});

test('Alt also suspends hover/edge look, but does not consume modified keys or text input', async t => {
  const page = await pageFor(t);
  await page.locator('canvas').focus();
  await page.mouse.move(698, 200);
  assert.notEqual(await page.evaluate(() => { player.applyEdgeLook(1); return player.look.dx; }), 0);
  await page.keyboard.press('Alt');
  assert.equal(await page.evaluate(() => player.cursorReleased), true);
  assert.equal(await page.evaluate(() => { player.applyEdgeLook(1); return player.look.dx; }), 0);
  const keys = await page.evaluate(() => {
    player.cursorReleased = false;
    const target = document.querySelector('canvas');
    return [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }].map(modifiers => {
      const event = new KeyboardEvent('keydown', { code: 'AltRight', key: 'Alt', bubbles: true, cancelable: true, ...modifiers });
      target.dispatchEvent(event); return [event.defaultPrevented, player.cursorReleased];
    });
  });
  assert.deepEqual(keys, [[false, false], [false, false], [false, false]]);
  await page.getByLabel('聊天').focus(); await page.keyboard.press('Alt'); await page.keyboard.type('WASD');
  assert.equal(await page.getByLabel('聊天').inputValue(), 'WASD');
  assert.equal(await page.evaluate(() => player.cursorReleased), false);
  assert.deepEqual(await page.evaluate(() => [...player.keys]), []);
});

test('a delayed lock request cannot recapture after Alt; teardown removes the key listener', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas'); let held = null;
    Object.defineProperty(document, 'pointerLockElement', { get: () => held });
    document.exitPointerLock = () => { held = null; document.dispatchEvent(new Event('pointerlockchange')); };
    canvas.requestPointerLock = () => new Promise(resolve => { window.finishLock = () => { held = canvas; document.dispatchEvent(new Event('pointerlockchange')); resolve(); }; });
  });
  await page.locator('canvas').click(); await page.waitForFunction(() => !!window.finishLock);
  await page.keyboard.press('Alt'); await page.evaluate(() => finishLock());
  await page.waitForFunction(() => !document.pointerLockElement && player.cursorReleased && !player.pointerLocked);
  assert.equal(await page.evaluate(() => {
    lifetime.abort(); player.cursorReleased = false;
    const event = new KeyboardEvent('keydown', { code: 'AltLeft', key: 'Alt', bubbles: true, cancelable: true });
    document.querySelector('canvas').dispatchEvent(event); return event.defaultPrevented || player.cursorReleased;
  }), false);
});

test('unavailable pointer lock still permits the existing hover/edge fallback', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => { document.querySelector('canvas').requestPointerLock = () => Promise.reject(new Error('fixture denied')); });
  await page.locator('canvas').click(); await page.waitForFunction(() => states.at(-1)?.unavailable);
  await page.mouse.move(698, 200);
  assert.notEqual(await page.evaluate(() => { player.applyEdgeLook(1); return player.look.dx; }), 0);
  assert.equal(await page.evaluate(() => player.cursorReleased), false);
});

test('cursor release and blur discard running momentum; held Space cannot bounce on landing', async t => {
  const page = await pageFor(t);
  await page.locator('canvas').focus(); await page.keyboard.down('Shift'); await page.keyboard.down('w');
  await page.evaluate(() => { for (let i = 0; i < 60; i++) player.update(1 / 60); });
  assert.ok(await page.evaluate(() => player.vel.length() > 4));
  await page.keyboard.up('Shift'); // Bare Alt, not the OS's Shift+Alt shortcut.
  await page.keyboard.press('Alt');
  const p = await page.evaluate(() => player.pos.toArray());
  await page.evaluate(() => { for (let i = 0; i < 30; i++) player.update(1 / 60); });
  assert.deepEqual(await page.evaluate(() => player.pos.toArray()), p);
  await page.keyboard.up('w'); await page.keyboard.up('Shift');
  await page.evaluate(() => { player.cursorReleased = false; player.jump(); for (let i = 0; i < 60; i++) player.update(1 / 60); });
  await page.locator('canvas').dispatchEvent('keydown', { code: 'Space', repeat: true, bubbles: true });
  assert.equal(await page.evaluate(() => player.vy), 0, 'held key repeats must not start another jump');
  await page.keyboard.down('w'); await page.evaluate(() => player.update(.05));
  await page.evaluate(() => dispatchEvent(new Event('blur')));
  assert.equal(await page.evaluate(() => player.vel.length()), 0);
});

test('edge rotation eases in consistently at 30/60/120 Hz and stops on leaving the edge', async t => {
  const page = await pageFor(t), yaw = [];
  for (const fps of [30, 60, 120]) {
    await page.evaluate(() => { player.resetInput(); player.setPose(0, 0); });
    await page.locator('canvas').dispatchEvent('pointermove', { pointerType: 'mouse', clientX: 699, clientY: 200 });
    yaw.push(await page.evaluate(fps => { for (let i = 0; i < fps * 3; i++) player.update(1 / fps); return player.yaw; }, fps));
    await page.locator('canvas').dispatchEvent('pointermove', { pointerType: 'mouse', clientX: 350, clientY: 200 });
    const end = await page.evaluate(() => { player.update(1 / 60); return player.yaw; });
    await page.evaluate(() => { for (let i = 0; i < 30; i++) player.update(1 / 60); });
    assert.equal(await page.evaluate(() => player.yaw), end);
  }
  for (const angle of yaw) { assert.ok(Math.abs(angle) > Math.PI); assert.ok(Math.abs(angle - yaw[0]) < 1e-8); }
});
