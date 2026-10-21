/** Parentheses are literal parts of NovelAI character tags, not SD weights.
 * Use this only for identity fields/lookup keys, never arbitrary prompt text. */
export function unescapeNovelAiTagParentheses(value: string): string {
  return value.replace(/\\+([()])/g, "$1");
}

const key = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

/** An explicit identity is one plain tag, not a prompt, weight or instruction. */
export function parseNovelAiCharacterTag(value: unknown, field = "identityTag"): string {
  if (typeof value !== "string" || !value.trim() || value.length > 300 ||
    /[,{}\[\]\\\x00-\x1f\x7f]|::/.test(unescapeNovelAiTagParentheses(value)) ||
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)) {
    throw new Error(`${field} 必须是一个不带权重的英文角色 tag，如 name (work)，不能是外貌词串`);
  }
  const tag = unescapeNovelAiTagParentheses(value).trim().replace(/\s+/g, " ");
  if (!/[a-z]/i.test(tag) || !/^[^()]+(?:\([^()]+\)\s*)*$/.test(tag)) {
    throw new Error(`${field} 的角色 tag 括号必须完整配对，不嵌套、不使用权重语法`);
  }
  return tag;
}

function qualifiedTag(name: string): string | undefined {
  try {
    const tag = parseNovelAiCharacterTag(name);
    return tag.includes("(") ? tag : undefined;
  } catch { return undefined; }
}

export function resolveNovelAiCharacterTag(input: {
  name: string; identityTag?: unknown; libraryTag?: string; field: string;
}): { tag: string; source: "library" | "explicit" | "qualified-name" } | undefined {
  const explicit = input.identityTag === undefined ? undefined : parseNovelAiCharacterTag(input.identityTag, input.field);
  const inferred = qualifiedTag(input.name);
  const authoritative = input.libraryTag ?? inferred;
  if (explicit && authoritative && key(explicit) !== key(unescapeNovelAiTagParentheses(authoritative))) {
    throw new Error(`${input.field} 与角色库/带作品名的角色名冲突；核对角色身份，不用新 tag 静默替换另一个角色`);
  }
  if (input.libraryTag) return { tag: input.libraryTag, source: "library" };
  if (explicit) return { tag: explicit, source: "explicit" };
  return inferred ? { tag: inferred, source: "qualified-name" } : undefined;
}

/** Only standalone copies of THIS identity are removed. Weighted/grouped
 * appearance, garments and every other escaped string remain byte-identical. */
export function withoutDuplicateCharacterTag(anchors: string[], tag: string): string[] {
  return anchors.filter(anchor => {
    try { return key(parseNovelAiCharacterTag(anchor)) !== key(tag); }
    catch { return true; }
  });
}

/** Structural preservation, never a claim that the model recognized a person. */
export function assertNovelAiCharacterTagPreserved(tag: string, prompt: string, field: string): void {
  const literal = key(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`(?:^|[\\s,{}\\[\\]:])${literal}(?=$|[\\s,{}\\[\\]:])`, "u").test(key(prompt))) {
    throw new Error(`${field} 丢失或改写了角色 tag「${tag}」；必须保留在该角色的正向 Prompt，不能只放在名字标签或 Base`);
  }
}
