import { readFile } from "node:fs/promises";
import { z } from "zod";
import { expandSkillResources, loadSkillResourceIndex, resolveSkillResourceFile,
  type SkillResourceIndex } from "./skillResourceIndex";
import { extractNovelAiTemplateBlocks, isIntactNovelAiFragmentSyntax, novelAiTemplatePortableSha256, sha256Hex,
  type ResolvedNovelAiTemplateFragment } from "./novelAiTemplateFragments";

/** Opt-in parameterized templates. This renderer has no model, browser, token
 * counter or model-route decision. Existing callers without modules do no I/O. */
export interface NovelAiTemplateModuleInput {
  id: string;
  values?: Record<string, string | string[]>;
}

// Layered templates now have separate composition, style, lighting and action
// modules. Keep a bounded input without retaining the old three-module-era cap.
export const NOVELAI_TEMPLATE_MAX_SELECTIONS = 8;

/** Values already normalized and validated by the shared composer. A module may
 * branch on these instead of asking the author to restate the same field; an
 * omitted field is reported as "absent" and never guessed. */
export interface NovelAiTemplateModuleContext {
  garments?: readonly string[];
  hosiery?: { color: string; structure: string };
  underwear?: { state: string };
}

/** The only context a module may branch on. Each entry is an already validated
 * author field of the unified compiler; unknown names are rejected at load. */
export const NOVELAI_TEMPLATE_CONTEXT_DOMAINS: Record<string, readonly string[]> = {
  "outfit.hosiery.color": ["white", "nude", "black"],
  "outfit.hosiery.structure": ["standard", "male-sheath"],
  "outfit.underwear.state": ["none", "worn"],
};
export const NOVELAI_TEMPLATE_CONTEXT_ABSENT = "absent";

const id = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const parameterName = z.string().regex(/^[a-z][a-zA-Z0-9]{0,47}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const heading = z.array(z.string().min(1).max(160)).min(1).max(6);
const parameter = z.discriminatedUnion("type", [
  z.object({ type: z.literal("enum"), values: z.array(id).min(1).max(24), default: id.optional() }).strict(),
  z.object({ type: z.literal("set"), values: z.array(id).min(1).max(24),
    min: z.number().int().min(0).max(8), max: z.number().int().min(1).max(8),
    default: z.array(id).max(8).optional() }).strict(),
  // Compiler-provided state: the author never fills it, so it cannot contradict
  // the structured field it mirrors. No default; "absent" means the field is missing.
  z.object({ type: z.literal("context"), from: z.enum(["outfit.hosiery.color",
    "outfit.hosiery.structure", "outfit.underwear.state"]), values: z.array(id).min(1).max(24) }).strict(),
]);
const condition = z.array(z.object({ parameter: parameterName, in: z.array(id).min(1).max(24) }).strict()).min(1).max(8);
const source = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("block"), heading, block: z.number().int().min(0), sha256: digest }).strict(),
  z.object({ kind: z.literal("inline"), heading, sha256: digest }).strict(),
]);
/** Structural cross-parameter rule: counts the union of the selected values of
 * the listed SET parameters. It never inspects wording or content categories, so
 * a source rule stays a countable rule instead of a keyword heuristic. */
const crossLimit = z.object({
  when: condition.optional(),
  parameters: z.array(parameterName).min(1).max(8),
  min: z.number().int().min(0).max(64).optional(),
  max: z.number().int().min(0).max(64).optional(),
  coverage: z.object({ min: z.number().int().min(0).max(8).optional(),
    max: z.number().int().min(0).max(8).optional() }).strict().optional(),
  message: z.string().min(1).max(160),
}).strict();
/** Explicit Full / V4.5-Compact relation of one emitted fragment:
 *  "keep"    both versions emit this wording (already minimal);
 *  "omit"    a reviewed extension block the Compact version drops entirely;
 *  { short } a reviewed shorter wording the Compact version emits instead.
 * A module may not leave this implicit: every fragment that can reach a NovelAI
 * form has to declare which of the three relations it has. */
const compact = z.union([z.enum(["keep", "omit"]),
  z.object({ short: z.string().min(1).max(600) }).strict()]);
