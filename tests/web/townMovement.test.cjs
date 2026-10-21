const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('../../vendor/folia/node_modules/playwright');
const web = path.resolve(__dirname, '../../web');
const hasSuibo = process.env.TOWN_TEST_PUBLIC_ASSETS_ONLY !== '1' && fs.existsSync(path.join(web, 'town/maps/suibo/source/src/core/collision.js'));
let server, browser, page;
const fixture = `<!doctype html><script type="importmap">{"imports":{"three":"/town/lib/three/build/three.module.js"}}</script>
<script type="module">
import { PerspectiveCamera } from 'three';
import { TownMotion } from '/town/player-motion.js';
import { Player } from '/town/station/src/core/player.js';
import { Physics } from '/town/station/src/core/physics.js';
${hasSuibo ? "import { CollisionWorld } from '/town/maps/suibo/source/src/core/collision.js';" : 'const CollisionWorld = null;'}
import { adaptPhysics } from '/town/maps/suibo/physics.js';
class Original extends Player { _bind() {} }
window.movementMaps = CollisionWorld ? ['station', 'suibo'] : ['station'];
window.setup = ({ original = false, map = 'station' } = {}) => {
  const world = map === 'station' ? new Physics(() => 0) : new CollisionWorld();
  const physics = map === 'station' ? world : adaptPhysics(world);
  const player = new (original ? Original : TownMotion)(new PerspectiveCamera(58), null, physics, { x0: -1000, x1: 1000, z0: -1000, z1: 1000 });
  player.enabled = true; player.setPose(0, 0);
  return { player, world, physics };
};
</script>`;

before(async () => {
  server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://fixture').pathname;
    if (name === '/') { res.setHeader('Content-Type', 'text/html'); res.end(fixture); return; }
    const file = path.resolve(web, '.' + decodeURIComponent(name));
    if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
    res.setHeader('Content-Type', 'application/javascript'); fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, args: ['--mute-audio'], executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined) });
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => !!window.setup);
});
after(async () => { await browser?.close(); server?.closeAllConnections(); await new Promise(resolve => server?.close(resolve)); });

test('running keeps a level, fixed-FOV camera; footsteps retain travel phase', async () => {
  const results = await page.evaluate(() => [true, false].map(original => {
    const { player: p } = setup({ original }); p.keys.add('KeyW'); p.keys.add('ShiftLeft');
    let minY = Infinity, maxY = -Infinity, roll = 0, fovChange = 0;
    for (let i = 0; i < 360; i++) {
      p.update(1 / 60); minY = Math.min(minY, p.camera.position.y); maxY = Math.max(maxY, p.camera.position.y);
      roll = Math.max(roll, Math.abs(p.camera.rotation.z)); fovChange = Math.max(fovChange, Math.abs(p.camera.fov - 58));
    }
    return { original, bounce: maxY - minY, roll, fovChange, phase: p.bob, speed: p.vel.length() };
  }));
  assert.ok(results[0].bounce > .04 && results[0].roll > .002, 'comparison really exercises the original camera shake');
  assert.equal(results[1].bounce, 0); assert.equal(results[1].roll, 0); assert.equal(results[1].fovChange, 0);
  assert.ok(results[1].phase > 10, 'no loss of footsteps when camera bob is removed');
  assert.ok(results[1].speed < results[0].speed);
  console.log('Camera before / after:', JSON.stringify(results));
});

test('walk, sprint, release and reverse integrate equally at 30/60/120 Hz without diagonal boost', async () => {
  const results = await page.evaluate(() => [30, 60, 120].map(fps => {
    const { player: p } = setup(), sample = [];
    for (const [keys, seconds] of [[['KeyW'], 1], [['KeyW', 'ShiftLeft'], 2], [[], .5], [['KeyS'], 1], [[], .5]]) {
      p.keys = new Set(keys);
      for (let i = 0; i < fps * seconds; i++) p.update(1 / fps);
      sample.push([p.pos.x, p.pos.z, p.vel.x, p.vel.z]);
    }
    const { player: diagonal } = setup(), { player: straight } = setup();
    diagonal.keys = new Set(['KeyW', 'KeyD']); straight.keys.add('KeyW');
    for (let i = 0; i < fps * 3; i++) { diagonal.update(1 / fps); straight.update(1 / fps); }
    return { fps, sample, diagonal: diagonal.pos.length(), straight: straight.pos.length() };
  }));
  for (const r of results) {
    assert.ok(Math.abs(r.diagonal - r.straight) < 1e-8);
    r.sample.forEach((s, i) => s.forEach((v, j) => assert.ok(Math.abs(v - results[0].sample[i][j]) < 1e-7, JSON.stringify(results))));
    assert.equal(r.sample.at(-1)[3], 0, 'no indefinite micro-sliding after release');
  }
});

