/** QQ 多 Bot 配置：凭据仅来自进程环境/.env，代码与 data/ 不保存 AppSecret。 */

export interface QQBotConfig {
  /** 稳定实例名；同时用于 Gateway accountId、OpenID 绑定和 session 隔离。 */
  key: string;
  label: string;
  appId: string;
  appSecret: string;
  agentName: string;
  allowlist: string;
  ownerOpenids: string;
  pairingCode: string;
  bindingsFile: string;
  requireMention: boolean;
  markdownSupport: boolean;
  /** default 使用旧版 env 名和旧版 session key，保证已有单 Bot 配置平滑兼容。 */
  legacy: boolean;
}

export interface QQBotEnvNames {
  appId: string;
  appSecret: string;
  agentName: string;
  label: string;
  allowlist: string;
  ownerOpenids: string;
  pairingCode: string;
  requireMention: string;
  markdownSupport: string;
}

type Source = Record<string, unknown>;

const BOT_KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const APPLICATION_ID = /^\d{5,32}$/;

function text(source: Source, key: string, fallback = ""): string {
  const value = source[key];
  return value == null ? fallback : String(value).trim();
}

function bool(source: Source, key: string, fallback: boolean): boolean {
  const value = text(source, key);
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function normalizeQQBotKey(raw: unknown): string {
  const key = String(raw ?? "").trim().toLowerCase();
  if (!BOT_KEY.test(key)) {
    throw new Error(`QQ botKey「${String(raw ?? "")}」无效：只允许 1~32 位小写字母、数字、_、-，且须以字母或数字开头`);
  }
  return key;
}

export function parseQQBotKeys(raw: unknown): string[] {
  const value = String(raw ?? "").trim();
  if (!value) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value.split(",")) {
    const key = normalizeQQBotKey(item);
    if (seen.has(key)) throw new Error(`QQ_BOTS 中重复配置了「${key}」`);
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function qqBotEnvNames(keyInput: unknown): QQBotEnvNames {
  const key = normalizeQQBotKey(keyInput);
  if (key === "default") {
    return {
      appId: "QQBOT_APP_ID",
      appSecret: "QQBOT_APP_SECRET",
      agentName: "QQBOT_AGENT",
      label: "QQBOT_LABEL",
      allowlist: "QQBOT_ALLOWLIST",
      ownerOpenids: "OWNER_QQ_OPENIDS",
      pairingCode: "QQBOT_PAIRING_CODE",
      requireMention: "QQBOT_REQUIRE_MENTION",
      markdownSupport: "QQBOT_MARKDOWN",
    };
  }
  const suffix = key.toUpperCase().replace(/-/g, "_");
  const prefix = `QQ_BOT_${suffix}`;
  return {
    appId: `${prefix}_APP_ID`,
    appSecret: `${prefix}_APP_SECRET`,
    agentName: `${prefix}_AGENT`,
    label: `${prefix}_LABEL`,
    allowlist: `${prefix}_ALLOWLIST`,
    ownerOpenids: `${prefix}_OWNER_OPENIDS`,
    pairingCode: `${prefix}_PAIRING_CODE`,
    requireMention: `${prefix}_REQUIRE_MENTION`,
    markdownSupport: `${prefix}_MARKDOWN`,
  };
}

/**
 * QQ_BOTS 为空时装配旧版 default；一旦列出名字，就按列表顺序装配 N 个独立实例。
 * 每个命名 Bot 的 OpenID、配对码和 allowlist 都独立，避免两个应用之间错误复用身份。
 */
export function resolveQQBotConfigs(source: Source, defaultAgent = "main-elaina"): QQBotConfig[] {
  const listed = parseQQBotKeys(source.QQ_BOTS);
  const keys = listed.length ? listed : ["default"];
  const globalRequireMention = bool(source, "QQBOT_REQUIRE_MENTION", true);
  const globalMarkdown = bool(source, "QQBOT_MARKDOWN", false);
  return keys.map((key) => {
    const names = qqBotEnvNames(key);
    const appId = text(source, names.appId);
    if (appId && !APPLICATION_ID.test(appId)) {
      throw new Error(`${names.appId} 不是有效的 QQ Bot AppID`);
    }
    const inferredAgent = key === "default" ? defaultAgent : `main-${key}`;
    return {
      key,
      label: text(source, names.label, key === "default" ? "QQ Bot" : key),
      appId,
      appSecret: text(source, names.appSecret),
      agentName: text(source, names.agentName, inferredAgent) || inferredAgent,
      allowlist: text(source, names.allowlist),
      ownerOpenids: text(source, names.ownerOpenids),
      pairingCode: text(source, names.pairingCode),
      bindingsFile: text(source, "QQBOT_BINDINGS_FILE", "./data/qqBindings.json"),
      requireMention: bool(source, names.requireMention, globalRequireMention),
      markdownSupport: bool(source, names.markdownSupport, globalMarkdown),
      legacy: key === "default",
    };
  });
}

/** 旧调用点兼容；新代码应优先 resolveQQBotConfigs。 */
export function resolveQQBotConfig(source: Source, defaultAgent: string): QQBotConfig {
  return resolveQQBotConfigs(source, defaultAgent)[0]!;
}

export function qqConfigured(config: QQBotConfig): boolean {
  return !!config.appId && !!config.appSecret;
}

/** botKey + 私聊/群 + OpenID + persona 全部入 key，两个应用绝不共享历史。 */
export function qqSessionKey(
  bot: Pick<QQBotConfig, "key" | "legacy" | "agentName">,
  scope: "dm" | "group",
  targetId: string
): string {
  const accountKey = bot.legacy ? "default" : bot.key;
  return `qq:${accountKey}:${scope}:${encodeURIComponent(targetId)}:${bot.agentName}`;
}
