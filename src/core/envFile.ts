import { promises as fs } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { readSharedSettings, writeSharedSettings } from "./sharedSettings";

/**
 * .env 读写 helper —— 前端「模型管理」改 KEY/URL/model 时用。
 * 决策（见 PLAN）：模型密钥直接改 .env，不另建独立密钥库；改动写 .env + 提示「重启生效」
 * （backends/Router 在启动定死，env.ts 仅启动读一次，故 KEY/URL 改动本就需重启）。
 *
 * 写入时【保留注释、空行与未涉及键的原始顺序/格式】：只就地改动指定键，不存在则追加末尾。
 */

const ENV_PATH = path.resolve(process.cwd(), ".env");
/** Dashboard 保存、两个渠道同时完成配对时都可能并发写 .env；严格串行避免后写覆盖前写。 */
let envWriteTail: Promise<void> = Promise.resolve();

/** 读取 .env 现值（文件不存在 → 空对象）。 */
export async function readEnvValues(): Promise<Record<string, string>> {
  const shared = readSharedSettings();
  try {
    // 与启动时 dotenv.config 使用同一语法，避免热保存成功、重启后 JSON 失效。
    return { ...shared, ...dotenv.parse(await fs.readFile(ENV_PATH, "utf8")) };
  } catch {
    return shared;
  }
}

function formatLine(k: string, v: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || v.includes("\0")) {
    throw new Error("环境配置键或值无效；配置未写入。");
  }
  // dotenv 不会解码 JSON.stringify 产生的 \" / \\；JSON、Windows 路径必须按原文保存。
  // 始终只写单行，保留现有逐行更新和注释保留契约。
  const candidates: string[] = [];
  if (!/^["'`]/.test(v.trim())) candidates.push(v);
  for (const quote of ["'", "`", '"']) {
    if (v.includes(quote)) continue;
    const value = quote === '"' ? v.replace(/\r/g, "\\r").replace(/\n/g, "\\n") : v;
    candidates.push(`${quote}${value}${quote}`);
  }
  for (const candidate of candidates) {
    if (/[\r\n]/.test(candidate)) continue;
    const line = `${k}=${candidate}`;
    if (dotenv.parse(line)[k] === v) return line;
  }
  // 不把凭据或原始值带进报错；无损表达不了时在写盘前拒绝。
  throw new Error(`${k} 含有 .env 无法无损保存的字符组合；配置未写入。`);
}

/**
 * 就地更新 .env 里的若干键：已存在改值、不存在追加末尾，保留其余一切（注释/空行/顺序）。
 * 选择可被启动端 dotenv 无损读取的引号形式；不对 JSON 值重复转义。
 */
export function updateEnvValues(patch: Record<string, string>): Promise<void> {
  const write = envWriteTail.then(() => writeEnvValues(patch));
  // 当前调用仍收到真实错误；后续写入不能被前一次失败永久毒死。
  envWriteTail = write.catch(() => {});
  return write;
}

async function writeEnvValues(patch: Record<string, string>): Promise<void> {
  let raw = "";
  try {
    raw = await fs.readFile(ENV_PATH, "utf8");
  } catch {
    raw = "";
  }
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.length ? raw.split(/\r?\n/) : [];
  const remaining: Record<string, string> = { ...patch };

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    if (Object.prototype.hasOwnProperty.call(remaining, key)) {
      lines[i] = formatLine(key, remaining[key]!);
      delete remaining[key];
    }
  }

  const additions = Object.entries(remaining).map(([k, v]) => formatLine(k, v));
  let body = lines.join(eol);
  if (additions.length) {
    if (body.length && !body.endsWith(eol)) body += eol;
    body += additions.join(eol) + eol;
  }
  const expected = { ...dotenv.parse(raw), ...patch };
  const actual = dotenv.parse(body);
  if (Object.keys(expected).length !== Object.keys(actual).length
    || Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
    throw new Error("环境配置无法无损更新；配置未写入。");
  }
  await fs.writeFile(ENV_PATH, body, "utf8");
  // Mirror only portable preferences, never credentials. Keep the existing local override semantics.
  await writeSharedSettings(patch);
}
