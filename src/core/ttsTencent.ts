import { createHash, createHmac, randomUUID } from "node:crypto";
import { TENCENT_VOICES } from "./ttsVoices";

// This fallback is deliberately fixed to a basic/premium voice. Never inherit a
// primary provider's voice ID, model, headers or reference audio (or upgrade it).
export const TENCENT_TTS_URL = "https://tts.tencentcloudapi.com/";
export const TENCENT_TTS_VOICE = 101001; // 智瑜 · 精品中文女声
export interface TencentTtsConfig { secretId: string; secretKey: string }

function text(env: object, key: string): string {
  return String((env as Record<string, unknown>)[key] ?? "").trim();
}

export function tencentTtsSettings(env: object): Record<string, unknown> {
  return {
    enabled: /^(true|1|yes|on)$/i.test(text(env, "TTS_TENCENT_FALLBACK_ENABLED")),
    credentialsConfigured: !!text(env, "TENCENT_TTS_SECRET_ID") && !!text(env, "TENCENT_TTS_SECRET_KEY"),
    voice: TENCENT_TTS_VOICE,
    voiceLabel: "智瑜 · 精品中文女声",
  };
}

export function readTencentTtsFallback(env: object): TencentTtsConfig | undefined {
  const status = tencentTtsSettings(env);
  if (!status.enabled || !status.credentialsConfigured) return undefined;
  return { secretId: text(env, "TENCENT_TTS_SECRET_ID"), secretKey: text(env, "TENCENT_TTS_SECRET_KEY") };
}

export function readTencentTtsCredentials(env: object): TencentTtsConfig | undefined {
  return text(env, "TENCENT_TTS_SECRET_ID") && text(env, "TENCENT_TTS_SECRET_KEY")
    ? { secretId: text(env, "TENCENT_TTS_SECRET_ID"), secretKey: text(env, "TENCENT_TTS_SECRET_KEY") } : undefined;
}

/** Write-only credentials. Empty fields retain the existing pair; rotation is atomic. */
export function tencentTtsSettingsPatch(input: unknown): Record<string, string> {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("腾讯 TTS 配置必须是对象");
  const body = input as Record<string, unknown>;
  const patch: Record<string, string> = {};
  if (typeof body.enabled === "boolean") patch.TTS_TENCENT_FALLBACK_ENABLED = String(body.enabled);
  if (body.clearCredentials === true) {
    patch.TENCENT_TTS_SECRET_ID = "";
    patch.TENCENT_TTS_SECRET_KEY = "";
  } else {
    const id = typeof body.secretId === "string" ? body.secretId.trim() : "";
    const key = typeof body.secretKey === "string" ? body.secretKey.trim() : "";
    if (id || key) {
      if (!/^[A-Za-z0-9]{16,128}$/.test(id) || !/^[A-Za-z0-9]{16,128}$/.test(key)) {
        throw new Error("请同时填写有效的腾讯云 SecretId 和 SecretKey（不含空格、换行或引号）");
      }
      patch.TENCENT_TTS_SECRET_ID = id;
      patch.TENCENT_TTS_SECRET_KEY = key;
    }
  }
  return patch;
}

/** Tencent Cloud API 3.0 TC3 signature. Only the fixed official TTS host is signed. */
export function tencentTtsHeaders(config: TencentTtsConfig, body: string, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = "application/json; charset=utf-8";
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalHeaders = `content-type:${contentType}\nhost:tts.tencentcloudapi.com\nx-tc-action:texttovoice\n`;
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hash(body)}`;
  const scope = `${date}/tts/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(`TC3${config.secretKey}`, date), "tts"), "tc3_request");
  return {
    "Content-Type": contentType,
    "X-TC-Action": "TextToVoice",
    "X-TC-Version": "2019-08-23",
    "X-TC-Timestamp": String(timestamp),
    Authorization: `TC3-HMAC-SHA256 Credential=${config.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hmac(signingKey, stringToSign).toString("hex")}`,
  };
}

/** Conservative mixed-language limit: <= 140 code points and <= 420 UTF-8 bytes. */
export function splitTencentTtsText(value: string): string[] {
  const chars = Array.from(value);
  const parts: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = start;
    let bytes = 0;
    let boundary = start;
    while (end < chars.length && end - start < 140) {
      const char = chars[end]!;
      const size = Buffer.byteLength(char, "utf8");
      if (bytes + size > 420) break;
      bytes += size;
      end += 1;
      if (/[。！？!?；;，,\n\s]/u.test(char)) boundary = end;
    }
    if (end < chars.length && boundary > start + (end - start) / 2) end = boundary;
    parts.push(chars.slice(start, end).join(""));
    start = end;
  }
  return parts;
}

