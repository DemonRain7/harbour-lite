import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Fixed template fragments are referenced, never copied: the registry stores a
 * heading/block selector plus content hashes, so editing a template body can only
 * invalidate the reference, never silently relocate it to another paragraph. */
export type NovelAiTemplateFragmentLane = "positive" | "negative";
export type NovelAiTemplateFragmentSlot = "base" | "character";
export type NovelAiTemplateFragmentRequirement = "required" | "optional";
export type NovelAiTemplateFragmentStatus = "confirmed" | "pending_confirmation";

/** Registered Full / V4.5-Compact relation of one emitted source.
 *  "keep"           both versions emit the same wording (already minimal);
 *  "omit"           a reviewed extension block the Compact version leaves out;
 *  { short }        a reviewed shorter wording the Compact version emits instead.
 * Every source that can reach a NovelAI form must declare one of these. */
export type NovelAiTemplateFragmentCompact = "keep" | "omit" | { short: string };

export interface NovelAiTemplateFragmentDefinition {
  id: string;
  heading: string[];
  block: number;
  fence?: string;
  compact: NovelAiTemplateFragmentCompact;
  lane: NovelAiTemplateFragmentLane;
  slot: NovelAiTemplateFragmentSlot;
  requirement: NovelAiTemplateFragmentRequirement;
  /** Only meaningful for optional fragments; lower is tried first. */
  priority?: number;
  requires?: string[];
  /** "selectable" blocks are menus: a caller may pick one item with `id#index`. */
  items?: "atomic" | "selectable";
  selection: "author" | "compiler";
  compiledBy?: string;
  status?: NovelAiTemplateFragmentStatus;
  reason?: string;
}

export interface NovelAiTemplateResourceEntry {
  path: string;
  class: "A" | "B" | "C" | "D";
  sha256: string;
  /** Cross-checkout content digest: CRLF pairs become LF, all other bytes stay. */
  portableSha256?: string;
  fragments: NovelAiTemplateFragmentDefinition[];
  /** Opt-in parameter modules bound to this existing source; not another catalog.
   * A resource whose wording spans two scopes may declare one module per scope. */
  parameterization?: { id: string; path: string } | Array<{ id: string; path: string }>;
}

export interface NovelAiTemplateFragmentRegistry {
  schemaVersion: 1;
  /** Absent means legacy raw-byte sha256 verification. Never infer the policy. */
  hashPolicy?: "sha256-lf-v1";
  policy: string;
  resources: NovelAiTemplateResourceEntry[];
}

export interface NovelAiTemplateBlock {
  heading: string[];
  index: number;
  fence: string;
  text: string;
}

export interface ResolvedNovelAiTemplateFragment {
  /** The exact request token, including any `#item` suffix. */
  ref: string;
  id: string;
  resource: string;
  lane: NovelAiTemplateFragmentLane;
  slot: NovelAiTemplateFragmentSlot;
  requirement: NovelAiTemplateFragmentRequirement;
  priority: number;
  status: NovelAiTemplateFragmentStatus;
  text: string;
  /** True only when this entry was pulled in as a declared dependency. */
  viaRequires: boolean;
  /** Which block version carries this fragment. "shared" is used by the Full
   * (no reference) and the Compact (actual reference) assembly; "compact-omit"
   * is a reviewed extension block that V4.5 deliberately leaves out;
   * "compact-short" carries a reviewed shorter wording in `compactText`. */
  blockVersion?: "shared" | "compact-omit" | "compact-short";
  /** Present only for "compact-short": the registered Compact wording. The Full
   * wording stays in `text` and is never replaced in the Full assembly. */
  compactText?: string;
}

export const NOVELAI_TEMPLATE_ASSEMBLY_FILE = "references/assembly.json";
export const NOVELAI_TEMPLATE_POLICY = "novelai-template-fragments-v1";

const RESOURCE_PATH = /^references\/[A-Za-z0-9][A-Za-z0-9._\/-]*\.md$/;
const FRAGMENT_ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;

