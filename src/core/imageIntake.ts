import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { Attachment } from "../types";
import { channelAttachmentUrlDiagnostic, isTrustedChannelAttachmentUrl } from "./channelAttachmentUrl";

const MAX_IMAGES_PER_TURN = 10;
const MAX_VISION_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_EDGE = 4_096;

type ImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface ImageIntakeContext {
  platform?: string;
  uploadDir: string;
  maxSourceBytes: number;
  signal?: AbortSignal;
}

export interface PreparedImages {
  attachments: Attachment[];
  imageCount: number;
  normalizedCount: number;
  totalBytes: number;
}

export class ImageInputError extends Error {
  readonly code = "IMAGE_INPUT_ERROR";
  constructor(message: string, public attachmentKind: Attachment["kind"] = "image") {
    super(message);
    this.name = "ImageInputError";
  }
}

/** The legacy error type also covers audio/video/files; keep its compatibility code. */
export function attachmentInputErrorPresentation(error: ImageInputError): { reply: string; activity: string } {
  const kind = error.attachmentKind;
  const icon = kind === "audio" ? "🎙️" : kind === "image" || !kind ? "🖼️" : "📎";
  const label = kind === "audio" ? "语音附件" : kind === "image" || !kind ? "图片输入" : "附件";
  return { reply: `${icon} ${error.message}`, activity: `${label}不可用` };
}

export function isImageInputError(value: unknown): value is ImageInputError {
  return value instanceof ImageInputError || (
    value instanceof Error && (value as Error & { code?: string }).code === "IMAGE_INPUT_ERROR"
  );
}

/**
 * 把渠道短期 CDN 图片收进 Harbour 上传目录，并对所有图片做签名/像素/体积校验。
 * 返回的 url/path 都是可持久回放的本地引用；绝不把 QQ rkey、Discord 临时 URL 写进 session。
 */
export async function prepareIncomingAttachments(
  attachments: Attachment[] | undefined,
  context: ImageIntakeContext,
  logger?: Logger
): Promise<PreparedImages> {
  const list = (attachments ?? []).map((attachment) => ({ ...attachment }));
  const imageIndexes = list.flatMap((attachment, index) => attachment.kind === "image" ? [index] : []);
  if (imageIndexes.length > MAX_IMAGES_PER_TURN) {
    throw new ImageInputError(`单次最多发送 ${MAX_IMAGES_PER_TURN} 张图片`);
  }

  // 图片以外的 QQ/DC 附件同样必须从短期 CDN 收进 Harbour；否则 History 只留下一个
  // 很快失效的 URL，语音/视频/文件刷新后便无法回放。Web 上传本来就在受控目录，
  // 这里仅补齐绝对 path 与实际大小，整个步骤幂等，可在 checkpoint 恢复时重复执行。
  for (let index = 0; index < list.length; index += 1) {
    if (list[index]!.kind === "image") continue;
    try { list[index] = await localizeBinaryAttachment(list[index]!, context, logger); }
    catch (error) {
      if (isImageInputError(error)) error.attachmentKind = list[index]!.kind;
      throw error;
    }
  }
  if (!imageIndexes.length) return { attachments: list, imageCount: 0, normalizedCount: 0, totalBytes: 0 };

  let normalizedCount = 0;
  let totalBytes = 0;
  for (const index of imageIndexes) {
    if (context.signal?.aborted) throw new ImageInputError("图片读取已取消");
    const attachment = list[index]!;
    const source = await loadImageSource(attachment, context);
    const prepared = await validateAndNormalizeImage(source.data);
    totalBytes += prepared.data.byteLength;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new ImageInputError("本轮图片总大小超过 20MB 视觉输入上限");
    }
    if (prepared.normalized) normalizedCount += 1;
    const stored = await persistPreparedImage(prepared.data, prepared.mime, context.uploadDir);
    list[index] = {
      ...attachment,
      url: stored.url,
      path: stored.path,
      mime: prepared.mime,
      size: prepared.data.byteLength,
      image: {
        width: prepared.width,
        height: prepared.height,
        sha256: stored.sha256,
        ...(prepared.normalized ? { normalized: true } : {}),
      },
    };
    logger?.info({
      attachment: attachment.name,
      source: source.source,
      bytes: prepared.data.byteLength,
      width: prepared.width,
      height: prepared.height,
      normalized: prepared.normalized,
    }, "vision:image-prepared");
  }
  return { attachments: list, imageCount: imageIndexes.length, normalizedCount, totalBytes };
}

