import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TurnFileChange } from "../types";

const MAX_PREVIEW_BYTES = 1024 * 1024;
const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", md: "markdown", css: "css", html: "html", py: "python", sh: "shell",
  ps1: "powershell", yaml: "yaml", yml: "yaml", toml: "toml", sql: "sql", rs: "rust",
};

export interface TurnFilePreview {
  file: TurnFileChange;
  status: "text" | "deleted" | "binary" | "too_large" | "unavailable" | "remote_unavailable";
  view: "current";
  content?: string;
  language?: string;
  size?: number;
  reason?: string;
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !!relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function sensitivePath(relative: string): boolean {
  return relative.split(/[\\/]/).some((part) =>
    /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.gnupg|\.npmrc|\.netrc|id_rsa|id_ed25519|credentials(?:\.json)?)$/i.test(part)
    || /\.(?:pem|p12|pfx|key)$/i.test(part));
}

/** 只接受会话内已记录的文件证据，不接受客户端任意 path。预览是当前磁盘内容，不是历史快照。 */
export async function readTurnFilePreview(
  file: TurnFileChange,
  options: { root?: string; hostname?: string } = {},
): Promise<TurnFilePreview> {
  const result = (status: TurnFilePreview["status"], extra: Partial<TurnFilePreview> = {}): TurnFilePreview =>
    ({ file, status, view: "current", ...extra });
  if (file.location !== "local") return result("remote_unavailable", { reason: "此文件位于执行设备；当前预览不读取远端文件，也不会改读服务端同名路径。" });
  if (!file.originHost || file.originHost !== (options.hostname ?? os.hostname())) {
    return result("unavailable", { reason: "文件修改发生在另一台或未标识的主机，不能以当前服务器同名路径代替。" });
  }
  const root = path.resolve(options.root ?? process.cwd());
  const target = path.resolve(file.path);
  if (!path.isAbsolute(file.path) || !within(root, target)) {
    return result("unavailable", { reason: "当前预览仅支持本机 Harbour 项目内的已记录文件；该路径不在此范围内。" });
  }
  if (sensitivePath(path.relative(root, target))) {
    return result("unavailable", { reason: "凭证或私钥文件不在聊天预览中展开。" });
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
    if (!within(realRoot, realTarget) || sensitivePath(path.relative(realRoot, realTarget))) {
      return result("unavailable", { reason: "文件链接指向预览范围外或敏感位置，已停止读取。" });
    }
    // 不阻塞在设备/FIFO；句柄检查与读取使用同一文件，体积按读取上限再次约束。
    handle = await fs.open(realTarget, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) return result("unavailable", { reason: "此记录当前不是普通文件。" });
    if (stat.size > MAX_PREVIEW_BYTES) return result("too_large", { size: stat.size, reason: "文件超过 1 MiB 预览上限，未加载正文。" });
    const buffer = Buffer.alloc(MAX_PREVIEW_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > MAX_PREVIEW_BYTES) return result("too_large", { size: length, reason: "文件在读取期间增大，已停止展开。" });
    const bytes = buffer.subarray(0, length);
    const utf16 = length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
    if (!utf16 && bytes.includes(0)) return result("binary", { size: length, reason: "二进制文件不作为源代码展开。" });
    let content: string;
    try {
      content = new TextDecoder(utf16 ? (bytes[0] === 0xff ? "utf-16le" : "utf-16be") : "utf-8", { fatal: true }).decode(bytes);
    } catch {
      return result("binary", { size: length, reason: "此文件不是支持的 UTF-8 / UTF-16 文本。" });
    }
    return result("text", { content, size: length, language: LANGUAGES[path.extname(target).slice(1).toLowerCase()] ?? "text" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return result("deleted", { reason: "当前磁盘上已找不到此文件；这里不保存历史文件正文。" });
    return result("unavailable", { reason: "当前文件无法读取，可能已移动或权限发生变化。" });
  } finally {
    await handle?.close().catch(() => {});
  }
}
