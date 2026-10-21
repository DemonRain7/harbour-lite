const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const town = path.resolve(__dirname, '../../web/town');
const threeURL = pathToFileURL(path.join(town, 'lib/three/build/three.module.js')).href;
const three = import(threeURL);
const load = file => import('data:text/javascript;base64,' + Buffer.from(
  fs.readFileSync(path.join(town, 'maps/suibo', file), 'utf8').replaceAll("from 'three'", `from '${threeURL}'`),
).toString('base64'));

function soup(THREE, count = 300, unique = 6) {
  const g = new THREE.BufferGeometry();
  for (const [name, size] of Object.entries({ position: 3, normal: 3, uv: 2, color: 3, aRoom: 1, windW: 1 })) {
    const a = new Float32Array(count * size);
    for (let i = 0; i < count; i++) for (let k = 0; k < size; k++) a[i * size + k] = name === 'position' ? i % unique + k : (i % 3 + k) / 4;
    g.setAttribute(name, new THREE.BufferAttribute(a, size));
  }
  return g;
}
const bits = attribute => new Uint32Array(attribute.array.buffer, attribute.array.byteOffset, attribute.array.length);

test('static indexing preserves exact attributes, seams, triangle order, groups and draw range', async () => {
  const THREE = await three, { indexStaticGeometry } = await load('static-geometry.js');
  const g = soup(THREE);
  // Same positions but distinct room/color/UV/normal/wind values must not weld.
  for (const [n, name] of ['normal', 'uv', 'color', 'aRoom', 'windW'].entries()) g.attributes[name].array[(n + 1) * 6 * g.attributes[name].itemSize] = .99;
  bits(g.attributes.normal)[0] = 0x80000000; // -0 is not +0
  bits(g.attributes.windW)[0] = 0x7fc00001; // retain even a NaN payload, bit-for-bit
  g.attributes.color.name = 'room-colors'; g.attributes.color.setUsage(THREE.DynamicDrawUsage);
  g.addGroup(0, 150, 0); g.addGroup(150, 150, 1); g.setDrawRange(6, 288);
  g.computeBoundingBox(); g.computeBoundingSphere();
  const original = Object.fromEntries(Object.entries(g.attributes).map(([name, a]) => [name, { size: a.itemSize, bits: bits(a).slice(), attribute: a }]));
  let disposed = 0; g.addEventListener('dispose', () => { disposed++; assert.equal(g.attributes.position, original.position.attribute, 'GPU attributes disposed before replacement'); });
  const bounds = g.boundingBox.clone(), sphere = g.boundingSphere.clone();
  assert.equal(indexStaticGeometry(g), g); assert.equal(disposed, 1);
  assert.ok(g.index.array instanceof Uint16Array);
  assert.ok(g.attributes.position.count > 6, 'attribute seams are distinct vertices');
  assert.equal(g.index.count, 300);
  for (const [name, a] of Object.entries(original)) {
    const actual = bits(g.attributes[name]);
    for (let i = 0; i < 300; i++) for (let k = 0; k < a.size; k++) assert.equal(actual[g.index.array[i] * a.size + k], a.bits[i * a.size + k], `${name} ${i}/${k}`);
  }
  assert.equal(g.attributes.color.name, 'room-colors'); assert.equal(g.attributes.color.usage, THREE.DynamicDrawUsage);
  assert.deepEqual(g.groups, [{ start: 0, count: 150, materialIndex: 0 }, { start: 150, count: 150, materialIndex: 1 }]);
  assert.deepEqual(g.drawRange, { start: 6, count: 288 }); assert.deepEqual(g.boundingBox, bounds); assert.deepEqual(g.boundingSphere, sphere);
  assert.ok(g.userData.townIndexing.indexedBytes < g.userData.townIndexing.sourceBytes);
  const index = g.index; indexStaticGeometry(g); assert.equal(g.index, index); assert.equal(disposed, 1, 'idempotent');
});

