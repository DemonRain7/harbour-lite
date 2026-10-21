import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Tokenizer } from "@huggingface/tokenizers";

/** Planning only. Callers must select the actual-reference V4.5 branch; this
 * module neither chooses a model nor replaces the exact browser token gate. */
export interface NovelAiReferenceBudgetForm {
  basePrompt: string;
  undesiredPrompt: string;
  characterPrompts: string[];
  characterUndesiredPrompts: string[];
}

export interface NovelAiReferenceBudgetField {
  lane: "positive" | "negative";
  field: string;
  estimatedTokens: number;
  unknownTokens: number;
}

export interface NovelAiReferenceBudgetLane {
  estimatedTokens: number;
  reserveTokens: number;
  /** Total compiled text allowance, including compiler defaults, not free space. */
  recommendedBudget: number;
  remainingTokens: number;
  overBy: number;
}

export interface NovelAiReferenceBudgetPlan {
  source: "local-t5-planning-estimate";
  tokenizer: "google-t5/t5-small@df1b051c49625cf57a3d0d8d3863ed4d13564fe4";
  limit: 512;
  positive: NovelAiReferenceBudgetLane;
  negative: NovelAiReferenceBudgetLane;
  fields: NovelAiReferenceBudgetField[];
  /** Combined Base + Character text allowance, including compiler-added parts. */
  recommendedAuthorBudget: { positive: 480; negative: 416 };
  fitsPlanningBudget: boolean;
  /** The bound author can revise the whole compiled wording, not just input fields. */
  wholePromptRevision?: "available" | "applied";
  /** Present only when the composer supplies provenance, never inferred by text subtraction. */
  compilerRequired?: { positive: number; negative: number };
  planningDisposition?: "fit" | "revise_authored" | "page_check_required" | "constraints_conflict";
  requiresPageVerification: true;
  warnings: string[];
}

const TOKENIZER_ID = "google-t5/t5-small@df1b051c49625cf57a3d0d8d3863ed4d13564fe4" as const;
const ASSET_DIRECTORY = path.resolve(__dirname, "../../assets/tokenizers/google-t5-small");
const ASSET_HASHES = {
  "tokenizer.json": "d2acde0d8d71dd30a711834b07781b9c89feaac33fd332f60507699282740066",
  "tokenizer_config.json": "d1e7146101aa96282057f374aa9c3b260fba2109e5990edb1775d6efc70ffa3c",
} as const;
// Conservative Harbour authoring reserves, not official fixed preset costs.
const RESERVE = { positive: 32, negative: 96 } as const;
let tokenizerPromise: Promise<Tokenizer> | undefined;

async function loadTokenizer(): Promise<Tokenizer> {
  if (!tokenizerPromise) {
    tokenizerPromise = (async () => {
      const [{ Tokenizer }, ...assets] = await Promise.all([
        import("@huggingface/tokenizers"),
        ...Object.entries(ASSET_HASHES).map(async ([name, expected]) => {
          const bytes = await readFile(path.join(ASSET_DIRECTORY, name));
          if (createHash("sha256").update(bytes).digest("hex") !== expected) {
            throw new Error(`T5 planning tokenizer asset checksum mismatch: ${name}`);
          }
          return JSON.parse(bytes.toString("utf8")) as object;
        }),
      ]);
      return new Tokenizer(assets[0]!, assets[1]!);
    })().catch(() => {
      tokenizerPromise = undefined;
      // Do not expose paths, prompt text or an untrusted dependency error.
      throw new Error("本地 T5 规划器无法加载固定词表；不能把估计当作已通过，需恢复词表后重算，网页最终计数仍不可省略。");
    });
  }
  return tokenizerPromise;
}

/** Offline planning count of one wording string, no truncation and no page claim.
 * Used by the block-version audit; the browser counter stays the only gate. */
export async function countNovelAiPlanningTokens(text: string): Promise<number> {
  if (typeof text !== "string") throw new TypeError("T5 规划计数需要字符串");
  const tokenizer = await loadTokenizer();
  return tokenizer.encode(text, { add_special_tokens: false }).ids.length;
}

