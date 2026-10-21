import type { Message, ToolDef } from "../types";
import { toolImages } from "./toolImages";

// 不绑定供应商 tokenizer：Harbour 的会话可在同一条 session 里切模型，这里只需要一个
// 稳定、略保守的跨模型估算。ASCII 按常见的约 4 chars/token；中日韩文字通常接近
// 1 char/token；emoji 与其它非 ASCII 字符按 1.5 token 预留余量。
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function estimateTextTokens(text: string | undefined): number {
  if (!text) return 0;
  let asciiChars = 0;
  let weightedNonAscii = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 0x7f) asciiChars += 1;
    else weightedNonAscii += CJK_CHAR.test(char) ? 1 : 1.5;
  }
  return Math.ceil(asciiChars / 4 + weightedNonAscii);
}

export function estimateMessageTokens(message: Message): number {
  let tokens = estimateTextTokens(message.content);
  tokens += toolImages(message).length * 1_600;
  if (message.toolCalls?.length) tokens += estimateTextTokens(JSON.stringify(message.toolCalls));
  if (message.attachments?.length) {
    tokens += estimateTextTokens(JSON.stringify(message.attachments));
    // 不绑定某家视觉 tokenizer：给每张图预留保守固定预算，避免 session 看似很空却
    // 被历史图片撑满供应商窗口。真实值随分辨率/模型不同，1600 是跨端点安全近似。
    tokens += message.attachments.filter((attachment) => attachment.kind === "image").length * 1_600;
  }
  return tokens;
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

/** Heuristic protocol allowance; provider tokenizers and native tool wrappers differ. */
export const REQUEST_ENVELOPE_RESERVE_TOKENS = 256;

/** Only model-visible tool metadata: never serialize execute closures or tool context. */
export function estimateToolTokens(tools: readonly Pick<ToolDef, "name" | "description" | "parameters">[] | undefined): number {
  if (!tools?.length) return 0;
  return estimateTextTokens(JSON.stringify(tools.map(({ name, description, parameters }) => ({
    type: "function", function: { name, description, parameters },
  }))));
}

export function estimateRequestTokens(messages: Message[], tools?: readonly Pick<ToolDef, "name" | "description" | "parameters">[]): number {
  return estimateMessagesTokens(messages) + estimateToolTokens(tools) + REQUEST_ENVELOPE_RESERVE_TOKENS;
}