test('large static batches use 32-bit indices; unsupported or unprofitable data stays untouched', async () => {
  const THREE = await three, { indexStaticGeometry } = await load('static-geometry.js');
  const large = soup(THREE, 65538 * 2, 65538); indexStaticGeometry(large);
  assert.ok(large.index.array instanceof Uint32Array); assert.equal(large.attributes.position.count, 65538);
  assert.equal(large.index.array[65537], 65537); assert.equal(large.index.array[65538], 0);
  for (const unique of [65535, 65536]) {
    const boundary = soup(THREE, unique * 3, unique);
    for (const [name, a] of Object.entries(boundary.attributes)) if (name !== 'position') a.array.fill(0);
    indexStaticGeometry(boundary);
    assert.equal(boundary.index.array.BYTES_PER_ELEMENT, unique === 65535 ? 2 : 4, '0xffff is reserved for WebGL2 primitive restart');
    assert.equal(boundary.index.array[unique - 1], unique - 1);
  }
  for (const mutate of [
    g => g.setIndex([0, 1, 2]),
    g => { g.morphAttributes.position = [g.attributes.position.clone()]; },
    g => g.setAttribute('aRoom', new THREE.Uint16BufferAttribute(new Uint16Array(300), 1)),
    g => g.setAttribute('aRoom', new THREE.Float32BufferAttribute(new Float32Array(2), 1)),
    g => g.setAttribute('aRoom', new THREE.InstancedBufferAttribute(new Float32Array(300), 1)),
    g => g.setAttribute('aRoom', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(new Float32Array(300), 1), 1, 0)),
  ]) {
    const g = soup(THREE); mutate(g); const attributes = { ...g.attributes }, index = g.index;
    indexStaticGeometry(g); assert.deepEqual(g.attributes, attributes); assert.equal(g.index, index);
  }
  for (const g of [soup(THREE, 3), soup(THREE, 301), soup(THREE, 300, 300)]) {
    const position = g.attributes.position; indexStaticGeometry(g); assert.equal(g.index, null); assert.equal(g.attributes.position, position);
  }
});

test('only tagged non-instanced static meshes are optimized, after source cleanup, with shared geometry deduplicated', async () => {
  const THREE = await three, { indexStaticScene } = await load('static-geometry.js');
  const scene = new THREE.Scene(), g = soup(THREE), untagged = soup(THREE), instanced = soup(THREE);
  g.userData.townStaticSoup = instanced.userData.townStaticSoup = true;
  // Source cleanup collapses a triangle before indexing. It must remain collapsed.
  g.attributes.position.copyAt(1, g.attributes.position, 0); g.attributes.position.copyAt(2, g.attributes.position, 0);
  scene.add(new THREE.Mesh(g), new THREE.Mesh(g), new THREE.Mesh(untagged), new THREE.InstancedMesh(instanced, new THREE.MeshBasicMaterial(), 2));
  let disposals = 0; g.addEventListener('dispose', () => disposals++);
  await indexStaticScene(scene, async () => {});
  assert.ok(g.index); assert.equal(disposals, 1); assert.equal(untagged.index, null); assert.equal(instanced.index, null);
  for (const i of [1, 2]) assert.equal(g.attributes.position.getX(g.index.getX(i)), g.attributes.position.getX(g.index.getX(0)));
  const adapter = fs.readFileSync(path.join(town, 'maps/suibo.js'), 'utf8');
  assert.ok(adapter.indexOf('for (const update of updates) update(0, 14)') < adapter.indexOf('await indexStaticScene'));
  assert.ok(adapter.indexOf('await indexStaticScene') < adapter.indexOf('bakedAO = bakeAO'));
});

