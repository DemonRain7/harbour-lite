import { promises as fs } from "node:fs";
import path from "node:path";
import { readWorkflowGraphSettings } from "./workflowGraph";
import { WorkflowInputValidationError } from "./registry";
import { frozenNovelAiRequiredReferences } from "../novelAiReferences";

/** Only numeric policy/quotes are stored here. No prompt, author or second approval LLM. */
export interface NovelAiBudgetPlan {
  version: 1;
  source: "auto" | "explicit";
  tolerancePercent: number;
  /** Standing per-image ceiling frozen for new automatic budgets; absent on legacy/explicit plans. */
  autoMaxAnlasPerImage?: number;
  estimatedTotalAnlas: number;
  units: Array<{
    signature: string;
    estimatedAnlas: number;
    maxCostAnlas: number;
    /** Explicit per-unit authorization, including zero; not a measured price. */
    explicitMaxCostAnlas?: number;
    basis: "baseline" | "pixel-estimate" | "legacy-explicit-estimate" | "unknown-profile" | "unknown-settings" | "observed-ui" | "observed-unit-rate";
    /** Source observation, not proof of the current account's final charge. */
    observationId?: string;
  }>;
}
export interface NovelAiWaiting {
  kind: "review" | "budget" | "pricing";
  reason: string;
  /** One-based frozen unit needing a price ceiling; never the total budget. */
  unit?: number;
}
export interface NovelAiRequestPolicy {
  maxTotalAnlas?: number;
  reviewBeforeGenerate?: boolean;
}
export interface NovelAiPricingTable {
  version: 2;
  profiles: Array<{ model: string; uiName: string; mode: string; defaultGuidance: number; defaultNoiseSchedule: string | null }>;
  presets: Record<string, { landscape?: number[]; portrait?: number[]; square?: number[] | null; maxBatch?: number }>;
  observationDefaults: Record<string, unknown>;
  observations: Array<Record<string, unknown> & { id: string; width: number; height: number; anlas: number }>;
}

/** Read the same measured table for image sets and comics; no LLM or additional browser run. */
export async function readNovelAiPricingTable(): Promise<NovelAiPricingTable> {
  const table: NovelAiPricingTable = JSON.parse(await fs.readFile(path.resolve("workflows/novelai-generation/anlas-pricing.json"), "utf8"));
  if (table.version !== 2 || !table.profiles?.length || !table.observations?.length || !table.observationDefaults || !table.presets) throw new Error("Anlas 估价表无效");
  return table;
}

