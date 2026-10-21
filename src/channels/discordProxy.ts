import { createRequire } from "node:module";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent } from "undici";

/**
 * Discord 在部分网络下需要显式代理。REST 使用 undici dispatcher；Gateway 使用 ws 的 agent。
 * 这里只补丁 ws 模块导出的 WebSocket 构造器，不修改全局 fetch/https agent，避免让 Kimi、
 * DeepSeek、RSS 等无关流量被 DISCORD_PROXY_URL 意外接管。
 */

function resolveProxyUrl(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (!value) return "";
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("DISCORD_PROXY_URL 仅支持 http:// 或 https:// 代理");
  }
  return parsed.toString();
}

export const discordProxyUrl = resolveProxyUrl(process.env.DISCORD_PROXY_URL);
export const discordRestProxyAgent = discordProxyUrl ? new ProxyAgent(discordProxyUrl) : undefined;

if (discordProxyUrl) {
  const gatewayAgent = new HttpsProxyAgent(discordProxyUrl);
  const requireHere = createRequire(__filename);
  const wsModule = requireHere("ws") as {
    WebSocket: new (address: unknown, protocols?: unknown, options?: Record<string, unknown>) => object;
  };
  const OriginalWebSocket = wsModule.WebSocket;

  class ProxiedDiscordWebSocket extends OriginalWebSocket {
    constructor(address: unknown, protocols?: unknown, options?: Record<string, unknown>) {
      super(address, protocols, { ...(options ?? {}), agent: gatewayAgent });
    }
  }

  // @discordjs/ws 在模块初始化时读取 require("ws").WebSocket；必须在 discord.js import 前替换。
  wsModule.WebSocket = ProxiedDiscordWebSocket;
}

/** 日志只显示代理地址，不泄露 URL 中可能存在的账号密码。 */
export function discordProxyLabel(): string {
  if (!discordProxyUrl) return "";
  const parsed = new URL(discordProxyUrl);
  return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
}
