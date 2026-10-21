import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import pino from 'pino';
import { startServer, type ServerDeps } from '../../src/server/api';
import { LogBroadcaster } from '../../src/server/logBroadcaster';
import { isPrivateTownAssetPath } from '../../src/server/townAssets';

async function run() {
  const privatePaths = ['/town/models/local/manifest.json', '/TOWN/MODELS/local/manifest.json',
    '/town//models/local/manifest.json', '/town/a/../models/local/manifest.json', '/town\\models\\local\\manifest.json',
    '/town/audio/local/lingering-summer-light.m4a', '/TOWN/AUDIO/LOCAL/track.m4a',
    '/town//audio/local/track.m4a', '/town/a/../audio/local/track.m4a', '/town\\audio\\local\\track.m4a'];
  for (const pathname of privatePaths) assert.equal(isPrivateTownAssetPath(pathname), true, pathname);
  for (const pathname of ['/town/index.html', '/town/model-data.js', '/town/models.css', '/town/models-other/foo']) assert.equal(isPrivateTownAssetPath(pathname), false, pathname);
  for (const token of ['', 'town-assets-test']) {
    const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address(); assert.ok(address && typeof address !== 'string');
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const server = startServer({ port: address.port, host: '127.0.0.1', logger: pino({ level: 'silent' }),
      broadcaster: new LogBroadcaster(2), runtime: { asks: { onChange() {} } },
      env: { WEB_AUTH_TOKEN: token, WEB_CORS: true }, queue: { stats: () => ({ active: 0, queued: 0 }) },
    } as unknown as ServerDeps);
    const base = `http://127.0.0.1:${address.port}`;
    try {
      for (const pathname of privatePaths) {
        const response = await fetch(base + pathname, { headers: token ? {} : { Origin: 'https://foreign.invalid' } });
        assert.equal(response.status, token ? 401 : 403, pathname);
      }
      const authorized = await fetch(base + '/town/models/local/manifest.json', { headers: token ? { 'x-harbour-token': token } : {} });
      assert.equal(authorized.status, 200);
      if (existsSync('web/town/audio/local/lingering-summer-light.m4a')) {
        const music = await fetch(base + '/town/audio/local/lingering-summer-light.m4a', { headers: token ? { 'x-harbour-token': token } : {} });
        assert.equal(music.status, 200); assert.match(music.headers.get('content-type') || '', /^audio\/mp4/);
        assert.equal((await music.arrayBuffer()).byteLength, 3806838);
      }
      assert.equal((await fetch(base + '/town/model-data.js')).status, 200, 'town program remains public, licensed models do not');
    } finally { await server.close(); }
  }
  console.log('PASS town model/music asset auth: local-only, token, foreign origin, Windows casing and path normalization');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
