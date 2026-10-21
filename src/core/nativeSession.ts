import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CompletionRequest, Message } from "../types";

/** Runtime-owned capability. Message/seed fields are transient and never written here. */
export interface NativeSessionContext {
  rootDir: string;
  scope: string;
  attemptId: string;
  previousAttemptId?: string;
  continuity?: boolean;
  incrementalInput?: string;
  incrementalMessages?: Message[];
  prepareSeed?: (options?: { modelRef: string; contextPolicy?: CompletionRequest["contextPolicy"] }) => Promise<Message[]>;
  resumingCheckpoint?: boolean;
  recoveryOnly?: boolean;
  active?: boolean;
  observedContext?: { tokens: number; modelRef: string };
}

export interface NativeSessionRecord {
  version: 1;
  scopeHash: string;
  /** Hash of the adapter's compatibility fingerprint; raw configuration is not stored. */
  fingerprint: string;
  nativeId?: string;
  nativeTurnId?: string;
  nativeBaselineTurnId?: string;
  lastAttemptId?: string;
  phase: "prepared" | "accepted" | "finished" | "interrupted";
  contextTokens?: number;
  usageTotals?: NativeSessionUsageTotals;
  updatedAt: string;
  id: string;
}

export interface NativeSessionUsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export type NativeSessionPatch = Partial<Pick<NativeSessionRecord,
  "nativeId" | "nativeTurnId" | "nativeBaselineTurnId" | "lastAttemptId" | "phase" | "contextTokens" | "usageTotals">>;

export interface NativeSessionLease {
  /** A defensive copy; changing it cannot change the durable binding. */
  readonly record: NativeSessionRecord;
  readonly resumed: boolean;
  readonly reason: string;
  /** Stable for one binding. Reset rotates it without deleting any older workspace. */
  readonly directory: string;
  update(patch: NativeSessionPatch): Promise<void>;
  reset(reason: string): Promise<void>;
}

interface DiskLock { version: 1; pid: number; hostname: string; token: string }
interface RecordEnvelope { record: NativeSessionRecord; integrity: string }
const MAX_METADATA_BYTES = 16 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^ns-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const processLocks = new Map<string, Promise<void>>();
// Tokens expire on release: a timer created inside a completed run may legitimately
// start the next run later, even though it inherited the old async context.
const heldScopes = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();
const host = os.hostname();

export class NativeSessionReentryError extends Error {
  readonly code = "NATIVE_SESSION_REENTRANT";
  constructor() {
    super("子任务试图复用仍由父任务持有的原生会话，已阻止循环等待；未向该子任务的模型发送请求。请修正子任务会话隔离后再继续。");
    this.name = "NativeSessionReentryError";
  }
}

interface NativeSessionLockOptions {
  signal?: AbortSignal;
  onWait?: (state: "waiting" | "acquired" | "cancelled") => void;
}