/** An uploaded attachment is not necessarily Image2Image. Only explicitly typed pricing inputs select it. */
export function quoteNovelAiAnlas(table: NovelAiPricingTable, request: Record<string, unknown>, count: number):
  Pick<NovelAiBudgetPlan["units"][number], "signature" | "estimatedAnlas" | "basis" | "observationId"> {
  const form = request.browserForm && typeof request.browserForm === "object" ? request.browserForm as Record<string, unknown> : {};
  const value = (key: string, fallback?: unknown) => form[key] !== undefined ? form[key] : request[key] !== undefined ? request[key] : fallback;
  const model = value("model", "NAI Diffusion V5 Full"), mode = value("mode", "Anime");
  const profile = table.profiles.find(row => (row.model === model || row.uiName === model) && row.mode === mode);
  const category = String(request.resolution ?? "Normal"), orientation = String(form.orientation ?? "portrait");
  const preset = table.presets[category];
  const dimensions = orientation === "landscape" ? preset?.landscape : orientation === "square" ? preset?.square : preset?.portrait;
  const explicitSize = form.width !== undefined || form.height !== undefined;
  const width = explicitSize ? form.width : dimensions?.[0], height = explicitSize ? form.height : dimensions?.[1];
  const defaults = table.observationDefaults;
  const operation = value("operation", defaults.operation);
  // Frozen references describe what execution must actually upload.
  // Their local quote signature is a pricing input, not evidence of a remote upload.
  const autoRoutes = (request.reference ?? "auto") === "auto" && Array.isArray(request.characterRoutes)
    ? request.characterRoutes : undefined;
  const frozenAttachment = request.reference && typeof request.reference === "object" && !Array.isArray(request.reference)
    && request.referenceAttachmentHash !== undefined;
  const preciseReferences = frozenAttachment ? frozenNovelAiRequiredReferences(request).length : autoRoutes ? new Set(autoRoutes.flatMap((route: unknown) => {
    if (!route || typeof route !== "object" || Array.isArray(route)) return [];
    const row = route as Record<string, unknown>;
    const reference = row.reference;
    if (row.referencePolicy !== "required" || !reference || typeof reference !== "object" || Array.isArray(reference)) return [];
    const asset = reference as Record<string, unknown>;
    return asset.available === true && typeof asset.handle === "string" && asset.handle.trim() ? [asset.handle.trim()] : [];
  })).size : value("preciseReferences", 0);
  const parameters: Record<string, unknown> = { model: profile?.uiName ?? model, mode, width, height, operation,
    steps: value("steps", defaults.steps), guidance: value("guidance", profile?.defaultGuidance ?? defaults.guidance),
    sampler: value("sampler", defaults.sampler), guidanceRescale: value("guidanceRescale", defaults.guidanceRescale),
    noiseSchedule: value("noiseSchedule", profile?.defaultNoiseSchedule ?? defaults.noiseSchedule),
    preciseReferences, vibeReferences: value("vibeReferences", 0), batch: count,
    ...(operation === "image2image" ? { strength: value("strength", 0.7), noise: value("noise", 0) } : {}),
    ...(preciseReferences ? { referenceType: value("referenceType", "Character & Style") } : {}),
  };
  const signature = JSON.stringify(parameters);
  const unknown = (basis: "unknown-profile" | "unknown-settings") => ({ signature, estimatedAnlas: 0, basis });
  if (!profile) return unknown("unknown-profile");
  if (![width, height].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 64 && n % 64 === 0) ||
    !Number.isSafeInteger(count) || count < 1) return unknown("unknown-settings");
  const exactPreset = Object.values(table.presets).find(row => [row.portrait, row.landscape, row.square]
    .some(size => size?.[0] === width && size?.[1] === height));
  // Do not infer custom-size batch limits from area alone. Exact observations can still match.
  const observations = table.observations.map(row => ({ ...defaults, ...row }));
  const matches = (row: Record<string, unknown>, batch: number) => Object.entries(parameters)
    .every(([key, expected]) => row[key] === (key === "batch" ? batch : expected));
  const exact = observations.find(row => matches(row, count));
  const single = !exact && exactPreset?.maxBatch && count <= exactPreset.maxBatch
    ? observations.find(row => matches(row, 1)) : undefined;
  const row = exact ?? single;
  if (!row) return unknown("unknown-settings");
  return { signature, estimatedAnlas: anlasLimit(row.anlas * (exact ? 1 : count), "单组估价"),
    basis: exact ? "observed-ui" as const : "observed-unit-rate" as const, observationId: row.id };
}
export function anlasLimit(value: unknown, field = "maxTotalAnlas"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new WorkflowInputValidationError(`${field} 必须为 0–1000000 的整数；省略表示自动预算，0 表示禁止扣费`);
  }
  return value;
}
export function requestPolicy(input: Record<string, unknown>): NovelAiRequestPolicy {
  if (input.reviewBeforeGenerate !== undefined && typeof input.reviewBeforeGenerate !== "boolean") throw new WorkflowInputValidationError("reviewBeforeGenerate 必须为布尔值");
  return { ...(input.maxTotalAnlas !== undefined ? { maxTotalAnlas: anlasLimit(input.maxTotalAnlas) } : {}),
    ...(input.reviewBeforeGenerate !== undefined ? { reviewBeforeGenerate: input.reviewBeforeGenerate } : {}) };
}
export async function planNovelAiBudget(
  requests: Array<{ request: Record<string, unknown>; count: number }>,
  explicitLimit: unknown,
  options: { graphRoot?: string; expectedCostAnlas?: number; reviewBeforeGenerate?: boolean } = {},
): Promise<{ maxTotalAnlas: number; plan: NovelAiBudgetPlan; waiting?: NovelAiWaiting }> {
  const table = await readNovelAiPricingTable();
  const settings = await readWorkflowGraphSettings("novelai-generation", options.graphRoot);
  const tolerancePercent = settings.anlasTolerancePercent ?? 20;
  const autoMaxAnlasPerImage = explicitLimit === undefined ? settings.maxAnlasPerImage : undefined;
  const units = requests.map(({ request, count }) => {
    if (!Number.isSafeInteger(count) || count < 1) throw new WorkflowInputValidationError("预算张数必须为正整数");
    const quote = quoteNovelAiAnlas(table, request, count);
    const legacy = options.expectedCostAnlas;
    const basis: NovelAiBudgetPlan["units"][number]["basis"] = legacy !== undefined ? "legacy-explicit-estimate"
      : quote.basis;
    const estimatedAnlas = anlasLimit(legacy === undefined ? quote.estimatedAnlas : legacy * count, "单组估价");
    return { signature: quote.signature, estimatedAnlas, ...(legacy === undefined && quote.observationId ? { observationId: quote.observationId } : {}),
      maxCostAnlas: autoMaxAnlasPerImage === undefined ? Math.ceil(estimatedAnlas * (1 + tolerancePercent / 100))
        : anlasLimit(autoMaxAnlasPerImage * count, "单组额度"), basis };
  });
  const estimatedTotalAnlas = units.reduce((sum, unit) => sum + unit.estimatedAnlas, 0);
  const maxTotalAnlas = explicitLimit === undefined ? anlasLimit(units.reduce((sum, unit) => sum + unit.maxCostAnlas, 0)) : anlasLimit(explicitLimit);
  const plan: NovelAiBudgetPlan = { version: 1, source: explicitLimit === undefined ? "auto" : "explicit", tolerancePercent,
    ...(autoMaxAnlasPerImage !== undefined ? { autoMaxAnlasPerImage } : {}), estimatedTotalAnlas, units };
  const unitWait = units.map((_, index) => novelAiUnitPricingWait(plan, index) ?? novelAiUnitBudgetWait(plan, index)).find(Boolean);
  const waiting: NovelAiWaiting | undefined = unitWait
    ?? (options.reviewBeforeGenerate ? { kind: "review", reason: "完整方案已保存，等待确认剧本/画面；确认后沿用此 Job，不重新创作。" }
      : maxTotalAnlas < estimatedTotalAnlas && maxTotalAnlas !== 0
        ? { kind: "budget", reason: `预计 ${estimatedTotalAnlas} Anlas，超过指定总上限 ${maxTotalAnlas}；方案已保存，尚未提交生成。` } : undefined);
  return { maxTotalAnlas, plan, ...(waiting ? { waiting } : {}) };
}
/** Unknown is not free. A frozen standing ceiling permits bounded page inspection,
 * including zero/free-only; legacy jobs still need their original authorization. */
