/** Verified pixels live only in memory. JSON receipts, Trace and checkpoints never contain
 * the payload. Only trusted tool code can attach it; a model-authored path/JSON cannot. */
export interface ToolImage {
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
}

const images = new WeakMap<object, readonly ToolImage[]>();

export function withToolImages<T extends object>(receipt: T, content: readonly ToolImage[]): T {
  if (!content.length) return receipt;
  images.set(receipt, Object.freeze(content.map(image => Object.freeze({ ...image }))));
  return receipt;
}

/** Also accepts the outer loop's Message: the same immutable snapshot follows its receipt. */
export function toolImages(value: unknown): readonly ToolImage[] {
  return value !== null && typeof value === "object" ? images.get(value) ?? [] : [];
}
