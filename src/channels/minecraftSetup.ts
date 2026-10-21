import { promises as fs } from "node:fs";
import path from "node:path";
import { MINECRAFT_AGENT, MINECRAFT_API_PREFIX } from "../server/minecraftApi";

export function minecraftSite(apiUrl: string, key: string) {
  const url = new URL(apiUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname !== `${MINECRAFT_API_PREFIX}/chat/completions`) throw new Error("需要完整 Minecraft chat/completions 地址，不能含账号、查询参数或片段。");
  if (!/^[-_A-Za-z0-9]{32,}$/.test(key)) throw new Error("Minecraft API Key 格式无效；不会写入游戏配置。");
  return { id: "harbour-winefox", api_type: "openai", enabled: true,
    icon: "touhou_little_maid:textures/gui/ai_chat/openai.png", url: url.toString(), secret_key: key,
    headers: {}, models: [MINECRAFT_AGENT] };
}

/** Change only our site entry. Preserve all other providers and retain the exact original file. */
export async function installMinecraftSite(gameDirectory: string, apiUrl: string, key: string) {
  const gameRoot = await fs.realpath(path.resolve(gameDirectory));
  const expected = path.join(gameRoot, "config", "touhou_little_maid", "sites", "llm.json");
  const target = await fs.realpath(expected);
  if (path.relative(gameRoot, target).startsWith("..") || path.isAbsolute(path.relative(gameRoot, target))) throw new Error("女仆配置不能位于游戏目录外。");
  const before = await fs.readFile(target, "utf8");
  const sites: unknown = JSON.parse(before);
  if (!sites || typeof sites !== "object" || Array.isArray(sites)) throw new Error("现有 llm.json 不是站点对象，未修改。");
  const entry = minecraftSite(apiUrl, key);
  const updated = { ...sites, "harbour-winefox": entry };
  if (JSON.stringify((sites as Record<string, unknown>)["harbour-winefox"]) === JSON.stringify(entry)) return { target, changed: false };
  const backup = `${target}.harbour-backup-${Date.now()}`;
  await fs.writeFile(backup, before, { flag: "wx", mode: 0o600 });
  if (await fs.readFile(target, "utf8") !== before) throw new Error("游戏配置刚被其他程序更改，请重新运行；原文件未覆盖。");
  const temporary = `${target}.harbour-new-${Date.now()}`;
  await fs.writeFile(temporary, JSON.stringify(updated, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await fs.rename(temporary, target);
  return { target, backup, changed: true };
}
