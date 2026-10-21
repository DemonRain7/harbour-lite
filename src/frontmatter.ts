import { parse, stringify } from 'yaml';

export function document(text: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new Error('文档需要 YAML frontmatter');
  const data: unknown = parse(match[1]!, { maxAliasCount: 0 });
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('文档配置格式错误');
  return { data: data as Record<string, unknown>, content: match[2]!.trim() };
}
export function serialize(data: Record<string, unknown>, content: string) {
  return `---\n${stringify(data)}---\n\n${content.trim()}\n`;
}
