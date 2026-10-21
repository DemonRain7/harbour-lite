const path = require('node:path');

function packagedFoliaRoot(desktopRoot, platform = process.platform, arch = process.arch) {
  const output = platform === 'darwin'
    ? path.join(arch === 'arm64' ? 'mac-arm64' : 'mac', 'Harbour.app', 'Contents', 'Resources')
    : platform === 'win32' ? 'win-unpacked/resources' : 'linux-unpacked/resources';
  return path.join(desktopRoot, 'dist', output, 'folia');
}
module.exports = { packagedFoliaRoot };
