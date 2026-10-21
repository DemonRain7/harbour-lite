import * as THREE from 'three';
import { boneFrame } from './motion-grounding.js';

// Calibrate from the supplied hand itself: A-pose arms do not tell us which
// way its palm faces. Never fix a wrist with one shared, arbitrary twist angle.
export function createHandPose(bones) {
  const p = new THREE.Vector3(), q = new THREE.Quaternion();
  const position = bone => { boneFrame(bone, p, q); return p.clone(); };
  const hands = [], touched = [];
  for (const side of ['左', '右']) {
    const wrist = bones.get(side + '手首'), middle = bones.get(side + '中指１');
    const index = bones.get(side + '人指１'), pinky = bones.get(side + '小指１');
    if (!wrist || !middle || !index || !pinky) continue;
    const forward = position(middle).sub(position(wrist)).normalize();
    const across = position(index).sub(position(pinky)).normalize();
    const palm = across.clone().cross(forward).multiplyScalar(side === '右' ? 1 : -1).normalize();
    const tangent = forward.clone().cross(palm).normalize();
    const inverseFrame = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(tangent, forward, palm)).invert();
    boneFrame(wrist, p, q); const restRotation = q.clone();
    const fingers = [];
    for (const family of ['人指', '中指', '薬指', '小指', '親指']) {
      const digits = family === '親指' ? '０１２' : '１２３';
      for (const [joint, digit] of [...digits].entries()) {
        const bone = bones.get(side + family + digit); if (!bone) continue;
        const child = bones.get(side + family + String.fromCharCode(digit.charCodeAt(0) + 1));
        const direction = child ? position(child).sub(position(bone)).normalize()
          : bone.parent?.isBone ? position(bone).sub(position(bone.parent)).normalize() : forward.clone();
        const axis = direction.clone().cross(palm).normalize();
        boneFrame(bone, p, q); const inverse = q.clone().invert(); axis.applyQuaternion(inverse);
        const thumb = family === '親指';
        const softness = { 人指: .85, 中指: 1, 薬指: 1.2, 小指: 1.5, 親指: 1 }[family];
        const rest = (thumb ? [.10, .12, .07] : [.12, .20, .10])[joint] * softness;
        const open = (thumb ? [.07, .06, .04] : [.07, .12, .065])[joint] * softness;
        fingers.push({ bone, axis, spreadAxis: palm.clone().applyQuaternion(inverse), rest, open, family, joint }); touched.push(bone);
      }
    }
    hands.push({ side, wrist, inverseFrame, restRotation, fingers });
  }
  const normal = new THREE.Vector3(), up = new THREE.Vector3(), right = new THREE.Vector3();
  const matrix = new THREE.Matrix4(), desired = new THREE.Quaternion(), parent = new THREE.Quaternion(), curl = new THREE.Quaternion();
  return {
    bones: touched,
    apply(wave, oscillation, game = { weight: 0, choice: 'rock' }) {
      for (const hand of hands) {
        const lift = Math.max(wave, game.weight);
        if (hand.side === '右' && lift > .0001) {
          // Fingers roughly follow the forearm; palm looks out towards the
          // person we face. A gentle side-to-side wave, not a bent-back salute.
          up.set(-.12 + oscillation * (1 - game.weight), .985, .06 + game.weight * .18).normalize();
          normal.set(.10, .03, 1).addScaledVector(up, -up.dot(normal)).normalize();
          right.crossVectors(up, normal).normalize();
          desired.setFromRotationMatrix(matrix.makeBasis(right, up, normal)).multiply(hand.inverseFrame).multiply(hand.restRotation);
          if (hand.wrist.parent?.isBone) boneFrame(hand.wrist.parent, p, parent); else parent.identity();
          desired.premultiply(parent.invert()); hand.wrist.quaternion.slerp(desired, lift);
        }
        for (const finger of hand.fingers) {
          const amount = hand.side === '右' ? wave : 0;
          let angle = THREE.MathUtils.lerp(finger.rest, finger.open, amount);
          if (hand.side === '右' && game.weight > .0001) {
            const extended = game.choice === 'paper' || (game.choice === 'scissors' && ['人指', '中指'].includes(finger.family));
            const closed = (finger.family === '親指' ? [.4, .7, .6] : [1.05, 1.35, .95])[finger.joint];
            angle = THREE.MathUtils.lerp(angle, extended ? finger.open * .35 : closed, game.weight);
          }
          curl.setFromAxisAngle(finger.axis, angle);
          finger.bone.quaternion.multiply(curl);
          if (hand.side === '右' && game.choice === 'scissors' && game.weight > .0001 && finger.joint === 0) {
            const spread = finger.family === '人指' ? -.13 : finger.family === '中指' ? .07 : 0;
            curl.setFromAxisAngle(finger.spreadAxis, spread * game.weight); finger.bone.quaternion.multiply(curl);
          }
        }
      }
    },
  };
}
