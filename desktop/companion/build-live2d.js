const path = require("node:path");
const fs = require("node:fs");
const { buildSync } = require("esbuild");

const root = path.resolve(__dirname, "..", "..");
const entry = path.join(__dirname, "live2d-adapter-entry.js");
const outfile = path.join(root, "web", "harbour-cubism-adapter.js");

function adapterNeedsBuild() {
  if (!fs.existsSync(outfile)) return true;
  return fs.statSync(entry).mtimeMs > fs.statSync(outfile).mtimeMs;
}

function buildLive2DAdapter({ force = false, logLevel = "info" } = {}) {
  if (!force && !adapterNeedsBuild()) return outfile;
  buildSync({
    entryPoints: [entry],
    outfile,
    bundle: true,
    minify: true,
    sourcemap: false,
    platform: "browser",
    format: "iife",
    target: ["chrome120"],
    legalComments: "eof",
    logLevel,
  });
  return outfile;
}

if (require.main === module) {
  try {
    buildLive2DAdapter({ force: true });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { adapterNeedsBuild, buildLive2DAdapter, outfile };
