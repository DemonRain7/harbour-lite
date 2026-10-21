import type { SessionOrigin } from "../types";

const MAX_SPEECH_CHARS = 2_400;

export interface CompanionUtteranceEvent {
  __harbour: "companion:utterance";
  version: 1;
  companionId: string;
  agent: string;
  runId: string;
  text: string;
  source: SessionOrigin;
  sessionId?: string;
  sessionKey?: string;
  createdAt: string;
}

/**
 * Produce the text that may leave the backend for a local companion's TTS process.
 * This deliberately works on the final assistant answer only. Thinking, tool arguments and
 * tool results never enter this function; obvious credentials and non-spoken markup are also
 * removed as a final defence. It is a transport/privacy filter, not a content-policy filter:
 * ordinary fictional/adult prose is preserved verbatim.
 */
export function normalizeCompanionSpeech(input: string): string {
  let text = String(input || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/<https?:\/\/[^>]+>/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/(?:^|\s)(?:[A-Za-z]:\\|\/)(?:[^\s<>"']+[\\/])+[^\s<>"']*/g, " ")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, "Bearer [已隐藏]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[密钥已隐藏]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}\b/g, "[令牌已隐藏]")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*_~`]+/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (text.length > MAX_SPEECH_CHARS) {
    const clipped = text.slice(0, MAX_SPEECH_CHARS);
    const sentenceEnd = Math.max(
      clipped.lastIndexOf("。"),
      clipped.lastIndexOf("！"),
      clipped.lastIndexOf("？"),
      clipped.lastIndexOf("."),
      clipped.lastIndexOf("!"),
      clipped.lastIndexOf("?")
    );
    text = `${sentenceEnd > MAX_SPEECH_CHARS * 0.6 ? clipped.slice(0, sentenceEnd + 1) : clipped}（后文请在 Harbour 中查看）`;
  }
  return text;
}

export function buildCompanionUtterance(args: {
  agent: string;
  runId: string;
  answer: string;
  source: SessionOrigin;
  sessionId?: string;
  sessionKey?: string;
}): CompanionUtteranceEvent | null {
  if (!args.agent.startsWith("main-")) return null;
  const companionId = args.agent.slice("main-".length).replace(/[^a-z0-9_-]/gi, "").toLowerCase();
  if (!companionId) return null;
  const text = normalizeCompanionSpeech(args.answer);
  if (!text) return null;
  const source: SessionOrigin = {
    platform: String(args.source.platform || "unknown"),
    ...(args.source.accountLabel ? { accountLabel: args.source.accountLabel } : {}),
    ...(args.source.scope ? { scope: args.source.scope } : {}),
    ...(args.source.containerName ? { containerName: args.source.containerName } : {}),
    ...(args.source.locationName ? { locationName: args.source.locationName } : {}),
  };
  return {
    __harbour: "companion:utterance",
    version: 1,
    companionId,
    agent: args.agent,
    runId: args.runId,
    text,
    source,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.sessionKey ? { sessionKey: args.sessionKey } : {}),
    createdAt: new Date().toISOString(),
  };
}