const fragment = z.object({
  id, source: id, lane: z.enum(["positive", "negative"]),
  compact,
  // Offsets are into a hash-pinned canonical SOURCE block, never a final prompt.
  // Every span is independently hash-pinned and must have intact syntax.
  span: z.object({ start: z.number().int().min(0), end: z.number().int().positive(), sha256: digest }).strict().optional(),
  requirement: z.enum(["required", "optional"]), priority: z.number().int().min(0).max(10000).optional(),
  when: condition.optional(), requiredWhen: condition.optional(),
  requires: z.array(id).max(16).optional(),
}).strict();
// A relationship selects another registered module, never copies its wording.
// "same" retains the exact character card; crossing to characters must be explicit.
const moduleDependency = z.object({
  module: id, target: z.enum(["same", "base", "each-character"]).default("same"),
  when: condition.optional(),
  values: z.record(parameterName, z.union([id, z.array(id).max(8),
    z.object({ fromParameter: parameterName }).strict()])).optional(),
}).strict();
const moduleSchema = z.object({
  schemaVersion: z.literal(1), id, scope: z.enum(["base", "character"]), exclusiveGroup: id.optional(),
  requiresFields: z.array(z.enum(["outfit.garments", "outfit.hosiery"])).max(2).optional(),
  parameters: z.record(parameterName, parameter), sources: z.record(id, source),
  constraints: z.array(z.object({ when: condition, require: condition, message: z.string().min(1).max(160) }).strict()).max(24).optional(),
  limits: z.array(crossLimit).max(8).optional(),
  requires: z.array(moduleDependency).max(8).optional(),
  fragments: z.array(fragment).min(1).max(96),
}).strict();
type Module = z.infer<typeof moduleSchema>;
type Fragment = Module["fragments"][number];
type Values = Record<string, string | string[]>;
type Binding = { id: string; path: string; resource: string; sha256: string };
type Loaded = { module: Module; binding: Binding; text: Map<string, string>; compact: Map<string, string> };

const inputSchema = z.array(z.object({ id, values: z.record(parameterName,
  z.union([id, z.array(id).max(8)])).optional() }).strict()).max(NOVELAI_TEMPLATE_MAX_SELECTIONS);
const ASSEMBLY = "references/assembly.json";

function invalid(where: string, message: string): never {
  throw new Error(`templateModules ${where}: ${message}`);
}

async function boundedRead(root: string, resource: string): Promise<Buffer> {
  const { target } = await resolveSkillResourceFile(root, resource);
  const bytes = await readFile(target);
  if (bytes.length > 256 * 1024) invalid(resource, "文件超过 256 KiB");
  return bytes;
}

async function bindings(root: string): Promise<{ entries: Binding[]; bytes: Buffer }> {
  const bytes = await boundedRead(root, ASSEMBLY);
  const registry = JSON.parse(bytes.toString("utf8"));
  if (registry.schemaVersion !== 1 || registry.hashPolicy !== "sha256-lf-v1" || !Array.isArray(registry.resources)) {
    invalid(ASSEMBLY, "需要 schemaVersion=1 和跨平台 sha256-lf-v1 哈希");
  }
  const catalog = await loadSkillResourceIndex(root);
  const entries: Binding[] = [];
  const bindingSchema = z.object({ id, path: z.string().regex(/^assets\/template-modules\/[a-z0-9-]+\.json$/) }).strict();
  for (const resource of registry.resources) {
    if (resource.parameterization === undefined) continue;
    // One resource may expose several modules when its prompt wording lives in
    // more than one scope (a Base relation plus a per-character card). The
    // declared order is stable and each module still owns one scope.
    const declared = Array.isArray(resource.parameterization) ? resource.parameterization : [resource.parameterization];
    if (!declared.length || declared.length > 4) invalid(resource.path, "参数模块条目必须是 1–4 项");
    for (const item of declared) {
      const binding = bindingSchema.parse(item);
      if (resource.class !== "D" || !digest.safeParse(resource.portableSha256).success ||
        !catalog?.resources.some(entry => entry.path === resource.path)) {
        invalid(binding.id, "来源必须是唯一资源目录中已有、固定哈希的 D 类模板");
      }
      if (entries.some(entry => entry.id === binding.id || entry.path === binding.path)) {
        invalid(binding.id, "重复的模块 id 或配置路径");
      }
      entries.push({ ...binding, resource: resource.path, sha256: resource.portableSha256 });
    }
  }
  return { entries, bytes };
}

