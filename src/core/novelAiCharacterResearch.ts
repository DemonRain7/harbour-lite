import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  rebuildNovelAiCharacterIndex,
  resolveNovelAiCharacter,
  type NovelAiCharacterProfile,
  type NovelAiCharacterRoute,
} from "./novelAiCharacterLibrary";

const USER_AGENT = "Harbour/0.1 (personal NovelAI character-reference research)";
const LOCK_NAME = ".reference-research.lock";
const LOCK_STALE_MS = 10 * 60_000;
const LOCK_WAIT_MS = 120_000;
const DEFAULT_MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 3;
const MAX_API_BYTES = 2 * 1024 * 1024;
const MIN_IMAGE_SIDE = 384;
const MAX_IMAGE_SIDE = 2_048;
const MAX_INPUT_PIXELS = 50_000_000;

const SAFEBOORU_API = "https://safebooru.org/index.php";
const DANBOORU_APIS = [
  "https://safebooru.donmai.us/posts.json",
  "https://danbooru.donmai.us/posts.json",
];

const ALLOWED_MEDIA_HOSTS = new Set([
  "safebooru.org",
  "danbooru.donmai.us",
  "safebooru.donmai.us",
  "cdn.donmai.us",
]);

const REJECTED_REFERENCE_TAGS = new Set([
  "2girls",
  "3girls",
  "4girls",
  "multiple_girls",
  "group",
  "comic",
  "4koma",
  "manga",
  "monochrome",
  "sketch",
  "chibi",
  "cosplay",
  "photo_(medium)",
  "ai-generated",
  "ai_generated",
]);

const ANCHOR_STOP_TAGS = new Set([
  "1girl",
  "solo",
  "looking_at_viewer",
  "smile",
  "open_mouth",
  "closed_mouth",
  "blush",
  "standing",
  "sitting",
  "indoors",
  "outdoors",
  "simple_background",
  "white_background",
  "transparent_background",
  "highres",
  "absurdres",
  "very_high_resolution",
  "official_art",
  "solo_focus",
  "artist_name",
  "signature",
  "watermark",
]);

export interface NovelAiCharacterResearchRequest {
  libraryDir: string;
  displayName: string;
  work: string;
  characterTag: string;
  workTag?: string;
  novelAiTag?: string;
  id?: string;
  aliases?: string[];
  positiveAnchors?: string[];
  negativeAnchors?: string[];
  refresh?: boolean;
  maxSourceBytes?: number;
}

export interface NovelAiReferenceCandidate {
  provider: "safebooru" | "danbooru";
  postId: string;
  postUrl: string;
  assetUrl: string;
  rating: string;
  score: number;
  width: number;
  height: number;
  tags: string[];
}

export interface NovelAiCharacterResearchResult {
  ok: true;
  action: "created" | "updated" | "reused";
  id: string;
  query: string;
  referencePolicy: "required";
  referenceAvailable: true;
  handle: string;
  tag: string;
  source?: {
    provider: "safebooru" | "danbooru";
    postId: string;
    postUrl: string;
  };
  next: "query novelai_character again and continue through required + available";
}