test('screen caches keep scene precision/MSAA, trim only unused channels/depth, and have an idempotent lifecycle', async () => {
  const THREE = await three, { managePostResources, postTargets, targetBytes } = await load('render-resources.js');
  const rt = options => new THREE.WebGLRenderTarget(256, 128, { type: THREE.HalfFloatType, ...options });
  const material = new THREE.ShaderMaterial(), lut = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  let materialDisposals = 0, lutDisposals = 0;
  material.addEventListener('dispose', () => materialDisposals++); lut.addEventListener('dispose', () => lutDisposals++);
  const pass = { quad: { material }, dispose() {} };
  const post = {
    composer: { renderTarget1: rt(), renderTarget2: rt(), passes: [pass], dispose() {} },
    scenePass: { mrt: rt({ count: 2, samples: 4 }), aoRT: rt({ depthBuffer: false }), aoRT2: rt({ depthBuffer: false }) },
    taa: { hist: [rt({ depthBuffer: false }), rt({ depthBuffer: false })], reset() { this.resets = (this.resets || 0) + 1; } },
    shafts: { rtA: rt({ depthBuffer: false }), rtB: rt({ depthBuffer: false }) },
    bloom: { renderTargetBright: rt(), renderTargetsHorizontal: [rt()], renderTargetsVertical: [rt()] },
    fxaa: pass, grade: { uniforms: { tLutDay: { value: lut }, tLutDusk: { value: null }, tLutNight: { value: null } } },
  };
  const mrtBytes = targetBytes(post.scenePass.mrt), targets = postTargets(post), disposals = new Map();
  targets.forEach(t => t.addEventListener('dispose', () => disposals.set(t, (disposals.get(t) || 0) + 1)));
  const owner = managePostResources(post);
  assert.equal(targetBytes(post.scenePass.mrt), mrtBytes); assert.equal(post.scenePass.mrt.samples, 4); assert.equal(post.scenePass.mrt.depthBuffer, true);
  assert.equal(post.scenePass.aoRT.texture.format, THREE.RedFormat); assert.equal(post.scenePass.aoRT.texture.type, THREE.HalfFloatType);
  assert.equal(post.shafts.rtA.texture.format, THREE.RedFormat); assert.equal(post.taa.hist[0].texture.format, THREE.RGBAFormat);
  assert.equal(post.bloom.renderTargetBright.depthBuffer, false); assert.ok(owner.status().savedPostBufferMiB > 0);
  owner.suspend(); owner.suspend(); assert.equal(owner.status().residentPostBufferMiB, 0); assert.equal(post.taa.resets, 1);
  assert.ok(targets.every(t => disposals.get(t) === 1));
  owner.resume(); assert.equal(owner.status().buffersSuspended, false); assert.ok(owner.status().residentPostBufferMiB > 0);
  owner.suspend(); assert.equal(post.taa.resets, 2);
  owner.dispose(); owner.dispose(); assert.equal(materialDisposals, 1); assert.equal(lutDisposals, 1); assert.equal(owner.status().residentPostBufferMiB, 0);
});

test('resident lighting reuses the café table and clips to that room, without changing source materials', async () => {
  const THREE = await three, { cafeLightBinding, applyResidentRoomLight } = await load('resident-lighting.js');
  const scene = new THREE.Scene(), group = new THREE.Group(); group.name = 'cafe-interior'; scene.add(group);
  const g = soup(THREE); g.attributes.aRoom.array.fill(3);
  const texture = new THREE.DataTexture(new Float32Array(18 * 4 * 64), 18, 64, THREE.RGBAFormat, THREE.FloatType);
  const mat = new THREE.ShaderMaterial({ uniforms: { uILTex: { value: texture } } }); group.add(new THREE.Mesh(g, mat));
  const night = { value: 1 }, cafe = { x0: 24, z0: 54, x1: 46, z1: 70, FY: .35, CY: 6.4 };
  const binding = cafeLightBinding(scene, cafe, night);
  assert.equal(binding.uTownRoomLights.value, texture); assert.equal(binding.uTownRoomRow.value, 3); assert.equal(binding.uTownRoomNight, night);
  assert.deepEqual(binding.uTownRoomBounds.value.toArray(), [24, 54, 46, 70]); assert.deepEqual(binding.uTownRoomHeights.value.toArray(), [.35, 6.4]);
  const shader = { uniforms: {}, vertexShader: '#include <project_vertex>', fragmentShader: '#include <lights_fragment_end>' };
  applyResidentRoomLight(shader, binding);
  assert.match(shader.vertexShader, /modelMatrix \* vec4\(transformed/); assert.match(shader.fragmentShader, /roomWeight > 0.0/);
  assert.match(shader.fragmentShader, /diffuseColor.rgb \* roomLight/); assert.equal(shader.uniforms.uTownRoomNight, night);
  night.value = 0; assert.equal(shader.uniforms.uTownRoomNight.value, 0);
  assert.deepEqual(Object.keys(mat.uniforms), ['uILTex']); assert.equal(cafeLightBinding(new THREE.Scene(), cafe, night), null);
  const basic = { uniforms: {}, vertexShader: 'void main() {}', fragmentShader: 'void main() {}' };
  applyResidentRoomLight(basic, binding); assert.deepEqual(basic.uniforms, {});
});