function parseValues(module: Module, supplied: unknown, where: string,
  contextValues: Record<string, string> = {}): Values {
  const raw = supplied ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid(where, "values 必须是对象");
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(module.parameters, key)) invalid(where, `未知参数 ${key}，不猜测别名`);
  }
  const values: Values = {};
  for (const [key, spec] of Object.entries(module.parameters)) {
    if (spec.type === "context") {
      // The compiler owns this value. A hand-filled duplicate could contradict the
      // structured field it mirrors, so it is refused rather than reconciled.
      if (Object.hasOwn(raw as object, key)) invalid(where, `${key} 由编译器按 ${spec.from} 提供，不接受作者手填`);
      const value = contextValues[spec.from] ?? NOVELAI_TEMPLATE_CONTEXT_ABSENT;
      if (!spec.values.includes(value)) {
        invalid(where, `${key} 的 ${spec.from} 值 ${value} 不在模块声明的取值内`);
      }
      values[key] = value;
      continue;
    }
    const value = (raw as Values)[key] ?? spec.default;
    if (value === undefined) invalid(where, `缺少参数 ${key}`);
    const choices = Array.isArray(value) ? value : [value];
    if (choices.some(item => typeof item !== "string" || !spec.values.includes(item))) {
      invalid(where, `${key} 仅允许 ${spec.values.join(" | ")}`);
    }
    if (spec.type === "enum") {
      if (typeof value !== "string") invalid(where, `${key} 是互斥单选，不能同时选择多个值`);
      values[key] = value;
    } else {
      if (!Array.isArray(value) || value.length < spec.min || value.length > spec.max || new Set(value).size !== value.length) {
        invalid(where, `${key} 需要 ${spec.min}–${spec.max} 个不重复选项`);
      }
      // Sets are order-independent; source declaration controls stable output.
      values[key] = spec.values.filter(item => value.includes(item));
    }
  }
  return values;
}

function selectedValues(values: Values, parameters: readonly string[]): { count: number; coverage: number } {
  const union = new Set<string>();
  let coverage = 0;
  for (const name of parameters) {
    const value = values[name];
    if (value === undefined) continue;
    const list = Array.isArray(value) ? value : [value];
    if (list.length) coverage += 1;
    // The same element selected through two groups counts once.
    for (const item of list) union.add(item);
  }
  return { count: union.size, coverage };
}

function matches(conditions: Fragment["when"], values: Values): boolean {
  return !conditions || conditions.every(rule => {
    const value = values[rule.parameter];
    return rule.in.some(option => Array.isArray(value) ? value.includes(option) : value === option);
  });
}

function intactSyntax(text: string, where: string): void {
  // One shared checker for module wording, registered short wording and legacy
  // templates, so a weight/bracket boundary can never mean two different things.
  if (!isIntactNovelAiFragmentSyntax(text)) invalid(where, "片段切断或不匹配括号/权重语法");
}

function topLevelBoundary(text: string, offset: number): boolean {
  let depth = 0, escaped = false;
  for (const char of text.slice(0, offset)) {
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (["(", "[", "{"].includes(char)) depth++;
    else if (")]}".includes(char)) depth--;
  }
  return depth === 0 && !escaped;
}

/** Only inline-code atoms in the exact section are eligible. Prose, headings,
 * instruction examples and code fences are never emitted as image prompts. */
function inlineAtoms(markdown: string, selectedHeading: string[]): string[] {
  const stack: Array<{ level: number; text: string }> = [];
  let fenced = false;
  const result: string[] = [];
  for (const line of markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const title = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (title) {
      const level = title[1]!.length;
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, text: title[2]! });
      continue;
    }
    if (JSON.stringify(stack.map(item => item.text)) === JSON.stringify(selectedHeading)) {
      for (const match of line.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) result.push(match[1]!);
    }
  }
  return result;
}

