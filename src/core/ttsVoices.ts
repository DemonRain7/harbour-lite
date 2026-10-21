import type { TtsVoiceProfile, TtsFormat } from "./ttsGateway";

// A small, explicit catalogue, not a claim that every Tencent voice is available.
// Source: https://cloud.tencent.com/document/product/1073/92668 (2026-10-15).
export const TENCENT_VOICES = [
  { voice: 101001, label: "智瑜", tier: "精品", description: "中文女声 · 低成本备用" },
  { voice: 101026, label: "智希", tier: "精品", description: "中文女声" },
  { voice: 101004, label: "智云", tier: "精品", description: "中文男声" },
  { voice: 501004, label: "月华", tier: "大模型", description: "聊天女声" },
  { voice: 601009, label: "爱小芊", tier: "大模型", description: "聊天女声" },
  { voice: 601010, label: "爱小娇", tier: "大模型", description: "聊天女声" },
  { voice: 402000, label: "云晓芙", tier: "超自然大模型", description: "聊天女声" },
  { voice: 402001, label: "云小团", tier: "超自然大模型", description: "温柔女声" },
] as const;

export interface NamedTtsVoice {
  id: string; label: string; provider: string; format: TtsFormat; url: string;
  model: string; voice: string; ext: string; headers: string; profile: TtsVoiceProfile;
}
export const VOICE_ID = /^(?:auto|tencent:\d{6}|primary:[a-z0-9_-]{1,48}|custom:[a-z0-9_-]{1,48})$/;
const formats = ["json", "query", "gpt-sovits-v2", "openai-speech", "mimo-chat-audio"];

export function normalizeNamedVoice(input: unknown, previous?: NamedTtsVoice): NamedTtsVoice {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("音色配置必须是对象");
  const row = input as Record<string, unknown>;
  const text = (key: string, fallback = "", max = 4000) => {
    if (row[key] != null && typeof row[key] !== "string") throw new Error(`音色 ${key} 格式无效`);
    const value = String(row[key] ?? fallback).trim();
    if (value.length > max || value.includes("\0")) throw new Error(`音色 ${key} 过长或无效`);
    return value;
  };
  const id = text("id", "", 48), label = text("label", "", 80);
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id) || !label) throw new Error("音色需要有效的 ID 和名称");
  const format = text("format", "json") as TtsFormat;
  if (!formats.includes(format)) throw new Error("不支持的音色接口协议");
  const url = text("url");
  if (url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error("音色接口 URL 无效"); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error("音色只支持不含内嵌凭据的 HTTP/HTTPS 地址");
  }
  const profile: TtsVoiceProfile = {};
  if (row.profile != null && (typeof row.profile !== "object" || Array.isArray(row.profile))) throw new Error("音色 profile 必须是对象");
  const raw = (row.profile || {}) as Record<string, unknown>;
  for (const key of ["refAudioPath", "promptText", "promptLang", "textLang", "stylePrompt"] as const) {
    if (raw[key] == null) continue;
    if (typeof raw[key] !== "string" || raw[key].length > 4000) throw new Error(`音色 ${key} 格式无效`);
    if (raw[key].trim()) profile[key] = raw[key].trim();
  }
  if (raw.speed != null) {
    if (typeof raw.speed !== "number" || !Number.isFinite(raw.speed) || raw.speed < 0.5 || raw.speed > 2) throw new Error("音色语速必须为 0.5–2");
    profile.speed = raw.speed;
  }
  const ext = text("ext", "wav", 5);
  if (!["wav", "mp3", "ogg", "webm", "m4a", "aac", "flac"].includes(ext)) throw new Error("音色音频格式无效");
  const headers = row.clearHeaders === true ? "" : text("headers") || previous?.headers || "";
  if (/[\r\n]/.test(headers)) throw new Error("音色鉴权 Headers 不能包含换行");
  return { id, label, provider: text("provider", "custom-json", 80), format, url,
    model: text("model", "", 200), voice: text("voice", "", 200), ext, headers, profile };
}

export function readNamedVoices(raw: unknown): NamedTtsVoice[] {
  const defaults = ["aemeath", "elaina"].map(id => normalizeNamedVoice({ id, label: `${id === "aemeath" ? "Aemeath" : "Elaina"} · 专属声线` }));
  if (!raw) return defaults;
  let data;
  try { data = JSON.parse(String(raw)); } catch { throw new Error("TTS_VOICES_JSON 不是合法 JSON"); }
  if (!Array.isArray(data) || data.length > 40) throw new Error("音色库必须为数组，最多 40 项");
  const rows = data.map(row => normalizeNamedVoice(row));
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("音色 ID 重复");
  const result = [...rows, ...defaults.filter(row => !rows.some(item => item.id === row.id))];
  if (result.length > 40) throw new Error("音色库最多 40 项（包含角色预留声线）");
  return result;
}

export function readVoiceSelections(raw: unknown): Record<string, string> {
  if (!raw) return {};
  let data;
  try { data = JSON.parse(String(raw)); } catch { throw new Error("TTS_VOICE_SELECTIONS_JSON 不是合法 JSON"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("音色选择必须是角色映射");
  const result: Record<string, string> = Object.create(null);
  for (const [id, value] of Object.entries(data)) {
    if (!/^[a-z0-9_-]{1,48}$/.test(id) || typeof value !== "string" || !VOICE_ID.test(value)) throw new Error("音色选择无效");
    result[id] = value;
  }
  return result;
}
