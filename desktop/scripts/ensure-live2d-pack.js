"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DEFAULT_PROFILE,
  argument,
  hashBuffer,
  installLive2dPack,
  integritySpec,
  readProfile,
  safeRelative,
} = require("./install-live2d-pack");
const { platformPath, resolveCharacterHome } = require("../companion/platform-paths");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function installedPackStatus({
  profilePath = DEFAULT_PROFILE,
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
} = {}) {
  const profile = readProfile(profilePath);
  const spec = integritySpec(profile);
  const paths = platformPath(platform);
  const characterRoot = paths.join(resolveCharacterHome({ env, platform, homedir }), String(profile.characterId));
  const packageRoot = paths.join(characterRoot, "live2d", String(profile.packageId));
  const required = [
    ...spec.files.map((entry) => paths.join(packageRoot, ...entry.file.split("/"))),
    paths.join(characterRoot, ...safeRelative(profile.visual.runtime, "runtime").split("/")),
    paths.join(characterRoot, ...safeRelative(profile.visual.adapter, "adapter").split("/")),
  ];
  const missing = required.filter((file) => {
    try { return !fs.statSync(file).isFile() || fs.statSync(file).size <= 0; } catch { return true; }
  });
  const manifest = readJson(paths.join(characterRoot, "manifest.json"));
  const license = readJson(paths.join(characterRoot, "license.json"));
  const pinnedHashes = spec.files.every((entry) => license?.files?.[entry.file] === entry.sha256);
  const filesMatch = spec.files.every((entry) => {
    try {
      const file = paths.join(packageRoot, ...entry.file.split("/"));
      return hashBuffer(fs.readFileSync(file), entry.file, spec.textLineEndings) === entry.sha256;
    } catch {
      return false;
    }
  });
  const installedFileMatches = (relative, expected) => {
    try {
      if (!expected) return false;
      const file = paths.join(characterRoot, ...safeRelative(relative, "runtime file").split("/"));
      return hashBuffer(fs.readFileSync(file)) === expected;
    } catch {
      return false;
    }
  };
  const coreMatches = license?.cubismCore?.sha256 === spec.cubismCoreSha256
    && installedFileMatches(profile.visual.runtime, spec.cubismCoreSha256);
  const adapterMatches = installedFileMatches(profile.visual.adapter, license?.adapter?.sha256);
  const metadataReady = manifest?.visual?.live2d?.packageId === profile.packageId
    && manifest.visual.live2d.enabled === true
    && license?.packageId === profile.packageId
    && license?.source?.mirrorCommit === profile.source?.mirrorCommit
    && pinnedHashes
    && filesMatch
    && coreMatches
    && adapterMatches;
  return {
    installed: missing.length === 0 && metadataReady,
    status: missing.length === 0 && metadataReady ? "installed" : "missing",
    characterRoot,
    packageId: profile.packageId,
    missingCount: missing.length,
    metadataReady,
    integrityReady: filesMatch && coreMatches && adapterMatches,
  };
}

async function ensureLive2dPack(options = {}) {
  const before = installedPackStatus(options);
  if (before.installed) return { ...before, noOp: true };
  const env = options.env || process.env;
  if (env.HARBOUR_LIVE2D_AUTO_INSTALL === "0") {
    return { ...before, noOp: true, skipped: true, reason: "HARBOUR_LIVE2D_AUTO_INSTALL=0" };
  }
  const installed = await installLive2dPack(options);
  const after = installedPackStatus(options);
  if (!after.installed) throw new Error("Live2D package install completed without a valid installed package");
  return { ...after, noOp: false, downloaded: installed.downloaded };
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const options = {
    profilePath: path.resolve(argument("profile") || DEFAULT_PROFILE),
    source: argument("source") || process.env.HARBOUR_LIVE2D_SOURCE || "",
  };
  const before = installedPackStatus(options);
  if (!checkOnly && !before.installed && process.env.HARBOUR_LIVE2D_AUTO_INSTALL === "0") {
    console.log(JSON.stringify({ ...before, skipped: true, reason: "HARBOUR_LIVE2D_AUTO_INSTALL=0" }, null, 2));
    return;
  }
  const result = checkOnly ? before : await ensureLive2dPack(options);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[Harbour Live2D] ${error?.message || error}; pixel fallback remains available.`);
    // Desktop startup must remain usable offline. Explicit installer invocations stay strict,
    // while npm start opts into best-effort and falls back to the tracked pixel companion.
    process.exitCode = process.argv.includes("--best-effort") ? 0 : 1;
  });
}

module.exports = { ensureLive2dPack, installedPackStatus };
