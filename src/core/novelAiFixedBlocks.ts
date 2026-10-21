/**
 * Public compiler compatibility, with the FULL / V4.5-Compact relation registered
 * in one structured definition.
 *
 * Private material presets are intentionally empty in the public copy.
 * The generic quality, identity and position helpers remain compatible.
 * Two rules keep the remaining defaults in one place:
 *  - `full` is the very array the V5 (no actual reference) path has always
 *    emitted. It is referenced, never re-typed, so the Full output, field order,
 *    IDs and old baselines stay byte-identical.
 *  - `compact` is a reviewed shorter wording used ONLY by the reference/V4.5
 *    Compact path. It may merge repeated phrasing and drop atoms that another
 *    fixed source in the same submission already carries verbatim, but it may
 *    not drop identity, action, garment, spatial, visibility or negation
 *    constraints, and it never truncates a word, weight or compound group.
 */

export type NovelAiBlockVersion = "full" | "compact";
export type NovelAiFixedBlockLane = "positive" | "negative";
export type NovelAiFixedBlockScope = "base" | "character";
/** "shared" = both versions emit the same wording (already minimal).
 *  "short"  = a reviewed Compact wording replaces the Full wording. */
export type NovelAiFixedBlockRelation = "shared" | "short";

export interface NovelAiCompilerFixedBlock {
  id: string;
  lane: NovelAiFixedBlockLane;
  scope: NovelAiFixedBlockScope;
  relation: NovelAiFixedBlockRelation;
  /** Exact V5 Full wording. Same array (or by-branch map) the composer has always
   * used, never a re-typed copy. */
  full: readonly string[] | Record<string, readonly string[]>;
  /** Exact reference/V4.5 wording. Identical to `full` when relation is "shared". */
  compact: readonly string[] | Record<string, readonly string[]>;
  /** Required whenever relation is "short": what was merged or de-duplicated. */
  rationale?: string;
  /** Extra reason a source cannot be shortened further. */
  limitation?: string;
  /** V5-only optional decoration blocks the budget packer may still drop. */
  optionalDecoration?: boolean;
  /** True when the entry carries a `{denier}` placeholder filled from hosiery data. */
  denierPlaceholder?: boolean;
}

const GLOBAL_QUALITY_UNDESIRED = [
  "lowres",
  "blurry",
  "bad anatomy",
  "bad hands",
  "extra limbs",
  "extra legs",
  "missing limbs",
  "fused legs",
  "disconnected body parts",
  "interpenetrating bodies",
  "impossible pelvis connection",
  "extra fingers",
  "fused fingers",
  "merged bodies",
  "fused torsos",
  "duplicate person",
  "missing person",
  "wrong character count",
  "identity blending",
  "swapped hair colors",
  "swapped eye colors",
  "clothing color transfer",
  "action role reversal",
  "text",
  "watermark",
  "logo",
  "blank white band",
  "white border",
  "empty margin",
  "letterbox",
  "split panel",
];

/** Generic quality synonyms are merged; private weighted guards are not shipped. */
const GLOBAL_QUALITY_UNDESIRED_COMPACT = [
  "lowres",
  "blurry",
  "bad anatomy",
  "bad hands",
  "extra, missing, fused or disconnected limbs",
  "merged or interpenetrating bodies",
  "fused torsos",
  "impossible pelvis connection",
  "extra or fused fingers",
  "duplicate or missing person",
  "wrong character count",
  "identity blending",
  "swapped hair or eye colors",
  "clothing color transfer",
  "action role reversal",
  "text",
  "watermark",
  "logo",
  "split panel",
  "blank white band",
  "white border",
  "empty margin",
  "letterbox",
];

const HOSIERY_COMMON = [] as string[];

/** Reference-only material wording. Construction/weight groups stay intact;
 * short optical cues describe translucency and broad, soft reflections instead
 * of adding another long material paragraph. Full/V5 above is unchanged. */
const HOSIERY_COMMON_COMPACT = [] as string[];

const HOSIERY_UNDESIRED = [] as string[];

/** Reviewed Compact wording: material, colour, hosiery-shape, foot and
 * thigh-high-family negations all stay; the weighted seam group is untouched. */
const HOSIERY_UNDESIRED_COMPACT = [] as string[];

const UNDERWEAR_NONE_POSITIVE = [] as string[];

const UNDERWEAR_NONE_POSITIVE_COMPACT = [] as string[];

const UNDERWEAR_NONE_UNDESIRED = [] as string[];

const UNDERWEAR_NONE_UNDESIRED_COMPACT = [] as string[];

const UNDERWEAR_WORN_POSITIVE = [] as string[];

const UNDERWEAR_WORN_POSITIVE_COMPACT = [] as string[];