test('stopping is short, sprint acceleration is continuous, turns do not leave a camera tail', async () => {
  const r = await page.evaluate(() => {
    const { player: p } = setup(); p.keys.add('KeyW');
    for (let i = 0; i < 60; i++) p.update(1 / 60);
    p.keys.add('ShiftLeft'); const speeds = [p.vel.length()];
    for (let i = 0; i < 60; i++) { p.update(1 / 60); speeds.push(p.vel.length()); }
    p.keys.clear(); const start = p.pos.z;
    for (let i = 0; i < 30; i++) p.update(1 / 60);
    const stop = Math.abs(p.pos.z - start);
    p.look.dx = Math.PI / .0022; p.update(1 / 60);
    const yaw = p.yaw; p.update(1 / 60);
    return { stop, speeds, yaw, settledYaw: p.yaw, roll: p.camera.rotation.z };
  });
  assert.ok(r.stop < .21 && r.stop > .15, JSON.stringify(r));
  r.speeds.slice(1).forEach((v, i) => { assert.ok(v >= r.speeds[i]); assert.ok(v - r.speeds[i] < .3); });
  assert.ok(Math.abs(r.yaw + Math.PI) < 1e-10); assert.equal(r.yaw, r.settledYaw); assert.equal(r.roll, 0);
});

test('available map collision engines: thin walls, sliding, corners and bounds stop stored momentum', async () => {
  const results = await page.evaluate(() => movementMaps.flatMap(map => [30, 60, 120].map(fps => {
    const { player: p, world } = setup({ map });
    world.addBox(2, 0, .1, 30, 0, -5, 5);
    p.keys = new Set(['KeyD', 'ShiftLeft']);
    for (let i = 0; i < fps * 2; i++) p.update(1 / fps);
    const wall = { x: p.pos.x, vx: p.vel.x };
    p.keys.add('KeyW');
    for (let i = 0; i < fps; i++) p.update(1 / fps);
    const slide = p.pos.toArray();
    world.addBox(0, -4, 30, .1, 0, -5, 5);
    for (let i = 0; i < fps * 3; i++) p.update(1 / fps);
    const corner = p.pos.toArray();
    p.setPose(-10, 0); p.keys = new Set(['KeyA', 'ShiftLeft']); p.bounds.x0 = -11;
    for (let i = 0; i < fps; i++) p.update(1 / fps);
    return { map, fps, wall, slide, corner, bound: p.pos.x, vx: p.vel.x };
  })));
  for (const r of results) {
    assert.ok(Math.abs(r.wall.x - 1.65) < 1e-7, JSON.stringify(r)); assert.ok(Math.abs(r.wall.vx) < 1e-6);
    assert.ok(r.slide[2] < -2 && r.slide[0] <= 1.650001, JSON.stringify(r));
    assert.ok(r.corner[0] <= 1.650001 && r.corner[2] >= -3.650001, JSON.stringify(r));
    assert.equal(r.bound, -11); assert.ok(Math.abs(r.vx) < 1e-6);
  }
});

test('stairs ease the camera, stay grounded down small steps and reject excessive rises', async () => {
  const results = await page.evaluate(() => movementMaps.flatMap(map => [30, 60, 120].map(fps => {
    const { player: p, world } = setup({ map });
    for (let i = 0; i < 3; i++) world.addWalkBox(1.5 + i, 0, 1, 8, 0, (i + 1) * .25);
    p.keys.add('KeyD'); let maxCameraStep = 0, air = 0, beforeY = p.camera.position.y, peakFeet = 0;
    const sample = () => {
      p.update(1 / fps); maxCameraStep = Math.max(maxCameraStep, Math.abs(p.camera.position.y - beforeY)); beforeY = p.camera.position.y;
      air += Number(!p.onGround); peakFeet = Math.max(peakFeet, p.pos.y);
    };
    for (let i = 0; i < fps * 5 && p.pos.x < 3.55; i++) sample();
    const reached = p.pos.x;
    p.keys = new Set(['KeyA']); for (let i = 0; i < fps * 5 && p.pos.x > .3; i++) sample();
    p.keys.clear(); for (let i = 0; i < fps; i++) sample();
    const ending = { feet: p.pos.y, eye: p.camera.position.y };
    p.setPose(0, 0); p.physics = { resolve() {}, groundHeight: x => x >= 1 ? 1 : 0 };
    p.keys = new Set(['KeyD', 'ShiftLeft']); for (let i = 0; i < fps * 2; i++) p.update(1 / fps);
    return { map, fps, maxCameraStep, air, peakFeet, ending, reached, blocked: p.pos.x };
  })));
  for (const r of results) {
    assert.equal(r.air, 0, JSON.stringify(r)); assert.equal(r.peakFeet, .75);
    assert.ok(r.reached >= 3.55, 'stair traversal really reaches the last step');
    assert.ok(r.maxCameraStep < .085, JSON.stringify(r));
    assert.equal(r.ending.feet, 0); assert.ok(Math.abs(r.ending.eye - 1.52) < .0001);
    assert.ok(r.blocked < 1, JSON.stringify(r));
  }
  console.log('Stairs:', JSON.stringify(results));
});

