"use strict";
// Build-time normalization only. No generation, segmentation or runtime dependency.
// node desktop/scripts/prepare-startup-art.cjs aemeath <transparent PNG> v2
// Add --preserve-source-crop only for a visually reviewed, intentionally cropped portrait.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const [character, source, version = "v1", framing] = process.argv.slice(2);
assert.ok(["elaina", "aemeath"].includes(character) && source, "Pass elaina|aemeath and a transparent image path");
assert.match(version, /^v[1-9][0-9]*$/, "Version must be a simple v1/v2/... asset suffix");
assert.ok(framing === undefined || framing === "--preserve-source-crop", "Unknown source framing option");
const sourcePath = path.resolve(source);
const directory = path.resolve(__dirname, "../renderer/assets/startup");
const destination = path.join(directory, character + "-" + version + ".webp");
assert.notEqual(sourcePath, destination, "Keep the master non-destructively");
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function alphaBounds(bytes, width, height, channels) {
  let left = width, top = height, right = -1, bottom = -1, clear = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const a = bytes[(y * width + x) * channels + channels - 1];
    if (a <= 2) { clear++; continue; }
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  assert.ok(right >= left && bottom >= top, "Character must not be empty");
  return { left, top, width: right - left + 1, height: bottom - top + 1, clear };
}

(async () => {
  const metadata = await sharp(sourcePath).metadata();
  assert.equal(metadata.hasAlpha, true, "Use an actual alpha cutout, not a white/checkerboard background");
  const raw = await sharp(sourcePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const bounds = alphaBounds(raw.data, raw.info.width, raw.info.height, raw.info.channels);
  assert.ok(bounds.clear > raw.info.width * raw.info.height * .08, "Transparent background required");
  const sourceTouchesEdge = bounds.left === 0 || bounds.top === 0
    || bounds.left + bounds.width === raw.info.width || bounds.top + bounds.height === raw.info.height;
  assert.ok(!sourceTouchesEdge || framing === "--preserve-source-crop",
    "Source silhouette touches a canvas edge; inspect for clipping before importing (intentional portraits may use --preserve-source-crop)");
  // Fit the full alpha silhouette into a shared 576px safe area, never stretch it.
  const bytes = await sharp(sourcePath).extract({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height })
    .resize(576, 576, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({ top: 32, bottom: 32, left: 32, right: 32, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 92, alphaQuality: 100, effort: 6 }).toBuffer();
  assert.ok(bytes.length < 250_000, "Keep one character below 250KB");
  const output = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const actual = alphaBounds(output.data, 640, 640, output.info.channels);
  const margin = Math.min(actual.left, actual.top, 640 - actual.left - actual.width, 640 - actual.top - actual.height);
  assert.ok(margin >= 30, "Preserve safe transparent padding after encoding");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(destination, bytes);
  console.log(JSON.stringify({ file: path.basename(destination), width: 640, height: 640, alpha: true,
    bytes: bytes.length, sha256: sha256(bytes), transparentMarginPixels: margin, sourceTouchesEdge,
    cutoutMasterSha256: sha256(fs.readFileSync(sourcePath)) }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