const UNDERWEAR_WORN_UNDESIRED = [] as string[];

const UNDERWEAR_WORN_UNDESIRED_COMPACT = [] as string[];

const SHEATH_POSITIVE = [] as string[];

const SHEATH_POSITIVE_COMPACT = [] as string[];

const SHEATH_UNDESIRED = [] as string[];

const SHEATH_UNDESIRED_COMPACT = [] as string[];

/** Hosiery colour heads keep the author-supplied denier, so the placeholder is
 * substituted identically in both versions. */
export const NOVELAI_DENIER_PLACEHOLDER = "{denier}";

const HOSIERY_COLOR_POSITIVE: Record<string, readonly string[]> = {};

const HOSIERY_COLOR_POSITIVE_COMPACT: Record<string, readonly string[]> = {};

const HOSIERY_COLOR_UNDESIRED: Record<string, readonly string[]> = {};

const HOSIERY_COLOR_UNDESIRED_COMPACT: Record<string, readonly string[]> = {};

/** One branch per spatial role; only the selected role is ever emitted. */
const POSITION_PROMPTS: Record<string, readonly string[]> = {
  left: ["positioned on the left side of the frame"],
  right: ["positioned on the right side of the frame"],
  center: ["positioned near the center of the frame"],
  foreground: ["positioned in the foreground"],
  background: ["positioned behind the foreground character"],
  front: ["positioned in front of the other character"],
  behind: ["positioned behind the other character"],
};

const POSITION_PROMPTS_COMPACT: Record<string, readonly string[]> = {
  left: ["left side of the frame"],
  right: ["right side of the frame"],
  center: ["near the center of the frame"],
  foreground: ["in the foreground"],
  background: ["behind the foreground character"],
  front: ["in front of the other character"],
  behind: ["behind the other character"],
};

const BASE_GUARDS = [
  "distinct separate bodies and stable character identities",
  "clear body ownership and anatomically plausible pose",
  "every visible limb belongs to exactly one character",
];

const BASE_GUARDS_COMPACT = [
  "distinct bodies, stable identities, clear body ownership",
  "anatomically plausible pose, each visible limb owned by one character",
];

/** With an actual reference the image already carries the face; these two guards
 * are the only compiler-owned identity wording and are already minimal. */
const IDENTITY_GUARDS = ["canonical recognizable character design", "consistent facial design"];

const REQUIRED_NEGATIVE_TAIL = [
  "identity blending",
  "identity drift",
  "generic substitute character",
  "another character's features",
  "clothing color transfer",
];

/** The Base lane already carries "identity blending" and "clothing color
 * transfer" verbatim in both versions, so the Compact tail drops only those two
 * exact duplicates and keeps every character-scoped negation. */
const REQUIRED_NEGATIVE_TAIL_COMPACT = [
  "identity drift",
  "generic substitute character",
  "another character's features",
];

/** Generic, program-owned decoration. Never identity, anatomy or material. */
export const REFERENCE_OPTIONAL_DECORATION = new Set([
  "blank white band", "white border", "empty margin", "letterbox",
]);

/** Generic, program-owned quality defaults. They restate no author requirement
 * (never identity, action, garment, material, spatial or visibility), so the
 * Compact version does not spend its lane on them unconditionally: the
 * deterministic assembler offers them as optional candidates and may leave them
 * out before the Browser, reporting every omitted id. They are dropped later
 * than the decorations above, because a stray watermark reads worse than a thin
 * edge. The Full/V5 form still carries them verbatim. */
export const REFERENCE_OPTIONAL_QUALITY_DEFAULTS = new Set([
  "lowres", "blurry", "text", "watermark", "logo", "split panel",
]);

/** Optional compiler default priority bands. The assembler tries smaller values
 * first, so authored optional content and registered template fragments
 * (priority <= 100) are always kept ahead of program-owned defaults. */
export const REFERENCE_OPTIONAL_PRIORITY = { qualityDefault: 1_000,
  decoration: Number.MAX_SAFE_INTEGER } as const;

/** Compiler-owned per-character material slots. Every card pays for them again
 * with byte-identical wording whenever all cards declare the same hosiery or
 * underwear layer. The Compact version may emit such a slot once in the shared
 * Base lane - same wording, charged once - but only when EVERY card in the same
 * form declares the identical layer, and never in Full/V5. The scope change is
 * reported separately; offline token tests cannot establish visual equivalence. */
export const NOVELAI_COMPACT_SHARED_MATERIAL_SLOTS = ["hosiery-positive",
  "hosiery-undesired", "underwear-positive", "underwear-undesired"] as const;

const shared = (full: readonly string[]): readonly string[] => full;

