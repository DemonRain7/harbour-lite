import * as THREE from 'three';
import { angleDelta } from './resident-behavior.js';
import { gaitPhase, STANCE, smoothStep } from './motion-style.js';
import { createFootSupport } from './motion-foot-support.js';

// Skeleton-space FK: only the handful of chains we animate, not a second full
// update of 1,000 PMX bones. Mesh/world scale is applied at the boundary.
export function boneFrame(bone, position, rotation) {
  position.copy(bone.position); rotation.copy(bone.quaternion);
  for (let parent = bone.parent; parent?.isBone; parent = parent.parent) {
    position.applyQuaternion(parent.quaternion).add(parent.position);
    rotation.premultiply(parent.quaternion);
  }
}

function limbSolver(upper, lower, end) {
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qc = new THREE.Quaternion();
  boneFrame(upper, a, qa); boneFrame(lower, b, qb); boneFrame(end, c, qc);
  const l1 = a.distanceTo(b), l2 = b.distanceTo(c);
  const direction = new THREE.Vector3(), bend = new THREE.Vector3(), knee = new THREE.Vector3();
  const from = new THREE.Vector3(), to = new THREE.Vector3(), delta = new THREE.Quaternion(), parent = new THREE.Quaternion(), localInverse = new THREE.Quaternion();
  const setWorld = (bone, world, current) => {
    localInverse.copy(bone.quaternion).invert(); parent.copy(current).multiply(localInverse).invert();
    bone.quaternion.copy(parent).multiply(world).normalize();
  };
  return {
    length: l1 + l2,
    solve(target, footRotation) {
      boneFrame(upper, a, qa); boneFrame(lower, b, qb);
      direction.copy(target).sub(a);
      const d = THREE.MathUtils.clamp(direction.length(), Math.abs(l1 - l2) + .0001, l1 + l2 - .0001);
      direction.normalize();
      // Knees always bend towards the character's front (+Z), not backwards.
      bend.set(0, 0, 1).addScaledVector(direction, -direction.z).normalize();
      const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
      knee.copy(a).addScaledVector(direction, along).addScaledVector(bend, Math.sqrt(Math.max(0, l1 * l1 - along * along)));
      from.copy(b).sub(a).normalize(); to.copy(knee).sub(a).normalize();
      delta.setFromUnitVectors(from, to).multiply(qa); setWorld(upper, delta, qa);
      boneFrame(lower, b, qb); boneFrame(end, c, qc);
      from.copy(c).sub(b).normalize(); to.copy(a).addScaledVector(direction, d).sub(b).normalize();
      delta.setFromUnitVectors(from, to).multiply(qb); setWorld(lower, delta, qb);
      boneFrame(end, c, qc); setWorld(end, footRotation, qc);
    },
  };
}

