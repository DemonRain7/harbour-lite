const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const load = name => import(pathToFileURL(path.resolve(__dirname, '../../web/town', name)).href);

test('visibility gate defers hidden builds, coalesces transitions and cancels without polling', async () => {
  const { createTownVisibility } = await load('visibility.js');
  const lifetime = new AbortController(), document = new EventTarget(); document.hidden = false;
  const gate = createTownVisibility({ signal: lifetime.signal, document });
  let changes = 0, built = 0;
  gate.subscribe(() => changes++);
  gate.setVisible(false); gate.setVisible(false);
  const first = gate.whenVisible().then(() => built++);
  await Promise.resolve(); assert.equal(built, 0); assert.equal(changes, 1);
  gate.setVisible(true); gate.setVisible(false);
  await Promise.resolve(); assert.equal(built, 0, 'rapid re-hide keeps the chunk deferred');
  gate.setVisible(true); await first; assert.equal(built, 1);
  document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(gate.hidden(), true);
  const cancelled = gate.whenVisible(); lifetime.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  await assert.rejects(gate.whenVisible(), { name: 'AbortError' });
});

test('native gate waits for host visibility rather than its hidden owning shell', async () => {
  const { createTownVisibility } = await load('visibility.js');
  const lifetime = new AbortController(), document = new EventTarget(); document.hidden = true;
  const gate = createTownVisibility({ signal: lifetime.signal, document, native: true });
  assert.equal(gate.hidden(), true);
  let built = false; const waiting = gate.whenVisible().then(() => { built = true; });
  await Promise.resolve(); assert.equal(built, false);
  gate.setVisible(true); await waiting;
  assert.equal(gate.hidden(), false); assert.equal(built, true);
  lifetime.abort();
});

