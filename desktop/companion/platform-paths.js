"use strict";

const os = require("node:os");
const path = require("node:path");

function platformPath(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function resolveHarbourDataRoot({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
} = {}) {
  const paths = platformPath(platform);
  const override = String(env.HARBOUR_DATA_HOME || "").trim();
  if (override) return paths.resolve(override);
  if (platform === "win32") {
    const localAppData = String(env.LOCALAPPDATA || "").trim()
      || paths.join(homedir, "AppData", "Local");
    return paths.join(localAppData, "HarbourPublic");
  }
  if (platform === "darwin") {
    return paths.join(homedir, "Library", "Application Support", "HarbourPublic");
  }
  const configHome = String(env.XDG_CONFIG_HOME || "").trim()
    || paths.join(homedir, ".config");
  return paths.join(configHome, "HarbourPublic");
}

function resolveCharacterHome(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const paths = platformPath(platform);
  const override = String(env.HARBOUR_CHARACTER_HOME || "").trim();
  return override
    ? paths.resolve(override)
    : paths.join(resolveHarbourDataRoot({ ...options, env, platform }), "characters");
}

module.exports = {
  platformPath,
  resolveCharacterHome,
  resolveHarbourDataRoot,
};
