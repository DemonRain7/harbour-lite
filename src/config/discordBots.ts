/** Discord 多 Bot 配置：密钥仍只来自进程环境/.env，代码和 data/ 都不保存 token。 */

export interface DiscordBotConfig {
  /** 稳定实例名；用于 env 后缀、日志和 session 隔离。 */
  key: string;
  label: string;
  token: string;
  applicationId: string;
  agentName: string;
  allowlist: string;
  /** default 使用旧版 env 键和旧版 session key，保证平滑兼容。 */
  legacy: boolean;
}

export interface DiscordBotEnvNames {
  token: string;
  applicationId: string;
  agentName: string;
  allowlist: string;
  label: string;
}

const BOT_KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const APPLICATION_ID = /^\d{16,22}$/;

export function normalizeDiscordBotKey(raw: unknown): string {
  const key = String(raw ?? "").trim().toLowerCase();
  if (!BOT_KEY.test(key)) {
    throw new Error(`Discord botKey「${String(raw ?? "")}」无效：只允许 1~32 位小写字母、数字、_、-，且须以字母或数字开头`);
  }
  return key;
}

export function parseDiscordBotKeys(raw: unknown): string[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of text.split(",")) {
    const key = normalizeDiscordBotKey(item);
    if (seen.has(key)) throw new Error(`DISCORD_BOTS 中重复配置了「${key}」`);
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function discordBotEnvNames(keyInput: unknown): DiscordBotEnvNames {
  const key = normalizeDiscordBotKey(keyInput);
  if (key === "default") {
    return {
      token: "DISCORD_BOT_TOKEN",
      applicationId: "DISCORD_APPLICATION_ID",
      agentName: "DEFAULT_AGENT",
      allowlist: "DISCORD_ALLOWLIST",
      label: "DISCORD_BOT_LABEL",
    };
  }
  const suffix = key.toUpperCase().replace(/-/g, "_");
  const prefix = `DISCORD_BOT_${suffix}`;
  return {
    token: `${prefix}_TOKEN`,
    applicationId: `${prefix}_APPLICATION_ID`,
    agentName: `${prefix}_AGENT`,
    allowlist: `${prefix}_ALLOWLIST`,
    label: `${prefix}_LABEL`,
  };
}

function value(source: Record<string, unknown>, key: string): string {
  return String(source[key] ?? "").trim();
}

/**
 * DISCORD_BOTS 为空时只装配旧版 default；一旦列出名字，就按列表顺序装配 N 个实例。
 * 列表中可显式写 default，让旧 token 与新增 Bot 并存而无需迁移密钥。
 */
export function resolveDiscordBotConfigs(
  source: Record<string, unknown>,
  defaultAgent = "main-elaina"
): DiscordBotConfig[] {
  const listed = parseDiscordBotKeys(source.DISCORD_BOTS);
  const keys = listed.length ? listed : ["default"];
  return keys.map((key) => {
    const names = discordBotEnvNames(key);
    const applicationId = value(source, names.applicationId) ||
      (key === "default" ? value(source, "DISCORD_CLIENT_ID") : "");
    if (applicationId && !APPLICATION_ID.test(applicationId)) {
      throw new Error(`${names.applicationId} 不是有效的 Discord Application ID`);
    }
    const inferredAgent = key === "default" ? defaultAgent : `main-${key}`;
    return {
      key,
      label: value(source, names.label) || (key === "default" ? "Default" : key),
      token: value(source, names.token),
      applicationId,
      agentName: value(source, names.agentName) || inferredAgent,
      allowlist: value(source, names.allowlist),
      legacy: key === "default",
    };
  });
}

/** default 保留旧 key；命名 Bot 加 botKey，避免同频道/同 agent 的多入口串历史。 */
export function discordSessionKey(bot: Pick<DiscordBotConfig, "key" | "legacy" | "agentName">, target: string): string {
  return bot.legacy
    ? `discord:${target}:${bot.agentName}`
    : `discord:${bot.key}:${target}:${bot.agentName}`;
}

export function selectDiscordNewsBot(bots: DiscordBotConfig[], preferredKey: string): DiscordBotConfig | undefined {
  if (preferredKey) return bots.find((bot) => bot.key === preferredKey && !!bot.token);
  return bots.find((bot) => bot.key === "default" && !!bot.token) ?? bots.find((bot) => !!bot.token);
}
