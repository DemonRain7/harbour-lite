import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { unescapeNovelAiTagParentheses } from "./novelAiCharacterTag";

export type NovelAiReferencePolicy = "none" | "required";

export interface NovelAiCharacterProfile {
  schemaVersion: 1;
  id: string;
  displayName: string;
  source: string;
  aliases: string[];
  referencePolicy: NovelAiReferencePolicy;
  novelai: {
    tag: string;
    positiveAnchors: string[];
    negativeAnchors: string[];
  };
  reference?: { file: string; files?: never } | { files: string[]; file?: never };
}

export interface NovelAiCharacterIndex {
  schemaVersion: 1;
  aliases: Record<string, string>;
}

export interface NovelAiCharacterReference {
  id: string;
  handle: string;
  name: string;
  filePath: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  kind: "png" | "jpeg" | "webp";
  size: number;
  sha256: string;
}

export interface NovelAiCharacterRoute {
  query: string;
  found: boolean;
  fallback: "normal-generation";
  id?: string;
  displayName?: string;
  source?: string;
  /** Optional lazy guidance path; its body is never included in the resolver response. */
  notesResource?: string;
  referencePolicy?: NovelAiReferencePolicy;
  novelai?: NovelAiCharacterProfile["novelai"];
  reference?: {
    required: boolean;
    available: boolean;
    handle?: string;
    name?: string;
    mime?: NovelAiCharacterReference["mime"];
    size?: number;
    reason?: "missing" | "invalid";
  };
}

const PROFILE_NAME = "profile.json";
const INDEX_NAME = "index.json";
const SOURCE_NAME = "source.json";
const HANDLE_PREFIX = "novelai-character";
const DEFAULT_MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const MAX_CHARACTERS = 10_000;
const MAX_REFERENCE_FILES = 8;

export function defaultNovelAiCharacterLibraryDir(): string {
  return path.resolve(process.cwd(), "workflows", "novelai-generation", "assets", "character-library");
}

