const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { backup, restore } = require('../../scripts/local-state.cjs');

test('first-pull backup survives Git removal; restore never overwrites newer files or definitions', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'harbour-backup-'));
  const root = path.join(temp, 'checkout');
  try {
    await fs.mkdir(path.join(root, 'data/sessions'), { recursive: true });
    await fs.writeFile(path.join(root, 'data/sessions/a.json'), 'old-chat');
    await fs.writeFile(path.join(root, 'data/cron.json'), 'legacy-cron');
    await fs.writeFile(path.join(root, '.env'), 'SECRET_NOT_IN_BACKUP');
    const saved = await backup(root, path.join(temp, 'backups'));
    assert.equal(saved.files, 2);
    await fs.unlink(path.join(root, 'data/sessions/a.json'));
    await fs.writeFile(path.join(root, 'data/cron.json'), 'new-definition');
    assert.equal((await restore(root, saved.backupPath)).restored, 1);
    assert.equal(await fs.readFile(path.join(root, 'data/sessions/a.json'), 'utf8'), 'old-chat');
    assert.equal(await fs.readFile(path.join(root, 'data/cron.json'), 'utf8'), 'new-definition');
    await fs.writeFile(path.join(root, 'data/sessions/a.json'), 'new-chat');
    assert.equal((await restore(root, saved.backupPath)).restored, 0);
    assert.equal(await fs.readFile(path.join(root, 'data/sessions/a.json'), 'utf8'), 'new-chat');
    const other = path.join(temp, 'other'); await fs.mkdir(other);
    await assert.rejects(restore(other, saved.backupPath), /belong/);
    await fs.writeFile(path.join(saved.backupPath, 'files/data/sessions/a.json'), 'tampered');
    await assert.rejects(restore(root, saved.backupPath), /checksum/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('backup refuses a symlinked ancestor instead of copying another directory', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'harbour-backup-link-'));
  const root = path.join(temp, 'checkout');
  try {
    await fs.mkdir(root);
    const outside = path.join(temp, 'outside');
    await fs.mkdir(path.join(outside, 'sessions'), { recursive: true });
    await fs.writeFile(path.join(outside, 'sessions/private.json'), 'not-checkout-data');
    await fs.symlink(outside, path.join(root, 'data'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(backup(root, path.join(temp, 'backups')), /Symlink/);
    assert.equal(await fs.readFile(path.join(outside, 'sessions/private.json'), 'utf8'), 'not-checkout-data');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('machine-local QQ bindings and approval records survive untracking without overwriting current state', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'harbour-backup-identity-'));
  const root = path.join(temp, 'checkout');
  try {
    await fs.mkdir(path.join(root, 'data'), { recursive: true });
    await fs.mkdir(path.join(root, 'assets/Memory/.governance'), { recursive: true });
    const records = {
      'data/qqBindings.json': '{"version":1,"accounts":{"fixture":{"ownerOpenids":["fixture-owner"]}}}',
      'assets/Memory/.governance/proposals.json': '[{"id":"fixture-proposal"}]',
      'assets/Memory/.governance/audit.jsonl': '{"id":"fixture-audit"}\n',
    };
    for (const [file, text] of Object.entries(records)) await fs.writeFile(path.join(root, file), text);
    const saved = await backup(root, path.join(temp, 'backups'));
    assert.equal(saved.files, 3);
    for (const file of Object.keys(records)) await fs.unlink(path.join(root, file));
    assert.equal((await restore(root, saved.backupPath)).restored, 3);
    for (const [file, text] of Object.entries(records)) assert.equal(await fs.readFile(path.join(root, file), 'utf8'), text);
    await fs.writeFile(path.join(root, 'data/qqBindings.json'), 'new-local-binding');
    assert.equal((await restore(root, saved.backupPath)).restored, 0);
    assert.equal(await fs.readFile(path.join(root, 'data/qqBindings.json'), 'utf8'), 'new-local-binding');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('repository excludes runtime identity/approval state but keeps accepted Memory and portable configuration', async () => {
  const { execFileSync } = require('node:child_process');
  const repo = path.resolve(__dirname, '../..');
  const local = ['data/qqBindings.json', 'assets/Memory/.governance/proposals.json',
    'assets/Memory/.governance/audit.jsonl', 'data/sessions/fixture.json', 'data/spaces/fixture.json',
    'assets/uploads/fixture.png', 'data/calendar/fixture.json', 'data/gmail/fixture.json', '.env'];
  const kept = ['data/models.json', 'data/cron.json', 'assets/Memory/index.md', '.env.example'];
  const ignored = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
    cwd: repo, input: [...local, ...kept].join('\n') + '\n', encoding: 'utf8',
  }).trim().split(/\r?\n/);
  assert.deepEqual(ignored.sort(), local.sort());
});