export function novelAiUnitPricingWait(plan: NovelAiBudgetPlan | undefined, index: number): NovelAiWaiting | undefined {
  const quote = plan?.units[index];
  if (!quote || (quote.basis !== "unknown-profile" && quote.basis !== "unknown-settings") ||
    plan?.autoMaxAnlasPerImage !== undefined || quote.explicitMaxCostAnlas !== undefined || quote.maxCostAnlas > 0) return;
  return { kind: "pricing", unit: index + 1,
    reason: `第 ${index + 1} 个生成单元尚无已核实报价或明确单次额度；这不表示总预算为 0。未启动 Browser/Generate，请核对该单元页面价格并用 maxUnitAnlas 明确单次上限（0 表示仅允许免费）。` };
}

function novelAiUnitBudgetWait(plan: NovelAiBudgetPlan, index: number): NovelAiWaiting | undefined {
  const quote = plan.units[index];
  // A free-only plan must still inspect the actual account price; an estimate is not a charge.
  if (!quote || quote.maxCostAnlas === 0 || quote.estimatedAnlas <= quote.maxCostAnlas) return;
  return { kind: "budget", unit: index + 1,
    reason: `第 ${index + 1} 个生成单元预计 ${quote.estimatedAnlas} Anlas，超过该单元已授权上限 ${quote.maxCostAnlas}；未提交生成。若接受更高价格，明确用 maxUnitAnlas 授权此单元，且仍须满足总预算。` };
}

/** Older saved pricing pauses did not identify the unit. Resolve them without
 * rewriting the job or implying that a sibling's cap authorizes this one. */
export function targetedNovelAiPricingWait(plan: NovelAiBudgetPlan | undefined, pendingIndices: number[],
  waiting: NovelAiWaiting | undefined): NovelAiWaiting | undefined {
  if (waiting?.kind !== "pricing") return waiting;
  return pendingIndices.map(index => novelAiUnitPricingWait(plan, index)).find(Boolean) ?? waiting;
}

/** A pricing pause may concern a later unit, not the first known-price sibling.
 * Each approval binds only that unit; never spread it over the remaining job. */
export function authorizeNovelAiUnitBudget(plan: NovelAiBudgetPlan | undefined, pendingIndices: number[],
  waiting: NovelAiWaiting | undefined, value: unknown): void {
  if (value === undefined) return;
  const ceiling = anlasLimit(value, "maxUnitAnlas");
  const pricingIndex = waiting?.kind === "pricing"
    ? pendingIndices.find(index => novelAiUnitPricingWait(plan, index)) : undefined;
  const budgetIndex = waiting?.kind === "budget" && waiting.unit !== undefined && pendingIndices.includes(waiting.unit - 1)
    ? waiting.unit - 1 : undefined;
  const index = pricingIndex ?? budgetIndex ?? pendingIndices[0];
  const quote = index === undefined ? undefined : plan?.units[index];
  if (!quote || ceiling < quote.maxCostAnlas) throw new WorkflowInputValidationError("maxUnitAnlas 只能提高待确认单元的已保存额度", "budget_conflict");
  quote.maxCostAnlas = ceiling;
  quote.explicitMaxCostAnlas = ceiling;
}

