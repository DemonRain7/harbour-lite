const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { refreshAnonymousToken, resolveXeapiPublicKey } = require('./neteaseApiStartup.cjs');

// electron/neteaseRuntime.cjs
// Loaded exclusively by the provider worker; imports include jsdom and hundreds of API routes.
async function startNeteaseRuntime({ port, shouldStop }) {
  const tokenPath = path.join(os.tmpdir(), 'anonymous_token');
  const xeapiPublicKeyPath = path.join(os.tmpdir(), 'xeapi_public_key');
  // The package reads this synchronously on import, before its first HTTP request.
  await fs.promises.mkdir(os.tmpdir(), { recursive: true });
  try { await fs.promises.writeFile(tokenPath, '', { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  // The package's aggregate entry eagerly imports hundreds of endpoints. Only this one
  // registration handler is needed here; preserve its public wrapper's cookie normalization.
  const { getXeapiPublicKey } = require('@neteasecloudmusicapienhanced/api/util/xeapiKey');
  const { cookieToJson, generateDeviceId, generateRandomChineseIP } = require('@neteasecloudmusicapienhanced/api/util/index');
  const registerAnonymous = (data = {}) => require('@neteasecloudmusicapienhanced/api/module/register_anonimous')({
    ...data, cookie: typeof data.cookie === 'string' ? cookieToJson(data.cookie) : data.cookie || {},
  }, (...args) => require('@neteasecloudmusicapienhanced/api/util/request')(...args));
  global.cnIp = generateRandomChineseIP();
  global.deviceId ||= generateDeviceId();
  let currentPublicKey = {};
  try { currentPublicKey = JSON.parse(await fs.promises.readFile(xeapiPublicKeyPath, 'utf8')); }
  catch { /* Missing/invalid anonymous cache is refreshed by the same existing startup policy. */ }
  const retryOptions = { shouldRetry: () => !shouldStop() };
  const { publicKey, refreshed } = await resolveXeapiPublicKey({
    currentPublicKey, deviceId: global.deviceId, getXeapiPublicKey, retryOptions,
  });
  if (shouldStop()) return null;
  if (refreshed) await fs.promises.writeFile(xeapiPublicKeyPath, JSON.stringify(publicKey));
  await refreshAnonymousToken({
    registerAnonymous, cookieToJson, retryOptions,
    persistToken: token => !shouldStop() && fs.promises.writeFile(tokenPath, token),
  });
  if (shouldStop()) return null;
  const { serveNcmApi } = require('@neteasecloudmusicapienhanced/api/server');
  const app = await serveNcmApi({ port, host: '127.0.0.1', checkVersion: false });
  const server = app.server;
  await new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    const failed = error => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', failed); resolve(); };
    server.once('error', failed); server.once('listening', ready);
  });
  return { close: () => new Promise(resolve => {
    server.close(resolve); server.closeAllConnections?.();
  }) };
}

module.exports = { startNeteaseRuntime };
