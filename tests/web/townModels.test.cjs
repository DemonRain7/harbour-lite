const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const library = import(pathToFileURL(path.join(root, 'web/town/model-data.js')));
const manifestPath = path.join(root, 'web/town/models/local/manifest.json');
const fixtures = () => ({ version: 1, localOnly: true, residents: { 'main-elaina': { defaultVariant: 'original',
  variants: [{ id: 'original', pmx: 'original.pmx', bytes: 1, sha256: 'a'.repeat(64), textures: [] }] } } });

test('model catalogue only accepts known residents and local flat paths', async () => {
  const { validateCatalogue, modelFile } = await library;
  assert.equal(modelFile('main-elaina', 'original.pmx'), '/town/models/local/main-elaina/original.pmx');
  assert.equal(modelFile('chisa', 'original.pmx'), '/town/models/local/chisa/original.pmx');
  for (const file of ['../model.pmx', 'https://external/a.pmx', 'foo/../model.pmx', '..\\a.pmx', 'a.pmx?token=x']) assert.throws(() => modelFile('main-elaina', file));
  assert.throws(() => modelFile('not-a-resident', 'a.pmx'));
  assert.equal(Object.keys(validateCatalogue(fixtures())).length, 1);
  const bad = fixtures(); bad.residents['main-elaina'].variants[0].bytes = 100 * 1024 * 1024;
  assert.throws(() => validateCatalogue(bad));
  const duplicate = fixtures(); duplicate.residents['main-elaina'].variants.push(duplicate.residents['main-elaina'].variants[0]);
  assert.throws(() => validateCatalogue(duplicate));
});
test('runtime pruning preserves source, geometry, bones and author data', async () => {
  const { prepareMmdData } = await library;
  const source = { metadata: { format: 'pmx', vertexCount: 1, boneCount: 1, morphCount: 3, rigidBodyCount: 1, constraintCount: 1 },
    textures: ['Tex\\A.png'], vertices: [{ position: [0, 0, 0] }], bones: [{ name: '頭' }], materials: [{ name: 'coat' }],
    morphs: [{ name: 'まばたき', type: 1 }, { name: 'unused', type: 1 }, { name: 'material morph', type: 8 }], rigidBodies: [{}], constraints: [{}] };
  const snapshot = structuredClone(source);
  const result = prepareMmdData(source, ['blob:verified']);
  assert.deepEqual(source, snapshot); assert.equal(result.vertices, source.vertices); assert.equal(result.bones, source.bones);
  assert.equal(result.materials, source.materials); assert.equal(result.metadata.morphCount, 1);
  assert.deepEqual(result.rigidBodies, []); assert.deepEqual(result.constraints, []);
  assert.throws(() => prepareMmdData(source, []));
});

test('source texture selection is opt-in, bounded and does not mutate existing optimized mappings', async () => {
  const { selectModelTextures, validateCatalogue } = await library;
  const optimized = { file: 'tex-a.webp', bytes: 100, sha256: 'a'.repeat(64), width: 2048, height: 2048 };
  const original = { file: 'source-a.png', bytes: 200, sha256: 'b'.repeat(64), width: 4096, height: 4096 };
  const variant = { textures: [{ ...optimized, original }, optimized] }, snapshot = structuredClone(variant);
  assert.deepEqual(selectModelTextures(variant).textures, variant.textures);
  assert.deepEqual(selectModelTextures(variant, { sourceTextures: true, maxTextureSize: 4096 }), { textures: [original, optimized], fallback: 1 });
  assert.equal(selectModelTextures(variant, { sourceTextures: true, maxTextureSize: 2048 }).fallback, 2);
  assert.deepEqual(variant, snapshot);
  const catalogue = fixtures(); catalogue.residents['main-elaina'].variants[0].textures = variant.textures;
  assert.doesNotThrow(() => validateCatalogue(catalogue));
  original.file = '../outside.png'; assert.throws(() => validateCatalogue(catalogue)); original.file = 'source-a.png';
  original.width = 32768; assert.throws(() => validateCatalogue(catalogue));
});
test('unbound PMX grant parents cannot stop animation of all residents', async () => {
  const { rotationGrants } = await library;
  const valid = { index: 1, parentIndex: 0, ratio: .3, affectRotation: true, isLocal: false };
  const list = [valid, { ...valid, parentIndex: -1 }, { ...valid, index: 2 }, { ...valid, ratio: NaN }, { ...valid, isLocal: true }];
  assert.deepEqual(rotationGrants(list, 2), [valid]);
});

