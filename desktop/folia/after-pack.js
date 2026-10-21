const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function verifyFoliaResources(root, platform) {
  const packageFile = path.join(root, 'package.json');
  const requireFolia = createRequire(packageFile);
  const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const dependencies = Object.keys(packageJson.dependencies || {});
  const modulesRoot = fs.realpathSync(path.join(root, 'node_modules')) + path.sep;
  for (const name of dependencies) {
    const resolved = fs.realpathSync(requireFolia.resolve(name));
    if (!resolved.startsWith(modulesRoot)) throw new Error(`Folia 缺少包内依赖 ${name}；禁止借用源码工作区依赖冒充打包成功。`);
  }
  for (const name of ['dist/index.html', 'electron/main.cjs', 'LICENSE', 'UPSTREAM.json',
    `ffmpeg-audio/ffmpeg${platform === 'win32' ? '.exe' : ''}`,
    ...(platform === 'win32' ? ['build/folia-wallpaper-helper.exe', 'build/folia-wallpaper-helper.provenance.json'] : [])]) {
    if (!fs.statSync(path.join(root, name)).isFile()) throw new Error(`Folia 包内资源缺失：${name}`);
  }
  return { dependencies: dependencies.length };
}

module.exports = async context => {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app', 'Contents/Resources')
    : path.join(context.appOutDir, 'resources');
  const root = path.join(resources, 'folia');
  await require(path.resolve(__dirname, '../../vendor/folia/build/afterPack.cjs')).default(
    context, path.join(root, 'node_modules/onnxruntime-node/bin/napi-v6'));
  const result = verifyFoliaResources(root, context.electronPlatformName);
  console.log(`[Folia] verified ${result.dependencies} packaged runtime dependencies and native resources`);
};
module.exports.verifyFoliaResources = verifyFoliaResources;
