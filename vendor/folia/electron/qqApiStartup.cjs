// electron/qqApiStartup.cjs
//
// Starts @yakult-green-tea/qq-music-api inside the Electron main process. The package is a regular
// production dependency, so npm nests its own ws@7 under it and the app's ws@8 is left alone.

const QQ_API_MODULE = '@yakult-green-tea/qq-music-api';

function getErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return typeof error === 'string' && error.trim() ? error : 'Unknown error';
}

// A missing package is a packaging problem the user can act on; anything else (a port that is
// already taken, a throw from inside the package) is a runtime failure. Callers map the two to
// different statuses, so the distinction must survive the throw.
function isModuleNotFound(error) {
  return Boolean(error) && error.code === 'MODULE_NOT_FOUND';
}

// The package calls app.listen() while it is being required, so require() returns before the socket
// is bound. Resolving only on 'listening' keeps the caller from reporting "running" against a port
// that may still fail to bind; a bind failure arrives as 'error' and is surfaced as a rejection
// rather than an unhandled event on the server.
function waitUntilListening(server) {
  return new Promise((resolve, reject) => {
    if (server.listening) {
      resolve(server);
      return;
    }

    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server);
    };

    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };

    server.once('listening', onListening);
    server.once('error', onError);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

// The package listens on import and reads PORT at config load, so the environment is prepared first
// and restored afterwards to keep the main process environment untouched.
//
// Standalone mode starts once per process. Harbour hosted mode uses the package's public Koa
// app to create a fresh loopback listener; unloading/reopening never reuses a closed HTTP server.
async function startQqApi(options = {}) {
  const {
    port,
    stateFilePath,
    authSessionRepository,
    moduleId = QQ_API_MODULE,
    loadModule = (target) => require(target),
    env = process.env,
    hosted = false,
  } = options;

  if (!port) {
    throw new Error('A port is required to start the QQ API');
  }

  const previous = {
    PORT: env.PORT,
    NODE_ENV: env.NODE_ENV,
    AUTO_OPEN_EXPLORER: env.AUTO_OPEN_EXPLORER,
    QQ_AUTH_STATE_PATH: env.QQ_AUTH_STATE_PATH,
    QQ_DISABLE_UPDATE_CHECK: env.QQ_DISABLE_UPDATE_CHECK,
  };

  const restore = () => {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    });
  };

  env.PORT = String(port);
  env.AUTO_OPEN_EXPLORER = 'false';
  env.QQ_DISABLE_UPDATE_CHECK = 'true';
  // In pinned QQ API 3.1.0 this disables import-time listen/explorer/log chatter only;
  // routes, transport and auth persistence are unchanged. Restored synchronously below.
  if (hosted) env.NODE_ENV = 'test';
  if (stateFilePath) {
    env.QQ_AUTH_STATE_PATH = stateFilePath;
  }

  let qqApi;
  try {
    qqApi = loadModule(moduleId);
    if (authSessionRepository) {
      const configureAuthSessionRepository = qqApi && (
        qqApi.configureAuthSessionRepository ||
        (qqApi.default && qqApi.default.configureAuthSessionRepository)
      );
      if (typeof configureAuthSessionRepository !== 'function') {
        throw new Error(
          `QQ API package ${moduleId} does not support auth session persistence`,
        );
      }
      // require() starts the server, but Node cannot accept an HTTP request until this synchronous
      // stack returns. Injecting here restores encrypted credentials before the first status probe.
      configureAuthSessionRepository(authSessionRepository);
    }
  } catch (error) {
    if (isModuleNotFound(error)) {
      const missing = new Error(
        `QQ API package ${moduleId} is not installed. Run: npm install`,
        { cause: error },
      );
      missing.code = 'MODULE_NOT_FOUND';
      throw missing;
    }

    throw error;
  } finally {
    restore();
  }

  let server = qqApi && (qqApi.server || (qqApi.default && qqApi.default.server));
  if (hosted) {
    if (server?.listening) throw new Error('QQ API was loaded outside the hosted lifecycle');
    if (typeof qqApi?.default?.callback !== 'function') throw new Error('QQ API does not expose the expected Koa app');
    server = require('node:http').createServer(qqApi.default.callback());
    server.listen(port, '127.0.0.1');
  }
  if (!server || typeof server.once !== 'function') {
    throw new Error(
      `QQ API package ${moduleId} did not expose an HTTP server`,
    );
  }

  await waitUntilListening(server);

  // Once bound, later socket errors must not take the main process down with an unhandled 'error'.
  server.on('error', (error) => {
    console.error('[QQ API] server error', error);
  });

  return {
    port,
    stateFilePath: stateFilePath || null,
    server,
    close: () => closeServer(server),
  };
}

module.exports = {
  QQ_API_MODULE,
  getErrorMessage,
  isModuleNotFound,
  startQqApi,
};
