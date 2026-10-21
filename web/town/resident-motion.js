import * as THREE from 'three';
import { rotationGrants } from './model-data.js';
import { angleDelta } from './resident-behavior.js';
import { createClipPlayer, selectMotion } from './motion-clips.js';
import { motionStyle } from './motion-style.js';
import { boneFrame, createGroundedGait } from './motion-grounding.js';
import { createHandPose } from './motion-hands.js';

// Downloaded CC0 clips blend with procedural interaction/face cues. Original
// PMX, vertex data and textures stay untouched. Small foot IK is local; there is
// no full-body/cloth physics simulation or model call.
export const MOTION_BONES = ['左腕', '右腕', '左ひじ', '右ひじ', '左手首', '右手首', '上半身', '下半身', '頭', '左足', '右足', '左ひざ', '右ひざ', '左足首', '右足首'];
export function createAvatarMotion(mesh, ctx, resident, library) {
  const bones = new Map(mesh.skeleton.bones.map(bone => [bone.name, bone]));
  const style = motionStyle(resident.id);
  const gait = createGroundedGait(mesh, style, ctx.physics ? (x, z, ground) => ctx.physics.groundHeight(x, z, ground) : null);
  const hands = createHandPose(bones);
  const grants = rotationGrants(mesh.geometry.userData.MMD?.grants || [], mesh.skeleton.bones.length);
  const touched = new Set(MOTION_BONES.map(name => bones.get(name)).filter(Boolean));
  for (const bone of [...gait.bones, ...hands.bones]) touched.add(bone);
  for (const grant of grants) touched.add(mesh.skeleton.bones[grant.index]);
  const rests = [...touched].map(bone => [bone, bone.quaternion.clone()]);
  const offsets = new Map(MOTION_BONES.filter(name => bones.has(name)).map(name => [name, new THREE.Euler()]));
  const rotation = new THREE.Quaternion(), inherited = new THREE.Quaternion();
  const modelRotation = new THREE.Quaternion(), parentRotation = new THREE.Quaternion();
  const pointPosition = new THREE.Vector3(), direction = new THREE.Vector3();
  const bindDirections = new Map();
  for (const [name, child] of [['左腕', '左ひじ'], ['右腕', '右ひじ'], ['左ひじ', '左手首'], ['右ひじ', '右手首']]) {
    if (!bones.has(name) || !bones.has(child)) continue;
    boneFrame(bones.get(child), pointPosition, modelRotation); const end = pointPosition.clone();
    boneFrame(bones.get(name), pointPosition, modelRotation); bindDirections.set(name, end.sub(pointPosition).normalize());
  }
  const baseY = mesh.position.y;
  const clipPlayer = library ? createClipPlayer(mesh, library, { grounded: true }) : null;
  mesh.userData.townModel.motionLibrary = library ? 'Quaternius · CC0 · 6 clips' : 'procedural fallback';
  mesh.userData.townModel.motionStyle = { ...style, footIK: true, locomotion: 'shared-foot-phase', calibratedPalms: true, formalWalk: false, randomFoldArms: false };
  const morph = mesh.morphTargetDictionary || {}, values = mesh.morphTargetInfluences || [];
  let wave = 0, walk = 0, think = 0, reply = 0, headYaw = 0, pat = 0, game = 0;
  mesh.userData.townModel.animatedBones = touched.size;
  // The same skeleton is drawn in depth, colour and shadow passes. All three
  // use the matrices prepared for this display frame; no repeated palette work.
  const updateSkeleton = mesh.skeleton.update.bind(mesh.skeleton);
  let paletteFrame = -1;
  mesh.skeleton.update = () => { if (paletteFrame === ctx.frameId) return; paletteFrame = ctx.frameId; updateSkeleton(); };
  const set = (name, x = 0, y = 0, z = 0) => {
    const bone = bones.get(name), offset = offsets.get(name); if (!bone) return;
    offset.set(x, y, z); rotation.setFromEuler(offset); bone.quaternion.multiply(rotation);
  };
  const face = (name, value) => { if (morph[name] !== undefined) values[morph[name]] = value; };
  const aim = (name, x, y, z, amount = 1) => {
    const bone = bones.get(name), bind = bindDirections.get(name); if (!bone || !bind) return;
    modelRotation.setFromUnitVectors(bind, direction.set(x, y, z).normalize());
    if (bone.parent?.isBone) boneFrame(bone.parent, pointPosition, parentRotation); else parentRotation.identity();
    rotation.copy(parentRotation).invert().multiply(modelRotation);
    bone.quaternion.slerp(rotation, amount);
  };
  return (dt, t) => {
    const pose = resident.motion;
    if (Math.hypot(ctx.player.position.x - pose.x, ctx.player.position.z - pose.z) > 40) return;
    for (const [bone, rest] of rests) bone.quaternion.copy(rest);
    gait.reset();
    const blend = 1 - Math.exp(-dt * 7);
    wave += ((pose.mode === 'greet' ? 1 : 0) - wave) * blend;
    walk += ((pose.mode === 'walk' ? Math.min(1, pose.speed / style.speed) : 0) - walk) * blend;
    think += ((pose.mode === 'think' ? 1 : 0) - think) * blend;
    reply += ((pose.mode === 'reply' ? 1 : 0) - reply) * blend;
    pat += ((pose.mode === 'pat' ? 1 : 0) - pat) * blend;
    game += ((pose.mode === 'rps' ? 1 : 0) - game) * blend;
    mesh.position.y = baseY;
    // The actual foot cycle also drives the arms/body. An independently looping
    // retargeted walk used to restart out of phase with our grounded legs.
    const footState = gait.apply(pose, dt);
    const swing = Math.cos(footState.cycle * Math.PI * 2) * walk;
    aim('左腕', .11, -1, -.18 * swing);
    aim('右腕', -.11, -1, .18 * swing);
    aim('左ひじ', .10, -.97, .16 - .16 * swing);
    aim('右ひじ', -.10, -.97, .16 + .16 * swing);
    set('上半身', Math.sin(t * 1.4) * .006 + think * .025, swing * .020, Math.sin(t * .65) * .006 - swing * .008);
    const near = Math.hypot(ctx.camera.position.x - pose.x, ctx.camera.position.z - pose.z) < 5;
    const target = near ? THREE.MathUtils.clamp(angleDelta(pose.yaw, Math.atan2(ctx.camera.position.x - pose.x, ctx.camera.position.z - pose.z)), -.5, .5) : Math.sin(t * .24) * .08;
    headYaw += (target - headYaw) * (1 - Math.exp(-dt * 4));
    set('頭', .065 * think + Math.sin(t * 2.4) * .025 * reply, headYaw, think * .04);
    if (clipPlayer) {
      const clip = selectMotion(pose, resident.id);
      clipPlayer.apply(clip.id, clip.time, dt);
      // Keep a small responsive gaze on top of imported body motion.
      if (clip.id) set('頭', 0, headYaw * .55, 0);
      mesh.userData.townModel.activeClip = clipPlayer.active;
    }
    // A small wave beside the face, elbow down, instead of the old shoulder-wide
    // presenting pose. Geometry-derived directions fit all three A-pose rigs.
    aim('右腕', -.36, -.91, .20, wave);
    if (wave > .0001) {
      // Raise through the elbow's forward bending plane. Slerping directly
      // from arm-down to arm-up swung the forearm sideways like a windmill.
      const raise = THREE.MathUtils.lerp(.163, Math.PI - .205, wave);
      aim('右ひじ', -.10 - .10 * wave, -Math.cos(raise), Math.sin(raise));
    }
    if (game > .0001) {
      const beat = pose.social?.countdown ? Math.sin(pose.social.elapsed / .7 * Math.PI * 2) * .12 : 0;
      aim('右腕', -.22, -.93, .30, game);
      aim('右ひじ', -.05, .80 + beat, .60, game);
    }
    hands.apply(wave, Math.sin((pose.social?.elapsed ?? pose.phase ?? 0) * 7) * .12 * style.gesture,
      { weight: game, choice: pose.social?.choice || 'rock' });
    if (pat > .001) set('頭', pat * .09, 0, pat * .10 * (resident.id === 'chisa' ? -1 : 1));
    mesh.userData.townModel.socialGesture = pose.social?.type || null;
    mesh.userData.townModel.gait = footState;
    for (const grant of grants) {
      inherited.identity().slerp(mesh.skeleton.bones[grant.parentIndex].quaternion, grant.ratio);
      mesh.skeleton.bones[grant.index].quaternion.multiply(inherited);
    }
    const blinkT = (t + (resident.id === 'main-elaina' ? .7 : 2.1)) % 4.6;
    face('まばたき', Math.max(pat * .76, blinkT < .18 ? Math.sin(blinkT / .18 * Math.PI) : 0));
    face('にこり', .08 + wave * .2 + reply * .18 + pat * .4 + game * .16 + (pose.mode === 'listen' ? .12 : 0));
    face('あ', reply * (.10 + .16 * Math.max(0, Math.sin(t * 11))));
  };
}