function stripByteOrderMark(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

/** True when brackets, weights and escapes are balanced and no phrase, weight
 * group or escape was cut in half. Shared by every registered wording source. */
export function isIntactNovelAiFragmentSyntax(value: string): boolean {
  const stack: string[] = [];
  let escaped = false;
  for (const char of value) {
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (["(", "[", "{"].includes(char)) stack.push(char);
    else if (")]}".includes(char)) {
      const expected: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
      if (stack.pop() !== expected[char]) return false;
    }
  }
  return !escaped && !stack.length;
}

export function novelAiTemplateCanonicalText(body: string): string {
  return stripByteOrderMark(body).replace(/\r\n?/g, "\n").split("\n").map(line => line.trim()).join("\n").trim();
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Portability is ONLY CRLF -> LF. Unlike prompt canonicalization, this preserves
 * spaces, BOM, isolated CR, invalid UTF-8 bytes and terminal blank lines. */
export function novelAiTemplatePortableSha256(value: string | Buffer): string {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const hash = createHash("sha256");
  let start = 0;
  for (let index = 0; index + 1 < bytes.length; index++) {
    if (bytes[index] !== 13 || bytes[index + 1] !== 10) continue;
    hash.update(bytes.subarray(start, index));
    start = index + 1;
  }
  return hash.update(bytes.subarray(start)).digest("hex");
}

/** All fenced blocks keyed by their exact heading path. Indented fences count:
 * several template blocks live inside list items. */
export function extractNovelAiTemplateBlocks(markdown: string): NovelAiTemplateBlock[] {
  const lines = stripByteOrderMark(markdown).replace(/\r\n?/g, "\n").split("\n");
  const stack: Array<{ level: number; text: string }> = [];
  const blocks: NovelAiTemplateBlock[] = [];
  const seen = new Map<string, number>();
  let open: { fence: string; line: number } | undefined;
  for (const [position, line] of lines.entries()) {
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      if (open) {
        const heading = stack.map(item => item.text);
        const key = JSON.stringify(heading);
        const index = seen.get(key) ?? 0;
        seen.set(key, index + 1);
        blocks.push({ heading, index, fence: open.fence,
          text: novelAiTemplateCanonicalText(lines.slice(open.line + 1, position).join("\n")) });
        open = undefined;
      } else open = { fence: fence[1]!.trim(), line: position };
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (!heading) continue;
    const level = heading[1]!.length;
    while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, text: heading[2]! });
  }
  if (open) throw new Error("模板 Markdown 存在未闭合的代码围栏，无法确定片段边界");
  return blocks;
}

/** Top-level split of a source menu into its items. Weights, escapes and bracket
 * groups stay intact, and a line break is a separator only at top level, so the
 * count matches the tags the author sees in the template file. The split is
 * verified to tile the source: every item appears in order and only separators
 * sit between them, so a lossy split can never be offered. */
export function splitNovelAiTemplateItems(text: string): string[] | undefined {
  const items: string[] = [];
  let current = "";
  let depth = 0;
  let escaped = false;
  const separator = (character: string) => character === "," || character === "\n";
  for (const character of text) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\") { current += character; escaped = true; continue; }
    if (character === "(" || character === "{" || character === "[") depth += 1;
    else if (character === ")" || character === "}" || character === "]") depth = Math.max(0, depth - 1);
    if (depth === 0 && separator(character)) { items.push(current); current = ""; continue; }
    current += character;
  }
  items.push(current);
  const cleaned = items.map(item => item.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!cleaned.length) return undefined;
  const flatText = text.replace(/\s+/g, " ").trim();
  let cursor = 0;
  for (const item of cleaned) {
    const at = flatText.indexOf(item, cursor);
    if (at < 0 || /[^\s,]/.test(flatText.slice(cursor, at))) return undefined;
    cursor = at + item.length;
  }
  return /[^\s,]/.test(flatText.slice(cursor)) ? undefined : cleaned;
}
export interface LoadedNovelAiTemplateFragmentRegistry {
  registry: NovelAiTemplateFragmentRegistry;
  root: string;
  blocks: Map<string, NovelAiTemplateBlock[]>;
  byId: Map<string, { definition: NovelAiTemplateFragmentDefinition; resource: string; text: string }>;
  /** Observed raw bytes for local before/after audits; not a portable baseline. */
  rawHashes: Map<string, string>;
}