/** 与角色库构建脚本共用；索引 key 不进入 prompt，只在本机确定性匹配。 */
export function normalizeNovelAiCharacterName(value: string): string {
  return unescapeNovelAiTagParentheses(value)
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[\s_\-‐‑‒–—―·・'’"“”()[\]{}]+/gu, "");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  if (value.length > max) throw new Error(`${label} 超过 ${max} 字符`);
  return value.trim();
}

function stringList(value: unknown, label: string, maxItems: number, maxItemLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} 必须是至多 ${maxItems} 项的数组`);
  return value.map((entry, index) => stringValue(entry, `${label}[${index}]`, maxItemLength));
}

function safeCharacterId(value: unknown): string {
  const id = stringValue(value, "profile.id", 80);
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) {
    throw new Error("profile.id 只允许小写字母、数字和短横线");
  }
  return id;
}

function safeReferenceFile(value: unknown, label = "profile.reference.file"): string {
  const file = stringValue(value, label, 128);
  if (path.basename(file) !== file || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(file)
    || file.endsWith(".") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(file)) {
    throw new Error(`${label} 只能是角色目录内的单个安全文件名`);
  }
  return file;
}

function parseReference(row: Record<string, unknown>): NonNullable<NovelAiCharacterProfile["reference"]> {
  const hasFile = Object.hasOwn(row, "file");
  const hasFiles = Object.hasOwn(row, "files");
  if (hasFile === hasFiles) throw new Error("profile.reference.file 与 files 必须且只能提供一个");
  if (hasFile) return { file: safeReferenceFile(row.file) };
  if (!Array.isArray(row.files) || row.files.length < 1 || row.files.length > MAX_REFERENCE_FILES) {
    throw new Error(`profile.reference.files 必须包含 1–${MAX_REFERENCE_FILES} 个文件名`);
  }
  const files = row.files.map((file, index) => safeReferenceFile(file, `profile.reference.files[${index}]`));
  if (new Set(files.map(file => file.toLowerCase())).size !== files.length) {
    throw new Error("profile.reference.files 不得包含重复文件名（不区分大小写）");
  }
  return { files };
}

function referenceFiles(profile: NovelAiCharacterProfile): string[] {
  if (profile.referencePolicy !== "required" || !profile.reference) {
    throw new Error(`角色「${profile.id}」没有 required 参考图`);
  }
  return profile.reference.file !== undefined ? [profile.reference.file] : profile.reference.files;
}

function parseProfile(raw: unknown, expectedId?: string): NovelAiCharacterProfile {
  const row = record(raw, "profile");
  if (row.schemaVersion !== 1) throw new Error("profile.schemaVersion 必须为 1");
  const id = safeCharacterId(row.id);
  if (expectedId && id !== expectedId) throw new Error(`profile.id「${id}」与目录「${expectedId}」不一致`);
  const policy = row.referencePolicy;
  if (policy !== "none" && policy !== "required") {
    throw new Error("profile.referencePolicy 只能是 none 或 required");
  }
  const novelai = record(row.novelai, "profile.novelai");
  const referenceRow = row.reference === undefined ? undefined : record(row.reference, "profile.reference");
  if (policy === "none" && referenceRow !== undefined) {
    throw new Error("referencePolicy=none 时不得配置运行时参考图");
  }
  if (policy === "required" && referenceRow === undefined) {
    throw new Error("referencePolicy=required 时必须配置 reference.file 或 reference.files");
  }
  return {
    schemaVersion: 1,
    id,
    displayName: stringValue(row.displayName, "profile.displayName", 160),
    source: stringValue(row.source, "profile.source", 240),
    aliases: stringList(row.aliases, "profile.aliases", 64, 160),
    referencePolicy: policy,
    novelai: {
      tag: stringValue(novelai.tag, "profile.novelai.tag", 300),
      positiveAnchors: stringList(novelai.positiveAnchors, "profile.novelai.positiveAnchors", 48, 180),
      negativeAnchors: stringList(novelai.negativeAnchors, "profile.novelai.negativeAnchors", 48, 180),
    },
    ...(referenceRow ? { reference: parseReference(referenceRow) } : {}),
  };
}

function parseIndex(raw: unknown): NovelAiCharacterIndex {
  const row = record(raw, "character index");
  if (row.schemaVersion !== 1) throw new Error("character index.schemaVersion 必须为 1");
  const aliasesRaw = record(row.aliases, "character index.aliases");
  const entries = Object.entries(aliasesRaw);
  if (entries.length > MAX_CHARACTERS * 64) throw new Error("character index.aliases 过大");
  const aliases: Record<string, string> = {};
  for (const [alias, rawId] of entries) {
    const normalized = normalizeNovelAiCharacterName(alias);
    if (!normalized || normalized !== alias) throw new Error(`character index 含未规范化 alias：${alias}`);
    aliases[alias] = safeCharacterId(rawId);
  }
  return { schemaVersion: 1, aliases };
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function imageKind(bytes: Buffer): NovelAiCharacterReference["kind"] | null {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

function mimeFor(kind: NovelAiCharacterReference["kind"]): NovelAiCharacterReference["mime"] {
  return kind === "png" ? "image/png" : kind === "jpeg" ? "image/jpeg" : "image/webp";
}

async function readIndex(libraryDir: string): Promise<NovelAiCharacterIndex> {
  const raw = JSON.parse(await fs.readFile(path.join(libraryDir, INDEX_NAME), "utf8")) as unknown;
  return parseIndex(raw);
}

async function readProfile(libraryDir: string, id: string): Promise<NovelAiCharacterProfile> {
  const raw = JSON.parse(await fs.readFile(path.join(libraryDir, id, PROFILE_NAME), "utf8")) as unknown;
  return parseProfile(raw, id);
}

async function characterNotesResource(libraryDir: string, id: string): Promise<string | undefined> {
  try {
    const root = await fs.realpath(path.resolve(libraryDir));
    const directory = await fs.realpath(path.join(root, id));
    if (!isInside(directory, root)) return undefined;
    const notes = await fs.realpath(path.join(directory, "notes.md"));
    if (!isInside(notes, root) || !isInside(notes, directory) || !(await fs.stat(notes)).isFile()) return undefined;
    return `assets/character-library/${id}/notes.md`;
  } catch {
    // Optional guidance cannot block identity routing, and inaccessible/outside paths
    // are not advertised as resources for a later read.
    return undefined;
  }
}

async function materializeReference(
  libraryDir: string,
  profile: NovelAiCharacterProfile,
  file: string,
  maxBytes: number
): Promise<NovelAiCharacterReference> {
  const absoluteRoot = path.resolve(libraryDir);
  const realRoot = await fs.realpath(absoluteRoot).catch(() => absoluteRoot);
  const candidate = path.resolve(absoluteRoot, profile.id, file);
  const resolved = await fs.realpath(candidate);
  if (!isInside(resolved, realRoot)) throw new Error("角色参考图越出角色库根目录");
  const info = await fs.stat(resolved);
  if (!info.isFile() || info.size <= 0 || info.size > maxBytes) {
    throw new Error(`角色参考图必须是 1–${Math.floor(maxBytes / 1024 / 1024)}MB 的普通文件`);
  }
  const bytes = await fs.readFile(resolved);
  const kind = imageKind(bytes);
  if (!kind) throw new Error("角色参考图签名不是 PNG/JPEG/WebP");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    id: profile.id,
    handle: `${HANDLE_PREFIX}:${profile.id}:${sha256}`,
    name: `${profile.id}-${file}`,
    filePath: resolved,
    mime: mimeFor(kind),
    kind,
    size: info.size,
    sha256,
  };
}

export async function resolveNovelAiCharacter(
  libraryDir: string,
  query: string,
  maxReferenceBytes = DEFAULT_MAX_REFERENCE_BYTES,
  selectionKey?: string,
): Promise<NovelAiCharacterRoute> {
  const normalized = normalizeNovelAiCharacterName(query);
  if (!normalized) return { query, found: false, fallback: "normal-generation" };
  const index = await readIndex(libraryDir);
  const id = index.aliases[normalized];
  if (!id) return { query, found: false, fallback: "normal-generation" };
  const profile = await readProfile(libraryDir, id);
  const notesResource = await characterNotesResource(libraryDir, id);
  if (profile.referencePolicy === "none") {
    return {
      query,
      found: true,
      fallback: "normal-generation",
      id,
      displayName: profile.displayName,
      source: profile.source,
      ...(notesResource ? { notesResource } : {}),
      referencePolicy: "none",
      novelai: profile.novelai,
      reference: { required: false, available: false },
    };
  }
  // Choose exactly once. A missing/invalid selected image is unavailable, not an
  // invitation to silently choose a different appearance for this request.
  // A workflow key makes recompilation stable across retries and character aliases.
  const files = referenceFiles(profile);
  const selection = files.length === 1 ? 0 : selectionKey === undefined
    ? Math.floor(Math.random() * files.length)
    : createHash("sha256").update(JSON.stringify([selectionKey, profile.id])).digest().readUInt32BE(0) % files.length;
  const selectedFile = files[selection]!;
  try {
    const reference = await materializeReference(libraryDir, profile, selectedFile, maxReferenceBytes);
    return {
      query,
      found: true,
      fallback: "normal-generation",
      id,
      displayName: profile.displayName,
      source: profile.source,
      ...(notesResource ? { notesResource } : {}),
      referencePolicy: "required",
      novelai: profile.novelai,
      reference: {
        required: true,
        available: true,
        handle: reference.handle,
        name: reference.name,
        mime: reference.mime,
        size: reference.size,
      },
    };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    return {
      query,
      found: true,
      fallback: "normal-generation",
      id,
      displayName: profile.displayName,
      source: profile.source,
      ...(notesResource ? { notesResource } : {}),
      referencePolicy: "required",
      novelai: profile.novelai,
      reference: { required: true, available: false, reason: missing ? "missing" : "invalid" },
    };
  }
}

/** 浏览器只接受 resolver 返回的内容寻址句柄；永远不接受模型提供的路径。 */
export async function resolveNovelAiReferenceHandle(
  libraryDir: string,
  handle: string,
  maxReferenceBytes = DEFAULT_MAX_REFERENCE_BYTES
): Promise<NovelAiCharacterReference> {
  const match = handle.match(/^novelai-character:([a-z0-9][a-z0-9-]{0,79}):([a-f0-9]{64})$/);
  if (!match?.[1] || !match[2]) throw new Error("角色参考图句柄格式无效");
  const id = match[1];
  const expectedHash = match[2];
  const index = await readIndex(libraryDir);
  if (!Object.values(index.aliases).includes(id)) throw new Error("角色参考图句柄不属于当前薄索引");
  const profile = await readProfile(libraryDir, id);
  // A frozen handle resolves by content, never by another random selection.
  // Unrelated candidates may be missing; only the exact authorized hash can win.
  for (const file of referenceFiles(profile)) {
    let reference: NovelAiCharacterReference;
    try { reference = await materializeReference(libraryDir, profile, file, maxReferenceBytes); }
    catch { continue; }
    if (reference.sha256 === expectedHash && reference.handle === handle) return reference;
  }
  throw new Error("角色参考图已发生变化、缺失或不再授权；不能替换已冻结的参考图，请先核对原请求");
}

/** 从每个 profile 的 aliases 生成薄索引；profile 是角色数据的唯一事实源。 */
export async function rebuildNovelAiCharacterIndex(
  libraryDir: string,
  options: { write?: boolean; maxReferenceBytes?: number } = {}
): Promise<NovelAiCharacterIndex> {
  const entries = await fs.readdir(libraryDir, { withFileTypes: true });
  const aliases = new Map<string, string>();
  let count = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const profile = await readProfile(libraryDir, entry.name);
    count += 1;
    if (count > MAX_CHARACTERS) throw new Error(`角色数量超过 ${MAX_CHARACTERS}`);
    if (profile.referencePolicy === "required") {
      for (const file of referenceFiles(profile)) {
        await materializeReference(libraryDir, profile, file, options.maxReferenceBytes ?? DEFAULT_MAX_REFERENCE_BYTES);
      }
      const sourcePath = path.join(libraryDir, profile.id, SOURCE_NAME);
      record(JSON.parse(await fs.readFile(sourcePath, "utf8")) as unknown, `${profile.id}/${SOURCE_NAME}`);
    }
    const candidateAliases = [profile.id, profile.displayName, ...profile.aliases];
    for (const rawAlias of candidateAliases) {
      const alias = normalizeNovelAiCharacterName(rawAlias);
      if (!alias) throw new Error(`角色「${profile.id}」包含空 alias`);
      const previous = aliases.get(alias);
      if (previous && previous !== profile.id) {
        throw new Error(`角色 alias 冲突：「${rawAlias}」同时指向 ${previous} 与 ${profile.id}`);
      }
      aliases.set(alias, profile.id);
    }
  }
  const sortedAliases = Object.fromEntries([...aliases.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const index: NovelAiCharacterIndex = { schemaVersion: 1, aliases: sortedAliases };
  if (options.write) {
    await fs.writeFile(path.join(libraryDir, INDEX_NAME), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }
  return index;
}
