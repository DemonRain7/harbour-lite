import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { Attachment } from "../types";
import { channelAttachmentUrlDiagnostic, isTrustedChannelAttachmentUrl } from "./channelAttachmentUrl";

export interface SttProviderConfig {
  name: string;
  url: string;
  headers: Record<string, string>;
  model: string;
  language?: string;
}

export interface SttGatewayConfig {
  enabled: boolean;
  providers: SttProviderConfig[];
  timeoutMs: number;
  maxAudioBytes: number;
  maxSeconds: number;
  maxConcurrency: number;
  maxRequestsPerMinute: number;
}

export interface SttTranscriptionResult {
  text: string;
  provider: string;
  processingMs: number;
  audioDurationMs?: number;
  language?: string;
}

export interface SttAttachmentContext {
  platform: "web" | "discord" | "qq";
  actorKey: string;
  uploadDir: string;
  signal?: AbortSignal;
}

interface LoadedAudio {
  data: Buffer;
  mime: string;
  name: string;
  durationMs?: number;
}

interface FallbackInput {
  name?: unknown;
  url?: unknown;
  headers?: unknown;
  model?: unknown;
  language?: unknown;
}

type EnvLike = object;

const AUDIO_MIME_BY_KIND: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  webm: "audio/webm",
  m4a: "audio/mp4",
  flac: "audio/flac",
  amr: "audio/amr",
};

function envText(env: EnvLike, key: string): string {
  const value = (env as Record<string, unknown>)[key];
  return value == null ? "" : String(value).trim();
}

function envBool(env: EnvLike, key: string, fallback: boolean): boolean {
  const value = envText(env, key);
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function parseHeaders(raw: unknown): Record<string, string> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>)
      .map(([name, value]) => [name.trim(), String(value ?? "").trim()] as const)
      .filter(([name, value]) => name && value && !/^(host|content-length|content-type)$/i.test(name)));
  }
  const headers: Record<string, string> = {};
  for (const pair of String(raw ?? "").split(";")) {
    const separator = pair.indexOf(":");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!name || !value || /^(host|content-length|content-type)$/i.test(name)) continue;
    headers[name] = value;
  }
  return headers;
}

function transcriptionUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("STT_URL 不是合法 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("STT_URL 只允许 HTTP/HTTPS");
  const cleanPath = url.pathname.replace(/\/+$/, "");
  if (!/\/audio\/transcriptions$/i.test(cleanPath)) {
    url.pathname = `${cleanPath.replace(/\/v1$/i, "")}/v1/audio/transcriptions`.replace(/\/+/g, "/");
  }
  return url.toString();
}

function providerFrom(input: FallbackInput, defaults: Partial<SttProviderConfig>, index = 0): SttProviderConfig | null {
  const rawUrl = String(input.url ?? defaults.url ?? "").trim();
  if (!rawUrl) return null;
  const url = transcriptionUrl(rawUrl);
  const hostname = new URL(url).hostname;
  const name = String(input.name ?? defaults.name ?? hostname ?? `provider-${index + 1}`).trim().slice(0, 64)
    || `provider-${index + 1}`;
  return {
    name,
    url,
    headers: parseHeaders(input.headers ?? defaults.headers ?? {}),
    model: String(input.model ?? defaults.model ?? "sensevoice").trim() || "sensevoice",
    ...(String(input.language ?? defaults.language ?? "").trim() && String(input.language ?? defaults.language).trim().toLowerCase() !== "auto"
      ? { language: String(input.language ?? defaults.language).trim() }
      : {}),
  };
}

function parseFallbacks(raw: string, defaults: Partial<SttProviderConfig>): SttProviderConfig[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("STT_FALLBACKS_JSON 不是合法 JSON");
  }
  if (!Array.isArray(value)) throw new Error("STT_FALLBACKS_JSON 必须是 Provider 数组");
  return value
    .map((item, index) => item && typeof item === "object" && !Array.isArray(item)
      ? providerFrom(item as FallbackInput, defaults, index + 1)
      : null)
    .filter((item): item is SttProviderConfig => !!item);
}

