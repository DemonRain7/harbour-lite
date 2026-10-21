const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const manifest = require('./vendor/windows-wallpaper/provenance.json');

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sourceDigest(root) {
  const base = path.join(root, 'packaging/windows/wallpaper-helper');
  const actualFiles = ['Cargo.lock', 'Cargo.toml', ...fs.readdirSync(path.join(base, 'src'), { recursive: true })
    .filter(name => fs.statSync(path.join(base, 'src', name)).isFile()).map(name => 'src/' + name.split(path.sep).join('/'))].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(manifest.sourceFiles)) throw new Error('Folia 壁纸助手源码清单已变化；请更新校验记录。');
  const hash = createHash('sha256');
  for (const name of manifest.sourceFiles) {
    hash.update(name + '\0').update(fs.readFileSync(path.join(base, name), 'utf8').replace(/\r\n/g, '\n'));
  }
  return hash.digest('hex');
}

// A small, verified upstream release binary avoids requiring a system-wide
// Rust/MSVC installation just to run the unmodified Windows wallpaper helper.
// Updating the helper sources requires an explicit new pin, never silent reuse.
function prepareWindowsHelper(root, { platform = process.platform, arch = process.arch, binaryPath = path.join(__dirname, 'vendor/windows-wallpaper/folia-wallpaper-helper.exe') } = {}) {
  if (platform !== 'win32' || arch !== 'x64') return false;
  if (sourceDigest(root) !== manifest.sourceSha256) throw new Error('Folia 壁纸助手源码已变化；请重新构建并更新二进制校验记录。');
  const bytes = fs.readFileSync(binaryPath);
  if (sha256(bytes) !== manifest.sha256) throw new Error('Folia 壁纸助手 SHA-256 校验失败。');
  const output = path.join(root, 'build/folia-wallpaper-helper.exe');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (!fs.existsSync(output) || sha256(fs.readFileSync(output)) !== manifest.sha256) fs.writeFileSync(output, bytes);
  return true;
}

module.exports = { prepareWindowsHelper, sourceDigest };