// Share only in-flight reads. A resolved registry must never stay trusted forever:
// files can be changed in a running server, even preserving both mtime and size.
const registryLoads = new Map<string, Promise<LoadedNovelAiTemplateFragmentRegistry>>();
type RegistrySnapshot = { active: boolean; loading?: Promise<LoadedNovelAiTemplateFragmentRegistry> };
const registrySnapshots = new AsyncLocalStorage<Map<string, RegistrySnapshot>>();

/** One compilation uses one lazy validated snapshot across Base and characters.
 * No requested fragments => no file reads. The next compilation always rechecks
 * content. A failed load is not pinned, so repair + explicit retry can recover. */
export async function withNovelAiTemplateFragmentSnapshot<T>(root: string, run: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(root);
  const current = registrySnapshots.getStore();
  if (current?.get(resolved)?.active) return run();
  const scope = new Map(current);
  const snapshot: RegistrySnapshot = { active: true };
  scope.set(resolved, snapshot);
  try { return await registrySnapshots.run(scope, run); }
  finally {
    // Detached async callbacks inherit ALS too; they must not retain trust after
    // the owning compilation has finished.
    snapshot.active = false;
    snapshot.loading = undefined;
  }
}

export function clearNovelAiTemplateFragmentCache(root?: string): void {
  if (root) {
    const resolved = path.resolve(root);
    registryLoads.delete(resolved);
    const scoped = registrySnapshots.getStore()?.get(resolved);
    if (scoped) scoped.loading = undefined;
  } else {
    registryLoads.clear();
    for (const scoped of registrySnapshots.getStore()?.values() ?? []) scoped.loading = undefined;
  }
}

function definitionError(resource: string, id: string, message: string): Error {
  return new Error(`模板装配元数据 ${NOVELAI_TEMPLATE_ASSEMBLY_FILE} 中 ${resource} 的片段 ${id} ${message}`);
}

/** Revalidate on every independent load; only an explicit compilation snapshot
 * reuses a successful read. No network/model calls or prompt rewriting. */
export async function loadNovelAiTemplateFragmentRegistry(root: string,
  options: { allowUnpinnedHashes?: boolean } = {}): Promise<LoadedNovelAiTemplateFragmentRegistry> {
  const resolved = path.resolve(root);
  if (options.allowUnpinnedHashes) return readNovelAiTemplateFragmentRegistry(resolved, options);
  const candidate = registrySnapshots.getStore()?.get(resolved);
  const scoped = candidate?.active ? candidate : undefined;
  if (scoped?.loading) return scoped.loading;
  let loading = registryLoads.get(resolved);
  if (!loading) {
    loading = readNovelAiTemplateFragmentRegistry(resolved, options);
    registryLoads.set(resolved, loading);
    // Identity check: clearing an older read must not evict a newer in-flight read.
    const release = () => { if (registryLoads.get(resolved) === loading) registryLoads.delete(resolved); };
    void loading.then(release, release);
  }
  if (scoped) {
    scoped.loading = loading;
    void loading.catch(() => { if (scoped.loading === loading) scoped.loading = undefined; });
  }
  return loading;
}

/** Offline coverage audit for the legacy templateFragments entry: one row per
 * registered fragment with its Full / Compact token counts. Counts only. */