export function unitBudget(plan: NovelAiBudgetPlan | undefined, index: number, remaining: number, fallbackCost: number, count: number) {
  const quote = plan?.units[index];
  return { estimatedAnlas: quote?.estimatedAnlas ?? fallbackCost * count,
    maxCostAnlas: Math.max(0, Math.min(remaining, quote?.maxCostAnlas ?? Math.ceil(fallbackCost * count * 1.2))) };
}
/** Raising the total ceiling never resets either spent money or uncertain reservations. */
export function updateBudgetCeiling(budget: { maxTotalAnlas: number; visibleSpentAnlas: number; uncertainReservedAnlas?: number; plan?: NovelAiBudgetPlan }, value: unknown): void {
  if (value === undefined) return;
  const next = anlasLimit(value);
  if (next < budget.maxTotalAnlas || next < budget.visibleSpentAnlas + (budget.uncertainReservedAnlas ?? 0)) throw new WorkflowInputValidationError("恢复时总额度只能提高，且不得低于已记账及待核对金额", "budget_conflict");
  budget.maxTotalAnlas = next;
  if (budget.plan) budget.plan.source = "explicit";
}
/** Approval is not an implicit budget increase. Import-only/completed units cost nothing new. */
export function reviewBudgetShortfall(waiting: NovelAiWaiting | undefined,
  budget: { maxTotalAnlas: number; visibleSpentAnlas: number; uncertainReservedAnlas?: number; plan?: NovelAiBudgetPlan },
  pendingIndices: number[]): NovelAiWaiting | undefined {
  if (!waiting || !budget.plan || budget.maxTotalAnlas === 0) return;
  const unitWait = pendingIndices.map(index => novelAiUnitBudgetWait(budget.plan!, index)).find(Boolean);
  if (unitWait) return unitWait;
  const remainingEstimate = pendingIndices.reduce((sum, index) => sum + (budget.plan!.units[index]?.estimatedAnlas ?? 0), 0);
  const required = remainingEstimate + budget.visibleSpentAnlas + (budget.uncertainReservedAnlas ?? 0);
  if (required > budget.maxTotalAnlas) return { kind: "budget",
    reason: `方案已确认，但含已记账及待核对费用共预计 ${required} Anlas，仍超过总上限 ${budget.maxTotalAnlas}；未开始新的生成，请调整额度或修订方案。` };
}

/** Revisions only reprice the changed unit; never increase the approved total or recompile siblings. */
export async function refreshNovelAiBudgetUnit(plan: NovelAiBudgetPlan | undefined, index: number, request: Record<string, unknown>, count = 1): Promise<void> {
  if (!plan) return;
  const priced = quoteNovelAiAnlas(await readNovelAiPricingTable(), request, count);
  const previous = plan.units[index];
  const quote = { ...priced,
    maxCostAnlas: previous?.explicitMaxCostAnlas ?? (plan.autoMaxAnlasPerImage === undefined
      ? Math.ceil(priced.estimatedAnlas * (1 + plan.tolerancePercent / 100)) : plan.autoMaxAnlasPerImage * count),
    ...(previous?.explicitMaxCostAnlas !== undefined ? { explicitMaxCostAnlas: previous.explicitMaxCostAnlas } : {}) };
  plan.estimatedTotalAnlas += quote.estimatedAnlas - (plan.units[index]?.estimatedAnlas ?? 0);
  plan.units[index] = quote;
}
export function approveWaiting(waiting: NovelAiWaiting | undefined, input: { approve?: boolean; expectedRevision?: number }, revision: number): void {
  if (!waiting) return;
  if (input.approve !== true || input.expectedRevision !== revision) throw new WorkflowInputValidationError(`此 Job 等待确认；请先 status 查看方案，再 resume 携带 approve:true, expectedRevision:${revision}。`, "approval_required");
}

/** A review pause must actually deliver the saved proposal, not just say "please approve". */
export function novelAiReviewMarkdown(title: string, premise: string | undefined, scenes: Array<{ title: string; text: string }>): string {
  const escape = (value: string) => value.replace(/([\\`*_{}[\]()#+!|])/g, "\\$1").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [`## 待确认方案：${escape(title)}`, ...(premise ? [escape(premise)] : []),
    ...scenes.map((scene, index) => `### ${index + 1}. ${escape(scene.title)}\n\n${escape(scene.text)}`)].join("\n\n");
}
