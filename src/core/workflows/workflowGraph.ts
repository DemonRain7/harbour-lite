import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { WORKFLOW_GRAPHS, type WorkflowGraphDefinition } from "./workflowGraphCatalog";

export interface WorkflowGraphDocument {
  version: 1;
  executor: string;
  positions: Record<string, { x: number; y: number }>;
  notes: Record<string, string>;
  settings: Record<string, number>;
}
export class WorkflowGraphError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkflowGraphError("画布字段必须是对象");
  return value as Record<string, unknown>;
};
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new WorkflowGraphError(`不支持字段 ${key}；画布不能改写执行器连线或注入脚本`);
}
export function graphDefinition(name: string): WorkflowGraphDefinition {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !Object.hasOwn(WORKFLOW_GRAPHS, name)) {
    throw new WorkflowGraphError("此 Workflow 尚未注册流程图；仍可查看和编辑 MD 契约", 404);
  }
  return WORKFLOW_GRAPHS[name]!;
}
export function defaultGraphDocument(name: string): WorkflowGraphDocument {
  const definition = graphDefinition(name);
  return { version: 1, executor: name, positions: {}, notes: {},
    settings: Object.fromEntries(definition.settings.map(setting => [setting.key, setting.default])) };
}
export function validateGraphDocument(name: string, input: unknown): WorkflowGraphDocument {
  const definition = graphDefinition(name), raw = object(input);
  exactKeys(raw, ["version", "executor", "positions", "notes", "settings"]);
  if (raw.version !== 1 || raw.executor !== name) throw new WorkflowGraphError("画布版本或执行器不匹配");
  const positions = object(raw.positions), notes = object(raw.notes), settings = object(raw.settings);
  const ids = definition.nodes.map(node => node.id);
  exactKeys(positions, ids); exactKeys(notes, ids); exactKeys(settings, definition.settings.map(setting => setting.key));
  const document = defaultGraphDocument(name);
  for (const [id, value] of Object.entries(positions)) {
    const position = object(value); exactKeys(position, ["x", "y"]);
    if (![position.x, position.y].every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 8000)) {
      throw new WorkflowGraphError("节点坐标必须为 0–8000 的有限数字");
    }
    document.positions[id] = { x: position.x as number, y: position.y as number };
  }
  for (const [id, value] of Object.entries(notes)) {
    if (typeof value !== "string" || value.length > 1200) throw new WorkflowGraphError("节点备注最多 1200 字符");
    document.notes[id] = value;
  }
  for (const field of definition.settings) {
    const value = settings[field.key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < field.min || value > field.max) {
      throw new WorkflowGraphError(`${field.label} 必须为 ${field.min}–${field.max} 的整数`);
    }
    document.settings[field.key] = value;
  }
  return document;
}

/** 所有源文件均来自静态目录；拒绝 symlink/junction 导向项目外或另一个项目目录。 */
async function controlledPath(root: string, relative: string, missing = false): Promise<string> {
  const resolvedRoot = await fs.realpath(root);
  const parts = relative.split("/");
  let current = resolvedRoot;
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(current, parts[i]!);
    try {
      const actual = await fs.realpath(next);
      if (path.relative(next, actual) !== "") throw new WorkflowGraphError("流程图不接受重定向路径");
      current = actual;
    } catch (error) {
      if (missing && i === parts.length - 1 && (error as NodeJS.ErrnoException).code === "ENOENT") return next;
      throw error;
    }
  }
  return current;
}
async function readBounded(file: string) {
  if ((await fs.stat(file)).size > 1024 * 1024) throw new WorkflowGraphError("文件过大，不能在流程画布读取");
  return fs.readFile(file, "utf8");
}
export async function readWorkflowGraph(name: string, root = process.cwd()) {
  const definition = graphDefinition(name);
  const contractPath = `workflows/${name}/WORKFLOW.md`;
  const contract = await readBounded(await controlledPath(root, contractPath));
  const meta = matter(contract).data;
  if (meta.name !== name || meta.executor !== definition.executor) throw new WorkflowGraphError("WORKFLOW.md 与已注册执行器不匹配");
  const targetPath = `workflows/${name}/GRAPH.json`;
  const file = await controlledPath(root, targetPath, true);
  const content = await readBounded(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  let document: WorkflowGraphDocument;
  try { document = content ? validateGraphDocument(name, JSON.parse(content)) : defaultGraphDocument(name); }
  catch (error) { throw new WorkflowGraphError(`GRAPH.json 无效：${error instanceof Error ? error.message : String(error)}；请在文件视图修复`); }
  return { definition, document, targetPath, contractPath, revision: hash(`${contract}\0${content}`), beforeHash: hash(content) };
}
export async function previewWorkflowGraph(name: string, input: unknown, root = process.cwd()) {
  const raw = object(input); exactKeys(raw, ["revision", "document"]);
  const current = await readWorkflowGraph(name, root);
  if (raw.revision !== current.revision) throw new WorkflowGraphError("流程已在另一处修改，请刷新后重新编辑；本次未提交", 409);
  const document = validateGraphDocument(name, raw.document);
  return { ...current, document, content: `${JSON.stringify(document, null, 2)}\n` };
}
export async function readWorkflowGraphSource(name: string, id: string, root = process.cwd()) {
  await readWorkflowGraph(name, root);
  const source = graphDefinition(name).nodes.find(node => node.id === id)?.source;
  if (!source) throw new WorkflowGraphError("此节点没有可读取的实现文件", 404);
  const text = await readBounded(await controlledPath(root, source.path));
  const lines = text.split(/\r?\n/);
  const index = source.symbol ? lines.findIndex(line => line.includes(source.symbol!)) : 0;
  const start = Math.max(0, index - 2), end = Math.min(lines.length, start + 100);
  return { path: source.path, startLine: start + 1, endLine: end, totalLines: lines.length,
    content: lines.slice(start, end).join("\n"), readOnly: true };
}

/** 只在创建新 Job 时取执行默认值；布局和备注永远不送入模型、不参与执行。 */
export async function readWorkflowGraphSettings(name: string, root = process.cwd()) {
  return (await readWorkflowGraph(name, root)).document.settings;
}

/** Governance 创建/应用都校验，防文件编辑入口绕过画布校验。 */
export async function validateGovernedGraph(target: string, content: string, root = process.cwd()) {
  const match = /^workflows\/([a-z0-9-]+)\/GRAPH\.json$/i.exec(target.replace(/\\/g, "/"));
  if (!match) return;
  const name = match[1]!;
  // 即使当前 GRAPH.json 损坏也允许修复；单独验证契约及真实落盘路径。
  const definition = graphDefinition(name);
  const contract = matter(await readBounded(await controlledPath(root, `workflows/${name}/WORKFLOW.md`))).data;
  if (contract.name !== name || contract.executor !== definition.executor) throw new WorkflowGraphError("执行器与契约不匹配");
  await controlledPath(root, `workflows/${name}/GRAPH.json`, true);
  if (Buffer.byteLength(content) > 128 * 1024) throw new WorkflowGraphError("GRAPH.json 超过 128KB");
  validateGraphDocument(name, JSON.parse(content));
}