export interface NovelAiCharacterResearchDependencies {
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

interface RawCandidate {
  provider: NovelAiReferenceCandidate["provider"];
  postId: string;
  postUrl: string;
  assetUrl: string;
  rating: string;
  score: number;
  width: number;
  height: number;
  tagString: string;
}

interface SanitizedReference {
  bytes: Buffer;
  sha256: string;
  sourceSha256: string;
  width: number;
  height: number;
}

function cleanText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${label} 超过 ${max} 字符`);
  return result;
}

function cleanOptionalText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return cleanText(value, label, max);
}

function cleanTag(value: unknown, label: string): string {
  const tag = cleanText(value, label, 220).toLocaleLowerCase("en-US").replace(/\s+/g, "_");
  if (!/^[a-z0-9_()!'.:+-]+$/.test(tag)) {
    throw new Error(`${label} 必须是已核对的 ASCII booru tag`);
  }
  return tag;
}

function cleanList(values: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > maxItems) {
    throw new Error(`${label} 必须是至多 ${maxItems} 项的数组`);
  }
  return values.map((value, index) => cleanText(value, `${label}[${index}]`, maxLength));
}

function stableId(value: string): string {
  const id = value
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  if (!id || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) {
    throw new Error("无法从角色 tag 生成安全 id，请显式传入 --id");
  }
  return id;
}

function cleanId(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return stableId(fallback);
  const id = cleanText(value, "id", 80);
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) {
    throw new Error("id 只允许小写字母、数字和短横线");
  }
  return id;
}

function uniqueStrings(values: string[], maxItems: number): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(value.trim());
    if (output.length >= maxItems) break;
  }
  return output;
}

function tagWords(tag: string): string {
  return tag.replace(/_/g, " ").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function tagSet(value: string): Set<string> {
  return new Set(value.trim().split(/\s+/).filter(Boolean).map((tag) => tag.toLocaleLowerCase("en-US")));
}

function allowedMediaUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("候选参考图 URL 无效");
  }
  if (url.protocol !== "https:" || !ALLOWED_MEDIA_HOSTS.has(url.hostname.toLocaleLowerCase("en-US"))) {
    throw new Error(`候选参考图域名不在白名单：${url.hostname || "unknown"}`);
  }
  return url;
}

function candidateFromRaw(
  raw: RawCandidate,
  characterTag: string,
  workTag?: string
): NovelAiReferenceCandidate | null {
  if (raw.width < MIN_IMAGE_SIDE || raw.height < MIN_IMAGE_SIDE) return null;
  const tags = tagSet(raw.tagString);
  if (!tags.has(characterTag)) return null;
  if (workTag && !tags.has(workTag)) return null;
  if (!tags.has("solo")) return null;
  for (const rejected of REJECTED_REFERENCE_TAGS) {
    if (tags.has(rejected)) return null;
  }
  try {
    allowedMediaUrl(raw.assetUrl);
  } catch {
    return null;
  }
  return {
    provider: raw.provider,
    postId: raw.postId,
    postUrl: raw.postUrl,
    assetUrl: raw.assetUrl,
    rating: raw.rating,
    score: raw.score,
    width: raw.width,
    height: raw.height,
    tags: [...tags],
  };
}

function rankCandidate(candidate: NovelAiReferenceCandidate): number {
  const area = Math.min(candidate.width * candidate.height, 20_000_000);
  const portraitBonus = candidate.height >= candidate.width ? 100_000 : 0;
  const providerBonus = candidate.provider === "safebooru" ? 50_000 : 0;
  return candidate.score * 1_000_000 + area + portraitBonus + providerBonus;
}

function appearanceTag(tag: string): boolean {
  if (ANCHOR_STOP_TAGS.has(tag) || REJECTED_REFERENCE_TAGS.has(tag)) return false;
  return /(?:hair|eyes?|bangs|braid|ponytail|twintails|hair_ribbon|hairband|hairclip|ahoge|antenna_hair|skin|freckles|petite|slender|breasts|school_uniform|sailor|shirt|blouse|skirt|dress|ribbon|bowtie|necktie|jacket|cardigan|sweater|hat|gloves|boots|shoes|socks|stockings|pantyhose)$/.test(tag)
    || /^(?:short_hair|long_hair|very_long_hair|medium_hair|bob_cut|hime_cut|side_ponytail|low_ponytail|fair_skin|dark_skin)$/.test(tag);
}

function deriveAnchors(candidates: NovelAiReferenceCandidate[], characterTag: string, workTag?: string): string[] {
  const counts = new Map<string, number>();
  for (const candidate of candidates.slice(0, 12)) {
    for (const tag of new Set(candidate.tags)) {
      if (tag === characterTag || tag === workTag || !appearanceTag(tag)) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const threshold = Math.max(1, Math.ceil(Math.min(candidates.length, 12) * 0.35));
  return [...counts.entries()]
    .filter(([, count]) => count >= threshold)
    .sort(([tagA, countA], [tagB, countB]) => countB - countA || tagA.localeCompare(tagB))
    .slice(0, 20)
    .map(([tag]) => tag.replace(/_/g, " "));
}

async function delay(ms: number, sleep: NovelAiCharacterResearchDependencies["sleep"]): Promise<void> {
  if (sleep) await sleep(ms);
  else await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetries(
  url: URL,
  options: {
    maxBytes: number;
    fetchImpl: typeof fetch;
    sleep?: NovelAiCharacterResearchDependencies["sleep"];
    timeoutMs?: number;
    redirects?: number;
    validateRedirect?: (url: URL) => void;
  }
): Promise<{ bytes: Buffer; contentType: string }> {
  let current = new URL(url);
  const redirects = options.redirects ?? 3;
  for (let redirectCount = 0; redirectCount <= redirects; redirectCount += 1) {
    let lastError: unknown;
    for (let attempt = 0; attempt < DEFAULT_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const response = await options.fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { accept: "application/json,image/*;q=0.9,*/*;q=0.1", "user-agent": USER_AGENT },
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) throw new Error(`HTTP ${response.status} 缺少 Location`);
          current = new URL(location, current);
          options.validateRedirect?.(current);
          lastError = undefined;
          break;
        }
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          const error = new Error(`HTTP ${response.status} ${response.statusText}`);
          if (!retryable) throw error;
          lastError = error;
          if (attempt + 1 < DEFAULT_RETRIES) await delay(500 * (2 ** attempt), options.sleep);
          continue;
        }
        const declaredLength = Number(response.headers.get("content-length") ?? "0");
        if (declaredLength > options.maxBytes) throw new Error(`响应超过 ${options.maxBytes} 字节上限`);
        if (!response.body) throw new Error("响应没有 body");
        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let total = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          const chunk = Buffer.from(part.value);
          total += chunk.length;
          if (total > options.maxBytes) {
            await reader.cancel("response too large").catch(() => undefined);
            throw new Error(`响应超过 ${options.maxBytes} 字节上限`);
          }
          chunks.push(chunk);
        }
        return {
          bytes: Buffer.concat(chunks, total),
          contentType: response.headers.get("content-type") ?? "",
        };
      } catch (error) {
        lastError = error;
        if (attempt + 1 < DEFAULT_RETRIES) await delay(500 * (2 ** attempt), options.sleep);
      } finally {
        clearTimeout(timer);
      }
    }
    if (lastError) throw lastError;
    if (redirectCount === redirects) throw new Error("参考图重定向次数过多");
  }
  throw new Error("无法取得响应");
}

async function fetchJson(
  url: URL,
  fetchImpl: typeof fetch,
  sleep?: NovelAiCharacterResearchDependencies["sleep"]
): Promise<unknown> {
  const response = await fetchWithRetries(url, { maxBytes: MAX_API_BYTES, fetchImpl, sleep });
  const text = response.bytes.toString("utf8").trim();
  if (!text) return [];
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`参考图 API 没有返回合法 JSON（Content-Type: ${response.contentType || "unknown"}）`);
  }
}

function safebooruUrl(characterTag: string, workTag: string | undefined): URL {
  const url = new URL(SAFEBOORU_API);
  const tags = [characterTag, workTag, "solo"].filter(Boolean).join(" ");
  url.search = new URLSearchParams({
    page: "dapi",
    s: "post",
    q: "index",
    json: "1",
    limit: "30",
    tags,
  }).toString();
  return url;
}

function danbooruUrl(base: string, characterTag: string, workTag?: string): URL {
  const url = new URL(base);
  url.search = new URLSearchParams({
    limit: "30",
    tags: [characterTag, workTag, "solo"].filter(Boolean).join(" "),
  }).toString();
  return url;
}

function parseSafebooru(raw: unknown): RawCandidate[] {
  if (!Array.isArray(raw)) return [];
  const output: RawCandidate[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const id = String(row.id ?? "").trim();
    const assetUrl = String(row.sample_url || row.file_url || "").trim();
    const tags = String(row.tags ?? "").trim();
    if (!id || !assetUrl || !tags) continue;
    output.push({
      provider: "safebooru",
      postId: id,
      postUrl: `https://safebooru.org/index.php?page=post&s=view&id=${encodeURIComponent(id)}`,
      assetUrl,
      rating: String(row.rating ?? ""),
      score: numberValue(row.score),
      width: numberValue(row.sample_width || row.width),
      height: numberValue(row.sample_height || row.height),
      tagString: tags,
    });
  }
  return output;
}

