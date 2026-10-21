import type { CompletionResult } from "../types";

const INCOMPLETE_KEY = "harbour:delivery-incomplete";
const TOOL_ACTIVITY_KEY = "harbour:delivery-tool-activity";
export type IncompleteDelivery = NonNullable<CompletionResult["incomplete"]>;

export function markIncompleteDelivery(state: Map<string, unknown>, reason: IncompleteDelivery): void {
  state.set(INCOMPLETE_KEY, reason);
}

export function incompleteDelivery(state: Map<string, unknown>): IncompleteDelivery | undefined {
  return state.get(INCOMPLETE_KEY) as IncompleteDelivery | undefined;
}

export function recordDeliveryToolActivity(state: Map<string, unknown>): void {
  state.set(TOOL_ACTIVITY_KEY, true);
}

export function hasDeliveryToolActivity(state: Map<string, unknown>): boolean {
  return state.get(TOOL_ACTIVITY_KEY) === true;
}

/** 保留独立文字回答，但 canonical 已负责的媒体不能再次输出（包括反序重复图）。 */
export function appendCanonicalDelivery(reply: string, canonical: string): string {
  if (!reply.trim()) return canonical;
  if (reply === canonical || canonical.includes(reply)) return canonical;
  const media = new Set<string>();
  const imagePattern = /!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  for (const match of canonical.matchAll(imagePattern)) media.add(match[1]!);
  // Exact delivered blocks are not independent prose; avoid echoing all captions
  // when the model already returned the canonical body plus an additional answer.
  let prose = reply.split(canonical).join("").replace(/!?\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g,
    (whole, url: string) => media.has(url) ? "" : whole);
  for (const url of media) prose = prose.split(url).join("");
  prose = prose.replace(/\n{3,}/g, "\n\n").trim();
  return prose ? `${prose}\n\n${canonical}` : canonical;
}