function validateModule(module: Module): void {
  const where = module.id;
  if (module.requiresFields?.length && module.scope !== "character") invalid(where, "角色输入依赖只能用于 character 模块");
  if (Object.keys(module.parameters).length > 16 || Object.keys(module.sources).length > 48) invalid(where, "参数/来源过多");
  for (const [key, spec] of Object.entries(module.parameters)) {
    if (new Set(spec.values).size !== spec.values.length) invalid(where, `${key} 选项重复`);
    if (spec.type === "set" && (spec.min > spec.max || spec.max > spec.values.length)) invalid(where, `${key} 的选择数量无效`);
    if (spec.type === "context") {
      if (module.scope !== "character") invalid(where, `${key} 的角色上下文字段不能用于 base 模块`);
      // Never accept a field name the running compiler does not actually provide.
      const domain = NOVELAI_TEMPLATE_CONTEXT_DOMAINS[spec.from];
      if (!domain) invalid(where, `${key} 引用了运行时并不认识的字段 ${spec.from}`);
      if (spec.values.some(value => value !== NOVELAI_TEMPLATE_CONTEXT_ABSENT && !domain.includes(value))) {
        invalid(where, `${key} 的选项必须来自 ${spec.from} 的实际取值`);
      }
      continue;
    }
    if (spec.default !== undefined) {
      parseValues({ ...module, parameters: { [key]: spec } }, {}, where);
    }
  }
  const byId = new Map(module.fragments.map(item => [item.id, item]));
  if (byId.size !== module.fragments.length) invalid(where, "片段 id 重复");
  for (const rule of module.limits ?? []) {
    // Only SET parameters have an unambiguous selected count; an enum value such
    // as "off" is not a selectable element and is never counted here.
    for (const name of rule.parameters) {
      const spec = module.parameters[name];
      if (!spec) invalid(where, `跨参数限制引用了未知参数 ${name}`);
      if (spec.type !== "set") invalid(where, `跨参数限制只能统计 set 参数，${name} 是 ${spec.type}`);
    }
    if (new Set(rule.parameters).size !== rule.parameters.length) invalid(where, "跨参数限制的参数重复");
    if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) invalid(where, "跨参数限制的 min 大于 max");
    const coverage = rule.coverage;
    if (coverage && coverage.min !== undefined && coverage.max !== undefined && coverage.min > coverage.max) {
      invalid(where, "跨参数覆盖限制的 min 大于 max");
    }
    if (coverage?.max !== undefined && coverage.max > rule.parameters.length) invalid(where, "跨参数覆盖上限超过参数个数");
  }
  for (const item of module.fragments) {
    if (item.compact !== "omit") continue;
    // A kept fragment may not depend on a block the Compact version drops.
    const dependents = module.fragments.filter(other => other.compact !== "omit" && (other.requires ?? []).includes(item.id));
    if (dependents.length) invalid(where, `${item.id} 是 compact 省略块，但 ${dependents.map(other => other.id).join("/")} 依赖它`);
  }
  const checkCondition = (rules: NonNullable<Fragment["when"]>, owner: string) => {
    for (const rule of rules) {
      const spec = module.parameters[rule.parameter];
      if (!spec || rule.in.some(value => !spec.values.includes(value))) invalid(where, `${owner} 条件引用了未知参数/选项`);
    }
  };
  for (const rule of module.constraints ?? []) checkCondition([...rule.when, ...rule.require], "参数约束");
  for (const rule of module.limits ?? []) checkCondition(rule.when ?? [], "跨参数限制");
  for (const rule of module.requires ?? []) checkCondition(rule.when ?? [], "模块依赖");
  for (const item of module.fragments) {
    if (!Object.hasOwn(module.sources, item.source)) invalid(where, `${item.id} 引用了未知来源 ${item.source}`);
    checkCondition([...(item.when ?? []), ...(item.requiredWhen ?? [])], item.id);
    for (const dep of item.requires ?? []) {
      const dependency = byId.get(dep);
      // Flat budget packing cannot conditionally drop a prerequisite. Require
      // dependencies to remain mandatory instead of adding a second packer.
      if (!dependency || dependency.requirement !== "required") invalid(where, `${item.id} 依赖 ${dep} 不存在或不是 required`);
    }
  }
  const done = new Set<string>(), visiting = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) invalid(where, `片段依赖循环：${key}`);
    if (done.has(key)) return;
    visiting.add(key);
    for (const dep of byId.get(key)!.requires ?? []) visit(dep);
    visiting.delete(key); done.add(key);
  };
  for (const key of byId.keys()) visit(key);
}

