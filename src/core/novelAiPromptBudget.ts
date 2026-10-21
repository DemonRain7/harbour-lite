/** Exact page observations only. This module does not estimate or truncate prompts. */
export interface NovelAiPromptTokenCounter {
  used: number;
  total: number | null;
  max: number;
}

export interface NovelAiPromptTokenReading {
  field: string;
  lane: "positive" | "negative";
  used: number;
  max: number;
}

export interface NovelAiPromptBudgetAssessment {
  verified: true;
  positiveTokens: number;
  negativeTokens: number;
  limit: 512;
}

/** Exact counts only: safe to persist or return without exposing prompt text. */
export interface NovelAiPromptBudgetOverflowReport {
  limit: 512;
  positive: { used: number; overBy: number };
  negative: { used: number; overBy: number };
  fields: NovelAiPromptTokenReading[];
}

function copyOverflowReport(report: NovelAiPromptBudgetOverflowReport): NovelAiPromptBudgetOverflowReport {
  return {
    limit: 512,
    positive: { used: report.positive.used, overBy: report.positive.overBy },
    negative: { used: report.negative.used, overBy: report.negative.overBy },
    fields: report.fields.map(({ field, lane, used, max }) => ({ field, lane, used, max })),
  };
}

/** A complete, validated measurement failed the limit; this is not an uncertain submission. */
export class NovelAiPromptBudgetExceededError extends Error {
  readonly code = "novelai_prompt_budget_exceeded";
  readonly report: NovelAiPromptBudgetOverflowReport;

  constructor(report: NovelAiPromptBudgetOverflowReport) {
    const safe = copyOverflowReport(report);
    const overflow = (["positive", "negative"] as const)
      .filter(lane => safe[lane].overBy > 0)
      .map(lane => `${lane} ${safe[lane].used}/512 tokens（超出 ${safe[lane].overBy}）`).join("；");
    const breakdown = (["positive", "negative"] as const)
      .map(lane => `${lane}: ${safe.fields.filter(item => item.lane === lane)
        .map(item => `${item.field}=${item.used}`).join(", ")}`).join("；");
    super(`NovelAI 提示词超限：${overflow}（Base + 所有角色）；字段计数：${breakdown}；已在提交前停止，未执行 Generate，未截断内容。请先修订超限内容；冻结 Prompt 未变化时不要重新准备或重跑。`);
    this.name = "NovelAiPromptBudgetExceededError";
    Object.freeze(safe.positive);
    Object.freeze(safe.negative);
    safe.fields.forEach(Object.freeze);
    Object.freeze(safe.fields);
    this.report = Object.freeze(safe);
  }
}

/** Do not infer overflow evidence from free-form error strings or foreign objects. */
export function novelAiPromptBudgetOverflowReport(error: unknown): NovelAiPromptBudgetOverflowReport | undefined {
  return error instanceof NovelAiPromptBudgetExceededError ? copyOverflowReport(error.report) : undefined;
}

function invalid(reason: string): never {
  throw new Error(`NovelAI 提示词 token 预算无法核验：${reason}；已在提交前停止，未执行 Generate。`);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Parse the observed tooltip, not arbitrary numbers elsewhere on the page.
 * NovelAI may display NaN for its aggregate total; the per-field used count and
 * maximum must still be exact integers. The aggregate is never an input to the gate.
 */
export function parseNovelAiPromptTokenCounter(text: string): NovelAiPromptTokenCounter {
  if (typeof text !== "string") invalid("token counter text is missing");
  const normalized = text.trim().replace(/\s+/g, " ");
  const match = /^This prompt is using (\d+) of the currently used (\d+|NaN) tokens\. Max total tokens: (\d+)$/.exec(normalized);
  if (!match) invalid("unrecognized token counter tooltip");
  const used = Number(match[1]);
  const total = match[2] === "NaN" ? null : Number(match[2]);
  const max = Number(match[3]);
  if (!nonnegativeInteger(used) || !nonnegativeInteger(max) || max === 0 ||
    (total !== null && !nonnegativeInteger(total))) invalid("token counter contains an invalid integer");
  return { used, total, max };
}

/**
 * Each lane must contain exactly base plus character:1..N. Positive and negative
 * prompts have independent budgets; neither is deducted from the other.
 */
export function assessNovelAiPromptBudget(
  readings: Array<NovelAiPromptTokenReading>,
  expectedCharacters: number,
): NovelAiPromptBudgetAssessment {
  if (!nonnegativeInteger(expectedCharacters) || expectedCharacters > 6) invalid("expectedCharacters must be an integer from 0 to 6");
  if (!Array.isArray(readings)) invalid("token readings must be an array");
  const fields = new Set(["base", ...Array.from({ length: expectedCharacters }, (_, index) => `character:${index + 1}`)]);
  const observed = new Set<string>();
  const totals = { positive: 0, negative: 0 };
  const validated: NovelAiPromptTokenReading[] = [];
  for (const reading of readings) {
    if (!reading || typeof reading !== "object" || Array.isArray(reading)) invalid("malformed token reading");
    const { field, lane, used, max } = reading;
    if (lane !== "positive" && lane !== "negative") invalid("unknown prompt lane");
    if (typeof field !== "string" || !fields.has(field)) invalid("unknown or unexpected prompt field");
    const key = `${lane}:${field}`;
    if (observed.has(key)) invalid(`duplicate token reading for ${key}`);
    if (!nonnegativeInteger(used)) invalid(`invalid token usage for ${key}`);
    if (max !== 512) invalid(`unsupported token limit for ${key}; expected 512`);
    observed.add(key);
    // Explicit projection excludes extra properties, including any prompt text.
    validated.push({ field, lane, used, max });
    totals[lane] += used;
    if (!Number.isSafeInteger(totals[lane])) invalid(`token usage overflow for ${lane}`);
  }
  for (const lane of ["positive", "negative"] as const) {
    for (const field of fields) {
      if (!observed.has(`${lane}:${field}`)) invalid(`missing token reading for ${lane}:${field}`);
    }
  }
  // Both lanes must be complete and valid before any count becomes reusable
  // overflow evidence. In particular, an overfull positive lane cannot hide a
  // missing or malformed negative reading.
  if (totals.positive > 512 || totals.negative > 512) {
    throw new NovelAiPromptBudgetExceededError({
      limit: 512,
      positive: { used: totals.positive, overBy: Math.max(0, totals.positive - 512) },
      negative: { used: totals.negative, overBy: Math.max(0, totals.negative - 512) },
      fields: (["positive", "negative"] as const).flatMap(lane =>
        [...fields].map(field => validated.find(item => item.field === field && item.lane === lane)!)),
    });
  }
  return { verified: true, positiveTokens: totals.positive, negativeTokens: totals.negative, limit: 512 };
}
