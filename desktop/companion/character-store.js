const fs = require("node:fs");
const path = require("node:path");
const { resolveCharacterHome, resolveHarbourDataRoot } = require("./platform-paths");

const CHARACTER_ID = /^[a-z0-9_-]+$/i;

function defaultManifest(character) {
  const id = character.id;
  return {
    schemaVersion: 2,
    id,
    agent: character.agentName,
    displayName: character.displayName,
    visual: {
      preferred: "pixel",
      fallback: "pixel",
      live2d: {
        enabled: false,
        model: `live2d/${character.displayName}.model3.json`,
        runtime: "live2d/live2dcubismcore.min.js",
        adapter: "live2d/harbour-cubism-adapter.js",
        parameters: {
          mouthOpen: "ParamMouthOpenY",
          angleX: "ParamAngleX",
          angleY: "ParamAngleY",
          eyeBallX: "ParamEyeBallX",
          eyeBallY: "ParamEyeBallY",
        },
        actions: {},
      },
      pixel: { manifest: `assets/pets/${id}/pet.json` },
    },
    voice: {
      enabled: false,
      provider: "harbour-remote",
      contentPolicy: "passthrough",
      allowedSources: ["web", "discord", "qq"],
      maxQueuedChunks: 4,
      maxChunkChars: 220,
    },
  };
}

class CharacterStore {
  constructor(app, catalog) {
    this.app = app;
    this.root = resolveCharacterHome();
    const dataRoot = process.env.HARBOUR_CHARACTER_HOME
      ? path.dirname(this.root)
      : resolveHarbourDataRoot();
    this.settingsPath = path.join(dataRoot, "companion-settings.json");
    this.catalog = catalog;
  }

  adapterSource() {
    if (this.app.isPackaged) return path.join(process.resourcesPath, "web", "harbour-cubism-adapter.js");
    // Taskbar/Desktop shortcuts intentionally launch Electron directly so no console window is
    // left behind. That bypasses `npm start`, therefore make the development app self-sufficient:
    // build the tiny browser adapter on first launch (and after its source changes) before the
    // character package is installed. Failure remains a safe pixel fallback.
    try {
      return require("./build-live2d").buildLive2DAdapter({ logLevel: "silent" });
    } catch {
      return path.join(__dirname, "..", "..", "web", "harbour-cubism-adapter.js");
    }
  }

  ensureAdapter(dir) {
    const adapter = this.adapterSource();
    if (!fs.existsSync(adapter)) return false;
    const target = path.join(dir, "live2d", "harbour-cubism-adapter.js");
    fs.copyFileSync(adapter, target);
    return true;
  }

