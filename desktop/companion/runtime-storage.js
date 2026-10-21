"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveHarbourDataRoot } = require("./platform-paths");

// Read one non-secret path, not the backend credentials, into the desktop process.
function localDataHome(repoRoot) {
  try {
    const text = fs.readFileSync(path.join(repoRoot, ".env"), "utf8");
    const value = text.match(/^\s*HARBOUR_DATA_HOME\s*=\s*(.*?)\s*$/mu)?.[1] || "";
    const quoted = value.match(/^(["'])(.*?)\1\s*(?:#.*)?$/u);
    return (quoted ? quoted[2] : value.split("#")[0]).trim();
  } catch { return ""; }
}

function copyOnce(source, destination) {
  if (path.resolve(source) === path.resolve(destination) || fs.existsSync(destination) || !fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.statSync(source).isDirectory()) {
    const staging = fs.mkdtempSync(`${destination}.migration-`);
    try {
      fs.cpSync(source, staging, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true,
        filter: file => !["DevToolsActivePort", "SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"].includes(path.basename(file)) });
      fs.renameSync(staging, destination);
    } catch (error) {
      if (path.dirname(path.resolve(staging)) === path.dirname(path.resolve(destination))
        && path.basename(staging).startsWith(`${path.basename(destination)}.migration-`)) {
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* original copy failure is actionable */ }
      }
      throw error;
    }
  } else fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}

/** Called only by the primary instance, before Chromium or any stores open files. */
function initializeDesktopStorage(app, { repoRoot, dataHome = "", env = process.env } = {}) {
  const legacyRoot = resolveHarbourDataRoot({ env: { ...env, HARBOUR_DATA_HOME: "" } });
  let localRepo = false;
  try { localRepo = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).name === "harbour"; } catch { /* packaged remote client */ }
  const configured = env.HARBOUR_DATA_HOME || dataHome || (localRepo ? localDataHome(repoRoot) || path.join(repoRoot, "data", "runtime") : "");
  if (!configured) return; // Standalone clients retain platform defaults unless configured.
  const root = path.resolve(localRepo ? repoRoot : process.cwd(), configured);
  const oldUserData = app.getPath("userData");
  const defaultUserData = path.join(app.getPath("appData"), app.getName());
  // Respect launchers/tests that explicitly supplied an isolated Chromium profile.
  const moveUserData = path.resolve(oldUserData) === path.resolve(defaultUserData);
  if (moveUserData) {
    const destination = path.join(root, "electron");
    if (env.HARBOUR_MIGRATE_LEGACY === "true") copyOnce(oldUserData, destination);
    fs.mkdirSync(destination, { recursive: true });
    app.setPath("userData", destination);
    app.setPath("sessionData", destination);
    for (const key of ["crashDumps", "logs"]) {
      const dir = path.join(root, key);
      fs.mkdirSync(dir, { recursive: true }); app.setPath(key, dir);
    }
    // Settings, local tracks and avatars are copied once, never removed or overwritten.
    if (env.HARBOUR_MIGRATE_LEGACY === "true") {
      for (const name of ["characters", "music", "stickers", "companion-settings.json"]) copyOnce(path.join(legacyRoot, name), path.join(root, name));
    }
  }
  env.HARBOUR_DATA_HOME = root;
  env.HARBOUR_LEGACY_TEMP ||= os.tmpdir();
  const temp = path.join(root, "tmp"); fs.mkdirSync(temp, { recursive: true });
  env.TEMP = temp; env.TMP = temp; env.TMPDIR = temp;
  app.setPath("temp", temp);
  return root;
}

module.exports = { initializeDesktopStorage, localDataHome, copyOnce };
