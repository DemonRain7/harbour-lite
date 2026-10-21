const path = require('node:path');
const { spawnSync } = require('node:child_process');

// scripts/desktop-preflight.cjs — the same desktop checks locally and in CI.
const root = path.resolve(__dirname, '..');
const nodeMajor = 24;
const npmRun = (script, cwd = '.') => ({ cwd, args: ['run', script] });
const npmExec = (cwd, ...args) => ({ cwd, args: ['exec', '--no', '--', ...args] });
const groups = {
  prepare: [npmRun('folia:prepare')],
  contracts: ['typecheck', 'test:main-policy', 'test:identity', 'test:shared-state', 'test:desktop-preflight'].map(s => npmRun(s)),
  startup: [npmRun('desktop:check'), ...['test:startup', 'test:live2d-installer', 'build:companion'].map(s => npmRun(s, 'desktop')),
    { cwd: '.', node: ['desktop/tests/companion-runtime.test.js'] }],
  'folia-logic': [npmExec('vendor/folia', 'tsc', '--noEmit'), npmExec('vendor/folia', 'vitest', 'run',
    'test/unit/visualizer/webglFallback.test.ts', 'test/unit/visualizer/monetSettings.test.ts',
    'test/unit/visualizer/temperaWorkshopModel.test.ts', 'test/unit/visualizer/temperaSettings.test.ts',
    'test/unit/visualizer/temperaImageLayer.test.ts', 'test/unit/services/temperaImageArchive.test.ts',
    'test/unit/visualizer/visualSettingsImportExport.test.ts', 'test/unit/command-palette/commandRegistryContract.test.ts')],
  'folia-integration': [npmRun('test:folia')],
  'folia-fallback': [npmRun('test:folia-no-webgl', 'desktop')],
  'folia-layout': ['test:folia-device-menu', 'test:folia-compact'].map(s => npmRun(s, 'desktop')),
  'folia-workshop': [npmRun('test:folia-workshop', 'desktop')],
  'music-controls': ['test:folia-source-menu', 'test:folia-shuffle', 'test:music-companion'].map(s => npmRun(s, 'desktop')),
  composer: [npmRun('test:composer-ui')],
  sessions: [npmRun('test:session-browsing-ui')],
  'file-changes': [npmRun('test:file-changes-ui')],
  cowork: [npmRun('test:cowork-ui')],
};

function selectGroups(args) {
  if (!args.length || (args.length === 1 && args[0] === '--list')) return Object.keys(groups);
  if (args.length === 2 && args[0] === '--group' && Object.hasOwn(groups, args[1])) return [args[1]];
  throw new Error('Usage: desktop-preflight.cjs [--list | --group <known group>]');
}

function assertNodeVersion(version) {
  if (Number(version.replace(/^v/, '').split('.')[0]) !== nodeMajor) {
    throw new Error(`Desktop preflight requires Node ${nodeMajor}.x to match CI (current ${version}); it does not change your global Node installation`);
  }
}

function executeStep(step) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const isNpm = !step.node;
  const command = isNpm ? (process.platform === 'win32' ? 'npm.cmd' : 'npm') : process.execPath;
  // All arguments are repository-owned constants, never free-form shell input.
  const result = spawnSync(command, step.node || step.args, {
    cwd: path.join(root, step.cwd), env, stdio: 'inherit',
    shell: isNpm && process.platform === 'win32', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Preflight failed: ${step.cwd}: ${command} ${(step.node || step.args).join(' ')} (${result.status ?? result.signal})`);
}

function runGroups(ids, execute = executeStep) {
  for (const id of ids) {
    if (!Object.hasOwn(groups, id)) throw new Error(`Unknown preflight group: ${id}`);
    console.log(`[desktop-preflight] ${id}`);
    for (const step of groups[id]) execute(step);
  }
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2), ids = selectGroups(args);
    if (args[0] === '--list') {
      for (const id of ids) console.log(`${id}: ${groups[id].map(s => `${s.cwd}: ${s.node ? 'node' : 'npm'} ${(s.node || s.args).join(' ')}`).join(' ; ')}`);
    } else {
      assertNodeVersion(process.version);
      console.log(`[desktop-preflight] ${process.platform}/${process.arch}, Node ${process.version}; local checks only, no push or Actions dispatch`);
      runGroups(ids);
      console.log(`[desktop-preflight] PASS ${ids.length} groups on ${process.platform}/${process.arch}; other OS/packaged builds are not certified by this result`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { groups, selectGroups, runGroups, nodeMajor, assertNodeVersion };