export function createGroundedGait(mesh, style, groundHeight) {
  const bones = new Map(mesh.skeleton.bones.map(b => [b.name, b]));
  const center = bones.get('センター'), centerRest = center?.position.clone();
  const scale = mesh.scale.x, baseY = mesh.position.y;
  const q = new THREE.Quaternion(), p = new THREE.Vector3(), target = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0), pitchAxis = new THREE.Vector3(1, 0, 0);
  const footRotation = new THREE.Quaternion(), pitchRotation = new THREE.Quaternion();
  const feet = ['左', '右'].map((side, index) => {
    const upper = bones.get(side + '足'), lower = bones.get(side + 'ひざ'), end = bones.get(side + '足首');
    if (!upper || !lower || !end) return null;
    boneFrame(end, p, q);
    const rest = p.clone().multiplyScalar(scale); boneFrame(upper, p, q);
    return { side: index * .5, upper, end, rest, hipZ: p.z * scale, solver: limbSolver(upper, lower, end),
      support: createFootSupport(mesh, side, rest, groundHeight),
      target: new THREE.Vector3(), position: new THREE.Vector3(), previous: new THREE.Vector3(), anchor: new THREE.Vector3(), from: new THREE.Vector3(), yaw: 0, pitch: 0, swingStart: STANCE, planted: true, initialized: false };
  }).filter(Boolean);
  // Start halfway through support: the opposite foot gets a half swing to
  // take its first, shorter step. Heel offsets must not shorten that time.
  const startPhase = STANCE * .5;
  let cycle = STANCE * .5, previousX, previousZ, previousYaw, previousGround, previousWalking = false, previousTurning = false, moving = 0, reach = 0, pelvisDrop = 0;
  let swingLift = .020, swingPitch = 0;
  let settling = -1, settleTime = 0;
  const toWorld = (local, pose, out, foot) => {
    const s = Math.sin(pose.yaw), c = Math.cos(pose.yaw);
    out.set(pose.x + local.x * c + local.z * s, pose.ground + baseY + local.y, pose.z + local.z * c - local.x * s);
    if (foot?.support) out.y = foot.support(out, pose.yaw, 0, pose.ground);
    return out;
  };
  const status = { planted: [true, true], feet: [[], []], cycle: 0 };
  return {
    bones: center ? [center] : [],
    reset() { if (center) center.position.copy(centerRest); },
    apply(pose, dt) {
      const distance = previousX === undefined ? 0 : Math.hypot(pose.x - previousX, pose.z - previousZ);
      const turn = previousYaw === undefined ? 0 : Math.abs(angleDelta(previousYaw, pose.yaw));
      // Teleports / returning from distance-culling rebase contacts, never stretch.
      const rebase = distance > .4 || turn > .8 || (previousGround !== undefined && Math.abs(pose.ground - previousGround) > .45);
      const walking = pose.mode === 'walk' && pose.speed > .015;
      const turning = turn > Math.max(.000001, dt * .09) && !walking;
      const starting = walking && !previousWalking && !previousTurning && settling < 0;
      if (rebase || previousX === undefined || starting) cycle = startPhase;
      moving += ((walking ? 1 : turning ? .35 : 0) - moving) * (1 - Math.exp(-dt * 10));
      swingLift += ((walking ? style.lift : .020) - swingLift) * (1 - Math.exp(-dt * 10));
      swingPitch += ((walking ? .20 : 0) - swingPitch) * (1 - Math.exp(-dt * 10));
      if (starting) reach = style.stride * STANCE * .5;
      else reach += ((walking ? style.stride * STANCE * .5 : 0) - reach) * (1 - Math.exp(-dt * 10));
      // A stationary 90° pivot needs roughly two short steps, not a quarter of
      // a walking cycle with one ankle left facing the old direction.
      cycle += rebase ? 0 : distance / style.stride + turn * (turning ? .6 : .08 / style.stride);
      previousX = pose.x; previousZ = pose.z; previousYaw = pose.yaw; previousGround = pose.ground;
      previousWalking = walking; previousTurning = turning;
      if (walking || turning || rebase) settling = -1;
      else if (settling < 0) {
        let furthest = .008;
        // Finish the airborne foot first; otherwise the old planted anchor
        // pulled it backwards across the floor as soon as walking stopped.
        settling = feet.findIndex(foot => foot.initialized && !foot.planted);
        for (const [index, foot] of feet.entries()) {
          if (settling >= 0 && !feet[settling].planted) break;
          if (!foot.initialized) continue;
          toWorld(foot.rest, pose, target, foot);
          const distance = foot.position.distanceTo(target);
          if (distance > furthest) { furthest = distance; settling = index; }
        }
        if (settling >= 0) { feet[settling].from.copy(feet[settling].position); settleTime = 0; }
      }
      if (settling >= 0) settleTime = Math.min(1, settleTime + dt / .26);
      if (center) {
        center.position.copy(centerRest);
        // A small knee-softening drop gives the planted leg reach at both ends
        // of a step. Root navigation remains solely owned by the behavior.
        center.position.y -= (.004 + moving * (.020 + .007 * Math.cos(cycle * Math.PI * 4))) / scale;
        center.position.x += Math.sin(cycle * Math.PI * 2) * style.sway * moving / scale;
      }
      for (const [index, foot] of feet.entries()) {
        const phase = gaitPhase(cycle, foot.side);
        if (!foot.initialized || rebase) {
          toWorld(foot.rest, pose, foot.position, foot); foot.anchor.copy(foot.position); foot.from.copy(foot.position);
          foot.initialized = true; foot.planted = true; foot.yaw = pose.yaw;
        }
        if (starting) { foot.anchor.copy(foot.position); foot.from.copy(foot.position); foot.planted = true; }
        foot.previous.copy(foot.position);
        const wasPlanted = foot.planted;
        if (walking || turning) {
          // Shorter placements while pivoting. Do not skate sideways while the
          // navigation waits to face a corner or a conversation partner.
          if (!phase.planted) {
            if (foot.planted) { foot.from.copy(foot.position); foot.swingStart = phase.phase; }
            // A start/restart may occur part-way through the global phase. Its
            // first swing still starts at zero, never at a half-completed lerp.
            const swing = smoothStep((phase.phase - foot.swingStart) / (1 - foot.swingStart));
            p.copy(foot.rest); p.z += reach + (foot.hipZ - foot.rest.z) * Math.min(1, moving * 3);
            toWorld(p, pose, target, foot);
            foot.position.copy(foot.from).lerp(target, swing);
            const lift = swingLift * Math.min(1, moving * 3);
            if (foot.support && Math.abs(target.y - foot.from.y) > .025) {
              // Reach the upper tread before crossing its riser, then lower the
              // shoe onto the destination. Flat-ground gait stays unchanged.
              const peak = Math.max(foot.from.y, target.y) + lift;
              foot.position.y = swing < .5 ? THREE.MathUtils.lerp(foot.from.y, peak, smoothStep(swing * 2))
                : THREE.MathUtils.lerp(peak, target.y, smoothStep((swing - .5) * 2));
            } else foot.position.y += lift * Math.sin(swing * Math.PI);
            foot.yaw += angleDelta(foot.yaw, pose.yaw) * swing;
            foot.pitch = swingPitch * Math.sin(swing * Math.PI);
          } else if (!foot.planted) {
            // Land where the swing arrived, not at a newly recomputed forward
            // position. A mode/velocity change must not snap the foot sideways.
            foot.position.y = foot.support ? foot.support(foot.position, pose.yaw, 0, pose.ground) : pose.ground + baseY + foot.rest.y;
            foot.anchor.copy(foot.position); foot.yaw = pose.yaw;
          } else foot.position.copy(foot.anchor);
          foot.planted = phase.planted;
          if (foot.planted) foot.pitch = 0;
        } else {
          // Bring the feet together one at a time with a tiny lifted step.
          // Blending BOTH ankles towards rest along the floor looked like skating.
          if (settling === index) {
            toWorld(foot.rest, pose, target, foot);
            const s = smoothStep(settleTime), distance = foot.from.distanceTo(target);
            foot.position.copy(foot.from).lerp(target, s);
            foot.position.y += Math.min(.022, distance * .25) * Math.sin(s * Math.PI);
            foot.yaw += angleDelta(foot.yaw, pose.yaw) * s;
            foot.pitch *= 1 - s;
            foot.planted = settleTime >= 1;
            if (foot.planted) foot.anchor.copy(foot.position);
          } else { foot.position.copy(foot.anchor); foot.planted = true; foot.pitch = 0; }
        }
        // The swing foot travels a whole stride in < half a cycle. Its peak
        // speed must exceed root speed; a root-like cap makes every step lag.
        const move = foot.position.distanceTo(foot.previous), maxMove = dt * Math.max(3, (pose.speed || 0) / (1 - STANCE) * 1.6);
        if (move > maxMove) foot.position.lerpVectors(foot.previous, foot.position, maxMove / move);
        if (foot.support) {
          // Collision clearance wins over smoothing: never freeze an old
          // contact below a tread, even while stopping/turning on its edge.
          const floor = foot.support(foot.position, foot.yaw, foot.pitch, pose.ground);
          foot.position.y = foot.planted ? floor : Math.max(foot.position.y, floor);
          if (foot.planted) foot.anchor.copy(foot.position);
        }
        if (foot.planted && !wasPlanted) foot.anchor.copy(foot.position);
        const dx = foot.position.x - pose.x, dz = foot.position.z - pose.z;
        foot.target.set(dx * Math.cos(pose.yaw) - dz * Math.sin(pose.yaw), foot.position.y - pose.ground - baseY,
          dz * Math.cos(pose.yaw) + dx * Math.sin(pose.yaw)).divideScalar(scale);
        status.planted[index] = foot.planted; foot.position.toArray(status.feet[index]);
      }
      // High-heel PMX rigs rest with their ankle behind the hip. During the
      // first step after a pivot, soften the pelvis just enough for *both*
      // planted feet to remain reachable, instead of lifting one through IK.
      let neededDrop = 0;
      for (const foot of feet) {
        boneFrame(foot.upper, p, q);
        const horizontal2 = (p.x - foot.target.x) ** 2 + (p.z - foot.target.z) ** 2;
        // Leave a little extension reserve so the support knee never locks
        // straight at the end of a longer step (especially on high heels).
        const vertical = Math.sqrt(Math.max(0, (foot.solver.length - .008 / scale) ** 2 - horizontal2));
        neededDrop = Math.max(neededDrop, p.y - foot.target.y - vertical);
      }
      if (settleTime >= 1) settling = -1;
      if (rebase) pelvisDrop = 0;
      const lowerTread = Math.max(0, ...feet.map(foot => pose.ground + baseY + foot.rest.y - foot.position.y));
      pelvisDrop = Math.min((.05 + Math.min(.4, lowerTread)) / scale, Math.max(neededDrop, pelvisDrop * Math.exp(-dt * 12)));
      if (center) center.position.y -= pelvisDrop;
      for (const foot of feet) {
        footRotation.setFromAxisAngle(up, angleDelta(pose.yaw, foot.yaw));
        pitchRotation.setFromAxisAngle(pitchAxis, foot.pitch); footRotation.multiply(pitchRotation);
        foot.solver.solve(foot.target, footRotation);
      }
      status.cycle = cycle; return status;
    },
  };
}
