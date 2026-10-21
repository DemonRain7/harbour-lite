"use strict";
const fs = require("node:fs");
const path = require("node:path");

// Local configuration, separate from agents and credentials. Only raster images cross IPC.
function readStartupAppearance({ root = path.resolve(__dirname, ".."), env = process.env } = {}) {
  const file = env.HARBOUR_SPLASH_CONFIG
    ? path.resolve(env.HARBOUR_SPLASH_CONFIG) : path.join(root, "startup.config.json");
  let config;
  try {
    if (fs.statSync(file).size > 32 * 1024) return null;
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return null; }
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const result = {};
  for (const side of ["left", "right"]) {
    const entry = config[side];
    if (entry === false) { result[side] = { hidden: true }; continue; }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const value = { label: String(entry.label || "").replace(/[\u0000-\u001f]/g, "").slice(0, 80) };
    if (typeof entry.file === "string" && entry.file.trim()) {
      try {
        const image = path.resolve(path.dirname(file), entry.file);
        if (fs.statSync(image).size > 6 * 1024 * 1024) continue;
        const bytes = fs.readFileSync(image);
        const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
          : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
          : bytes.toString("ascii",0,4) === "RIFF" && bytes.toString("ascii",8,12) === "WEBP" ? "image/webp" : "";
        if (!mime) continue;
        value.src = `data:${mime};base64,${bytes.toString("base64")}`;
      } catch { continue; } // A missing custom image keeps the bundled default.
    }
    result[side] = value;
  }
  return result;
}

module.exports = { readStartupAppearance };