function parseDanbooru(raw: unknown): RawCandidate[] {
  if (!Array.isArray(raw)) return [];
  const output: RawCandidate[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const id = String(row.id ?? "").trim();
    const assetUrl = String(row.large_file_url || row.file_url || "").trim();
    const tags = String(row.tag_string ?? "").trim();
    if (!id || !assetUrl || !tags) continue;
    output.push({
      provider: "danbooru",
      postId: id,
      postUrl: `https://danbooru.donmai.us/posts/${encodeURIComponent(id)}`,
      assetUrl,
      rating: String(row.rating ?? ""),
      score: numberValue(row.score),
      width: numberValue(row.image_width),
      height: numberValue(row.image_height),
      tagString: tags,
    });
  }
  return output;
}

export async function discoverNovelAiReferenceCandidates(
  request: Pick<NovelAiCharacterResearchRequest, "characterTag" | "workTag">,
  dependencies: NovelAiCharacterResearchDependencies = {}
): Promise<NovelAiReferenceCandidate[]> {
  const characterTag = cleanTag(request.characterTag, "characterTag");
  const workTag = request.workTag ? cleanTag(request.workTag, "workTag") : undefined;
  const fetchImpl = dependencies.fetch ?? fetch;
  const seen = new Set<string>();
  const accepted: NovelAiReferenceCandidate[] = [];

  let raw: unknown;
  try {
    raw = await fetchJson(safebooruUrl(characterTag, workTag), fetchImpl, dependencies.sleep);
  } catch {
    // safebooru 不可用时继续走 danbooru 兜底
  }
  for (const candidate of parseSafebooru(raw)) {
    const acceptedCandidate = candidateFromRaw(candidate, characterTag, workTag);
    if (!acceptedCandidate || seen.has(acceptedCandidate.assetUrl)) continue;
    seen.add(acceptedCandidate.assetUrl);
    accepted.push(acceptedCandidate);
  }

  if (!accepted.length) {
    for (const base of DANBOORU_APIS) {
      let raw: unknown;
      try {
        raw = await fetchJson(danbooruUrl(base, characterTag, workTag), fetchImpl, dependencies.sleep);
      } catch {
        continue;
      }
      for (const candidate of parseDanbooru(raw)) {
        const acceptedCandidate = candidateFromRaw(candidate, characterTag, workTag);
        if (!acceptedCandidate || seen.has(acceptedCandidate.assetUrl)) continue;
        seen.add(acceptedCandidate.assetUrl);
        accepted.push(acceptedCandidate);
      }
      if (accepted.length) break;
    }
  }

  return accepted.sort((a, b) => rankCandidate(b) - rankCandidate(a) || a.postId.localeCompare(b.postId));
}

