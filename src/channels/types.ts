/**
 * 渠道抽象。中台核心不依赖任何具体渠道——加一个渠道 = 实现这个接口。
 * 已落地 Discord 与 QQ 官方机器人；企业微信（WeCom）见 wecom.ts 占位。
 */

import type { Attachment, SessionOrigin } from "../types";

export interface IncomingMessage {
  /** Stable platform ID, not author-controlled text; used for durable intake deduplication. */
  messageId?: string;
  /** 用户发来的文本。 */
  text: string;
  /** 回发目标（如 Discord channelId；QQ 使用带 reply msgId 的不透明编码）。 */
  target: string;
  /** 发送者标识（用于白名单）。 */
  authorId: string;
  /** 多模态附件（图片/语音/文件），渠道可选解析。 */
  attachments?: Attachment[];
  /** 供跨渠道会话中心展示 Bot / 私聊 / 服务器 / 频道；不参与白名单判断。 */
  origin?: SessionOrigin;
  /** 原始消息对象，备用。 */
  raw?: unknown;
}

export type MessageHandler = (msg: IncomingMessage) => void | Promise<void>;

export interface Channel {
  readonly name: string;
  /** 连接并开始接收消息。 */
  start(): Promise<void>;
  /** 断开（优雅退出用）。 */
  stop?(): Promise<void> | void;
  /** 注册收到消息的处理器。 */
  onMessage(handler: MessageHandler): void;
  /** 主动发消息到某目标（可带出站多模态附件）。 */
  sendMessage(target: string, text: string, attachments?: Attachment[]): Promise<void>;
  /** 触发「正在输入…」指示，返回停止函数（渠道可选实现，如 Discord/QQ 私聊 typing）。 */
  startTyping?(target: string): () => void;
}
