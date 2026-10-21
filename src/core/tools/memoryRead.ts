import path from "node:path";
import { promises as fs } from "node:fs";
import type { ToolDef } from "../../types";
import { resolveRead } from "../permissions";

/** Memory 是中央资源；不能借 Cowork 的普通文件工具误读目标电脑上的同名目录。 */
export const memoryReadTool: ToolDef = {
  name: "memory_read",
  description: "读取或列出中央 assets/Memory 知识库（不随 Cowork 设备切换）。path 相对知识库根；外部摄入源仍用目标设备 read_file/list_files。",
  readOnly: true,
  parameters: { type: "object", properties: { action: { type: "string", enum: ["read", "list"] }, path: { type: "string" } }, required: ["action"], additionalProperties: false },
  async execute(args, ctx) {
    if (args.action !== "read" && args.action !== "list") throw new Error("memory_read action 必须为 read/list");
    const root = await fs.realpath(path.resolve("assets/Memory"));
    const requested = String(args.path ?? "");
    const target = await fs.realpath(resolveRead(ctx, path.resolve(root, requested)));
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("memory_read 只能访问中央知识库");
    if (args.action === "list") {
      const entries = await fs.readdir(target, { withFileTypes: true });
      return { location: "server", path: relative, entries: entries.slice(0, 500).map((entry) => ({ name: entry.name, directory: entry.isDirectory() })), truncated: entries.length > 500 };
    }
    const file = await fs.open(target, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1_048_576) throw new Error("知识页不是普通文件或超过 1 MB，请按索引缩小读取范围");
      const bytes = Buffer.alloc(Math.min(stat.size + 1, 1_048_577));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 1_048_576) throw new Error("知识页在读取时超过上限");
      return { location: "server", path: relative, content: bytes.subarray(0, bytesRead).toString("utf8") };
    } finally { await file.close(); }
  },
};
