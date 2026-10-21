import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const MAX_TEXT_BYTES = 1024 * 1024;
const TEXT_EXT = /\.(?:txt|md|markdown|py|pyw|js|jsx|ts|tsx|mjs|cjs|json|jsonl|csv|tsv|log|yaml|yml|toml|xml|html?|css|scss|sass|less|svg|sh|bash|ps1|bat|cmd|sql|rs|go|java|c|h|cpp|hpp|rb|php|ini|cfg|conf|srt|vtt|lrc|r)$/i;
const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
  ".webm": "audio/webm", ".ogg": "audio/ogg", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".flac": "audio/flac", ".amr": "audio/amr",
};
const LANGUAGES: Record<string, string> = { py: "Python", pyw: "Python", js: "JavaScript", ts: "TypeScript", json: "JSON", md: "Markdown", html: "HTML", csv: "CSV", yaml: "YAML", yml: "YAML", txt: "文本" };

class FileError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return !!rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
/** No arbitrary paths, external URLs, double decoding, symlink escape or Windows ADS. */
export function uploadRelativePath(raw: string): string {
  if (!raw.startsWith("/uploads/") || raw.length > 4096 || /[?#\\\x00-\x1f\x7f]/.test(raw) || /%2f|%5c/i.test(raw)) throw new FileError(400, "附件地址无效");
  let decoded: string;
  try { decoded = decodeURIComponent(raw.slice(9)); } catch { throw new FileError(400, "附件地址编码无效"); }
  if (!decoded || /[%:\\?\x00-\x1f\x7f]/.test(decoded)
    || decoded.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part))) throw new FileError(403, "附件路径超出允许范围");
  return decoded;
}
async function openUpload(root: string, raw: string): Promise<{ handle: FileHandle; size: number; name: string }> {
  const rel = uploadRelativePath(raw), target = path.resolve(root, rel);
  if (!inside(path.resolve(root), target)) throw new FileError(403, "附件路径超出允许范围");
  const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
  if (!inside(realRoot, realTarget)) throw new FileError(403, "附件链接超出允许范围");
  const handle = await fs.open(realTarget, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new FileError(403, "不是普通附件文件");
    return { handle, size: stat.size, name: path.basename(rel) };
  } catch (error) { await handle.close(); throw error; }
}
function errorResponse(res: ServerResponse, error: unknown): void {
  if (res.headersSent) { res.destroy(); return; }
  const status = error instanceof FileError ? error.status : 404;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ error: error instanceof FileError ? error.message : "附件不存在、已过期或暂时无法读取" }));
}

export async function previewUpload(res: ServerResponse, root: string, raw: string): Promise<void> {
  let file: Awaited<ReturnType<typeof openUpload>> | undefined;
  try {
    file = await openUpload(root, raw);
    const { handle, size, name } = file;
    const ext = path.extname(name).slice(1).toLowerCase();
    const result: Record<string, unknown> = { name, size, status: "unsupported", language: LANGUAGES[ext] || ext || "文本" };
    // Never load large binaries or render active content. Even HTML/SVG is plain text.
    if (!TEXT_EXT.test(name) && (TYPES[path.extname(name).toLowerCase()] || /\.(?:pdf|zip|7z|rar|docx?|xlsx?|pptx?|odt|ods|odp|rtf|epub|exe|dll|msi|lnk|url)$/i.test(name))) result.status = "unsupported";
    else if (size > MAX_TEXT_BYTES) result.status = TEXT_EXT.test(name) ? "too_large" : "unsupported";
    else {
      const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > MAX_TEXT_BYTES) result.status = "too_large";
      else {
        const bytes = buffer.subarray(0, length);
        const utf16 = bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
        if (utf16 || !bytes.includes(0)) {
          let content: string | undefined;
          const encodings = utf16 ? [bytes[0] === 0xff ? "utf-16le" : "utf-16be"] : ["utf-8", ...(TEXT_EXT.test(name) ? ["gb18030"] : [])];
          for (const encoding of encodings) {
            try { content = new TextDecoder(encoding, { fatal: true }).decode(bytes); result.encoding = encoding; break; } catch { /* Try only known text encodings. */ }
          }
          if (content !== undefined && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) {
            if (content.split("\n").length > 20000) result.status = "too_large";
            else Object.assign(result, { status: "text", content });
          }
        }
      }
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(result));
  } catch (error) { errorResponse(res, error); }
  finally { await file?.handle.close().catch(() => {}); }
}

/** Auth is applied by the existing /uploads guard before reaching this handler. */
export async function serveUploadFile(req: IncomingMessage, res: ServerResponse, root: string, raw: string): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); res.end(); return; }
  let file: Awaited<ReturnType<typeof openUpload>> | undefined;
  try {
    file = await openUpload(root, raw);
    const { handle, size, name } = file;
    const type = /\.video\.webm$/i.test(name) ? "video/webm" : TYPES[path.extname(name).toLowerCase()] || "application/octet-stream";
    // Uploaded HTML/SVG/scripts must never gain the Dashboard origin or preload privileges.
    const headers: Record<string, string | number> = {
      "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox", "Accept-Ranges": "bytes",
      "Content-Disposition": `${type === "application/octet-stream" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)}`,
    };
    let start = 0, end = size - 1, partial = false;
    const range = req.headers.range;
    if (range && req.method === "GET") {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
        partial = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < size;
      }
      if (!partial) { res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}`, "Content-Length": 0 }); res.end(); return; }
    }
    const length = size ? end - start + 1 : 0;
    res.writeHead(partial ? 206 : 200, { ...headers, "Content-Length": length, ...(partial ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) });
    if (req.method === "HEAD" || !length) { res.end(); return; }
    await pipeline(handle.createReadStream({ start, end, autoClose: false }), res);
  } catch (error) { errorResponse(res, error); }
  finally { await file?.handle.close().catch(() => {}); }
}
