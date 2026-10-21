/** Local edits to a resolved identity; never modify the shared character profile. */
export interface NovelAiIdentityPatch {
  replacePositive?: Array<{ from: string; to: string }>;
  removeNegative?: string[];
}

interface IdentityProfile {
  tag: string;
  positiveAnchors: string[];
  negativeAnchors: string[];
  /** Compiler-local provenance; even a no-op explicit replacement is user-owned. */
  explicitPositiveIndices?: number[];
}

const normalize = (value: string): string => value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
// Do not interpret or reassemble weighted/grouped/escaped NovelAI prompt syntax.
const opaqueSyntax = /[{}\[\]()\\]|::/;
const typeTags = ["1girl", "1boy", "1man", "1woman", "1person", "solo"];

// Deliberately incomplete: only whole, plain appearance tags are eligible.
// Garments, actions, type/count, weighted syntax and ambiguous prose stay intact.
const appearanceColor = "(?:black|brown|blonde?|silver(?:-gr[ae]y)?|gr[ae]y|white|red|auburn|orange|yellow|green|blue|purple|pink|teal|turquoise|gold(?:en)?)";
const plainAppearance = [
  new RegExp(`^(?:(?:very|long|short|medium|straight|wavy|curly|messy|fluffy|silky|spiky|braided|${appearanceColor}) )+hair$`),
  new RegExp(`^(?:(?:dark|light) )?${appearanceColor} eyes$`),
  /^(?:side|small) ponytail$/,
  /^large eyes$/,
  /^long eyelashes$/,
  /^small mouth$/,
  /^(?:fair|pale|light|dark|tan|tanned|brown|olive) skin$/,
  /^(?:oval|round|square|heart-shaped) face$/,
  /^(?:ahoge|freckles|heterochromia|(?:distinct )?side braid|(?:blunt|side-swept) bangs)$/,
  new RegExp(`^${appearanceColor} hair ornament$`),
];

/** Indices keep the original first-six emphasis boundary and exact source text. */
export function novelAiReferenceAppearanceOmissions(identity: IdentityProfile): Array<{ index: number; anchor: string }> {
  const explicit = new Set(identity.explicitPositiveIndices ?? []);
  return identity.positiveAnchors.flatMap((anchor, index) =>
    !explicit.has(index) && !opaqueSyntax.test(anchor) && plainAppearance.some(pattern => pattern.test(normalize(anchor)))
      ? [{ index, anchor }] : []);
}

export function stripDuplicateIdentityAnchors(
  anchors: string[],
  libraryPositiveAnchors: string[],
  libraryTag?: string,
): string[] {
  const known = new Set(typeTags);
  for (const anchor of [...libraryPositiveAnchors, ...(libraryTag ? [libraryTag] : [])]) {
    known.add(normalize(anchor));
    if (!opaqueSyntax.test(anchor)) {
      for (const tag of anchor.split(",")) if (tag.trim()) known.add(normalize(tag));
    }
  }
  return anchors.flatMap((anchor) => {
    if (known.has(normalize(anchor))) return [];
    if (opaqueSyntax.test(anchor)) return [anchor];
    const tags = anchor.split(",");
    const kept = tags.filter((tag) => !known.has(normalize(tag)));
    // Preserve the original text when there was no proven duplicate.
    return kept.length === tags.length ? [anchor] : kept.map((tag) => tag.trim()).filter(Boolean);
  });
}

function object(value: unknown, field: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) throw new Error(`${field}.${key} is not supported`);
  }
  return record;
}

function list(value: unknown, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 24) throw new Error(`${field} must be an array of at most 24 items`);
  return value;
}

function anchorText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 300) {
    throw new Error(`${field} must be a non-empty prompt string of at most 300 characters`);
  }
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)) {
    throw new Error(`${field} must use English prompt text`);
  }
  return value.trim().replace(/\s+/g, " ");
}

export function applyNovelAiIdentityPatch(
  profile: IdentityProfile | undefined,
  rawPatch: unknown,
  field: string,
): IdentityProfile | undefined {
  if (rawPatch === undefined) return profile;
  const patch = object(rawPatch, field, ["replacePositive", "removeNegative"]);
  const replacements = list(patch.replacePositive, `${field}.replacePositive`).map((raw, index) => {
    const itemField = `${field}.replacePositive[${index}]`;
    const item = object(raw, itemField, ["from", "to"]);
    return { from: anchorText(item.from, `${itemField}.from`), to: anchorText(item.to, `${itemField}.to`) };
  });
  const removals = list(patch.removeNegative, `${field}.removeNegative`)
    .map((value, index) => anchorText(value, `${field}.removeNegative[${index}]`));
  if (!replacements.length && !removals.length) return profile;
  if (!profile) throw new Error(`${field} requires a matching character library profile; use extraAnchors for a new character`);

  const resolveIndex = (anchors: string[], target: string, seen: Set<string>, selectorField: string): number => {
    const key = normalize(target);
    if (seen.has(key)) throw new Error(`${selectorField}: duplicate anchor selector "${target}"`);
    seen.add(key);
    const matches = anchors.flatMap((anchor, index) => normalize(anchor) === key ? [index] : []);
    if (matches.length !== 1) throw new Error(`${selectorField}: expected one exact library anchor match for "${target}"`);
    return matches[0]!;
  };
  const positiveAnchors = [...profile.positiveAnchors];
  const seenPositive = new Set<string>();
  const explicitPositiveIndices: number[] = [];
  for (const [index, replacement] of replacements.entries()) {
    const slot = resolveIndex(profile.positiveAnchors, replacement.from, seenPositive, `${field}.replacePositive[${index}].from`);
    // Retain ordering, including the composer's first-six emphasis boundary.
    positiveAnchors[slot] = replacement.to;
    explicitPositiveIndices.push(slot);
  }
  const seenNegative = new Set<string>();
  const removed = new Set(removals.map((target, index) =>
    resolveIndex(profile.negativeAnchors, target, seenNegative, `${field}.removeNegative[${index}]`)));
  return { ...profile, positiveAnchors, negativeAnchors: profile.negativeAnchors.filter((_, index) => !removed.has(index)),
    ...(explicitPositiveIndices.length ? { explicitPositiveIndices } : {}) };
}
