"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { defaultManifest } = require("../companion/character-store");
const { platformPath, resolveCharacterHome } = require("../companion/platform-paths");

const CORE_URL = "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js";
const DEFAULT_PROFILE = path.join(__dirname, "..", "companion", "profiles", "elaina-lss.json");
const SHA256 = /^[a-f0-9]{64}$/;
const HARD_MAX_FILE_BYTES = 32 * 1024 * 1024;
const HARD_MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const CORE_MAX_BYTES = 8 * 1024 * 1024;

function argument(name, argv = process.argv) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : "";
}

function safeId(value, label) {
  const id = String(value || "");
  if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error(`${label} is invalid`);
  return id.toLowerCase();
}

function safeRelative(value, label = "file") {
  const raw = String(value || "");
  if (!raw || raw.includes("\\") || raw.includes("\0")) throw new Error(`${label} is invalid`);
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized.startsWith("../") || normalized.startsWith("/") || normalized !== raw) {
    throw new Error(`${label} must be a normalized relative path`);
  }
  return normalized;
}

function inside(root, relative, label) {
  const normalized = safeRelative(relative, label);
  const resolved = path.resolve(root, ...normalized.split("/"));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`${label} escapes package root`);
  return resolved;
}

function readProfile(profilePath = DEFAULT_PROFILE) {
  return JSON.parse(fs.readFileSync(path.resolve(profilePath), "utf8"));
}

function integritySpec(profile) {
  if (String(profile?.integrity?.algorithm || "").toLowerCase() !== "sha256") {
    throw new Error("profile integrity.algorithm must be sha256");
  }
  const files = Object.entries(profile.integrity.files || {}).map(([relative, digest]) => {
    const file = safeRelative(relative, `integrity file ${relative}`);
    const sha256 = String(digest || "").toLowerCase();
    if (!SHA256.test(sha256)) throw new Error(`invalid sha256 for ${file}`);
    return { file, sha256 };
  });
  if (!files.length) throw new Error("profile integrity.files is empty");
  const maxFileBytes = Math.min(
    HARD_MAX_FILE_BYTES,
    Math.max(1, Number(profile.integrity.maxFileBytes) || HARD_MAX_FILE_BYTES),
  );
  const maxTotalBytes = Math.min(
    HARD_MAX_TOTAL_BYTES,
    Math.max(maxFileBytes, Number(profile.integrity.maxTotalBytes) || HARD_MAX_TOTAL_BYTES),
  );
  const sourceModel = safeRelative(profile.sourceModel, "sourceModel");
  if (!files.some((entry) => entry.file === sourceModel)) throw new Error("sourceModel is missing from integrity.files");
  const textLineEndings = profile.integrity.textLineEndings === "crlf" ? "crlf" : "none";
  const cubismCoreSha256 = String(profile.integrity.cubismCoreSha256 || "").toLowerCase();
  if (!SHA256.test(cubismCoreSha256)) throw new Error("profile integrity.cubismCoreSha256 is invalid");
  return { files, maxFileBytes, maxTotalBytes, sourceModel, textLineEndings, cubismCoreSha256 };
}