test('incremental model import preserves existing residents and publishes only complete variants', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-town-import-'));
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const output = path.join(temp, 'models'), source = path.join(temp, 'source');
  fs.mkdirSync(path.join(output, 'main-elaina'), { recursive: true }); fs.mkdirSync(source);
  const old = fixtures(); old.audit = 'preserve extra catalogue metadata';
  const original = JSON.stringify(old), manifest = path.join(output, 'manifest.json');
  fs.writeFileSync(manifest, original); fs.writeFileSync(path.join(output, 'main-elaina/original.pmx'), 'old-model');
  // A valid empty PMX isolates importer transaction behavior from licensed assets.
  const pmx = Buffer.alloc(17 + 4 * 4 + 9 * 4);
  pmx.write('PMX '); pmx.writeFloatLE(2, 4); pmx.set([8, 0, 0, 1, 1, 1, 1, 1, 1], 8);
  fs.writeFileSync(path.join(source, '鸣潮_千咲1.03(裙子超硬版本).pmx'), pmx);
  fs.writeFileSync(path.join(source, '鸣潮_千咲1.02.pmx'), 'invalid PMX');
  fs.writeFileSync(path.join(source, 'readme.txt'), 'fixture credit');
  const run = (...extra) => spawnSync(process.execPath, [path.join(root, 'scripts/import-town-models.mjs'), '--chisa', source, '--output', output, ...extra], { cwd: root, encoding: 'utf8', timeout: 20000 });
  assert.match(run().stderr, /Refusing to overwrite/);
  const failed = run('--append'); assert.notEqual(failed.status, 0);
  assert.equal(fs.readFileSync(manifest, 'utf8'), original, 'invalid second variant cannot publish the first');
  assert.equal(fs.existsSync(path.join(output, 'chisa')), false);
  assert.equal(fs.existsSync(path.join(output, '.import.lock')), false);
  fs.writeFileSync(path.join(source, '鸣潮_千咲1.02.pmx'), pmx);
  fs.writeFileSync(path.join(output, '.import.lock'), 'another importer');
  assert.notEqual(run('--append').status, 0, 'respect another importer lock');
  assert.equal(fs.readFileSync(manifest, 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(output, '.import.lock'), 'utf8'), 'another importer');
  fs.unlinkSync(path.join(output, '.import.lock'));
  const success = run('--append'); assert.equal(success.status, 0, success.stderr);
  const updated = JSON.parse(fs.readFileSync(manifest));
  assert.deepEqual(updated.residents['main-elaina'], old.residents['main-elaina']); assert.equal(updated.audit, old.audit);
  assert.equal(fs.readFileSync(path.join(output, 'main-elaina/original.pmx'), 'utf8'), 'old-model');
  assert.deepEqual(updated.residents.chisa.variants.map(v => v.id), ['original', 'standard']);
  for (const v of updated.residents.chisa.variants) assert.deepEqual(fs.readFileSync(path.join(output, 'chisa', v.pmx)), pmx);
  assert.equal(fs.readFileSync(path.join(output, 'chisa/LICENSE-1.txt'), 'utf8'), 'fixture credit');
  const beforeRetry = fs.readFileSync(manifest);
  assert.match(run('--append').stderr, /already imported/);
  assert.deepEqual(fs.readFileSync(manifest), beforeRetry, 'repeat import does not overwrite the catalogue');
});
test('local import integrity: every variant and texture exists, matches hash, no texture exceeds 2048', { skip: !fs.existsSync(manifestPath) }, async () => {
  const { validateCatalogue, prepareMmdData } = await library;
  const { MMDParser } = await import(pathToFileURL(path.join(root, 'web/town/lib/three/examples/jsm/libs/mmdparser.module.js')));
  const residents = validateCatalogue(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  let variants = 0;
  for (const [id, entry] of Object.entries(residents)) for (const variant of entry.variants) {
    variants++;
    for (const file of [variant, ...variant.textures]) {
      const bytes = fs.readFileSync(path.join(path.dirname(manifestPath), id, file.file || file.pmx));
      assert.equal(bytes.length, file.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
      if (file.width) assert.ok(file.width <= 2048 && file.height <= 2048);
    }
    for (const texture of variant.textures) if (texture.original) {
      const file = texture.original, bytes = fs.readFileSync(path.join(path.dirname(manifestPath), id, file.file));
      assert.equal(bytes.length, file.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
      if (file.width) assert.ok(file.width <= 8192 && file.height <= 8192);
    }
    const bytes = fs.readFileSync(path.join(path.dirname(manifestPath), id, variant.pmx));
    const data = new MMDParser.Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true);
    const prepared = prepareMmdData(data, variant.textures.map(t => t.file));
    assert.equal(prepared.metadata.morphCount, 4); assert.ok(data.metadata.morphCount > 20);
    assert.ok(prepared.bones.some(b => b.name === '頭'));
  }
  assert.equal(variants, residents.chisa ? 6 : 4);
  if (residents.chisa) assert.deepEqual(residents.chisa.variants.map(v => v.id), ['original', 'standard']);
});