function fail(message: string): never { throw new Error(`Native session: ${message}`); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function bounded(value: unknown, field: string, limit = 1024): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > limit) fail(`invalid ${field}`);
  return value;
}
function canonicalRecord(record: NativeSessionRecord): string {
  return JSON.stringify(Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b))));
}
function checkedRecord(raw: unknown, scopeHash: string): NativeSessionRecord {
  if (!plain(raw)) fail("corrupt metadata record");
  const allowed = ["version", "scopeHash", "fingerprint", "nativeId", "nativeTurnId", "nativeBaselineTurnId", "lastAttemptId", "phase", "contextTokens", "usageTotals", "updatedAt", "id"];
  if (Object.keys(raw).some((key) => !allowed.includes(key))) fail("unexpected metadata field");
  if (raw.version !== 1 || raw.scopeHash !== scopeHash || !SHA256.test(String(raw.fingerprint)) || !ID.test(String(raw.id))) {
    fail("metadata scope/version/identity mismatch");
  }
  if (!["prepared", "accepted", "finished", "interrupted"].includes(String(raw.phase))) fail("invalid metadata phase");
  if (raw.nativeId !== undefined) bounded(raw.nativeId, "nativeId", 2048);
  if (raw.nativeTurnId !== undefined) bounded(raw.nativeTurnId, "nativeTurnId", 2048);
  if (raw.nativeBaselineTurnId !== undefined) bounded(raw.nativeBaselineTurnId, "nativeBaselineTurnId", 2048);
  if (raw.lastAttemptId !== undefined) bounded(raw.lastAttemptId, "lastAttemptId");
  if (raw.contextTokens !== undefined && (typeof raw.contextTokens !== "number" || !Number.isSafeInteger(raw.contextTokens) || raw.contextTokens < 0)) {
    fail("invalid context token count");
  }
  let usageTotals: Record<string, number> | undefined;
  if (raw.usageTotals !== undefined) {
    const fields = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
    if (!plain(raw.usageTotals) || Object.getOwnPropertySymbols(raw.usageTotals).length ||
      Object.keys(raw.usageTotals).some((key) => !fields.includes(key))) fail("invalid usage totals");
    const descriptors = Object.getOwnPropertyDescriptors(raw.usageTotals);
    const copy: Record<string, number> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "number" ||
        !Number.isFinite(descriptor.value) || descriptor.value < 0) fail("invalid usage total");
      copy[field] = descriptor.value;
    }
    usageTotals = copy;
  }
  if (typeof raw.updatedAt !== "string" || !Number.isFinite(Date.parse(raw.updatedAt)) || new Date(raw.updatedAt).toISOString() !== raw.updatedAt) {
    fail("invalid metadata timestamp");
  }
  return { ...raw, ...(usageTotals ? { usageTotals } : {}) } as unknown as NativeSessionRecord;
}

/** Resolve platform aliases in trusted ancestors (e.g. macOS /var -> /private/var),
 * but keep the configured root itself lexical so a linked storage root is rejected. */
async function canonicalStorageRoot(configured: string): Promise<string> {
  const absolute = path.resolve(configured);
  if (absolute === path.parse(absolute).root) fail("storage root must be a dedicated directory");
  const suffix = [path.basename(absolute)];
  let ancestor = path.dirname(absolute);
  for (;;) {
    try { return path.join(await fs.realpath(ancestor), ...suffix); }
    catch (error) {
      if (!missing(error)) throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor)); ancestor = parent;
    }
  }
}

/** Reject links in the canonical storage tree. */
async function safeDirectory(directory: string, create: boolean): Promise<void> {
  const absolute = path.resolve(directory);
  const volume = path.parse(absolute).root;
  let current = volume;
  for (const part of absolute.slice(volume.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) await fs.mkdir(current).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    });
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("storage directory must not be a symbolic link");
  }
}

