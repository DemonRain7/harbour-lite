import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

// Space is an owner-only library, not model memory or a second generation ledger.
// Files are copied byte-for-byte out of expiring uploads; existing jobs stay untouched.
export type SpaceKind = "image" | "comic" | "document" | "file";
export interface SpaceFile { id: string; name: string; mime: string; size: number; caption?: string; sourceKey?: string; presentation?: "comic-page" }
export interface SpaceEntry {
  id: string; title: string; kind: SpaceKind; files: SpaceFile[];
  createdAt: string; updatedAt: string; revision: number; favorite: boolean;
  collectionId: string | null; source: "generation" | "conversation" | "upload";
  status: string; expectedFiles?: number;
  sourceKeys?: string[];
}
interface SpaceIndex {
  version: 1; entries: SpaceEntry[];
  collections: Array<{ id: string; name: string }>;
  fingerprints: Record<string, string>;
}
const FORMATS: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".pdf": "application/pdf", ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv", ".html": "text/html",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav",
};
export const MAX_SPACE_FILE_BYTES = 40 * 1024 * 1024;
const digest = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const obj = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const arr = (v: unknown): any[] => Array.isArray(v) ? v : [];
const cleanName = (s: unknown, fallback = "未命名作品") => String(s ?? "").replace(/[\x00-\x1f]/g, "").trim().slice(0, 180) || fallback;
const inside = (root: string, file: string) => { const rel = path.relative(root, file); return !!rel && !rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel); };
const iso = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : new Date().toISOString();
export class SpaceError extends Error { constructor(message: string, public status = 400) { super(message); } }

