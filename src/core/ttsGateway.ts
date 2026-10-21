import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { harbourDataHome } from "./storagePaths";
import path from "node:path";
import { readTencentTtsFallback, readTencentTtsCredentials, synthesizeTencentTts, TENCENT_TTS_URL, TENCENT_TTS_VOICE, type TencentTtsConfig } from "./ttsTencent";
import { readNamedVoices, readVoiceSelections, TENCENT_VOICES, type NamedTtsVoice } from "./ttsVoices";

export type TtsFormat = "json" | "query" | "gpt-sovits-v2" | "openai-speech" | "mimo-chat-audio";

export interface TtsVoiceProfile {
  voice?: string;
  model?: string;
  /** GPT-SoVITS：推理服务上的路径；MiMo VoiceClone：Harbour 后端机器上的本地路径。 */
  refAudioPath?: string;
  promptText?: string;
  promptLang?: string;
  textLang?: string;
  stylePrompt?: string;
  speed?: number;
}

export interface TtsCacheConfig {
  enabled: boolean;
  dir: string;
  maxBytes: number;
}

export interface TtsGatewayConfig {
  enabled: boolean;
  /** 面向 UI/日志的 Provider 名；请求形状由 format 决定。 */
  provider: string;
  url: string;
  format: TtsFormat;
  model: string;
  voice: string;
  headers: Record<string, string>;
  ext: string;
  timeoutMs: number;
  maxAudioBytes: number;
  profiles: Record<string, TtsVoiceProfile>;
  cache: TtsCacheConfig;
  /** Backend-only credentials. Never include this object in API responses or logs. */
  tencentFallback?: TencentTtsConfig;
  tencent?: TencentTtsConfig;
  namedVoices?: NamedTtsVoice[];
  selections?: Record<string, string>;
}

export interface TtsSynthesisRequest {
  text: string;
  companionId?: string;
  voice?: string;
  emotion?: string;
  signal?: AbortSignal;
  voiceId?: string;
  /** Explicit previews must not silently play a different voice. */
  allowFallback?: boolean;
}

export interface TtsSynthesisResult {
  data: Buffer;
  mime: string;
  ext: string;
  provider: string;
  cacheKey: string;
  cached: boolean;
  fallbackFrom?: string;
  voiceId?: string;
}

export interface TtsProviderDefinition {
  id: string;
  label: string;
  description: string;
  format: TtsFormat;
  icon: string;
  defaultExt: string;
  defaultModel?: string;
  defaultUrl?: string;
}

type EnvLike = object;

const MIME_BY_EXT: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  webm: "audio/webm",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
};

const TTS_PROVIDERS: TtsProviderDefinition[] = [
  {
    id: "aemeath-indextts2",
    label: "Aemeath · Local IndexTTS-2",
    description: "连接本机独立音色服务；按需加载，空闲释放显存。仅支持 Aemeath，不随 Electron 启动模型。",
    format: "json",
    icon: "/assets/providers/custom.svg",
    defaultExt: "mp3",
    defaultModel: "aemeath-v3",
    defaultUrl: "http://127.0.0.1:9892/tts",
  },
  {
    id: "gpt-sovits",
    label: "GPT-SoVITS · Remote",
    description: "连接另一台 GPU 主机或云容器的官方 API v2；Harbour 本机不加载模型。",
    format: "gpt-sovits-v2",
    icon: "/assets/providers/custom.svg",
    defaultExt: "wav",
  },
  {
    id: "xiaomi-mimo",
    label: "Xiaomi MiMo · Cloud",
    description: "小米官方托管 TTS；支持预置音色、文字设计音色与短音频克隆，无需部署模型。",
    format: "mimo-chat-audio",
    icon: "/assets/providers/custom.svg",
    defaultExt: "wav",
    defaultModel: "mimo-v2.5-tts-voicedesign",
    defaultUrl: "https://api.xiaomimimo.com/v1/chat/completions",
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible Speech",
    description: "适合 Qwen、Mossland 及提供 /v1/audio/speech 兼容接口的云服务。",
    format: "openai-speech",
    icon: "/assets/providers/openai.svg",
    defaultExt: "mp3",
    defaultModel: "tts-1",
  },
  {
    id: "custom-json",
    label: "Custom · POST JSON",
    description: "POST { text, voice, model, ... }，响应体直接返回音频字节。",
    format: "json",
    icon: "/assets/providers/custom.svg",
    defaultExt: "wav",
  },
  {
    id: "custom-query",
    label: "Custom · GET Query",
    description: "GET ?text=…&voice=…，用于既有轻量 TTS 网关。",
    format: "query",
    icon: "/assets/providers/custom.svg",
    defaultExt: "wav",
  },
];

