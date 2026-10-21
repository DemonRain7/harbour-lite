import type { ToolContext } from "../../types";
import type { NovelAiComposeInput, NovelAiBrowserPromptForm } from "../novelAiPromptComposer";
import { promptText, validatePromptRevision, planPromptRevision, REFERENCE_PROMPT_INSTRUCTION } from "../novelAiPromptRefinement";
import { inspectNovelAiGeneration } from "./novelAiGenerationUnit";
import { WorkflowInputValidationError } from "./registry";

export const NOVELAI_PROMPT_DRAFT_ACTIONS = ["inspect_prompt", "revise_prompt"];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function generationAt(plan: Record<string, unknown>, pointer: unknown): Record<string, unknown> {
  if (typeof pointer !== "string" || !/^\/(?:set\/items\/(?:[0-9]|1[01])|job\/panels\/(?:[0-9]|1[0-9]|2[0-3]))\/generation$/.test(pointer)) {
    throw new WorkflowInputValidationError("path 使用预算回执里的单张 generation 路径，不修改整本或其他字段。", "prompt_target_invalid");
  }
  const [, root, list, index] = pointer.split("/");
  const parent = plan[root!];
  const rows = object(parent) ? parent[list!] : undefined;
  const item = Array.isArray(rows) ? rows[Number(index)] : undefined;
  if (!object(item) || !object(item.generation)) throw new WorkflowInputValidationError("目标画面尚未保存完整 generation，先 save_draft/save_panel。", "prompt_target_missing");
  return item.generation;
}

/** The same bound author rewrites text; code owns persistence, shape, routing and
 * counting. No extra agent, model call, browser or template mutation is hidden here. */
export async function currentDraftPrompt(action: string, input: Record<string, unknown>, plan: Record<string, unknown>, ctx: ToolContext) {
  const generation = generationAt(plan, input.path);
  const { referencePromptRevision: oldRevision, ...authoredInput } = generation;
  const preview = await inspectNovelAiGeneration(authoredInput as unknown as NovelAiComposeInput, Number(generation.numberOfImages ?? 1), ctx);
  const source = preview.referencePromptRefinement as Record<string, unknown> | undefined;
  if (!source) throw new WorkflowInputValidationError("本次没有实际 reference，沿用 V5 完整装配；不进入整稿精简路径。", "prompt_refinement_not_applicable");
  const common = { executed: false, path: input.path, sourceHash: source.sourceHash,
    characterNames: source.characterNames, pageVerified: false, generationAuthorized: false };
  if (action === "inspect_prompt") {
    let prompt = source.original as ReturnType<typeof promptText>;
    let revisionApplied = false;
    if (oldRevision) {
      try {
        prompt = promptText(validatePromptRevision(oldRevision, preview.browserForm as NovelAiBrowserPromptForm, String(source.sourceHash)));
        revisionApplied = true;
      } catch { /* A changed source is read afresh, never silently reuse an old revision. */ }
    }
    const budget = await planPromptRevision({ ...(preview.browserForm as NovelAiBrowserPromptForm), ...prompt });
    return { result: { ...common, instruction: REFERENCE_PROMPT_INSTRUCTION, authoredInput, prompt, revisionApplied,
      localCounts: { positive: budget.positive.estimatedTokens, negative: budget.negative.estimatedTokens },
      nextAction: { name: "novelai-generation", action: "revise_prompt", input: { path: input.path,
        draftRevision: input.draftRevision, sourceHash: source.sourceHash } },
      edit: "revise_prompt 的 input 另填 prompt，结构与上方相同，四个文本字段均须完整。" } };
  }
  const revision = { version: 1 as const, sourceHash: input.sourceHash, prompt: input.prompt };
  let revised: NovelAiBrowserPromptForm;
  try { revised = validatePromptRevision(revision, preview.browserForm as NovelAiBrowserPromptForm, String(source.sourceHash)); }
  catch (error) { throw new WorkflowInputValidationError((error as Error).message, "prompt_revision_invalid"); }
  const budget = await planPromptRevision(revised);
  const localCounts = { positive: budget.positive.estimatedTokens, negative: budget.negative.estimatedTokens };
  if (localCounts.positive > 512 || localCounts.negative > 512) return { result: { ...common,
    status: "needs_revision", saved: false, localCounts,
    reason: "整稿精简后仍超过 512；继续改写这张正负向文本，不追加模板原长词，不启动 Browser。",
    nextAction: "revise_prompt" } };
  const updated = structuredClone(plan);
  generationAt(updated, input.path).referencePromptRevision = { version: 1, sourceHash: source.sourceHash, prompt: promptText(revised) };
  return { updated, result: { ...common, status: "ready_for_page_check", localCounts, originalPreserved: true,
    reason: "本地计数通过；原输入不变，不追加旧长词，提交时仍核对网页计数。" } };
}