async function readResponse(response: Response, maxBytes: number): Promise<unknown> {
  if (Number(response.headers.get("content-length") || 0) > maxBytes) {
    await response.body?.cancel();
    throw new Error("腾讯 TTS 响应超过大小上限");
  }
  if (!response.body) throw new Error("腾讯 TTS 返回空响应");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("腾讯 TTS 响应超过大小上限");
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("腾讯 TTS 返回无效 JSON"); }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Merge PCM WAV data, not complete RIFF files (which would truncate playback). */
export function joinTencentWav(parts: Buffer[], maxBytes: number): Buffer {
  let format: Buffer | undefined;
  const samples: Buffer[] = [];
  let sampleBytes = 0;
  for (const wav of parts) {
    if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE"
      || wav.readUInt32LE(4) + 8 !== wav.length) throw new Error("腾讯 TTS 返回无效 WAV 音频");
    let partFormat: Buffer | undefined;
    const partSamples: Buffer[] = [];
    for (let offset = 12; offset < wav.length;) {
      if (offset + 8 > wav.length) throw new Error("腾讯 TTS WAV 分块不完整");
      const size = wav.readUInt32LE(offset + 4);
      const end = offset + 8 + size;
      if (end > wav.length) throw new Error("腾讯 TTS WAV 分块不完整");
      const id = wav.toString("ascii", offset, offset + 4);
      if (id === "fmt ") partFormat = wav.subarray(offset + 8, end);
      if (id === "data") partSamples.push(wav.subarray(offset + 8, end));
      offset = end + (size % 2);
    }
    if (!partFormat || partFormat.length < 16 || partFormat.readUInt16LE(0) !== 1
      || partFormat.readUInt16LE(2) !== 1 || partFormat.readUInt32LE(4) !== 16000
      || partFormat.readUInt32LE(8) !== 32000 || partFormat.readUInt16LE(12) !== 2
      || partFormat.readUInt16LE(14) !== 16 || !partSamples.length
      || partSamples.some((part) => !part.length || part.length % 2 !== 0)) {
      throw new Error("腾讯 TTS WAV 必须为非空 16kHz 单声道 PCM16");
    }
    if (format && !format.equals(partFormat.subarray(0, 16))) throw new Error("腾讯 TTS 分段音频格式不一致");
    format = partFormat.subarray(0, 16);
    for (const sample of partSamples) {
      sampleBytes += sample.length;
      if (sampleBytes + 44 > maxBytes) throw new Error("腾讯 TTS 音频超过大小上限");
      samples.push(sample);
    }
  }
  if (!format || !sampleBytes) throw new Error("腾讯 TTS 返回空音频");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(sampleBytes + 36, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); format.copy(header, 20);
  header.write("data", 36); header.writeUInt32LE(sampleBytes, 40);
  return Buffer.concat([header, ...samples]);
}

export async function synthesizeTencentTts(config: TencentTtsConfig, text: string, options: {
  signal?: AbortSignal; maxAudioBytes: number; timeoutMs?: number; voice?: number;
}): Promise<Buffer> {
  const voice = options.voice ?? TENCENT_TTS_VOICE;
  if (!TENCENT_VOICES.some(item => item.voice === voice)) throw new Error("腾讯 TTS 音色不在已支持目录中");
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 45_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const wavs: Buffer[] = [];
  let totalBytes = 0;
  try {
    for (const part of splitTencentTtsText(text)) {
      signal.throwIfAborted();
      // Plain text only; do not allow SSML to alter voices or fetch external audio.
      const body = JSON.stringify({ Text: part.replace(/</g, "＜").replace(/>/g, "＞"),
        SessionId: randomUUID(), ModelType: 1, VoiceType: voice,
        Codec: "wav", SampleRate: 16000, Speed: 0, Volume: 0 });
      const response = await fetch(TENCENT_TTS_URL, { method: "POST", redirect: "error",
        headers: tencentTtsHeaders(config, body), body, signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`腾讯 TTS 返回 HTTP ${response.status}`);
      }
      const payload = await readResponse(response, Math.ceil(options.maxAudioBytes * 4 / 3) + 65536) as {
        Response?: { Audio?: unknown; Error?: { Code?: unknown } };
      } | null;
      const result = payload?.Response;
      if (result?.Error) {
        // Never echo upstream Message, request body, credentials or signature.
        const raw = result.Error.Code;
        const code = typeof raw === "string" && /^[A-Za-z0-9_.]{1,100}$/.test(raw) ? raw : "UnknownError";
        throw new Error(`腾讯 TTS 调用失败（${code}）；本次不自动重试`);
      }
      const encoded = result?.Audio;
      if (typeof encoded !== "string" || !encoded.length || encoded.length % 4 !== 0
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("腾讯 TTS 响应缺少有效音频");
      const wav = Buffer.from(encoded, "base64");
      totalBytes += wav.length;
      if (totalBytes > options.maxAudioBytes) throw new Error("腾讯 TTS 音频超过大小上限");
      joinTencentWav([wav], options.maxAudioBytes); // Fail before sending another billed chunk.
      wavs.push(wav);
    }
    signal.throwIfAborted();
    return joinTencentWav(wavs, options.maxAudioBytes);
  } catch (error) {
    if (options.signal?.aborted) throw new Error("TTS 请求已取消");
    if (timeout.aborted) throw new Error("腾讯 TTS 合成超时；本次不自动重试");
    // fetch errors can contain implementation details; our own errors contain no secrets.
    if (error instanceof Error && error.message.startsWith("腾讯 TTS")) throw error;
    throw new Error("腾讯 TTS 网络请求失败；本次不自动重试");
  }
}
