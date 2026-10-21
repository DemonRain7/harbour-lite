import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { ToolContext, TurnFileChange, TurnFileChangeCollector } from "../types";
import { decodeSdkToolResult } from "./backends/sdkToolResult";

const MAX_CHANGES = 256;
const MAX_PATH = 4096;
const kinds = new Set(["created", "modified", "deleted", "renamed"]);

export function createFileChangeCollector(): TurnFileChangeCollector {
  return { scope: randomUUID(), entries: new Map(), seen: new Set() };
}

/** Persistence/public callers must only receive the explicitly allowed metadata. */
export function normalizeFileChanges(value: unknown): TurnFileChange[] {
  if (!Array.isArray(value)) return [];
  const result: TurnFileChange[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, MAX_CHANGES)) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !/^fc-[a-f0-9]{32}$/.test(entry.id)
      || seen.has(entry.id) || entry.source !== "tool" || typeof entry.kind !== "string" || !kinds.has(entry.kind)) continue;
    const file = cleanPath(entry.path);
    const oldPath = entry.oldPath === undefined ? undefined : cleanPath(entry.oldPath);
    if (!file || (entry.oldPath !== undefined && !oldPath)) continue;
    if (entry.location !== "local" && entry.location !== "remote") continue;
    const originHost = shortLabel(entry.originHost);
    const deviceId = shortLabel(entry.deviceId);
    if (entry.location === "local" && (!originHost || !isAbsoluteAny(file) || oldPath !== undefined && !isAbsoluteAny(oldPath))) continue;
    if (entry.location === "remote" && !deviceId) continue;
    if (entry.kind === "renamed" && !oldPath) continue;
    seen.add(entry.id);
    result.push({
      id: entry.id, path: file, kind: entry.kind as TurnFileChange["kind"], source: "tool", location: entry.location,
      ...(oldPath ? { oldPath } : {}), ...(originHost ? { originHost } : {}),
      ...(deviceId ? { deviceId } : {}), ...(shortLabel(entry.deviceLabel) ? { deviceLabel: shortLabel(entry.deviceLabel)! } : {}),
    });
  }
  return result;
}

export function snapshotFileChanges(collector?: TurnFileChangeCollector): TurnFileChange[] {
  return normalizeFileChanges(collector ? [...collector.entries.values()] : []);
}

/** Call only inside a real execution callback, never after checkpoint replay. The
 * result must have returned successfully; a fulfilled error/refusal is still ignored.
 * This intentionally does not infer changes made by Bash, shell scripts, or plans.
 */
export function recordSuccessfulToolFileChanges(
  tool: string, _args: unknown, result: unknown, ctx: ToolContext, receiptId?: string,
): void {
  if (!ctx.execution?.fileChanges || ctx.permissionMode === "plan") return;
  if (!["Write", "Edit", "MultiEdit", "NotebookEdit", "write_file", "apply_patch"].includes(tool)) return;
  const decoded = decodeSdkToolResult(result);
  const value = decoded.value;
  if (decoded.isError || failedReceipt(value)) return;
  const row = isRecord(value) ? value : undefined;
  if (tool === "apply_patch") {
    // Canonical apply_patch completion receipt, not the patch body or model prose.
    if (typeof value !== "string" || !value.startsWith("Success. Updated the following files:\n")) return;
    for (const line of value.trimEnd().split(/\r?\n/).slice(1, MAX_CHANGES + 1)) {
      const match = /^([AMD]) (.+)$/.exec(line);
      if (!match) continue;
      addChange(ctx, { path: match[2], kind: match[1] === "A" ? "created" : match[1] === "D" ? "deleted" : "modified" }, receiptId);
    }
    return;
  }
  if (!row) return;
  if (tool === "write_file") {
    // Cowork's trusted completed write receipt includes the actual resolved path.
    if (typeof row.path !== "string" || typeof row.bytes !== "number" || !Number.isFinite(row.bytes) || row.bytes < 0) return;
    addChange(ctx, { path: row.path, kind: "modified" }, receiptId);
  } else if (tool === "Write") {
    if (row.type !== "create" && row.type !== "update") return;
    addChange(ctx, { path: row.filePath, kind: row.type === "create" ? "created" : "modified" }, receiptId);
  } else if (tool === "NotebookEdit") {
    if (typeof row.notebook_path !== "string" || typeof row.edit_mode !== "string") return;
    addChange(ctx, { path: row.notebook_path, kind: "modified" }, receiptId);
  } else {
    // Native successful Edit/MultiEdit receipts; only path metadata is retained.
    const file = row.filePath ?? row.file_path;
    if (typeof file !== "string") return;
    addChange(ctx, { path: file, kind: "modified" }, receiptId);
  }
}

