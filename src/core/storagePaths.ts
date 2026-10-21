import { mkdirSync } from "node:fs";
import path from "node:path";

type StorageEnvironment = { HARBOUR_DATA_HOME?: string; HARBOUR_OPENCLI_BROWSER_HOME?: string };

/** Harbour-owned files stay beside this checkout, never in the OS profile by default. */
export function harbourDataHome(env: StorageEnvironment = process.env): string {
  return path.resolve(env.HARBOUR_DATA_HOME?.trim() || path.join(process.cwd(), "data", "runtime"));
}

/** Preserve the existing browser-only override's base-directory semantics. */
export function harbourBrowserHome(env: StorageEnvironment = process.env): string {
  const base = env.HARBOUR_OPENCLI_BROWSER_HOME?.trim();
  return path.join(base ? path.resolve(base) : harbourDataHome(env), "opencli-browser");
}

export function harbourTempDir(): string {
  const directory = path.join(harbourDataHome(), "tmp");
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** Scoped to this process and its children; never changes Windows/user environment. */
export function configureHarbourTemp(): void {
  const directory = harbourTempDir();
  process.env.TEMP = directory;
  process.env.TMP = directory;
  process.env.TMPDIR = directory;
}
