import type { Channel, MessageHandler } from "./types";
import type { Logger } from "pino";

/**
 * 企业微信（WeCom）adapter —— 占位，未实现。
 *
 * ⚠️ 合规说明（务必遵守）：
 *   - 微信【个人号】没有任何合法的机器人 API。任何「个人微信机器人」都依赖
 *     逆向的非官方协议，违反微信使用条款、且账号随时可能被封。本项目【不会】
 *     去实现任何非官方微信协议。
 *   - 唯一合规路径是【企业微信 WeCom】自建应用，或微信公众号的【官方 API】。
 *     需要：企业 corpId、应用 agentId、应用 secret（以及可选的回调 token/aesKey）。
 *
 * 待 用户 提供 WeCom 自建应用凭据后，在这里用官方 API 实现：
 *   - 接收：配置应用「接收消息」回调 URL（需起一个 HTTP server 验签 + 收消息）。
 *   - 发送：调 https://qyapi.weixin.qq.com/cgi-bin/message/send（先用 secret 换 access_token）。
 *
 * 现在 start() 直接抛错，提示尚未配置——绝不静默假装可用。
 */
export class WecomChannel implements Channel {
  readonly name = "wecom";

  constructor(private opts: { logger: Logger }) {}

  onMessage(_handler: MessageHandler): void {
    // 待实现：把回调收到的消息包成 IncomingMessage 交给 handler。
  }

  async start(): Promise<void> {
    this.opts.logger.warn("WeCom 渠道尚未实现（需要企业微信自建应用凭据）。详见 channels/wecom.ts。");
    throw new Error(
      "WeCom 渠道未实现：请提供企业微信 corpId/agentId/secret 后按 wecom.ts 注释用官方 API 实现。不实现任何非官方微信协议。"
    );
  }

  async sendMessage(_target: string, _text: string): Promise<void> {
    throw new Error("WeCom 渠道未实现。");
  }
}