async function downloadAndSanitize(
  candidate: NovelAiReferenceCandidate,
  maxBytes: number,
  dependencies: NovelAiCharacterResearchDependencies
): Promise<SanitizedReference> {
  const fetchImpl = dependencies.fetch ?? fetch;
  const url = allowedMediaUrl(candidate.assetUrl);
  const response = await fetchWithRetries(url, {
    maxBytes,
    fetchImpl,
    sleep: dependencies.sleep,
    validateRedirect: (redirect) => { allowedMediaUrl(redirect.toString()); },
  });
  if (!/^image\//i.test(response.contentType)) {
    throw new Error(`参考图响应不是图片：${response.contentType || "unknown"}`);
  }
  const sourceSha256 = createHash("sha256").update(response.bytes).digest("hex");
  const pipeline = sharp(response.bytes, {
    animated: false,
    failOn: "error",
    limitInputPixels: MAX_INPUT_PIXELS,
  });
  const metadata = await pipeline.metadata();
  if (!metadata.width || !metadata.height || metadata.width < MIN_IMAGE_SIDE || metadata.height < MIN_IMAGE_SIDE) {
    throw new Error(`参考图尺寸过小：${metadata.width ?? 0}x${metadata.height ?? 0}`);
  }
  if (!metadata.format || !["png", "jpeg", "webp"].includes(metadata.format)) {
    throw new Error(`参考图格式不受支持：${metadata.format ?? "unknown"}`);
  }
  const bytes = await pipeline
    .rotate()
    .resize({ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 95, effort: 4 })
    .toBuffer();
  if (!bytes.length || bytes.length > maxBytes) throw new Error("净化后的参考图超过大小上限");
  const sanitizedMetadata = await sharp(bytes).metadata();
  if (!sanitizedMetadata.width || !sanitizedMetadata.height) throw new Error("无法读取净化后参考图尺寸");
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sourceSha256,
    width: sanitizedMetadata.width,
    height: sanitizedMetadata.height,
  };
}