async function loadModule(root: string, binding: Binding, assemblyBytes: Buffer): Promise<Loaded> {
  const bytes = await boundedRead(root, binding.path);
  const module = moduleSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (module.id !== binding.id) invalid(binding.id, "绑定 id 与配置 id 不一致");
  validateModule(module);
  const sourceBytes = await boundedRead(root, binding.resource);
  if (novelAiTemplatePortableSha256(sourceBytes) !== binding.sha256) invalid(binding.id, "来源 Markdown 哈希改变，需重新核验分段");
  const markdown = sourceBytes.toString("utf8"), blocks = extractNovelAiTemplateBlocks(markdown);
  const sources = new Map<string, string>();
  for (const [key, spec] of Object.entries(module.sources)) {
    const candidates = spec.kind === "block"
      ? blocks.filter(block => block.index === spec.block && JSON.stringify(block.heading) === JSON.stringify(spec.heading)).map(block => block.text)
      : inlineAtoms(markdown, spec.heading);
    const matched = candidates.filter(text => sha256Hex(text) === spec.sha256);
    if (matched.length !== 1) invalid(binding.id, `来源 ${key} 必须精确匹配一个哈希固定片段，实际 ${matched.length} 个`);
    sources.set(key, matched[0]!);
  }
  const text = new Map<string, string>();
  const compactText = new Map<string, string>();
  for (const item of module.fragments) {
    const original = sources.get(item.source)!;
    intactSyntax(original, `${binding.id}.${item.source}`);
    let value = original;
    if (item.span) {
      const { start, end, sha256 } = item.span;
      // Source menus separate items with a comma or with a top-level line break.
      // Either is a real boundary; anything else would cut a phrase, weight group
      // or escape in half. Never compare against the final joined prompt.
      const startsAtBoundary = start === 0 || /\n\s*$/.test(original.slice(0, start)) ||
        original.slice(0, start).trimEnd().endsWith(",");
      const endsAtBoundary = end === original.length || /^\s*\n/.test(original.slice(end)) ||
        original.slice(end).trimStart().startsWith(",");
      if (end <= start || end > original.length || !startsAtBoundary || !endsAtBoundary ||
        !topLevelBoundary(original, start) || !topLevelBoundary(original, end)) {
        invalid(binding.id, `${item.id} 不是完整源片段边界；不得切开词组或权重组`);
      }
      if (original.includes("::") && (start !== 0 || end !== original.length)) {
        invalid(binding.id, `${item.id} 含双冒号复合语法，仅支持完整来源块，不猜测其内部边界`);
      }
      value = original.slice(start, end);
      if (sha256Hex(value) !== sha256) invalid(binding.id, `${item.id} 的源片段哈希不符`);
    }
    if (!value.trim() || value !== value.trim()) invalid(binding.id, `${item.id} 为空或边界有空白`);
    intactSyntax(value, `${binding.id}.${item.id}`);
    if (typeof item.compact === "object") {
      const short = item.compact.short;
      if (!short.trim() || short !== short.trim()) invalid(binding.id, `${item.id} 的 compact 短版为空或首尾有空白`);
      if (!isIntactNovelAiFragmentSyntax(short)) invalid(binding.id, `${item.id} 的 compact 短版截断了括号或权重语法`);
      if (short.length >= value.length) invalid(binding.id, `${item.id} 的 compact 短版并不比 Full 正文短；不得用同义复制冒充短版`);
      compactText.set(item.id, short);
    }
    text.set(item.id, value);
  }
  // No permanent cache: one compile has one snapshot, the next revalidates.
  if (!sourceBytes.equals(await boundedRead(root, binding.resource)) ||
    !bytes.equals(await boundedRead(root, binding.path)) || !assemblyBytes.equals(await boundedRead(root, ASSEMBLY))) {
    invalid(binding.id, "读取期间文件发生变化，请在编辑结束后重试编译");
  }
  return { module, binding, text, compact: compactText };
}

function createModuleLoader(root: string) {
  let registry: ReturnType<typeof bindings> | undefined;
  const cache = new Map<string, Promise<Loaded>>();
  const getRegistry = () => registry ??= bindings(root);
  const get = async (key: string): Promise<Loaded> => {
    const loadedRegistry = await getRegistry();
    const binding = loadedRegistry.entries.find(item => item.id === key);
    if (!binding) invalid(key, "未登记的参数化模板；不能用任意路径或回退手抄正文");
    let loading = cache.get(key);
    if (!loading) { loading = loadModule(root, binding, loadedRegistry.bytes); cache.set(key, loading); }
    return loading;
  };
  // Validate the reachable declarative graph, including currently inactive edges.
  // Parent-first order lets all parents contribute bindings before defaults apply.
  const order = async (roots: readonly string[]) => {
    const done = new Set<string>(), visiting = new Set<string>(), sorted: string[] = [];
    const visit = async (key: string): Promise<void> => {
      if (visiting.has(key)) invalid(key, `模块依赖循环：${[...visiting, key].join(" -> ")}`);
      if (done.has(key)) return;
      if (done.size + visiting.size >= 64) invalid(key, "模块依赖图超过 64 个模块");
      visiting.add(key);
      const parent = (await get(key)).module;
      for (const edge of parent.requires ?? []) {
        const child = (await get(edge.module)).module;
        const expected = edge.target === "same" ? parent.scope : edge.target === "base" ? "base" : "character";
        if (child.scope !== expected) invalid(key, `依赖 ${child.id} 的 target=${edge.target} 与作用域 ${child.scope} 不符`);
        if (edge.target === "each-character" && parent.scope !== "base") {
          invalid(key, "each-character 只允许 Base 显式声明；角色间不得自动串用");
        }
        for (const [name, value] of Object.entries(edge.values ?? {})) {
          const target = child.parameters[name];
          if (!target || target.type === "context") invalid(key, `依赖 ${child.id}.${name} 不存在或由编译器提供`);
          if (typeof value === "object" && !Array.isArray(value)) {
            const origin = parent.parameters[value.fromParameter];
            if (!origin || (origin.type === "set") !== (target.type === "set")) {
              invalid(key, `依赖 ${child.id}.${name} 的 fromParameter 不存在或类型不匹配`);
            }
          } else {
            parseValues({ ...child, parameters: { [name]: target } }, { [name]: value }, `${key} -> ${child.id}`);
          }
        }
        await visit(child.id);
      }
      visiting.delete(key); done.add(key); sorted.push(key);
    };
    for (const key of roots) await visit(key);
    return sorted.reverse();
  };
  return { getRegistry, get, order };
}

