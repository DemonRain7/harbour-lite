import { promises as fs } from "node:fs";
import path from "node:path";

export const SKILL_RESOURCE_INDEX = "references/index.json";

export interface SkillResourceEntry {
  name: string;
  path: string;
  description: string;
  use_when: string[];
  example?: string;
  requires?: string[];
}

export interface SkillResourceIndex {
  version: 1;
  /** Only shared foundations loaded with SKILL.md; conditional templates stay lazy. */
  entrypoint_requires?: string[];
  resources: SkillResourceEntry[];
}

const MAX_INDEX_BYTES = 64 * 1024;
const MAX_ENTRIES = 128;
const MAX_PATH_LENGTH = 512;
const MAX_COVERAGE_ENTRIES = 4096;
const INDEX_KEYS = new Set(["version", "entrypoint_requires", "resources"]);
const ENTRY_KEYS = new Set(["name", "path", "description", "use_when", "example", "requires"]);

function invalid(message: string): never {
  throw new Error(`skill resource index: ${message}`);
}

/** Reject aliases instead of normalizing them, so dependency and cache keys stay canonical. */
function canonicalResource(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > MAX_PATH_LENGTH
    || value !== value.trim() || /[\\:%?#<>"|*\u0000-\u001f\u007f]/.test(value)
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    invalid(`非法资源路径 (invalid resource path): ${String(value)}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."
    || segment !== segment.trim() || segment.endsWith(".")
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    invalid(`非法资源路径 (invalid resource path): ${value}`);
  }
  return value;
}

function referenceResource(value: unknown): string {
  const resource = canonicalResource(value);
  if (!resource.startsWith("references/") || resource.toLowerCase() === SKILL_RESOURCE_INDEX) {
    invalid(`indexed resources must be references/ files, not the index itself: ${resource}`);
  }
  return resource;
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

async function skillRoot(directory: string): Promise<string> {
  const root = await fs.realpath(path.resolve(directory));
  if (!(await fs.stat(root)).isDirectory()) invalid("skill directory must be a directory");
  return root;
}

async function containedTarget(root: string, resource: string): Promise<string> {
  const lexicalTarget = path.resolve(root, resource);
  if (!contained(root, lexicalTarget)) invalid(`resource escapes skill directory: ${resource}`);
  const target = await fs.realpath(lexicalTarget);
  if (!contained(root, target)) invalid(`resource escapes skill directory through a symlink: ${resource}`);
  return target;
}

async function regularFile(root: string, resource: string): Promise<string> {
  const target = await containedTarget(root, resource);
  if (!(await fs.stat(target)).isFile()) invalid(`resource must be a regular file: ${resource}`);
  return target;
}

/** Shared read boundary, including legacy SKILL.md, scripts/ and assets/ resources. */
export async function resolveSkillResourceFile(
  directory: string,
  resource: string,
): Promise<{ resource: string; target: string }> {
  const canonical = canonicalResource(resource);
  const root = await skillRoot(directory);
  return { resource: canonical, target: await regularFile(root, canonical) };
}

function object(value: unknown, label: string, allowed: Set<string>): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  const unknown = Object.keys(result).filter((key) => !allowed.has(key));
  if (unknown.length) invalid(`${label} has unknown fields: ${unknown.join(", ")}`);
  return result;
}

function shortText(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()
    || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) {
    invalid(`${label} must be nonempty single-line text of at most ${limit} characters`);
  }
  return value;
}

function parseIndex(value: unknown): SkillResourceIndex {
  const index = object(value, "index", INDEX_KEYS);
  if (index.version !== 1) invalid("version must be 1");
  if (!Array.isArray(index.resources) || index.resources.length > MAX_ENTRIES) {
    invalid(`resources must be an array of at most ${MAX_ENTRIES} entries`);
  }
  const names = new Set<string>();
  const paths = new Set<string>();
  const resources = index.resources.map((value, position): SkillResourceEntry => {
    const label = `resources[${position}]`;
    const entry = object(value, label, ENTRY_KEYS);
    const name = shortText(entry.name, `${label}.name`, 80);
    const resource = referenceResource(entry.path);
    if (names.has(name)) invalid(`duplicate name: ${name}`);
    // A transferable catalog must not name the same Windows file twice with different casing.
    if (paths.has(resource.toLowerCase())) invalid(`duplicate path: ${resource}`);
    names.add(name);
    paths.add(resource.toLowerCase());
    if (!Array.isArray(entry.use_when) || entry.use_when.length < 1 || entry.use_when.length > 8) {
      invalid(`${label}.use_when must contain 1–8 short triggers`);
    }
    const result: SkillResourceEntry = {
      name,
      path: resource,
      description: shortText(entry.description, `${label}.description`, 240),
      use_when: entry.use_when.map((text) => shortText(text, `${label}.use_when item`, 240)),
    };
    if (entry.example !== undefined) result.example = shortText(entry.example, `${label}.example`, 320);
    if (entry.requires !== undefined) {
      if (!Array.isArray(entry.requires) || entry.requires.length > MAX_ENTRIES) {
        invalid(`${label}.requires must be an array of at most ${MAX_ENTRIES} paths`);
      }
      result.requires = entry.requires.map(referenceResource);
      if (new Set(result.requires).size !== result.requires.length) invalid(`${label}.requires has duplicate paths`);
    }
    return result;
  });
  const result: SkillResourceIndex = { version: 1, resources };
  if (index.entrypoint_requires !== undefined) {
    if (!Array.isArray(index.entrypoint_requires) || index.entrypoint_requires.length > 16) {
      invalid("entrypoint_requires must be an array of at most 16 indexed paths");
    }
    result.entrypoint_requires = index.entrypoint_requires.map(referenceResource);
    if (new Set(result.entrypoint_requires).size !== result.entrypoint_requires.length) {
      invalid("entrypoint_requires has duplicate paths");
    }
    const catalogPaths = new Set(resources.map((entry) => entry.path));
    for (const required of result.entrypoint_requires) {
      if (!catalogPaths.has(required)) invalid(`dangling entrypoint dependency: ${required}`);
    }
  }
  // Validate the complete graph once, but never use this list as the runtime read selection.
  expandSkillResources(result, resources.map((entry) => entry.path), MAX_ENTRIES);
  // The read tool adds the directory itself: foundations + SKILL.md must leave one slot.
  if (result.entrypoint_requires?.length) expandSkillResources(result, ["SKILL.md"], 15);
  return result;
}

async function checkReferenceCoverage(root: string, index: SkillResourceIndex): Promise<void> {
  const indexed = new Set(index.resources.map((entry) => entry.path));
  let visited = 0;
  async function walk(resource: string, ancestors: Set<string>): Promise<void> {
    const target = await containedTarget(root, resource);
    if (ancestors.has(target)) invalid(`cyclic reference directory symlink: ${resource}`);
    const nextAncestors = new Set(ancestors).add(target);
    if (nextAncestors.size > 64) invalid("reference coverage exceeds maximum directory depth (64)");
    // Stream directory entries so the validation cap also bounds traversal memory.
    const entries = await fs.opendir(target);
    for await (const entry of entries) {
      if (++visited > MAX_COVERAGE_ENTRIES) invalid(`reference coverage exceeds ${MAX_COVERAGE_ENTRIES} entries`);
      const child = canonicalResource(`${resource}/${entry.name}`);
      const childTarget = await containedTarget(root, child);
      const stat = await fs.stat(childTarget);
      if (stat.isDirectory()) {
        await walk(child, nextAncestors);
      } else if (/\.md$/i.test(entry.name)) {
        if (!stat.isFile()) invalid(`reference must be a regular file: ${child}`);
        if (!indexed.has(child)) invalid(`orphan reference Markdown is not indexed: ${child}`);
      }
    }
  }
  await walk("references", new Set());
}

/** Read bounded metadata only. Absence is compatible with skills that predate catalogs. */
export async function loadSkillResourceIndex(
  directory: string,
  opts: { checkCoverage?: boolean } = {},
): Promise<SkillResourceIndex | null> {
  const root = await skillRoot(directory);
  try {
    // lstat distinguishes an absent optional index from an existing broken symlink.
    await fs.lstat(path.join(root, SKILL_RESOURCE_INDEX));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const target = await regularFile(root, SKILL_RESOURCE_INDEX);
  const handle = await fs.open(target, "r");
  let parsed: unknown;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) invalid("index must be a regular file");
    if (stat.size > MAX_INDEX_BYTES) invalid(`index exceeds ${MAX_INDEX_BYTES} bytes (64 KiB)`);
    // A bounded read also protects against growth after stat; no reference body is read here.
    const buffer = Buffer.alloc(MAX_INDEX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > MAX_INDEX_BYTES) invalid(`index exceeds ${MAX_INDEX_BYTES} bytes (64 KiB)`);
    try {
      parsed = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    } catch {
      invalid("index must contain valid JSON");
    }
  } finally {
    await handle.close();
  }
  const index = parseIndex(parsed);
  for (const entry of index.resources) await regularFile(root, entry.path);
  if (opts.checkCoverage) await checkReferenceCoverage(root, index);
  return index;
}

/** Dependency-first, stable selection; non-indexed legacy paths remain explicit reads. */
export function expandSkillResources(
  index: SkillResourceIndex | null,
  requested: string[],
  maxResources = 16,
): string[] {
  if (!Number.isInteger(maxResources) || maxResources < 1 || maxResources > MAX_ENTRIES) {
    invalid(`maxResources must be an integer between 1 and ${MAX_ENTRIES}`);
  }
  const byPath = new Map(index?.resources.map((entry) => [entry.path, entry]) ?? []);
  const exactPaths = new Map(index?.resources.map((entry) => [entry.path.toLowerCase(), entry.path]) ?? []);
  const selected: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (value: string): void => {
    const resource = canonicalResource(value);
    const exactPath = index && resource.toLowerCase() === "skill.md"
      ? "SKILL.md" : exactPaths.get(resource.toLowerCase());
    // Windows accepts casing aliases on disk; they must not bypass catalog dependencies.
    if (exactPath !== undefined && exactPath !== resource) {
      invalid(`catalog path casing mismatch: ${resource}; use exact catalog path ${exactPath}`);
    }
    if (done.has(resource)) return;
    if (visiting.has(resource)) invalid(`dependency cycle includes: ${resource}`);
    visiting.add(resource);
    const dependencies = resource === "SKILL.md"
      ? index?.entrypoint_requires ?? [] : byPath.get(resource)?.requires ?? [];
    for (const dependency of dependencies) {
      if (!byPath.has(dependency)) invalid(`dangling dependency ${dependency} required by ${resource}`);
      visit(dependency);
    }
    visiting.delete(resource);
    done.add(resource);
    selected.push(resource);
    if (selected.length > maxResources) invalid(`expanded resources exceed limit ${maxResources}; narrow the selection`);
  };
  for (const resource of requested) visit(resource);
  return selected;
}