export class SpaceStore {
  readonly directory: string;
  private index?: SpaceIndex;
  private tail: Promise<unknown> = Promise.resolve();
  private scannedAt = 0;
  private syncing?: Promise<{ imported: number; unavailable: number }>;
  private archives = new Map<string, Promise<void>>();
  constructor(readonly root: string, readonly uploadDir = path.join(root, "assets/uploads")) {
    this.directory = path.join(root, "data/spaces");
  }
  private async load(): Promise<SpaceIndex> {
    if (this.index) return this.index;
    try {
      const value = JSON.parse(await fs.readFile(path.join(this.directory, "index.json"), "utf8"));
      if (value.version !== 1 || !Array.isArray(value.entries) || !Array.isArray(value.collections) || !value.fingerprints) throw new Error("invalid index");
      this.index = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new SpaceError("空间索引无法读取；已保留原文件，请检查后重试。", 500);
      this.index = { version: 1, entries: [], collections: [], fingerprints: {} };
    }
    return this.index!;
  }
  private change<T>(fn: (index: SpaceIndex) => Promise<T> | T): Promise<T> {
    const task = this.tail.then(async () => {
      const original = await this.load(), next = structuredClone(original);
      const result = await fn(next);
      await fs.mkdir(this.directory, { recursive: true });
      const file = path.join(this.directory, "index.json"), temp = file + "." + randomUUID() + ".tmp";
      try { await fs.writeFile(temp, JSON.stringify(next), { flag: "wx" }); await fs.rename(temp, file); }
      finally { await fs.unlink(temp).catch(() => {}); }
      this.index = next;
      return result;
    });
    this.tail = task.catch(() => {});
    return task;
  }
  private async sourceFile(ref: string): Promise<string> {
    if (!ref || /^(?:https?:|data:|file:|javascript:)/i.test(ref)) throw new SpaceError("仅归档本机已交付文件，外链不会自动下载");
    let candidate: string;
    try {
      const raw = decodeURIComponent(ref.replace(/[?#].*$/, ""));
      candidate = raw.startsWith("/uploads/") ? path.resolve(this.uploadDir, raw.slice(9)) : path.resolve(this.root, raw);
    } catch { throw new SpaceError("无效文件引用"); }
    const real = await fs.realpath(candidate);
    const roots = await Promise.all([this.root, this.uploadDir].map(p => fs.realpath(p).catch(() => path.resolve(p))));
    if (!roots.some(r => inside(r, real))) throw new SpaceError("文件不在 Harbour 的归档范围内", 403);
    const rel = path.relative(inside(roots[0]!, real) ? roots[0]! : roots[1]!, real).replace(/\\/g, "/");
    if (/(^|\/)\.[^/]+/.test(rel) || /^(?:agents|skills|workflows|mcp|data|assets\/Memory|node_modules)\//i.test(rel)) {
      throw new SpaceError("配置、记忆和运行数据不能作为作品自动归档", 403);
    }
    if (!FORMATS[path.extname(real).toLowerCase()]) throw new SpaceError("不支持的作品文件类型");
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size > MAX_SPACE_FILE_BYTES) throw new SpaceError("文件不是普通文件或超过 40 MB");
    return real;
  }
  private async archiveBytes(bytes: Buffer, name: string, caption?: string): Promise<SpaceFile> {
    const ext = path.extname(name).toLowerCase(), mime = FORMATS[ext];
    if (!mime || !bytes.length || bytes.length > MAX_SPACE_FILE_BYTES) throw new SpaceError("文件格式不支持、内容为空或超过 40 MB");
    const id = digest(bytes) + ext;
    const dir = path.join(this.directory, "files"); await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, id);
    // Share in-flight writes, especially on Windows where concurrent rename is EPERM.
    let pending = this.archives.get(id);
    if (!pending) {
      pending = (async () => {
        try { await fs.access(target); return; } catch { /* first copy */ }
        const temp = path.join(dir, "." + randomUUID());
        try { await fs.writeFile(temp, bytes, { flag: "wx" }); await fs.rename(temp, target); }
        finally { await fs.unlink(temp).catch(() => {}); }
      })().finally(() => this.archives.delete(id));
      this.archives.set(id, pending);
    }
    await pending;
    return { id, name: cleanName(path.basename(name)), mime, size: bytes.length, ...(caption ? { caption: caption.slice(0, 2000) } : {}) };
  }
  private async archiveRef(ref: string, caption?: string): Promise<SpaceFile> {
    const file = await this.sourceFile(ref);
    return { ...await this.archiveBytes(await fs.readFile(file), path.basename(file), caption), sourceKey: digest(ref) };
  }
  private async upsert(key: string, input: Omit<SpaceEntry, "id" | "revision" | "favorite" | "collectionId">): Promise<boolean> {
    const id = digest(key).slice(0, 32);
    return this.change(index => {
      const old = index.entries.find(e => e.id === id);
      if (old && JSON.stringify([old.files, old.status, old.sourceKeys]) === JSON.stringify([input.files, input.status, input.sourceKeys])) return false;
      const entry: SpaceEntry = { ...input, id, favorite: old?.favorite ?? false, collectionId: old?.collectionId ?? null, revision: (old?.revision ?? 0) + 1 };
      if (old) { entry.title = old.title; entry.createdAt = old.createdAt; index.entries[index.entries.indexOf(old)] = entry; }
      else index.entries.push(entry);
      // Once a real job groups the files, don't leave duplicate loose conversation images.
      if (input.source === "generation") index.entries = index.entries.filter(e => {
        const absorbed = e.id !== id && e.source === "conversation" && e.files.every(f => input.files.some(g => g.id === f.id) || (f.sourceKey && input.sourceKeys?.includes(f.sourceKey)));
        if (absorbed) { entry.favorite ||= e.favorite; entry.collectionId ||= e.collectionId; }
        return !absorbed;
      });
      return !old;
    });
  }
  async sync(force = false): Promise<{ imported: number; unavailable: number }> {
    if (this.syncing) return this.syncing;
    if (!force && Date.now() - this.scannedAt < 30_000) return { imported: 0, unavailable: 0 };
    this.syncing = this.discover().finally(() => { this.syncing = undefined; });
    return this.syncing;
  }
  private async discover() {
    let imported = 0, unavailable = 0;
    for (const kind of ["comic", "image"] as const) {
      const dir = path.join(this.root, "data", kind === "comic" ? "comicJobs" : "novelAiImageSets");
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
      for (const item of entries) {
        if (!item.isFile() || !item.name.endsWith(".json")) continue;
        const file = path.join(dir, item.name), stat = await fs.stat(file), key = `${kind}:${item.name}`;
        if (stat.size > 8 * 1024 * 1024) { unavailable++; continue; }
        // v3 reprojects existing comics from composed pages to their original panels.
        const signature = `${kind === "comic" ? 3 : 2}:${stat.mtimeMs}:${stat.size}`;
        if ((await this.load()).fingerprints[key] === signature) continue;
        try {
          const job = obj(JSON.parse(await fs.readFile(file, "utf8")));
          if (job.schemaVersion !== 1 || typeof job.id !== "string" || typeof job.ownerKey !== "string") continue;
          type Ref = { ref: string; caption?: string; presentation?: "comic-page" };
          let refs: Ref[] = [];
          const pageRefs: Ref[] = kind === "comic" ? arr(obj(job.artifacts).pages)
            .filter(p => typeof obj(p).url === "string").map(p => ({ ref: p.url, presentation: "comic-page" })) : [];
          if (kind === "comic") {
            for (const p of arr(job.panels).sort((a, b) => Number(a.number) - Number(b.number))) {
              const a = obj(p.asset);
              if (p.status === "completed" && typeof a.url === "string") refs.push({ ref: a.url, caption: [p.caption, p.narration, ...arr(p.dialogue).map(d => `${d.speaker}: ${d.text}`)].filter(Boolean).join("\n") });
            }
            if (!refs.length) refs = pageRefs;
          } else for (const g of arr(job.groups).sort((a, b) => Number(a.index) - Number(b.index))) {
            for (const a of arr(g.artifacts)) if (typeof a.url === "string") refs.push({ ref: a.url, caption: typeof g.caption === "string" ? g.caption : undefined });
          }
          const index = await this.load();
          const previous = index.entries.find(e => e.id === digest(key).slice(0, 32));
          const archived = new Map(index.entries.flatMap(e => e.files.filter(f => f.sourceKey).map(f => [f.sourceKey!, f] as const)));
          const readRef = async (ref: Ref): Promise<SpaceFile> => {
            let file: SpaceFile;
            try { file = await this.archiveRef(ref.ref, ref.caption); }
            catch (error) {
              // A panel may already have been archived from its chat delivery.
              const saved = archived.get(digest(ref.ref));
              if (!saved) throw error;
              file = { ...saved, ...(ref.caption ? { caption: ref.caption.slice(0, 2000) } : {}) };
            }
            return { ...file, ...(ref.presentation ? { presentation: ref.presentation } : {}) };
          };
          let files: SpaceFile[] = []; let missing = false;
          for (const ref of refs) {
            try { files.push(await readRef(ref)); }
            catch {
              missing = true; unavailable++;
            }
          }
          if (missing && pageRefs.length && refs !== pageRefs) {
            // Never replace an intact archived book with only some recoverable panels.
            const pages = await Promise.all(pageRefs.map(ref => readRef(ref).catch(() => undefined)));
            if (pages.every((page): page is SpaceFile => !!page)) { files = pages; refs = pageRefs; }
            else if (previous?.files.some(f => pageRefs.some(r => f.sourceKey === digest(r.ref)))) {
              files = previous.files.map(f => ({ ...f, presentation: "comic-page" })); refs = pageRefs;
            }
          }
          if (files.length) {
            const added = await this.upsert(key, { title: cleanName(job.title), kind, files, source: "generation",
              status: missing ? "incomplete" : String(job.status || "completed"), createdAt: iso(job.createdAt), updatedAt: iso(job.updatedAt),
              expectedFiles: kind === "image" ? Number(job.totalImages) || files.length : refs.length,
              sourceKeys: [...new Set([...refs.map(r => digest(r.ref)), ...pageRefs.map(r => digest(r.ref)), ...(kind === "comic" ? arr(job.panels).flatMap(p => typeof obj(p.asset).url === "string" ? [digest(obj(p.asset).url)] : []) : [])])] });
            if (added) imported++;
          }
          // Missing assets may arrive later even when the job JSON has not changed.
          if (!missing) await this.change(index => { index.fingerprints[key] = signature; });
        } catch { unavailable++; }
      }
    }
    // Backfill delivered documents from owner conversations, not memories, prompts or traces.
    // Only changed files are read; no model work and no network requests.
    const sessions = path.join(this.root, "data/sessions");
    const names = await fs.readdir(sessions).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith("_")) continue;
      const file = path.join(sessions, name), stat = await fs.stat(file), key = `session:${name}`, signature = `${stat.mtimeMs}:${stat.size}`;
      if ((await this.load()).fingerprints[key] === signature) continue;
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024) { unavailable++; continue; }
      try {
        const session = obj(JSON.parse(await fs.readFile(file, "utf8")));
        let owner = obj(session.origin).actorRole === "owner";
        for (const m of arr(session.messages)) {
          if (m.role === "user") owner = m.actor ? obj(m.actor).role === "owner" : obj(session.origin).actorRole === "owner";
          else if (owner && m.role === "assistant" && typeof m.content === "string") {
            const result = await this.captureText(m.content, cleanName(session.title), iso(session.updatedAt));
            imported += result.imported; unavailable += result.unavailable;
          }
        }
        await this.change(index => { index.fingerprints[key] = signature; });
      } catch { unavailable++; }
    }
    this.scannedAt = Date.now();
    return { imported, unavailable };
  }
  async captureDelivery(text: string, title: string): Promise<void> {
    // Do not rescan the full historic library in the latency-sensitive reply path.
    await this.captureText(text, title);
  }
  private async captureText(text: string, title: string, createdAt = iso(undefined)) {
    const refs = new Set<string>();
    for (const m of text.matchAll(/!?\[[^\]]*\]\(<?([^>\n]+?)>?(?:\s+"[^"]*")?\)/g)) refs.add(m[1]!.trim());
    for (const m of text.matchAll(/(?:\/uploads\/|assets\/)[^\s<>"')]+/g)) refs.add(m[0].replace(/[*_~`，。；！？]+$/u, ""));
    let imported = 0, unavailable = 0;
    for (const ref of [...refs].slice(0, 80)) {
      if (/^(?:https?:|data:|file:|javascript:)/i.test(ref)) continue;
      try {
        if ((await this.load()).entries.some(e => e.sourceKeys?.includes(digest(ref)))) continue;
        const file = await this.archiveRef(ref);
        if ((await this.load()).entries.some(e => e.files.some(f => f.id === file.id))) continue;
        const added = await this.upsert(`file:${file.id}`, { title: file.mime.startsWith("image/") ? cleanName(title, file.name) : file.name,
          kind: file.mime.startsWith("image/") ? "image" : file.mime.startsWith("text/") || /pdf|officedocument/.test(file.mime) ? "document" : "file",
          files: [file], source: "conversation", status: "completed", createdAt, updatedAt: iso(undefined) });
        if (added) imported++;
      } catch (error) {
        // Ignore forbidden references. Missing delivered files are reported; storage failures propagate.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") unavailable++;
        else if (!(error instanceof SpaceError)) throw error;
      }
    }
    return { imported, unavailable };
  }
  async importFile(name: string, bytes: Buffer, collectionId: string | null = null) {
    const index = await this.load();
    if (collectionId && !index.collections.some(c => c.id === collectionId)) throw new SpaceError("收藏夹不存在", 404);
    const file = await this.archiveBytes(bytes, name);
    const existing = (await this.load()).entries.find(e => e.files.length === 1 && e.files[0]?.id === file.id);
    if (existing) return this.detail(existing.id);
    const key = `upload:${file.id}`;
    await this.upsert(key, { title: cleanName(name), kind: file.mime.startsWith("image/") ? "image" : /text\/|pdf|officedocument/.test(file.mime) ? "document" : "file",
      source: "upload", files: [file], status: "completed", createdAt: iso(undefined), updatedAt: iso(undefined) });
    const id = digest(key).slice(0, 32);
    if (collectionId) await this.update(id, { collectionId, revision: 1 });
    return this.detail(id);
  }
  async list(query: { q?: string; kind?: string; collection?: string; favorite?: boolean; offset?: number; limit?: number } = {}) {
    await this.tail; const index = await this.load();
    const q = (query.q || "").trim().toLowerCase();
    const filtered = index.entries.filter(e => (!query.kind || e.kind === query.kind) && (!query.favorite || e.favorite)
      && (!query.collection || e.collectionId === query.collection) && (!q || `${e.title} ${e.files.map(f => f.name).join(" ")}`.toLowerCase().includes(q)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    const offset = Math.max(0, Math.floor(query.offset || 0)), limit = Math.min(100, Math.max(1, Math.floor(query.limit || 48)));
    return { entries: filtered.slice(offset, offset + limit).map(({ files, ...e }) => ({ ...e, fileCount: files.length, cover: files[0] })),
      total: filtered.length, offset, hasMore: offset + limit < filtered.length, collections: index.collections.map(c => ({ ...c, count: index.entries.filter(e => e.collectionId === c.id).length })),
      counts: { all: index.entries.length, favorite: index.entries.filter(e => e.favorite).length,
        ...Object.fromEntries(["image", "comic", "document", "file"].map(kind => [kind, index.entries.filter(e => e.kind === kind).length])) } };
  }
  async detail(id: string) { await this.tail; const entry = (await this.load()).entries.find(e => e.id === id); if (!entry) throw new SpaceError("作品不存在", 404); return structuredClone(entry); }
  async update(id: string, patch: Record<string, unknown>) {
    return this.change(index => {
      const entry = index.entries.find(e => e.id === id); if (!entry) throw new SpaceError("作品不存在", 404);
      if (patch.revision !== entry.revision) throw new SpaceError("作品已更新，请刷新后重试", 409);
      if (patch.title !== undefined) { if (typeof patch.title !== "string" || !patch.title.trim()) throw new SpaceError("标题不能为空"); entry.title = cleanName(patch.title); }
      if (patch.favorite !== undefined) { if (typeof patch.favorite !== "boolean") throw new SpaceError("无效收藏状态"); entry.favorite = patch.favorite; }
      if (patch.collectionId !== undefined) {
        if (patch.collectionId !== null && !index.collections.some(c => c.id === patch.collectionId)) throw new SpaceError("收藏夹不存在", 404);
        entry.collectionId = patch.collectionId as string | null;
      }
      entry.revision++; entry.updatedAt = iso(undefined); return structuredClone(entry);
    });
  }
  async createCollection(name: string) {
    if (!name?.trim() || name.length > 60) throw new SpaceError("收藏夹名称需要 1–60 个字");
    return this.change(index => {
      const normalized = cleanName(name), old = index.collections.find(c => c.name === normalized); if (old) return old;
      const collection = { id: randomUUID(), name: normalized }; index.collections.push(collection); return collection;
    });
  }
  async file(id: string) {
    if (!/^[a-f0-9]{64}\.[a-z0-9]+$/.test(id)) throw new SpaceError("文件不存在", 404);
    const index = await this.load(), meta = index.entries.flatMap(e => e.files).find(f => f.id === id);
    if (!meta) throw new SpaceError("文件不存在", 404);
    const file = await fs.realpath(path.join(this.directory, "files", id)).catch(() => { throw new SpaceError("归档文件丢失，请恢复备份", 404); });
    const root = await fs.realpath(path.join(this.directory, "files"));
    if (!inside(root, file)) throw new SpaceError("归档路径无效", 403);
    return { ...meta, path: file };
  }
}

const stores = new Map<string, SpaceStore>();
export function getSpaceStore(uploadDir = "assets/uploads", root = process.cwd()) {
  const key = path.resolve(root) + "\0" + path.resolve(root, uploadDir);
  let store = stores.get(key);
  if (!store) { store = new SpaceStore(path.resolve(root), path.resolve(root, uploadDir)); stores.set(key, store); }
  return store;
}
