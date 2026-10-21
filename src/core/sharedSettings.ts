import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Deliberate allowlist: never export keys, headers, URLs, machine paths, bot bindings or device permissions.
const keys = new Set([
  "DEFAULT_AGENT", "WORKER_CONCURRENCY", "HEARTBEAT_INTERVAL_MS", "LOG_LEVEL",
  "ENABLE_CODEX_HARNESS", "CODEX_HARNESS_MODEL", "CODEX_HARNESS_MODELS",
  "CODEX_HARNESS_CONTEXT_WINDOW", "CODEX_HARNESS_STARTUP_TIMEOUT_MS", "CLAUDE_AGENT_THINKING",
  "OPENCLI_BROWSER_IDLE_TIMEOUT", "HARBOUR_CHROME_START_TIMEOUT_MS",
  "MAX_UPLOAD_MB", "ATTACHMENT_RETENTION_DAYS", "ATTACHMENT_CLEANUP_INTERVAL_HOURS",
  "STT_ENABLED", "STT_MODEL", "STT_LANGUAGE", "STT_TIMEOUT_MS", "STT_MAX_AUDIO_MB",
  "STT_MAX_SECONDS", "STT_MAX_CONCURRENCY", "STT_MAX_REQUESTS_PER_MINUTE",
  "TTS_ENABLED", "TTS_FORMAT", "TTS_MODEL", "TTS_VOICE", "TTS_EXT", "TTS_TIMEOUT_MS",
  "TTS_MAX_AUDIO_MB", "TTS_CACHE_ENABLED", "TTS_CACHE_MAX_MB",
  "DAILY_NEWS_MODEL", "DAILY_NEWS_SUMMARY_LIMIT", "DAILY_NEWS_MAX_AGE_DAYS",
  "STOCK_NEWS_TICKERS", "STOCK_NEWS_SUMMARY_LIMIT", "STOCK_NEWS_MAX_AGE_DAYS",
  "STOCK_NEWS_WINDOW_HOURS", "STOCK_NEWS_MOVE_THRESHOLD_PCT",
  "SESSIONS_ENABLED", "SESSION_COMPACT_TOKENS", "SESSION_KEEP_RECENT", "SESSION_KEEP_RECENT_TOKENS",
]);

export function sharedSettingsPath(root = process.cwd()): string {
  return path.join(root, "data", "sharedSettings.json");
}

export function selectSharedSettings(values: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(values)
    .filter(([key, value]) => keys.has(key) && typeof value === "string")
    .sort(([a], [b]) => a.localeCompare(b))) as Record<string, string>;
}

export function readSharedSettings(root = process.cwd()): Record<string, string> {
  let raw;
  try { raw = readFileSync(sharedSettingsPath(root), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  const data = JSON.parse(raw);
  if (data?.version !== 1 || !data.values || typeof data.values !== "object" || Array.isArray(data.values)) {
    throw new Error("data/sharedSettings.json 格式无效；未加载共享设置");
  }
  const selected = selectSharedSettings(data.values);
  if (Object.keys(selected).length !== Object.keys(data.values).length) {
    throw new Error("data/sharedSettings.json 包含非白名单字段或非字符串值；秘密与设备配置必须留在 .env");
  }
  return selected;
}

/** Local .env / explicit process environment still wins; a clone never imports another host's paths or keys. */
export function applySharedSettingsDefaults(target: NodeJS.ProcessEnv, values: Record<string, string>): void {
  for (const [key, value] of Object.entries(selectSharedSettings(values))) {
    if (target[key] === undefined) target[key] = value;
  }
}

// Calls from Dashboard already use envWriteTail; exports are explicitly run while preparing a Git update.
export async function writeSharedSettings(patch: Record<string, unknown>, root = process.cwd()): Promise<void> {
  const safe = selectSharedSettings(patch);
  if (!Object.keys(safe).length) return;
  const values = selectSharedSettings({ ...readSharedSettings(root), ...safe });
  const file = sharedSettingsPath(root);
  const text = JSON.stringify({ version: 1, values }, null, 2) + "\n";
  try { if (await fs.readFile(file, "utf8") === text) return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, text, { flag: "wx", encoding: "utf8" });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}