test('late native visibility snapshot cannot override a newer window event', async () => {
  const { bindPresentation } = await load('presentation.js');
  const saved = Object.fromEntries(['document', 'window', 'parent', 'opener'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const lifetime = new AbortController(), visible = [], document = new EventTarget();
  const buttons = new Map(['popout', 'fullscreen'].map(key => [key, Object.assign(new EventTarget(), { setAttribute() {} })]));
  document.getElementById = key => buttons.get(key);
  let event, snapshot;
  const window = { harbourTownHost: { onState(fn) { event = fn; return () => {}; }, status: () => new Promise(resolve => { snapshot = resolve; }), onBeforeClose() {} } };
  try {
    Object.assign(globalThis, { document, window, parent: window, opener: null });
    bindPresentation({ setVisible: value => visible.push(value) }, assert.fail, lifetime.signal);
    event({ mode: 'window', visible: true }); snapshot({ mode: 'background', visible: false });
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(visible, [true]);
  } finally {
    lifetime.abort();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});

test('edge look is continuous, frame-rate independent and bounded to the canvas', async () => {
  const { edgeLookVelocity } = await load('look-input.js');
  assert.equal(edgeLookVelocity(400, 800), 0);
  assert.equal(edgeLookVelocity(-1, 800), 0); assert.equal(edgeLookVelocity(801, 800), 0);
  assert.equal(edgeLookVelocity(0, 0), 0);
  assert.equal(edgeLookVelocity(2, 800), -edgeLookVelocity(798, 800));
  for (const fps of [30, 60, 144]) {
    let radians = 0; for (let i = 0; i < fps * 3; i++) radians += edgeLookVelocity(799, 800) / fps * .0022;
    assert.ok(radians > Math.PI, 'stationary cursor reaches a complete 180-degree turn');
  }
});

test('patrol graph sweeps thin obstacles and excludes disconnected cells and drops', async () => {
  const { createPatrolGraph } = await load('resident-behavior.js');
  const origin = { x: 0, z: 0, ground: 0 }, bounds = { x0: -3, x1: 3, z0: -3, z1: 3 };
  const graph = createPatrolGraph(origin, bounds, (x, z) => z > 1 ? -3 : 0, x => !(x > .3 && x < .5));
  assert.ok(graph.length > 5);
  assert.ok(graph.every(n => n.x < .3 && n.z <= 1));
  assert.deepEqual(createPatrolGraph(origin, bounds, () => 0, () => false), []);
});

test('residents roam locally, greet once, stop for chat, and react only to actual replies', async () => {
  const { createPatrolGraph, createResidentBehavior } = await load('resident-behavior.js');
  const origin = { id: 'test', x: 0, z: 0, ground: 0 }, activity = { replies: {} };
  const graph = createPatrolGraph(origin, { x0: -3, x1: 3, z0: -3, z1: 3 }, () => 0, () => true);
  const create = () => createResidentBehavior(origin, { graph, random: () => .37, canMove: () => true, groundAt: () => 0 });
  const a = create(), b = create(), far = { x: 20, z: 20 };
  for (let i = 0; i < 220; i++) { a.update(.05, far, activity); b.update(.05, far, activity); }
  assert.deepEqual(a.snapshot(), b.snapshot(), 'same inputs are deterministic');
  assert.ok(Math.hypot(a.state.x, a.state.z) > 1);
  const close = { x: a.state.x, z: a.state.z + 2 };
  a.update(.05, close, activity); assert.equal(a.state.mode, 'greet');
  const { x, z } = a.state;
  for (let i = 0; i < 70; i++) a.update(.05, close, activity);
  assert.equal(a.state.mode, 'attentive'); assert.equal(a.state.x, x); assert.equal(a.state.z, z);
  activity.selected = 'test'; a.update(.05, close, activity); assert.equal(a.state.mode, 'listen');
  activity.busy = 'test'; a.update(.05, close, activity); assert.equal(a.state.mode, 'think');
  activity.busy = ''; a.update(.05, close, activity); assert.equal(a.state.mode, 'listen', 'stop/error without a reply never fakes a speaking cue');
  activity.replies.test = 1; a.update(.05, close, activity); assert.equal(a.state.mode, 'reply');
  for (let i = 0; i < 95; i++) a.update(.05, close, activity);
  assert.equal(a.state.mode, 'listen'); activity.selected = '';
  for (let i = 0; i < 240; i++) a.update(.05, far, activity);
  assert.notEqual(a.state.x + ',' + a.state.z, x + ',' + z, 'roaming resumes after leaving');
});

test('dynamic obstruction stops movement and collisions follow the new resident location', async () => {
  const { createPatrolGraph, createResidentBehavior, separateFromResidents } = await load('resident-behavior.js');
  const origin = { id: 'test', x: 0, z: 0, ground: 0 };
  const graph = createPatrolGraph(origin, { x0: -3, x1: 3, z0: -3, z1: 3 }, () => 0, () => true);
  const blocked = createResidentBehavior(origin, { graph, random: () => .5, canMove: () => false, groundAt: () => 0 });
  for (let i = 0; i < 400; i++) blocked.update(.05, { x: 20, z: 20 }, {});
  assert.equal(blocked.state.x, 0); assert.equal(blocked.state.z, 0);
  const player = { x: 0, y: 0, z: 0 }, residents = [{ x: 2, z: 2, ground: 0 }];
  assert.equal(separateFromResidents(player, residents), false, 'no ghost collision at spawn');
  Object.assign(player, { x: 2, z: 2 }); assert.equal(separateFromResidents(player, residents), true);
  assert.ok(Math.hypot(player.x - 2, player.z - 2) >= .62 - 1e-9);
});

test('gentle patrol faces corners before translating and accelerates without random full-body emotes', async () => {
  const { createPatrolGraph, createResidentBehavior, angleDelta } = await load('resident-behavior.js');
  const { motionStyle, gaitPhase } = await load('motion-style.js');
  for (const id of ['main-elaina', 'main-aemeath', 'chisa']) {
    const origin = { id, x: 0, z: 0, ground: 0 };
    const graph = createPatrolGraph(origin, { x0: -3, x1: 3, z0: -3, z1: 3 }, () => 0, () => true);
    const behavior = createResidentBehavior(origin, { graph, random: () => .37, canMove: () => true, groundAt: () => 0 });
    let turns = 0, steps = 0;
    for (let i = 0; i < 2400; i++) {
      const old = { ...behavior.state }, s = behavior.update(1 / 60, { x: 20, z: 20 }, {});
      const dx = s.x - old.x, dz = s.z - old.z;
      assert.equal(s.idleGesture, 'idle');
      assert.ok(s.speed <= motionStyle(id).speed + 1e-8);
      if (s.mode === 'turn') { turns++; assert.ok(Math.hypot(dx, dz) < 1e-8, 'no sideways translation during a pivot'); }
      if (s.mode === 'walk') {
        steps++; assert.ok(Math.abs(angleDelta(s.yaw, Math.atan2(dx, dz))) < .66, 'never move backwards while facing the old direction');
        assert.ok(s.speed - old.speed <= .9 / 60 + 1e-8, 'bounded starting acceleration');
      }
    }
    assert.ok(turns > 30 && steps > 300);
  }
  for (let i = 0; i < 100; i++) assert.ok(gaitPhase(i / 100).planted || gaitPhase(i / 100, .5).planted, 'walking always has at least one support foot');
});

test('a nearby spectator does not freeze patrols; walls and upstairs players cannot trigger a greeting', async () => {
  const { createPatrolGraph, createResidentBehavior } = await load('resident-behavior.js');
  const origin = { id: 'main-elaina', x: 0, z: 0, ground: 0 };
  const graph = createPatrolGraph(origin, { x0: -3, x1: 3, z0: -3, z1: 3 }, () => 0, () => true);
  const options = { graph, random: () => .37, canMove: () => true, groundAt: () => 0 };
  const a = createResidentBehavior(origin, options);
  let travelled = 0, greetings = 0;
  for (let i = 0; i < 800; i++) {
    const { x, z, mode } = a.state;
    a.update(.05, { x, z: z + 2, y: 0 }, {});
    travelled += Math.hypot(a.state.x - x, a.state.z - z);
    if (mode !== 'greet' && a.state.mode === 'greet') greetings++;
  }
  assert.equal(greetings, 1, 'no repeated greetings while the same spectator stays close');
  assert.ok(travelled > 4, 'resumes after greeting without requiring the player to leave');
  for (const [canSee, y] of [[() => false, 0], [() => true, 4]]) {
    const b = createResidentBehavior(origin, { ...options, canSee });
    for (let i = 0; i < 200; i++) {
      b.update(.05, { x: b.state.x, z: b.state.z + 2, y }, {});
      assert.ok(['idle', 'turn', 'walk'].includes(b.state.mode), 'no interaction through a wall or floor');
    }
  }
});

test('shadow cache halves idle updates without delaying fast camera changes', async () => {
  const { createShadowSchedule } = await load('scene-performance.js');
  const schedule = createShadowSchedule(15), camera = { position: { x: 0, z: 0 }, rotation: { x: 0, y: 0 } };
  let draws = 0; for (let frame = 0; frame < 120; frame++) if (schedule(frame / 30, camera)) draws++;
  assert.equal(draws, 60);
  camera.rotation.y += .2; assert.equal(schedule(119.1 / 30, camera), true);
  camera.position.x += 1; assert.equal(schedule(119.2 / 30, camera), true);
  assert.equal(schedule(119.3 / 30, camera), false);
  assert.equal(schedule(119.4 / 30, camera, true), true);
});

test('explicit visits keep their target; out-of-range, hidden and upstairs residents cannot be selected', async () => {
  const { selectNearbyResident } = await load('resident-interaction.js');
  const player = { x: 0, z: 0, y: 0 }, direction = { x: 0, z: 1 };
  const visitor = { id: 'chisa', x: .1, z: 1.5, ground: 0, canSee: () => true };
  const wanted = { id: 'main-aemeath', x: .4, z: 2.3, ground: 0, canSee: () => true };
  assert.equal(selectNearbyResident([visitor, wanted], player, direction), visitor);
  assert.equal(selectNearbyResident([visitor, wanted], player, direction, wanted.id), wanted, 'passers-by cannot steal the chosen interaction');
  for (const patch of [{ z: 4 }, { ground: 3 }, { z: -2 }, { canSee: () => false }]) {
    assert.equal(selectNearbyResident([visitor, { ...wanted, ...patch }], player, direction, wanted.id), visitor);
  }
  assert.equal(selectNearbyResident([wanted], player, { x: 0, z: -1 }, wanted.id), null);
});

test('explicit visitor greeting repeats locally but still checks distance, floor and line of sight', async () => {
  const { createResidentBehavior } = await load('resident-behavior.js');
  const origin = { id: 'chisa', x: 0, z: 0, ground: 0 }, activity = { greetings: {} };
  const options = { graph: [], random: () => .37, canMove: () => true, groundAt: () => 0 };
  const behavior = createResidentBehavior(origin, options);
  const close = { x: 0, z: 2, y: 0 };
  for (let i = 0; i < 140; i++) behavior.update(.05, close, activity);
  assert.equal(behavior.state.mode, 'idle');
  activity.greetings.chisa = 1;
  behavior.update(.05, close, activity); assert.equal(behavior.state.mode, 'greet');
  for (let i = 0; i < 50; i++) behavior.update(.05, close, activity);
  assert.notEqual(behavior.state.mode, 'greet', 'one click does not restart the greeting each frame');
  activity.greetings.chisa++;
  behavior.update(.05, close, activity); assert.equal(behavior.state.mode, 'greet');
  for (const [player, canSee] of [[{ ...close, z: 5 }, () => true], [{ ...close, y: 3 }, () => true], [close, () => false]]) {
    const blocked = createResidentBehavior(origin, { ...options, canSee });
    blocked.update(.05, player, activity); assert.equal(blocked.state.mode, 'idle');
  }
});