  syncInstalledProfile(character, dir) {
    const manifestPath = path.join(dir, "manifest.json");
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { return false; }
    const installed = manifest.visual?.live2d || {};
    const packageId = String(installed.packageId || "").toLowerCase();
    if (!CHARACTER_ID.test(packageId)) return false;
    const profilePath = path.join(__dirname, "profiles", `${packageId}.json`);
    let profile;
    try { profile = JSON.parse(fs.readFileSync(profilePath, "utf8")); } catch { return false; }
    const source = profile?.visual || {};
    const installedVersion = Number(installed.behaviorVersion) || 0;
    const sourceVersion = Number(source.behaviorVersion) || 0;
    if (profile.characterId !== character.id || sourceVersion <= installedVersion) return false;
    const next = {
      ...manifest,
      visual: {
        ...(manifest.visual || {}),
        live2d: {
          ...installed,
          behaviorVersion: sourceVersion,
          propStyle: source.propStyle || "none",
          parameters: source.parameters || installed.parameters || {},
          actions: source.actions || {},
          interactions: source.interactions || {},
        },
      },
    };
    const temp = `${manifestPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, manifestPath);
    const interactionsPath = path.join(dir, "interactions.json");
    fs.writeFileSync(interactionsPath, `${JSON.stringify({
      schemaVersion: 2,
      packageId,
      ...(source.interactions || {}),
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return true;
  }

  migrateLegacyPreview(character, dir) {
    const manifestPath = path.join(dir, "manifest.json");
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { return; }
    const live2d = manifest.visual?.live2d || {};
    const isLegacyPreview = live2d.previewPackage === "cyrene-preview"
      || /(?:^|[/\\])cyrene-preview(?:[/\\]|$)/i.test(String(live2d.model || ""));
    if (!isLegacyPreview) return;
    const defaults = defaultManifest(character);
    manifest = {
      ...manifest,
      visual: {
        ...(manifest.visual || {}),
        preferred: "pixel",
        fallback: "pixel",
        live2d: {
          ...defaults.visual.live2d,
          assetLabel: "尚未安装本机 Live2D 角色包",
        },
      },
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const licensePath = path.join(dir, "license.json");
    let license = {};
    try { license = JSON.parse(fs.readFileSync(licensePath, "utf8")); } catch { /* reset below */ }
    if (license.previewPackage === "cyrene-preview") {
      fs.writeFileSync(licensePath, `${JSON.stringify({
        character: character.displayName,
        status: "user-supplied-assets-required",
        notes: "Live2D models and Cubism Core stay in this local character directory and are not bundled with Harbour.",
      }, null, 2)}\n`, "utf8");
    }
  }

  live2dAssetsReady(dir, config) {
    if (!config || config.enabled !== true) return false;
    const required = [config.model, config.runtime, config.adapter]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    if (required.length !== 3) return false;
    return required.every((relative) => {
      const resolved = path.resolve(dir, relative);
      return (resolved === dir || resolved.startsWith(`${dir}${path.sep}`))
        && fs.existsSync(resolved)
        && fs.statSync(resolved).isFile();
    });
  }

  characterDir(id) {
    const clean = String(id || "").toLowerCase();
    if (!CHARACTER_ID.test(clean)) throw new Error("invalid character id");
    return path.join(this.root, clean);
  }

  ensureCharacter(character) {
    const dir = this.characterDir(character.id);
    fs.mkdirSync(path.join(dir, "live2d"), { recursive: true });
    fs.mkdirSync(path.join(dir, "voice"), { recursive: true });
    const files = [
      ["manifest.json", defaultManifest(character)],
      ["license.json", {
        character: character.displayName,
        status: "user-supplied-assets-required",
        notes: "Record the source and redistribution terms for every local Live2D/TTS asset here. Harbour does not bundle third-party character assets.",
      }],
      ["interactions.json", {
        schemaVersion: 1,
        hotspots: [],
        motions: { idle: [], running: [], waiting: [], complete: [], error: [], speaking: [] },
      }],
    ];
    for (const [name, value] of files) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    }
    this.migrateLegacyPreview(character, dir);
    this.syncInstalledProfile(character, dir);
    this.ensureAdapter(dir);
    return dir;
  }

  readCharacter(id) {
    const character = this.catalog[id];
    if (!character) throw new Error(`unknown character: ${id}`);
    const dir = this.ensureCharacter(character);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    const defaults = defaultManifest(character);
    const settings = this.readSettings();
    const visualMode = settings.characters?.[id]?.visualMode || manifest.visual?.preferred || "pixel";
    const live2dConfig = { ...defaults.visual.live2d, ...(manifest.visual?.live2d || {}) };
    const live2dAvailable = this.live2dAssetsReady(dir, live2dConfig);
    return {
      directory: dir,
      manifest: {
        ...defaults,
        ...manifest,
        visual: {
          ...defaults.visual,
          ...(manifest.visual || {}),
          preferred: visualMode,
          live2d: {
            ...live2dConfig,
            available: live2dAvailable,
            enabled: visualMode === "live2d" && live2dAvailable,
            assetLabel: live2dAvailable
              ? (live2dConfig.assetLabel || "本机 Live2D 角色包")
              : "Live2D 模型或 Cubism Core 尚未安装；当前使用像素桌宠",
          },
          pixel: { ...defaults.visual.pixel, ...(manifest.visual?.pixel || {}) },
        },
        voice: {
          ...defaults.voice,
          ...(manifest.voice || {}),
          // 推理位置统一由 Harbour 后端决定；旧角色包中的 qwen/gptSovits 字段仅作为遗留数据忽略。
          provider: "harbour-remote",
        },
      },
    };
  }

  readSettings() {
    const fallback = {
      schemaVersion: 2,
      voiceEnabled: false,
      characters: {},
      appearance: {
        followDashboard: true,
        alwaysOnTop: true,
        category: "anime",
        persona: "elaina",
        theme: "anime-wisteria",
        chatStyle: "flowing",
        bubbleStyle: "glass",
        font: "system",
      },
    };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.settingsPath, "utf8"));
      return {
        ...fallback,
        ...parsed,
        characters: parsed.characters || {},
        appearance: { ...fallback.appearance, ...(parsed.appearance || {}) },
      };
    } catch {
      return fallback;
    }
  }

  writeSettings(next) {
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    const temp = `${this.settingsPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, this.settingsPath);
    return next;
  }

  appearance() {
    return this.readSettings().appearance;
  }

  setAppearance(patch) {
    const settings = this.readSettings();
    const allowed = {
      followDashboard: typeof patch?.followDashboard === "boolean"
        ? patch.followDashboard
        : settings.appearance.followDashboard !== false,
      alwaysOnTop: typeof patch?.alwaysOnTop === "boolean"
        ? patch.alwaysOnTop
        : settings.appearance.alwaysOnTop !== false,
      category: String(patch?.category || settings.appearance.category).slice(0, 40),
      persona: String(patch?.persona || settings.appearance.persona).slice(0, 40),
      theme: String(patch?.theme || settings.appearance.theme).slice(0, 80),
      chatStyle: ["flowing", "compact", "cards"].includes(patch?.chatStyle) ? patch.chatStyle : settings.appearance.chatStyle,
      bubbleStyle: ["glass", "paper", "minimal"].includes(patch?.bubbleStyle) ? patch.bubbleStyle : settings.appearance.bubbleStyle,
      font: ["system", "rounded", "serif", "mono"].includes(patch?.font) ? patch.font : settings.appearance.font,
    };
    this.writeSettings({ ...settings, appearance: allowed });
    return allowed;
  }

  setVisualMode(id, visualMode) {
    if (!this.catalog[id] || !["live2d", "pixel"].includes(visualMode)) return false;
    const settings = this.readSettings();
    const characters = { ...settings.characters, [id]: { ...(settings.characters?.[id] || {}), visualMode } };
    this.writeSettings({ ...settings, characters });
    return true;
  }

  voiceEnabled(id) {
    const { manifest } = this.readCharacter(id);
    const settings = this.readSettings();
    const local = settings.characters?.[id]?.voiceEnabled;
    return settings.voiceEnabled !== false && (typeof local === "boolean" ? local : manifest.voice?.enabled === true);
  }

  setVoiceEnabled(id, enabled) {
    const settings = this.readSettings();
    const characters = { ...settings.characters, [id]: { ...(settings.characters?.[id] || {}), voiceEnabled: !!enabled } };
    return this.writeSettings({ ...settings, voiceEnabled: true, characters });
  }
}

module.exports = { CharacterStore, defaultManifest };