export function ttsProviderCatalog(): TtsProviderDefinition[] {
  return TTS_PROVIDERS.map((provider) => ({ ...provider }));
}

function envText(env: EnvLike, key: string): string {
  const value = (env as Record<string, unknown>)[key];
  return value == null ? "" : String(value).trim();
}

function envBool(env: EnvLike, key: string, fallback: boolean): boolean {
  const raw = envText(env, key);
  return raw ? ["true", "1", "yes", "on"].includes(raw.toLowerCase()) : fallback;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of raw.split(";")) {
    const separator = pair.indexOf(":");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!name || !value || /^(host|content-length)$/i.test(name)) continue;
    headers[name] = value;
  }
  return headers;
}

function parseProfiles(raw: string): Record<string, TtsVoiceProfile> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("TTS_PROFILES_JSON 不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("TTS_PROFILES_JSON 必须是以角色 ID 为键的对象");
  }
  const profiles: Record<string, TtsVoiceProfile> = {};
  for (const [rawId, value] of Object.entries(parsed)) {
    const id = rawId.trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,48}$/.test(id) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    const profile: TtsVoiceProfile = {};
    const copy = (from: string, to: keyof TtsVoiceProfile) => {
      const text = item[from] == null ? "" : String(item[from]).trim();
      if (text) (profile as Record<string, unknown>)[to] = text;
    };
    copy("voice", "voice");
    copy("model", "model");
    copy("refAudioPath", "refAudioPath");
    copy("promptText", "promptText");
    copy("promptLang", "promptLang");
    copy("textLang", "textLang");
    copy("stylePrompt", "stylePrompt");
    if (item.speed != null) profile.speed = boundedNumber(item.speed, 1, 0.5, 2);
    profiles[id] = profile;
  }
  return profiles;
}

function defaultCacheDir(env: EnvLike): string {
  return path.join(harbourDataHome({ HARBOUR_DATA_HOME: envText(env, "HARBOUR_DATA_HOME") }), "cache", "tts");
}

function providerIdFor(format: TtsFormat): string {
  // The general protocol must not start implying a specific local voice when
  // another optional provider uses the same JSON transport.
  if (format === "json") return "custom-json";
  return TTS_PROVIDERS.find((provider) => provider.format === format)?.id ?? format;
}

/**
 * 所有 TTS 都由 Harbour 后端访问。Electron 不读取上游地址/密钥，也不会启动 Python/GPU 进程。
 * 主服务 URL 可留空，届时直接使用已启用且配好密钥的腾讯备用。总开关关闭时都不调用。
 */