export async function auditNovelAiTemplateFragmentVersions(root: string,
  countTokens: (text: string) => number | Promise<number>) {
  const loaded = await loadNovelAiTemplateFragmentRegistry(root);
  const rows: Array<{ source: string; id: string; lane: string; slot: string; requirement: string;
    relation: "shared" | "compact-short" | "compact-omit"; fullTokens: number; compactTokens: number }> = [];
  for (const [id, entry] of loaded.byId) {
    const definition = entry.definition;
    const relation = definition.compact === "omit" ? "compact-omit" as const
      : typeof definition.compact === "object" ? "compact-short" as const : "shared" as const;
    const short = relation === "compact-short" ? (definition.compact as { short: string }).short : entry.text;
    rows.push({ source: `legacy:${entry.resource}`, id, lane: definition.lane, slot: definition.slot,
      requirement: definition.requirement, relation,
      fullTokens: await countTokens(entry.text),
      compactTokens: relation === "compact-omit" ? 0 : await countTokens(short) });
  }
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

async function readNovelAiTemplateFragmentRegistry(root: string,
  options: { allowUnpinnedHashes?: boolean }): Promise<LoadedNovelAiTemplateFragmentRegistry> {
  const file = path.join(root, NOVELAI_TEMPLATE_ASSEMBLY_FILE);
  let parsed: unknown;
  let metadata: Buffer;
  try { metadata = await readFile(file); parsed = JSON.parse(metadata.toString("utf8")); }
  catch (error) {
    throw new Error(`无法读取模板装配元数据 ${NOVELAI_TEMPLATE_ASSEMBLY_FILE}：${error instanceof Error ? error.message : String(error)}`);
  }
  const registry = parsed as NovelAiTemplateFragmentRegistry;
  if (!registry || typeof registry !== "object" || registry.schemaVersion !== 1 ||
    typeof registry.policy !== "string" || !Array.isArray(registry.resources)) {
    throw new Error(`模板装配元数据 ${NOVELAI_TEMPLATE_ASSEMBLY_FILE} 结构无效：需要 schemaVersion 1 与 resources 数组`);
  }
  if (registry.hashPolicy !== undefined && registry.hashPolicy !== "sha256-lf-v1") {
    throw new Error(`模板装配元数据 hashPolicy 无效：${String(registry.hashPolicy)}`);
  }
  const blocks = new Map<string, NovelAiTemplateBlock[]>();
  const byId = new Map<string, { definition: NovelAiTemplateFragmentDefinition; resource: string; text: string }>();
  const rawHashes = new Map<string, string>();
  const paths = new Set<string>();
  for (const resource of registry.resources) {
    if (!resource || typeof resource.path !== "string" || !RESOURCE_PATH.test(resource.path) || resource.path.includes("..")) {
      throw new Error(`模板装配元数据中的资源路径无效：${String(resource?.path)}`);
    }
    if (paths.has(resource.path)) throw new Error(`模板装配元数据重复登记资源：${resource.path}`);
    paths.add(resource.path);
    if (!["A", "B", "C", "D"].includes(resource.class)) throw definitionError(resource.path, "-", `的 class 无效：${String(resource.class)}`);
    if (!Array.isArray(resource.fragments)) throw definitionError(resource.path, "-", "缺少 fragments 数组");
    const bytes = await readFile(path.join(root, resource.path));
    rawHashes.set(resource.path, sha256Hex(bytes));
    const portable = registry.hashPolicy === "sha256-lf-v1";
    const expected = portable ? resource.portableSha256 : resource.sha256;
    for (const field of ["sha256", "portableSha256"] as const) {
      const digest = resource[field];
      if (digest !== undefined && digest !== "" && (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))) {
        throw definitionError(resource.path, "-", `的 ${field} 不是有效的 SHA-256`);
      }
    }
    if ((!resource.sha256 || !expected) && !options.allowUnpinnedHashes) {
      throw definitionError(resource.path, "-", "未固定文件哈希；正文可能已被改动");
    }
    const digest = portable ? novelAiTemplatePortableSha256(bytes) : rawHashes.get(resource.path)!;
    if (expected && expected !== digest) {
      throw new Error(`模板正文已变化：${resource.path} 的实际哈希 ${digest} 与登记值 ${expected} 不一致；` +
        "旧片段引用已失效，必须重新核对并重新固定，不得静默沿用。");
    }
    const extracted = extractNovelAiTemplateBlocks(bytes.toString("utf8"));
    blocks.set(resource.path, extracted);
    for (const fragment of resource.fragments) {
      validateDefinition(resource.path, fragment);
      if (byId.has(fragment.id)) throw definitionError(resource.path, fragment.id, "与其它资源中的片段 id 重复");
      if (fragment.selection === "author") {
        const block = extracted.find(item => item.index === fragment.block &&
          item.heading.length === fragment.heading.length && item.heading.every((value, at) => value === fragment.heading[at]));
        if (!block) throw definitionError(resource.path, fragment.id,
          `的选择器无法定位片段：找不到标题路径 [${fragment.heading.join(" > ")}] 下的第 ${fragment.block} 个代码块`);
        if (fragment.fence !== undefined && fragment.fence !== block.fence) {
          throw definitionError(resource.path, fragment.id, `登记的围栏类型 ${fragment.fence} 与实际 ${block.fence} 不一致`);
        }
        if (fragment.items === "selectable" && !splitNovelAiTemplateItems(block.text)) {
          throw definitionError(resource.path, fragment.id, "声明为可按项选择，但该片段无法在不破坏加权/括号语法的前提下切开");
        }
        assertCompactShortIsShorter(resource.path, fragment, block.text);
        byId.set(fragment.id, { definition: fragment, resource: resource.path, text: block.text });
        continue;
      }
      const block = extracted.find(item => item.index === fragment.block &&
        item.heading.length === fragment.heading.length && item.heading.every((value, at) => value === fragment.heading[at]));
      if (!block) throw definitionError(resource.path, fragment.id,
        `的选择器无法定位片段：找不到标题路径 [${fragment.heading.join(" > ")}] 下的第 ${fragment.block} 个代码块`);
      assertCompactShortIsShorter(resource.path, fragment, block.text);
      byId.set(fragment.id, { definition: fragment, resource: resource.path, text: block.text });
    }
  }
  for (const [id, entry] of byId) {
    for (const dependency of entry.definition.requires ?? []) {
      if (!byId.has(dependency)) throw definitionError(entry.resource, id, `依赖了未登记的片段 ${dependency}`);
      const required = byId.get(dependency)!;
      if (required.definition.requirement !== "required") {
        throw definitionError(entry.resource, id, `依赖的片段 ${dependency} 必须是 required，不能依赖可被预算省略的 optional 片段`);
      }
      if (required.definition.slot !== entry.definition.slot) {
        throw definitionError(entry.resource, id, `依赖的片段 ${dependency} 必须具有相同作用域，不能跨 base/character 装配`);
      }
      if (required.definition.compact === "omit" && entry.definition.compact !== "omit") {
        throw definitionError(entry.resource, id, `依赖的片段 ${dependency} 是 compact 省略块，两版都无法保证该依赖`);
      }
    }
  }
  assertNoRequirementCycle(byId);
  if (!metadata.equals(await readFile(file))) {
    throw new Error(`模板装配元数据 ${NOVELAI_TEMPLATE_ASSEMBLY_FILE} 在校验期间发生变化；请在编辑完成后重新校验`);
  }
  return { registry, root, blocks, byId, rawHashes };
}

