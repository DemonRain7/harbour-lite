import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { applyNovelAiIdentityPatch, novelAiReferenceAppearanceOmissions, stripDuplicateIdentityAnchors, type NovelAiIdentityPatch } from "./novelAiIdentity";
import { resolveNovelAiCharacterTag, withoutDuplicateCharacterTag } from "./novelAiCharacterTag";
import {
  defaultNovelAiCharacterLibraryDir,
  normalizeNovelAiCharacterName,
  resolveNovelAiCharacter,
  type NovelAiCharacterRoute,
} from "./novelAiCharacterLibrary";
import {
  isMultiPanelComicRequest,
  MULTI_PANEL_COMIC_ROUTE_REASON,
} from "./novelAiComicRouting";
import { resolveNovelAiTemplateFragments, withNovelAiTemplateFragmentSnapshot,
  type ResolvedNovelAiTemplateFragment } from "./novelAiTemplateFragments";
import { compilerFixedBlocks, REFERENCE_OPTIONAL_DECORATION, REFERENCE_OPTIONAL_PRIORITY,
  REFERENCE_OPTIONAL_QUALITY_DEFAULTS, type NovelAiBlockVersion } from "./novelAiFixedBlocks";
import { createNovelAiTemplateModuleResolver, type NovelAiTemplateModuleInput } from "./novelAiTemplateModules";

export type NovelAiCharacterType = "female" | "male" | "other";
export type NovelAiHosieryColor = "white" | "nude" | "black";
export type NovelAiHosieryStructure = "standard" | "male-sheath";
export type NovelAiUnderwearState = "worn" | "none";
export type NovelAiCharacterPosition =
  | "left"
  | "right"
  | "center"
  | "foreground"
  | "background"
  | "front"
  | "behind";

export interface NovelAiComposeCharacterInput {
  name: string;
  /** Plain English identity for a named character absent from the library.
   * name remains the story/UI label; a qualified English name is a fallback. */
  identityTag?: string;
  type: NovelAiCharacterType;
  action: string;
  position?: NovelAiCharacterPosition;
  expression?: string;
  outfit?: NovelAiComposeCharacterOutfit | string[];
  extraAnchors?: string[];
  extraUndesired?: string[];
  /** Registered fixed template fragments for this character only, by id. */
  templateFragments?: string[];
  /** Explicit parameterized modules; registered scope is enforced. */
  templateModules?: NovelAiTemplateModuleInput[];
  identityPatch?: NovelAiIdentityPatch;
  /** @deprecated New inputs use outfit.hosiery; retained for existing tasks. */
  hosiery?: NovelAiComposeCharacterHosiery;
  /** @deprecated New inputs use outfit.underwear; all existing layer semantics still apply. */
  underwear?: NovelAiComposeCharacterUnderwear;
}

export interface NovelAiComposeCharacterOutfit {
  garments?: string[];
  hosiery?: NovelAiComposeCharacterHosiery;
  /** Omitted = legacy compile behavior; state=none must not carry color/style. */
  underwear?: NovelAiComposeCharacterUnderwear;
}

export interface NovelAiComposeCharacterHosiery {
  color: NovelAiHosieryColor;
  structure?: NovelAiHosieryStructure;
  denier?: number;
}

export interface NovelAiComposeCharacterUnderwear {
  state: NovelAiUnderwearState;
  color?: string;
  style?: string;
}

export interface NovelAiUnderwearNormalized {
  state: NovelAiUnderwearState;
  color?: string;
  style?: string;
}

export interface NovelAiComposeInput {
  characters: NovelAiComposeCharacterInput[];
  /** Explicit SFW pilot only; ignored by the unchanged legacy route. */
  sampling?: import("./workflows/novelAiSfwSampling").NovelAiSfwSampling;
  /** Applied only after actual-reference V4.5 routing; ignored by Full/V5. */
  referencePromptRevision?: import("./novelAiPromptRefinement").NovelAiPromptRevision;
  /** Optional execution settings, frozen by the shared generation preparation layer. */
  reference?: "auto" | "none" | { attachmentIndex: number };
  resolution?: { category: "Normal" | "Large" | "Wallpaper" | "Small" | "Custom"; width?: number; height?: number };
  interaction: string;
  setting: string;
  camera: string;
  lighting: string;
  style?: string;
  globalUndesired?: string[];
  /** Discretionary decoration only. All existing fields remain mandatory;
   * never put a user requirement here merely to make it fit a smaller model. */
  optionalDetails?: { positive?: string[]; negative?: string[] };
  /** Registered fixed template fragments shared by the whole frame (Base scope). */
  templateFragments?: string[];
  /** Opt-in registered module selection. No model route or budget can be supplied here. */
  templateModules?: NovelAiTemplateModuleInput[];
  orientation?: "landscape" | "portrait" | "square";
  numberOfImages?: number;
}

export interface NovelAiBrowserPromptForm {
  characters: NovelAiCharacterType[];
  characterNames: string[];
  orientation: "landscape" | "portrait" | "square";
  numberOfImages: number;
  basePrompt: string;
  undesiredPrompt: string;
  characterPrompts: string[];
  characterUndesiredPrompts: string[];
}

export interface NovelAiReferenceAssembly {
  /** Complete authored requirements, not the compiler-only diagnostic floor. */
  coreForm: NovelAiBrowserPromptForm;
  coreCompilerForm: NovelAiBrowserPromptForm;
  /** Diagnostic counts of resolved author-selected template uses (including
   * dependencies, counted per scope). Not compiler-owned defaults or text. */
  templateUsage?: { required: number; optional: number; pendingRequired: number };
  /** Optional blocks stay whole. `character` binds a fragment to one character
   * prompt; a base-lane block never leaks into another character's card.
   * `compactText` is the registered reviewed shorter wording the Compact version
   * appends instead of `text`; the Full version always appends `text`. */
  optional: Array<{ id: string; lane: "positive" | "negative"; text: string; compactText?: string; character?: number;
    /** Smaller values are attempted first across Base and every character.
     * Omitted priorities preserve the legacy author-supplied block order. */
    priority?: number }>;
  /** The same selection compiled with the Compact fixed-block version: identical
   * fields, authored content and compiler-owned text, minus the reviewed
   * extension blocks. The generation stage picks between the two from the ACTUAL
   * reference route; the composer never inspects the library or a model. */
  compactForm?: NovelAiBrowserPromptForm;
  compactCompilerForm?: NovelAiBrowserPromptForm;
  /** Module fragment refs (module:<id>.<fragment>) the Compact version leaves
   * out. Empty means both versions carry the same fixed blocks. */
  compactOmitted?: string[];
  /** Compiler-owned per-character material slots the Compact version charges once
   * in the shared Base lane, because EVERY card declared the identical layer.
   * Absent/empty means each card keeps its own copy. Full/V5 is never affected. */
  sharedBaseBlocks?: string[];
}