export function readTtsGatewayConfig(env: EnvLike = process.env, allowUnconfigured = false): TtsGatewayConfig | null {
  const values = env as Record<string, unknown>;
  if (!envBool(env, "TTS_ENABLED", true)) return null;
  const url = envText(env, "TTS_URL");
  const tencentFallback = readTencentTtsFallback(env);
  const tencent = readTencentTtsCredentials(env);
  const namedVoices = readNamedVoices(values.TTS_VOICES_JSON);
  const selections = readVoiceSelections(values.TTS_VOICE_SELECTIONS_JSON);
  if (!allowUnconfigured && !url && !tencent && !namedVoices.some(item => item.url)) return null;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url || TENCENT_TTS_URL);
  } catch {
    throw new Error("TTS_URL 不是合法 URL");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("TTS_URL 只允许 HTTP/HTTPS");
  }

  const requestedFormat = envText(env, "TTS_FORMAT").toLowerCase() || "json";
  const format: TtsFormat = requestedFormat === "query"
    ? "query"
    : requestedFormat === "gpt-sovits-v2"
      ? "gpt-sovits-v2"
      : requestedFormat === "openai-speech"
        ? "openai-speech"
        : requestedFormat === "mimo-chat-audio"
          ? "mimo-chat-audio"
          : "json";
  const provider = envText(env, "TTS_PROVIDER") || providerIdFor(format);
  const providerDefaults = TTS_PROVIDERS.find((entry) => entry.id === provider)
    ?? TTS_PROVIDERS.find((entry) => entry.id === providerIdFor(format));
  const rawExt = envText(env, "TTS_EXT").replace(/^\./, "").toLowerCase() || providerDefaults?.defaultExt || "wav";
  const ext = /^[a-z0-9]{2,5}$/.test(rawExt) ? rawExt : "wav";
  const cacheDir = envText(env, "TTS_CACHE_DIR") || defaultCacheDir(env);
  return {
    enabled: true,
    provider,
    url: url ? parsedUrl.toString() : "",
    format,
    model: envText(env, "TTS_MODEL") || providerDefaults?.defaultModel || "",
    voice: envText(env, "TTS_VOICE"),
    headers: parseHeaders(envText(env, "TTS_HEADERS")),
    ext,
    timeoutMs: boundedNumber(values["TTS_TIMEOUT_MS"], 60_000, 1_000, 10 * 60_000),
    maxAudioBytes: Math.round(boundedNumber(values["TTS_MAX_AUDIO_MB"], 25, 1, 100) * 1024 * 1024),
    profiles: parseProfiles(envText(env, "TTS_PROFILES_JSON")),
    cache: {
      enabled: envBool(env, "TTS_CACHE_ENABLED", true),
      dir: path.resolve(cacheDir),
      maxBytes: Math.round(boundedNumber(values["TTS_CACHE_MAX_MB"], 512, 16, 10_240) * 1024 * 1024),
    },
    ...(tencentFallback ? { tencentFallback } : {}),
    ...(tencent ? { tencent } : {}),
    namedVoices, selections,
  };
}

/** Safe catalogue for every playback surface: no upstream URLs, headers or reference paths. */
export function ttsVoiceCatalog(config: TtsGatewayConfig | null) {
  return {
    selections: config?.selections || {},
    voices: [
      { id: "auto", label: "跟随默认服务", group: "默认", description: "原有主服务 → 腾讯精品备用", available: true },
      ...TENCENT_VOICES.map(item => ({ id: `tencent:${item.voice}`, label: item.label, group: `腾讯 · ${item.tier}`,
        description: `${item.description} · 使用${item.tier}额度`, available: !!(config?.tencent || config?.tencentFallback) })),
      ...Object.keys(config?.url ? config.profiles : {}).filter(id => id !== "default").map(id => ({ id: `primary:${id}`,
        label: `${id} · 原主声线`, group: "兼容主服务", description: config?.url ? config.provider : "尚未配置主服务", available: !!config?.url })),
      ...(config?.namedVoices || readNamedVoices("")).map(item => ({ id: `custom:${item.id}`, label: item.label,
        group: "自定义与角色声线", description: item.url ? item.provider : "未配置 · 请在设置中连接服务", available: !!item.url })),
    ],
  };
}

function profileFor(config: TtsGatewayConfig, companionId?: string): TtsVoiceProfile {
  const id = String(companionId || "").trim().toLowerCase();
  return (id && config.profiles[id]) || config.profiles.default || {};
}

function localAudioMime(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".m4a" || ext === ".mp4") return "audio/mp4";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".flac") return "audio/flac";
  if (ext === ".webm") return "audio/webm";
  return "audio/mpeg";
}

