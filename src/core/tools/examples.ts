import { promises as fs } from "node:fs";
import type { ToolDef } from "../../types";
import { resolveRead } from "../permissions";
import { runTraceReadMetadata } from "../trace";

/**
 * 几个示例工具，便于不接真模型也能跑通 loop。
 * 都对本地文件系统只读操作（可对 mockdata/ 跑），结果统一返回可 JSON 化的对象。
 * 路径经 resolveRead 过 sandbox 读权限校验（agent 声明 readPaths 时生效）。
 */

/** 列出某目录下的文件名（非递归）。 */
export const listFilesTool: ToolDef = {
  name: "list_files",
  readOnly: true,
  description: "列出指定目录下的文件名（非递归）。返回 { dir, files }。",
  parameters: {
    type: "object",
    properties: {
      dir: { type: "string", description: "相对工作目录或绝对路径的目录" },
    },
    required: ["dir"],
  },
  async execute(args, ctx) {
    const dir = String(args.dir ?? "");
    const abs = resolveRead(ctx, dir); // sandbox：越权读路径直接拒绝
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    return { dir, files };
  },
};

/** 读取一个文件的 UTF-8 内容。 */
export const readFileTool: ToolDef = {
  name: "read_file",
  readOnly: true,
  description: "读取指定文件的 UTF-8 文本内容。返回 { path, content }；长文件可用 offset（从 0 起的字符偏移）和 limit 分页，按 nextOffset 继续。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对工作目录或绝对路径的文件" },
      offset: { type: "integer", minimum: 0, description: "字符偏移，从 0 起；下一页使用返回的 nextOffset" },
      limit: { type: "integer", minimum: 1, maximum: 8000, description: "本页最多字符数；设置 offset 时默认 8000" },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const p = String(args.path ?? "");
    const abs = resolveRead(ctx, p); // sandbox：越权读路径直接拒绝
    const content = await fs.readFile(abs, "utf8");
    const traceCoverage = await runTraceReadMetadata(abs, content);
    if (args.offset !== undefined || args.limit !== undefined) {
      const offset = args.offset ?? 0, limit = args.limit ?? 8000;
      if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
        || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 8000)
        throw new Error("read_file: offset 必须是非负整数，limit 必须是 1–8000 的整数");
      let start = Math.min(offset, content.length), end = Math.min(start + limit, content.length);
      const betweenSurrogates = (i: number) => /[\uD800-\uDBFF]/.test(content.charAt(i - 1)) && /[\uDC00-\uDFFF]/.test(content.charAt(i));
      if (betweenSurrogates(start)) start--;
      if (betweenSurrogates(end)) end++;
      return { path: p, content: content.slice(start, end), offset: start, nextOffset: end < content.length ? end : null,
        totalCharacters: content.length, truncated: start > 0 || end < content.length, ...(traceCoverage ? { traceCoverage } : {}) };
    }
    return { path: p, content, ...(traceCoverage ? { traceCoverage } : {}) };
  },
};

export const exampleTools: ToolDef[] = [listFilesTool, readFileTool];