export interface NovelAiTemplateModuleScope {
  raw?: unknown;
  scope: "base" | "character";
  field: string;
  legacy?: readonly ResolvedNovelAiTemplateFragment[];
  context?: NovelAiTemplateModuleContext;
}

function moduleContextValues(context: NovelAiTemplateModuleContext = {}): Record<string, string> {
  const absent = NOVELAI_TEMPLATE_CONTEXT_ABSENT;
  return { "outfit.hosiery.color": context.hosiery?.color ?? absent,
    "outfit.hosiery.structure": context.hosiery?.structure ?? absent,
    "outfit.underwear.state": context.underwear?.state ?? absent };
}

/** Resolve every scope together: a character dependency can add a shared Base
 * module without moving character wording or choosing another card on its behalf. */
export function createNovelAiTemplateModuleResolver(root: string) {
  const loader = createModuleLoader(root);
  const resolveScopes = async (scopes: readonly NovelAiTemplateModuleScope[]): Promise<ResolvedNovelAiTemplateFragment[][]> => {
    if (scopes.filter(item => item.scope === "character").length > 6 || scopes.filter(item => item.scope === "base").length > 1) invalid("scopes", "最多一个 Base 和六个角色");
    type Selection = { id: string; values: Values; viaRequires: boolean; parents: Set<string> };
    const selected = scopes.map(input => {
      const entries = new Map<string, Selection>();
      for (const item of input.raw === undefined ? [] : inputSchema.parse(input.raw)) {
        if (entries.has(item.id)) invalid(`${input.field}.${item.id}`, "同一作用域不能重复选择模块");
        entries.set(item.id, { id: item.id, values: structuredClone(item.values ?? {}), viaRequires: false, parents: new Set() });
      }
      return entries;
    });
    const roots = selected.flatMap(entries => [...entries.keys()]);
    if (!roots.length) return scopes.map(() => []); // Preserve the no-I/O path.
    const order = await loader.order(roots);
    const sameValue = (a: string | string[], b: string | string[]) => JSON.stringify(Array.isArray(a) ? [...a].sort() : a) ===
      JSON.stringify(Array.isArray(b) ? [...b].sort() : b);
    for (const key of order) {
      const module = (await loader.get(key)).module;
      for (let index = 0; index < scopes.length; index++) {
        const item = selected[index]!.get(key);
        if (!item) continue;
        const input = scopes[index]!;
        const where = `${input.field}.${key}${item.parents.size ? `（依赖来源 ${[...item.parents].join(", ")}）` : ""}`;
        if (module.scope !== input.scope) invalid(where, `只适用于 ${module.scope}，不能装入 ${input.scope}`);
        // Missing creative choices are actionable author errors, never a reason
        // to bypass validation and emit only the unconditional fragments.
        const values = parseValues(module, item.values, where, moduleContextValues(input.context));
        for (const edge of module.requires ?? []) {
          if (!matches(edge.when, values)) continue;
          const targets = edge.target === "same" ? [index] : scopes.flatMap((scope, i) =>
            scope.scope === (edge.target === "base" ? "base" : "character") ? [i] : []);
          if (!targets.length) invalid(where, `依赖 ${edge.module} 缺少 ${edge.target} 目标作用域`);
          for (const targetIndex of targets) {
            const entries = selected[targetIndex]!;
            let target = entries.get(edge.module);
            if (!target) {
              target = { id: edge.module, values: {}, viaRequires: true, parents: new Set() };
              entries.set(edge.module, target);
              if (entries.size > 32 || selected.reduce((n, group) => n + group.size, 0) > 128) invalid(where, "展开后的模块数量超过安全上限");
            }
            const origin = `${input.field}.${key}`;
            for (const [name, source] of Object.entries(edge.values ?? {})) {
              const value = typeof source === "object" && !Array.isArray(source) ? values[source.fromParameter]! : source;
              const previous = target.values[name];
              if (previous !== undefined && !sameValue(previous, value)) {
                invalid(where, `依赖参数冲突：${scopes[targetIndex]!.field}.${edge.module}.${name}；不覆盖作者或其它父模块的选择`);
              }
              target.values[name] = structuredClone(value);
            }
            target.parents.add(origin);
          }
        }
      }
    }
    const results: ResolvedNovelAiTemplateFragment[][] = [];
    for (let i = 0; i < scopes.length; i++) {
      const input = scopes[i]!;
      results.push(await render([...selected[i]!.values()], input));
    }
    return results;
  };
  const render = async (selections: Array<NovelAiTemplateModuleInput & { viaRequires: boolean; parents: Set<string> }>,
    { scope, field, legacy = [], context = {} }: NovelAiTemplateModuleScope): Promise<ResolvedNovelAiTemplateFragment[]> => {
    if (!selections.length) return [];
    const loadedRegistry = await loader.getRegistry();
    const contextValues = moduleContextValues(context);
    const seen = new Set<string>(), groups = new Set<string>();
    const resolved: ResolvedNovelAiTemplateFragment[] = [];
    for (const selected of selections) {
      const where = `${field}.${selected.id}`;
      if (seen.has(selected.id)) invalid(where, "同一作用域不能重复选择模块");
      seen.add(selected.id);
      const binding = loadedRegistry.entries.find(item => item.id === selected.id);
      if (!binding) invalid(where, "未登记的参数化模板；不能用任意路径或回退手抄正文");
      const { module, text, compact: compactText } = await loader.get(selected.id);
      if (module.scope !== scope) invalid(where, `只适用于 ${module.scope}，不能装入 ${scope}`);
      if (legacy.some(item => item.resource === binding.resource)) invalid(where, "同一模板不能同时使用 templateFragments 与 templateModules");
      if (module.requiresFields?.includes("outfit.garments") && !context.garments?.length) {
        invalid(where, "需要明确的 outfit.garments；旧版 outfit 数组也可用，不从动作或角色名猜测衣物");
      }
      if (module.requiresFields?.includes("outfit.hosiery") && !context.hosiery) {
        invalid(where, "需要明确的 outfit.hosiery（颜色与结构），不从 garments 文本猜测丝袜材质");
      }
      if (module.exclusiveGroup) {
        if (groups.has(module.exclusiveGroup)) invalid(where, `同一作用域只能选择一种 ${module.exclusiveGroup}`);
        for (const legacyResource of new Set(legacy.map(item => item.resource))) {
          // A resource can expose several modules; check every one of them.
          for (const legacyBinding of loadedRegistry.entries.filter(entry => entry.resource === legacyResource)) {
            const legacyModule = (await loader.get(legacyBinding.id)).module;
            if (legacyModule.scope === scope && legacyModule.exclusiveGroup === module.exclusiveGroup) {
              invalid(where, `templateFragments 与 templateModules 选择了互斥的 ${module.exclusiveGroup}，请只保留一个入口`);
            }
          }
        }
        groups.add(module.exclusiveGroup);
      }
      const values = parseValues(module, selected.values, where, contextValues);
      for (const rule of module.constraints ?? []) {
        if (matches(rule.when, values) && !matches(rule.require, values)) invalid(where, rule.message);
      }
      for (const rule of module.limits ?? []) {
        if (!matches(rule.when, values)) continue;
        const { count, coverage } = selectedValues(values, rule.parameters);
        if (rule.min !== undefined && count < rule.min) invalid(where, rule.message);
        if (rule.max !== undefined && count > rule.max) invalid(where, rule.message);
        if (rule.coverage?.min !== undefined && coverage < rule.coverage.min) invalid(where, rule.message);
        if (rule.coverage?.max !== undefined && coverage > rule.coverage.max) invalid(where, rule.message);
      }
      const active = module.fragments.filter(item => matches(item.when, values));
      if (selected.parents.size && !active.length) invalid(where, "依赖模块没有激活任何片段；请检查绑定参数，不能空装配");
      for (const item of active) {
        for (const dep of item.requires ?? []) {
          if (!active.some(candidate => candidate.id === dep)) invalid(where, `${item.id} 缺少已激活依赖 ${dep}`);
        }
        const requirement = item.requirement === "required" || (item.requiredWhen && matches(item.requiredWhen, values))
          ? "required" : "optional";
        const short = compactText.get(item.id);
        resolved.push({ ref: `module:${module.id}.${item.id}`, id: `${module.id}.${item.id}`,
          resource: binding.resource, lane: item.lane, slot: scope, requirement,
          priority: item.priority ?? 100, status: "confirmed", viaRequires: selected.viaRequires,
          ...(item.compact === "omit" ? { blockVersion: "compact-omit" as const }
            : short ? { blockVersion: "compact-short" as const, compactText: short } : {}),
          text: text.get(item.id)! });
      }
    }
    return resolved;
  };
  const resolve = async (raw: unknown, scope: "base" | "character", field: string,
    legacy: readonly ResolvedNovelAiTemplateFragment[] = [], context: NovelAiTemplateModuleContext = {}) =>
    (await resolveScopes([{ raw, scope, field, legacy, context }]))[0]!;
  return Object.assign(resolve, { resolveScopes });
}