function modelReferences(model) {
  const refs = model?.FileReferences || {};
  const values = [refs.Moc, refs.Physics, refs.Pose, refs.DisplayInfo, refs.UserData, ...(refs.Textures || [])];
  for (const expression of refs.Expressions || []) values.push(expression?.File);
  for (const motions of Object.values(refs.Motions || {})) {
    for (const motion of motions || []) values.push(motion?.File, motion?.Sound, motion?.Expression);
  }
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function githubRawBase(profile) {
  const mirror = new URL(String(profile?.source?.runtimeMirror || ""));
  if (mirror.protocol !== "https:" || mirror.hostname.toLowerCase() !== "github.com") {
    throw new Error("runtimeMirror must be a GitHub HTTPS tree URL");
  }
  const match = decodeURIComponent(mirror.pathname).match(/^\/([^/]+)\/([^/]+)\/tree\/([a-f0-9]{40})\/(.+)$/i);
  if (!match) throw new Error("runtimeMirror must pin a full Git commit");
  const [, owner, repository, commit, treePath] = match;
  const declaredCommit = String(profile?.source?.mirrorCommit || "").toLowerCase();
  if (declaredCommit !== commit.toLowerCase()) throw new Error("runtimeMirror and mirrorCommit disagree");
  const encodedPath = treePath.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${commit}/${encodedPath}/`;
}

function profileDownloadPlan(profile) {
  const base = githubRawBase(profile);
  const spec = integritySpec(profile);
  return spec.files.map((entry) => ({
    ...entry,
    url: `${base}${entry.file.split("/").map(encodeURIComponent).join("/")}`,
  }));
}

async function responseBytes(response, maxBytes) {
  const declared = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`download exceeds ${maxBytes} bytes`);
  if (!response?.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`download exceeds ${maxBytes} bytes`);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`download exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

async function fetchBounded(url, {
  fetchImpl = globalThis.fetch,
  maxBytes,
  expectedSha256 = "",
  integrityFile = "",
  textLineEndings = "none",
  allowedHost,
  timeoutMs = 30_000,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { redirect: "follow", signal: controller.signal });
    if (!response?.ok) throw new Error(`download failed: HTTP ${response?.status || "unknown"}`);
    const finalUrl = new URL(response.url || url);
    if (finalUrl.protocol !== "https:" || finalUrl.hostname.toLowerCase() !== allowedHost) {
      throw new Error("download redirected outside the trusted HTTPS host");
    }
    const body = await responseBytes(response, maxBytes);
    if (!body.length) throw new Error("download returned an empty file");
    const sha256 = hashBuffer(body, integrityFile, textLineEndings);
    if (expectedSha256 && sha256 !== expectedSha256) throw new Error("download sha256 mismatch");
    return { body, sha256 };
  } finally {
    clearTimeout(timer);
  }
}

function retryableDownload(error) {
  const message = String(error?.message || error);
  return !/(?:sha256 mismatch|HTTP 4\d\d|redirected outside|exceeds \d+ bytes|empty file)/iu.test(message);
}

async function fetchBoundedWithRetry(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchBounded(url, options);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !retryableDownload(error)) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw lastError;
}

