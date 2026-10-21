import * as THREE from 'three';
import { Human } from './station/src/world/characters/human.js';
import { Driver, rot } from './station/src/world/characters/anim.js';
import { book } from './station/src/world/characters/gear.js';
import { RESIDENTS } from './client.js';
import { residentCatalogue, buildModelResident } from './model-residents.js';
import { createPatrolGraph, createResidentBehavior } from './resident-behavior.js';
import { loadMotionClips } from './motion-clips.js';
import { createCompanionNavigator } from './companion-navigation.js';

export function movingResident(ctx, definition, activity, neighbors = []) {
  const groundAt = (x, z, ground) => ctx.physics.groundHeight(x, z, ground);
  const resident = { ...definition, ground: groundAt(definition.x, definition.z, definition.groundHint ?? ctx.L.heightAt(definition.x, definition.z) + .2) };
  const probe = { x: 0, z: 0 };
  const clearAt = (x, z, ground) => {
    probe.x = x; probe.z = z; ctx.physics.resolve(probe, .42, ground, 1.7);
    return Math.hypot(probe.x - x, probe.z - z) < .002;
  };
  const bounds = resident.patrol || (resident.id === 'main-elaina' ? { x0: 1, x1: 12, z0: -21, z1: -9 } : { x0: 2.8, x1: 8.4, z0: 5, z1: 13.5 });
  const graph = createPatrolGraph(resident, bounds, groundAt, clearAt, .65);
  const canMove = (x, z, ground) => clearAt(x, z, ground)
    && neighbors.every(other => other.id === resident.id || Math.abs(ground - other.ground) > 1.7 || Math.hypot(x - other.x, z - other.z) >= .9)
    && (Math.abs(ground - ctx.player.position.y) > 1.7 || Math.hypot(x - ctx.player.position.x, z - ctx.player.position.z) >= .8);
  const canSee = player => {
    for (let i = 1; i < 12; i++) {
      const x = resident.x + (player.x - resident.x) * i / 12, z = resident.z + (player.z - resident.z) * i / 12;
      probe.x = x; probe.z = z; ctx.physics.resolve(probe, .05, resident.ground + .9, .5);
      if (Math.hypot(probe.x - x, probe.z - z) > .01) return false;
    }
    return true;
  };
  const navigator = createCompanionNavigator({ groundAt, canMove, bounds: ctx.townBounds });
  resident.behavior = createResidentBehavior(resident, { graph, groundAt, canMove, canRestore: clearAt, canSee, navigator, random: ctx.rng(resident.id) });
  resident.canSee = canSee;
  resident.motion = resident.behavior.state;
  ctx.onUpdate(dt => {
    const state = resident.behavior.update(dt, ctx.player.position, activity);
    resident.x = state.x; resident.z = state.z; resident.ground = state.ground;
  });
  return resident;
}

export async function buildResidents(ctx, activity, options) {
  let catalogue = {}, catalogueError = '';
  try { catalogue = await residentCatalogue(options.signal); }
  catch (error) { if (options.signal.aborted) throw error; catalogueError = error.message; }
  try { options = { ...options, motionLibrary: await loadMotionClips(options.signal) }; }
  catch (error) { if (options.signal.aborted) throw error; console.warn('Town motion library unavailable; keeping procedural poses:', error.message); }
  const residents = [];
  try {
    for (const [index, definition] of (options.definitions || RESIDENTS).entries()) {
      await options.whenVisible?.();
      options.signal.throwIfAborted();
      const resident = movingResident(ctx, definition, activity, residents);
      if (catalogue[resident.id]) {
        try { residents.push(await buildModelResident(ctx, activity, resident, catalogue[resident.id], options)); continue; }
        catch (error) {
          if (options.signal.aborted) throw error;
          options.onModelState?.({ id: resident.id, type: 'placeholder', error: error.message });
        }
      } else options.onModelState?.({ id: resident.id, type: 'placeholder', error: catalogueError || '本机未导入模型' });
      residents.push(buildPlaceholder(ctx, activity, resident, index));
    }
    return residents;
  } catch (error) { residents.forEach(r => r.dispose?.()); throw error; }
}