/** 兼容早期内部调用名；新代码应使用 prepareIncomingAttachments。 */
export const prepareImageAttachments = prepareIncomingAttachments;

async function localizeBinaryAttachment(
  attachment: Attachment,
  context: ImageIntakeContext,
  logger?: Logger
): Promise<Attachment> {
  if (context.signal?.aborted) throw new ImageInputError("附件读取已取消");
  const root = path.resolve(context.uploadDir);
  const local = await resolveLocalUpload(attachment, root);
  if (local) {
    const stat = await fs.stat(local).catch(() => null);
    if (!stat?.isFile()) throw new ImageInputError(`附件不存在：${attachment.name}`);
    if (stat.size <= 0) throw new ImageInputError(`附件为空：${attachment.name}`);
    if (stat.size > context.maxSourceBytes) throw new ImageInputError(`附件超过 ${mb(context.maxSourceBytes)}MB 上传上限`);
    const relative = path.relative(root, local).split(path.sep).join("/");
    return {
      ...attachment,
      url: `/uploads/${relative}`,
      path: local,
      size: stat.size,
    };
  }
  if (!/^https:\/\//i.test(attachment.url)) {
    throw new ImageInputError(`附件没有可读取的 Harbour 路径：${attachment.name}`);
  }
  const platform = String(context.platform || "").toLowerCase();
  if (platform !== "qq" && platform !== "discord") {
    throw new ImageInputError("Web/API 附件必须先上传到 Harbour，不能读取任意远程 URL");
  }
  const fetched = await fetchOfficialAttachment(
    attachment.url,
    platform,
    context.maxSourceBytes,
    context.signal,
    "附件"
  );
  const mime = safeMime(fetched.mime || attachment.mime, attachment.kind);
  const stored = await persistBinaryAttachment(fetched.data, mime, attachment.name, attachment.kind, context.uploadDir);
  logger?.info({
    attachment: attachment.name,
    kind: attachment.kind,
    bytes: fetched.data.byteLength,
  }, "attachment:localized");
  return {
    ...attachment,
    url: stored.url,
    path: stored.path,
    mime,
    size: fetched.data.byteLength,
  };
}

async function loadImageSource(
  attachment: Attachment,
  context: ImageIntakeContext
): Promise<{ data: Buffer; source: "upload" | "channel-cdn" }> {
  const root = path.resolve(context.uploadDir);
  const local = await resolveLocalUpload(attachment, root);
  if (local) {
    const stat = await fs.stat(local).catch(() => null);
    if (!stat?.isFile()) throw new ImageInputError(`图片附件不存在：${attachment.name}`);
    if (stat.size <= 0) throw new ImageInputError(`图片附件为空：${attachment.name}`);
    if (stat.size > context.maxSourceBytes) throw new ImageInputError(`图片超过 ${mb(context.maxSourceBytes)}MB 上传上限`);
    return { data: await fs.readFile(local), source: "upload" };
  }
  if (!/^https:\/\//i.test(attachment.url)) {
    throw new ImageInputError(`图片没有可读取的 Harbour 路径：${attachment.name}`);
  }
  const platform = String(context.platform || "").toLowerCase();
  if (platform !== "qq" && platform !== "discord") {
    throw new ImageInputError("Web/API 图片必须先上传到 Harbour，不能让模型读取任意远程 URL");
  }
  return {
    data: (await fetchOfficialAttachment(
      attachment.url,
      platform,
      context.maxSourceBytes,
      context.signal,
      "图片"
    )).data,
    source: "channel-cdn",
  };
}

