import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { requestPolicy, type NovelAiRequestPolicy } from "./workflows/novelAiBudget";
import { novelAiContentRating, type NovelAiContentRating } from "./workflows/novelAiSfwAuthoring";

export const DELEGATION_TASK_MAX_BYTES = 128 * 1024;
export const DELEGATION_TASK_MAX_SNAPSHOTS = 64;
export const DELEGATION_TASK_LIST_LIMIT = 12;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const TASK_REF = /^dgt-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const INPUT_REF = /^wfi-[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
// Shared across instances: each mutation reloads the latest record while holding this
// server-process lock. This store is not a multi-process/distributed database.
const scopeLocks = new Map<string, Promise<void>>();

export interface DelegationInputSnapshot {
  value: Record<string, unknown>;
  byteLength: number;
  parts: number;
}

export interface DelegationTaskDraft {
  workflow: string;
  inputRef: string;
  byteLength: number;
  parts: number;
  sha256: string;
  createdAt: string;
}

export interface DelegationWorkflowResult {
  workflow: string;
  action: string;
  result: Record<string, unknown>;
  updatedAt: string;
}

export interface DelegationTask {
  ref: string;
  agent: string;
  originalInput: string;
  executionIntent?: "prompt" | "generate" | "readiness";
  novelAiContentRating?: NovelAiContentRating;
  novelAiPolicy?: NovelAiRequestPolicy;
  followups?: string[];
  result?: string;
  status: "open" | "completed";
  revision: number;
  createdAt: string;
  updatedAt: string;
  drafts: DelegationTaskDraft[];
  /** Current editable head, separate from immutable snapshots and execution receipts. */
  draftHeads?: Record<string, { inputRef: string; revision: number }>;
  workflowResults: DelegationWorkflowResult[];
}

export interface DelegationTaskSummary {
  ref: string;
  agent: string;
  status: "open" | "completed";
  revision: number;
  createdAt: string;
  updatedAt: string;
  resultAvailable: boolean;
  latestDrafts: DelegationTaskDraft[];
  workflowResults: Array<Pick<DelegationWorkflowResult, "workflow" | "action" | "updatedAt">>;
}

interface TaskEnvelope {
  version: 1;
  scopeHash: string;
  operationKeyHash?: string;
  task: DelegationTask;
  integrity: string;
}

interface SnapshotEnvelope extends DelegationInputSnapshot {
  version: 1;
  scopeHash: string;
  taskRef: string;
  workflow: string;
  inputRef: string;
  integrity: string;
}

function fail(message: string): never { throw new Error(`Delegation task: ${message}`); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function string(value: unknown, field: string, max = 256, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || Buffer.byteLength(value, "utf8") > max) {
    fail(`${field} must be ${empty ? "a" : "a non-empty"} string of at most ${max} bytes`);
  }
  return value;
}
function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail(`invalid ${field}`);
  return value;
}
function date(value: unknown, field: string): string {
  const result = string(value, field, 32);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) fail(`invalid ${field}`);
  return result;
}

