const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

// Reproducible desktop build. No clone-at-runtime, account import or AI/model downloads.
const root = path.resolve(__dirname, '../vendor/folia');
function npm(args, cwd = root, env = {}) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd, env: { ...process.env, ...env }, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Folia npm ${args[0]} failed (${result.status})`);
}
function dependencyPlan(cwd = root) {
  const hash = value => createHash('sha256').update(value).digest('hex');
  const lock = hash(fs.readFileSync(path.join(cwd, 'package-lock.json')));
  const patchDir = path.join(cwd, 'patches');
  const patches = fs.existsSync(patchDir) ? fs.readdirSync(patchDir).filter(name => name.endsWith('.patch')).sort().map(name => {
    const file = path.join(patchDir, name);
    if (!fs.lstatSync(file).isFile()) throw new Error(`Folia patch must be a regular file: ${name}`);
    return { file: name, sha256: hash(fs.readFileSync(file)) };
  }) : [];
  return { lock, patches, fingerprint: hash(JSON.stringify({ version: 1, lock, patches })) };
}

// Only run upstream's reviewed dependency patches, never arbitrary install hooks.
// The production stage has no devDependencies: use the source tree's CLI there.
function applyDependencyPatches(cwd = root, { toolRoot = root, run = spawnSync, plan = dependencyPlan(cwd) } = {}) {
  if (!plan.patches.length) return;
  const cli = path.join(toolRoot, 'node_modules/patch-package/index.js');
  if (!fs.existsSync(cli)) throw new Error('Folia dependency patches require patch-package; run folia:prepare first.');
  const result = run(process.execPath, [cli, '--error-on-fail', '--patch-dir', 'patches'], {
    cwd, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Folia dependency patch failed (${result.status}); dependencies were not marked ready.`);
}

function prepareDependencies({ cwd = root, force = false, install = npm, run = spawnSync } = {}) {
  const plan = dependencyPlan(cwd);
  const marker = path.join(cwd, 'node_modules/.harbour-lock');
  if (force || !fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== plan.fingerprint) {
    // A changed or removed patch must start from the locked pristine package, not
    // layer a second diff onto yesterday's patched files. Failure cannot cache success.
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
    install(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd);
    applyDependencyPatches(cwd, { toolRoot: cwd, run, plan });
    fs.writeFileSync(marker, plan.fingerprint);
  }
  return plan;
}
function prepare({ force = false } = {}) {
  if (!fs.existsSync(path.join(root, 'package-lock.json'))) throw new Error('缺少 vendor/folia 源码；请完整更新仓库。');
  require('../desktop/folia/windows-helper').prepareWindowsHelper(root);
  const { lock, patches, fingerprint } = prepareDependencies({ force });
  // Lifecycle scripts stay opt-in (notably optional audio-analysis model downloads).
  npm(['run', 'build'], root, { ELECTRON: 'true', ELECTRON_DEV: 'false' });
  fs.writeFileSync(path.join(root, 'dist/harbour-build.json'), JSON.stringify({ upstream: require('../vendor/folia/UPSTREAM.json').commit, lock, patches, dependencyFingerprint: fingerprint, builtAt: new Date().toISOString() }));
}
if (require.main === module) { try { prepare({ force: process.argv.includes('--force') }); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { prepare, npm, root, dependencyPlan, applyDependencyPatches, prepareDependencies };