async function resolveLocalUpload(attachment: Attachment, root: string): Promise<string | null> {
  let candidate = "";
  if (attachment.url.startsWith("/uploads/")) {
    const relative = decodeURIComponent(attachment.url.slice("/uploads/".length));
    candidate = path.resolve(root, relative);
  } else if (attachment.path) {
    candidate = path.resolve(attachment.path);
  }
  if (!candidate || !isInside(candidate, root)) return null;
  const realRoot = await fs.realpath(root).catch(() => root);
  const realCandidate = await fs.realpath(candidate).catch(() => candidate);
  return isInside(realCandidate, realRoot) ? realCandidate : null;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function fetchOfficialAttachment(
  rawUrl: string,
  platform: "qq" | "discord",
  maxBytes: number,
  callerSignal: AbortSignal | undefined,
  label: "图片" | "附件"
): Promise<{ data: Buffer; mime?: string }> {
  let current: URL;
  try { current = new URL(rawUrl); } catch { throw new ImageInputError(`平台${label} URL 无效`); }
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("image download timeout")), 30_000);
  try {
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      if (!isTrustedChannelAttachmentUrl(platform, current)) {
        const target = channelAttachmentUrlDiagnostic(current);
        throw new ImageInputError(`${platform} ${label} URL 不属于受信官方 CDN（${target.protocol}//${target.hostname}；端口 ${target.port}）`);
      }
      const response = await fetch(current, { redirect: "manual", signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new ImageInputError(`平台${label}重定向缺少 Location`);
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) throw new ImageInputError(`下载平台${label}失败：HTTP ${response.status}`);
      const announced = Number(response.headers.get("content-length") || 0);
      if (announced > maxBytes) throw new ImageInputError(`${label}超过 ${mb(maxBytes)}MB 上传上限`);
      const responseMime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (!response.body) {
        const data = Buffer.from(await response.arrayBuffer());
        if (data.byteLength > maxBytes) throw new ImageInputError(`${label}超过 ${mb(maxBytes)}MB 上传上限`);
        return { data, ...(responseMime ? { mime: responseMime } : {}) };
      }
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new ImageInputError(`${label}超过 ${mb(maxBytes)}MB 上传上限`);
        }
        chunks.push(Buffer.from(value));
      }
      return { data: Buffer.concat(chunks, total), ...(responseMime ? { mime: responseMime } : {}) };
    }
    throw new ImageInputError("平台图片重定向次数过多");
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ImageInputError(callerSignal?.aborted ? `${label}读取已取消` : `下载平台${label}超时`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

const BINARY_MIME_EXT: Record<string, string> = {
  "audio/webm": ".audio.webm",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/flac": ".flac",
  "audio/amr": ".amr",
  "video/webm": ".video.webm",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/json": ".json",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
};

function safeMime(value: string | undefined, kind: Attachment["kind"]): string {
  const mime = String(value || "").split(";", 1)[0]!.trim().toLowerCase();
  if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime)) return mime;
  if (kind === "audio") return "audio/octet-stream";
  if (kind === "video") return "video/octet-stream";
  return "application/octet-stream";
}

function safeBinaryExtension(mime: string, name: string, kind: Attachment["kind"]): string {
  const known = BINARY_MIME_EXT[mime];
  if (known) return known;
  const raw = path.extname(name).toLowerCase();
  if (/^\.[a-z0-9]{1,10}$/.test(raw)) return raw;
  return kind === "audio" ? ".audio" : kind === "video" ? ".video" : ".bin";
}

