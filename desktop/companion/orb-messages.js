"use strict";

const IMAGE_EXT = /\.(?:png|jpe?g|webp|gif|avif|bmp)$/i;
const { publicAttachment } = require("./orb-attachments");

// Resolve only displayed image references, never arbitrary server/file paths.
// External pictures use the same authenticated image proxy as Main Chat; the
// desktop token is sent to Harbour, never to the external image host.
function imageTarget(raw, serverUrl, explicit = false) {
  if (typeof raw !== "string" || raw.length > 4096 || /[\\\x00-\x1f\x7f]/.test(raw)) return null;
  raw = raw.trim().replace(/&amp;/g, "&");
  const base = new URL(serverUrl), prefix = base.pathname.replace(/\/+$/, "");
  let local = raw.startsWith("/uploads/") ? raw : null;
  let url;
  if (!local) {
    try { url = new URL(raw); } catch { return null; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    if (url.origin === base.origin) {
      const relative = prefix && url.pathname.startsWith(`${prefix}/`) ? url.pathname.slice(prefix.length) : url.pathname;
      if (!relative.startsWith("/uploads/")) return null;
      // Validate the original spelling before URL's dot-segment normalization.
      local = raw.replace(/^https?:\/\/[^/]+/i, "");
      if (prefix && local.startsWith(`${prefix}/`)) local = local.slice(prefix.length);
    }
  }
  if (local) {
    const pathname = local.split(/[?#]/)[0];
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return null; }
    if (!decoded.startsWith("/uploads/") || /[\\%\x00-\x1f\x7f?#]/.test(decoded)
      || decoded.split("/").slice(2).some(part => !part || part === "." || part === "..")
      || /%2f|%5c/i.test(pathname) || !IMAGE_EXT.test(decoded)) return null;
    return { key: decoded, path: decoded.split("/").map(encodeURIComponent).join("/") };
  }
  if (!explicit && !IMAGE_EXT.test(url.pathname)) return null;
  url.hash = "";
  return { key: url.href, path: `/api/img-proxy?url=${encodeURIComponent(url.href)}` };
}

function projectMessage(message, serverUrl, issueImage) {
  const content = typeof message.content === "string" ? message.content : "（请在完整会话查看）";
  const parts = [], seen = new Set();
  const files = Array.isArray(message.attachments) ? message.attachments : [];
  const expiredKeys = new Set(files.filter(file => file?.expired).map(file => imageTarget(file.url, serverUrl, true)?.key).filter(Boolean));
  const addImage = (raw, name, explicit, expired = false) => {
    const target = imageTarget(raw, serverUrl, explicit);
    if (!target) return false;
    if (!seen.has(target.key)) {
      seen.add(target.key);
      parts.push({ type: "image", name: String(name || "图片").slice(0, 240),
        ...(expired || expiredKeys.has(target.key) ? { expired: true } : { id: issueImage(target.path) }) });
    }
    return true;
  };
  // Code examples stay text. Markdown images, ordinary image links and bare
  // upload URLs share one projection for live replies and restored history.
  const refs = /```[\s\S]*?(?:```|$)|`[^`\n]*`|(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+"[^"\n]*")?\s*\)|(?:\/uploads\/|https?:\/\/)[^\s<>"'`]+/gi;
  let cursor = 0;
  for (const match of content.matchAll(refs)) {
    if (match[0].startsWith("`")) continue;
    const raw = match[3]?.replace(/^<|>$/g, "") || match[0].replace(/[，。；;：:！？!、)\]＊*~]+$/u, "");
    const before = parts.length;
    if (!addImage(raw, match[2], match[1] === "!")) continue;
    const image = parts.length > before ? parts.pop() : null;
    if (match.index > cursor) parts.push({ type: "text", text: content.slice(cursor, match.index) });
    if (image) parts.push(image);
    const consumed = match[3] ? match[0].length : raw.length;
    cursor = match.index + consumed;
  }
  if (cursor < content.length) parts.push({ type: "text", text: content.slice(cursor) });
  const attachments = [];
  for (const file of files) {
    if (file?.kind === "image" && addImage(file.url, file.name, true, !!file.expired)) continue;
    const safe = publicAttachment(file);
    if (safe) attachments.push(safe);
  }
  return { role: message.role, content, parts, ...(attachments.length ? { attachments } : {}) };
}

function rasterMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 26 && bytes.toString("ascii", 0, 2) === "BM") return "image/bmp";
  if (bytes.length >= 16 && bytes.toString("ascii", 4, 8) === "ftyp" && /avif|avis/.test(bytes.toString("ascii", 8, 32))) return "image/avif";
  return null;
}

module.exports = { imageTarget, projectMessage, rasterMime };
