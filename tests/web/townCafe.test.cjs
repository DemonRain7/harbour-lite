const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('../../vendor/folia/node_modules/playwright');
const web = path.resolve(__dirname, '../../web');

test('both real café collision maps: in-room spawns, sustained patrol, furniture and mutual avoidance', { timeout: 180000 }, async t => {
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://local').pathname;
    if (name === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<canvas></canvas><script type="importmap">{"imports":{"three":"/town/lib/three/build/three.module.js","three/addons/":"/town/lib/three/examples/jsm/"}}</script>'); return; }
    const file = path.resolve(web, '.' + decodeURIComponent(name));
    if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : 'application/octet-stream'); fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined) });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/**', route => { errors.push('Unexpected API call'); return route.abort(); });
  for (const map of ['station', ...(fs.existsSync(path.join(web, 'town/maps/suibo/source/src/core/env.js')) ? ['suibo'] : [])]) {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const result = await page.evaluate(async map => {
      const THREE = await import('three');
      const { createMap } = await import(`/town/maps/${map}.js`);
      const { MAPS } = await import('/town/maps.js');
      const { TownPlayer } = await import('/town/player.js');
      const { movingResident } = await import('/town/residents.js');
      const { createPatrolGraph } = await import('/town/resident-behavior.js');
      const { createCompanionNavigator } = await import('/town/companion-navigation.js');
      const { TownSocial } = await import('/town/social-state.js');
      const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(58, 1, .1, 1000);
      const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector('canvas') }); renderer.setSize(128, 128);
      const env = createMap({ scene, camera, renderer, quality: { name: 'low', pixelRatio: .5, shadowMap: 512, shadowSize: 45, petals: 0, msaa: 0 } });
      const signal = new AbortController().signal;
      env.ctx.playerObj = new TownPlayer(camera, renderer.domElement, env.ctx.physics, env.bounds, signal);
      await env.build(() => {}, signal);
      if (map === 'suibo') {
        const spawn = env.spawn, feet = env.ctx.physics.groundHeight(spawn.x, spawn.z, spawn.groundHint);
        if (Math.abs(feet - .35) > .01) throw new Error('Suibo spawn is not on the café floor');
        const probe = { x: spawn.x, z: spawn.z }; env.ctx.physics.resolve(probe, .3, feet, 1.7);
        if (Math.hypot(probe.x - spawn.x, probe.z - spawn.z) > .001) throw new Error('Café spawn intersects furniture or a wall');
        if (MAPS[map].residents.some(r => Math.hypot(r.x - spawn.x, r.z - spawn.z) < .9)) throw new Error('Café spawn overlaps a resident');
      }
      const residents = [], activity = {};
      env.ctx.townBounds = env.bounds;
      for (const def of MAPS[map].residents) residents.push(movingResident(env.ctx, def, activity, residents));
      env.ctx.player.position.set(0, 0, 0);
      let minDistance = Infinity, collisions = 0, escaped = 0;
      const distance = residents.map(() => 0), perMinute = Array.from({ length: 3 }, () => residents.map(() => 0)), modes = residents.map(() => new Set()), positions = residents.map(() => new Set());
      const start = residents.map(r => r.behavior.snapshot());
      for (let tick = 0; tick < 3600; tick++) {
        for (const [i, r] of residents.entries()) {
          const oldX = r.x, oldZ = r.z, s = r.behavior.update(.05, env.ctx.player.position, activity);
          r.x = s.x; r.z = s.z; r.ground = s.ground; modes[i].add(s.mode); positions[i].add(`${s.x.toFixed(1)},${s.z.toFixed(1)}`);
          const travelled = Math.hypot(r.x - oldX, r.z - oldZ);
          distance[i] += travelled; perMinute[Math.floor(tick / 1200)][i] += travelled;
          const probe = { x: r.x, z: r.z }; env.ctx.physics.resolve(probe, .42, r.ground, 1.7);
          if (Math.hypot(probe.x - r.x, probe.z - r.z) > .003) collisions++;
          const b = r.patrol; if (r.x < b.x0 || r.x > b.x1 || r.z < b.z0 || r.z > b.z1 || Math.abs(r.ground - r.groundHint) > .03) escaped++;
        }
        for (let i = 0; i < residents.length; i++) for (let j = i + 1; j < residents.length; j++) {
          minDistance = Math.min(minDistance, Math.hypot(residents[i].x - residents[j].x, residents[i].z - residents[j].z));
        }
      }
      const end = residents.map(r => r.behavior.snapshot());
      const follow = [];
      activity.social = new TownSocial(MAPS[map].residents);
      const groundAt = (x, z, ground) => env.ctx.physics.groundHeight(x, z, ground);
      const probe = { x: 0, z: 0 };
      for (const r of residents) {
        const clearAt = (x, z, ground) => {
          probe.x = x; probe.z = z; env.ctx.physics.resolve(probe, .42, ground, 1.7);
          return Math.hypot(probe.x - x, probe.z - z) < .002 && residents.every(other => other === r || Math.hypot(other.x - x, other.z - z) >= .9);
        };
        const origin = { x: r.x, z: r.z, ground: r.ground };
        const graph = createPatrolGraph(origin, r.patrol, groundAt, clearAt, .65);
        const nav = createCompanionNavigator({ canMove: clearAt, groundAt, bounds: env.bounds });
        const destination = graph.filter(p => Math.hypot(p.x - origin.x, p.z - origin.z) > 3.5)
          .sort((a, b) => Math.hypot(b.x - origin.x, b.z - origin.z) - Math.hypot(a.x - origin.x, a.z - origin.z))
          .find(p => nav.route(origin, p).length);
        if (!destination) throw new Error(`No reachable follow test destination for ${map}/${r.id}`);
        env.ctx.player.position.set(destination.x, destination.ground, destination.z);
        activity.social.act(r.id, 'follow');
        let travelled = 0, contact = 0, maxTickMs = 0;
        for (let tick = 0; tick < 500; tick++) {
          const old = { x: r.x, z: r.z }; const before = performance.now();
          const s = r.behavior.update(.05, env.ctx.player.position, activity);
          maxTickMs = Math.max(maxTickMs, performance.now() - before);
          r.x = s.x; r.z = s.z; r.ground = s.ground;
          travelled += Math.hypot(r.x - old.x, r.z - old.z);
          if (!clearAt(r.x, r.z, r.ground)) contact++;
          if (Math.hypot(r.x - old.x, r.z - old.z) > .110001) throw new Error('companion teleported');
        }
        follow.push({ id: r.id, travelled, remaining: Math.hypot(r.x - destination.x, r.z - destination.z), contact, navigation: r.behavior.snapshot().navigation, maxTickMs });
        activity.social.act(r.id, 'end');
      }
      renderer.dispose(); renderer.forceContextLoss();
      return { map, start, end, distance, perMinute, modes: modes.map(s => [...s]), visited: positions.map(s => s.size), minDistance, collisions, escaped, follow };
    }, map);
    console.log('Cafe patrol:', JSON.stringify(result));
    assert.ok(result.start.every(s => s.walkableCells > 10), 'spawns connect to usable café paths');
    assert.equal(result.start.length, 3);
    assert.ok(result.distance.every(d => d > 8), 'all three move over repeated patrols, not one lucky first step');
    assert.ok(result.perMinute.every(pair => pair.every(d => d > 1)), 'no prolonged stand-off in later patrols');
    assert.ok(result.modes.every(m => m.includes('idle') && m.includes('walk')));
    assert.ok(result.minDistance >= .899, 'residents never overlap');
    assert.equal(result.collisions, 0, 'no furniture collision'); assert.equal(result.escaped, 0, 'stay on the café ground floor');
    for (const follow of result.follow) {
      assert.ok(follow.travelled > 1, `${follow.id} actually followed on ${map}`);
      assert.ok(follow.remaining < 2.2, `${follow.id} reaches conversational distance: ${JSON.stringify(follow)}`);
      assert.equal(follow.contact, 0, 'following uses the real furniture collider, not just a fixture grid');
      assert.ok(follow.navigation.searches < 25, 'search is throttled');
    }
  }
  assert.deepEqual(errors, []);
});
