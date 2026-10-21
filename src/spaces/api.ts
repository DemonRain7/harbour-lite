import { createReadStream, promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { getSpaceStore, MAX_SPACE_FILE_BYTES, SpaceError, type SpaceStore } from "./store";

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (String(req.headers["content-type"]).split(";")[0] !== "application/json") throw new SpaceError("需要 application/json");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > Math.ceil(MAX_SPACE_FILE_BYTES * 4 / 3) + 4096) throw new SpaceError("文件超过 40 MB", 413);
    chunks.push(chunk);
  }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new SpaceError("请求体必须是 JSON 对象"); }
}
const thumbnails = new Map<string, Promise<Buffer>>();
async function thumbnail(store: SpaceStore, file: { id: string; path: string }) {
  const target = path.join(store.directory, "thumbnails", file.id + ".webp");
  try { return await fs.readFile(target); } catch { /* disposable cache */ }
  let pending = thumbnails.get(target);
  if (!pending) {
    pending = (async () => {
      const sharp = (await import("sharp")).default;
      const bytes = await sharp(file.path, { limitInputPixels: 50_000_000 }).rotate().resize(560, 480, { fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); return bytes;
    })().finally(() => thumbnails.delete(target));
    thumbnails.set(target, pending);
  }
  return pending;
}

// Authentication and same-origin checks are performed by the shared server boundary.
export async function spacesApi(req: IncomingMessage, res: ServerResponse, url: URL, uploadDir: string,
  sendJson: (res: ServerResponse, status: number, data: unknown) => void, store = getSpaceStore(uploadDir)): Promise<void> {
  try {
    const route = url.pathname.slice("/api/spaces".length), method = req.method || "GET";
    res.setHeader("Cache-Control", "private, no-store");
    if ((route === "" || route === "/") && method === "GET") {
      const sync = await store.sync();
      return sendJson(res, 200, { ...await store.list({ q: url.searchParams.get("q") || "", kind: url.searchParams.get("kind") || "",
        collection: url.searchParams.get("collection") || "", favorite: url.searchParams.get("favorite") === "1",
        offset: Number(url.searchParams.get("offset")) || 0 }), sync });
    }
    if (route === "/refresh" && method === "POST") { await body(req); return sendJson(res, 200, await store.sync(true)); }
    if (route === "/collections" && method === "POST") {
      const data = await body(req); if (typeof data.name !== "string") throw new SpaceError("需要收藏夹名称");
      return sendJson(res, 201, await store.createCollection(data.name));
    }
    if (route === "/import" && method === "POST") {
      const data = await body(req);
      if (typeof data.name !== "string" || typeof data.base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.base64) || data.base64.length % 4) throw new SpaceError("无效的文件上传");
      if (data.collectionId != null && typeof data.collectionId !== "string") throw new SpaceError("无效收藏夹");
      return sendJson(res, 201, await store.importFile(data.name, Buffer.from(data.base64, "base64"), data.collectionId as string | null));
    }
    const entryId = /^\/entries\/([a-f0-9]{32})$/.exec(route)?.[1];
    if (entryId && method === "GET") return sendJson(res, 200, await store.detail(entryId));
    if (entryId && method === "PATCH") return sendJson(res, 200, await store.update(entryId, await body(req)));
    const fileId = /^\/files\/([a-f0-9]{64}\.[a-z0-9]+)$/.exec(route)?.[1];
    if (fileId && method === "GET") {
      const file = await store.file(fileId);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
      res.setHeader("Referrer-Policy", "no-referrer");
      if (url.searchParams.get("text") === "1") {
        if (!file.mime.startsWith("text/")) throw new SpaceError("该格式不支持文本预览");
        const handle = await fs.open(file.path, "r");
        try {
          const bytes = Buffer.alloc(128 * 1024), result = await handle.read(bytes, 0, bytes.length, 0);
          return sendJson(res, 200, { text: bytes.subarray(0, result.bytesRead).toString("utf8"), truncated: file.size > bytes.length });
        } finally { await handle.close(); }
      }
      if (url.searchParams.get("thumb") === "1" && file.mime.startsWith("image/")) {
        const bytes = await thumbnail(store, file); res.writeHead(200, { "Content-Type": "image/webp", "Content-Length": bytes.length, "Cache-Control": "private, max-age=86400" }); res.end(bytes); return;
      }
      const download = url.searchParams.get("download") === "1" || !/^(image\/|application\/pdf$)/.test(file.mime);
      res.writeHead(200, { "Content-Type": file.mime, "Content-Length": file.size,
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="harbour${path.extname(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, "%27")}` });
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(file.path);
        stream.on("error", reject); res.on("close", () => { stream.destroy(); resolve(); }); stream.on("end", resolve); stream.pipe(res);
      });
      return;
    }
    throw new SpaceError("空间接口不存在", 404);
  } catch (error) {
    if (res.headersSent) { res.destroy(); return; }
    sendJson(res, error instanceof SpaceError ? error.status : 500, { error: error instanceof SpaceError ? error.message : "空间暂时无法读取，请稍后重试" });
  }
}