/** Strict, canonical JSON without invoking accessors/toJSON or accepting mutable aliases. */
function canonicalClone(value: unknown, depth = 0, ancestors = new Set<object>(), maxDepth = 64): unknown {
  if (depth > maxDepth) fail(`JSON nesting exceeds ${maxDepth} levels`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("JSON numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") fail("only JSON values are supported");
  if (ancestors.has(value)) fail("cyclic JSON is not supported");
  if (Object.getOwnPropertySymbols(value).length) fail("symbol keys are not JSON");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) fail("non-JSON object instance");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).filter((key) => !(Array.isArray(value) && key === "length"));
  if (keys.length > 32768) fail("too many JSON members");
  if (Array.isArray(value) && (value.length > 32768 || keys.length !== value.length)) fail("sparse or oversized array");
  ancestors.add(value);
  try {
    const output: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {};
    for (const key of keys.sort()) {
      if (FORBIDDEN_KEYS.has(key)) fail("prototype-related keys are forbidden");
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !("value" in descriptor)) fail("getters and hidden properties are not JSON");
      if (Array.isArray(output)) {
        if (!/^(0|[1-9][0-9]*)$/.test(key) || !Array.isArray(value) || Number(key) >= value.length) fail("non-index array property");
        output[Number(key)] = canonicalClone(descriptor.value, depth + 1, ancestors, maxDepth);
      } else output[key] = canonicalClone(descriptor.value, depth + 1, ancestors, maxDepth);
    }
    return output;
  } finally { ancestors.delete(value); }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalClone(value, 0, new Set(), 128))).digest("hex");
}
function jsonObject(value: unknown, field: string): Record<string, unknown> {
  const cloned = canonicalClone(value);
  if (!object(cloned)) fail(`${field} must be a JSON object`);
  if (Buffer.byteLength(JSON.stringify(cloned), "utf8") > DELEGATION_TASK_MAX_BYTES) fail(`${field} exceeds 128 KiB`);
  return cloned;
}
function scopeDigest(scope: string): string {
  return digest(["harbour-delegation-scope-v1", string(scope, "trusted scope", 16 * 1024)]);
}
function taskRef(value: string): string {
  if (typeof value !== "string" || !TASK_REF.test(value)) fail("invalid taskRef");
  return value;
}
function inputRef(value: string): string {
  if (typeof value !== "string" || !INPUT_REF.test(value)) fail("invalid inputRef");
  return value;
}
function deterministicRef(scopeHash: string, operationKeyHash: string): string {
  const bytes = Buffer.from(digest(["harbour-delegation-ref-v1", scopeHash, operationKeyHash]), "hex").subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `dgt-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }

/** Disk paths derive only from trusted root + scope hashes + validated opaque references.
 * Checksums detect corruption/swapped records; they are not authentication against a
 * process that already has arbitrary write access to this private storage directory.
 */
export class DelegationTaskStore {
  private readonly rootDir: string;

  constructor(rootDir: string) { this.rootDir = path.resolve(string(rootDir, "storage root", 32 * 1024)); }

  private directory(scopeHash: string): string { return path.join(this.rootDir, scopeHash); }
  private taskFile(scopeHash: string, ref: string): string { return path.join(this.directory(scopeHash), `${taskRef(ref)}.json`); }
  private snapshotFile(scopeHash: string, ref: string, workflow: string, preparedRef: string): string {
    return path.join(this.directory(scopeHash), "inputs", taskRef(ref), `${digest([workflow, inputRef(preparedRef)])}.json`);
  }

  private async withLock<T>(scopeHash: string, action: () => Promise<T>): Promise<T> {
    const directory = this.directory(scopeHash);
    const key = process.platform === "win32" ? directory.toLowerCase() : directory;
    const previous = scopeLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    scopeLocks.set(key, current);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (scopeLocks.get(key) === current) scopeLocks.delete(key);
    }
  }

  private async safeDirectory(directory: string, create: boolean): Promise<void> {
    // The constructor root is supplied by the server, never by a model. Reject links
    // in the storage tree so a stale/symlinked scope cannot redirect a write.
    const relative = path.relative(this.rootDir, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative)) fail("storage path escaped root");
    const directories = [this.rootDir];
    for (const part of relative.split(path.sep).filter(Boolean)) directories.push(path.join(directories.at(-1)!, part));
    for (const entry of directories) {
      if (create) await fs.mkdir(entry, { recursive: entry === this.rootDir }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      });
      const stat = await fs.lstat(entry);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("storage directory must not be a symbolic link");
    }
  }

  private async readJson(file: string): Promise<unknown> {
    await this.safeDirectory(path.dirname(file), false);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) fail("invalid or oversized storage record");
    const raw = await fs.readFile(file, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) fail("oversized storage record");
    try { return canonicalClone(JSON.parse(raw), 0, new Set(), 128); }
    catch { fail("corrupt storage record"); }
  }

  private async atomicWrite(file: string, value: unknown): Promise<void> {
    const raw = JSON.stringify(canonicalClone(value, 0, new Set(), 128));
    if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) fail("storage record limit exceeded");
    await this.safeDirectory(path.dirname(file), true);
    const existing = await fs.lstat(file).catch((error: unknown) => { if (!isMissing(error)) throw error; return undefined; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) fail("storage file must not be a symbolic link");
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(raw, "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      await fs.rename(temporary, file);
    }
    finally { await fs.unlink(temporary).catch((error: unknown) => { if (!isMissing(error)) throw error; }); }
    // POSIX directory sync makes the rename durable. Windows does not provide the
    // same directory-handle operation, but the file was flushed before rename.
    if (process.platform !== "win32") {
      const directory = await fs.open(path.dirname(file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }

  private validateTask(value: unknown, scopeHash: string, ref: string): TaskEnvelope {
    if (!object(value) || value.version !== 1 || value.scopeHash !== scopeHash || !object(value.task)) fail("task scope or format mismatch");
    const { integrity, ...body } = value;
    if (typeof integrity !== "string" || integrity !== digest(body)) fail("task integrity mismatch");
    if (value.operationKeyHash !== undefined && (typeof value.operationKeyHash !== "string" || !SHA256.test(value.operationKeyHash))) fail("invalid operation key hash");
    const row = value.task;
    if (row.ref !== ref || !TASK_REF.test(String(row.ref))) fail("task reference mismatch");
    string(row.agent, "agent"); string(row.originalInput, "originalInput", DELEGATION_TASK_MAX_BYTES, true);
    if (row.executionIntent !== undefined && !["prompt", "generate", "readiness"].includes(String(row.executionIntent))) fail("invalid executionIntent");
    novelAiContentRating(row.novelAiContentRating);
    if (row.novelAiPolicy !== undefined) {
      if (!object(row.novelAiPolicy)) fail("invalid novelAiPolicy");
      requestPolicy(row.novelAiPolicy);
    }
    if (row.followups !== undefined) {
      if (!Array.isArray(row.followups) || row.followups.length > 64 || Buffer.byteLength(JSON.stringify(row.followups)) > DELEGATION_TASK_MAX_BYTES) fail("invalid followups");
      for (const input of row.followups) string(input, "followup", DELEGATION_TASK_MAX_BYTES, true);
    }
    if (row.result !== undefined) string(row.result, "result", DELEGATION_TASK_MAX_BYTES, true);
    if (row.status !== "open" && row.status !== "completed") fail("invalid task status");
    integer(row.revision, "revision", 1, Number.MAX_SAFE_INTEGER);
    const createdAt = date(row.createdAt, "createdAt");
    if (date(row.updatedAt, "updatedAt") < createdAt) fail("task timestamps are inconsistent");
    if (!Array.isArray(row.drafts) || row.drafts.length > DELEGATION_TASK_MAX_SNAPSHOTS) fail("invalid task drafts");
    const seen = new Set<string>();
    for (const draft of row.drafts) {
      if (!object(draft)) fail("invalid draft");
      const workflow = string(draft.workflow, "workflow"); inputRef(draft.inputRef as string);
      integer(draft.byteLength, "snapshot byteLength", 0, DELEGATION_TASK_MAX_BYTES);
      integer(draft.parts, "snapshot parts", 1, DELEGATION_TASK_MAX_SNAPSHOTS); date(draft.createdAt, "draft createdAt");
      if (typeof draft.sha256 !== "string" || !SHA256.test(draft.sha256)) fail("invalid snapshot integrity");
      const key = JSON.stringify([workflow, draft.inputRef]);
      if (seen.has(key)) fail("duplicate snapshot reference");
      seen.add(key);
    }
    if (!Array.isArray(row.workflowResults) || row.workflowResults.length > DELEGATION_TASK_MAX_SNAPSHOTS) fail("invalid workflow results");
    if (row.draftHeads !== undefined) {
      if (!object(row.draftHeads)) fail("invalid draft heads");
      for (const [workflow, head] of Object.entries(row.draftHeads)) {
        if (!object(head)) fail("invalid draft head");
        inputRef(head.inputRef as string); integer(head.revision, "draft revision", 1, Number.MAX_SAFE_INTEGER);
        if (!row.drafts.some(draft => object(draft) && draft.workflow === workflow && draft.inputRef === head.inputRef)) fail("draft head snapshot missing");
      }
    }
    const workflows = new Set<string>();
    for (const result of row.workflowResults) {
      if (!object(result)) fail("invalid workflow result");
      const workflow = string(result.workflow, "workflow");
      if (workflows.has(workflow)) fail("duplicate workflow result");
      workflows.add(workflow); string(result.action, "action"); date(result.updatedAt, "workflow updatedAt");
      jsonObject(result.result, "workflow result");
    }
    if (value.operationKeyHash && deterministicRef(scopeHash, value.operationKeyHash as string) !== ref) fail("operation reference mismatch");
    return value as unknown as TaskEnvelope;
  }

  private async readTask(scopeHash: string, ref: string): Promise<TaskEnvelope> {
    try { return this.validateTask(await this.readJson(this.taskFile(scopeHash, ref)), scopeHash, ref); }
    catch (error) { if (isMissing(error)) fail("task not found in this scope"); throw error; }
  }

  private async saveTask(envelope: TaskEnvelope): Promise<void> {
    const { integrity: _old, ...body } = envelope;
    envelope.integrity = digest(body);
    this.validateTask(envelope, envelope.scopeHash, envelope.task.ref);
    await this.atomicWrite(this.taskFile(envelope.scopeHash, envelope.task.ref), envelope);
  }

  private async mutate(scope: string, ref: string, mutation: (task: DelegationTask, scopeHash: string) => Promise<boolean> | boolean): Promise<DelegationTask> {
    const scopeHash = scopeDigest(scope); taskRef(ref);
    return this.withLock(scopeHash, async () => {
      const envelope = await this.readTask(scopeHash, ref);
      if (await mutation(envelope.task, scopeHash)) {
        envelope.task.revision++;
        envelope.task.updatedAt = new Date(Math.max(Date.now(), Date.parse(envelope.task.updatedAt) + 1)).toISOString();
        await this.saveTask(envelope);
      }
      return structuredClone(envelope.task);
    });
  }

  async create(scope: string, input: { agent: string; input: string; operationKey?: string; executionIntent?: "prompt" | "generate" | "readiness"; novelAiPolicy?: NovelAiRequestPolicy; novelAiContentRating?: NovelAiContentRating }): Promise<DelegationTask> {
    const scopeHash = scopeDigest(scope);
    const contentRating = novelAiContentRating(input.novelAiContentRating);
    const agent = string(input.agent, "agent");
    const originalInput = string(input.input, "input", DELEGATION_TASK_MAX_BYTES, true);
    const operationKeyHash = input.operationKey === undefined ? undefined : digest(string(input.operationKey, "operationKey", 16 * 1024));
    const ref = operationKeyHash ? deterministicRef(scopeHash, operationKeyHash) : `dgt-${randomUUID()}`;
    return this.withLock(scopeHash, async () => {
      let existing: TaskEnvelope | undefined;
      try { existing = this.validateTask(await this.readJson(this.taskFile(scopeHash, ref)), scopeHash, ref); }
      catch (error) { if (!isMissing(error)) throw error; }
      if (existing) {
        if (existing.operationKeyHash !== operationKeyHash || existing.task.agent !== agent || existing.task.originalInput !== originalInput || existing.task.executionIntent !== input.executionIntent || existing.task.novelAiContentRating !== contentRating || digest(existing.task.novelAiPolicy ?? {}) !== digest(input.novelAiPolicy ?? {})) fail("operationKey conflicts with immutable original task");
        return structuredClone(existing.task);
      }
      const now = new Date().toISOString();
      const task: DelegationTask = { ref, agent, originalInput, ...(input.executionIntent ? { executionIntent: input.executionIntent } : {}),
        ...(contentRating ? { novelAiContentRating: contentRating } : {}),
        ...(input.novelAiPolicy ? { novelAiPolicy: requestPolicy({ ...input.novelAiPolicy }) } : {}), status: "open", revision: 1, createdAt: now, updatedAt: now, drafts: [], workflowResults: [] };
      await this.saveTask({ version: 1, scopeHash, ...(operationKeyHash ? { operationKeyHash } : {}), task, integrity: "" });
      return structuredClone(task);
    });
  }

  async get(scope: string, ref: string): Promise<DelegationTask> {
    return structuredClone((await this.readTask(scopeDigest(scope), taskRef(ref))).task);
  }

  async findByOperation(scope: string, operationKey: string): Promise<DelegationTask | undefined> {
    const scopeHash = scopeDigest(scope);
    const hash = digest(string(operationKey, "operationKey", 16 * 1024));
    const ref = deterministicRef(scopeHash, hash);
    try { return structuredClone(this.validateTask(await this.readJson(this.taskFile(scopeHash, ref)), scopeHash, ref).task); }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
  }

  async list(scope: string, filter?: { status?: "open" | "completed"; agents?: readonly string[]; hasDrafts?: boolean }): Promise<DelegationTaskSummary[]> {
    const scopeHash = scopeDigest(scope);
    return this.withLock(scopeHash, async () => {
      let files: string[];
      try { await this.safeDirectory(this.directory(scopeHash), false); files = await fs.readdir(this.directory(scopeHash)); }
      catch (error) { if (isMissing(error)) return []; throw error; }
      const tasks: DelegationTask[] = [];
      for (const file of files) if (file.endsWith(".json") && TASK_REF.test(file.slice(0, -5))) tasks.push((await this.readTask(scopeHash, file.slice(0, -5))).task);
      return tasks.filter((task) => (!filter?.status || task.status === filter.status) &&
        (!filter?.agents || filter.agents.includes(task.agent)) &&
        (filter?.hasDrafts === undefined || (task.drafts.length > 0) === filter.hasDrafts))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.ref.localeCompare(a.ref)).slice(0, DELEGATION_TASK_LIST_LIMIT).map((task) => ({
        ref: task.ref, agent: task.agent, status: task.status, revision: task.revision,
        createdAt: task.createdAt, updatedAt: task.updatedAt, resultAvailable: task.result !== undefined,
        latestDrafts: [...new Map(task.drafts.map((draft) => [draft.workflow, draft])).values()],
        workflowResults: task.workflowResults.map(({ workflow, action, updatedAt }) => ({ workflow, action, updatedAt })),
      }));
    });
  }

  async update(scope: string, ref: string, update: { result?: string; status?: "open" | "completed" }): Promise<DelegationTask> {
    const patch = canonicalClone(update);
    if (!object(patch) || Object.keys(patch).some((key) => !["result", "status"].includes(key))) fail("only result and status can be updated; original task is immutable");
    if (Object.hasOwn(patch, "result")) string(patch.result, "result", DELEGATION_TASK_MAX_BYTES, true);
    if (Object.hasOwn(patch, "status") && patch.status !== "open" && patch.status !== "completed") fail("invalid status");
    return this.mutate(scope, ref, (task) => {
      let changed = false;
      if (typeof patch.result === "string" && patch.result !== task.result) { task.result = patch.result; changed = true; }
      if ((patch.status === "open" || patch.status === "completed") && patch.status !== task.status) { task.status = patch.status; changed = true; }
      return changed;
    });
  }

  /** Keep accepted task amendments even if the next model stops before a tool call. */
  async updateNovelAiPolicy(scope: string, ref: string, policy: NovelAiRequestPolicy): Promise<DelegationTask> {
    const next = requestPolicy({ ...policy });
    return this.mutate(scope, ref, task => {
      if (digest(task.novelAiPolicy ?? {}) === digest(next)) return false;
      task.novelAiPolicy = next;
      return true;
    });
  }

  async recordFollowup(scope: string, ref: string, input: string): Promise<DelegationTask> {
    string(input, "followup", DELEGATION_TASK_MAX_BYTES, true);
    return this.mutate(scope, ref, (task) => {
      if (task.followups?.at(-1) === input) return false;
      const followups = [...(task.followups ?? []), input];
      if (followups.length > 64 || Buffer.byteLength(JSON.stringify(followups)) > DELEGATION_TASK_MAX_BYTES) fail("followup history exceeds task limit");
      task.followups = followups;
      return true;
    });
  }

  async saveInput(scope: string, ref: string, workflow: string, preparedRef: string, snapshot: DelegationInputSnapshot): Promise<DelegationTaskDraft> {
    workflow = string(workflow, "workflow"); preparedRef = inputRef(preparedRef);
    const value = jsonObject(snapshot.value, "snapshot");
    const byteLength = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (snapshot.byteLength !== byteLength) fail("snapshot byteLength integrity mismatch");
    const parts = integer(snapshot.parts, "snapshot parts", 1, DELEGATION_TASK_MAX_SNAPSHOTS);
    const task = await this.mutate(scope, ref, async (current, scopeHash) => {
      const body = { version: 1 as const, scopeHash, taskRef: ref, workflow, inputRef: preparedRef, value, byteLength, parts };
      const integrity = digest(body);
      const existing = current.drafts.find((draft) => draft.workflow === workflow && draft.inputRef === preparedRef);
      if (existing && existing.sha256 !== integrity) fail("prepared snapshot is immutable");
      if (!existing && current.drafts.length >= DELEGATION_TASK_MAX_SNAPSHOTS) fail("task already contains 64 input snapshots");
      const file = this.snapshotFile(scopeHash, ref, workflow, preparedRef);
      let stored: unknown;
      try { stored = await this.readJson(file); } catch (error) { if (!isMissing(error)) throw error; }
      if (stored !== undefined && digest(stored) !== digest({ ...body, integrity })) fail("snapshot storage integrity mismatch");
      if (existing && stored === undefined) fail("acknowledged snapshot is missing");
      if (stored === undefined) await this.atomicWrite(file, { ...body, integrity });
      if (existing) return false;
      current.drafts.push({ workflow, inputRef: preparedRef, byteLength, parts, sha256: integrity, createdAt: new Date().toISOString() });
      return true;
    });
    return task.drafts.find((draft) => draft.workflow === workflow && draft.inputRef === preparedRef)!;
  }

  async getInput(scope: string, ref: string, workflow: string, preparedRef: string): Promise<DelegationInputSnapshot> {
    const scopeHash = scopeDigest(scope); taskRef(ref);
    workflow = string(workflow, "workflow"); preparedRef = inputRef(preparedRef);
    const task = (await this.readTask(scopeHash, ref)).task;
    const draft = task.drafts.find((entry) => entry.workflow === workflow && entry.inputRef === preparedRef);
    if (!draft) fail("inputRef not found in this task/Workflow/scope");
    let stored: unknown;
    try { stored = await this.readJson(this.snapshotFile(scopeHash, ref, workflow, preparedRef)); }
    catch (error) { if (isMissing(error)) fail("acknowledged snapshot is missing"); throw error; }
    if (!object(stored)) fail("corrupt snapshot");
    const { integrity, ...body } = stored;
    if (integrity !== draft.sha256 || integrity !== digest(body) || stored.version !== 1 || stored.scopeHash !== scopeHash
      || stored.taskRef !== ref || stored.workflow !== workflow || stored.inputRef !== preparedRef) fail("snapshot integrity or scope mismatch");
    const value = jsonObject(stored.value, "snapshot");
    const byteLength = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (byteLength !== draft.byteLength || byteLength !== stored.byteLength || stored.parts !== draft.parts) fail("snapshot metadata integrity mismatch");
    return { value, byteLength, parts: draft.parts };
  }

  async listInputs(scope: string, ref: string, workflow: string): Promise<DelegationTaskDraft[]> {
    workflow = string(workflow, "workflow");
    return (await this.get(scope, ref)).drafts.filter((draft) => draft.workflow === workflow);
  }

  /** Compare-and-swap prevents a delayed author tool call from replacing newer work. */
  async advanceDraft(scope: string, ref: string, workflow: string, preparedRef: string, expectedRevision: number): Promise<{ inputRef: string; revision: number }> {
    const saved = await this.mutate(scope, ref, task => {
      const head = task.draftHeads?.[workflow];
      if ((head?.revision ?? 0) !== expectedRevision) fail("draft revision changed; inspect_draft before editing or submitting");
      if (!task.drafts.some(draft => draft.workflow === workflow && draft.inputRef === preparedRef)) fail("draft snapshot missing");
      if (head?.inputRef === preparedRef) return false;
      task.draftHeads = { ...task.draftHeads, [workflow]: { inputRef: preparedRef, revision: expectedRevision + 1 } };
      return true;
    });
    return saved.draftHeads![workflow]!;
  }

  /** Caller must first confirm final delivery and mark the task completed. Retire all
   * pointers atomically before removing the exact task's payloads. Retrying cleanup
   * also finds orphan snapshots left by a crash between those two boundaries.
   */
  async clearInputs(scope: string, ref: string): Promise<DelegationTask> {
    const scopeHash = scopeDigest(scope); taskRef(ref);
    return this.withLock(scopeHash, async () => {
      const envelope = await this.readTask(scopeHash, ref);
      if (envelope.task.status !== "completed") fail("only completed tasks can clear temporary inputs after delivery");
      if (envelope.task.drafts.length) {
        envelope.task.drafts = [];
        delete envelope.task.draftHeads;
        envelope.task.revision++;
        envelope.task.updatedAt = new Date(Math.max(Date.now(), Date.parse(envelope.task.updatedAt) + 1)).toISOString();
        await this.saveTask(envelope);
      }
      const directory = path.join(this.directory(scopeHash), "inputs", ref);
      let files: string[];
      try { await this.safeDirectory(directory, false); files = await fs.readdir(directory); }
      catch (error) { if (isMissing(error)) return structuredClone(envelope.task); throw error; }
      for (const file of files) {
        if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
        const target = path.join(directory, file);
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink()) fail("snapshot cleanup target must be a regular file");
        await fs.unlink(target);
      }
      return structuredClone(envelope.task);
    });
  }

  async recordWorkflowResult(scope: string, ref: string, workflow: string, action: string, result: Record<string, unknown>): Promise<DelegationTask> {
    workflow = string(workflow, "workflow"); action = string(action, "action");
    const copy = jsonObject(result, "workflow result");
    return this.mutate(scope, ref, (task) => {
      const index = task.workflowResults.findIndex((entry) => entry.workflow === workflow);
      const previous = task.workflowResults[index];
      if (previous?.result.jobId === copy.jobId && typeof previous?.result.revision === "number" &&
        typeof copy.revision === "number" && copy.revision < previous.result.revision) return false;
      // A rejected call is not a new Job state. Keep paid progress and the last
      // authoritative receipt, recording diagnostics separately from execution.
      // Nor can a later preflight rejection reconcile an earlier no-Job unknown
      // write. Preserve that uncertainty through bookkeeping-only started rows;
      // an executor-owned Job snapshot may still establish the real outcome.
      const unresolved = previous?.result.status === "unknown" || previous?.result.retrySafety === "uncertain";
      const preservePrevious = previous && (
        (previous.result.jobId && previous.result.executionStarted !== false && (copy.executionStarted === false || copy.status === "started")) ||
        (unresolved && (copy.executionStarted === false || (copy.status === "started" && !copy.jobId)))
      );
      const next = preservePrevious
        ? { ...previous.result, ...(copy.executionStarted === false ? { lastError: copy } : { lastAttempt: { action, status: "started" } }) }
        : copy;
      if (previous && previous.action === action && digest(previous.result) === digest(next)) return false;
      if (index < 0 && task.workflowResults.length >= DELEGATION_TASK_MAX_SNAPSHOTS) fail("task already contains 64 workflow results");
      const entry = { workflow, action, result: next, updatedAt: new Date().toISOString() };
      if (index < 0) task.workflowResults.push(entry); else task.workflowResults[index] = entry;
      return true;
    });
  }
}
