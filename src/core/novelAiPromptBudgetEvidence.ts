import { createHash } from "node:crypto";
import type { NovelAiSubmissionLimit } from "../types";
import { supportsNovelAiPreciseReferences } from "./novelAiModelCapabilities";

/** Content identity, not a token estimate. Size/price/onceKey edits cannot fix overflow. */
export function novelAiPromptContentKey(request?: Record<string, unknown>): string | undefined {
  const form = request?.browserForm;
  if (typeof request?.model !== "string" || !request.model.trim() || !form || typeof form !== "object" || Array.isArray(form)) return;
  const fields = form as Record<string, unknown>;
  if (typeof fields.basePrompt !== "string" || typeof fields.undesiredPrompt !== "string" ||
    !Array.isArray(fields.characterPrompts) || !fields.characterPrompts.every(value => typeof value === "string") ||
    !Array.isArray(fields.characterUndesiredPrompts) || !fields.characterUndesiredPrompts.every(value => typeof value === "string")) return;
  return createHash("sha256").update(JSON.stringify({ model: request.model.trim(),
    base: fields.basePrompt, negative: fields.undesiredPrompt,
    characters: fields.characterPrompts, characterNegatives: fields.characterUndesiredPrompts,
  })).digest("hex");
}

/** Run-local trusted evidence only. Never reuse an old pass to authorize Generate. */
export function novelAiPromptBudgetFailureKey(submission?: NovelAiSubmissionLimit): string | undefined {
  if (!submission?.expectedModel || !supportsNovelAiPreciseReferences(submission.expectedModel)) return;
  const content = novelAiPromptContentKey({ model: submission.expectedModel, browserForm: submission.form });
  return content ? `novelai:prompt-budget:${submission.onceKey}:${content}` : undefined;
}
