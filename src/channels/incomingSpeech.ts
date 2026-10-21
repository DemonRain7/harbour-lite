import type { IncomingMessage } from "./types";
import type { Attachment } from "../types";
import type { SttGateway, SttTranscriptionResult } from "../core/sttGateway";

export interface IncomingSpeechTrace {
  msg: "stt:native" | "stt:complete" | "stt:failed";
  source: "platform" | "gateway";
  provider?: string;
  processingMs?: number;
  audioDurationMs?: number;
  preview?: string;
  err?: string;
  attachment?: string;
}

export interface PreparedIncomingSpeech {
  message: IncomingMessage;
  trace: IncomingSpeechTrace[];
  /** 有文字可继续跑 Main、但其中某条语音失败时，先给渠道一个明确提示。 */
  warnings: string[];
  /** 纯语音且全部失败时不启动 Main，也不创建会话，直接回这句话。 */
  blockedReply?: string;
}

export interface PrepareIncomingSpeechOptions {
  gateway: SttGateway;
  platform: "discord" | "qq";
  actorKey: string;
  uploadDir: string;
  signal?: AbortSignal;
}

interface SpeechOutcome {
  attachment: Attachment;
  text?: string;
  trace: IncomingSpeechTrace;
}

/**
 * 模型调用前的统一语音入口。QQ 官方 ASR 优先；只有平台没有给转写时才请求 Gateway。
 * 转写文本会成为真正的 user input，因此标题、History、压缩与 Main 看到的是同一份内容。
 */
export async function prepareIncomingSpeech(
  message: IncomingMessage,
  options: PrepareIncomingSpeechOptions
): Promise<PreparedIncomingSpeech> {
  const attachments = message.attachments ?? [];
  const audioIndexes = attachments
    .map((attachment, index) => attachment.kind === "audio" ? index : -1)
    .filter((index) => index >= 0);
  if (!audioIndexes.length) return { message, trace: [], warnings: [] };

  const outcomes = await Promise.all(audioIndexes.map(async (index): Promise<SpeechOutcome> => {
    const attachment = attachments[index]!;
    const native = trustedPlatformTranscript(attachment);
    if (native) {
      return {
        attachment,
        text: native.text,
        trace: {
          msg: "stt:native",
          source: "platform",
          provider: native.provider,
          ...(native.durationMs ? { audioDurationMs: native.durationMs } : {}),
          preview: preview(native.text),
          attachment: attachment.name,
        },
      };
    }

    try {
      const result = await options.gateway.transcribeAttachment(attachment, {
        platform: options.platform,
        actorKey: options.actorKey,
        uploadDir: options.uploadDir,
        signal: options.signal,
      });
      return {
        attachment: {
          ...attachment,
          transcription: {
            text: result.text,
            source: "gateway",
            provider: result.provider,
            ...(result.audioDurationMs ? { durationMs: result.audioDurationMs } : {}),
          },
        },
        text: result.text,
        trace: completedTrace(result, attachment.name),
      };
    } catch (error) {
      return {
        attachment,
        trace: {
          msg: "stt:failed",
          source: "gateway",
          err: safeError(error),
          attachment: attachment.name,
        },
      };
    }
  }));

  const byIndex = new Map(audioIndexes.map((index, position) => [index, outcomes[position]!]));
  const preparedAttachments = attachments.map((attachment, index) => byIndex.get(index)?.attachment ?? attachment);
  const transcriptLines = outcomes
    .filter((outcome): outcome is SpeechOutcome & { text: string } => !!outcome.text)
    .map((outcome) => `[语音转写 · ${outcome.trace.provider || "STT"}] ${outcome.text}`);
  const failed = outcomes.filter((outcome) => !outcome.text).length;
  const originalText = String(message.text || "").trim();
  const warnings = failed
    ? [`⚠️ ${failed} 条语音未能转写；原音频仍会保留，但 Main 不会猜测其中内容。`]
    : [];
  const failureGuard = failed
    ? `[系统：${failed} 条语音未能转写，原音频仅供用户播放；禁止推测、杜撰其内容。]`
    : "";
  const text = [originalText, ...transcriptLines, failureGuard].filter(Boolean).join("\n");

  if (!originalText && !transcriptLines.length) {
    return {
      message: { ...message, attachments: preparedAttachments },
      trace: outcomes.map((outcome) => outcome.trace),
      warnings: [],
      blockedReply: "⚠️ 这条语音未能转写，因此没有启动 Main、也没有创建新会话。请检查 Harbour 的 STT 配置后重发，或同时附上一段文字。",
    };
  }

  return {
    message: { ...message, text, attachments: preparedAttachments },
    trace: outcomes.map((outcome) => outcome.trace),
    warnings,
  };
}

function trustedPlatformTranscript(attachment: Attachment): Attachment["transcription"] | undefined {
  const value = attachment.transcription;
  if (!value || value.source !== "platform" || !String(value.text || "").trim()) return undefined;
  return { ...value, text: String(value.text).trim() };
}

function completedTrace(result: SttTranscriptionResult, attachment: string): IncomingSpeechTrace {
  return {
    msg: "stt:complete",
    source: "gateway",
    provider: result.provider,
    processingMs: result.processingMs,
    ...(result.audioDurationMs ? { audioDurationMs: result.audioDurationMs } : {}),
    preview: preview(result.text),
    attachment,
  };
}

function preview(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 180);
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\r\n]+/g, " ").slice(0, 300);
}
