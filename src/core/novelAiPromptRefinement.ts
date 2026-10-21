import { createHash } from "node:crypto";
import type { NovelAiBrowserPromptForm, NovelAiComposeInput } from "./novelAiPromptComposer";
import { validateNovelAiBatchPrompt } from "./novelAiPromptComposer";
import { planNovelAiReferenceBudget, type NovelAiReferenceBudgetForm } from "./novelAiReferenceBudget";

/** Author wording, not a second model/reference/character-routing contract. */
export interface NovelAiPromptRevision {
  version: 1;
  sourceHash: string;
  prompt: NovelAiReferenceBudgetForm;
}

export const REFERENCE_PROMPT_INSTRUCTION = "保留用户冻结的画面意图、人物归属、动作和构图，在目标模型的实际限制内精简重复描述，不改变任务要求。程序只验证结构与计数，不证明语义或成图质量。";

export function promptText(form: NovelAiReferenceBudgetForm): NovelAiReferenceBudgetForm {
  return { basePrompt: form.basePrompt, undesiredPrompt: form.undesiredPrompt,
    characterPrompts: [...form.characterPrompts], characterUndesiredPrompts: [...form.characterUndesiredPrompts] };
}

/** Bind to authored input and both wording versions. Image selection and cost
 * identity are independently frozen by GenerationUnit. Batch size is not prose. */
export function promptRevisionSourceHash(input: NovelAiComposeInput, full: NovelAiBrowserPromptForm,
  compact: NovelAiBrowserPromptForm, model: string): string {
  const { referencePromptRevision: _revision, numberOfImages: _count, ...source } = input;
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, item]) => [key, canonical(item)])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(["reference-prompt-revision-v1", source,
    promptText(full), promptText(compact), full.characterNames, full.characters, full.orientation, model]))).digest("hex");
}

export function validatePromptRevision(value: unknown, form: NovelAiBrowserPromptForm, sourceHash: string): NovelAiBrowserPromptForm {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item);
  if (!object(value) || value.version !== 1 || value.sourceHash !== sourceHash ||
    Object.keys(value).some(key => !["version", "sourceHash", "prompt"].includes(key))) {
    throw new Error("精简稿来源已变化或绑定无效；重新 inspect_prompt 阅读当前完整稿，再 revise_prompt，不重用旧精简稿。");
  }
  const text = value.prompt;
  if (!object(text) || Object.keys(text).some(key => !["basePrompt", "undesiredPrompt", "characterPrompts", "characterUndesiredPrompts"].includes(key)) ||
    typeof text.basePrompt !== "string" || !text.basePrompt.trim() || typeof text.undesiredPrompt !== "string" ||
    !Array.isArray(text.characterPrompts) || !Array.isArray(text.characterUndesiredPrompts) ||
    text.characterPrompts.length !== form.characters.length || text.characterUndesiredPrompts.length !== form.characters.length ||
    [...text.characterPrompts, ...text.characterUndesiredPrompts].some(item => typeof item !== "string") ||
    text.characterPrompts.some(item => !item.trim()) ||
    [text.basePrompt, text.undesiredPrompt, ...text.characterPrompts, ...text.characterUndesiredPrompts].some(item => item.length > 32768)) {
    throw new Error("精简稿只填写完整 basePrompt/undesiredPrompt/characterPrompts/characterUndesiredPrompts；角色正负向数组须与原角色顺序等长，正向不能为空，不填模型、参考图、数量或角色名。");
  }
  const revised = { ...structuredClone(form), ...promptText(text as unknown as NovelAiReferenceBudgetForm) };
  validateNovelAiBatchPrompt(revised);
  return revised;
}

/** Count the complete rewritten text. Do NOT append fixed words afterwards. */
export async function planPromptRevision(form: NovelAiBrowserPromptForm) {
  const empty = { basePrompt: "", undesiredPrompt: "", characterPrompts: form.characters.map(() => ""),
    characterUndesiredPrompts: form.characters.map(() => "") };
  const budget = await planNovelAiReferenceBudget(form, empty);
  const withinLimit = budget.positive.estimatedTokens <= 512 && budget.negative.estimatedTokens <= 512;
  return { ...budget, wholePromptRevision: "applied" as const,
    planningDisposition: withinLimit ? budget.fitsPlanningBudget ? "fit" as const : "page_check_required" as const : "revise_authored" as const,
    warnings: [...budget.warnings, "整稿已由作者重述，旧固定词不再追加；512 是本地放行上限，不保证网页实际计数或语义无损。"] };
}