/** Completed App Server fileChange items are authoritative native edit receipts.
 * Missing/failed/declined status is not success. Patches/diffs are never copied.
 */
export function recordCodexFileChanges(item: unknown, ctx?: ToolContext, receiptId?: string): void {
  if (!ctx?.execution?.fileChanges || ctx.permissionMode === "plan" || !isRecord(item)
    || item.type !== "fileChange" || item.status !== "completed" || !Array.isArray(item.changes)) return;
  for (const change of item.changes.slice(0, MAX_CHANGES)) {
    if (!isRecord(change)) continue;
    const kind = isRecord(change.kind) ? change.kind : undefined;
    const rawKind = kind?.type ?? change.kind;
    const moved = kind?.move_path ?? kind?.movePath ?? change.move_path ?? change.movePath;
    if (typeof moved === "string") {
      addChange(ctx, { path: moved, oldPath: change.path, kind: "renamed" }, receiptId);
    } else {
      const action = rawKind === "add" || rawKind === "create" ? "created"
        : rawKind === "delete" ? "deleted" : rawKind === "update" || rawKind === undefined ? "modified" : undefined;
      if (action) addChange(ctx, { path: change.path, kind: action }, receiptId);
    }
  }
}

function addChange(
  ctx: ToolContext,
  candidate: { path: unknown; kind: TurnFileChange["kind"]; oldPath?: unknown },
  receiptId?: string,
): void {
  const collector = ctx.execution?.fileChanges;
  if (!collector) return;
  const target = ctx.execution?.cowork;
  const remote = !!target && target.deviceId !== "server";
  const file = resolveReceiptPath(candidate.path, remote ? target?.cwd : process.cwd(), remote);
  const oldPath = candidate.oldPath === undefined ? undefined : resolveReceiptPath(candidate.oldPath, remote ? target?.cwd : process.cwd(), remote);
  if (!file || (candidate.kind === "renamed" && !oldPath)) return;
  const device = remote ? shortLabel(target?.deviceId) : undefined;
  if (remote && !device) return;
  const host = remote ? undefined : os.hostname();
  const keyFor = (value: string) => JSON.stringify([host ?? "remote", device ?? "server", pathKey(value)]);
  const key = keyFor(file);
  const receipt = receiptId ? JSON.stringify([receiptId, key, candidate.kind, oldPath ?? ""]) : undefined;
  if (receipt && collector.seen.has(receipt)) return;
  if (receipt && collector.seen.size < MAX_CHANGES * 16) collector.seen.add(receipt);
  const previous = collector.entries.get(key) ?? (oldPath ? collector.entries.get(keyFor(oldPath)) : undefined);
  if (!previous && collector.entries.size >= MAX_CHANGES) return;
  if (oldPath) collector.entries.delete(keyFor(oldPath));
  const kind = candidate.kind === "modified" && (previous?.kind === "created" || previous?.kind === "renamed")
    ? previous.kind : candidate.kind;
  const retainedOldPath = kind === "renamed" ? previous?.oldPath ?? oldPath : undefined;
  const id = previous?.id ?? `fc-${createHash("sha256").update(`${collector.scope}:${key}`).digest("hex").slice(0, 32)}`;
  collector.entries.set(key, {
    id, path: file, kind, source: "tool", location: remote ? "remote" : "local",
    ...(retainedOldPath ? { oldPath: retainedOldPath } : {}),
    ...(host ? { originHost: host } : {}), ...(device ? { deviceId: device } : {}),
  });
}

function resolveReceiptPath(value: unknown, cwd: string | undefined, remote: boolean): string | undefined {
  const file = cleanPath(value);
  if (!file) return;
  const windows = /^[a-zA-Z]:[\\/]|^\\\\/.test(file) || !!cwd && /^[a-zA-Z]:[\\/]|^\\\\/.test(cwd);
  const paths = windows ? path.win32 : path.posix;
  if (paths.isAbsolute(file)) return paths.normalize(file);
  if (cwd && paths.isAbsolute(cwd)) return paths.resolve(cwd, file);
  // An unresolved remote path must remain remote, never resolved against this server.
  return remote ? file : undefined;
}

function cleanPath(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PATH
    && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value)
    && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : undefined;
}
function isAbsoluteAny(value: string): boolean { return path.posix.isAbsolute(value) || path.win32.isAbsolute(value); }
function pathKey(value: string): string { return /^[a-zA-Z]:[\\/]|^\\\\/.test(value) ? value.toLowerCase() : value; }
function shortLabel(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function failedReceipt(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.isError === true || value.is_error === true || value.success === false || value.ok === false
    || typeof value.error === "string" && value.error.trim().length > 0
    || value.error !== undefined && value.error !== null && typeof value.error !== "string" && value.error !== false
    || value.status !== undefined && !["ok", "completed", "success"].includes(String(value.status));
}