/** A registered short wording must actually be shorter than the source wording it
 * replaces; a same-length rephrasing would be a second, drifting truth. */
function assertCompactShortIsShorter(resource: string, fragment: NovelAiTemplateFragmentDefinition, fullText: string): void {
  if (typeof fragment.compact !== "object") {
    if (fragment.compact === "omit" && fullText.length === 0) throw definitionError(resource, fragment.id, "的 compact 省略块没有正文");
    return;
  }
  if (fragment.compact.short.length >= fullText.length) {
    throw definitionError(resource, fragment.id, "的 compact 短版并不比 Full 正文短；不得用同义复制冒充短版");
  }
}

function validateDefinition(resource: string, fragment: NovelAiTemplateFragmentDefinition): void {
  if (!fragment || typeof fragment.id !== "string" || !FRAGMENT_ID.test(fragment.id)) {
    throw definitionError(resource, String(fragment?.id), "的 id 必须是 <资源名>.<片段名> 形式的小写标识");
  }
  if (!Array.isArray(fragment.heading) || !fragment.heading.length || fragment.heading.some(value => typeof value !== "string" || !value.trim())) {
    throw definitionError(resource, fragment.id, "的 heading 必须是非空标题字符串数组");
  }
  if (!Number.isInteger(fragment.block) || fragment.block < 0) throw definitionError(resource, fragment.id, "的 block 必须是非负整数");
  if (!["positive", "negative"].includes(fragment.lane)) throw definitionError(resource, fragment.id, `的 lane 无效：${String(fragment.lane)}`);
  if (!["base", "character"].includes(fragment.slot)) throw definitionError(resource, fragment.id, `的 slot 无效：${String(fragment.slot)}`);
  if (!["required", "optional"].includes(fragment.requirement)) {
    throw definitionError(resource, fragment.id, `的 requirement 无效：${String(fragment.requirement)}`);
  }
  if (!["author", "compiler"].includes(fragment.selection)) throw definitionError(resource, fragment.id, `的 selection 无效：${String(fragment.selection)}`);
  if (fragment.selection === "compiler" && (fragment.requirement !== "required" || !fragment.compiledBy)) {
    throw definitionError(resource, fragment.id, "由编译器持有的片段必须登记为 required 并写明 compiledBy");
  }
  if (fragment.priority !== undefined && (!Number.isInteger(fragment.priority) || fragment.priority < 0)) {
    throw definitionError(resource, fragment.id, "的 priority 必须是非负整数");
  }
  if (fragment.items !== undefined && !["atomic", "selectable"].includes(fragment.items)) {
    throw definitionError(resource, fragment.id, `的 items 无效：${String(fragment.items)}`);
  }
  if (fragment.status !== undefined && !["confirmed", "pending_confirmation"].includes(fragment.status)) {
    throw definitionError(resource, fragment.id, `的 status 无效：${String(fragment.status)}`);
  }
  if (fragment.status === "pending_confirmation" && fragment.requirement !== "required") {
    throw definitionError(resource, fragment.id, "尚待确认的片段必须保留为 required，不能按 optional 自动省略");
  }
  if (fragment.requires !== undefined && (!Array.isArray(fragment.requires) || fragment.requires.some(value => typeof value !== "string"))) {
    throw definitionError(resource, fragment.id, "的 requires 必须是片段 id 数组");
  }
  const compact = fragment.compact;
  if (compact === undefined || compact === null || typeof compact !== "object" && compact !== "keep" && compact !== "omit") {
    throw definitionError(resource, fragment.id, `必须显式登记 compact 关系：keep | omit | { short }；当前 ${JSON.stringify(compact)}`);
  }
  if (compact === "keep" || compact === "omit") return;
  if (typeof compact !== "object" || Array.isArray(compact) || Object.keys(compact).length !== 1 || typeof compact.short !== "string") {
    throw definitionError(resource, fragment.id, "的 compact 短版必须写作 { short: \"…\" }，不接受其它字段");
  }
  const short = compact.short;
  if (!short.trim() || short !== short.trim()) throw definitionError(resource, fragment.id, "的 compact 短版为空或首尾有空白");
  if (short.length > 600) throw definitionError(resource, fragment.id, "的 compact 短版超过 600 字符");
  if (!isIntactNovelAiFragmentSyntax(short)) throw definitionError(resource, fragment.id, "的 compact 短版截断了括号或权重语法");
}