async function fileSnapshot(file: string): Promise<Buffer | null> {
  return fs.readFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function atomicWrite(file: string, bytes: Buffer | string): Promise<void> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temp, bytes, { flag: "wx" });
  try {
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}

async function restoreFile(file: string, snapshot: Buffer | null): Promise<void> {
  if (snapshot === null) await fs.unlink(file).catch(() => undefined);
  else await atomicWrite(file, snapshot);
}

async function acquireLock(libraryDir: string, sleep?: NovelAiCharacterResearchDependencies["sleep"]): Promise<() => Promise<void>> {
  await fs.mkdir(libraryDir, { recursive: true });
  const lockPath = path.join(libraryDir, LOCK_NAME);
  const started = Date.now();
  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      await handle.close();
      return async () => { await fs.unlink(lockPath).catch(() => undefined); };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error("等待角色库调研锁超时");
      await delay(100, sleep);
    }
  }
}

async function existingProfile(libraryDir: string, id: string): Promise<NovelAiCharacterProfile | undefined> {
  const file = path.join(libraryDir, id, "profile.json");
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as NovelAiCharacterProfile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function existingRequiredRoute(
  libraryDir: string,
  queries: string[]
): Promise<NovelAiCharacterRoute | undefined> {
  for (const query of queries) {
    const route = await resolveNovelAiCharacter(libraryDir, query).catch(() => undefined);
    if (route?.referencePolicy === "required" && route.reference?.available && route.reference.handle) return route;
  }
  return undefined;
}

async function persistReference(args: {
  request: NovelAiCharacterResearchRequest;
  id: string;
  existing?: NovelAiCharacterProfile;
  candidate: NovelAiReferenceCandidate;
  candidates: NovelAiReferenceCandidate[];
  sanitized: SanitizedReference;
  now: Date;
}): Promise<{ route: NovelAiCharacterRoute; action: "created" | "updated" }> {
  const { request, id, existing, candidate, candidates, sanitized, now } = args;
  const libraryDir = path.resolve(request.libraryDir);
  const characterDir = path.join(libraryDir, id);
  const relative = path.relative(libraryDir, characterDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("角色目录越出角色库");
  const profilePath = path.join(characterDir, "profile.json");
  const sourcePath = path.join(characterDir, "source.json");
  const indexPath = path.join(libraryDir, "index.json");
  const referenceName = `reference-${sanitized.sha256.slice(0, 16)}.webp`;
  const referencePath = path.join(characterDir, referenceName);
  const targetExisted = await fs.stat(characterDir).then((stat) => stat.isDirectory()).catch(() => false);
  await fs.mkdir(characterDir, { recursive: true });

  const [profileBefore, sourceBefore, indexBefore] = await Promise.all([
    fileSnapshot(profilePath),
    fileSnapshot(sourcePath),
    fileSnapshot(indexPath),
  ]);
  let createdReference = false;
  try {
    await fs.writeFile(referencePath, sanitized.bytes, { flag: "wx" });
    createdReference = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const current = await fs.readFile(referencePath);
    const currentHash = createHash("sha256").update(current).digest("hex");
    if (currentHash !== sanitized.sha256) throw new Error("同名参考图内容不一致");
  }

  const suppliedAliases = cleanList(request.aliases, "aliases", 48, 160);
  const derivedAliases = [
    request.displayName,
    tagWords(request.characterTag),
    request.characterTag,
    `${request.displayName} ${request.work}`,
    ...suppliedAliases,
  ];
  const aliases = uniqueStrings([...(existing?.aliases ?? []), ...derivedAliases], 64)
    .filter((value) => value !== id && value !== request.displayName);
  const derivedAnchors = deriveAnchors(candidates, request.characterTag, request.workTag);
  const positiveAnchors = uniqueStrings([
    ...(existing?.novelai?.positiveAnchors ?? []),
    ...cleanList(request.positiveAnchors, "positiveAnchors", 32, 180),
    ...derivedAnchors,
  ], 48);
  const negativeAnchors = uniqueStrings([
    ...(existing?.novelai?.negativeAnchors ?? []),
    ...cleanList(request.negativeAnchors, "negativeAnchors", 32, 180),
    "wrong character",
    "wrong hair color",
    "wrong eye color",
    "text",
    "watermark",
  ], 48);
  const profile: NovelAiCharacterProfile = {
    schemaVersion: 1,
    id,
    displayName: request.displayName,
    source: request.work,
    aliases,
    referencePolicy: "required",
    novelai: {
      tag: request.novelAiTag || tagWords(request.characterTag),
      positiveAnchors,
      negativeAnchors,
    },
    reference: { file: referenceName },
  };
  const source = {
    schemaVersion: 1,
    provider: candidate.provider,
    sourceUrl: candidate.postUrl,
    assetUrl: candidate.assetUrl,
    postId: candidate.postId,
    retrievedAt: now.toISOString(),
    query: {
      displayName: request.displayName,
      work: request.work,
      characterTag: request.characterTag,
      ...(request.workTag ? { workTag: request.workTag } : {}),
    },
    rating: candidate.rating,
    score: candidate.score,
    sourceImage: {
      width: candidate.width,
      height: candidate.height,
      sha256: sanitized.sourceSha256,
    },
    storedImage: {
      file: referenceName,
      mime: "image/webp",
      width: sanitized.width,
      height: sanitized.height,
      size: sanitized.bytes.length,
      sha256: sanitized.sha256,
    },
  };

  try {
    await atomicWrite(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
    await atomicWrite(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
    const index = await rebuildNovelAiCharacterIndex(libraryDir);
    await atomicWrite(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    const route = await resolveNovelAiCharacter(libraryDir, request.displayName);
    if (route.id !== id || route.referencePolicy !== "required" || !route.reference?.available || !route.reference.handle) {
      throw new Error("入库后没有重新解析为 required + 有图");
    }
    const entries = await fs.readdir(characterDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === referenceName || !/^reference-[a-f0-9]{16}\.webp$/.test(entry.name)) continue;
      await fs.unlink(path.join(characterDir, entry.name)).catch(() => undefined);
    }
    return { route, action: existing ? "updated" : "created" };
  } catch (error) {
    await Promise.allSettled([
      restoreFile(profilePath, profileBefore),
      restoreFile(sourcePath, sourceBefore),
      restoreFile(indexPath, indexBefore),
    ]);
    if (createdReference) await fs.unlink(referencePath).catch(() => undefined);
    if (!targetExisted) await fs.rm(characterDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function validatedRequest(request: NovelAiCharacterResearchRequest): NovelAiCharacterResearchRequest {
  const displayName = cleanText(request.displayName, "displayName", 160);
  const work = cleanText(request.work, "work", 240);
  const characterTag = cleanTag(request.characterTag, "characterTag");
  const workTag = request.workTag ? cleanTag(request.workTag, "workTag") : undefined;
  const novelAiTag = cleanOptionalText(request.novelAiTag, "novelAiTag", 300);
  const maxSourceBytes = request.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1024 || maxSourceBytes > 50 * 1024 * 1024) {
    throw new Error("maxSourceBytes 必须是 1KB–50MB 的整数");
  }
  return {
    ...request,
    libraryDir: path.resolve(cleanText(request.libraryDir, "libraryDir", 2_000)),
    displayName,
    work,
    characterTag,
    ...(workTag ? { workTag } : {}),
    ...(novelAiTag ? { novelAiTag } : {}),
    aliases: cleanList(request.aliases, "aliases", 48, 160),
    positiveAnchors: cleanList(request.positiveAnchors, "positiveAnchors", 32, 180),
    negativeAnchors: cleanList(request.negativeAnchors, "negativeAnchors", 32, 180),
    maxSourceBytes,
  };
}

export async function acquireNovelAiCharacterReference(
  rawRequest: NovelAiCharacterResearchRequest,
  dependencies: NovelAiCharacterResearchDependencies = {}
): Promise<NovelAiCharacterResearchResult> {
  const request = validatedRequest(rawRequest);
  const release = await acquireLock(request.libraryDir, dependencies.sleep);
  try {
    // 新增 alias 只能在提交时接受冲突检查，不能反过来拿它认领现有档案；
    // 否则恶意/误写 alias 会把另一个角色原地覆盖。已有角色应由当前显示名、
    // canonical tag，或 Main 从 novelai_character 得到后显式传入的 id 识别。
    const existingQueries = [request.displayName, request.characterTag, ...(request.id ? [request.id] : [])];
    if (!request.refresh) {
      const route = await existingRequiredRoute(request.libraryDir, existingQueries);
      if (route?.id && route.reference?.handle && route.novelai?.tag) {
        return {
          ok: true,
          action: "reused",
          id: route.id,
          query: request.displayName,
          referencePolicy: "required",
          referenceAvailable: true,
          handle: route.reference.handle,
          tag: route.novelai.tag,
          next: "query novelai_character again and continue through required + available",
        };
      }
    }

    let matchedExisting: NovelAiCharacterRoute | undefined;
    for (const query of existingQueries) {
      const route = await resolveNovelAiCharacter(request.libraryDir, query).catch(() => undefined);
      if (route?.found && route.id) {
        matchedExisting = route;
        break;
      }
    }
    const id = matchedExisting?.id ?? cleanId(request.id, `${request.characterTag}-${request.workTag ?? "character"}`);
    if (request.id && matchedExisting?.id && request.id !== matchedExisting.id) {
      throw new Error(`显式 id「${request.id}」与现有角色「${matchedExisting.id}」冲突`);
    }
    const profile = await existingProfile(request.libraryDir, id);
    if (profile && matchedExisting?.id !== id) {
      throw new Error(`角色 id「${id}」已存在，但当前名称/别名没有命中它`);
    }

    const candidates = await discoverNovelAiReferenceCandidates(request, dependencies);
    if (!candidates.length) {
      throw new Error(`没有找到同时命中角色 tag「${request.characterTag}」${request.workTag ? `与作品 tag「${request.workTag}」` : ""}的安全单人参考图`);
    }
    let selected: NovelAiReferenceCandidate | undefined;
    let sanitized: SanitizedReference | undefined;
    const failures: string[] = [];
    for (const candidate of candidates.slice(0, 6)) {
      try {
        sanitized = await downloadAndSanitize(candidate, request.maxSourceBytes!, dependencies);
        selected = candidate;
        break;
      } catch (error) {
        failures.push(`${candidate.provider}#${candidate.postId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!selected || !sanitized) {
      throw new Error(`候选参考图均未通过下载/解码/净化：${failures.join("；").slice(0, 1_500)}`);
    }

    const persisted = await persistReference({
      request,
      id,
      existing: profile,
      candidate: selected,
      candidates,
      sanitized,
      now: dependencies.now?.() ?? new Date(),
    });
    return {
      ok: true,
      action: persisted.action,
      id,
      query: request.displayName,
      referencePolicy: "required",
      referenceAvailable: true,
      handle: persisted.route.reference!.handle!,
      tag: persisted.route.novelai!.tag,
      source: {
        provider: selected.provider,
        postId: selected.postId,
        postUrl: selected.postUrl,
      },
      next: "query novelai_character again and continue through required + available",
    };
  } finally {
    await release();
  }
}
