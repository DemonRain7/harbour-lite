const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { resolveHarbourDataRoot } = require("./platform-paths");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const SAFE_ID = /^[a-z0-9_-]{3,80}$/;

const BUILT_INS = [
  { id: "harbour-happy", label: "完成啦", mood: "happy", tags: ["开心", "成功", "完成", "好耶", "赞", "happy", "done"], glyph: "✦", color: "#ef5b96" },
  { id: "harbour-thinking", label: "让我想想", mood: "focused", tags: ["思考", "想想", "分析", "研究", "thinking"], glyph: "…", color: "#8b71e8" },
  { id: "harbour-curious", label: "欸？", mood: "curious", tags: ["疑问", "为什么", "什么", "欸", "好奇", "question"], glyph: "?", color: "#5f92ef" },
  { id: "harbour-care", label: "别担心", mood: "concerned", tags: ["担心", "小心", "抱歉", "失败", "难过", "care"], glyph: "♡", color: "#e0935d" },
];

function svgFor(sticker) {
  const label = sticker.label.replace(/[&<>"']/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${sticker.color}" stop-opacity=".98"/><stop offset="1" stop-color="#17131f"/></linearGradient></defs><rect x="10" y="10" width="300" height="220" rx="58" fill="url(#g)"/><circle cx="160" cy="94" r="54" fill="#fff" fill-opacity=".14"/><text x="160" y="119" text-anchor="middle" font-size="72" font-family="Segoe UI Symbol, sans-serif" fill="#fff">${sticker.glyph}</text><text x="160" y="190" text-anchor="middle" font-size="25" font-family="Segoe UI, sans-serif" fill="#fff">${label}</text></svg>`;
}

class StickerStore {
  constructor(app) {
    this.root = path.join(resolveHarbourDataRoot(), "stickers");
    this.manifestPath = path.join(this.root, "manifest.json");
    fs.mkdirSync(this.root, { recursive: true });
    this.manifest = this.load();
    this.ensureBuiltIns();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.manifestPath, "utf8"));
      return { schemaVersion: 1, stickers: Array.isArray(parsed.stickers) ? parsed.stickers : [] };
    } catch {
      return { schemaVersion: 1, stickers: [] };
    }
  }

  save() {
    const tmp = `${this.manifestPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.manifest, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, this.manifestPath);
  }

  ensureBuiltIns() {
    let changed = false;
    for (const builtIn of BUILT_INS) {
      const file = `${builtIn.id}.svg`;
      const target = path.join(this.root, file);
      if (!fs.existsSync(target)) fs.writeFileSync(target, svgFor(builtIn), "utf8");
      const existing = this.manifest.stickers.find((item) => item.id === builtIn.id);
      if (!existing) {
        this.manifest.stickers.push({ ...builtIn, file, enabled: true, builtIn: true, phrases: builtIn.tags });
        changed = true;
      }
    }
    if (changed) this.save();
  }

  list(companionId = "elaina") {
    return this.manifest.stickers.map(({ file: _file, ...item }) => ({
      ...item,
      url: `harbour-sticker://${encodeURIComponent(companionId)}/${encodeURIComponent(item.id)}`,
    }));
  }

  resolve(id) {
    const clean = String(id || "");
    if (!SAFE_ID.test(clean)) return null;
    const item = this.manifest.stickers.find((sticker) => sticker.id === clean);
    if (!item) return null;
    const file = path.resolve(this.root, item.file);
    return file.startsWith(`${path.resolve(this.root)}${path.sep}`) && fs.existsSync(file) ? file : null;
  }

  importFile(source, input = {}) {
    const ext = path.extname(source).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) throw new Error("只支持 PNG/JPG/GIF/WebP 表情包");
    const stat = fs.statSync(source);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 20 * 1024 * 1024) throw new Error("表情包必须小于 20 MB");
    const base = String(input.id || path.basename(source, ext)).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56);
    const hash = createHash("sha256").update(fs.readFileSync(source)).digest("hex").slice(0, 8);
    const id = SAFE_ID.test(base) && !this.manifest.stickers.some((item) => item.id === base) ? base : `sticker-${hash}`;
    if (this.manifest.stickers.some((item) => item.id === id)) throw new Error("这个表情包已经存在");
    const file = `${id}${ext}`;
    fs.copyFileSync(source, path.join(this.root, file));
    const phrases = Array.isArray(input.phrases)
      ? input.phrases.map((value) => String(value).trim().slice(0, 80)).filter(Boolean).slice(0, 24)
      : String(input.phrases || "").split(/[,，\n]/u).map((value) => value.trim()).filter(Boolean).slice(0, 24);
    const item = { id, label: String(input.label || path.basename(source, ext)).trim().slice(0, 80), mood: String(input.mood || "calm").slice(0, 30), tags: phrases, phrases, file, enabled: true, builtIn: false, createdAt: Date.now() };
    this.manifest.stickers.push(item);
    this.save();
    return this.list().find((row) => row.id === id);
  }

  setEnabled(id, enabled) {
    const item = this.manifest.stickers.find((sticker) => sticker.id === id);
    if (!item) return false;
    item.enabled = !!enabled;
    this.save();
    return true;
  }

  remove(id) {
    const index = this.manifest.stickers.findIndex((sticker) => sticker.id === id);
    if (index < 0 || this.manifest.stickers[index].builtIn) return false;
    const [item] = this.manifest.stickers.splice(index, 1);
    try { fs.unlinkSync(path.join(this.root, item.file)); } catch { /* ignore */ }
    this.save();
    return true;
  }

  match(companionId, text, mood) {
    const source = String(text || "").toLocaleLowerCase();
    let best = null;
    for (const sticker of this.manifest.stickers) {
      if (sticker.enabled === false) continue;
      let score = sticker.mood === mood ? 3 : 0;
      for (const phrase of sticker.phrases || sticker.tags || []) {
        const token = String(phrase).toLocaleLowerCase().trim();
        if (token && source.includes(token)) score += Math.min(4, Math.max(1, token.length / 2));
      }
      if (score >= 3 && (!best || score > best.score)) best = { sticker, score };
    }
    return best ? { id: best.sticker.id, label: best.sticker.label, url: `harbour-sticker://${encodeURIComponent(companionId)}/${encodeURIComponent(best.sticker.id)}` } : null;
  }
}

module.exports = { StickerStore, BUILT_INS };