async function persistBinaryAttachment(
  data: Buffer,
  mime: string,
  name: string,
  kind: Attachment["kind"],
  uploadDir: string
): Promise<{ url: string; path: string }> {
  const sha256 = createHash("sha256").update(data).digest("hex");
  const ext = safeBinaryExtension(mime, name, kind);
  const root = path.resolve(uploadDir);
  const dir = path.join(root, "inbound");
  const file = path.join(dir, `${sha256}${ext}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, data, { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    const existing = await fs.readFile(file);
    if (!existing.equals(data)) throw new ImageInputError("附件哈希文件冲突，拒绝覆盖");
  });
  return {
    url: `/uploads/inbound/${sha256}${ext}`,
    path: file,
  };
}

export async function validateAndNormalizeImage(data: Buffer, options: { verifyPixels?: boolean; staticImage?: boolean } = {}): Promise<{
  data: Buffer;
  mime: ImageMime;
  width: number;
  height: number;
  normalized: boolean;
}> {
  if (!data.byteLength) throw new ImageInputError("图片文件为空");
  const detected = detectImageMime(data);
  if (!detected) throw new ImageInputError("图片签名无效；仅支持 JPEG、PNG、GIF、WebP");
  let sharpFactory: typeof import("sharp")["default"];
  try {
    sharpFactory = (await import("sharp")).default;
  } catch {
    throw new ImageInputError("Harbour 缺少图片解码组件 sharp，无法安全验证视觉输入");
  }
  let metadata: import("sharp").Metadata;
  try {
    metadata = await sharpFactory(data, { limitInputPixels: MAX_IMAGE_PIXELS, animated: false }).metadata();
  } catch {
    throw new ImageInputError("图片已损坏、像素过大或无法解码");
  }
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  if (!width || !height) throw new ImageInputError("无法读取图片尺寸");
  const mustNormalize = data.byteLength > MAX_VISION_IMAGE_BYTES || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE
    || (options.staticImage === true && (detected === "image/gif" || Number(metadata.pages ?? 1) > 1));
  if (options.verifyPixels && !mustNormalize) {
    try { await sharpFactory(data, { limitInputPixels: MAX_IMAGE_PIXELS, animated: false, failOn: "warning" }).stats(); }
    catch { throw new ImageInputError("图片像素无法完整解码，未向模型提供图片"); }
  }
  if (!mustNormalize) return { data, mime: detected, width, height, normalized: false };
  try {
    const normalized = await sharpFactory(data, { limitInputPixels: MAX_IMAGE_PIXELS, animated: false })
      .rotate()
      .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 90, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    if (normalized.data.byteLength > MAX_VISION_IMAGE_BYTES) {
      throw new ImageInputError("图片压缩后仍超过 5MB 视觉输入上限");
    }
    return {
      data: normalized.data,
      mime: "image/webp",
      width: normalized.info.width,
      height: normalized.info.height,
      normalized: true,
    };
  } catch (error) {
    if (isImageInputError(error)) throw error;
    throw new ImageInputError("图片尺寸或体积超限，自动优化失败");
  }
}

function detectImageMime(data: Buffer): ImageMime | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 6 && ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

async function persistPreparedImage(data: Buffer, mime: ImageMime, uploadDir: string): Promise<{
  url: string;
  path: string;
  sha256: string;
}> {
  const sha256 = createHash("sha256").update(data).digest("hex");
  const ext = mime === "image/jpeg" ? ".jpg" : mime === "image/png" ? ".png" : mime === "image/gif" ? ".gif" : ".webp";
  const root = path.resolve(uploadDir);
  const dir = path.join(root, "inbound");
  const file = path.join(dir, `${sha256}${ext}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, data, { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    const existing = await fs.readFile(file);
    if (!existing.equals(data)) throw new ImageInputError("图片哈希文件冲突，拒绝覆盖");
  });
  return {
    url: `/uploads/inbound/${sha256}${ext}`,
    path: file,
    sha256,
  };
}

function mb(bytes: number): number {
  return Math.max(1, Math.floor(bytes / 1024 / 1024));
}
