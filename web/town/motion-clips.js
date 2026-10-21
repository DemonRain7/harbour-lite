import * as THREE from 'three';

export const CLIP_BONES = Object.freeze({
  下半身: 'pelvis', 上半身: 'spine_03', 頭: 'Head',
  左腕: 'upperarm_l', 左ひじ: 'lowerarm_l', 左手首: 'hand_l',
  右腕: 'upperarm_r', 右ひじ: 'lowerarm_r', 右手首: 'hand_r',
  左足: 'thigh_l', 左ひざ: 'calf_l', 左足首: 'foot_l',
  右足: 'thigh_r', 右ひざ: 'calf_r', 右足首: 'foot_r',
});

export async function loadMotionClips(signal) {
  const timeout = AbortSignal.timeout(5000);
  const response = await fetch(new URL('./motions/quaternius.json', import.meta.url), { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(`动作库载入失败（${response.status}）`);
  const data = await response.json();
  if (data.version !== 1 || data.license !== 'CC0-1.0') throw new Error('不支持的动作库');
  for (const id of ['idle', 'talk', 'walk', 'formalWalk', 'foldArms', 'nod']) {
    const c = data.clips?.[id];
    if (!c || !Number.isFinite(c.duration) || c.duration <= 0 || c.duration > 30 || !Number.isInteger(c.frames) || c.frames < 2 || c.frames > 1000) throw new Error('动作数据不完整');
    for (const joint of Object.values(CLIP_BONES)) {
      const track = c.tracks?.[joint];
      if (!Array.isArray(track) || track.length !== c.frames * 4 || track.some(n => !Number.isFinite(n) || Math.abs(n) > 1.001)) throw new Error('动作骨骼数据无效');
    }
  }
  return data;
}

// Input clips are world-space deltas against the author's T-pose. PMX models
// use an A-pose, identity bone rotations and additional helper/grant bones.
// Calibrate the arms once, then solve each local rotation against its *actual*
// parent chain. Root translation is deliberately not imported: navigation owns it.
export function createClipPlayer(mesh, library, { grounded = false } = {}) {
  const bones = new Map(mesh.skeleton.bones.map(b => [b.name, b]));
  const restPositions = mesh.skeleton.bones.map(b => {
    const p = b.position.clone(); let parent = b.parent;
    while (parent?.isBone) { p.applyQuaternion(parent.quaternion).add(parent.position); parent = parent.parent; }
    return p;
  });
  const position = name => restPositions[mesh.skeleton.bones.indexOf(bones.get(name))];
  const armBasis = new Map();
  for (const side of ['左', '右']) {
    const upper = position(side + '腕'), elbow = position(side + 'ひじ'), hand = position(side + '手首');
    if (!upper || !elbow || !hand) continue;
    const direction = new THREE.Vector3(side === '左' ? 1 : -1, 0, 0);
    armBasis.set(side + '腕', new THREE.Quaternion().setFromUnitVectors(elbow.clone().sub(upper).normalize(), direction));
    const lower = new THREE.Quaternion().setFromUnitVectors(hand.clone().sub(elbow).normalize(), direction);
    armBasis.set(side + 'ひじ', lower); armBasis.set(side + '手首', lower);
  }
  const targets = Object.keys(CLIP_BONES).filter(n => bones.has(n) && (!grounded || !/^(下半身|[左右](足|ひざ|足首))$/.test(n))).map(name => ({ name, bone: bones.get(name),
    basis: armBasis.get(name) || new THREE.Quaternion(), value: new THREE.Quaternion(), smooth: new THREE.Quaternion(), neutral: new THREE.Quaternion(), initialized: false }));
  for (const t of targets) {
    if (!/^[左右](腕|ひじ|手首)$/.test(t.name)) continue;
    // T-pose alignment is not a relaxed pose. Blend around an A-pose-derived
    // arm-down neutral, rather than towards identity (which raises the arms).
    const side = t.name[0], upper = position(side + '腕'), lower = position(side + 'ひじ'), hand = position(side + '手首');
    const axis = t.name.endsWith('腕') ? lower.clone().sub(upper) : hand.clone().sub(lower);
    t.neutral.setFromUnitVectors(axis.normalize(), new THREE.Vector3(side === '左' ? .16 : -.16, -1, .05).normalize());
  }
  // Parent targets must precede their descendants, including PMX helper chains.
  const depth = bone => { let n = 0; while (bone.parent?.isBone) { n++; bone = bone.parent; } return n; };
  targets.sort((a, b) => depth(a.bone) - depth(b.bone));
  const a = new THREE.Quaternion(), b = new THREE.Quaternion(), parentWorld = new THREE.Quaternion();
  const chain = [];
  let weight = 0, active = '';
  return {
    apply(id, seconds, dt) {
      const clip = library?.clips[id];
      const blend = 1 - Math.exp(-Math.min(.05, dt) * 9);
      weight += ((clip ? 1 : 0) - weight) * blend;
      if (clip) {
        active = id;
        const time = id === 'nod' ? Math.min(seconds, clip.duration) : ((seconds % clip.duration) + clip.duration) % clip.duration;
        const frame = time / clip.duration * (clip.frames - 1), i = Math.floor(frame), j = Math.min(clip.frames - 1, i + 1);
        for (const t of targets) {
          const track = clip.tracks[CLIP_BONES[t.name]];
          a.fromArray(track, i * 4); b.fromArray(track, j * 4);
          t.value.copy(a).slerp(b, frame - i).multiply(t.basis).normalize();
          if (grounded) {
            const amount = id === 'talk' ? .48 : id === 'walk' ? .50 : id === 'nod' ? .6 : .28;
            t.value.slerp(t.neutral, 1 - amount);
          }
          if (!t.initialized) { t.smooth.copy(t.value); t.initialized = true; }
          else t.smooth.slerp(t.value, blend);
        }
      }
      if (weight < .001) { active = ''; return; }
      for (const t of targets) {
        chain.length = 0; let parent = t.bone.parent;
        while (parent?.isBone) { chain.push(parent); parent = parent.parent; }
        parentWorld.identity();
        for (let n = chain.length - 1; n >= 0; n--) parentWorld.multiply(chain[n].quaternion);
        a.copy(parentWorld).invert().multiply(t.smooth);
        t.bone.quaternion.slerp(a, weight);
      }
    },
    get active() { return active; },
  };
}

export function selectMotion(pose, id) {
  const phase = pose.phase || 0;
  // Grounded locomotion owns both legs and arm swing on the same phase. Keep
  // the source Walk_Loop available to explicit clip users, not this hybrid.
  if (pose.mode === 'walk') return { id: '', time: 0 };
  if (pose.mode === 'reply') return { id: 'talk', time: phase };
  if (pose.mode === 'idle' || pose.mode === 'turn') return { id: 'idle', time: phase };
  if (pose.mode === 'listen' || pose.mode === 'attentive') {
    const beat = phase % 12;
    return beat >= 2 && beat < 4.5 ? { id: 'nod', time: beat - 2 } : { id: 'idle', time: phase };
  }
  return { id: '', time: 0 }; // existing wave / thinking remain expressive, not random emotes
}
