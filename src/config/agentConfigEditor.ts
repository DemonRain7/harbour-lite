import matter from "gray-matter";
import { ManifestSchema } from "./loadAgents";

// These are editing paths, not a second validation schema. The loader is authoritative.
export const AGENT_CONFIG_PATHS = [
  "description", "model", "taskType", "contextBudget", "maxSteps", "permissionMode", "reasoningEffort",
  "readsGlobalMemory", "fallbacks", "routerOverrides", "governance.temperature", "governance.allowedModels",
  "governance.maxTokensPerRun", "governance.tokenBudgetMode", "governance.hardMaxTokensPerRun",
  "governance.permissions.readOnly", "governance.permissions.readPaths", "governance.permissions.writePaths",
  "governance.permissions.tools", "governance.permissions.mcp",
] as const;

/** Transform only manifest metadata in a supplied draft. No filesystem, model calls or mutation. */
export function previewAgentConfig(source: unknown, patch: unknown) {
  if (typeof source !== "string" || source.length > 500_000) throw new Error("配置文件草稿必须是有效文本（最多 50 万字符）");
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("配置 patch 必须是对象");
  const head = source.match(/^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---[^\S\r\n]*(?:\r?\n|$))/);
  if (!head) throw new Error("CLAUDE.md 缺少有效的 YAML frontmatter，请在文件编辑器修复后重试");
  const data = structuredClone(matter(source.replace(/^\uFEFF/, "")).data) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (!(AGENT_CONFIG_PATHS as readonly string[]).includes(key)) throw new Error(`不支持的配置项：${key}`);
    const keys = key.split(".");
    let node: Record<string, unknown> | undefined = data;
    for (const segment of keys.slice(0, -1)) {
      if (!node) break;
      if (node[segment] === undefined) {
        if (value === null) { node = undefined; break; }
        node[segment] = {};
      }
      const child = node[segment];
      if (!child || typeof child !== "object" || Array.isArray(child)) {
        throw new Error(`${segment} 必须是配置对象`);
      }
      node = child as Record<string, unknown>;
    }
    if (!node) continue;
    const leaf = keys.at(-1)!;
    if (value === null) delete node[leaf];
    else node[leaf] = value;
  }
  const parsed = ManifestSchema.safeParse(data);
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("；"));
  // Empty optional containers do not introduce new policy; unknown existing fields survive.
  const governance = data.governance as Record<string, unknown> | undefined;
  if (governance?.permissions && !Object.keys(governance.permissions).length) delete governance.permissions;
  if (governance && !Object.keys(governance).length) delete data.governance;
  let content = source;
  if (Object.keys(patch).length) {
    const eol = head[1]!.endsWith("\r\n") ? "\r\n" : "\n";
    const serialized = matter.stringify("", data);
    const yaml = serialized.match(/^---\n([\s\S]*?)\n---/)?.[1];
    if (yaml === undefined) throw new Error("无法生成配置草稿");
    // Body, @ references, persona, NSFW rules and exact trailing whitespace remain byte-for-byte unchanged.
    content = head[1] + yaml.replace(/\n/g, eol) + head[3] + source.slice(head[0].length);
  }
  return { config: data, content };
}
