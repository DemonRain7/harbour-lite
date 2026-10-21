const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { register } = require('node:module');
const town = path.resolve(__dirname, '../../web/town');
const url = name => pathToFileURL(path.join(town, name)).href;
// Use the exact pinned Three.js math/PMX builder, without WebGL or a browser.
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s,c,next) {
  return next(s === 'three' ? ${JSON.stringify(url('lib/three/build/three.module.js'))} : s,c);
}`));
const load = name => import(url(name));
const localModels = fs.existsSync(path.join(town, 'models/local/manifest.json'));

async function avatar(id) {
  const THREE = await import(url('lib/three/build/three.module.js'));
  const { MMDLoader } = await load('lib/three/examples/jsm/loaders/MMDLoader.js');
  const { MMDParser } = await load('lib/three/examples/jsm/libs/mmdparser.module.js');
  const { prepareMmdData } = await load('model-data.js');
  const catalog = JSON.parse(fs.readFileSync(path.join(town, 'models/local/manifest.json'))).residents;
  const entry = catalog[id], variant = entry.variants.find(v => v.id === entry.defaultVariant);
  const bytes = fs.readFileSync(path.join(town, 'models/local', id, variant.pmx));
  const source = new MMDParser.Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true);
  const builder = new MMDLoader().meshBuilder;
  builder.materialBuilder.build = () => new THREE.MeshBasicMaterial(); // No textures needed for vertex contact measurements.
  const mesh = builder.build(prepareMmdData(source, source.textures.map(() => '')), '');
  mesh.geometry.computeBoundingBox();
  const head = source.bones.find(b => b.name === '頭');
  const scale = head ? 1.48 / head.position[1] : 1.7 / mesh.geometry.boundingBox.max.y;
  mesh.scale.setScalar(scale); mesh.position.y = -mesh.geometry.boundingBox.min.y * scale;
  mesh.userData.townModel = {};
  const root = new THREE.Group(); root.add(mesh);
  return { THREE, mesh, root };
}

test('sole support checks heel/toe and width, respects level hints and fails finite without a height', async () => {
  const THREE = await import(url('lib/three/build/three.module.js'));
  const { createFootSupport } = await load('motion-foot-support.js');
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(.12, .1, .3).translate(0, .05, .05));
  mesh.skeleton = { bones: [{ name: '左足首D' }] };
  const n = mesh.geometry.attributes.position.count;
  mesh.geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4));
  const weights = new Float32Array(n * 4); for (let i = 0; i < n; i++) weights[i * 4] = 1;
  mesh.geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  let hint, missing = false;
  const support = createFootSupport(mesh, '左', new THREE.Vector3(0, .1, 0), (x, z, ground) => {
    hint = ground; return missing ? NaN : (z > .1 || x > .04 ? .2 : 0);
  });
  assert.ok(Math.abs(support({ x: 0, z: 0 }, 0, 0, .35) - .303) < 1e-6, 'toe/side of shoe sees a step before the ankle crosses it');
  assert.equal(hint, .35, 'same floor hint, no ray from the sky onto a ceiling');
  assert.ok(support({ x: 0, z: 0 }, 0, .2, .35) > .303, 'a tilted toe still clears the tread');
  missing = true;
  assert.ok(Math.abs(support({ x: 0, z: 0 }, 0, 0, .35) - .453) < 1e-6);
  assert.equal(createFootSupport(mesh, '左', new THREE.Vector3(), null), null, 'rig-only previews stay compatible');
  mesh.geometry.dispose(); mesh.material.dispose();
});

for (const id of ['main-aemeath', 'main-elaina', 'chisa']) for (const fps of [30, 60, 120]) {
  test(`${id} ${fps}Hz: actual rig feet stay above cafe steps during follow, stop and return`, { skip: !localModels }, async () => {
    const { THREE, mesh, root } = await avatar(id);
    const { createAvatarMotion } = await load('resident-motion.js');
    // Same levels as Suibo's café floor / terrace / outer step / base ground.
    const height = (x, z) => z < 0 ? .35 : z < 1.5 ? .20 : z < 2.5 ? .11 : 0;
    const pose = { x: 0, z: -.8, ground: .35, yaw: 0, mode: 'idle', speed: 0, phase: 0 };
    const ctx = { camera: { position: new THREE.Vector3(0, 1.7, 4) }, player: { position: new THREE.Vector3(0, 0, 4) },
      physics: { groundHeight: height }, frameId: 0 };
    const library = JSON.parse(fs.readFileSync(path.join(town, 'motions/quaternius.json')));
    const update = createAvatarMotion(mesh, ctx, { id, motion: pose }, library);
    const sample = new THREE.Vector3();
    // Measure the deformed shoe/foot surface, not merely the requested ankle IK target.
    const positions = mesh.geometry.attributes.position;
    const sole = [];
    for (let i = 0; i < positions.count; i++) {
      sample.fromBufferAttribute(positions, i).multiplyScalar(mesh.scale.x).add(mesh.position);
      if (sample.y < .035 && Math.abs(sample.x) < .4) sole.push(i);
    }
    assert.ok(sole.length > 8, 'actual sole vertices are available');
    let worst = 0, worstAt, maxQueries = 0, queries = 0;
    ctx.physics.groundHeight = (...args) => { queries++; return height(...args); };
    for (let frame = 0; frame < fps * 14; frame++) {
      const t = frame / fps;
      pose.mode = t < .5 || t > 12.5 || (t > 4.4 && t < 5.2) ? 'idle' : 'walk';
      pose.speed = pose.mode === 'walk' ? (t > 7 ? 2.2 : .8) : 0;
      pose.yaw = t >= 5.2 ? Math.PI : 0;
      pose.z += Math.cos(pose.yaw) * pose.speed / fps;
      pose.ground = height(pose.x, pose.z); pose.phase = t;
      root.position.set(pose.x, pose.ground, pose.z); root.rotation.y = pose.yaw;
      ctx.frameId++; queries = 0; update(1 / fps, t); maxQueries = Math.max(maxQueries, queries);
      root.updateMatrixWorld(true); mesh.skeleton.update();
      for (const index of sole) {
        sample.fromBufferAttribute(positions, index); mesh.applyBoneTransform(index, sample); mesh.localToWorld(sample);
        const penetration = height(sample.x, sample.z) - sample.y;
        if (penetration > worst) { worst = penetration; worstAt = { frame, z: pose.z, mode: pose.mode, sample: sample.toArray() }; }
      }
    }
    console.log(id, fps, { worstPenetration: worst, worstAt, maxQueries });
    assert.ok(worst < .02, `${id} sole clips through the ground: ${JSON.stringify({ worst, worstAt })}`);
    assert.ok(maxQueries <= 80, 'foot support queries stay bounded, not a raycast across the full scene');
    mesh.geometry.dispose(); mesh.material.dispose(); mesh.skeleton.dispose();
  });
}

for (const id of ['main-aemeath', 'main-elaina', 'chisa']) test(`${id}: flat-ground contacts and turns retain a smooth planted foot`, { skip: !localModels }, async () => {
  const { THREE, mesh, root } = await avatar(id);
  const { createAvatarMotion } = await load('resident-motion.js');
  const pose = { x: 0, z: 0, ground: 0, yaw: 0, mode: 'idle', speed: 0, phase: 0 };
  const ctx = { camera: { position: new THREE.Vector3(0, 1.7, 4) }, player: { position: new THREE.Vector3(0, 0, 4) }, physics: { groundHeight: () => 0 }, frameId: 0 };
  const update = createAvatarMotion(mesh, ctx, { id, motion: pose });
  const feet = ['左', '右'].map(side => ({ bone: mesh.skeleton.bones.find(b => b.name === side + '足首D'), last: new THREE.Vector3(), planted: false }));
  const point = new THREE.Vector3(), desired = new THREE.Vector3();
  let maxSlide = 0, maxContact = 0, maxJump = 0;
  for (let frame = 0; frame < 600; frame++) {
    const t = frame / 60;
    pose.mode = t < .8 || t >= 8 ? 'idle' : t >= 4 && t < 5 ? 'turn' : 'walk';
    pose.speed = pose.mode === 'walk' ? .72 : 0; pose.phase = t;
    if (pose.mode === 'turn') pose.yaw += Math.PI / 2 / 60;
    pose.x += Math.sin(pose.yaw) * pose.speed / 60; pose.z += Math.cos(pose.yaw) * pose.speed / 60;
    root.position.set(pose.x, pose.ground, pose.z); root.rotation.y = pose.yaw;
    ctx.frameId++; update(1 / 60, t); root.updateMatrixWorld(true);
    const gait = mesh.userData.townModel.gait;
    for (const [i, foot] of feet.entries()) {
      foot.bone.getWorldPosition(point); desired.fromArray(gait.feet[i]);
      if (frame > 60) {
        if (gait.planted[i]) maxContact = Math.max(maxContact, point.distanceTo(desired));
        if (pose.mode === 'walk' && gait.planted[i] && foot.planted) maxSlide = Math.max(maxSlide, point.distanceTo(foot.last));
        maxJump = Math.max(maxJump, point.distanceTo(foot.last));
      }
      foot.last.copy(point); foot.planted = gait.planted[i];
    }
  }
  assert.ok(maxContact < .015, `ankles reach the planted targets: ${maxContact}`);
  assert.ok(maxSlide < .012, `flat contact does not skate: ${maxSlide}`);
  assert.ok(maxJump * 60 < 3.3, `foot speed is bounded: ${maxJump * 60}`);
  mesh.geometry.dispose(); mesh.material.dispose(); mesh.skeleton.dispose();
});
