"use strict";

const fs = require("node:fs/promises");
const { createWriteStream } = require("node:fs");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const MAX_BYTES = 256 * 1024 * 1024;
// OS associations can execute .py/.js/.sh instead of viewing them. Source files
// use a .txt copy; unknown/executable formats are never launched by this bridge.
const TEXT = /\.(?:txt|md|markdown|py|pyw|js|jsx|ts|tsx|mjs|cjs|json|jsonl|csv|tsv|log|yaml|yml|toml|xml|html?|css|scss|sass|less|svg|sh|bash|ps1|bat|cmd|sql|rs|go|java|c|h|cpp|hpp|rb|php|ini|cfg|conf|srt|vtt|lrc|r)$/i;
const DOCUMENT = /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|epub|zip|7z|rar|png|jpe?g|gif|webp|avif|bmp|ico|tiff?|mp4|m4v|mov|mkv|avi|webm|wmv|mpeg|mpg|ogg|mp3|wav|m4a|flac|aac|amr)$/i;

function attachmentTarget(input, serverUrl) {
  if (!input || typeof input.url !== "string" || input.url.length > 4096 || /[\\\x00-\x1f\x7f]/.test(input.url)) throw new Error("附件地址无效");
  const base = new URL(serverUrl), url = new URL(input.url, base);
  if (!["http:", "https:"].includes(base.protocol) || url.origin !== base.origin || url.username || url.password) throw new Error("只能打开当前 Harbour 服务的附件");
  // Validate before WHATWG URL normalizes dot segments.
  const rawPath = input.url.replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/)[0];
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { throw new Error("附件地址编码无效"); }
  if (!decoded.startsWith("/uploads/") || /[\\%:\x00-\x1f\x7f?]/.test(decoded) || /%2f|%5c/i.test(rawPath)
    || decoded.slice(9).split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part))) throw new Error("附件路径超出允许范围");
  url.search = ""; url.hash = "";
  const extension = path.posix.extname(decoded).toLowerCase();
  if (!TEXT.test(extension) && !DOCUMENT.test(extension)) throw new Error("此类型不会自动启动，以免执行程序；请下载后自行选择查看方式");
  let name = String(input.name || path.posix.basename(decoded)).split(/[\\/]/).pop()
    .replace(/[<>:"|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "_").replace(/[. ]+$/g, "").slice(0, 150);
  if (!name || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `attachment${extension}`;
  if (!name.toLowerCase().endsWith(extension)) name += extension;
  if (TEXT.test(extension) && extension !== ".txt") name += ".txt";
  return { url, name };
}

function authorizeFileSender(event, windows, serverUrl) {
  const sender = event?.sender;
  if (!sender || sender.isDestroyed() || event.senderFrame !== sender.mainFrame) return false;
  if (!windows.some(win => win && !win.isDestroyed() && win.webContents === sender)) return false;
  try {
    const actual = new URL(event.senderFrame.url), expected = new URL(serverUrl);
    // Only the actual Dashboard document, not an upload loaded in the same window.
    return actual.origin === expected.origin && ["/", "/index.html", expected.pathname].includes(actual.pathname)
      && !actual.pathname.startsWith("/uploads/");
  } catch { return false; }
}

function createFileOpener({ getConfig, cacheRoot, shell, fetchImpl = fetch, maxBytes = MAX_BYTES }) {
  let busy = false;
  return async function openAttachment(input) {
    if (busy) throw new Error("正在准备上一个附件，请稍候");
    const config = getConfig(), { url, name } = attachmentTarget(input, config.url);
    const token = config.token || (typeof input.token === "string" ? input.token.slice(0, 8192) : "");
    busy = true;
    let directory, target, success = false;
    try {
      await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
      // Bounded private cache. Remove only expired copies created by this component,
      // never user-picked paths or recursive directories. Locked copies are left alone.
      let retained = 0;
      for (const entry of await fs.readdir(cacheRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^file-[\w-]+$/.test(entry.name)) continue;
        const folder = path.join(cacheRoot, entry.name);
        for (const item of await fs.readdir(folder, { withFileTypes: true })) {
          if (!item.isFile()) continue;
          const file = path.join(folder, item.name), stat = await fs.stat(file);
          if (Date.now() - stat.mtimeMs > 7 * 86400000) {
            try { await fs.unlink(file); continue; } catch { /* e.g. a player still holds this copy */ }
          }
          retained += stat.size;
        }
        await fs.rmdir(folder).catch(() => {}); // Only succeeds when empty.
      }
      const downloadLimit = Math.min(maxBytes, 512 * 1024 * 1024 - retained);
      if (downloadLimit <= 0) throw new Error("附件缓存已满，请清理客户端 file-previews 缓存或直接下载");
      const response = await fetchImpl(url, { headers: token ? { "x-harbour-token": token } : {}, redirect: "error", signal: AbortSignal.timeout(120000) });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(response.status === 401 ? "附件认证失败，请重新连接 Harbour" : "附件不存在、已过期或下载失败"); }
      if (Number(response.headers.get("content-length")) > maxBytes) { await response.body.cancel(); throw new Error("附件超过 256 MiB，请使用下载功能"); }
      if (Number(response.headers.get("content-length")) > downloadLimit) { await response.body.cancel(); throw new Error("附件缓存空间不足，请直接下载"); }
      directory = await fs.mkdtemp(path.join(cacheRoot, "file-"));
      target = path.join(directory, name);
      let bytes = 0;
      const limit = new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.length; done(bytes > downloadLimit ? new Error("附件超过下载或缓存上限") : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(target, { flags: "wx", mode: 0o600 }));
      const error = await shell.openPath(target);
      if (error) { // Keep the verified copy available when no default association exists.
        shell.showItemInFolder(target); success = true;
        return { opened: false, revealed: true, message: "未找到可用的默认应用，已在文件夹中显示附件" };
      }
      success = true;
      return { opened: true, message: TEXT.test(path.extname(new URL(url).pathname)) ? "已用默认文本应用打开只读来源的副本；修改不会同步回服务端" : "已用系统默认应用打开附件副本" };
    } catch (error) {
      // Native network errors may contain credential-bearing input. Do not echo URLs.
      if (error instanceof TypeError || error?.name === "TimeoutError") throw new Error("附件下载失败或超时，请检查服务连接后重试");
      throw error;
    } finally {
      if (!success && target) await fs.unlink(target).catch(() => {});
      if (!success && directory) await fs.rmdir(directory).catch(() => {});
      busy = false;
    }
  };
}
module.exports = { createFileOpener, attachmentTarget, authorizeFileSender };