function assertNoRequirementCycle(byId: Map<string, { definition: NovelAiTemplateFragmentDefinition; resource: string }>): void {
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, trail: string[]): void => {
    const status = state.get(id);
    if (status === "done") return;
    if (status === "visiting") throw definitionError(byId.get(id)!.resource, id, `存在依赖循环：${[...trail, id].join(" -> ")}`);
    state.set(id, "visiting");
    for (const dependency of byId.get(id)!.definition.requires ?? []) visit(dependency, [...trail, id]);
    state.set(id, "done");
  };
  for (const id of byId.keys()) visit(id, []);
}

const requestPattern = /^([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*)(?:#([0-9]{1,2}))?$/;

/** Resolves author-requested fragment ids (with optional menu item index) into
 * fixed text. Every failure mode is an explicit field error, never a fallback. */
export async function resolveNovelAiTemplateFragments(requests: unknown, scope: NovelAiTemplateFragmentSlot,
  root: string, field: string): Promise<ResolvedNovelAiTemplateFragment[]> {
  if (requests === undefined) return [];
  if (!Array.isArray(requests) || requests.length > 32 || requests.some(value => typeof value !== "string" || !value.trim())) {
    throw new Error(`${field} 必须是至多 32 项的非空字符串数组`);
  }
  if (!requests.length) return [];
  const loaded = await loadNovelAiTemplateFragmentRegistry(root);
  const resolved: ResolvedNovelAiTemplateFragment[] = [];
  const seen = new Set<string>();
  const resolveOne = (reference: string, viaRequires: boolean): void => {
    const token = reference.trim();
    if (seen.has(token)) return;
    seen.add(token);
    const match = requestPattern.exec(token);
    if (!match) throw new Error(`${field}: 片段引用 ${token} 格式无效，应为 <资源名>.<片段名>[#序号]`);
    const id = match[1]!;
    const itemIndex = match[2] === undefined ? undefined : Number(match[2]);
    const entry = loaded.byId.get(id);
    if (!entry) throw new Error(`${field}: 未登记的模板片段 ${id}；不要手抄模板正文，只能引用 ${NOVELAI_TEMPLATE_ASSEMBLY_FILE} 中登记的片段`);
    const { definition } = entry;
    if (definition.selection === "compiler") {
      throw new Error(`${field}: ${id} 由编译器按结构化字段自动装配（${definition.compiledBy ?? "编译器"}），不需要也不允许手工登记`);
    }
    if (definition.slot !== scope) {
      throw new Error(`${field}: ${id} 的作用域是 ${definition.slot}，不能放进 ${scope} 字段`);
    }
    const items = definition.items === "selectable" ? splitNovelAiTemplateItems(entry.text) : undefined;
    if (itemIndex !== undefined) {
      if (!items) throw new Error(`${field}: ${id} 是完整片段，不支持 #序号，请整块引用`);
      if (itemIndex >= items.length) throw new Error(`${field}: ${id}#${itemIndex} 超出范围，该片段只有 ${items.length} 项可选`);
    }
    // A single menu item is already the minimal expression of that item, so a
    // whole-block short version never applies to a `#index` selection.
    // An explicit `#index` selection is an author requirement for that one item,
    // so neither a whole-block short wording nor a whole-block omit applies.
    const short = itemIndex === undefined && typeof definition.compact === "object"
      ? definition.compact.short : undefined;
    const omit = itemIndex === undefined && definition.compact === "omit";
    resolved.push({ ref: token, id, resource: entry.resource, lane: definition.lane, slot: definition.slot,
      requirement: definition.requirement, priority: definition.priority ?? 100,
      status: definition.status ?? "confirmed", viaRequires,
      ...(omit ? { blockVersion: "compact-omit" as const }
        : short ? { blockVersion: "compact-short" as const, compactText: short } : {}),
      text: itemIndex === undefined ? entry.text : items![itemIndex]! });
    for (const dependency of definition.requires ?? []) resolveOne(dependency, true);
  };
  for (const request of requests as string[]) resolveOne(request, false);
  return resolved;
}

/** Diagnostics-only projection: ids, scopes and counts, never creative text. */
export function summarizeNovelAiTemplateFragments(fragments: readonly ResolvedNovelAiTemplateFragment[]): Array<{
  ref: string; resource: string; lane: string; slot: string; requirement: string; status: string;
}> {
  return fragments.map(fragment => ({ ref: fragment.ref, resource: fragment.resource, lane: fragment.lane,
    slot: fragment.slot, requirement: fragment.requirement, status: fragment.status }));
}
