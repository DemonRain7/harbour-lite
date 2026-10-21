const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { resolveHarbourDataRoot } = require("./platform-paths");

const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".m4a", ".aac", ".wav", ".ogg", ".opus", ".webm"]);
const TRACK_ID = /^[a-f0-9]{20}$/;
const MUSIC_PROVIDERS = new Set(["local", "qqmusic", "folia"]);

function cleanText(value, max = 240) {
  return String(value || "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, max);
}

class MusicStore {
  constructor(app) {
    this.root = path.join(resolveHarbourDataRoot(), "music");
    this.tracksDir = path.join(this.root, "tracks");
    this.manifestPath = path.join(this.root, "library.json");
    fs.mkdirSync(this.tracksDir, { recursive: true });
    this.library = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.manifestPath, "utf8"));
      return {
        schemaVersion: 2,
        provider: MUSIC_PROVIDERS.has(parsed.provider) ? parsed.provider : "local",
        tracks: Array.isArray(parsed.tracks)
          ? parsed.tracks.filter((track) => TRACK_ID.test(String(track.id || "")) && fs.existsSync(path.join(this.tracksDir, track.file)))
          : [],
      };
    } catch {
      return { schemaVersion: 2, provider: "folia", tracks: [] };
    }
  }

  save() {
    fs.mkdirSync(this.root, { recursive: true });
    const tmp = `${this.manifestPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.library, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, this.manifestPath);
  }

  list() {
    return this.library.tracks.map(({ file: _file, ...track }) => ({ ...track, url: `harbour-music://track/${track.id}` }));
  }

  getProvider() {
    return MUSIC_PROVIDERS.has(this.library.provider) ? this.library.provider : "local";
  }

  setProvider(provider) {
    const next = String(provider || "").toLowerCase();
    if (!MUSIC_PROVIDERS.has(next)) throw new Error(`不支持的音乐来源：${next}`);
    if (this.getProvider() === next) return next;
    this.library.provider = next;
    this.save();
    return next;
  }

  resolve(id) {
    const clean = String(id || "");
    if (!TRACK_ID.test(clean)) return null;
    const track = this.library.tracks.find((item) => item.id === clean);
    if (!track) return null;
    const file = path.resolve(this.tracksDir, track.file);
    return file.startsWith(`${path.resolve(this.tracksDir)}${path.sep}`) && fs.existsSync(file) ? file : null;
  }

  importFiles(files) {
    const imported = [];
    const available = Math.max(0, 1_000 - this.library.tracks.length);
    for (const source of files.slice(0, Math.min(200, available))) {
      const stat = fs.statSync(source);
      const ext = path.extname(source).toLowerCase();
      if (!stat.isFile() || !AUDIO_EXTENSIONS.has(ext) || stat.size <= 0 || stat.size > 1024 * 1024 * 1024) continue;
      const seed = `${path.basename(source)}\u0000${stat.size}\u0000${stat.mtimeMs}\u0000${randomUUID()}`;
      const id = createHash("sha256").update(seed).digest("hex").slice(0, 20);
      const file = `${id}${ext}`;
      fs.copyFileSync(source, path.join(this.tracksDir, file));
      const title = cleanText(path.basename(source, ext));
      const track = { id, title, artist: "本地音乐", album: "Harbour Library", file, bytes: stat.size, importedAt: Date.now() };
      this.library.tracks.push(track);
      imported.push({ ...track, file: undefined, url: `harbour-music://track/${id}` });
    }
    if (imported.length) this.save();
    return imported.map(({ file: _file, ...track }) => track);
  }

  remove(id) {
    const index = this.library.tracks.findIndex((track) => track.id === id);
    if (index < 0) return false;
    const [track] = this.library.tracks.splice(index, 1);
    try { fs.unlinkSync(path.join(this.tracksDir, track.file)); } catch { /* file may already be gone */ }
    this.save();
    return true;
  }
}

module.exports = { MusicStore, AUDIO_EXTENSIONS, MUSIC_PROVIDERS };
