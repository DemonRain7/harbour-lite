const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require(path.join(root, 'desktop/node_modules/electron')), [path.join(root, 'desktop/tests/message-intake-smoke.cjs')], {
  cwd: root, env, windowsHide: true, stdio: 'inherit', timeout: 45000,
});
if (result.error) console.error(result.error); process.exitCode = result.status ?? 1;