// Generic decoration lives in the fixed-block registry; compiler-owned identity,
// anatomy, material and content-specific constraints are deliberately NOT optional.

export interface NovelAiPromptBundle {
  schemaVersion: 1;
  bundleId: string;
  browserForm: NovelAiBrowserPromptForm;
  characterRoutes: Array<{
    query: string;
    found: boolean;
    id?: string;
    displayName?: string;
    referencePolicy?: "none" | "required";
    reference?: NovelAiCharacterRoute["reference"];
    /** New fallback cards only; proves compiled text, not visual recognition. */
    identityTag?: string;
    identityTagSource?: "explicit" | "qualified-name";
    /** Library-origin omissions only; references do not guarantee identity fidelity. */
    referencePromptReduction?: { omittedLibraryAppearance: string[]; omittedCount: number };
    position: NovelAiCharacterPosition;
    hosiery?: Required<NonNullable<NovelAiComposeCharacterInput["hosiery"]>>;
    underwear?: NovelAiUnderwearNormalized;
  }>;
  batchPolicy: {
    mode: "shared-prompt";
    numberOfImages: number;
    note: string;
  };
  acceptance: string[];
}

export interface NovelAiBatchPromptValidationInput {
  characters: string[];
  characterNames?: string[];
  numberOfImages?: number;
  basePrompt: string;
  undesiredPrompt: string;
  characterPrompts: string[];
  characterUndesiredPrompts: string[];
}

const VARIANT_MARKER = /(?:\b(?:first|second|third|fourth)\s+(?:image|picture|variant)\b|\b(?:image|picture|variant)\s*[1-4]\b|第\s*[一二三四1234]\s*张|图\s*[一二三四1234])/iu;
const CJK_PROMPT_TEXT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// 默认不注入固定画风；画风由当次要求或 styles/ 下的可选风格叶子决定。
const DEFAULT_STYLE = "";


function requiredString(value: unknown, field: string, max = 1_000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 必须是非空字符串`);
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length > max) throw new Error(`${field} 超过 ${max} 字符`);
  return normalized;
}

/** NovelAI V5 的稳定执行面使用英文 tag/短语；中文叙事留在漫画 job，不直接灌进生成表单。 */
function promptString(value: unknown, field: string, max = 1_000): string {
  const normalized = requiredString(value, field, max);
  if (CJK_PROMPT_TEXT.test(normalized)) {
    throw new Error(`${field} 必须使用简洁英文 NovelAI tag/短语；中文只保留在剧情、对白和分镜说明中`);
  }
  return normalized;
}

function optionalStringList(value: unknown, field: string, maxItems = 24): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${field} 必须是至多 ${maxItems} 项的数组`);
  return value.map((item, index) => requiredString(item, `${field}[${index}]`, 300));
}

function optionalPromptList(value: unknown, field: string, maxItems = 24): string[] {
  const values = optionalStringList(value, field, maxItems);
  for (const [index, item] of values.entries()) {
    if (CJK_PROMPT_TEXT.test(item)) {
      throw new Error(`${field}[${index}] 必须使用简洁英文 NovelAI tag/短语`);
    }
  }
  return values;
}

/** Input-only adapter: keep compiled output and frozen task hashes unchanged. */
function characterClothing(character: NovelAiComposeCharacterInput, field: string) {
  const outfit = character.outfit;
  const nested = outfit !== undefined && !Array.isArray(outfit);
  if (nested) {
    if (!outfit || typeof outfit !== "object") throw new Error(`${field}.outfit 必须是穿搭对象或旧版服装数组`);
    for (const key of Object.keys(outfit)) {
      if (!["garments", "hosiery", "underwear"].includes(key)) {
        throw new Error(`${field}.outfit.${key} 未声明；穿搭对象只接受 garments/hosiery/underwear`);
      }
    }
  }
  const layer = <K extends "hosiery" | "underwear">(key: K) => {
    const value = nested ? outfit[key] : undefined;
    if (value !== undefined && character[key] !== undefined && !isDeepStrictEqual(value, character[key])) {
      throw new Error(`${field}.outfit.${key} 与旧版 ${field}.${key} 冲突；不得同时提供不同值`);
    }
    return { value: value === undefined ? character[key] : value,
      field: value === undefined ? `${field}.${key}` : `${field}.outfit.${key}` };
  };
  return {
    garments: nested ? outfit.garments : outfit,
    garmentsField: nested ? `${field}.outfit.garments` : `${field}.outfit`,
    hosiery: layer("hosiery"),
    underwear: layer("underwear"),
  };
}

/** Compiler-owned state a registered module may branch on. It mirrors the fields
 * the author already declared, so a module never asks for the same value twice;
 * an omitted field stays absent and no default is invented here. */
function templateModuleContext(clothing: ReturnType<typeof characterClothing>, garments: string[]) {
  const hosiery = clothing.hosiery.value;
  const underwear = clothing.underwear.value;
  const declared = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const layer = declared(hosiery), under = declared(underwear);
  return {
    garments,
    ...(typeof layer?.color === "string"
      ? { hosiery: { color: layer.color, structure: typeof layer.structure === "string" ? layer.structure : "standard" } }
      : {}),
    ...(typeof under?.state === "string" ? { underwear: { state: under.state } } : {}),
  };
}

/** version="full" keeps every registered fragment; version="compact" leaves out
 * the fragments a module registered as reviewed extension blocks and substitutes
 * the reviewed shorter wording where a source registered one. Authored fields,
 * identity, material and compiler-owned text are identical in both versions. */
const fragmentTexts = (fragments: readonly ResolvedNovelAiTemplateFragment[],
  lane: "positive" | "negative", requirement: "required" | "optional",
  version: NovelAiBlockVersion = "full"): string[] =>
  fragments.filter(fragment => fragment.lane === lane && fragment.requirement === requirement &&
    (version === "full" || fragment.blockVersion !== "compact-omit"))
    .map(fragment => version === "compact" ? fragment.compactText ?? fragment.text : fragment.text);