async function requestBody(config: TtsGatewayConfig, request: TtsSynthesisRequest): Promise<Record<string, unknown>> {
  const companionId = String(request.companionId || "").trim().toLowerCase();
  const profile = profileFor(config, companionId);
  const voice = String(request.voice || profile.voice || config.voice || companionId).trim();
  const model = String(profile.model || config.model || "").trim();
  const speed = boundedNumber(profile.speed, 1, 0.5, 2);
  if (config.format === "mimo-chat-audio") {
    const selectedModel = model || "mimo-v2.5-tts-voicedesign";
    const isVoiceDesign = selectedModel.includes("voicedesign");
    const isVoiceClone = selectedModel.includes("voiceclone");
    const stylePrompt = String(profile.stylePrompt || "").trim();
    if (isVoiceDesign && !stylePrompt) {
      throw new Error(`MiMo VoiceDesign 缺少 ${companionId || "default"} 的 stylePrompt（请在角色声线中描述音色）`);
    }
    const audio: Record<string, unknown> = {
      format: config.ext === "mp3" ? "mp3" : "wav",
      optimize_text_preview: true,
    };
    if (isVoiceClone) {
      if (!profile.refAudioPath) {
        throw new Error(`MiMo VoiceClone 缺少 ${companionId || "default"} 的 refAudioPath（Harbour 后端机器上的参考音频）`);
      }
      const reference = path.resolve(profile.refAudioPath);
      const stat = await fs.stat(reference).catch(() => null);
      if (!stat?.isFile()) throw new Error(`MiMo 参考音频不存在：${reference}`);
      if (stat.size <= 0 || stat.size > 10 * 1024 * 1024) {
        throw new Error("MiMo 参考音频必须非空且不超过 10 MB");
      }
      const data = await fs.readFile(reference);
      audio.voice = `data:${localAudioMime(reference)};base64,${data.toString("base64")}`;
    } else if (!isVoiceDesign) {
      audio.voice = String(request.voice || profile.voice || config.voice || "mimo_default").trim();
    }
    return {
      model: selectedModel,
      messages: [
        { role: "user", content: stylePrompt },
        { role: "assistant", content: request.text },
      ],
      audio,
    };
  }
  if (config.format === "openai-speech") {
    return {
      model: model || "tts-1",
      input: request.text,
      voice: voice || "alloy",
      response_format: config.ext === "m4a" ? "aac" : config.ext,
      speed,
    };
  }
  if (config.format !== "gpt-sovits-v2") {
    return {
      text: request.text,
      ...(voice ? { voice, speaker: voice } : {}),
      ...(model ? { model } : {}),
      ...(companionId ? { companionId } : {}),
      ...(request.emotion ? { emotion: request.emotion } : {}),
      ...(profile.stylePrompt ? { stylePrompt: profile.stylePrompt } : {}),
      speed,
    };
  }

  if (!profile.refAudioPath) {
    throw new Error(`GPT-SoVITS 缺少 ${companionId || "default"} 的 refAudioPath（配置在角色声线 Profile）`);
  }
  const mediaType = ["wav", "ogg", "aac", "raw"].includes(config.ext) ? config.ext : "wav";
  return {
    text: request.text,
    text_lang: profile.textLang || "auto",
    ref_audio_path: profile.refAudioPath,
    prompt_text: profile.promptText || "",
    prompt_lang: profile.promptLang || "ja",
    media_type: mediaType,
    streaming_mode: false,
    speed_factor: speed,
  };
}

function cacheKey(config: TtsGatewayConfig, request: TtsSynthesisRequest): string {
  const profile = profileFor(config, request.companionId);
  const source = JSON.stringify({
    version: 2,
    provider: config.provider,
    format: config.format,
    url: config.url,
    model: profile.model || config.model,
    voice: request.voice || profile.voice || config.voice,
    refAudioPath: profile.refAudioPath,
    promptText: profile.promptText,
    promptLang: profile.promptLang,
    textLang: profile.textLang,
    stylePrompt: profile.stylePrompt,
    speed: profile.speed ?? 1,
    emotion: request.emotion || "neutral",
    ext: config.ext,
    text: request.text,
  });
  return `tts-${createHash("sha256").update(source, "utf8").digest("hex")}`;
}

function cachePath(config: TtsGatewayConfig, key: string): string {
  if (!/^tts-[a-f0-9]{64}$/.test(key)) throw new Error("非法 TTS 缓存 key");
  return path.join(config.cache.dir, `${key}.${config.ext}`);
}

async function readCache(config: TtsGatewayConfig, key: string): Promise<Buffer | null> {
  if (!config.cache.enabled) return null;
  const file = cachePath(config, key);
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > config.maxAudioBytes) return null;
    const data = await fs.readFile(file);
    const now = new Date();
    void fs.utimes(file, now, now).catch(() => undefined);
    return data;
  } catch {
    return null;
  }
}

