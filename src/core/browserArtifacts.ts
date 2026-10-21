import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolContext } from "../types";

export interface BrowserArtifact {
  path: string;
  url: string;
  name: string;
  size: number;
  kind: "image";
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Called only with a file just produced by our tool, never a model-provided path. */
export async function publishBrowserImage(source: string, sourceRoot: string, uploadDir: string): Promise<BrowserArtifact> {
  const [root, file] = await Promise.all([realpath(sourceRoot), realpath(source)]);
  if (!inside(root, file)) throw new Error("浏览器图片不在本轮受控产出目录内");
  const info = await stat(file);
  if (!info.isFile() || info.size < 1 || info.size > 40 * 1024 * 1024) throw new Error("浏览器图片大小无效");
  const bytes = await readFile(file);
  const sharp = (await import("sharp")).default;
  const metadata = await sharp(bytes, { limitInputPixels: 50_000_000 }).metadata();
  const extensions: Record<string, string> = { png: "png", jpeg: "jpg", webp: "webp", gif: "gif" };
  const ext = extensions[metadata.format ?? ""];
  if (!ext || !metadata.width || !metadata.height) throw new Error("浏览器产物不是可验证的图片");
  await mkdir(uploadDir, { recursive: true });
  const uploads = await realpath(uploadDir);
  const directory = path.join(uploads, "browser");
  await mkdir(directory, { recursive: true });
  if (!inside(uploads, await realpath(directory))) throw new Error("浏览器交付目录越界");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const name = `${hash}.${ext}`;
  const destination = path.join(directory, name);
  try { await writeFile(destination, bytes, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await lstat(destination)).isSymbolicLink() || !inside(uploads, await realpath(destination))
      || createHash("sha256").update(await readFile(destination)).digest("hex") !== hash) {
      throw new Error("浏览器交付文件校验失败，未覆盖原文件");
    }
  }
  return { path: destination, url: `/uploads/browser/${name}`, name, size: bytes.length, kind: "image" };
}

/** Publishing failure never re-runs the page action; the original remains recoverable. */
export async function deliverBrowserImage(ctx: ToolContext, source: string, sourceRoot: string, uploadDir: string) {
  try {
    const artifact = await publishBrowserImage(source, sourceRoot, uploadDir);
    const receipts = ctx.execution?.browserArtifacts;
    if (receipts && !receipts.some(item => item.url === artifact.url)) receipts.push(artifact);
    return { url: artifact.url, deliveryArtifact: artifact };
  } catch (error) {
    return { deliveryError: error instanceof Error ? error.message : String(error) };
  }
}