async function readJson(file: string): Promise<unknown> {
  await safeDirectory(path.dirname(file), false);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_METADATA_BYTES) fail("invalid storage file");
  const raw = await fs.readFile(file, "utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_METADATA_BYTES) fail("oversized metadata");
  try { return JSON.parse(raw) as unknown; } catch { fail("corrupt metadata JSON"); }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeJson(file: string, value: unknown, exclusive = false): Promise<void> {
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw, "utf8") > MAX_METADATA_BYTES) fail("oversized metadata");
  await safeDirectory(path.dirname(file), true);
  const existing = await fs.lstat(file).catch((error: unknown) => { if (!missing(error)) throw error; return undefined; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) fail("storage file must not be a symbolic link");
  if (exclusive) {
    const handle = await fs.open(file, "wx", 0o600);
    try { await handle.writeFile(raw, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(path.dirname(file));
    return;
  }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(raw, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally { await fs.unlink(temporary).catch((error: unknown) => { if (!missing(error)) throw error; }); }
}

function checkedLock(raw: unknown): DiskLock {
  if (!plain(raw) || Object.keys(raw).some((key) => !["version", "pid", "hostname", "token"].includes(key)) || raw.version !== 1 ||
    typeof raw.pid !== "number" || !Number.isSafeInteger(raw.pid) || raw.pid < 1 || typeof raw.token !== "string" ||
    !/^[a-f0-9-]{36}$/.test(raw.token)) fail("corrupt lock; manual inspection required");
  bounded(raw.hostname, "lock hostname");
  return raw as unknown as DiskLock;
}
function processIsAlive(lock: DiskLock): boolean {
  // Another host's PID is not meaningful here; never steal its lock.
  if (lock.hostname !== host) return true;
  try { process.kill(lock.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code !== "ESRCH"; }
}
async function unlinkOwnedLock(file: string, expected: DiskLock): Promise<void> {
  const actual = checkedLock(await readJson(file));
  if (actual.token !== expected.token || actual.pid !== expected.pid || actual.hostname !== expected.hostname) fail("lock ownership changed");
  await fs.unlink(file);
}

async function diskLock(file: string, recoveryDepth = 0): Promise<() => Promise<void>> {
  if (recoveryDepth > 8) fail("stale lock recovery limit exceeded; manual inspection required");
  const owner: DiskLock = { version: 1, pid: process.pid, hostname: host, token: randomUUID() };
  try { await writeJson(file, owner, true); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    const previous = checkedLock(await readJson(file));
    if (processIsAlive(previous)) fail("scope is locked by an active process");
    // A separate exclusive guard prevents two stale-lock reclaimers from removing
    // a fresh owner's lock. Dead recovery guards use the same bounded protocol.
    const guard = `${file}.reclaim`;
    const releaseGuard = await diskLock(guard, recoveryDepth + 1);
    try {
      const current = checkedLock(await readJson(file));
      if (processIsAlive(current)) fail("scope is locked by an active process");
      await unlinkOwnedLock(file, current);
      try { await writeJson(file, owner, true); }
      catch (claimError) {
        if ((claimError as NodeJS.ErrnoException)?.code === "EEXIST") fail("scope was acquired by another process");
        throw claimError;
      }
    } finally { await releaseGuard(); }
  }
  return async () => { await unlinkOwnedLock(file, owner); };
}

async function waitForPrior(prior: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return prior;
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    prior.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function inProcessLock<T>(key: string, callback: () => Promise<T>, options: NativeSessionLockOptions): Promise<T> {
  options.signal?.throwIfAborted();
  if (heldScopes.getStore()?.get(key)?.active) throw new NativeSessionReentryError();
  const queued = processLocks.get(key);
  const prior = queued ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  processLocks.set(key, held);
  const finish = () => { release(); if (processLocks.get(key) === held) processLocks.delete(key); };
  const report = (state: Parameters<NonNullable<NativeSessionLockOptions["onWait"]>>[0]) => {
    try { if (queued) options.onWait?.(state); } catch { /* Telemetry cannot break a lock. */ }
  };
  let acquired = false;
  const token = { active: true };
  try {
    report("waiting");
    await waitForPrior(prior, options.signal);
    acquired = true;
    options.signal?.throwIfAborted();
    report("acquired");
    const ancestors = new Map(heldScopes.getStore());
    ancestors.set(key, token);
    return await heldScopes.run(ancestors, callback);
  } catch (error) {
    if (options.signal?.aborted && !acquired) report("cancelled");
    throw error;
  } finally {
    token.active = false;
    // A cancelled waiter must not unblock the next waiter ahead of the current
    // owner. Keep its queue position until its predecessor has actually exited.
    if (acquired) finish();
    else void prior.then(finish, finish);
  }
}

/** One active binding per trusted scope. This never retries model callbacks and
 * never deletes provider transcripts or old binding workspaces. */
export async function withNativeSession<T>(
  context: NativeSessionContext,
  fingerprint: string,
  callback: (lease: NativeSessionLease) => Promise<T>,
  options: NativeSessionLockOptions = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  const configuredRoot = bounded(context.rootDir, "rootDir", 32 * 1024);
  const root = await canonicalStorageRoot(configuredRoot);
  const scopeHash = hash(bounded(context.scope, "trusted scope", 16 * 1024));
  bounded(context.attemptId, "attemptId");
  if (context.previousAttemptId !== undefined) bounded(context.previousAttemptId, "previousAttemptId");
  const compatibility = hash(bounded(fingerprint, "fingerprint", 64 * 1024));
  const directory = path.join(root, scopeHash);
  const lockKey = process.platform === "win32" ? directory.toLowerCase() : directory;
  return inProcessLock(lockKey, async () => {
    await safeDirectory(directory, true);
    const release = await diskLock(path.join(directory, "active.lock"));
    try {
      options.signal?.throwIfAborted();
      const file = path.join(directory, "active.json");
      let record: NativeSessionRecord | undefined;
      try {
        const envelope = await readJson(file);
        if (!plain(envelope) || Object.keys(envelope).some((key) => !["record", "integrity"].includes(key))) fail("corrupt metadata envelope");
        record = checkedRecord(envelope.record, scopeHash);
        if (envelope.integrity !== hash(canonicalRecord(record))) fail("metadata integrity mismatch");
      } catch (error) { if (!missing(error)) throw error; }

      const save = async (value: NativeSessionRecord, destination = file) => {
        const safe = checkedRecord(value, scopeHash);
        const envelope: RecordEnvelope = { record: safe, integrity: hash(canonicalRecord(safe)) };
        await writeJson(destination, envelope);
      };
      let resumed = false;
      let reason = "new_scope";
      if (record) {
        if (record.fingerprint !== compatibility) reason = "fingerprint_changed";
        else if (!record.nativeId) reason = "native_id_missing";
        else if (context.continuity !== false && record.lastAttemptId &&
          context.previousAttemptId !== record.lastAttemptId &&
          !(context.resumingCheckpoint && ["accepted", "interrupted"].includes(record.phase))) reason = "continuity_mismatch";
        else { resumed = true; reason = "compatible_native_session"; }
      }
      const replace = async () => {
        if (record) await save(record, path.join(directory, "records", `${record.id}.json`));
        const next: NativeSessionRecord = {
          version: 1, id: `ns-${randomUUID()}`, scopeHash, fingerprint: compatibility,
          phase: "prepared", updatedAt: new Date().toISOString(),
        };
        await safeDirectory(path.join(directory, "bindings", next.id, "workspace"), true);
        await save(next);
        record = next;
      };
      if (!resumed) await replace();
      else await safeDirectory(path.join(directory, "bindings", record!.id, "workspace"), true);

      let open = true;
      let writes: Promise<void> = Promise.resolve();
      const enqueue = (operation: () => Promise<void>): Promise<void> => {
        if (!open) return Promise.reject(new Error("Native session: lease is closed"));
        const result = writes.then(operation);
        writes = result.catch(() => {});
        return result;
      };
      const lease: NativeSessionLease = {
        get record() { return structuredClone(record!); },
        get resumed() { return resumed; },
        get reason() { return reason; },
        get directory() { return path.join(directory, "bindings", record!.id, "workspace"); },
        update(patch) {
          if (!plain(patch) || Object.getOwnPropertySymbols(patch).length) return Promise.reject(new Error("Native session: invalid metadata patch"));
          const copy: Record<string, unknown> = {};
          for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(patch))) {
            if (!["nativeId", "nativeTurnId", "nativeBaselineTurnId", "lastAttemptId", "phase", "contextTokens", "usageTotals"].includes(key) || !descriptor.enumerable || !("value" in descriptor)) {
              return Promise.reject(new Error("Native session: only nativeId/nativeTurnId/nativeBaselineTurnId/lastAttemptId/phase/contextTokens/usageTotals may be updated"));
            }
            copy[key] = descriptor.value;
          }
          try {
            const validated = checkedRecord({ ...record!, ...copy }, scopeHash);
            if (copy.usageTotals !== undefined) copy.usageTotals = validated.usageTotals;
          } catch (error) { return Promise.reject(error); }
          return enqueue(async () => {
            const next = { ...record!, ...copy, updatedAt: new Date().toISOString() };
            for (const key of Object.keys(next)) if ((next as Record<string, unknown>)[key] === undefined) delete (next as Record<string, unknown>)[key];
            const safe = checkedRecord(next, scopeHash);
            await save(safe);
            record = safe;
          });
        },
        reset(nextReason) {
          bounded(nextReason, "reset reason");
          return enqueue(async () => { await replace(); resumed = false; reason = nextReason; });
        },
      };
      try { options.signal?.throwIfAborted(); return await callback(lease); }
      finally { open = false; await writes; }
    } finally { await release(); }
  }, options);
}
