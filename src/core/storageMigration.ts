import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { harbourBrowserHome, harbourDataHome, configureHarbourTemp } from "./storagePaths";

/** Copy once, atomically publish, and retain the old data as a recovery copy. */
export async function copyLegacyDirectory(source: string, destination: string): Promise<boolean> {
  try { await fs.access(destination); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try { if (!(await fs.stat(source)).isDirectory()) return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const relative = path.relative(path.resolve(source), path.resolve(destination));
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("Storage migration destination must not be inside its source");
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const staging = await fs.mkdtemp(`${destination}.migration-`);
  try {
    await fs.cp(source, staging, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true,
      filter: file => !["HarbourCdpOwner.json", "DevToolsActivePort", "SingletonLock", "SingletonSocket", "SingletonCookie"].includes(path.basename(file)) });
    await fs.rename(staging, destination);
  } catch (error) {
    // Only the exact directory created by this invocation; old data is untouched.
    if (path.dirname(path.resolve(staging)) === path.dirname(path.resolve(destination))
      && path.basename(staging).startsWith(`${path.basename(destination)}.migration-`)) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
  return true;
}

/** Runs after the predecessor has stopped, before browser warmup or SDK startup. */
export async function prepareRuntimeStorage(): Promise<void> {
  // A public checkout must never silently import another Harbour's login/profile data.
  // Migration is deliberately explicit; ordinary startup only prepares its own temp dir.
  if (process.env.HARBOUR_MIGRATE_LEGACY !== "true") {
    configureHarbourTemp();
    return;
  }
  const root = harbourDataHome();
  const legacy = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Harbour")
    : path.join(os.homedir(), ".harbour");
  const oldTemp = process.env.HARBOUR_LEGACY_TEMP || os.tmpdir();
  if (path.resolve(root) !== path.resolve(legacy)) {
    const profile = path.join(legacy, "chrome-profile");
    if (!process.env.HARBOUR_CHROME_PROFILE_DIR && !await exists(path.join(root, "chrome-profile"))) {
      let owner: { pid?: number } = {};
      try { owner = JSON.parse(await fs.readFile(path.join(profile, "HarbourCdpOwner.json"), "utf8")); } catch { /* old installs have no marker */ }
      if (owner.pid && owner.pid !== process.pid) {
        let running = false;
        try { process.kill(owner.pid, 0); running = true; } catch { /* already stopped */ }
        if (running) throw new Error("Harbour 专用浏览器仍在使用旧资料，请完整退出 Harbour 后重新打开，勿复制运行中的登录数据库。");
      }
      await copyLegacyDirectory(profile, path.join(root, "chrome-profile"));
    }
    for (const name of ["chrome-for-testing", "opencli-extension", "browser-harness", "cache", "cowork-host"]) {
      await copyLegacyDirectory(path.join(legacy, name), path.join(root, name));
    }
    await copyLegacyDirectory(path.join(legacy, "opencli-browser"), harbourBrowserHome());
  }
  await copyLegacyDirectory(path.join(oldTemp, "harbour-sdk-home"), path.join(root, "sdk-home"));
  configureHarbourTemp();
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}
