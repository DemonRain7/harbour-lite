const { workerData } = require('node:worker_threads');
const net = require('node:net');
const path = require('node:path');

// desktop/tests/fixtures/folia-provider-offline.cjs
// Real provider packages and listeners, but synthetic anonymous registration and no Internet.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = args[0];
  const host = typeof options === 'object' ? options.host : typeof args[1] === 'string' ? args[1] : '';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Fixture forbids outbound sockets');
  return connect.apply(this, args);
};
const startup = require(path.join(path.dirname(workerData.entry), 'neteaseApiStartup.cjs'));
startup.resolveXeapiPublicKey = async () => ({ publicKey: { sk: 'fixture' }, refreshed: false });
startup.refreshAnonymousToken = async () => true;
require(workerData.entry);