async function pruneCache(config: TtsGatewayConfig): Promise<void> {
  if (!config.cache.enabled) return;
  const names = await fs.readdir(config.cache.dir).catch(() => []);
  const entries = (await Promise.all(names
    .filter((name) => /^tts-[a-f0-9]{64}\.[a-z0-9]{2,5}$/i.test(name))
    .map(async (name) => {
      const file = path.join(config.cache.dir, name);
      const stat = await fs.stat(file).catch(() => null);
      return stat?.isFile() ? { file, size: stat.size, mtimeMs: stat.mtimeMs } : null;
    }))).filter((entry): entry is { file: string; size: number; mtimeMs: number } => !!entry);
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= config.cache.maxBytes) return;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of entries) {
    if (total <= config.cache.maxBytes) break;
    await fs.unlink(entry.file).catch(() => undefined);
    total -= entry.size;
  }
}

async function writeCache(config: TtsGatewayConfig, key: string, data: Buffer): Promise<void> {
  if (!config.cache.enabled || data.byteLength > config.cache.maxBytes) return;
  await fs.mkdir(config.cache.dir, { recursive: true });
  const target = cachePath(config, key);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, data, { flag: "wx" });
    await fs.rename(temporary, target).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      await fs.unlink(temporary).catch(() => undefined);
    });
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
  void pruneCache(config).catch(() => undefined);
}

async function upstreamError(response: Response): Promise<string> {
  const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
  return `TTS 上游返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`;
}

export async function synthesizeTts(
  config: TtsGatewayConfig,
  request: TtsSynthesisRequest
): Promise<TtsSynthesisResult> {
  const text = String(request.text || "").trim();
  if (!text) throw new Error("TTS 文本不能为空");
  if (text.length > 4_000) throw new Error("TTS 单次文本不能超过 4000 字符");
  if (request.signal?.aborted) throw new Error("TTS 请求已取消");
  const selected = request.voiceId ?? config.selections?.[request.companionId || "default"] ?? "auto";
  const option = ttsVoiceCatalog(config).voices.find(item => item.id === selected);
  if (!option || !option.available) throw new Error("所选音色不存在或尚未配置；请重新选择音色");
  const normalizedRequest = { ...request, text, ...(selected !== "auto" ? { voice: undefined } : {}) };
  let target = config;
  if (selected.startsWith("custom:")) {
    const preset = config.namedVoices!.find(item => `custom:${item.id}` === selected)!;
    target = { ...config, ...preset, headers: parseHeaders(preset.headers), profiles: { default: preset.profile } };
  } else if (selected.startsWith("primary:")) {
    target = { ...config, profiles: { default: config.profiles[selected.slice(8)]! } };
  }
  const tencentVoice = selected.startsWith("tencent:") ? Number(selected.slice(8)) : null;
  if (selected === "auto" && !config.url) return synthesizeTencentFallback(config, normalizedRequest);
  try {
    const result = tencentVoice
      ? await synthesizeTencentVoice(config, normalizedRequest, tencentVoice, config.tencent || config.tencentFallback!)
      : await synthesizePrimaryTts(target, normalizedRequest);
    return { ...result, voiceId: selected };
  } catch (error) {
    if (request.signal?.aborted) throw new Error("TTS 请求已取消");
    if (!config.tencentFallback || request.allowFallback === false || tencentVoice === TENCENT_TTS_VOICE) throw error;
    const result = await synthesizeTencentFallback(config, normalizedRequest);
    return { ...result, fallbackFrom: tencentVoice ? selected : target.provider };
  }
}

async function synthesizeTencentFallback(config: TtsGatewayConfig, request: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
  if (!config.tencentFallback) throw new Error("腾讯 TTS 备用尚未配置密钥或未开启");
  return synthesizeTencentVoice(config, request, TENCENT_TTS_VOICE, config.tencentFallback);
}

async function synthesizeTencentVoice(config: TtsGatewayConfig, request: TtsSynthesisRequest, voice: number, credentials: TencentTtsConfig): Promise<TtsSynthesisResult> {
  // A separate cache namespace: a fallback must never replace the primary's
  // voice on its next successful request. Primary style/ref audio stays private.
  const target: TtsGatewayConfig = { ...config, provider: "tencent-cloud", url: TENCENT_TTS_URL,
    format: "json", model: "premium", voice: String(voice), ext: "wav", headers: {}, profiles: {} };
  const key = cacheKey(target, { text: request.text });
  const cached = await readCache(target, key);
  if (request.signal?.aborted) throw new Error("TTS 请求已取消");
  const data = cached ?? await synthesizeTencentTts(credentials, request.text, {
    signal: request.signal, maxAudioBytes: config.maxAudioBytes, voice,
  });
  if (request.signal?.aborted) throw new Error("TTS 请求已取消");
  // A cache/disk failure is not a synthesis failure: don't lose a billed result.
  if (!cached) await writeCache(target, key, data).catch(() => undefined);
  return { data, mime: "audio/wav", ext: "wav", provider: "tencent-cloud", cacheKey: key, cached: !!cached, voiceId: `tencent:${voice}` };
}

