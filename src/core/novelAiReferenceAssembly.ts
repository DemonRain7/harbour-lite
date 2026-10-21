import type { NovelAiBrowserPromptForm, NovelAiReferenceAssembly } from "./novelAiPromptComposer";
import { planNovelAiReferenceBudget, type NovelAiReferenceBudgetPlan } from "./novelAiReferenceBudget";

export interface NovelAiReferenceAssemblyReport {
  policy: "reference-512-v1";
  /** Which fixed-block version produced the returned form. The generation stage
   * derives it from the ACTUAL reference route and model; it is never an author
   * field, never inferred from the library, and never guessed from wording. */
  blockVersion: "full" | "compact";
  /** "compact" = the Compact version fit with every optional candidate included;
   * "packed" = budget packing still had to leave optional candidates out. */
  status: "full" | "compact" | "packed" | "required_over_budget";
  /** Module fragment refs the Compact version leaves out (empty for "full"). */
  compactOmitted: string[];
  included: string[];
  omitted: string[];
  before: { positive: number; negative: number };
  after: { positive: number; negative: number };
  mandatory: { positive: number; negative: number };
  selection: {
    optionalSelection: "not_needed" | "evaluated" | "blocked_by_required";
    /** True when the original form was returned; false means reassembled,
     * not proof that the resulting text differs byte-for-byte. */
    originalPreserved: boolean;
    /** Author-selected template uses and declared dependencies, per scope.
     * Compiler-owned fixed defaults are not counted as selected templates. */
    templateUsage?: { required: number; optional: number; pendingRequired: number };
    optionalCandidates: { authored: number; templates: number; compilerDefaults: number; total: number };
    /** Compiler-owned per-character material slots the Compact version charges
     * once in the shared Base lane, because every card declared the identical
     * layer. Absent when each card keeps its own copy. Reporting only. */
    sharedBaseBlocks?: string[];
  };
  pageVerificationRequired: true;
}

const totals = (plan: NovelAiReferenceBudgetPlan) => ({
  positive: plan.positive.estimatedTokens, negative: plan.negative.estimatedTokens,
});
const fits = (plan: NovelAiReferenceBudgetPlan) => plan.planningDisposition !== "constraints_conflict" &&
  (plan.fitsPlanningBudget || plan.planningDisposition === "page_check_required");

function orderedOptionalBlocks(blocks: NovelAiReferenceAssembly["optional"]): NovelAiReferenceAssembly["optional"] {
  return blocks.map((block, order) => {
    if (block.priority !== undefined && (!Number.isSafeInteger(block.priority) || block.priority < 0)) {
      throw new Error(`参考图可选片段 ${block.id} 的优先级必须是非负安全整数；不猜测装配顺序。`);
    }
    return { block, order };
  }).sort((left, right) => (left.block.priority ?? 0) - (right.block.priority ?? 0) || left.order - right.order)
    .map(({ block }) => block);
}

/** One whole optional block, appended without trimming. A character-scoped block
 * can only ever reach its own character prompt; ids and declaration order stay
 * untouched, and an unknown character index errors instead of guessing. */
function appendAssemblyBlock(form: NovelAiBrowserPromptForm,
  block: { lane: "positive" | "negative"; text: string; compactText?: string; character?: number },
  compact: boolean): NovelAiBrowserPromptForm {
  // A registered short wording is used only while the Compact version is active;
  // the Full version always appends the source wording.
  // The full composer normalizes whitespace before joining prompt parts. Keep
  // packed optional blocks byte-compatible with that form (including Markdown
  // fragments containing line breaks) without splitting or truncating them.
  const text = (compact ? block.compactText ?? block.text : block.text).replace(/\s+/g, " ").trim();
  if (block.character === undefined) {
    return block.lane === "positive"
      ? { ...form, basePrompt: form.basePrompt ? `${form.basePrompt}, ${text}` : text }
      : { ...form, undesiredPrompt: form.undesiredPrompt ? `${form.undesiredPrompt}, ${text}` : text };
  }
  const list = [...(block.lane === "positive" ? form.characterPrompts : form.characterUndesiredPrompts)];
  const current = list[block.character];
  if (current === undefined) throw new Error(`参考图可选片段指向不存在的角色卡 ${block.character}；不猜测片段归属。`);
  list[block.character] = current ? `${current}, ${text}` : text;
  return block.lane === "positive" ? { ...form, characterPrompts: list } : { ...form, characterUndesiredPrompts: list };
}

/** Complete Compact wording for semantic review, before optional budget packing.
 * Returning the whole selected composition lets the author assess it together. */
export function completeNovelAiReferencePrompt(full: NovelAiBrowserPromptForm, assembly?: NovelAiReferenceAssembly): NovelAiBrowserPromptForm {
  if (!assembly) return structuredClone(full);
  const compact = !!assembly.compactForm;
  const omitted = new Set(assembly.compactOmitted ?? []);
  return orderedOptionalBlocks(assembly.optional).filter(block => !compact || !omitted.has(block.id.replace(/^fragment:/, "")))
    .reduce((form, block) => appendAssemblyBlock(form, block, compact), structuredClone(assembly.compactForm ?? assembly.coreForm));
}