test('jump and landing keep gravity, reset pose clears momentum, stalled frames cannot leap ahead', async () => {
  const results = await page.evaluate(() => [30, 60, 120].map(fps => {
    const { player: p } = setup(); p.jump(); let apex = 0;
    for (let i = 0; i < fps; i++) { p.update(1 / fps); apex = Math.max(apex, p.pos.y); }
    const landed = { y: p.pos.y, grounded: p.onGround, camera: p.camera.position.y, roll: p.camera.rotation.z };
    p.keys.add('KeyW'); p.keys.add('ShiftLeft'); for (let i = 0; i < fps; i++) p.update(1 / fps);
    const start = p.pos.z; for (const dt of [NaN, Infinity, -2]) p.update(dt);
    const invalidDelta = p.pos.z - start;
    p.update(10); const stalledTravel = Math.abs(p.pos.z - start);
    p.setPose(8, 8); p.keys.clear(); p.update(1 / fps);
    const pose = p.pos.toArray();
    p.keys.add('KeyW'); p.enabled = false; p.look.dx = 500; p.update(1 / fps);
    return { fps, apex, landed, invalidDelta, stalledTravel, pose, disabledPose: p.pos.toArray(), yaw: p.yaw };
  }));
  for (const r of results) {
    assert.ok(Math.abs(r.apex - .735) < .003, JSON.stringify(r));
    assert.deepEqual(r.landed, { y: 0, grounded: true, camera: 1.52, roll: 0 });
    assert.equal(r.invalidDelta, 0); assert.ok(r.stalledTravel <= .22500001);
    assert.deepEqual(r.pose, [8, 0, 8]); assert.deepEqual(r.disabledPose, r.pose); assert.equal(r.yaw, 0);
  }
});

test('ramps remain grounded in available maps; walking off a ledge falls rather than snapping down', async () => {
  const results = await page.evaluate(() => movementMaps.map(map => {
    const { player: p, world } = setup({ map });
    world.addWalkRamp(0, 0, 4, 8, 0, 0, 2); p.setPose(0, -3.5); p.keys.add('KeyS');
    let airborne = 0;
    for (let i = 0; i < 120; i++) { p.update(1 / 60); airborne += Number(!p.onGround); }
    const ramp = { airborne, z: p.pos.z, y: p.pos.y };
    p.physics = { resolve() {}, groundHeight: x => x < 1 ? 2 : 0 };
    p.setPose(0, 0); p.keys = new Set(['KeyD']); let firstFall;
    for (let i = 0; i < 180; i++) {
      p.update(1 / 60);
      if (!p.onGround && !firstFall) firstFall = { y: p.pos.y, vy: p.vy, cameraY: p.camera.position.y };
    }
    return { map, ramp, firstFall, finalY: p.pos.y };
  }));
  for (const r of results) {
    assert.equal(r.ramp.airborne, 0); assert.ok(r.ramp.z > 1); assert.ok(r.ramp.y > 1);
    assert.ok(r.firstFall.y > 1.9 && r.firstFall.vy < 0, JSON.stringify(r));
    assert.ok(Math.abs(r.firstFall.cameraY - r.firstFall.y - 1.52) < 1e-8);
    assert.equal(r.finalY, 0);
  }
});

test('touch sprint has no threshold jump, and idle motion adds no substep workload', async () => {
  const r = await page.evaluate(() => {
    const speeds = [.94, .95, .96].map(strength => {
      const { player: p } = setup(); p.touchMove.set(0, -strength);
      for (let i = 0; i < 180; i++) p.update(1 / 60);
      return p.vel.length();
    });
    const { player: p } = setup(); let queries = 0;
    p.physics = { resolve() { queries++; }, groundHeight: () => 0 };
    for (let i = 0; i < 60; i++) p.update(1 / 60);
    return { speeds, queries, phase: p.bob };
  });
  assert.ok(r.speeds[1] - r.speeds[0] < .15 && r.speeds[2] - r.speeds[1] < .15, JSON.stringify(r));
  assert.equal(r.queries, 60); assert.equal(r.phase, 0);
});
