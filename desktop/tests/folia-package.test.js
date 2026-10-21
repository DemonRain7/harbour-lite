const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyFoliaResources } = require('../folia/after-pack');
const { packagedFoliaRoot } = require('./packaged-folia-root');
const { dependencyPlan, prepareDependencies, applyDependencyPatches } = require('../../scripts/prepare-folia.cjs');

test('desktop packaging includes the complete Folia host and recovery dependency', () => {
  const { build } = require('../package.json');
  for (const file of ['folia/host.js', 'folia/controller.js', 'folia/renderer-health.js', 'folia/crash-reporting.js',
    'folia/device-menu.js', 'folia/device-menu.html', 'folia/device-menu-preload.js']) {
    assert.ok(build.files.includes(file), `missing packaged host file: ${file}`);
    assert.ok(fs.existsSync(path.join(__dirname, '..', file)));
  }
});

test('packaged smoke targets each native artifact rather than the Windows source tree', () => {
  assert.equal(packagedFoliaRoot('/fixture', 'darwin', 'arm64'), path.join('/fixture/dist/mac-arm64/Harbour.app/Contents/Resources/folia'));
  assert.equal(packagedFoliaRoot('/fixture', 'darwin', 'x64'), path.join('/fixture/dist/mac/Harbour.app/Contents/Resources/folia'));
  assert.equal(packagedFoliaRoot('/fixture', 'win32', 'x64'), path.join('/fixture/dist/win-unpacked/resources/folia'));
});

function fixture(t, dependencyLocation = 'inside') {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-folia-package-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'folia');
  const write = (name, data) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file, data); };
  write('package.json', JSON.stringify({ dependencies:{'harbour-fake-folia-dep':'1.0.0'} }));
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive:true });
  for (const name of ['dist/index.html','electron/main.cjs','LICENSE','UPSTREAM.json','ffmpeg-audio/ffmpeg.exe',
    'ffmpeg-audio/ffmpeg','build/folia-wallpaper-helper.exe','build/folia-wallpaper-helper.provenance.json']) write(name, 'fixture');
  if (dependencyLocation !== 'missing') {
    write(`${dependencyLocation === 'inside' ? '' : '../'}node_modules/harbour-fake-folia-dep/package.json`, JSON.stringify({name:'harbour-fake-folia-dep', main:'index.js'}));
    write(`${dependencyLocation === 'inside' ? '' : '../'}node_modules/harbour-fake-folia-dep/index.js`, 'module.exports = {};');
  }
  return root;
}
test('package validation resolves runtime modules inside the artifact, for Windows and Mac', t => {
  const root = fixture(t);
  assert.deepEqual(verifyFoliaResources(root, 'win32'), { dependencies:1 });
  assert.deepEqual(verifyFoliaResources(root, 'darwin'), { dependencies:1 });
});
test('missing runtime dependency fails instead of accepting a built UI', t => {
  assert.throws(() => verifyFoliaResources(fixture(t, 'missing'), 'win32'), /Cannot find module/);
});
test('a resolvable dependency outside the package cannot mask broken packaging', t => {
  assert.throws(() => verifyFoliaResources(fixture(t, 'outside'), 'win32'), /禁止借用源码工作区依赖/);
});
test('hosted packaging reuses upstream native-platform pruning without touching other resources', async t => {
  const root = fixture(t);
  const binaries = path.join(root, 'node_modules/onnxruntime-node/bin/napi-v6');
  for (const target of ['win32/x64', 'win32/arm64', 'darwin/arm64', 'linux/x64']) {
    fs.mkdirSync(path.join(binaries, target), { recursive:true });
    fs.writeFileSync(path.join(binaries, target, 'native.node'), 'fixture');
  }
  await require('../../vendor/folia/build/afterPack.cjs').default({
    arch:1, electronPlatformName:'win32', appOutDir:root,
    packager:{getResourcesDir:()=>root},
  }, binaries);
  assert.deepEqual(fs.readdirSync(binaries), ['win32']);
  assert.deepEqual(fs.readdirSync(path.join(binaries, 'win32')), ['x64']);
  assert.equal(fs.existsSync(path.join(root, 'electron/main.cjs')), true);
});

function dependencyFixture(t) {
  const root = fixture(t);
  const write = (name, contents) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  write('package-lock.json', '{"lockfileVersion":3}');
  write('patches/example+1.0.0.patch', 'fixture patch');
  write('node_modules/patch-package/index.js', '// fixture CLI; not executed');
  return { root, write, marker: path.join(root, 'node_modules/.harbour-lock') };
}

