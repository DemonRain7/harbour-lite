"use strict";

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_DRAFT_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10;

// Only explicitly picked/pasted bytes cross IPC. Paths, URLs and caller-made upload
// handles are not an alternative file-reading API for this sandboxed renderer.
function uploadPayload(input) {
  if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.length > 240
    || /[\\/\x00-\x1f]/.test(input.name)) throw new Error("附件文件名无效");
  const data = input.dataBase64;
  if (typeof data !== "string" || !data.length || data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4
    || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("附件格式无效或超过 32 MB");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_FILE_BYTES || bytes.toString("base64") !== data) throw new Error("附件格式无效或超过 32 MB");
  const mime = typeof input.mime === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(input.mime) ? input.mime : "application/octet-stream";
  const kind = mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : "file";
  return { payload: { name: input.name, mime, kind, dataBase64: data }, size: bytes.length };
}

function publicAttachment(value) {
  if (!value || typeof value.url !== "string" || !/^\/uploads\/[\w./%+-]+$/.test(value.url)
    || /(?:\.\.|%2e|%2f|%5c)/i.test(value.url)) return null;
  return { url: value.url, name: String(value.name || "附件").slice(0, 240),
    kind: ["image", "audio", "video", "file"].includes(value.kind) ? value.kind : "file",
    mime: String(value.mime || "application/octet-stream").slice(0, 120), size: Number(value.size) || 0 };
}

module.exports = { MAX_FILE_BYTES, MAX_DRAFT_BYTES, MAX_FILES, uploadPayload, publicAttachment };