function dedupe(parts: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    const value = raw?.replace(/\s+/g, " ").trim();
    if (!value) continue;
    const key = value.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function prompt(parts: readonly (string | undefined)[]): string {
  return dedupe(parts).join(", ");
}

interface ReferencePromptPart { value: string | undefined; authored?: boolean }

/** Only ordinary comma-separated English atoms are inspectable. Opaque groups,
 * weights, escapes and complex syntax retain their whole original source part. */
function plainReferenceAtoms(value: string | undefined): string[] | undefined {
  if (!value || /[{}\[\]()\\]|::/.test(value)) return undefined;
  const atoms = value.split(",").map(atom => atom.replace(/\s+/g, " ").trim());
  return atoms.every(atom => /^[a-z0-9][a-z0-9 '\-]*$/i.test(atom)) ? atoms : undefined;
}

/** One referenced character and one polarity only. Authored parts are never
 * edited; an exact duplicate is removed from ordinary generated parts instead. */
function referencedCharacterPrompt(parts: ReferencePromptPart[]): string {
  const key = (value: string) => value.toLocaleLowerCase("en-US");
  const seen = new Set(parts.filter(part => part.authored).map(part => part.value)
    .flatMap(value => plainReferenceAtoms(value) ?? []).map(key));
  return prompt(parts.map(part => {
    if (part.authored) return part.value;
    const atoms = plainReferenceAtoms(part.value);
    if (!atoms) return part.value;
    const kept = atoms.filter(atom => {
      const normalized = key(atom);
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
    // Preserve the complete source string if no proven duplicate was removed.
    return kept.length === atoms.length ? part.value : kept.length ? kept.join(", ") : undefined;
  }));
}

function defaultPosition(index: number, total: number): NovelAiCharacterPosition {
  if (total === 2) return index === 0 ? "left" : "right";
  if (total === 3) return (["left", "center", "right"] as const)[index] ?? "center";
  return index % 2 === 0 ? "foreground" : "background";
}

function positionPrompt(position: NovelAiCharacterPosition, version: NovelAiBlockVersion): string {
  return compilerFixedBlocks(version).position(position);
}

function hosieryParts(input: NonNullable<NovelAiComposeCharacterInput["hosiery"]>, type: NovelAiCharacterType,
  field: string, version: NovelAiBlockVersion): {
  positive: string[];
  undesired: string[];
  acceptance: string;
  normalized: Required<NonNullable<NovelAiComposeCharacterInput["hosiery"]>>;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${field} 必须是对象`);
  if (!["white", "nude", "black"].includes(input.color)) throw new Error(`${field}.color 必须是 white | nude | black`);
  const structure = input.structure ?? "standard";
  if (!["standard", "male-sheath"].includes(structure)) throw new Error(`${field}.structure 必须是 standard | male-sheath`);
  if (structure === "male-sheath" && type !== "male") {
    throw new Error(`${field}.structure: male-sheath 结构只能用于 male 角色卡`);
  }
  const defaultDenier = input.color === "nude" ? 10 : 15;
  const denier = input.denier ?? defaultDenier;
  if (!Number.isInteger(denier) || denier < 5 || denier > 80) throw new Error(`${field}.denier 必须是 5–80 的整数`);

  // Colour heads, structure/sheen, material guards and the sheath block all come
  // from the registered fixed blocks; only the version decides which wording.
  const fixed = compilerFixedBlocks(version);
  return {
    positive: dedupe([
      ...(structure === "male-sheath" ? fixed.sheathPositive : []),
      ...fixed.hosieryColorPositive(input.color, denier),
      ...fixed.hosieryCommon,
    ]),
    undesired: dedupe([
      ...fixed.hosieryUndesired,
      ...fixed.hosieryColorUndesired(input.color),
      ...(structure === "male-sheath" ? fixed.sheathUndesired : []),
    ]),
    acceptance: `${input.color} ${denier}D ${structure} pantyhose stays assigned to this character only; visually inspect center-front and crotch stitching or gusset outlines; toe seams and reinforced toe boundaries are acceptable if feet remain covered; covered or cropped crotch regions are unassessable, not passed`,
    normalized: { color: input.color, structure, denier },
  };
}

function underwearParts(
  input: NonNullable<NovelAiComposeCharacterInput["underwear"]>,
  field: string,
  version: NovelAiBlockVersion,
): {
  positive: string[];
  undesired: string[];
  acceptance: string;
  normalized: NovelAiUnderwearNormalized;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(field + " must be an object");
  const state = input.state;
  if (state !== "worn" && state !== "none") throw new Error(field + ".state must be worn | none");
  if (state === "none") {
    if (input.color !== undefined || input.style !== undefined) {
      throw new Error(field + ": state=none means no underwear layer under the pantyhose, so color/style are invalid; only state=worn describes the panty look");
    }
    return {
      positive: dedupe(compilerFixedBlocks(version).underwearNonePositive),
      undesired: dedupe(compilerFixedBlocks(version).underwearNoneUndesired),
      acceptance: "no underwear layer under the pantyhose on this character only; visually confirm no second garment and no visible panty line through the nylon; covered or cropped regions are unassessable, not passed",
      normalized: { state },
    };
  }
  const color = input.color === undefined ? undefined : promptString(input.color, field + ".color", 80);
  const style = input.style === undefined ? undefined : promptString(input.style, field + ".style", 160);
  const colorPrefix = color === undefined ? "" : color + " ";
  const styleSuffix = style === undefined ? "" : ", " + style;
  return {
    positive: dedupe([
      "wearing " + colorPrefix + "panties" + styleSuffix + " beneath the pantyhose as a separate underlayer",
      ...compilerFixedBlocks(version).underwearWornPositive,
    ]),
    undesired: dedupe(compilerFixedBlocks(version).underwearWornUndesired),
    acceptance: "panties" + (color === undefined ? "" : " in " + color) + (style === undefined ? "" : " (" + style + ")")
      + " worn as a separate layer under seamless sheer pantyhose on this character only; inspect panty color and edges softly readable through the nylon while the stockings stay continuous, seamless and sheer with no own opaque panel or gusset; the panty must not fuse into or print onto the nylon; covered or cropped regions are unassessable, not passed",
    normalized: {
      state,
      ...(color === undefined ? {} : { color }),
      ...(style === undefined ? {} : { style }),
    },
  };
}

function countPrompt(types: NovelAiCharacterType[]): string[] {
  if (!types.length) return [];
  const counts = new Map<NovelAiCharacterType, number>();
  for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
  const labels: Record<NovelAiCharacterType, string> = { female: "girl", male: "man", other: "person" };
  return [
    `${types.length}people`,
    ...(["male", "female", "other"] as const)
      .filter((type) => (counts.get(type) ?? 0) > 0)
      .map((type) => `${counts.get(type)}${labels[type]}`),
  ];
}

export function validateNovelAiBatchPrompt(input: NovelAiBatchPromptValidationInput): void {
  const count = input.characters.length;
  if (count > 6) throw new Error("NovelAI 角色卡数量必须是 0–6");
  if (input.characterPrompts.length !== count || input.characterUndesiredPrompts.length !== count) {
    throw new Error("NovelAI 角色 Prompt/Undesired 必须与角色卡等长");
  }
  if (count > 1) {
    if (!input.characterNames || input.characterNames.length !== count) {
      throw new Error("多人 NovelAI 表单必须提供与角色卡等长的 characterNames");
    }
    const names = input.characterNames.map(normalizeNovelAiCharacterName);
    if (names.some((name) => !name) || new Set(names).size !== names.length) {
      throw new Error("多人 NovelAI characterNames 必须非空且互不重复");
    }
    const prompts = input.characterPrompts.map((value) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US"));
    if (new Set(prompts).size !== prompts.length) {
      throw new Error("多人 NovelAI 角色卡不能使用完全相同的 Character Prompt");
    }
  }
  const numberOfImages = input.numberOfImages ?? 1;
  if (numberOfImages > 1) {
    const allPromptText = [input.basePrompt, ...input.characterPrompts].join("\n");
    if (VARIANT_MARKER.test(allPromptText)) {
      throw new Error("NovelAI 单个 batch 只有一份共享 Prompt；不得写第一张/第二张或 image 1/image 2 的互斥构图，请拆成独立 batch");
    }
  }
}

type NovelAiComposeOptions = { libraryDir?: string; referenceSelectionKey?: string;
    /** Internal planning provenance only, never an alternate submission form.
     * Includes compiler identity/guards and selected material expansions; excludes
     * author text and explicit identity replacements. No collection by default. */
    onRequiredForm?: (form: NovelAiBrowserPromptForm) => void;
    onReferenceAssembly?: (assembly: NovelAiReferenceAssembly) => void;
    /** Template library root holding references/assembly.json. */
    templateRoot?: string };

export async function composeNovelAiPromptBundle(raw: NovelAiComposeInput,
  options: NovelAiComposeOptions = {}): Promise<NovelAiPromptBundle> {
  const templateRoot = path.resolve(options.templateRoot ?? path.join(process.cwd(), "workflows", "novelai-generation"));
  // One compilation shares one validated snapshot across Base and all cards.
  // Loading stays lazy: ordinary V5 requests without fragments read no templates.
  return withNovelAiTemplateFragmentSnapshot(templateRoot,
    () => composeNovelAiPromptBundleInSnapshot(raw, { ...options, templateRoot }));
}

async function composeNovelAiPromptBundleInSnapshot(
  raw: NovelAiComposeInput,
  options: NovelAiComposeOptions,
): Promise<NovelAiPromptBundle> {
  if (!raw || typeof raw !== "object") throw new Error("novelai_compose 输入必须是对象");
  if (!Array.isArray(raw.characters) || raw.characters.length > 6) {
    throw new Error("novelai_compose 需要 0–6 个角色（无人场景用空数组）");
  }
  if (isMultiPanelComicRequest(JSON.stringify(raw))) {
    throw new Error(MULTI_PANEL_COMIC_ROUTE_REASON);
  }
  // Both word-block versions are compiled from the SAME fields in one pass. The
  // composer still never picks a version: the generation stage does, from the
  // actual reference route and model.
  const fixedFull = compilerFixedBlocks("full");
  const fixedCompact = compilerFixedBlocks("compact");
  const interaction = promptString(raw.interaction, "interaction", 1_200);
  const setting = promptString(raw.setting, "setting", 800);
  const camera = promptString(raw.camera, "camera", 500);
  const lighting = promptString(raw.lighting, "lighting", 500);
  const style = raw.style === undefined ? DEFAULT_STYLE : promptString(raw.style, "style", 500);
  const globalUndesired = optionalPromptList(raw.globalUndesired, "globalUndesired", 40);
  if (raw.optionalDetails !== undefined && (!raw.optionalDetails || typeof raw.optionalDetails !== "object" ||
      Array.isArray(raw.optionalDetails) || Object.keys(raw.optionalDetails).some(key => key !== "positive" && key !== "negative"))) {
    throw new Error("optionalDetails 仅接受 positive/negative 可选装饰数组；明确要求仍写入原字段");
  }
  const optionalPositive = optionalPromptList(raw.optionalDetails?.positive, "optionalDetails.positive", 16);
  const optionalNegative = optionalPromptList(raw.optionalDetails?.negative, "optionalDetails.negative", 16);
  const templateRoot = path.resolve(options.templateRoot ?? path.join(process.cwd(), "workflows", "novelai-generation"));
  // Registered fixed fragments are read from the template bodies and hash checked
  // here: the author selects ids and never copies fixed template wording.
  const resolveModules = createNovelAiTemplateModuleResolver(templateRoot);
  const baseFragments = await resolveNovelAiTemplateFragments(raw.templateFragments, "base", templateRoot, "templateFragments");
  const characterTemplateInputs = await Promise.all(raw.characters.map(async (character, index) => {
    const clothing = characterClothing(character, `characters[${index}]`);
    const outfit = optionalPromptList(clothing.garments, clothing.garmentsField, 12);
    const fragments = await resolveNovelAiTemplateFragments(character.templateFragments, "character",
      templateRoot, `characters[${index}].templateFragments`);
    return { clothing, outfit, fragments };
  }));
  // Resolve the scoped dependency graph once before emitting either word-block
  // version. No per-template names, free-text triggers or model decisions here.
  const scopedModules = await resolveModules.resolveScopes([
    { raw: raw.templateModules, scope: "base", field: "templateModules", legacy: baseFragments },
    ...raw.characters.map((character, index) => ({ raw: character.templateModules, scope: "character" as const,
      field: `characters[${index}].templateModules`, legacy: characterTemplateInputs[index]!.fragments,
      context: templateModuleContext(characterTemplateInputs[index]!.clothing, characterTemplateInputs[index]!.outfit) })),
  ]);
  baseFragments.push(...scopedModules[0]!);
  // Version bookkeeping only: the composer records which registered blocks the
  // Compact version drops. It never chooses a version, model or reference.
  const compactOmittedRefs = new Set<string>();
  const collectCompactOmissions = (fragments: readonly ResolvedNovelAiTemplateFragment[]) => {
    for (const fragment of fragments) {
      if (fragment.blockVersion === "compact-omit") compactOmittedRefs.add(fragment.ref);
    }
  };
  const templateUsage = { required: 0, optional: 0, pendingRequired: 0 };
  const countTemplateUsage = (fragments: typeof baseFragments) => {
    for (const fragment of fragments) {
      templateUsage[fragment.requirement]++;
      if (fragment.requirement === "required" && fragment.status === "pending_confirmation") templateUsage.pendingRequired++;
    }
  };
  countTemplateUsage(baseFragments);
  collectCompactOmissions(baseFragments);
  const baseFragmentRequiredPositive = fragmentTexts(baseFragments, "positive", "required");
  const baseFragmentRequiredNegative = fragmentTexts(baseFragments, "negative", "required");
  const baseFragmentOptionalPositive = fragmentTexts(baseFragments, "positive", "optional");
  const baseFragmentOptionalNegative = fragmentTexts(baseFragments, "negative", "optional");
  const baseCompactRequiredPositive = fragmentTexts(baseFragments, "positive", "required", "compact");
  const baseCompactRequiredNegative = fragmentTexts(baseFragments, "negative", "required", "compact");
  const fragmentOptionals: NovelAiReferenceAssembly["optional"] = baseFragments
    .filter(fragment => fragment.requirement === "optional")
    .map(fragment => ({ id: `fragment:${fragment.ref}`, lane: fragment.lane, text: fragment.text,
      ...(fragment.compactText ? { compactText: fragment.compactText } : {}), priority: fragment.priority }));
  const orientation = raw.orientation ?? "square";
  if (!["landscape", "portrait", "square"].includes(orientation)) throw new Error("orientation 无效");
  const numberOfImages = raw.numberOfImages ?? 1;
  if (!Number.isInteger(numberOfImages) || numberOfImages < 1 || numberOfImages > 4) {
    throw new Error("numberOfImages 必须是 1–4 的整数");
  }

  const names = raw.characters.map((character, index) => requiredString(character.name, `characters[${index}].name`, 160));
  const normalizedNames = names.map(normalizeNovelAiCharacterName);
  if (new Set(normalizedNames).size !== normalizedNames.length) throw new Error("characters.name 不得重复");
  const libraryDir = path.resolve(options.libraryDir ?? defaultNovelAiCharacterLibraryDir());
  const routes = await Promise.all(names.map((name) => resolveNovelAiCharacter(libraryDir, name, undefined, options.referenceSelectionKey)));
  const types: NovelAiCharacterType[] = [];
  const characterPrompts: string[] = [];
  const characterUndesiredPrompts: string[] = [];
  const requiredCharacters = options.onRequiredForm || options.onReferenceAssembly ? { positive: [] as string[], negative: [] as string[] } : undefined;
  const compactCharacters = requiredCharacters ? { positive: [] as string[], negative: [] as string[] } : undefined;
  const requiredCharacterPrompts: string[] = [];
  // Parallel fields for the Compact version; always the same length and order.
  const compactCharacterPrompts: string[] = [];
  const compactCharacterUndesired: string[] = [];
  const requiredCharacterUndesired: string[] = [];
  const routeSummaries: NovelAiPromptBundle["characterRoutes"] = [];
  const acceptance: string[] = [`exactly ${raw.characters.length} distinct characters with stable identity and body ownership`];

  // A per-card material slot may move into the shared Base lane only when every
  // card declares the identical layer: the registered wording of those blocks is a
  // pure function of the declared values, so equality of the declaration is
  // equality of the emitted wording. Registered, deterministic and Compact-only.
  const declaredLayer = (character: NovelAiComposeCharacterInput, key: "hosiery" | "underwear") => {
    const outfit = character.outfit;
    const nested = outfit !== undefined && !Array.isArray(outfit);
    const nestedValue = nested ? (outfit as NovelAiComposeCharacterOutfit)[key] : undefined;
    return nestedValue ?? character[key];
  };
  const layerKey = (character: NovelAiComposeCharacterInput, key: "hosiery" | "underwear"): string | undefined => {
    const value = declaredLayer(character, key);
    if (value === undefined) return undefined;
    if ("state" in value) return JSON.stringify([value.state, value.color ?? null, value.style ?? null]);
    return JSON.stringify([value.color, value.structure ?? "standard",
      value.denier ?? (value.color === "nude" ? 10 : 15)]);
  };
  const sharedLayer = (key: "hosiery" | "underwear") => raw.characters.length > 1 &&
    layerKey(raw.characters[0]!, key) !== undefined &&
    raw.characters.every(character => layerKey(character, key) === layerKey(raw.characters[0]!, key));
  const sharedMaterial = { hosiery: sharedLayer("hosiery"), underwear: sharedLayer("underwear") };
  const sharedMaterialWording = { positive: [] as string[], negative: [] as string[] };
  const sharedMaterialBlocks: string[] = [];
  const firstSharedWording: Record<"hosiery" | "underwear",
    { positive: readonly string[]; undesired: readonly string[] } | undefined> = {
      hosiery: undefined, underwear: undefined,
    };
  const verifySharedWording = (key: "hosiery" | "underwear",
    part: { positive: readonly string[]; undesired: readonly string[] } | undefined) => {
    if (!sharedMaterial[key]) return;
    if (!part) throw new Error(`共享材质 ${key} 缺少角色词块；不能从角色卡省略。`);
    const first = firstSharedWording[key];
    if (!first) firstSharedWording[key] = { positive: [...part.positive], undesired: [...part.undesired] };
    else if (!isDeepStrictEqual(part.positive, first.positive) || !isDeepStrictEqual(part.undesired, first.undesired)) {
      throw new Error(`共享材质 ${key} 的实际角色词块不一致；不能移入 Base。`);
    }
  };


  for (let index = 0; index < raw.characters.length; index += 1) {
    const character = raw.characters[index]!;
    const route = routes[index]!;
    if (!["female", "male", "other"].includes(character.type)) {
      throw new Error(`characters[${index}].type 无效`);
    }
    const action = promptString(character.action, `characters[${index}].action`, 800);
    const expression = character.expression === undefined
      ? undefined
      : promptString(character.expression, `characters[${index}].expression`, 300);
    const { clothing, outfit } = characterTemplateInputs[index]!;
    const characterTag = resolveNovelAiCharacterTag({ name: names[index]!, identityTag: character.identityTag,
      libraryTag: route.found ? route.novelai?.tag : undefined, field: `characters[${index}].identityTag` });
    const fallbackTag = characterTag && characterTag.source !== "library"
      ? { tag: characterTag.tag, source: characterTag.source } : undefined;
    const authoredAnchors = optionalPromptList(character.extraAnchors, `characters[${index}].extraAnchors`, 24);
    const extraAnchors = characterTag ? withoutDuplicateCharacterTag(authoredAnchors, characterTag.tag) : authoredAnchors;
    const extraUndesired = optionalPromptList(character.extraUndesired, `characters[${index}].extraUndesired`, 24);
    const characterFragments = [...characterTemplateInputs[index]!.fragments, ...scopedModules[index + 1]!];
    countTemplateUsage(characterFragments);
    collectCompactOmissions(characterFragments);
    const fragmentRequiredPositive = fragmentTexts(characterFragments, "positive", "required");
    const fragmentRequiredNegative = fragmentTexts(characterFragments, "negative", "required");
    const fragmentCompactRequiredPositive = fragmentTexts(characterFragments, "positive", "required", "compact");
    const fragmentCompactRequiredNegative = fragmentTexts(characterFragments, "negative", "required", "compact");
    const identity = applyNovelAiIdentityPatch(
      route.found ? route.novelai : undefined, character.identityPatch, `characters[${index}].identityPatch`,
    );
    if (!route.found && !fallbackTag && extraAnchors.length === 0) {
      throw new Error(`角色「${names[index]}」未命中薄角色库；具名角色提供 identityTag，原创/未知角色提供 extraAnchors，不能只靠显示名猜外貌`);
    }
    const position = character.position ?? defaultPosition(index, raw.characters.length);
    // Only a selected, content-addressed library reference establishes per-character
    // coverage. Attachments have no proven character mapping; unavailable references
    // and explicit reference:none keep the complete textual identity fallback.
    const referenceHandle = /^novelai-character:([a-z0-9][a-z0-9-]{0,79}):[a-f0-9]{64}$/.exec(route.reference?.handle ?? "");
    const referenceBacked = (raw.reference === undefined || raw.reference === "auto") && route.found &&
      route.referencePolicy === "required" && route.reference?.required === true && route.reference.available === true &&
      !!referenceHandle && referenceHandle[1] === route.id;
    const omissions = referenceBacked && identity ? novelAiReferenceAppearanceOmissions(identity) : [];
    const omittedIndices = new Set(omissions.map(item => item.index));
    const emphasizedIdentity = identity?.positiveAnchors.slice(0, 6).filter((_, index) => !omittedIndices.has(index)) ?? [];
    const remainingIdentity = identity?.positiveAnchors.slice(6).filter((_, index) => !omittedIndices.has(index + 6)) ?? [];
    const identityGuards = identity ? fixedFull.identityGuards : [];
    const typePrompt = character.type === "male" ? "1man" : character.type === "female" ? "1girl" : "1person";
    const identityPositive = identity
      ? [
          `{{{${identity.tag}}}}`,
          emphasizedIdentity.length
            ? `{{${emphasizedIdentity.join(", ")}}}`
            : undefined,
          ...remainingIdentity,
          ...identityGuards,
        ]
      : [fallbackTag?.tag, typePrompt, ...extraAnchors];
    const identityNegative = identity ? identity.negativeAnchors : [];
    const hosiery = clothing.hosiery.value !== undefined
      ? hosieryParts(clothing.hosiery.value, character.type, clothing.hosiery.field, "full") : undefined;
    const hosieryCompact = clothing.hosiery.value !== undefined
      ? hosieryParts(clothing.hosiery.value, character.type, clothing.hosiery.field, "compact") : undefined;
    const underwear = clothing.underwear.value !== undefined
      ? underwearParts(clothing.underwear.value, clothing.underwear.field, "full")
      : undefined;
    const underwearCompact = clothing.underwear.value !== undefined
      ? underwearParts(clothing.underwear.value, clothing.underwear.field, "compact")
      : undefined;
    // Declaration equality is not enough if a future compiler version varies
    // wording by character type or position. Compare the emitted blocks before
    // excluding any per-character copy from Compact.
    verifySharedWording("hosiery", hosieryCompact);
    verifySharedWording("underwear", underwearCompact);
    if (underwear && !hosiery) {
      throw new Error("characters[" + index + "].underwear: the underwear layer only describes stacking with pantyhose; add hosiery or omit underwear");
    }
    if (hosiery && hosiery.normalized.structure === "male-sheath" && underwear && underwear.normalized.state === "worn") {
      throw new Error("characters[" + index + "]: male-sheath pantyhose already forms an integrated front volume, so underwear.state=worn is not allowed; use state=none for no underwear");
    }
    const requiredPositiveTail = [positionPrompt(position, "full"), ...(hosiery?.positive ?? []), ...(underwear?.positive ?? [])];
    // A shared material slot leaves each card's Compact tail and is added once to
    // the Compact Base lane below; the Full tail above is never touched.
    const requiredPositiveTailCompact = [positionPrompt(position, "compact"),
      ...(hosieryCompact && !sharedMaterial.hosiery ? hosieryCompact.positive : []),
      ...(underwearCompact && !sharedMaterial.underwear ? underwearCompact.positive : [])];
    if (index === 0) {
      if (sharedMaterial.hosiery && hosieryCompact) {
        sharedMaterialWording.positive.push(...hosieryCompact.positive);
        sharedMaterialWording.negative.push(...hosieryCompact.undesired);
        sharedMaterialBlocks.push("hosiery-positive", "hosiery-undesired");
      }
      if (sharedMaterial.underwear && underwearCompact) {
        sharedMaterialWording.positive.push(...underwearCompact.positive);
        sharedMaterialWording.negative.push(...underwearCompact.undesired);
        sharedMaterialBlocks.push("underwear-positive", "underwear-undesired");
      }
    }
    const explicitIdentity = (referenceBacked || requiredCharacters) && identity
      ? new Set((identity.explicitPositiveIndices ?? []).map(anchorIndex => identity.positiveAnchors[anchorIndex]!)) : undefined;
    const buildPositive = (tail: readonly string[], fragments: readonly string[]) => {
      const authoredPositive = [
        ...(identity && !referenceBacked ? stripDuplicateIdentityAnchors(extraAnchors, identity.positiveAnchors, identity.tag) : extraAnchors),
        expression, ...outfit, action, ...fragments,
      ];
      return referenceBacked ? referencedCharacterPrompt([
        ...identityPositive.map(value => ({ value, authored: value !== undefined && explicitIdentity?.has(value) })),
        ...authoredPositive.map(value => ({ value, authored: true })),
        ...tail.map(value => ({ value })),
      ]) : prompt([...identityPositive, ...authoredPositive, ...tail]);
    };
    const positive = buildPositive(requiredPositiveTail, fragmentRequiredPositive);
    // Same structure with the Compact version; shared blocks stay identical and
    // only the registered fixed wording follows the Compact relation.
    const compactPositive = buildPositive(requiredPositiveTailCompact, fragmentCompactRequiredPositive);
    const requiredNegativeTail = [
      ...(hosiery?.undesired ?? []),
      ...(underwear?.undesired ?? []),
      ...fixedFull.requiredNegativeTail,
    ];
    const requiredNegativeTailCompact = [
      ...(hosieryCompact && !sharedMaterial.hosiery ? hosieryCompact.undesired : []),
      ...(underwearCompact && !sharedMaterial.underwear ? underwearCompact.undesired : []),
      ...fixedCompact.requiredNegativeTail,
    ];
    const buildUndesired = (tail: readonly string[], fragments: readonly string[]) => referenceBacked ? referencedCharacterPrompt([
      ...identityNegative.map(value => ({ value })), ...extraUndesired.map(value => ({ value, authored: true })),
      ...fragments.map(value => ({ value })),
      ...tail.map(value => ({ value })),
    ]) : prompt([...identityNegative, ...extraUndesired, ...fragments, ...tail]);
    const undesired = buildUndesired(requiredNegativeTail, fragmentRequiredNegative);
    const compactUndesired = buildUndesired(requiredNegativeTailCompact, fragmentCompactRequiredNegative);
    const fragmentOptionalPositive = fragmentTexts(characterFragments, "positive", "optional");
    const fragmentOptionalNegative = fragmentTexts(characterFragments, "negative", "optional");
    const fullPositive = fragmentOptionalPositive.length ? prompt([positive, ...fragmentOptionalPositive]) : positive;
    const fullUndesired = fragmentOptionalNegative.length ? prompt([undesired, ...fragmentOptionalNegative]) : undesired;
    if (fullPositive.length > 5_000 || fullUndesired.length > 5_000) {
      throw new Error(`角色「${names[index]}」编译后的 Prompt 过长`);
    }
    types.push(character.type);
    // The complete form keeps every fragment; the required-only form excludes
    // optional ones so the V4.5 planner never sees them as mandatory.
    requiredCharacterPrompts.push(positive);
    requiredCharacterUndesired.push(undesired);
    compactCharacterPrompts.push(compactPositive);
    compactCharacterUndesired.push(compactUndesired);
    characterPrompts.push(fullPositive);
    characterUndesiredPrompts.push(fullUndesired);
    for (const fragment of characterFragments.filter(item => item.requirement === "optional")) {
      fragmentOptionals.push({ id: `fragment:${fragment.ref}`, lane: fragment.lane, text: fragment.text,
        ...(fragment.compactText ? { compactText: fragment.compactText } : {}),
        character: index, priority: fragment.priority });
    }
    if (requiredCharacters) {
      // Work from source provenance, not string subtraction after joining. A
      // no-op identityPatch is still author-owned; removed negatives stay removed.
      const explicitIndices = new Set(identity?.explicitPositiveIndices ?? []);
      const fixedEmphasized = identity?.positiveAnchors.slice(0, 6)
        .filter((_, anchorIndex) => !omittedIndices.has(anchorIndex) && !explicitIndices.has(anchorIndex)) ?? [];
      const fixedRemaining = identity?.positiveAnchors.slice(6)
        .filter((_, anchorIndex) => !omittedIndices.has(anchorIndex + 6) && !explicitIndices.has(anchorIndex + 6)) ?? [];
      const buildRequiredPositive = (tail: readonly string[], fragments: readonly string[]) => [
        ...(identity ? [`{{{${identity.tag}}}}`, fixedEmphasized.length ? `{{${fixedEmphasized.join(", ")}}}` : undefined,
          ...fixedRemaining, ...identityGuards] : [fallbackTag?.tag, typePrompt]),
        ...tail, ...fragments,
      ];
      const requiredPositive = buildRequiredPositive(requiredPositiveTail, fragmentRequiredPositive);
      // This is the compiler's required semantic floor without optional authored
      // text, not the residual bytes after author-priority deduplication. An
      // author repeating a mandatory atom cannot make that constraint optional.
      // Explicit identityPatch additions remain excluded by the provenance above.
      requiredCharacters.positive.push(referenceBacked
        ? referencedCharacterPrompt(requiredPositive.map(value => ({ value })))
        : prompt(requiredPositive));
      const requiredNegative = [...identityNegative, ...requiredNegativeTail, ...fragmentRequiredNegative];
      const compactRequiredNegative = [...identityNegative, ...requiredNegativeTailCompact, ...fragmentCompactRequiredNegative];
      requiredCharacters.negative.push(referenceBacked
        ? referencedCharacterPrompt(requiredNegative.map(value => ({ value }))) : prompt(requiredNegative));
      // Compact twin of the same compiler floor: reuse the identical identity
      // and tail prefix, and swap only the registered fixed blocks.
      if (compactCharacters) {
        const compactRequiredPositive = buildRequiredPositive(requiredPositiveTailCompact, fragmentCompactRequiredPositive);
        compactCharacters.positive.push(referenceBacked
          ? referencedCharacterPrompt(compactRequiredPositive.map(value => ({ value })))
          : prompt(compactRequiredPositive));
        compactCharacters.negative.push(referenceBacked
          ? referencedCharacterPrompt(compactRequiredNegative.map(value => ({ value })))
          : prompt(compactRequiredNegative));
      }
    }

    acceptance.push(`${names[index]} keeps its own identity, outfit, local action and ${position} spatial role`);
    if (hosiery) acceptance.push(`${names[index]}: ${hosiery.acceptance}`);
    if (underwear) acceptance.push(names[index] + ": " + underwear.acceptance);
    routeSummaries.push({
      query: names[index]!,
      found: route.found,
      ...(fallbackTag ? { identityTag: fallbackTag.tag, identityTagSource: fallbackTag.source } : {}),
      ...(route.id ? { id: route.id } : {}),
      ...(route.displayName ? { displayName: route.displayName } : {}),
      ...(route.referencePolicy ? { referencePolicy: route.referencePolicy } : {}),
      ...(route.reference ? { reference: route.reference } : {}),
      ...(omissions.length ? { referencePromptReduction: {
        omittedLibraryAppearance: omissions.map(item => item.anchor), omittedCount: omissions.length,
      } } : {}),
      position,
      ...(hosiery ? { hosiery: hosiery.normalized } : {}),
      ...(underwear ? { underwear: underwear.normalized } : {}),
    });
  }

  // The shared slot is charged once, in the same lane, whatever the card count.
  const sharedMaterialBase = { positive: prompt(sharedMaterialWording.positive),
    negative: prompt(sharedMaterialWording.negative) };
  const baseGuards = [...countPrompt(types), ...fixedFull.baseGuards];
  const baseGuardsCompact = [...countPrompt(types), ...fixedCompact.baseGuards];
  const basePrompt = prompt([
    ...baseGuards,
    interaction,
    camera,
    setting,
    lighting,
    style,
    ...baseFragmentRequiredPositive,
    ...optionalPositive,
    ...baseFragmentOptionalPositive,
  ]);
  const undesiredPrompt = prompt([
    ...fixedFull.globalQualityUndesired,
    ...globalUndesired,
    ...baseFragmentRequiredNegative,
    ...optionalNegative,
    ...baseFragmentOptionalNegative,
  ]);
  const browserForm: NovelAiBrowserPromptForm = {
    characters: types,
    characterNames: names,
    orientation,
    numberOfImages,
    basePrompt,
    undesiredPrompt,
    characterPrompts,
    characterUndesiredPrompts,
  };
  validateNovelAiBatchPrompt(browserForm);
  const bundleId = createHash("sha256")
    .update(JSON.stringify({ browserForm, routes: routeSummaries.map((route) => route.id ?? route.query) }))
    .digest("hex")
    .slice(0, 20);
  const compilerForm = requiredCharacters ? {
    // Fresh arrays prevent an observer from mutating the real frozen form.
    characters: [...types], characterNames: [...names], orientation, numberOfImages,
    // Registered required fragments are fixed source text, not editable author
    // prose. Count them in the fixed-wording diagnostic so an overflow cannot
    // ask the author to repeatedly shorten unrelated scene/action fields.
    basePrompt: prompt([...baseGuards, raw.style === undefined ? DEFAULT_STYLE : undefined,
      ...baseFragmentRequiredPositive]),
    undesiredPrompt: prompt([...fixedFull.globalQualityUndesired, ...baseFragmentRequiredNegative]),
    characterPrompts: requiredCharacters.positive, characterUndesiredPrompts: requiredCharacters.negative,
  } : undefined;
  if (compilerForm) options.onRequiredForm?.(structuredClone(compilerForm));
  if (compilerForm && options.onReferenceAssembly) {
    // Program-owned defaults the Compact assembler may still drop stay out of the
    // mandatory core; an authored repetition of the same wording remains required
    // through `globalUndesired` above. Full/V5 never uses these filtered arrays.
    const coreDefaults = fixedFull.globalQualityUndesired.filter(value =>
      !REFERENCE_OPTIONAL_DECORATION.has(value) && !REFERENCE_OPTIONAL_QUALITY_DEFAULTS.has(value));
    const coreDefaultsCompact = fixedCompact.globalQualityUndesired.filter(value =>
      !REFERENCE_OPTIONAL_DECORATION.has(value) && !REFERENCE_OPTIONAL_QUALITY_DEFAULTS.has(value));
    // A caller may explicitly require the exact wording of a program default.
    // It is already present in the mandatory Compact lane in that case; offering
    // it again as an optional candidate would waste tokens and produce a false
    // include/omit decision. This lookup is Compact-only and never edits V5.
    const compactMandatoryNegativeAtoms = new Set([
      ...coreDefaultsCompact, ...globalUndesired, ...baseCompactRequiredNegative,
    ].map(value => value.replace(/\s+/g, " ").trim()));
    const unrepresentedDefault = (value: string) =>
      !compactMandatoryNegativeAtoms.has(value.replace(/\s+/g, " ").trim());
    options.onReferenceAssembly({
      templateUsage: { ...templateUsage },
      coreForm: { ...structuredClone(browserForm),
        characterPrompts: requiredCharacterPrompts, characterUndesiredPrompts: requiredCharacterUndesired,
        basePrompt: prompt([...baseGuards, interaction, camera, setting, lighting, style, ...baseFragmentRequiredPositive]),
        // An authored repetition stays required even if the same default is optional.
        undesiredPrompt: prompt([...coreDefaults, ...globalUndesired, ...baseFragmentRequiredNegative]) },
      coreCompilerForm: { ...structuredClone(compilerForm),
        undesiredPrompt: prompt([...coreDefaults, ...baseFragmentRequiredNegative]) },
      // Same fields, same authored and compiler-owned content, same character
      // order; only the registered fixed blocks follow the Compact version.
      compactForm: { ...structuredClone(browserForm),
        characterPrompts: compactCharacterPrompts, characterUndesiredPrompts: compactCharacterUndesired,
        basePrompt: prompt([...baseGuardsCompact, interaction, camera, setting, lighting, style, ...baseCompactRequiredPositive, sharedMaterialBase.positive]),
        undesiredPrompt: prompt([...coreDefaultsCompact, ...globalUndesired, ...baseCompactRequiredNegative, sharedMaterialBase.negative]) },
      compactCompilerForm: { ...structuredClone(compilerForm),
        basePrompt: prompt([...baseGuardsCompact, raw.style === undefined ? DEFAULT_STYLE : undefined, ...baseCompactRequiredPositive, sharedMaterialBase.positive]),
        undesiredPrompt: prompt([...coreDefaultsCompact, ...baseCompactRequiredNegative, sharedMaterialBase.negative]),
        characterPrompts: compactCharacters!.positive, characterUndesiredPrompts: compactCharacters!.negative },
      compactOmitted: [...compactOmittedRefs],
      sharedBaseBlocks: [...sharedMaterialBlocks],
      optional: [
        ...optionalPositive.map((text, index) => ({ id: `positive:${index}`, lane: "positive" as const, text })),
        ...optionalNegative.map((text, index) => ({ id: `negative:${index}`, lane: "negative" as const, text })),
        // Registered optional fragments stay whole and keep their own scope.
        ...fragmentOptionals,
        // Program-owned defaults: tried after every authored or template candidate,
        // and dropped whole (never trimmed) by the deterministic assembler when the
        // lane would otherwise overflow. Their registered wording is byte-identical
        // in both versions, so one source string serves as the candidate text.
        ...fixedFull.globalQualityUndesired.filter(value => REFERENCE_OPTIONAL_QUALITY_DEFAULTS.has(value))
          .map((text, index) => ({ id: `default-quality:${index}`, lane: "negative" as const, text,
            priority: REFERENCE_OPTIONAL_PRIORITY.qualityDefault }))
          .filter(block => unrepresentedDefault(block.text)),
        ...fixedFull.globalQualityUndesired.filter(value => REFERENCE_OPTIONAL_DECORATION.has(value))
          .map((text, index) => ({ id: `default-decoration:${index}`, lane: "negative" as const, text,
            priority: REFERENCE_OPTIONAL_PRIORITY.decoration }))
          .filter(block => unrepresentedDefault(block.text)),
      ],
    });
  }
  return {
    schemaVersion: 1,
    bundleId,
    browserForm,
    characterRoutes: routeSummaries,
    batchPolicy: {
      mode: "shared-prompt",
      numberOfImages,
      note: numberOfImages > 1
        ? "这一批的所有图片共享同一冻结构图，只改变随机采样；不同机位必须另建 bundle/batch。"
        : "这一批只有一张图片。",
    },
    acceptance,
  };
}
