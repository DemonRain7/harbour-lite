import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { parse as parseEnv } from 'dotenv';
import sharp from 'sharp';
import { z, ZodError } from 'zod';
import { Store } from './storage.js';
import { Engine, PublicError } from './engine.js';
import { Id } from './schema.js';
import type { Complete } from './providers.js';
import { acquireLock } from './lock.js';

const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
export type AppOptions = {
  root: string;
  data?: string;
  host?: string;
  token?: string;
  provider?: Complete;
};
const headers = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cache-control': 'no-store',
};
function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
async function json(request: IncomingMessage) {
  if (!request.headers['content-type']?.startsWith('application/json'))
    throw new PublicError('请求必须使用 JSON', 415);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 3 * 1024 * 1024) throw new PublicError('请求超过 3 MB 上限', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new PublicError('JSON 格式不正确');
  }
}
function equal(a: string, b: string) {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}
export async function createApp(options: AppOptions) {
  const host = options.host ?? '127.0.0.1';
  const token = options.token ?? '';
  if (!loopback.has(host) && token.length < 24)
    throw new Error('非本机绑定必须设置至少 24 字符的 HARBOUR_LITE_TOKEN');
  const store = new Store(options.root, options.data);
  const releaseLock = await acquireLock(store.data);
  try {
    await store.init();
  } catch (error) {
    await releaseLock();
    throw error;
  }
  const engine = new Engine(store, options.provider);
  const staticFiles: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  };
  const server = http.createServer(async (request, response) => {
    try {
      const authority = request.headers.host;
      if (!authority) throw new PublicError('缺少 Host', 400);
      const url = new URL(request.url ?? '/', `http://${authority}`);
      if (url.host !== authority || (loopback.has(host) && !loopback.has(url.hostname)))
        throw new PublicError('Host 不受信任', 403);
      const origin = request.headers.origin;
      if (origin) {
        let originUrl: URL;
        try {
          originUrl = new URL(origin);
        } catch {
          throw new PublicError('来源不受信任', 403);
        }
        if (!['http:', 'https:'].includes(originUrl.protocol) || originUrl.host !== authority)
          throw new PublicError('仅接受同源请求', 403);
      }
      if (request.headers['sec-fetch-site'] === 'cross-site')
        throw new PublicError('拒绝跨站请求', 403);
      const method = request.method ?? 'GET';
      if (url.pathname === '/api/health' && method === 'GET') {
        send(response, 200, { ok: true, app: 'harbour-lite' });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (token && !equal(request.headers.authorization ?? '', `Bearer ${token}`))
          throw new PublicError('请输入工作台访问口令', 401);
        if (method === 'GET' && url.pathname === '/api/bootstrap') {
          const models = await Promise.all(
            (await store.models()).map(async (model) => ({
              ...model,
              hasKey: !!(await store.secret(model.id)),
            })),
          );
          send(response, 200, {
            models,
            agents: await store.agents(),
            skills: (await store.skills()).map(({ id, description }) => ({ id, description })),
            appearance: await store.appearance(),
          });
          return;
        }
        if (method === 'PUT' && url.pathname === '/api/models') {
          const body = z
            .object({ model: z.unknown(), apiKey: z.string().optional() })
            .strict()
            .parse(await json(request));
          const model = await store.saveModel(body.model, body.apiKey);
          send(response, 200, { ...model, hasKey: !!(await store.secret(model.id)) });
          return;
        }
        if (method === 'PUT' && url.pathname === '/api/agents') {
          send(response, 200, await store.saveAgent(await json(request)));
          return;
        }
        if (method === 'PUT' && url.pathname === '/api/appearance') {
          send(response, 200, await store.saveAppearance(await json(request)));
          return;
        }
        if (method === 'POST' && url.pathname === '/api/appearance/image') {
          const { image } = z
            .object({ image: z.string().max(2900000) })
            .strict()
            .parse(await json(request));
          const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/.exec(image);
          if (!match) throw new PublicError('只接受 PNG、JPEG 或 WebP 图片');
          const bytes = Buffer.from(match[2]!, 'base64');
          if (bytes.length > 2 * 1024 * 1024) throw new PublicError('图片需小于 2 MB');
          let output: Buffer;
          try {
            const photo = sharp(bytes, { limitInputPixels: 4096 * 4096, animated: false });
            const metadata = await photo.metadata();
            if (
              !['png', 'jpeg', 'webp'].includes(metadata.format ?? '') ||
              (metadata.width ?? 0) > 4096 ||
              (metadata.height ?? 0) > 4096
            )
              throw new Error();
            output = await photo
              .rotate()
              .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
              .webp({ quality: 88 })
              .toBuffer();
          } catch {
            throw new PublicError('图片无效，或尺寸超过 4096 × 4096');
          }
          const name = `${createHash('sha256').update(output).digest('hex')}.webp`;
          await fs.writeFile(path.join(store.data, 'appearance', name), output, { mode: 0o600 });
          send(response, 201, { image: name });
          return;
        }
        const picture = /^\/api\/appearance\/image\/([a-f0-9]{64}\.webp)$/.exec(url.pathname);
        if (picture && method === 'GET') {
          const bytes = await fs.readFile(path.join(store.data, 'appearance', picture[1]!));
          response.writeHead(200, { ...headers, 'content-type': 'image/webp' });
          response.end(bytes);
          return;
        }
        if (url.pathname === '/api/sessions') {
          if (method === 'GET') {
            send(
              response,
              200,
              (await store.sessions()).map(({ messages, ...session }) => ({
                ...session,
                messageCount: messages.length,
              })),
            );
            return;
          }
          if (method === 'POST') {
            const body = z
              .object({ agentId: Id, modelId: Id.optional() })
              .strict()
              .parse(await json(request));
            send(response, 201, await engine.createSession(body.agentId, body.modelId));
            return;
          }
        }
        const session = /^\/api\/sessions\/([a-f0-9-]{36})(\/messages)?$/.exec(url.pathname);
        if (session) {
          if (!session[2] && method === 'GET') {
            send(response, 200, await store.session(session[1]!));
            return;
          }
          if (!session[2] && method === 'DELETE') {
            await engine.remove(session[1]!);
            send(response, 200, { ok: true });
            return;
          }
          if (session[2] && method === 'POST') {
            send(response, 202, await engine.start(session[1]!, await json(request)));
            return;
          }
        }
        const run = /^\/api\/runs\/([a-f0-9-]{36})(\/stop)?$/.exec(url.pathname);
        if (run) {
          if (run[2] && method === 'POST') {
            await json(request);
            engine.stop(run[1]!);
            send(response, 200, { ok: true });
            return;
          }
          if (!run[2] && method === 'GET') {
            const record = await engine.run(run[1]!);
            if (!record) throw new PublicError('任务不存在', 404);
            send(response, 200, record);
            return;
          }
        }
        throw new PublicError('接口不存在', 404);
      }
      const asset = staticFiles[url.pathname];
      if (method !== 'GET' || !asset) throw new PublicError('页面不存在', 404);
      const bytes = await fs.readFile(path.join(options.root, 'web', asset[0]));
      response.writeHead(200, { ...headers, 'content-type': asset[1] });
      response.end(bytes);
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status =
        error instanceof PublicError
          ? error.status
          : error instanceof ZodError
            ? 400
            : (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 404
              : 400;
      const message =
        error instanceof PublicError
          ? error.message
          : error instanceof ZodError
            ? '配置格式不正确，请检查必填项、地址和参数范围。'
            : status === 404
              ? '内容不存在'
              : '操作未完成，请检查配置和本机存储权限。';
      send(response, status, { error: message });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    server,
    store,
    engine,
    close: async () => {
      await engine.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await releaseLock();
    },
  };
}

async function main() {
  const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parseEnv(await fs.readFile(path.join(root, '.env')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const env = { ...fileEnv, ...process.env };
  const host = env.HARBOUR_LITE_HOST || '127.0.0.1';
  const port = Number(env.HARBOUR_LITE_PORT || 7799);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口配置无效');
  const app = await createApp({
    root,
    host,
    data: env.HARBOUR_LITE_DATA || 'data',
    token: env.HARBOUR_LITE_TOKEN,
  });
  app.server.on('error', (error) => {
    console.error(
      `Harbour Lite 无法启动（${(error as NodeJS.ErrnoException).code || 'server error'}），未停止其他服务。`,
    );
    void app.close().finally(() => {
      process.exitCode = 1;
    });
  });
  app.server.listen(port, host, () =>
    console.log(`Harbour Lite: http://${host.includes(':') ? `[${host}]` : host}:${port}`),
  );
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void app.close().then(() => {
      process.exitCode = 0;
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  void main().catch(() => {
    console.error('Harbour Lite 启动失败；请检查环境配置和数据目录。');
    process.exitCode = 1;
  });
