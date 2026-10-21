// Run hidden Electron with a scoped D/workspace profile; clean only that profile after exit.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
(async () => {
  const base = path.join(root, 'data/runtime/test-fixtures'); await fs.mkdir(base, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(base, 'chat-windows-'));
  try {
    const env = { ...process.env, HARBOUR_CHAT_TEST_ROOT: scratch }; delete env.ELECTRON_RUN_AS_NODE;
    await new Promise((resolve, reject) => {
      const script = process.argv.includes('--browsing') ? 'session-browsing-smoke.js' : 'chat-windows-smoke.js';
      const child = spawn(require('../../desktop/node_modules/electron'), [path.join(root, 'desktop/tests', script)],
        { cwd: root, env, windowsHide: true, stdio: 'inherit' });
      child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`UI fixture exited ${code}`)));
    });
  } finally {
    assert.equal(path.dirname(path.resolve(scratch)), base); assert.ok(path.basename(scratch).startsWith('chat-windows-'));
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