/** Caller must already have verified an actual reference/V4.5 route. Never
 * parses prose, rewrites requirements, truncates strings or touches frozen Jobs.
 * Optional fragments are selected whole, by global priority and stable source
 * order for ties, against BOTH lanes. A full-fit form keeps its original order. */
export async function assembleNovelAiReferencePrompt(full: NovelAiBrowserPromptForm,
  compilerForm: NovelAiBrowserPromptForm | undefined, assembly?: NovelAiReferenceAssembly) {
  const original = structuredClone(full);
  const before = await planNovelAiReferenceBudget(original, compilerForm);
  if (!assembly) return { form: original, budget: before };
  // The composer supplies a Compact form for the actual-reference route. It may
  // shorten compiler or template wording without omitting any fragment, so the
  // omission list is diagnostic only and must not gate version selection.
  const omittedRefs = new Set(assembly.compactOmitted ?? []);
  const compactActive = !!assembly.compactForm;
  const core = structuredClone(compactActive ? assembly.compactForm! : assembly.coreForm);
  const coreCompiler = structuredClone(compactActive
    ? (assembly.compactCompilerForm ?? assembly.coreCompilerForm) : assembly.coreCompilerForm);
  // A block the Compact version omits is never re-added as an optional candidate.
  const optional = structuredClone(assembly.optional)
    .filter(block => !omittedRefs.has(block.id.replace(/^fragment:/, "")));
  // Reporting only: classify program-owned block IDs, never inspect creative
  // text, change requirement levels, or infer independent additive token costs.
  const optionalCandidates = { authored: 0, templates: 0, compilerDefaults: 0, total: optional.length };
  for (const block of optional) {
    if (block.id.startsWith("fragment:")) optionalCandidates.templates++;
    else if (block.id.startsWith("default-")) optionalCandidates.compilerDefaults++;
    else optionalCandidates.authored++;
  }
  const selection = {
    ...(assembly.templateUsage ? { templateUsage: { ...assembly.templateUsage } } : {}), optionalCandidates,
    // Reporting only: which registered per-card material slots the Compact version
    // charges once in the shared Base lane instead of once per character.
    ...(assembly.sharedBaseBlocks?.length ? { sharedBaseBlocks: [...assembly.sharedBaseBlocks] } : {}),
  };
  const mandatoryBudget = await planNovelAiReferenceBudget(core, coreCompiler);
  const base = { policy: "reference-512-v1" as const, blockVersion: compactActive ? "compact" as const : "full" as const,
    compactOmitted: compactActive ? [...omittedRefs] : [], before: totals(before), mandatory: totals(mandatoryBudget),
    pageVerificationRequired: true as const };
  // Pre-existing fast path, kept byte-identical when no reviewed Compact mapping
  // applies: the complete authored form already fits the planning budget.
  if (!compactActive && fits(before)) return { form: original, budget: before, assembly: {
    ...base, status: "full" as const, included: optional.map(block => block.id), omitted: [], after: totals(before),
    selection: { ...selection, optionalSelection: "not_needed", originalPreserved: true },
  } satisfies NovelAiReferenceAssemblyReport };
  // No safe reduction of mandatory requirements is implied. Retain the complete
  // original form for diagnosis; do not disguise a conflict as a partial success.
  if (!fits(mandatoryBudget)) return { form: original, budget: before, assembly: {
    ...base, status: "required_over_budget" as const, included: [], omitted: [], after: totals(before),
    selection: { ...selection, optionalSelection: "blocked_by_required", originalPreserved: true },
  } satisfies NovelAiReferenceAssemblyReport };
  let selected = core;
  let budget = mandatoryBudget;
  const included: string[] = [], omitted: string[] = [];
  for (const block of orderedOptionalBlocks(optional)) {
    const candidate = appendAssemblyBlock(selected, block, compactActive);
    // Recount the full candidate: per-fragment token costs are not additive.
    const candidateBudget = await planNovelAiReferenceBudget(candidate, coreCompiler);
    if (fits(candidateBudget)) {
      selected = candidate;
      budget = candidateBudget;
      included.push(block.id);
    } else omitted.push(block.id);
  }
  // The Compact version deliberately carries fewer fixed blocks than the Full
  // form, so "compact" means "no optional candidate was dropped on top of that".
  const status = compactActive && omitted.length === 0 ? "compact" as const : "packed" as const;
  return { form: selected, budget, assembly: { ...base, status,
    included, omitted, after: totals(budget),
    selection: { ...selection, optionalSelection: "evaluated", originalPreserved: false },
  } satisfies NovelAiReferenceAssemblyReport };
}
