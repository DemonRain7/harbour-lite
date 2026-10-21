/** Shared QQ media policy: ASR download and archive download must accept the same URLs.
 * These QQ suffixes were already trusted by one of those two entry points. Keep the
 * existing, narrower Discord audio policy; do not turn this into arbitrary URL fetch.
 */
const QQ_MEDIA_SUFFIXES = ["qq.com", "qq.com.cn", "qpic.cn", "gtimg.cn", "qcloud.com", "myqcloud.com", "tencent.com"];
const DISCORD_MEDIA_SUFFIXES = ["discordapp.com", "discordapp.net", "discord.com"];
const DISCORD_AUDIO_SUFFIXES = ["cdn.discordapp.com", "media.discordapp.net"];

export function isTrustedChannelAttachmentUrl(
  platform: "qq" | "discord",
  url: URL,
  purpose: "attachment" | "audio" = "attachment"
): boolean {
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const suffixes = platform === "qq" ? QQ_MEDIA_SUFFIXES
    : purpose === "audio" ? DISCORD_AUDIO_SUFFIXES : DISCORD_MEDIA_SUFFIXES;
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** Safe diagnostics only: never log signed paths, query parameters or userinfo. */
export function channelAttachmentUrlDiagnostic(url: URL) {
  return { protocol: url.protocol, hostname: url.hostname.toLowerCase(), port: url.port || "default" };
}
