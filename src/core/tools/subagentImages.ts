import { promises as fs } from "node:fs";
import path from "node:path";
import type { Attachment, ToolContext } from "../../types";
import { ImageInputError, prepareIncomingAttachments } from "../imageIntake";
import { resolveRead } from "../permissions";

export interface SubagentImageSource {
  /** Original explicit selector; strings are Harbour URLs, never filesystem paths. */
  ref: number | string;
  /** One-based position in the deduplicated native image attachments. */
  imageIndex: number;
  name: string;
  mime: string;
  width: number;
  height: number;
  sha256: string;
  normalized?: boolean;
}

export interface ResolvedSubagentImages {
  attachments: Attachment[];
  /** One row per requested selector, including aliases, in original request order. */
  sources: SubagentImageSource[];
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ImageInputError("子 Agent 图片读取已取消");
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function uploadRelativePath(ref: string): string {
  if (!ref.startsWith("/uploads/")) {
    throw new ImageInputError("images 字符串只接受 /uploads/... 图片 URL，不接受远程 URL 或本地路径");
  }
  let relative: string;
  try {
    relative = decodeURIComponent(ref.slice("/uploads/".length));
  } catch {
    throw new ImageInputError("images 图片 URL 编码无效");
  }
  // Do not let URL query/fragment syntax, Windows separators/ADS, or dot segments
  // become a second path language after percent decoding.
  if (/[\u0000-\u001f\u007f\\?#:]/u.test(relative) ||
      relative.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ImageInputError("images 图片 URL 含无效路径、查询参数或越界片段");
  }
  return relative;
}

function safeName(name: string): string {
  return path.posix.basename(String(name).replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 160);
}

/** Explicit, bounded image delegation; never scrape paths from the task's prose. */
export async function resolveSubagentImages(
  images: unknown,
  ctx: ToolContext,
  options: { uploadDir: string; maxSourceBytes: number },
): Promise<ResolvedSubagentImages> {
  checkCancelled(ctx.signal);
  if (!Array.isArray(images) || images.length > 10) {
    throw new ImageInputError("images 必须是数组，单次最多选择 10 张图片");
  }
  if (!Number.isFinite(options.maxSourceBytes) || options.maxSourceBytes <= 0) {
    throw new ImageInputError("子 Agent 图片大小上限配置无效");
  }
  if (!images.length) return { attachments: [], sources: [] };

  const root = path.resolve(options.uploadDir);
  const selected: Attachment[] = [];
  const refs: Array<number | string> = [];
  for (const ref of images) {
    checkCancelled(ctx.signal);
    if (typeof ref === "number" && Number.isInteger(ref) && ref >= 0) {
      const grant = ctx.attachments?.[ref];
      if (!grant || grant.kind !== "image") {
        throw new ImageInputError(`images[${ref}] 不是本轮可用的图片附件`);
      }
      selected.push({ ...grant });
      refs.push(ref);
      continue;
    }
    if (typeof ref !== "string") {
      throw new ImageInputError("images 每项必须是本轮附件的非负整数索引，或 /uploads/... 图片 URL");
    }
    const relative = uploadRelativePath(ref);
    const grant = ctx.attachments?.find((attachment) => attachment.kind === "image" && attachment.url === ref);
    if (grant) {
      // Exact existing image URLs retain the same authority as attachment indices.
      selected.push({ ...grant });
      refs.push(ref);
      continue;
    }
    if (ctx.source?.actor?.role !== "owner") {
      throw new ImageInputError("只有可信主人可以选择本轮图片附件之外的 /uploads 图片");
    }
    const candidate = path.resolve(root, relative);
    if (!inside(root, candidate)) throw new ImageInputError("images 图片路径超出 Harbour 上传目录");
    resolveRead(ctx, candidate);
    let realRoot: string;
    let realFile: string;
    try {
      [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
    } catch {
      throw new ImageInputError("images 指定的图片不存在或无法读取");
    }
    if (!inside(realRoot, realFile)) throw new ImageInputError("images 图片链接超出 Harbour 上传目录");
    resolveRead(ctx, realFile);
    const stat = await fs.stat(realFile);
    if (!stat.isFile() || stat.size <= 0 || stat.size > options.maxSourceBytes) {
      throw new ImageInputError("images 指定的图片不是有效文件，或已超过上传大小上限");
    }
    selected.push({ kind: "image", url: ref, path: realFile, mime: "application/octet-stream", name: safeName(relative) });
    refs.push(ref);
  }

  const prepared = await prepareIncomingAttachments(selected, {
    platform: ctx.source?.channel,
    uploadDir: root,
    maxSourceBytes: options.maxSourceBytes,
    signal: ctx.signal,
  }, ctx.logger);
  checkCancelled(ctx.signal);
  const attachments: Attachment[] = [];
  const sources: SubagentImageSource[] = [];
  const imageIndexes = new Map<string, number>();
  for (let index = 0; index < prepared.attachments.length; index += 1) {
    const attachment = prepared.attachments[index]!;
    const metadata = attachment.image;
    if (attachment.kind !== "image" || !metadata) {
      throw new ImageInputError("子 Agent 图片缺少已验证的像素元数据");
    }
    let imageIndex = imageIndexes.get(metadata.sha256);
    if (imageIndex === undefined) {
      attachments.push(attachment);
      imageIndex = attachments.length;
      imageIndexes.set(metadata.sha256, imageIndex);
    }
    sources.push({
      ref: refs[index]!,
      imageIndex,
      name: safeName(attachment.name),
      mime: attachment.mime,
      width: metadata.width,
      height: metadata.height,
      sha256: metadata.sha256,
      ...(metadata.normalized ? { normalized: true } : {}),
    });
  }
  return { attachments, sources };
}