async function downloadProfileSource(profile, {
  fetchImpl = globalThis.fetch,
  tempParent = os.tmpdir(),
} = {}) {
  const spec = integritySpec(profile);
  const root = fs.mkdtempSync(path.join(path.resolve(tempParent), "harbour-live2d-"));
  let total = 0;
  try {
    for (const entry of profileDownloadPlan(profile)) {
      const remaining = spec.maxTotalBytes - total;
      if (remaining <= 0) throw new Error("profile download exceeds total size limit");
      let body;
      try {
        ({ body } = await fetchBoundedWithRetry(entry.url, {
          fetchImpl,
          maxBytes: Math.min(spec.maxFileBytes, remaining),
          expectedSha256: entry.sha256,
          integrityFile: entry.file,
          textLineEndings: spec.textLineEndings,
          allowedHost: "raw.githubusercontent.com",
        }));
      } catch (error) {
        throw new Error(`failed to download ${entry.file}: ${error?.message || error}`, { cause: error });
      }
      total += body.length;
      const target = inside(root, entry.file, `download target ${entry.file}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body, { mode: 0o600 });
    }
    return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function hashBuffer(buffer, relative = "", textLineEndings = "none") {
  let bytes = buffer;
  if (textLineEndings === "crlf" && /\.(?:json|cfg)$/i.test(relative)) {
    const canonical = buffer.toString("utf8").replace(/\r\n|\r|\n/g, "\r\n");
    bytes = Buffer.from(canonical, "utf8");
  }
  return createHash("sha256").update(bytes).digest("hex");
}

function hashFile(file, relative = "", textLineEndings = "none") {
  return hashBuffer(fs.readFileSync(file), relative, textLineEndings);
}

function verifyProfileSource(source, profile) {
  const spec = integritySpec(profile);
  const sourceRoot = fs.realpathSync(path.resolve(source));
  let total = 0;
  for (const entry of spec.files) {
    const file = inside(sourceRoot, entry.file, `source file ${entry.file}`);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new Error(`missing model file: ${entry.file}`);
    const real = fs.realpathSync(file);
    if (real !== sourceRoot && !real.startsWith(`${sourceRoot}${path.sep}`)) throw new Error(`model file escapes source: ${entry.file}`);
    const size = fs.statSync(real).size;
    if (!size || size > spec.maxFileBytes) throw new Error(`invalid model file size: ${entry.file}`);
    total += size;
    if (total > spec.maxTotalBytes) throw new Error("model package exceeds total size limit");
    if (hashFile(real, entry.file, spec.textLineEndings) !== entry.sha256) throw new Error(`model sha256 mismatch: ${entry.file}`);
  }
  const modelPath = inside(sourceRoot, spec.sourceModel, "sourceModel");
  const model = JSON.parse(fs.readFileSync(modelPath, "utf8"));
  const protectedFiles = new Set(spec.files.map((entry) => entry.file));
  for (const reference of modelReferences(model)) {
    const normalized = safeRelative(reference, `model reference ${reference}`);
    if (!protectedFiles.has(normalized)) throw new Error(`model reference is not integrity-pinned: ${normalized}`);
    const file = inside(sourceRoot, normalized, `model reference ${normalized}`);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`missing model reference: ${normalized}`);
  }
  return { sourceRoot, spec };
}

function copyVerifiedPackage(sourceRoot, target, spec) {
  for (const entry of spec.files) {
    const source = inside(sourceRoot, entry.file, `copy source ${entry.file}`);
    const destination = inside(target, entry.file, `copy target ${entry.file}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

function hashFiles(root, spec) {
  const result = {};
  for (const entry of spec.files) {
    result[entry.file] = hashFile(
      inside(root, entry.file, `installed file ${entry.file}`),
      entry.file,
      spec.textLineEndings,
    );
  }
  return result;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
}

async function installCore(live2dDir, { fetchImpl = globalThis.fetch, expectedSha256 } = {}) {
  const target = path.join(live2dDir, "live2dcubismcore.min.js");
  const { body, sha256 } = await fetchBoundedWithRetry(CORE_URL, {
    fetchImpl,
    maxBytes: CORE_MAX_BYTES,
    expectedSha256,
    allowedHost: "cubism.live2d.com",
  });
  if (body.length < 100_000 || !body.subarray(0, 1_000).toString("utf8").includes("Live2D Cubism Core")) {
    throw new Error("Cubism Core download did not pass signature checks");
  }
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, body, { mode: 0o600 });
  const backup = `${target}.backup-${Date.now()}`;
  if (fs.existsSync(target)) fs.renameSync(target, backup);
  try {
    fs.renameSync(temp, target);
    if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
  } catch (error) {
    if (!fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target);
    throw error;
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
  return { url: CORE_URL, sha256 };
}

async function installLive2dPack({
  profilePath = DEFAULT_PROFILE,
  source = "",
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  fetchImpl = globalThis.fetch,
  tempParent = os.tmpdir(),
  adapterBuilder = null,
} = {}) {
  const profile = readProfile(profilePath);
  const characterId = safeId(profile.characterId, "characterId");
  const packageId = safeId(profile.packageId, "packageId");
  let acquired = null;
  let sourceRoot = String(source || "").trim() ? path.resolve(source) : "";
  try {
    if (!sourceRoot) {
      acquired = await downloadProfileSource(profile, { fetchImpl, tempParent });
      sourceRoot = acquired.root;
    }
    const verified = verifyProfileSource(sourceRoot, profile);
    const paths = platformPath(platform);
    const characterRoot = paths.join(resolveCharacterHome({ env, platform, homedir }), characterId);
    const live2dDir = paths.join(characterRoot, "live2d");
    const target = paths.join(live2dDir, packageId);
    const staging = paths.join(live2dDir, `.install-${packageId}-${randomUUID()}`);
    fs.mkdirSync(staging, { recursive: true });
    try {
      copyVerifiedPackage(verified.sourceRoot, staging, verified.spec);
      const copiedModel = inside(staging, profile.sourceModel, "copied sourceModel");
      JSON.parse(fs.readFileSync(copiedModel, "utf8"));
      const backup = `${target}.backup-${Date.now()}`;
      if (fs.existsSync(target)) fs.renameSync(target, backup);
      try {
        fs.renameSync(staging, target);
        if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
      } catch (error) {
        if (!fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target);
        throw error;
      }
    } finally {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    }

    const core = await installCore(live2dDir, {
      fetchImpl,
      expectedSha256: verified.spec.cubismCoreSha256,
    });
    const buildAdapter = adapterBuilder
      || ((options) => require("../companion/build-live2d").buildLive2DAdapter(options));
    const adapter = buildAdapter({ logLevel: "silent" });
    const installedAdapter = paths.join(live2dDir, "harbour-cubism-adapter.js");
    fs.copyFileSync(adapter, installedAdapter);

    const character = {
      id: characterId,
      agentName: characterId === "elaina" ? "main-elaina" : `main-${characterId}`,
      displayName: profile.displayName || characterId,
    };
    const manifestPath = paths.join(characterRoot, "manifest.json");
    let manifest = defaultManifest(character);
    try { manifest = { ...manifest, ...JSON.parse(fs.readFileSync(manifestPath, "utf8")) }; } catch { /* first install */ }
    manifest = {
      ...manifest,
      schemaVersion: 3,
      id: characterId,
      agent: character.agentName,
      displayName: profile.displayName || manifest.displayName,
      visual: {
        ...(manifest.visual || {}),
        preferred: "live2d",
        fallback: "pixel",
        live2d: { ...profile.visual, enabled: true, packageId },
        pixel: { manifest: `assets/pets/${characterId}/pet.json`, ...(manifest.visual?.pixel || {}) },
      },
    };
    atomicJson(manifestPath, manifest);
    atomicJson(paths.join(characterRoot, "interactions.json"), {
      schemaVersion: 2,
      packageId,
      ...(profile.visual?.interactions || {}),
    });
    atomicJson(paths.join(characterRoot, "license.json"), {
      character: profile.displayName,
      status: "local-user-installed",
      packageId,
      installedAt: new Date().toISOString(),
      source: profile.source,
      cubismCore: core,
      adapter: { sha256: hashFile(installedAdapter) },
      files: hashFiles(target, verified.spec),
      notes: "The character model and proprietary Cubism Core remain in the platform-local Harbour data directory and are not bundled with Harbour source or installers.",
    });
    return {
      installed: true,
      downloaded: !!acquired,
      characterRoot,
      packageId,
      model: profile.visual.model,
    };
  } finally {
    acquired?.cleanup();
  }
}

async function main() {
  const result = await installLive2dPack({
    profilePath: path.resolve(argument("profile") || DEFAULT_PROFILE),
    source: argument("source") || process.env.HARBOUR_LIVE2D_SOURCE || "",
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {
  CORE_URL,
  DEFAULT_PROFILE,
  argument,
  downloadProfileSource,
  fetchBounded,
  fetchBoundedWithRetry,
  githubRawBase,
  hashBuffer,
  installLive2dPack,
  integritySpec,
  modelReferences,
  profileDownloadPlan,
  readProfile,
  safeRelative,
  verifyProfileSource,
};