test('dependency fingerprint tracks lock and patch content/name/removal, not patch documentation', t => {
  const { root, write } = dependencyFixture(t);
  const first = dependencyPlan(root);
  assert.deepEqual(first.patches.map(patch => patch.file), ['example+1.0.0.patch']);
  write('patches/README.md', 'Documentation does not change installed code.');
  assert.equal(dependencyPlan(root).fingerprint, first.fingerprint);
  write('patches/example+1.0.0.patch', 'new patch');
  const changed = dependencyPlan(root).fingerprint;
  assert.notEqual(changed, first.fingerprint);
  fs.renameSync(path.join(root, 'patches/example+1.0.0.patch'), path.join(root, 'patches/example+1.0.1.patch'));
  const renamed = dependencyPlan(root).fingerprint;
  assert.notEqual(renamed, changed);
  fs.unlinkSync(path.join(root, 'patches/example+1.0.1.patch'));
  const removed = dependencyPlan(root).fingerprint;
  assert.notEqual(removed, renamed);
  write('package-lock.json', '{"lockfileVersion":3,"version":"2"}');
  assert.notEqual(dependencyPlan(root).fingerprint, removed);
});

test('source dependencies install without hooks and patch before caching success', t => {
  const { root, write, marker } = dependencyFixture(t);
  const calls = [];
  const install = (args, cwd) => {
    calls.push('ci');
    assert.deepEqual(args, ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    assert.equal(cwd, root);
    assert.equal(fs.existsSync(marker), false);
    write('node_modules/fixture-installed.txt', 'pristine');
  };
  const run = (binary, args, options) => {
    calls.push('patch');
    assert.equal(binary, process.execPath);
    assert.deepEqual(args, [path.join(root, 'node_modules/patch-package/index.js'), '--error-on-fail', '--patch-dir', 'patches']);
    assert.equal(options.cwd, root);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(fs.readFileSync(path.join(root, 'node_modules/fixture-installed.txt'), 'utf8'), 'pristine');
    write('node_modules/fixture-installed.txt', 'patched');
    return { status: 0 };
  };
  const first = prepareDependencies({ cwd: root, install, run });
  assert.equal(fs.readFileSync(marker, 'utf8'), first.fingerprint);
  prepareDependencies({ cwd: root, install, run });
  assert.deepEqual(calls, ['ci', 'patch']);
  write('patches/example+1.0.0.patch', 'changed after first install');
  prepareDependencies({ cwd: root, install, run });
  assert.deepEqual(calls, ['ci', 'patch', 'ci', 'patch']);
  prepareDependencies({ cwd: root, force: true, install, run });
  assert.deepEqual(calls, ['ci', 'patch', 'ci', 'patch', 'ci', 'patch']);
});

test('patch failure never caches success and retry starts with a clean install', t => {
  const { root, write, marker } = dependencyFixture(t);
  write('node_modules/.harbour-lock', 'legacy lock-only marker');
  let installs = 0;
  const install = () => { installs += 1; assert.equal(fs.existsSync(marker), false); };
  assert.throws(() => prepareDependencies({ cwd: root, install, run: () => ({ status: 1 }) }), /dependency patch failed/);
  assert.equal(fs.existsSync(marker), false);
  prepareDependencies({ cwd: root, install, run: () => ({ status: 0 }) });
  assert.equal(installs, 2);
  assert.equal(fs.readFileSync(marker, 'utf8'), dependencyPlan(root).fingerprint);
});

test('patch deletion reinstalls pristine dependencies and does not execute removed patches', t => {
  const { root, marker } = dependencyFixture(t);
  fs.writeFileSync(marker, dependencyPlan(root).fingerprint);
  fs.unlinkSync(path.join(root, 'patches/example+1.0.0.patch'));
  let installs = 0;
  prepareDependencies({ cwd: root, install: () => { installs += 1; }, run: () => assert.fail('deleted patch executed') });
  assert.equal(installs, 1);
});

test('production dependencies are patched in the stage by the source-only dev CLI', t => {
  const source = dependencyFixture(t);
  const target = dependencyFixture(t);
  fs.unlinkSync(path.join(target.root, 'node_modules/patch-package/index.js'));
  let calls = 0;
  applyDependencyPatches(target.root, { toolRoot: source.root, run: (binary, args, options) => {
    calls += 1;
    assert.equal(binary, process.execPath);
    assert.equal(args[0], path.join(source.root, 'node_modules/patch-package/index.js'));
    assert.ok(args.includes('--error-on-fail'));
    assert.equal(options.cwd, target.root);
    return { status: 0 };
  } });
  assert.equal(calls, 1);
  const staging = fs.readFileSync(path.join(__dirname, '../folia/before-pack.js'), 'utf8');
  assert.match(staging, /'patches'.*'LICENSE'/);
  assert.match(staging, /'ci', '--omit=dev', '--ignore-scripts'/);
  assert.match(staging, /applyDependencyPatches\(target, \{ toolRoot: root \}\)/);
});

test('a missing patch tool or malformed patch entry is a hard preparation error', t => {
  const { root } = dependencyFixture(t);
  fs.unlinkSync(path.join(root, 'node_modules/patch-package/index.js'));
  assert.throws(() => applyDependencyPatches(root, { toolRoot: root }), /require patch-package/);
  fs.mkdirSync(path.join(root, 'patches/invalid.patch'));
  assert.throws(() => dependencyPlan(root), /regular file/);
});