/** 读取远端 STT 配置。URL 为空是正常的“尚未配置”，不会影响文字消息与 QQ 原生 ASR。 */
export function readSttGatewayConfig(env: EnvLike = process.env): SttGatewayConfig {
  const values = env as Record<string, unknown>;
  const primaryUrl = envText(env, "STT_URL");
  const defaults: Partial<SttProviderConfig> = {
    name: envText(env, "STT_PROVIDER") || "primary",
    url: primaryUrl,
    headers: parseHeaders(envText(env, "STT_HEADERS")),
    model: envText(env, "STT_MODEL") || "sensevoice",
    language: envText(env, "STT_LANGUAGE") || undefined,
  };
  const primary = primaryUrl ? providerFrom({ url: primaryUrl }, defaults) : null;
  const providers = [primary, ...parseFallbacks(envText(env, "STT_FALLBACKS_JSON"), defaults)]
    .filter((item): item is SttProviderConfig => !!item);
  return {
    enabled: envBool(env, "STT_ENABLED", true),
    providers,
    timeoutMs: boundedNumber(values.STT_TIMEOUT_MS, 120_000, 1_000, 10 * 60_000),
    maxAudioBytes: Math.round(boundedNumber(values.STT_MAX_AUDIO_MB, 25, 1, 100) * 1024 * 1024),
    maxSeconds: boundedNumber(values.STT_MAX_SECONDS, 300, 1, 3_600),
    maxConcurrency: Math.round(boundedNumber(values.STT_MAX_CONCURRENCY, 2, 1, 16)),
    maxRequestsPerMinute: Math.round(boundedNumber(values.STT_MAX_REQUESTS_PER_MINUTE, 12, 1, 120)),
  };
}

export class SttGateway {
  private config: SttGatewayConfig;
  private active = 0;
  private waiters: Array<() => void> = [];
  private readonly recentByActor = new Map<string, number[]>();
  /** Web 先转写、允许用户编辑、再发送时复用；upload URL 是 UUID 且文件不可覆盖。 */
  private readonly recentResults = new Map<string, { result: SttTranscriptionResult; expiresAt: number }>();

  constructor(config: SttGatewayConfig, private readonly logger: Logger) {
    this.config = config;
  }

  updateConfig(config: SttGatewayConfig): void {
    this.config = config;
  }

  currentConfig(): SttGatewayConfig {
    return this.config;
  }

  status(): Record<string, unknown> {
    return {
      enabled: this.config.enabled,
      configured: this.config.providers.length > 0,
      mode: "remote",
      protocol: "openai-compatible",
      providers: this.config.providers.map((provider, index) => ({
        name: provider.name,
        model: provider.model,
        language: provider.language || "auto",
        primary: index === 0,
      })),
      active: this.active,
      queued: this.waiters.length,
      limits: {
        maxAudioMb: Math.round(this.config.maxAudioBytes / 1024 / 1024),
        maxSeconds: this.config.maxSeconds,
        maxConcurrency: this.config.maxConcurrency,
        maxRequestsPerMinute: this.config.maxRequestsPerMinute,
      },
    };
  }

  async transcribeAttachment(attachment: Attachment, context: SttAttachmentContext): Promise<SttTranscriptionResult> {
    this.assertAvailable();
    this.checkRate(context.actorKey);
    const loaded = await loadAttachmentAudio(attachment, context, this.config);
    const result = await this.transcribeLoaded(loaded, context.signal);
    this.remember(attachment.url, result);
    return result;
  }