async function synthesizePrimaryTts(config: TtsGatewayConfig, normalizedRequest: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
  const request = normalizedRequest;
  const text = request.text;
  const key = cacheKey(config, normalizedRequest);
  const cached = await readCache(config, key);
  if (request.signal?.aborted) throw new Error("TTS 请求已取消");
  if (cached) {
    return {
      data: cached,
      mime: MIME_BY_EXT[config.ext] || "application/octet-stream",
      ext: config.ext,
      provider: config.provider,
      cacheKey: key,
      cached: true,
    };
  }

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (request.signal?.aborted) controller.abort();
  else request.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    let response: Response;
    if (config.format === "query") {
      const url = new URL(config.url);
      const body = await requestBody(config, normalizedRequest);
      url.searchParams.set("text", text);
      if (body.voice) url.searchParams.set("voice", String(body.voice));
      if (body.model) url.searchParams.set("model", String(body.model));
      response = await fetch(url, { headers: config.headers, signal: controller.signal });
    } else {
      response = await fetch(config.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...config.headers },
        body: JSON.stringify(await requestBody(config, normalizedRequest)),
        signal: controller.signal,
      });
    }
    if (!response.ok) throw new Error(await upstreamError(response));

    const announced = Number(response.headers.get("content-length") || 0);
    if (announced > config.maxAudioBytes) throw new Error("TTS 上游音频超过大小上限");
    let mime = (response.headers.get("content-type") || MIME_BY_EXT[config.ext] || "application/octet-stream")
      .split(";")[0]!.trim().toLowerCase();
    let data: Buffer;
    if (config.format === "mimo-chat-audio") {
      const payload = await response.json().catch(() => null) as {
        choices?: Array<{ message?: { audio?: { data?: unknown } } }>;
      } | null;
      const encoded = payload?.choices?.[0]?.message?.audio?.data;
      if (typeof encoded !== "string" || !encoded.trim()) {
        throw new Error("MiMo TTS 响应缺少 choices[0].message.audio.data");
      }
      data = Buffer.from(encoded.replace(/^data:[^,]+,/, ""), "base64");
      mime = MIME_BY_EXT[config.ext] || "audio/wav";
    } else {
      data = Buffer.from(await response.arrayBuffer());
    }
    if (!data.byteLength) throw new Error("TTS 上游返回了空音频");
    if (data.byteLength > config.maxAudioBytes) throw new Error("TTS 上游音频超过大小上限");
    if (config.format !== "mimo-chat-audio" && (mime === "application/json" || mime.startsWith("text/"))) {
      throw new Error(`TTS 上游没有返回音频：${data.toString("utf8").replace(/\s+/g, " ").slice(0, 240)}`);
    }
    if (request.signal?.aborted) throw new Error("TTS 请求已取消");
    await writeCache(config, key, data).catch(() => undefined);
    return { data, mime, ext: config.ext, provider: config.provider, cacheKey: key, cached: false };
  } catch (error) {
    if (controller.signal.aborted) {
      if (request.signal?.aborted) throw new Error("TTS 请求已取消");
      throw new Error(`TTS 合成超时（${config.timeoutMs}ms）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function ttsGatewayStatus(config: TtsGatewayConfig | null): Record<string, unknown> {
  if (!config) return { configured: false, mode: "remote", provider: null };
  return {
    configured: true,
    mode: "remote",
    provider: config.url ? config.provider : config.tencent ? "tencent-cloud" : "voice-library",
    format: config.url ? config.format : config.tencent ? "tencent-text-to-voice" : "voice-library",
    model: config.url ? config.model || null : null,
    profiles: config.url ? Object.keys(config.profiles).filter((id) => id !== "default") : [],
    cache: { enabled: config.cache.enabled, maxBytes: config.cache.maxBytes },
    ...(config.tencentFallback ? { fallback: { provider: "tencent-cloud", voice: TENCENT_TTS_VOICE, configured: true } } : {}),
  };
}
