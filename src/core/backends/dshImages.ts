import { createHash } from "node:crypto";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { ImageAttachmentRef, ImageRequestTarget, RequestImageAttachment, SaveImageAttachment } from "@deepseek-ai/dsh-attachment";
import type { Message } from "../../types";
import { ImageInputError, validateAndNormalizeImage } from "../imageIntake";
import { toolImages, type ToolImage } from "../toolImages";
import { loadPromptImages } from "./claudeAgentSdk";

type AttachmentModule = typeof import("@deepseek-ai/dsh-attachment");

/** Run-local, pixel-verified bridge. Only Harbour's admitted uploads/tool pixels enter it.
 * DSH receives opaque content hashes, never filesystem capabilities or remote URLs.
 * No second image library, remote Files upload, or persistent base64 transcript.
 */
export async function createDshImages(ctx: Context, module: AttachmentModule, messages: Message[], uploadDir: string, signal?: AbortSignal) {
  const stored = new Map<string, { ref: ImageAttachmentRef; data: Buffer }>();
  const versions = new Map<string, RequestImageAttachment>();
  const attachments = new class extends module.AttachmentStore {
    readonly imageLimits = { maxImageBytes: 5 * 1024 * 1024, maxImagesPerMessage: 10, maxMessageImageBytes: 20 * 1024 * 1024,
      maxImagePixels: 40_000_000, maxImageDimension: 4096, mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"] as const };
    async validateImage(input: SaveImageAttachment) { await validateAndNormalizeImage(Buffer.from(input.data), { verifyPixels: true, staticImage: true }); }
    async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
      signal?.throwIfAborted();
      if (input.data.byteLength > this.imageLimits.maxImageBytes) throw new ImageInputError("DSH 图片超过 5MB");
      const image = await validateAndNormalizeImage(Buffer.from(input.data), { verifyPixels: true, staticImage: true });
      const id = createHash("sha256").update(image.data).digest("hex");
      const ref: ImageAttachmentRef = { attachmentId: module.AttachmentId(id), mediaType: image.mime, bytes: image.data.length,
        width: image.width, height: image.height };
      if (stored.size >= 32 && !stored.has(id)) throw new ImageInputError("DSH 本轮图片数超过安全上限");
      if (!stored.has(id) && [...stored.values()].reduce((sum, item) => sum + item.data.length, image.data.length) > 20 * 1024 * 1024) {
        throw new ImageInputError("DSH 本轮图片总大小超过 20MB");
      }
      stored.set(id, { ref, data: image.data });
      return ref;
    }
    async readImage(ref: ImageAttachmentRef, callerSignal?: AbortSignal) {
      signal?.throwIfAborted(); callerSignal?.throwIfAborted();
      const item = stored.get(ref.attachmentId);
      if (!item || item.ref.bytes !== ref.bytes || item.ref.mediaType !== ref.mediaType
        || item.ref.width !== ref.width || item.ref.height !== ref.height) throw new ImageInputError("DSH 图片引用未通过校验");
      return item;
    }
    override async readImageRequest(ref: ImageAttachmentRef, target: ImageRequestTarget, callerSignal?: AbortSignal): Promise<RequestImageAttachment> {
      const item = await this.readImage(ref, callerSignal);
      const key = `${ref.attachmentId}:${target.width}:${target.height}:${target.maxBytes}:webp90-v1`;
      const known = versions.get(key); if (known) return known;
      const sharp = (await import("sharp")).default;
      const encoded = await sharp(item.data, { limitInputPixels: this.imageLimits.maxImagePixels, failOn: "warning" })
        .rotate().resize({ width: target.width, height: target.height, fit: "inside", withoutEnlargement: true })
        .toColourspace("srgb").webp({ quality: 90, effort: 0 }).toBuffer({ resolveWithObject: true });
      if (encoded.data.length > target.maxBytes) throw new ImageInputError("DSH 图片请求超过体积上限，未静默丢弃图片");
      callerSignal?.throwIfAborted(); signal?.throwIfAborted();
      const version: RequestImageAttachment = { variantId: module.ImageVariantId(createHash("sha256").update(key).digest("hex")),
        attachment: item.ref, data: encoded.data, mediaType: "image/webp", bytes: encoded.data.length,
        width: encoded.info.width, height: encoded.info.height, depth: "uchar", space: "srgb", hasAlpha: encoded.info.channels === 4 };
      versions.set(key, version); return version;
    }
  }(ctx);
  const blocksFromPixels = async (images: readonly ToolImage[]): Promise<ContentBlock[]> => {
    const blocks: ContentBlock[] = [];
    for (const image of images) blocks.push({ type: "image", attachment: await attachments.saveImage({ data: Buffer.from(image.data, "base64"), mediaType: image.mimeType }) });
    return blocks;
  };
  const loaded = await loadPromptImages(messages, uploadDir);
  const content = new Map<Message, ContentBlock[]>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const blocks: ContentBlock[] = message.content ? [{ type: "text", text: message.content }] : [];
    blocks.push(...await blocksFromPixels(toolImages(message)));
    for (let j = 0; j < (message.attachments?.length ?? 0); j++) {
      const item = message.attachments![j]!;
      const label = path.basename(String(item.name || "attachment")).replace(/[\r\n\t]/g, " ").slice(0, 160);
      if (item.kind !== "image") { blocks.push({ type: "text", text: `[${item.kind} 附件：${label}；${item.url}]` }); continue; }
      const image = loaded.get(`${i}:${j}`);
      if (!image) { blocks.push({ type: "text", text: `[历史图片当前不可用：${label}；不得猜测其内容]` }); continue; }
      blocks.push({ type: "text", text: `[图片附件：${label}]` },
        { type: "image", attachment: await attachments.saveImage({ data: image.data, mediaType: image.mediaType }) });
    }
    content.set(message, blocks.length ? blocks : [{ type: "text", text: "（空消息）" }]);
  }
  return { attachments, content, blocksFromPixels };
}
