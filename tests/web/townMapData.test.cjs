const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../../web/town');
const load = relative => import(pathToFileURL(path.join(root, relative)).href);

test('map routing is a closed catalogue; residents keep Main and session identity', async () => {
  const { MAPS, mapFor, initialMap } = await load('maps.js');
  const { RESIDENTS, sessionKey, canChat } = await load('client.js');
  assert.equal(mapFor('https://foreign').id, 'station');
  for (const id of ['__proto__', 'constructor', 'toString', null, 1]) assert.equal(mapFor(id).id, 'station');
  assert.equal(initialMap('?map=suibo', null).id, 'suibo');
  assert.equal(initialMap('', { getItem: () => 'suibo' }).id, 'suibo');
  assert.equal(initialMap('?map=../evil', { getItem: () => 'suibo' }).id, 'station');
  for (const map of Object.values(MAPS)) {
    assert.deepEqual(map.residents.map(r => r.id), RESIDENTS.map(r => r.id));
    assert.deepEqual(map.residents.filter(r => canChat(r.id)).map(r => sessionKey(r.id)), ['web:town:main-elaina', 'web:town:main-aemeath']);
    assert.equal(map.residents.find(r => r.id === 'chisa').chatEnabled, false);
    for (const r of map.residents) for (const other of map.residents) {
      if (r.id !== other.id) assert.ok(Math.hypot(r.x - other.x, r.z - other.z) >= .9, 'distinct café spawns');
    }
  }
});

test('Suibo physics adapter preserves head clearance, steps, and stacked floors', async () => {
  const { adaptPhysics } = await load('maps/suibo/physics.js');
  const calls = [], world = { groundAt(x, z, maxY) { calls.push([x, z, maxY]); return maxY > 5 ? 5.6 : .45; }, resolve(p, r, h) { calls.push([p.y, r, h]); p.x += 1; } };
  const physics = adaptPhysics(world), p = { x: 3, z: 2 };
  assert.equal(physics.groundHeight(3, 2, 0), .45);
  assert.equal(physics.groundHeight(3, 2, 5.6), 5.6);
  physics.resolve(p, .3, 5.6, 1.7); assert.deepEqual(p, { x: 4, z: 2 });
  assert.deepEqual(calls[2], [5.6, .3, 1.7]);
});

const directory = path.join(root, 'maps/suibo');
test('Suibo original collision supports stairs, bridge headroom, walls and door cutouts', { skip: !fs.existsSync(path.join(directory, 'source')) }, async () => {
  const { CollisionWorld } = await load('maps/suibo/source/src/core/collision.js');
  const { adaptPhysics } = await load('maps/suibo/physics.js');
  const world = new CollisionWorld(), physics = adaptPhysics(world);
  world.addWalkBox(0, 0, 4, 4, 0, .4);
  world.addWalkBox(0, 0, 4, 4, 0, 3);
  world.addBox(0, 0, 4, 4, 0, 2.8, 3);
  assert.equal(physics.groundHeight(0, 0, 0), .4, 'step up without jumping to a bridge overhead');
  assert.equal(physics.groundHeight(0, 0, 3), 3, 'stay on elevated surface');
  const under = { x: 0, z: 0 }; physics.resolve(under, .3, .4, 1.7);
  assert.deepEqual(under, { x: 0, z: 0 }, 'pass under bridge with head clearance');
  world.addWalkRamp(5, 0, 2, 4, 0, 0, 1.2);
  for (const z of [-1.8, -1.3, -.8, -.3, .2, .7, 1.2, 1.7]) {
    const current = (z + 2) / 4 * 1.2;
    assert.ok(Math.abs(physics.groundHeight(5, z, Math.max(0, current - .2)) - current) < 1e-6);
  }
  Object.assign(world.addBox(10, 0, .4, 8), { bound: true });
  const blocked = { x: 9.85, z: 2 }; physics.resolve(blocked, .3, 0, 1.7);
  assert.ok(blocked.x <= 9.5, 'wall stays solid');
  world.carve(9.5, 10.5, -1, 1);
  const door = { x: 10, z: 0 }; physics.resolve(door, .3, 0, 1.7);
  assert.deepEqual(door, { x: 10, z: 0 }, 'carved entrance is passable');
});

test('map media/source integrity: original media untouched, only declared source adaptations', { skip: !fs.existsSync(path.join(directory, 'source')) }, () => {
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'import.json')));
  const patches = JSON.parse(fs.readFileSync(path.join(directory, 'patches.json'))).files;
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const archive = path.resolve(root, '../../assets/town/local/maps/suibo/original.zip');
  assert.equal(hash(fs.readFileSync(archive)), receipt.archiveSha256);
  let media = 0;
  for (const entry of receipt.files) {
    const bytes = fs.readFileSync(path.join(directory, 'source', entry.path));
    const patch = patches.find(p => p.path === entry.path);
    if (!patch) assert.equal(hash(bytes), entry.sha256, entry.path);
    else {
      let original = bytes.toString('utf8').replace(/\r\n/g, '\n');
      for (const replacement of [...patch.replacements].reverse()) {
        assert.equal(original.split(replacement.to).length, 2, entry.path);
        original = original.replace(replacement.to, replacement.from);
      }
      // Original ZIP contains both LF and CRLF sources. Audit either unchanged
      // line convention, never accept an unrelated content/hash revision.
      assert.ok([hash(original), hash(original.replace(/\n/g, '\r\n'))].includes(entry.sha256), entry.path);
    }
    if (entry.path.startsWith('public/')) media++;
    assert.doesNotMatch(entry.path, /(?:^tools\/|\.bat$|package\.json$|src\/main\.js$)/);
  }
  assert.ok(media > 40); assert.equal(receipt.files.length, 112);
});
