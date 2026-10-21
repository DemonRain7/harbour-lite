const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { prepareWindowsHelper, sourceDigest } = require('../folia/windows-helper');
const pin = require('../folia/vendor/windows-wallpaper/provenance.json');
const originalRoot = path.resolve(__dirname, '../../vendor/folia');
const sourceDir = 'packaging/windows/wallpaper-helper';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-folia-helper-'));
  fs.cpSync(path.join(originalRoot, sourceDir), path.join(root, sourceDir), {
    recursive: true, filter: file => !file.split(path.sep).includes('target'),
  });
  // The only deletion target is this freshly allocated test directory.
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const options = { platform: 'win32', arch: 'x64' };

test('pinned Windows helper matches full vendored source and installs idempotently', t => {
  const root = fixture(t);
  assert.equal(sourceDigest(root), pin.sourceSha256);
  assert.equal(prepareWindowsHelper(root, options), true);
  const output = path.join(root, 'build/folia-wallpaper-helper.exe');
  const before = fs.statSync(output);
  assert.equal(prepareWindowsHelper(root, options), true);
  assert.equal(fs.statSync(output).mtimeMs, before.mtimeMs);
  const bytes = fs.readFileSync(output);
  assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
  const peOffset = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt32LE(peOffset), 0x4550);
  assert.equal(bytes.readUInt16LE(peOffset + 4), 0x8664, 'AMD64, never an accidental ARM helper');
});

test('source identity ignores checkout CRLF but detects edits and extra modules', t => {
  const root = fixture(t);
  const file = path.join(root, sourceDir, 'src/main.rs');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace(/\r?\n/g, '\r\n'));
  assert.equal(sourceDigest(root), pin.sourceSha256);
  fs.appendFileSync(file, '\n// a changed helper\n');
  assert.throws(() => prepareWindowsHelper(root, options), /源码已变化/);
  assert.equal(fs.existsSync(path.join(root, 'build')), false);
  fs.writeFileSync(file, original);
  fs.writeFileSync(path.join(root, sourceDir, 'src/new.rs'), '// newly added module');
  assert.throws(() => prepareWindowsHelper(root, options), /源码清单已变化/);
});

test('binary mismatch fails before publishing; other targets never get an x64 helper', t => {
  const root = fixture(t);
  const binaryPath = path.join(root, 'wrong.exe');
  fs.writeFileSync(binaryPath, 'not the verified binary');
  assert.throws(() => prepareWindowsHelper(root, { ...options, binaryPath }), /SHA-256/);
  assert.equal(fs.existsSync(path.join(root, 'build')), false);
  assert.equal(prepareWindowsHelper('does-not-exist', { platform: 'darwin', arch: 'arm64' }), false);
  assert.equal(prepareWindowsHelper('does-not-exist', { platform: 'win32', arch: 'arm64' }), false);
});