export const NOVELAI_COMPILER_FIXED_BLOCKS: readonly NovelAiCompilerFixedBlock[] = [
  { id: "global-quality-undesired", lane: "negative", scope: "base", relation: "short",
    full: GLOBAL_QUALITY_UNDESIRED, compact: GLOBAL_QUALITY_UNDESIRED_COMPACT, optionalDecoration: true,
    rationale: "合并同义否定（extra/missing/fused limbs、extra/fused fingers、merged/interpenetrating bodies、duplicate/missing person、swapped hair/eye colors），保留全部否定类别、四条装饰串与两条加权守卫。" },
  { id: "base-guards", lane: "positive", scope: "base", relation: "short",
    full: BASE_GUARDS, compact: BASE_GUARDS_COMPACT,
    rationale: "三条守卫合并为两条，身份独立、身体归属与肢体归属三个约束都在。" },
  { id: "identity-guards", lane: "positive", scope: "character", relation: "shared",
    full: shared(IDENTITY_GUARDS), compact: shared(IDENTITY_GUARDS),
    limitation: "两条身份锚点已是短语级最短表达，再删即丢身份约束。" },
  { id: "required-negative-tail", lane: "negative", scope: "character", relation: "short",
    full: REQUIRED_NEGATIVE_TAIL, compact: REQUIRED_NEGATIVE_TAIL_COMPACT,
    rationale: "去掉 Base lane 已经逐字携带的 identity blending / clothing color transfer，只保留角色作用域否定。" },
  { id: "hosiery-common", lane: "positive", scope: "character", relation: "short",
    full: HOSIERY_COMMON, compact: HOSIERY_COMMON_COMPACT,
    rationale: "公开副本不附带私有材质预设，仅保留兼容字段。" },
  { id: "hosiery-undesired", lane: "negative", scope: "character", relation: "short",
    full: HOSIERY_UNDESIRED, compact: HOSIERY_UNDESIRED_COMPACT,
    rationale: "公开副本不附带私有材质预设，仅保留兼容字段。" },
  { id: "hosiery-color-positive", lane: "positive", scope: "character", relation: "short",
    full: [], compact: [], denierPlaceholder: true,
    rationale: "公开副本不附带私有材质预设，仅保留兼容字段。" },
  { id: "hosiery-color-undesired", lane: "negative", scope: "character", relation: "short",
    full: [], compact: [],
    rationale: "公开副本不附带私有材质预设，仅保留兼容字段。" },
  { id: "underwear-none-positive", lane: "positive", scope: "character", relation: "short",
    full: UNDERWEAR_NONE_POSITIVE, compact: UNDERWEAR_NONE_POSITIVE_COMPACT,
    rationale: "公开副本不附带私有材质预设，仅保留兼容字段。" },
  { id: "underwear-none-undesired", lane: "negative", scope: "character", relation: "short",
    full: UNDERWEAR_NONE_UNDESIRED, compact: UNDERWEAR_NONE_UNDESIRED_COMPACT,
    rationale: "公开副本不附带私有材质预设，仅保留兼容字段。" },
  { id: "underwear-worn-positive", lane: "positive", scope: "character", relation: "short",
    full: UNDERWEAR_WORN_POSITIVE, compact: UNDERWEAR_WORN_POSITIVE_COMPACT,
    rationale: "公开副本不附带私有材质预设，仅保留兼容字段。" },
  { id: "underwear-worn-undesired", lane: "negative", scope: "character", relation: "short",
    full: UNDERWEAR_WORN_UNDESIRED, compact: UNDERWEAR_WORN_UNDESIRED_COMPACT,
    rationale: "公开副本不附带私有材质预设，仅保留兼容字段。" },
  { id: "sheath-positive", lane: "positive", scope: "character", relation: "short",
    full: SHEATH_POSITIVE, compact: SHEATH_POSITIVE_COMPACT,
    rationale: "公开副本不附带私有材质预设，仅保留兼容字段。" },
  { id: "sheath-undesired", lane: "negative", scope: "character", relation: "short",
    full: SHEATH_UNDESIRED, compact: SHEATH_UNDESIRED_COMPACT,
    rationale: "公开副本不附带私有材质预设，仅保留兼容字段。" },
  { id: "position", lane: "positive", scope: "character", relation: "short",
    full: POSITION_PROMPTS, compact: POSITION_PROMPTS_COMPACT,
    rationale: "每次只输出一条七选一短语，去掉重复的 positioned on 前缀即可保持空间角色语义。" },
];

function pick(block: NovelAiCompilerFixedBlock, version: NovelAiBlockVersion): readonly string[] {
  const wording = version === "compact" ? block.compact : block.full;
  if (!Array.isArray(wording)) throw new Error(`固定词块 ${block.id} 是逐分支映射，必须按分支取值`);
  return wording;
}