function validateForm(form: NovelAiReferenceBudgetForm): void {
  if (!form || typeof form !== "object" || Array.isArray(form)
    || typeof form.basePrompt !== "string" || typeof form.undesiredPrompt !== "string"
    || !Array.isArray(form.characterPrompts) || !Array.isArray(form.characterUndesiredPrompts)
    || form.characterPrompts.length > 6 || form.characterPrompts.length !== form.characterUndesiredPrompts.length
    || [...form.characterPrompts, ...form.characterUndesiredPrompts].some(value => typeof value !== "string")) {
    throw new TypeError("T5 规划需要完整 Base/Undesired 与等长的 0–6 个角色正负向字段；未改写、未截断 Prompt。");
  }
  // Resource protection, not a token estimate. Normal compiler limits are lower.
  if ([form.basePrompt, form.undesiredPrompt, ...form.characterPrompts, ...form.characterUndesiredPrompts]
    .some(value => value.length > 32_768)) {
    throw new TypeError("T5 规划单字段最多 32768 字符；请修改本格源字段，未改写、未截断 Prompt。");
  }
}

function laneBudget(estimatedTokens: number, lane: "positive" | "negative"): NovelAiReferenceBudgetLane {
  const recommendedBudget = 512 - RESERVE[lane];
  return { estimatedTokens, reserveTokens: RESERVE[lane], recommendedBudget,
    remainingTokens: Math.max(0, recommendedBudget - estimatedTokens), overBy: Math.max(0, estimatedTokens - recommendedBudget) };
}

/** Pure local planning, with a single lazy shared tokenizer. No network, browser,
 * generation, input edits or token-array slicing/truncation is performed here. */
export async function planNovelAiReferenceBudget(form: NovelAiReferenceBudgetForm,
  requiredForm?: NovelAiReferenceBudgetForm): Promise<NovelAiReferenceBudgetPlan> {
  validateForm(form);
  if (requiredForm) validateForm(requiredForm);
  // Snapshot before awaiting initialization; caller mutations cannot mix lanes.
  const lanes = { positive: [form.basePrompt, ...form.characterPrompts], negative: [form.undesiredPrompt, ...form.characterUndesiredPrompts] };
  const requiredSnapshot = requiredForm ? { basePrompt: requiredForm.basePrompt, undesiredPrompt: requiredForm.undesiredPrompt,
    characterPrompts: [...requiredForm.characterPrompts], characterUndesiredPrompts: [...requiredForm.characterUndesiredPrompts] } : undefined;
  const tokenizer = await loadTokenizer();
  const unknownId = tokenizer.token_to_id("<unk>");
  const fields: NovelAiReferenceBudgetField[] = [];
  const warnings = ["本地 T5 规划估计，不是 NovelAI 网页精确计数；32/96 预留为保守规划值，最终仍须网页核验。",
    "参考图不能代替动作、道具和构图。先保留用户明确要求及其可见位置；不要主动给未要求且不入镜的细节扩展长描述，也不要为合限删掉明确要求。预算通过不等于视觉验收通过。"];
  for (const lane of ["positive", "negative"] as const) {
    for (const [index, text] of lanes[lane].entries()) {
      const field = index === 0 ? "base" : `character:${index}`;
      const encoded = tokenizer.encode(text, { add_special_tokens: false });
      const unknownTokens = encoded.ids.filter(id => id === unknownId).length;
      fields.push({ lane, field, estimatedTokens: encoded.ids.length, unknownTokens });
      if (unknownTokens) warnings.push(`${lane}/${field}: 有未知 token，本地计数可能偏低或与网页不同，不能据此保证可提交。`);
      if (/[{}\[\]\\]|::|<[^<>\s]{1,64}>/.test(text)) {
        warnings.push(`${lane}/${field}: 含加权/特殊语法；本地按原文估计，未模拟 NovelAI 解析，仍须网页核验。`);
      }
    }
  }
  const positive = laneBudget(fields.filter(item => item.lane === "positive").reduce((sum, item) => sum + item.estimatedTokens, 0), "positive");
  const negative = laneBudget(fields.filter(item => item.lane === "negative").reduce((sum, item) => sum + item.estimatedTokens, 0), "negative");
  const required = requiredSnapshot ? await planNovelAiReferenceBudget(requiredSnapshot) : undefined;
  const compilerRequired = required ? { positive: required.positive.estimatedTokens, negative: required.negative.estimatedTokens } : undefined;
  const fitsPlanningBudget = positive.overBy === 0 && negative.overBy === 0;
  const planningDisposition = !compilerRequired ? undefined
    : compilerRequired.positive > 512 || compilerRequired.negative > 512 ? "constraints_conflict"
    : fitsPlanningBudget ? "fit"
    // Fixed requirements can consume the conservative reserve. In that lane,
    // retain authored content up to 512 for a real page measurement, not merely
    // up to the fixed subtotal. The other lane keeps its own planning target.
    : positive.estimatedTokens <= (compilerRequired.positive > positive.recommendedBudget ? 512 : positive.recommendedBudget) &&
      negative.estimatedTokens <= (compilerRequired.negative > negative.recommendedBudget ? 512 : negative.recommendedBudget)
      ? "page_check_required" : "revise_authored";
  if (planningDisposition === "page_check_required") warnings.push("编译器保留约束已占用规划余量；不要求作者删固定材质词，改用一次网页实测裁决。此处不是实际超限证据。");
  if (planningDisposition === "constraints_conflict") warnings.push("当前固定措辞子集超过 512，不代表语义无法短述。不能只反复缩写其它作者字段；使用整稿精简入口处理装配后的全部文本，原稿保留、参考图与模型不变。");
  return { source: "local-t5-planning-estimate", tokenizer: TOKENIZER_ID, limit: 512, positive, negative, fields,
    ...(compilerRequired ? { compilerRequired, planningDisposition } : {}),
    recommendedAuthorBudget: { positive: 480, negative: 416 }, fitsPlanningBudget,
    requiresPageVerification: true, warnings };
}

