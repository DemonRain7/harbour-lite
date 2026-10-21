import fs from "node:fs";
import path from "node:path";
import { harbourDataHome } from "../storagePaths";

export const CLAUDE_SDK_TELEMETRY_MAX_FILES = 8;
export const CLAUDE_SDK_TELEMETRY_MAX_BYTES = 2 * 1024 * 1024;

export type ClaudeSdkTelemetryPruneResult = {
  removedFiles: number;
  removedBytes: number;
  remainingFiles: number;
  remainingBytes: number;
};

export function defaultClaudeSdkHome(): string {
  return path.join(harbourDataHome(), "sdk-home");
}

/**
 * Keep the SDK's shared config directory, but bound its retryable failed-event
 * cache. Only regular files with the SDK's exact failed-event prefix are ever
 * removed; symlinks, nested directories and unrelated files are untouched.
 */
export function pruneClaudeSdkTelemetry(
  sdkHome: string,
  limits: { maxFiles?: number; maxBytes?: number } = {}
): ClaudeSdkTelemetryPruneResult {
  const maxFiles = nonNegativeInteger(limits.maxFiles, CLAUDE_SDK_TELEMETRY_MAX_FILES);
  const maxBytes = nonNegativeInteger(limits.maxBytes, CLAUDE_SDK_TELEMETRY_MAX_BYTES);
  const root = path.resolve(sdkHome);
  const telemetryDir = path.resolve(root, "telemetry");
  if (path.dirname(telemetryDir) !== root) return emptyResult();

  try {
    if (fs.lstatSync(root).isSymbolicLink()) return emptyResult();
    const telemetryStat = fs.lstatSync(telemetryDir);
    if (!telemetryStat.isDirectory() || telemetryStat.isSymbolicLink()) return emptyResult();
  } catch {
    return emptyResult();
  }

  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  try {
    for (const entry of fs.readdirSync(telemetryDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^1p_failed_events\..+\.json$/u.test(entry.name)) continue;
      const filePath = path.resolve(telemetryDir, entry.name);
      if (path.dirname(filePath) !== telemetryDir) continue;
      try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        files.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // A concurrent SDK process may have already retried or removed it.
      }
    }
  } catch {
    return emptyResult();
  }

  files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  let remainingFiles = files.length;
  let remainingBytes = files.reduce((sum, file) => sum + file.size, 0);
  let removedFiles = 0;
  let removedBytes = 0;

  for (const file of files) {
    if (remainingFiles <= maxFiles && remainingBytes <= maxBytes) break;
    try {
      fs.unlinkSync(file.path);
      removedFiles += 1;
      removedBytes += file.size;
      remainingFiles -= 1;
      remainingBytes -= file.size;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (code === "ENOENT") {
        remainingFiles -= 1;
        remainingBytes -= file.size;
      }
    }
  }

  return { removedFiles, removedBytes, remainingFiles, remainingBytes };
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function emptyResult(): ClaudeSdkTelemetryPruneResult {
  return { removedFiles: 0, removedBytes: 0, remainingFiles: 0, remainingBytes: 0 };
}
