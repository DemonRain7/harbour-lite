import type { Attachment, NovelAiRequiredReference } from "../types";

const HANDLE = /^novelai-character:([a-z0-9][a-z0-9-]{0,79}):[a-f0-9]{64}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** An index addresses a grant; it does not establish persistent image identity. */
export function frozenNovelAiAttachment(request: Record<string, unknown>, attachments?: Attachment[]): Attachment | undefined {
  if (!object(request.reference)) return undefined;
  const selected = attachments?.filter(item => item.kind === "image")[request.reference.attachmentIndex as number];
  if (!selected) throw new Error("指定的本轮参考图不存在，不能猜测历史附件");
  const expected = request.referenceAttachmentHash;
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("旧执行稿缺少冻结附件哈希；请核对并修订参考图，不能按索引替换");
  if (selected.image?.sha256 !== expected) throw new Error("本轮附件与冻结参考图哈希不一致；未启动 Browser，不能用新图片替换旧任务");
  return selected;
}

/** Validate the trusted grant again at local/remote execution boundaries. */
export function validateNovelAiRequiredReferences(value: unknown): asserts value is NovelAiRequiredReference[] {
  if (!Array.isArray(value) || value.length > 6) throw new Error("冻结参考图授权必须是至多 6 项的数组");
  const seen = new Set<string>();
  for (const ref of value) {
    if (!object(ref)) throw new Error("冻结参考图授权格式无效");
    const character = ref.kind === "character" && typeof ref.handle === "string" && HANDLE.exec(ref.handle);
    const attachment = ref.kind === "attachment" && Number.isSafeInteger(ref.index) && Number(ref.index) >= 0 && Number(ref.index) < 12
      && typeof ref.sha256 === "string" && /^[a-f0-9]{64}$/.test(ref.sha256);
    if (!(character || attachment) || Object.keys(ref).some(key => !(character ? ["kind", "handle"] : ["kind", "index", "sha256"]).includes(key))) {
      throw new Error("冻结参考图授权格式无效");
    }
    const key = character ? `character:${character[1]}` : `attachment:${ref.index}`;
    if (seen.has(key)) throw new Error("同一角色只能冻结一张参考图，不能重复授权");
    seen.add(key);
  }
  if (value.some(ref => ref.kind === "attachment") && value.length !== 1) throw new Error("指定附件参考只能选择一张，不能混用角色库");
}

/** Derive from persisted compiler output, never from Browser's generated JSON. */
export function frozenNovelAiRequiredReferences(request: Record<string, unknown>): NovelAiRequiredReference[] {
  const reference = request.reference ?? "auto";
  if (reference === "none") return [];
  if (object(reference)) {
    if (typeof request.referenceAttachmentHash !== "string" || !/^[a-f0-9]{64}$/.test(request.referenceAttachmentHash)) {
      throw new Error("旧执行稿缺少冻结附件哈希；请核对并修订参考图，不能按索引猜测或替换");
    }
    const result: NovelAiRequiredReference[] = [{ kind: "attachment", index: reference.attachmentIndex as number, sha256: request.referenceAttachmentHash }];
    validateNovelAiRequiredReferences(result);
    return result;
  }
  if (reference !== "auto") throw new Error("冻结 reference 必须为 auto/none 或附件索引");
  if (request.characterRoutes === undefined) return []; // Legacy non-character requests.
  if (!Array.isArray(request.characterRoutes)) throw new Error("冻结角色路由不是数组，不能猜测参考图要求");
  const result: NovelAiRequiredReference[] = [];
  for (const route of request.characterRoutes) {
    if (!object(route)) throw new Error("冻结角色路由格式无效");
    if (route.referencePolicy !== "required") continue;
    // A resolver's known unavailable fallback was already disclosed at creation.
    // A frozen available handle must never silently become optional at execution.
    if (object(route.reference) && route.reference.available === false) continue;
    if (!object(route.reference) || route.reference.available !== true || typeof route.reference.handle !== "string") {
      throw new Error("冻结角色缺少有效参考图句柄，未启动 Browser；请先核对执行稿");
    }
    const match = HANDLE.exec(route.reference.handle);
    if (!match || match[1] !== route.id) throw new Error("冻结参考图句柄与角色不一致");
    const handle = route.reference.handle;
    if (!result.some(ref => ref.kind === "character" && ref.handle === handle)) {
      result.push({ kind: "character", handle });
    }
  }
  validateNovelAiRequiredReferences(result);
  return result;
}