const block = (id: string): NovelAiCompilerFixedBlock => {
  const found = NOVELAI_COMPILER_FIXED_BLOCKS.find(entry => entry.id === id);
  if (!found) throw new Error(`未登记的编译器固定词块 ${id}`);
  return found;
};

export function applyNovelAiDenier(wording: readonly string[], denier: number): string[] {
  return wording.map(value => value.split(NOVELAI_DENIER_PLACEHOLDER).join(String(denier)));
}

/** The only wiring the composer uses. Every field maps to a registered block, so
 * the Full/Compact relation can never drift away from the emitted wording. */
export function compilerFixedBlocks(version: NovelAiBlockVersion) {
  return {
    globalQualityUndesired: pick(block("global-quality-undesired"), version),
    baseGuards: pick(block("base-guards"), version),
    identityGuards: pick(block("identity-guards"), version),
    requiredNegativeTail: pick(block("required-negative-tail"), version),
    hosieryCommon: pick(block("hosiery-common"), version),
    hosieryUndesired: pick(block("hosiery-undesired"), version),
    hosieryColorPositive: (color: string, denier: number) => applyNovelAiDenier(
      (version === "compact" ? HOSIERY_COLOR_POSITIVE_COMPACT : HOSIERY_COLOR_POSITIVE)[color] ?? [], denier),
    hosieryColorUndesired: (color: string) => (version === "compact" ? HOSIERY_COLOR_UNDESIRED_COMPACT : HOSIERY_COLOR_UNDESIRED)[color] ?? [],
    underwearNonePositive: pick(block("underwear-none-positive"), version),
    underwearNoneUndesired: pick(block("underwear-none-undesired"), version),
    underwearWornPositive: pick(block("underwear-worn-positive"), version),
    underwearWornUndesired: pick(block("underwear-worn-undesired"), version),
    sheathPositive: pick(block("sheath-positive"), version),
    sheathUndesired: pick(block("sheath-undesired"), version),
    position: (position: string) => (version === "compact" ? POSITION_PROMPTS_COMPACT : POSITION_PROMPTS)[position]!.join(""),
    version,
  };
}

/** Offline audit of the compiler-owned fixed blocks. The denier placeholder is
 * filled with the same default the composer uses, so the counts are comparable. */
export async function auditNovelAiCompilerFixedBlockVersions(
  countTokens: (text: string) => number | Promise<number>) {
  const rows: Array<{ source: string; id: string; lane: string; slot: string; relation: string;
    optionalDecoration: boolean; fullTokens: number; compactTokens: number; rationale: string }> = [];
  const joined = (wording: readonly string[]) => wording.join(", ").split(NOVELAI_DENIER_PLACEHOLDER).join("15");
  for (const entry of listNovelAiCompilerFixedBlockWording()) {
    // Map-shaped blocks emit one branch at a time, so each branch gets its own
    // row: summing all colours or all seven positions would invent a cost that
    // no single image can ever pay.
    const branches: Array<[string, readonly string[], readonly string[]]> =
      typeof entry.full === "object" && !Array.isArray(entry.full)
        ? Object.keys(entry.full).map(key => [`${entry.id}:${key}`,
          (entry.full as Record<string, readonly string[]>)[key]!,
          (entry.compact as Record<string, readonly string[]>)[key]!])
        : [[entry.id, entry.full as readonly string[], entry.compact as readonly string[]]];
    for (const [id, full, compact] of branches) {
      rows.push({ source: "compiler:novelAiFixedBlocks", id, lane: entry.lane, slot: entry.scope,
        relation: entry.relation, optionalDecoration: entry.optionalDecoration,
        fullTokens: await countTokens(joined(full)), compactTokens: await countTokens(joined(compact)),
        rationale: entry.rationale });
    }
  }
  return rows;
}

/** Audit helper: every registered wording pair, without creative re-authoring. */
export function listNovelAiCompilerFixedBlockWording() {
  return NOVELAI_COMPILER_FIXED_BLOCKS.map(entry => ({
    id: entry.id, lane: entry.lane, scope: entry.scope, relation: entry.relation,
    optionalDecoration: entry.optionalDecoration === true, rationale: entry.rationale ?? entry.limitation ?? "",
    full: entry.id === "hosiery-color-positive" ? HOSIERY_COLOR_POSITIVE : entry.id === "hosiery-color-undesired" ? HOSIERY_COLOR_UNDESIRED : entry.full,
    compact: entry.id === "hosiery-color-positive" ? HOSIERY_COLOR_POSITIVE_COMPACT : entry.id === "hosiery-color-undesired" ? HOSIERY_COLOR_UNDESIRED_COMPACT : entry.compact,
    denierPlaceholder: entry.denierPlaceholder === true,
  }));
}
