/** 供应商/协议不统一，统一识别常见的“输入上下文过长”错误。 */
const CONTEXT_OVERFLOW_PATTERNS = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /max(?:imum)? context (?:length|window).*(?:exceed|limit|token)/i,
  /context (?:length|window).*(?:exceed|too (?:large|long)|overflow)/i,
  /(?:exceed|overflow).*(?:context (?:length|window)|input token)/i,
  /prompt is too long/i,
  /input is too long(?: for (?:the )?(?:requested )?model)?/i,
  /too many input tokens/i,
  /request too large.*(?:token|context)/i,
  /conversation too long/i,
  /输入.{0,12}(?:token|上下文).{0,12}(?:超|过长)/i,
  /上下文.{0,12}(?:超限|过长|溢出)/i,
];

export class ContextWindowExceededError extends Error {
  readonly code = "CONTEXT_WINDOW_EXCEEDED";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ContextWindowExceededError";
  }
}

/** 把 Error.cause / SDK errors[] 一并展开，避免只看见最外层“SDK 执行失败”。 */
export function contextErrorText(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  const visit = (value: unknown): void => {
    if (value == null || seen.has(value)) return;
    if (typeof value === "object") seen.add(value);
    if (value instanceof Error) {
      parts.push(value.message);
      visit(value.cause);
      const errors = (value as Error & { errors?: unknown[] }).errors;
      if (Array.isArray(errors)) for (const nested of errors) visit(nested);
      return;
    }
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (typeof obj.message === "string") parts.push(obj.message);
      if (typeof obj.code === "string") parts.push(obj.code);
      visit(obj.error);
      visit(obj.cause);
      if (Array.isArray(obj.errors)) for (const nested of obj.errors) visit(nested);
      return;
    }
    parts.push(String(value));
  };
  visit(error);
  return parts.join("\n");
}

export function isContextOverflowError(error: unknown): boolean {
  if (error instanceof ContextWindowExceededError) return true;
  const text = contextErrorText(error);
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}

export function contextOverflowMessage(toolActivity: boolean): string {
  if (toolActivity) {
    return "本轮执行过程中上下文超过了模型窗口。Harbour 已保存工具级断点；为避免重复副作用，没有自动从头重跑。请先缩短任务/附件，或新开会话后明确让我从现有结果继续。";
  }
  return "当前消息与会话上下文仍超过模型窗口。Harbour 已尝试压缩一次，但本条输入或最近必留内容仍然过长；请缩短消息/附件，或新开一段会话后再发。";
}