  /** Web composer 预转写后，/api/run 用这个确认该附件确实由当前 Harbour 转写过。 */
  recentResult(attachmentUrl: string): SttTranscriptionResult | undefined {
    const hit = this.recentResults.get(attachmentUrl);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.recentResults.delete(attachmentUrl);
      return undefined;
    }
    return hit.result;
  }

  /** 设置页的显式测试：发一段 0.25 秒静音，验证 multipart、鉴权、模型和响应解析。 */
  async probe(signal?: AbortSignal): Promise<SttTranscriptionResult> {
    this.assertAvailable();
    return this.transcribeLoaded({
      data: silentWav(250),
      mime: "audio/wav",
      name: "harbour-stt-probe.wav",
      durationMs: 250,
    }, signal, true);
  }

  private assertAvailable(): void {
    if (!this.config.enabled) throw new Error("STT 已关闭");
    if (!this.config.providers.length) throw new Error("Harbour 尚未配置远端 STT Provider");
  }

  private remember(attachmentUrl: string, result: SttTranscriptionResult): void {
    if (!attachmentUrl) return;
    const now = Date.now();
    this.recentResults.set(attachmentUrl, { result, expiresAt: now + 30 * 60_000 });
    if (this.recentResults.size <= 512) return;
    for (const [url, item] of this.recentResults) {
      if (item.expiresAt <= now) this.recentResults.delete(url);
    }
    while (this.recentResults.size > 512) {
      const first = this.recentResults.keys().next().value as string | undefined;
      if (!first) break;
      this.recentResults.delete(first);
    }
  }

  private checkRate(actorKey: string): void {
    const key = String(actorKey || "anonymous").slice(0, 180);
    const now = Date.now();
    const recent = (this.recentByActor.get(key) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= this.config.maxRequestsPerMinute) throw new Error("语音转写过于频繁，请稍后再试");
    recent.push(now);
    this.recentByActor.set(key, recent);
    if (this.recentByActor.size > 2_048) {
      for (const [id, times] of this.recentByActor) {
        if (!times.some((at) => now - at < 60_000)) this.recentByActor.delete(id);
      }
    }
  }

  private async transcribeLoaded(
    audio: LoadedAudio,
    signal?: AbortSignal,
    allowEmpty = false
  ): Promise<SttTranscriptionResult> {
    const release = await this.acquire(signal);
    const failures: string[] = [];
    try {
      for (const provider of this.config.providers) {
        const started = Date.now();
        try {
          const result = await callProvider(provider, audio, this.config.timeoutMs, signal, allowEmpty);
          const processingMs = Date.now() - started;
          this.logger.info({
            provider: provider.name,
            model: provider.model,
            bytes: audio.data.byteLength,
            processingMs,
            audioDurationMs: audio.durationMs,
          }, "stt:complete");
          return {
            ...result,
            provider: provider.name,
            processingMs,
            ...(audio.durationMs ? { audioDurationMs: audio.durationMs } : {}),
          };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          failures.push(`${provider.name}: ${detail}`);
          this.logger.warn({ provider: provider.name, err: detail }, "stt:provider-failed");
          if (signal?.aborted) throw error;
        }
      }
      throw new Error(`所有 STT Provider 均失败：${failures.join("；").slice(0, 600)}`);
    } finally {
      release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("STT 请求已取消"));
    if (this.active < this.config.maxConcurrency) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }
    return new Promise<() => void>((resolve, reject) => {
      let settled = false;
      const run = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        this.active += 1;
        resolve(() => this.release());
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        this.waiters = this.waiters.filter((waiter) => waiter !== run);
        reject(new Error("STT 请求已取消"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(run);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.();
  }
}

async function callProvider(
  provider: SttProviderConfig,
  audio: LoadedAudio,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  allowEmpty: boolean
): Promise<{ text: string; language?: string }> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("STT timeout"));
  }, timeoutMs);
  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio.data)], { type: audio.mime }), audio.name);
    form.append("model", provider.model);
    form.append("response_format", "json");
    if (provider.language) form.append("language", provider.language);
    const response = await fetch(provider.url, {
      method: "POST",
      headers: provider.headers,
      body: form,
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      const detail = body.replace(/\s+/g, " ").slice(0, 300);
      throw new Error(`HTTP ${response.status}${detail ? `：${detail}` : ""}`);
    }
    let text = "";
    let language = "";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("json") || /^\s*[{[]/.test(body)) {
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { throw new Error("上游返回了无效 JSON"); }
      if (parsed && typeof parsed === "object") {
        const value = parsed as Record<string, unknown>;
        text = String(value.text ?? value.transcript ?? "");
        language = String(value.language ?? "").trim();
      }
    } else {
      text = body;
    }
    text = cleanTranscript(text);
    if (!text && !allowEmpty) throw new Error("上游返回了空转写");
    if (text.length > 100_000) throw new Error("STT 转写文本超过 100000 字符上限");
    return { text, ...(language ? { language } : {}) };
  } catch (error) {
    if (controller.signal.aborted) {
      if (callerSignal?.aborted) throw new Error("STT 请求已取消");
      if (timedOut) throw new Error(`转写超时（${timeoutMs}ms）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

function cleanTranscript(value: string): string {
  return String(value || "")
    .replace(/^(?:\s*<\|[^|>]{1,80}\|>)+\s*/g, "")
    .replace(/\u0000/g, "")
    .trim();
}

async function loadAttachmentAudio(
  attachment: Attachment,
  context: SttAttachmentContext,
  config: SttGatewayConfig
): Promise<LoadedAudio> {
  if (attachment.kind !== "audio") throw new Error("只允许转写音频附件");
  let data: Buffer;
  if (attachment.url.startsWith("/uploads/")) {
    const root = path.resolve(context.uploadDir);
    const relative = decodeURIComponent(attachment.url.slice("/uploads/".length));
    const target = path.resolve(root, relative);
    if (target === root || !target.startsWith(`${root}${path.sep}`)) throw new Error("音频路径越出 Harbour 上传目录");
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error("音频附件不是文件");
    if (stat.size > config.maxAudioBytes) throw new Error("语音文件超过 STT 大小上限");
    data = await fs.readFile(target);
  } else {
    if (context.platform === "web") throw new Error("Web STT 只接受 Harbour /uploads 音频");
    data = await fetchRemoteAudio(attachment.url, context.platform, config.maxAudioBytes, context.signal);
  }
  if (!data.byteLength) throw new Error("语音文件为空");
  if (data.byteLength > config.maxAudioBytes) throw new Error("语音文件超过 STT 大小上限");
  const detected = detectAudio(data);
  if (!detected) throw new Error("无法识别音频签名；仅支持 wav/mp3/ogg/webm/m4a/flac/amr");
  const declaredDuration = Number(attachment.durationMs);
  const durationMs = detected.durationMs
    ?? (Number.isFinite(declaredDuration) && declaredDuration > 0 ? declaredDuration : undefined);
  if (durationMs && durationMs > config.maxSeconds * 1_000) {
    throw new Error(`语音超过 ${config.maxSeconds} 秒上限`);
  }
  return {
    data,
    mime: AUDIO_MIME_BY_KIND[detected.kind]!,
    name: safeAudioName(attachment.name, detected.kind),
    ...(durationMs ? { durationMs } : {}),
  };
}

async function fetchRemoteAudio(
  rawUrl: string,
  platform: "discord" | "qq",
  maxBytes: number,
  signal?: AbortSignal
): Promise<Buffer> {
  let current: URL;
  try { current = new URL(rawUrl); } catch { throw new Error("平台音频 URL 无效"); }
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!isTrustedChannelAttachmentUrl(platform, current, "audio")) {
      const target = channelAttachmentUrlDiagnostic(current);
      throw new Error(`${platform} 音频 URL 不属于受信官方 CDN（${target.protocol}//${target.hostname}；端口 ${target.port}）`);
    }
    const response = await fetch(current, { redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("平台音频重定向缺少 Location");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`下载平台音频失败：HTTP ${response.status}`);
    const announced = Number(response.headers.get("content-length") || 0);
    if (announced > maxBytes) throw new Error("平台语音超过 STT 大小上限");
    if (!response.body) return Buffer.from(await response.arrayBuffer());
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("平台语音超过 STT 大小上限");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  }
  throw new Error("平台音频重定向次数过多");
}

function safeAudioName(raw: string, kind: string): string {
  const stem = path.basename(String(raw || "voice")).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 120) || "voice";
  const withoutExt = stem.replace(/\.[^.]+$/, "");
  return `${withoutExt}.${kind === "m4a" ? "m4a" : kind}`;
}

function detectAudio(data: Buffer): { kind: string; durationMs?: number } | null {
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WAVE") {
    return { kind: "wav", ...(wavDurationMs(data) ? { durationMs: wavDurationMs(data) } : {}) };
  }
  if (data.subarray(0, 4).toString("ascii") === "OggS") return { kind: "ogg" };
  if (data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) return { kind: "webm" };
  if (data.subarray(0, 4).toString("ascii") === "fLaC") return { kind: "flac" };
  if (data.subarray(0, 5).toString("ascii") === "#!AMR") return { kind: "amr" };
  if (data.length >= 12 && data.subarray(4, 8).toString("ascii") === "ftyp") return { kind: "m4a" };
  if (data.subarray(0, 3).toString("ascii") === "ID3" || (data.length >= 2 && data[0] === 0xff && (data[1]! & 0xe0) === 0xe0)) return { kind: "mp3" };
  return null;
}

function wavDurationMs(data: Buffer): number | undefined {
  if (data.length < 44) return undefined;
  const byteRate = data.readUInt32LE(28);
  if (!byteRate) return undefined;
  let offset = 12;
  while (offset + 8 <= data.length) {
    const id = data.subarray(offset, offset + 4).toString("ascii");
    const size = data.readUInt32LE(offset + 4);
    if (id === "data") return Math.round(size / byteRate * 1_000);
    offset += 8 + size + (size % 2);
  }
  return undefined;
}

function silentWav(durationMs: number): Buffer {
  const sampleRate = 8_000;
  const samples = Math.max(1, Math.round(sampleRate * durationMs / 1_000));
  const dataSize = samples * 2;
  const out = Buffer.alloc(44 + dataSize);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataSize, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataSize, 40);
  return out;
}
