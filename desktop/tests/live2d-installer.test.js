"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const test = require("node:test");
const { CharacterStore } = require("../companion/character-store");
const { resolveCharacterHome, resolveHarbourDataRoot } = require("../companion/platform-paths");
const {
  CORE_URL,
  downloadProfileSource,
  fetchBoundedWithRetry,
  installLive2dPack,
  profileDownloadPlan,
  readProfile,
  verifyProfileSource,
} = require("../scripts/install-live2d-pack");
const { ensureLive2dPack, installedPackStatus } = require("../scripts/ensure-live2d-pack");

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function fixtureProfile(payloads, commit = "a".repeat(40)) {
  return {
    packageId: "fixture-pack",
    characterId: "fixture",
    displayName: "Fixture",
    source: {
      runtimeMirror: `https://github.com/example/fixture/tree/${commit}/models/Fixture`,
      mirrorCommit: commit,
      usage: "test fixture",
    },
    sourceModel: "Fixture.model3.json",
    integrity: {
      algorithm: "sha256",
      cubismCoreSha256: "1".repeat(64),
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
      files: Object.fromEntries([...payloads].map(([file, body]) => [file, digest(body)])),
    },
    visual: {
      enabled: true,
      behaviorVersion: 1,
      packageId: "fixture-pack",
      model: "live2d/fixture-pack/Fixture.model3.json",
      runtime: "live2d/live2dcubismcore.min.js",
      adapter: "live2d/harbour-cubism-adapter.js",
      parameters: {},
      actions: {},
      interactions: {},
    },
  };
}

function fixtureFiles() {
  const model = Buffer.from(JSON.stringify({
    Version: 3,
    FileReferences: {
      Moc: "Fixture.moc3",
      Textures: ["Fixture.2048/texture_00.png"],
      Expressions: [{ Name: "happy", File: "happy.exp3.json" }],
    },
  }));
  return new Map([
    ["Fixture.model3.json", model],
    ["Fixture.moc3", Buffer.from("fixture-moc3")],
    ["Fixture.2048/texture_00.png", Buffer.from("fixture-texture")],
    ["happy.exp3.json", Buffer.from('{"Type":"Live2D Expression"}')],
  ]);
}

function response(body, url, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name) => name.toLowerCase() === "content-length" ? String(body.length) : null },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }),
  };
}

test("Live2D data roots are deterministic on Windows, macOS and Linux", () => {
  assert.equal(resolveHarbourDataRoot({
    platform: "win32",
    homedir: "C:\\Users\\用户",
    env: { LOCALAPPDATA: "C:\\Users\\用户\\AppData\\Local" },
  }), "C:\\Users\\用户\\AppData\\Local\\Harbour");
  assert.equal(resolveHarbourDataRoot({
    platform: "darwin",
    homedir: "/Users/rain",
    env: {},
  }), "/Users/rain/Library/Application Support/Harbour");
  assert.equal(resolveHarbourDataRoot({
    platform: "linux",
    homedir: "/home/rain",
    env: { XDG_CONFIG_HOME: "/home/rain/.xdg" },
  }), "/home/rain/.xdg/Harbour");
  assert.equal(resolveHarbourDataRoot({
    platform: "darwin",
    homedir: "/Users/rain",
    env: { HARBOUR_DATA_HOME: "/Volumes/Private/Harbour" },
  }), "/Volumes/Private/Harbour");
  assert.equal(resolveCharacterHome({
    platform: "darwin",
    homedir: "/Users/rain",
    env: { HARBOUR_CHARACTER_HOME: "/Volumes/Private/characters" },
  }), "/Volumes/Private/characters");
});