// Original lightweight fallback remains usable on machines without licensed assets.
function buildPlaceholder(ctx, activity, resident, index) {
    const witch = index === 0;
    const guest = resident.chatEnabled === false;
    const human = new Human(ctx, {
      key: resident.id, sex: 'f', height: 1.63, seed: 900 + index, skin: '#f5ddce', variants: ['open', 'blink', 'talk'],
      face: { skin: '#f5ddce', ink: '#483a51', eyeP: 24, eyeT: -12, eyeW: 20, eyeH: 22,
        irisDark: witch ? '#4c3e61' : '#485a72', irisMid: witch ? '#88729c' : '#7693ad', irisLight: '#d1c7de',
        lash: 1, lidTop: -.5, iris: .37, irisH: .46, brow: '#6e586d', browW: 1.7, browGap: 3.5,
        browArch: 2.4, noseT: -32, mouthT: -52, mouthW: 9, smile: .35, blush: .3 },
      hair: { fringe: { n: 7, span: 62, tip: 0, skew: -6, w: .05 }, side: { long: .19, w: .033 },
        back: { len: .57, n: 9, span: 108, w: .08, spread: .2, taper: .2 }, hairlineBack: -64 },
      hairTex: witch ? { top: '#d4d1dc', base: '#c4bfd2', tip: '#aaa2c0', hi: '#f1edf7', hi2: '#fff8ff' }
        : guest ? { top: '#343138', base: '#24232a', tip: '#17171d', hi: '#57515e', hi2: '#746b7a' }
          : { top: '#eebdce', base: '#e1a7c0', tip: '#ca8bad', hi: '#ffe1ea', hi2: '#fff2f5' },
      outfit: { top: witch ? 'cardigan' : 'blouse', topColor: witch ? '#494155' : '#f3e7ee',
        collar: '#f7f1e8', band: witch ? '#bca5c9' : guest ? '#a24e5c' : '#9c8daf', tucked: true,
        bottom: 'skirt', bottomColor: witch ? '#514457' : guest ? '#49414c' : '#9698b3', hem: .23, flare: .18,
        legs: witch ? '#565064' : '#e5dce8', shoes: { color: '#665970', sole: '#433c4e' } },
      hands: { L: witch ? 'hold' : 'relax', R: witch ? 'hold' : 'relax' },
      props: witch ? [h => { h.townBook = book(h, { cover: '#655078' }); }] : [],
    });
    // Small geometric eyes remain legible at conversational distance, without
    // depending on the distant-NPC atlas' mip level. Only our two rigs use these.
    const eyes = [];
    for (const side of [-1, 1]) {
      const group = new THREE.Group();
      const point = human.headPt(side * 24 * Math.PI / 180, -12 * Math.PI / 180, 1.025);
      group.position.set(...point); group.rotation.y = side * .3;
      const white = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 8), new THREE.MeshToonMaterial({ color: '#f8f3ef' }));
      white.scale.set(.025, .020, .006); group.add(white);
      const iris = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshToonMaterial({ color: witch ? '#79658f' : '#7298ba' }));
      iris.scale.set(.012, .017, .005); iris.position.z = .006; group.add(iris);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), new THREE.MeshBasicMaterial({ color: '#362f46' }));
      pupil.scale.set(.004, .011, .002); pupil.position.z = .011; group.add(pupil);
      const glint = new THREE.Mesh(new THREE.SphereGeometry(.0035, 8, 6), new THREE.MeshBasicMaterial({ color: '#fffdfb' }));
      glint.position.set(-.004, .007, .014); group.add(glint);
      human.b.head.add(group); eyes.push(group);
    }
    if (witch) {
      const material = new THREE.MeshToonMaterial({ color: '#463b56' });
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(.27, .29, .025, 24), material);
      brim.position.set(0, .265, -.025); human.b.head.add(brim);
      const hat = new THREE.Mesh(new THREE.ConeGeometry(.15, .37, 20), material);
      hat.position.set(0, .445, -.035); hat.rotation.z = -.12; human.b.head.add(hat);
      const ribbon = new THREE.Mesh(new THREE.CylinderGeometry(.139, .156, .037, 20), new THREE.MeshToonMaterial({ color: '#c4a5c9' }));
      ribbon.position.set(0, .305, -.025); human.b.head.add(ribbon);
    } else if (!guest) {
      const star = new THREE.Mesh(new THREE.OctahedronGeometry(.035), new THREE.MeshToonMaterial({ color: '#f8dea7' }));
      star.position.set(.095, .17, .095); star.scale.y = 1.4; human.b.head.add(star);
    }
    ctx.add(human.group);
    const driver = new Driver(ctx, human, { seed: 900 + index, wind: .65 });
    const left = new THREE.Vector3(), right = new THREE.Vector3(), pole = new THREE.Vector3(), target = new THREE.Vector3();
    ctx.onUpdate((dt, t) => {
      const { ground, motion } = resident;
      const engaged = activity.selected === resident.id, busy = motion.mode === 'think';
      const nearby = ctx.player.position.distanceToSquared(human.group.position) < 36;
      driver.place(resident.x, ground, resident.z, motion.yaw); driver.reset();
      const walking = motion.mode === 'walk', stride = motion.motionTime * 7.8, swing = Math.sin(stride);
      driver.stand({ hx: .009 * Math.sin(t * .7), hrz: .008 * Math.sin(t * .7),
        ...(walking ? { footL: [human.P.hipJx, human.P.ankle + Math.max(0, swing) * .06, swing * .16],
          footR: [-human.P.hipJx, human.P.ankle + Math.max(0, -swing) * .06, -swing * .16] } : {}) });
      driver.breathe(t, .8);
      if (human.townBook) human.townBook.book.visible = !['greet', 'reply', 'pat', 'rps'].includes(motion.mode);
      if (witch && human.townBook.book.visible) {
        const bk = human.townBook;
        bk.book.position.set(0, .27, .27); rot(bk.book, -.95, 0, 0);
        const turn = Math.max(0, Math.min(1, ((t % 12) - 10) / 1.3));
        rot(bk.page, 0, -turn * 2.9, 0);
        human.group.updateMatrixWorld(true);
        left.set(-bk.W * .95, -bk.H * .18, -.02).applyMatrix4(bk.book.matrixWorld);
        right.set(bk.W * .95, -bk.H * .18, -.02).applyMatrix4(bk.book.matrixWorld);
        driver.armIK('L', left, driver.W(.45, .9, -.15, pole));
        driver.armIK('R', right, driver.W(-.45, .9, -.15, pole));
        rot(human.b.handL, -.3, .9, -.2); rot(human.b.handR, -.3, -.9, .2);
        target.set(0, 0, 0).applyMatrix4(bk.book.matrixWorld);
      } else {
        driver.arm('L', .05, .1, 0, .2);
        const wave = motion.mode === 'greet' || motion.mode === 'rps';
        driver.arm('R', busy ? .3 : wave ? 1.7 : .08, wave ? .5 : .12, 0, busy ? 1.6 : wave ? .45 : .18, [0, 0, wave ? Math.sin(t * 8) * .25 : 0]);
        target.set(resident.x + .3, ground + 1.5, resident.z + 4);
      }
      if ((engaged || nearby) && !busy) target.copy(ctx.camera.position);
      driver.lookAt(target, dt, { speed: 3, maxYaw: .8, maxDown: .8 });
      if (motion.mode === 'pat') human.b.head.rotation.z += .10;
      driver.blink(t, motion.mode === 'reply'); eyes.forEach(eye => { eye.scale.y = human.face === 'blink' ? .08 : 1; }); driver.wind(t, dt);
      if (motion.mode === 'pat') eyes.forEach(eye => { eye.scale.y = .18; });
    });
    return Object.assign(resident, { human, state: () => ({ id: resident.id, type: 'placeholder', behavior: resident.behavior.snapshot() }) });
}