export interface NovelAiTemplateBlockVersionAudit {
  source: string;
  id: string;
  lane: string;
  slot: string;
  requirement: string;
  relation: "shared" | "compact-short" | "compact-omit";
  fullTokens: number;
  compactTokens: number;
}

/** Offline coverage audit: one row per emitted fragment, with the Full and the
 * V4.5 Compact token counts of the SAME source wording. Counts only — this never
 * returns creative text, never picks a version and never touches a browser. */
export async function auditNovelAiTemplateBlockVersions(root: string,
  countTokens: (text: string) => number | Promise<number>): Promise<NovelAiTemplateBlockVersionAudit[]> {
  const registry = await bindings(root);
  const rows: NovelAiTemplateBlockVersionAudit[] = [];
  for (const binding of registry.entries) {
    const { module, text, compact } = await loadModule(root, binding, registry.bytes);
    for (const item of module.fragments) {
      const relation = item.compact === "omit" ? "compact-omit" as const
        : compact.has(item.id) ? "compact-short" as const : "shared" as const;
      const full = text.get(item.id)!;
      const short = relation === "compact-short" ? compact.get(item.id)! : full;
      rows.push({ source: `module:${module.id}`, id: item.id, lane: item.lane, slot: module.scope,
        requirement: item.requirement, relation,
        fullTokens: await countTokens(full),
        compactTokens: relation === "compact-omit" ? 0 : await countTokens(short) });
    }
  }
  return rows;
}