test("CharacterStore keeps HARBOUR_CHARACTER_HOME settings isolation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-character-path-"));
  const previous = process.env.HARBOUR_CHARACTER_HOME;
  try {
    process.env.HARBOUR_CHARACTER_HOME = path.join(root, "characters");
    const store = new CharacterStore({ isPackaged: false }, {});
    assert.equal(store.root, path.join(root, "characters"));
    assert.equal(store.settingsPath, path.join(root, "companion-settings.json"));
  } finally {
    if (previous == null) delete process.env.HARBOUR_CHARACTER_HOME;
    else process.env.HARBOUR_CHARACTER_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("profile download is pinned, bounded, hash checked and cleaned", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-live2d-download-test-"));
  const payloads = fixtureFiles();
  const profile = fixtureProfile(payloads);
  const plan = profileDownloadPlan(profile);
  assert.equal(plan.length, payloads.size);
  assert.ok(plan.every((entry) => entry.url.includes(profile.source.mirrorCommit)));
  const byUrl = new Map(plan.map((entry) => [entry.url, payloads.get(entry.file)]));
  const downloaded = await downloadProfileSource(profile, {
    tempParent: root,
    fetchImpl: async (url) => response(byUrl.get(url), url),
  });
  try {
    assert.equal(verifyProfileSource(downloaded.root, profile).spec.files.length, payloads.size);
  } finally {
    downloaded.cleanup();
  }
  assert.deepEqual(fs.readdirSync(root), []);

  const corrupted = fixtureProfile(payloads);
  corrupted.integrity.files["Fixture.moc3"] = "0".repeat(64);
  await assert.rejects(downloadProfileSource(corrupted, {
    tempParent: root,
    fetchImpl: async (url) => response(byUrl.get(url), url),
  }), /sha256 mismatch/);
  assert.deepEqual(fs.readdirSync(root), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("transient network failures retry without weakening integrity checks", async () => {
  const body = Buffer.from("verified payload");
  const url = "https://raw.githubusercontent.com/example/repo/" + "a".repeat(40) + "/file.bin";
  let attempts = 0;
  const result = await fetchBoundedWithRetry(url, {
    maxBytes: 1024,
    expectedSha256: digest(body),
    allowedHost: "raw.githubusercontent.com",
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      return response(body, url);
    },
  }, 3);
  assert.equal(result.sha256, digest(body));
  assert.equal(attempts, 2);
});

test("no-source install works once and ensure becomes a network-free no-op", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-live2d-install-test-"));
  const payloads = fixtureFiles();
  const profile = fixtureProfile(payloads);
  const core = Buffer.alloc(100_001, 32);
  core.write("/* Live2D Cubism Core */");
  profile.integrity.cubismCoreSha256 = digest(core);
  const profilePath = path.join(root, "fixture-profile.json");
  const characterHome = path.join(root, "characters");
  const tempParent = path.join(root, "downloads");
  const adapter = path.join(root, "adapter.js");
  fs.mkdirSync(tempParent);
  fs.writeFileSync(profilePath, JSON.stringify(profile));
  fs.writeFileSync(adapter, "window.HarbourLive2D = {};");
  const plan = profileDownloadPlan(profile);
  const byUrl = new Map(plan.map((entry) => [entry.url, payloads.get(entry.file)]));
  const fetchImpl = async (url) => {
    if (url === CORE_URL) return response(core, url);
    const body = byUrl.get(url);
    if (!body) return response(Buffer.from("missing"), url, 404);
    return response(body, url);
  };
  const options = {
    profilePath,
    env: { HARBOUR_CHARACTER_HOME: characterHome },
    platform: process.platform,
    homedir: os.homedir(),
    fetchImpl,
    tempParent,
    adapterBuilder: () => adapter,
  };
  const installed = await installLive2dPack(options);
  assert.equal(installed.downloaded, true);
  assert.equal(installedPackStatus(options).installed, true);
  assert.deepEqual(fs.readdirSync(tempParent), []);

  let fetches = 0;
  const ensured = await ensureLive2dPack({ ...options, fetchImpl: async () => { fetches += 1; throw new Error("offline"); } });
  assert.equal(ensured.noOp, true);
  assert.equal(fetches, 0);

  fs.writeFileSync(path.join(characterHome, "fixture", "live2d", "fixture-pack", "Fixture.moc3"), "corrupt");
  assert.equal(installedPackStatus(options).installed, false);
  const skipped = await ensureLive2dPack({
    ...options,
    env: { HARBOUR_CHARACTER_HOME: characterHome, HARBOUR_LIVE2D_AUTO_INSTALL: "0" },
    fetchImpl: async () => { fetches += 1; throw new Error("must not fetch"); },
  });
  assert.equal(skipped.skipped, true);
  assert.equal(fetches, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("real Elaina profile pins every locally installed source file when available", (t) => {
  const profile = readProfile();
  const localSource = path.join(resolveCharacterHome(), "elaina", "live2d", "elaina-lss");
  if (!fs.existsSync(localSource)) return t.skip("local LSS package is not installed");
  assert.equal(verifyProfileSource(localSource, profile).spec.files.length, 22);
});