function copyReport(plan: NovelAiReferenceBudgetPlan): NovelAiReferenceBudgetPlan {
  const copyLane = (lane: NovelAiReferenceBudgetLane) => ({ estimatedTokens: lane.estimatedTokens, reserveTokens: lane.reserveTokens,
    recommendedBudget: lane.recommendedBudget, remainingTokens: lane.remainingTokens, overBy: lane.overBy });
  return { source: "local-t5-planning-estimate", tokenizer: TOKENIZER_ID, limit: 512,
    positive: copyLane(plan.positive), negative: copyLane(plan.negative),
    fields: plan.fields.map(({ lane, field, estimatedTokens, unknownTokens }) => ({ lane, field, estimatedTokens, unknownTokens })),
    recommendedAuthorBudget: { positive: 480, negative: 416 }, fitsPlanningBudget: plan.fitsPlanningBudget,
    ...(plan.wholePromptRevision ? { wholePromptRevision: plan.wholePromptRevision } : {}),
    ...(plan.compilerRequired ? { compilerRequired: { ...plan.compilerRequired }, planningDisposition: plan.planningDisposition } : {}),
    requiresPageVerification: true, warnings: [...plan.warnings] };
}

/** Deliberately distinct from exact page overflow evidence. */
export class NovelAiReferenceBudgetExceededError extends Error {
  readonly code = "novelai_reference_planning_budget_exceeded";
  readonly report: NovelAiReferenceBudgetPlan;

  constructor(plan: NovelAiReferenceBudgetPlan) {
    const report = copyReport(plan);
    const lanes = (["positive", "negative"] as const).map(lane => {
      const item = report[lane];
      return `${lane}≈${item.estimatedTokens}/${item.recommendedBudget}（另预留${item.reserveTokens}，规划超出${item.overBy}）`;
    }).join("；");
    const breakdown = report.fields.map(item => `${item.lane}/${item.field}≈${item.estimatedTokens}`).join(", ");
    super(`参考图 V4.5 的本地 T5 规划预算不足：${lanes}；${breakdown}。这是规划估计，不是网页超限证据。请作者精简本格源字段，保留动作/场景/服装等明确约束；不得截断成稿或原样重跑。未修改 Prompt、未调用 Browser 或 Generate；通过规划后仍须网页计数。`);
    this.name = "NovelAiReferenceBudgetExceededError";
    Object.freeze(report.positive); Object.freeze(report.negative); Object.freeze(report.recommendedAuthorBudget);
    if (report.compilerRequired) Object.freeze(report.compilerRequired);
    report.fields.forEach(Object.freeze); Object.freeze(report.fields); Object.freeze(report.warnings);
    this.report = Object.freeze(report);
  }
}

export async function assertNovelAiReferenceBudget(form: NovelAiReferenceBudgetForm): Promise<NovelAiReferenceBudgetPlan> {
  const plan = await planNovelAiReferenceBudget(form);
  if (!plan.fitsPlanningBudget) throw new NovelAiReferenceBudgetExceededError(plan);
  return plan;
}