/** Offline configuration acceptance; no generation, network or model calls. */
export async function validateNovelAiTemplateModules(root: string): Promise<string[]> {
  const loader = createModuleLoader(root);
  const registry = await loader.getRegistry();
  await loader.order(registry.entries.map(entry => entry.id));
  return registry.entries.map(entry => entry.id);
}

/** Reading prerequisites and assembly prerequisites are different relations.
 * Module relationships also expose the target's author contract, without asking
 * maintainers to duplicate those same edges in index.requires. Conditional edges
 * are read conservatively here; only the matching branch is assembled later. */
export async function expandNovelAiTemplateModuleResources(root: string, index: SkillResourceIndex | null,
  requested: string[]): Promise<string[]> {
  let expanded = expandSkillResources(index, requested);
  if (!expanded.some(resource => resource.startsWith("references/") && resource.endsWith(".md"))) return expanded;
  const loader = createModuleLoader(root);
  const registry = await loader.getRegistry();
  for (;;) {
    const roots = registry.entries.filter(binding => expanded.includes(binding.resource)).map(binding => binding.id);
    if (!roots.length) return expanded;
    const order = await loader.order(roots);
    const dependencies = order.map(key => registry.entries.find(entry => entry.id === key)!.resource);
    const next = expandSkillResources(index, [...expanded, ...dependencies]);
    if (next.length === expanded.length) return expanded;
    expanded = next;
  }
}

/** Lazy author contract generated from the SAME metadata as the renderer.
 * No source wording, selectors or giant combination matrix in the prompt. */
export async function describeNovelAiTemplateModules(root: string, resources?: readonly string[]) {
  const loader = createModuleLoader(root);
  const registry = await loader.getRegistry();
  const selected = resources === undefined ? registry.entries
    : registry.entries.filter(binding => resources.includes(binding.resource));
  await loader.order(selected.map(binding => binding.id));
  return Promise.all(selected.map(async binding => {
    const { module } = await loader.get(binding.id);
    const compactOmitted = module.fragments.filter(item => item.compact === "omit").map(item => item.id);
    const compactShortened = module.fragments.filter(item => typeof item.compact === "object").map(item => item.id);
    return { id: module.id, scope: module.scope, source: binding.resource,
      exclusiveGroup: module.exclusiveGroup, parameters: module.parameters,
      ...(module.requiresFields?.length ? { requiresFields: module.requiresFields } : {}),
      ...(module.constraints?.length ? { constraints: module.constraints } : {}),
      ...(module.limits?.length ? { limits: module.limits } : {}),
      ...(module.requires?.length ? { requires: module.requires } : {}),
      // Author-visible truth: these ids are used by Full and omitted by Compact;
      // these ids keep their branch but emit a registered shorter wording.
      ...(compactOmitted.length ? { compactOmitted } : {}),
      ...(compactShortened.length ? { compactShortened } : {}) };
  }));
}

/** Discovery only. Detailed contracts and source validation stay with the selected
 * resource, so reading one template cannot preload every unrelated module. */
export async function listNovelAiTemplateModules(root: string) {
  return (await bindings(root)).entries.map(binding => ({ id: binding.id, source: binding.resource }));
}
