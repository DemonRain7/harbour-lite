import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { approveWaiting, updateBudgetCeiling, reviewBudgetShortfall, refreshNovelAiBudgetUnit,
  novelAiUnitPricingWait, authorizeNovelAiUnitBudget, type NovelAiWaiting } from "../workflows/novelAiBudget";
import { validateNovelAiBatchPrompt } from "../novelAiPromptComposer";
import { novelAiPromptContentKey } from "../novelAiPromptBudgetEvidence";
import { WorkflowInputValidationError } from "../workflows/registry";
import { frozenPrompt, frozenPromptRecoveryAction, frozenPromptUnit, type FrozenPromptTarget } from "../workflows/novelAiFrozenPrompt";
import {
  COMIC_ANGLES,
  COMIC_CONTENT_RATINGS,
  COMIC_SHOTS,
  COMIC_TRANSITIONS,
  type ComicAngle,
  type ComicCharacterBible,
  type ComicContentRating,
  type ComicContinuitySnapshot,
  type ComicDialogueLine,
  type ComicJob,
  type ComicJobArtifacts,
  type ComicJobCreateInput,
  type ComicLocationBible,
  type ComicPanel,
  type ComicPanelDraft,
  type ComicShot,
  type ComicTransition,
  type ComicVisualBible,
} from "./comicTypes";

const MAX_JOB_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_PANELS = 24;
const MAX_BATCH_SIZE = 3;
const MAX_STRING = 4_000;

export interface ComicJobStoreConfig {
  jobDir: string;
  uploadDir: string;
  allowedImageRoots: string[];
  now?: () => Date;
}

export interface ComicOwner {
  ownerKey: string;
  channel: string;
  key: string;
  actorId?: string;
  sessionId?: string;
}

/** Text-only edits may also prepare an unsubmitted sibling. Claims are not
 * submissions: a released claim is safe only with the persisted false marker. */
export function comicPromptTarget(job: ComicJob, unit: number): FrozenPromptTarget {
  const panel = job.panels[unit - 1];
  const pending = panel?.status === "pending" && !panel.blocked && !panel.claimId &&
    (panel.generationStarted === false || (panel.attempts === 0 && panel.generationStarted === undefined));
  const overflow = panel?.status === "blocked" && panel.blocked?.stage === "prompt-budget" && panel.blocked.retrySafety === "safe";
  return { kind: "comic", jobId: job.id, revision: job.revision, unit, request: panel?.novelAiRequest,
    pageCounts: panel?.blocked?.promptBudgetOverflow,
    recoverable: ["planned", "blocked", "paused"].includes(job.status) && (!job.waitingFor || job.waitingFor.kind === "review") &&
      !job.panels.some(item => item.status === "running" || item.blocked?.retrySafety === "uncertain") &&
      (job.budget.uncertainReservedAnlas ?? 0) === 0 && !!panel && (pending || overflow) &&
      (panel.visibleCostAnlas ?? 0) === 0 && !panel.asset && !panel.generationReceipt };
}

export function nextComicPricingWait(job: ComicJob): NovelAiWaiting | undefined {
  if (["completed", "aborted", "ready"].includes(job.status)) return;
  const index = job.panels.findIndex(panel => panel.status !== "completed");
  const panel = job.panels[index];
  if (!panel || panel.generationReceipt || (panel.status !== "pending" &&
    !(panel.status === "blocked" && panel.blocked?.retrySafety === "safe" &&
      ["browser-result", "budget-preflight"].includes(panel.blocked.stage)))) return;
  return novelAiUnitPricingWait(job.budget.plan, index);
}

function text(value: unknown, field: string, max = MAX_STRING): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 必须是非空字符串`);
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${field} 最多 ${max} 字符`);
  return normalized;
}

function optionalText(value: unknown, field: string, max = MAX_STRING): string | undefined {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return undefined;
  return text(value, field, max);
}

function stringList(value: unknown, field: string, maxItems = 32, maxLength = 500): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`);
  if (value.length > maxItems) throw new Error(`${field} 最多 ${maxItems} 项`);
  return value.map((item, index) => text(item, `${field}[${index}]`, maxLength));
}

function finiteNumber(value: unknown, field: string, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${field} 必须是 ${min}–${max} 的数字`);
  }
  return number;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  const number = finiteNumber(value, field, min, max);
  if (!Number.isInteger(number)) throw new Error(`${field} 必须是整数`);
  return number;
}

function enumValue<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${field} 必须是 ${allowed.join(" | ")}`);
  }
  return value as T;
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  return value as Record<string, unknown>;
}

/** 完整冻结表单是每格可复现/可审计的证据；长度摘要或 bundleId 本身不够。 */
export function normalizeNovelAiRequest(value: unknown): Record<string, unknown> {
  const row = objectValue(value, "novelAiRequest");
  const bundleId = text(row.bundleId, "novelAiRequest.bundleId", 80);
  if (!/^[a-f0-9]{20}$/.test(bundleId)) throw new Error("novelAiRequest.bundleId 必须是 novelai_compose 返回的 20 位十六进制 ID");
  const form = objectValue(row.browserForm, "novelAiRequest.browserForm");
  const characters = stringList(form.characters, "novelAiRequest.browserForm.characters", 6, 16);
  if (!characters.length || characters.some((item) => !["female", "male", "other"].includes(item))) {
    throw new Error("novelAiRequest.browserForm.characters 必须包含 1–6 个 female/male/other");
  }
  const characterNames = stringList(form.characterNames, "novelAiRequest.browserForm.characterNames", 6, 120);
  const characterPrompts = stringList(form.characterPrompts, "novelAiRequest.browserForm.characterPrompts", 6, 10_000);
  const characterUndesiredPrompts = stringList(
    form.characterUndesiredPrompts,
    "novelAiRequest.browserForm.characterUndesiredPrompts",
    6,
    10_000
  );
  const orientation = enumValue(
    form.orientation,
    "novelAiRequest.browserForm.orientation",
    ["landscape", "portrait", "square"] as const
  );
  const numberOfImages = integer(form.numberOfImages, "novelAiRequest.browserForm.numberOfImages", 1, 4);
  const basePrompt = text(form.basePrompt, "novelAiRequest.browserForm.basePrompt", 10_000);
  const undesiredPrompt = text(form.undesiredPrompt, "novelAiRequest.browserForm.undesiredPrompt", 10_000);
  validateNovelAiBatchPrompt({
    characters,
    characterNames,
    numberOfImages,
    basePrompt,
    undesiredPrompt,
    characterPrompts,
    characterUndesiredPrompts,
  });
  return {
    ...row,
    bundleId,
    model: text(row.model, "novelAiRequest.model", 120),
    mode: text(row.mode, "novelAiRequest.mode", 80),
    resolution: text(row.resolution, "novelAiRequest.resolution", 80),
    browserForm: {
      ...(form.width !== undefined || form.height !== undefined ? {
        width: integer(form.width, "browserForm.width", 64, 4096), height: integer(form.height, "browserForm.height", 64, 4096),
      } : {}),
      characters,
      characterNames,
      orientation,
      numberOfImages,
      basePrompt,
      undesiredPrompt,
      characterPrompts,
      characterUndesiredPrompts,
    },
  };
}

function normalizeDialogue(value: unknown, field: string): ComicDialogueLine[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`);
  if (value.length > 8) throw new Error(`${field} 最多 8 句`);
  return value.flatMap((line, index) => {
    if (!line || typeof line !== "object" || Array.isArray(line)) throw new Error(`${field}[${index}] 必须是对象`);
    const row = line as Record<string, unknown>;
    const speaker = typeof row.speaker === "string" ? row.speaker.trim() : row.speaker;
    const dialogueText = typeof row.text === "string" ? row.text.trim() : row.text;
    if (!speaker && !dialogueText) return [];
    return [{
      speaker: text(row.speaker, `${field}[${index}].speaker`, 80),
      text: text(row.text, `${field}[${index}].text`, 300),
    }];
  });
}

function normalizeContinuity(value: unknown, field: string): ComicContinuitySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  const row = value as Record<string, unknown>;
  const rawStates = row.characterStates;
  if (!rawStates || typeof rawStates !== "object" || Array.isArray(rawStates)) {
    throw new Error(`${field}.characterStates 必须是对象`);
  }
  const entries = Object.entries(rawStates as Record<string, unknown>);
  if (entries.length > 8) throw new Error(`${field}.characterStates 最多 8 个角色`);
  const characterStates: Record<string, string> = {};
  for (const [name, state] of entries) {
    characterStates[text(name, `${field}.characterStates key`, 100)] = text(state, `${field}.characterStates.${name}`, 800);
  }
  return {
    location: text(row.location, `${field}.location`, 200),
    time: text(row.time, `${field}.time`, 120),
    axis: text(row.axis, `${field}.axis`, 300),
    screenDirection: text(row.screenDirection, `${field}.screenDirection`, 120),
    characterStates,
    props: stringList(row.props ?? [], `${field}.props`, 24, 200),
    ...(optionalText(row.intentionalAxisBreak, `${field}.intentionalAxisBreak`, 500)
      ? { intentionalAxisBreak: optionalText(row.intentionalAxisBreak, `${field}.intentionalAxisBreak`, 500) }
      : {}),
  };
}

function normalizeCharacter(value: unknown, field: string): ComicCharacterBible {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  const row = value as Record<string, unknown>;
  return {
    name: text(row.name, `${field}.name`, 120),
    role: text(row.role, `${field}.role`, 160),
    appearance: text(row.appearance, `${field}.appearance`, 1_000),
    initialWardrobe: text(row.initialWardrobe, `${field}.initialWardrobe`, 1_000),
    ...(optionalText(row.referenceQuery, `${field}.referenceQuery`, 160)
      ? { referenceQuery: optionalText(row.referenceQuery, `${field}.referenceQuery`, 160) }
      : {}),
  };
}

function normalizeLocation(value: unknown, field: string): ComicLocationBible {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  const row = value as Record<string, unknown>;
  return {
    name: text(row.name, `${field}.name`, 160),
    visualAnchors: text(row.visualAnchors, `${field}.visualAnchors`, 1_000),
  };
}

export function normalizeComicBible(value: unknown): ComicVisualBible {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bible 必须是对象");
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.characters) || row.characters.length > 8) throw new Error("bible.characters 必须是最多 8 项的数组");
  if (!Array.isArray(row.locations) || row.locations.length < 1 || row.locations.length > 12) {
    throw new Error("bible.locations 必须包含 1–12 个场景");
  }
  const characters = row.characters.map((item, index) => normalizeCharacter(item, `bible.characters[${index}]`));
  const characterKeys = characters.map((character) => character.name.toLocaleLowerCase());
  if (new Set(characterKeys).size !== characterKeys.length) throw new Error("bible.characters 角色名不得重复");
  const locations = row.locations.map((item, index) => normalizeLocation(item, `bible.locations[${index}]`));
  const locationKeys = locations.map((location) => location.name.toLocaleLowerCase());
  if (new Set(locationKeys).size !== locationKeys.length) throw new Error("bible.locations 场景名不得重复");
  return {
    style: text(row.style, "bible.style", 1_000),
    ...(row.renderStyle === undefined ? {} : { renderStyle: text(row.renderStyle, "bible.renderStyle", 500) }),
    palette: text(row.palette, "bible.palette", 500),
    lighting: text(row.lighting, "bible.lighting", 500),
    aspectRatio: enumValue(row.aspectRatio, "bible.aspectRatio", ["portrait", "landscape", "square"] as const),
    characters,
    locations,
  };
}

/** 兼容交付字段，不让旧导演的中文 title/text 在落盘时消失。 */
export function normalizeComicPanelTextAliases(value: unknown, field: string): Record<string, unknown> {
  const row = { ...objectValue(value, field) };
  for (const [alias, canonical, max] of [["title", "caption", 240], ["text", "narration", 500]] as const) {
    const aliasValue = optionalText(row[alias], `${field}.${alias}`, max);
    const canonicalValue = optionalText(row[canonical], `${field}.${canonical}`, max);
    if (aliasValue !== undefined && canonicalValue !== undefined && aliasValue !== canonicalValue) {
      throw new Error(`${field}.${alias} 与 ${field}.${canonical} 冲突；请保留同一份交付文字`);
    }
    if (aliasValue !== undefined || canonicalValue !== undefined) row[canonical] = canonicalValue ?? aliasValue;
    delete row[alias];
  }
  return row;
}

export function normalizeComicPanel(value: unknown, expectedNumber: number, bible: ComicVisualBible): ComicPanelDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`panels[${expectedNumber - 1}] 必须是对象`);
  const row = normalizeComicPanelTextAliases(value, `panels[${expectedNumber - 1}]`);
  const number = integer(row.number, `panels[${expectedNumber - 1}].number`, 1, MAX_PANELS);
  if (number !== expectedNumber) throw new Error(`panels[${expectedNumber - 1}].number 漫画格号必须连续；期望 ${expectedNumber}，实际 ${number}`);
  const characters = stringList(row.characters ?? [], `panels[${number - 1}].characters`, 8, 120);
  const known = new Set(bible.characters.map((character) => character.name));
  for (const character of characters) if (!known.has(character)) throw new Error(`panels[${number - 1}].characters 引用了 bible 中不存在的角色「${character}」`);
  const continuity = normalizeContinuity(row.continuity, `panels[${number - 1}].continuity`);
  const knownLocations = new Set(bible.locations.map((location) => location.name));
  if (!knownLocations.has(continuity.location)) {
    throw new Error(`panels[${number - 1}].continuity.location 引用了 bible 中不存在的场景「${continuity.location}」`);
  }
  for (const stateName of Object.keys(continuity.characterStates)) {
    if (!known.has(stateName)) throw new Error(`panels[${number - 1}].continuity.characterStates 引用了 bible 中不存在的角色「${stateName}」`);
  }
  for (const character of characters) {
    if (!continuity.characterStates[character]) throw new Error(`panels[${number - 1}].continuity.characterStates 缺少角色「${character}」的 continuity 状态`);
  }
  return {
    number,
    beat: text(row.beat, `panels[${number - 1}].beat`, 500),
    transition: enumValue(row.transition, `panels[${number - 1}].transition`, COMIC_TRANSITIONS) as ComicTransition,
    shot: enumValue(row.shot, `panels[${number - 1}].shot`, COMIC_SHOTS) as ComicShot,
    angle: enumValue(row.angle, `panels[${number - 1}].angle`, COMIC_ANGLES) as ComicAngle,
    focalPoint: text(row.focalPoint, `panels[${number - 1}].focalPoint`, 500),
    action: text(row.action, `panels[${number - 1}].action`, 1_000),
    emotion: text(row.emotion, `panels[${number - 1}].emotion`, 500),
    visualDescription: text(row.visualDescription, `panels[${number - 1}].visualDescription`, 2_000),
    ...(optionalText(row.caption, `panels[${number - 1}].caption`, 240) ? { caption: optionalText(row.caption, `panels[${number - 1}].caption`, 240) } : {}),
    ...(optionalText(row.narration, `panels[${number - 1}].narration`, 500) ? { narration: optionalText(row.narration, `panels[${number - 1}].narration`, 500) } : {}),
    dialogue: normalizeDialogue(row.dialogue ?? [], `panels[${number - 1}].dialogue`),
    characters,
    continuity,
    emphasis: integer(row.emphasis ?? 1, `panels[${number - 1}].emphasis`, 1, 3) as 1 | 2 | 3,
    ...(row.novelAiRequest !== undefined ? { novelAiRequest: normalizeNovelAiRequest(row.novelAiRequest) } : {}),
  };
}

export function normalizeComicJobCreateInput(value: unknown): ComicJobCreateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("job 必须是对象");
  const row = value as Record<string, unknown>;
  const contentRating: ComicContentRating = enumValue(
    row.contentRating ?? "sfw",
    "contentRating",
    COMIC_CONTENT_RATINGS
  );
  const bible = normalizeComicBible(row.bible);
  if (!Array.isArray(row.panels) || row.panels.length < 2 || row.panels.length > MAX_PANELS) {
    throw new Error(`panels 必须包含 2–${MAX_PANELS} 格`);
  }
  const panels = row.panels.map((panel, index) => normalizeComicPanel(panel, index + 1, bible));
  const layout = row.layout && typeof row.layout === "object" && !Array.isArray(row.layout)
    ? row.layout as Record<string, unknown>
    : {};
  const budget = row.budget && typeof row.budget === "object" && !Array.isArray(row.budget)
    ? row.budget as Record<string, unknown>
    : {};
  return {
    title: text(row.title, "title", 200),
    ...(optionalText(row.workflowKey, "workflowKey", 240) ? { workflowKey: optionalText(row.workflowKey, "workflowKey", 240) } : {}),
    premise: text(row.premise, "premise", 2_000),
    contentRating,
    nsfwAuthorized: integer(row.nsfwAuthorized ?? 0, "nsfwAuthorized", 0, 1) as 0 | 1,
    readingDirection: enumValue(row.readingDirection ?? "ltr", "readingDirection", ["ltr", "rtl"] as const),
    language: optionalText(row.language, "language", 80) ?? "zh-CN",
    batchSize: integer(row.batchSize ?? 3, "batchSize", 1, MAX_BATCH_SIZE),
    layout: {
      columns: integer(layout.columns ?? 2, "layout.columns", 1, 3),
      panelsPerPage: integer(layout.panelsPerPage ?? 6, "layout.panelsPerPage", 1, 6),
    },
    budget: { maxTotalAnlas: finiteNumber(budget.maxTotalAnlas ?? 0, "budget.maxTotalAnlas", 0, 1_000_000) },
    bible,
    panels,
  };
}

function safeId(value: string): string {
  if (!/^comic-[a-f0-9-]{12,64}$/.test(value)) throw new Error("comic job id 无效");
  return value;
}

function isWithin(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function atomicWrite(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_JOB_BYTES) throw new Error("comic job 超过 4MB 状态上限");
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temp, body, { flag: "wx" });
  try {
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}

export class ComicJobStore {
  private readonly config: ComicJobStoreConfig;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(config: ComicJobStoreConfig) {
    this.config = {
      ...config,
      jobDir: path.resolve(config.jobDir),
      uploadDir: path.resolve(config.uploadDir),
      allowedImageRoots: config.allowedImageRoots.map((root) => path.resolve(root)),
    };
  }

  private now(): Date {
    return this.config.now?.() ?? new Date();
  }

  private file(id: string): string {
    return path.join(this.config.jobDir, `${safeId(id)}.json`);
  }

  private async withLock<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate, () => gate);
    this.locks.set(id, queued);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(id) === queued) this.locks.delete(id);
    }
  }

  private async readUnchecked(id: string): Promise<ComicJob> {
    const raw = await fs.readFile(this.file(id), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error(`未知 comic job：${id}`);
      throw error;
    });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.schemaVersion !== 1 || parsed.id !== id) throw new Error(`comic job「${id}」结构无效`);
    // 旧任务只在读取边界兼容；返回与下一次保存时统一使用新枚举 nsfw。
    parsed.contentRating = parsed.contentRating === "adult"
      ? "nsfw"
      : enumValue(parsed.contentRating, "contentRating", COMIC_CONTENT_RATINGS);
    return parsed as unknown as ComicJob;
  }

  private assertOwner(job: ComicJob, owner: ComicOwner): void {
    if (job.ownerKey !== owner.ownerKey || (job.source.sessionId && job.source.sessionId !== owner.sessionId)) {
      throw new Error("comic job 不属于当前可信会话/主人；请回到原会话继续");
    }
  }

  private async save(job: ComicJob): Promise<void> {
    job.revision += 1;
    job.updatedAt = this.now().toISOString();
    await atomicWrite(this.file(job.id), job);
  }

  async create(owner: ComicOwner, raw: unknown, policy?: {
    plan: import("../workflows/novelAiBudget").NovelAiBudgetPlan;
    waiting?: import("../workflows/novelAiBudget").NovelAiWaiting;
  }): Promise<ComicJob> {
    const input = normalizeComicJobCreateInput(raw);
    // Batching/auto quotes can change in Settings after freezing. They are not
    // another story, and a repeated start must keep the original execution plan.
    const { batchSize: _batch, budget: _budget, ...creativePlan } = input;
    const planHash = createHash("sha256").update(JSON.stringify(creativePlan, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest("hex");
    // Keep legacy explicit-ID recovery, but never reuse its channel-only key for
    // a new session. Actor/channel ownership remains an independent check.
    const scope = owner.sessionId ? `${owner.ownerKey}\0session:${owner.sessionId}` : owner.ownerKey;
    const id = input.workflowKey
      ? `comic-${createHash("sha256").update(`${scope}\0${input.workflowKey}`).digest("hex").slice(0, 32)}`
      : `comic-${randomUUID()}`;
    const createOrReuse = async (): Promise<ComicJob> => {
      if (input.workflowKey) {
        const existing = await this.readUnchecked(id).catch((error: Error) => {
          if (/^未知 comic job：/.test(error.message)) return undefined;
          throw error;
        });
        if (existing) {
          this.assertOwner(existing, owner);
          if (existing.planHash && existing.planHash !== planHash) {
            throw new WorkflowInputValidationError(`同一 workflowKey 已绑定不同漫画计划；原 Job=${existing.id}。续跑使用 resume，修改使用 revise_panel；不能重新 start 绕过账本。`,
              "plan_conflict", [{ name: "novelai-generation", action: "status", input: { jobId: existing.id } }], existing.id);
          }
          return existing;
        }
      }
      const now = this.now().toISOString();
      const job: ComicJob = {
        schemaVersion: 1,
        id,
        ...(input.workflowKey ? { workflowKey: input.workflowKey } : {}),
        planHash,
        ownerKey: owner.ownerKey,
        source: { channel: owner.channel, key: owner.key, ...(owner.actorId ? { actorId: owner.actorId } : {}),
          ...(owner.sessionId ? { sessionId: owner.sessionId } : {}) },
        title: input.title,
        premise: input.premise,
        contentRating: input.contentRating ?? "sfw",
        nsfwAuthorized: input.nsfwAuthorized ?? 0,
        readingDirection: input.readingDirection ?? "ltr",
        language: input.language ?? "zh-CN",
        status: policy?.waiting ? "paused" : "planned",
        ...(policy?.waiting ? { waitingFor: policy.waiting } : {}),
        batchSize: input.batchSize ?? 3,
        layout: {
          columns: input.layout?.columns ?? 2,
          panelsPerPage: input.layout?.panelsPerPage ?? 6,
        },
        budget: {
          maxTotalAnlas: input.budget?.maxTotalAnlas ?? 0,
          visibleSpentAnlas: 0,
          ...(policy ? { plan: policy.plan } : {}),
        },
        bible: input.bible,
        panels: input.panels.map((panel) => ({ ...panel, status: "pending", attempts: 0 })),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      await atomicWrite(this.file(id), job);
      return job;
    };
    // workflowKey 是副作用幂等键；同进程并发 start 也只能创建一个 Job。
    return input.workflowKey ? this.withLock(id, createOrReuse) : createOrReuse();
  }

  async get(owner: ComicOwner, id: string): Promise<ComicJob> {
    const job = await this.readUnchecked(safeId(id));
    this.assertOwner(job, owner);
    return job;
  }

  async claimNextBatch(
    owner: ComicOwner,
    id: string,
    expectedRevision?: number
  ): Promise<{ job: ComicJob; claimId?: string; panels: ComicPanel[] }> {
    return this.withLock(safeId(id), async () => {
      const job = await this.readUnchecked(id);
      this.assertOwner(job, owner);
      if (expectedRevision !== undefined && job.revision !== expectedRevision) {
        throw new Error(`comic job revision 已变化：expected=${expectedRevision}, current=${job.revision}；先读取 status 再领取`);
      }
      if (job.status === "aborted" || job.status === "completed") throw new Error(`comic job 已是终态：${job.status}`);
      if (job.waitingFor || job.status === "paused" || job.status === "blocked") throw new Error("Job 已暂停；先明确 resume，不能领取新的生成任务");
      const alreadyRunning = job.panels.filter((panel) => panel.status === "running");
      if (alreadyRunning.length) throw new Error("comic job 有未释放的运行批次；先执行 resume 恢复中断状态");
      let pending = job.panels.filter((panel) => panel.status === "pending").slice(0, job.batchSize);
      const unpriced = pending.findIndex(panel => !panel.generationReceipt && novelAiUnitPricingWait(job.budget.plan, panel.number - 1));
      if (unpriced === 0) {
        job.waitingFor = novelAiUnitPricingWait(job.budget.plan, pending[0]!.number - 1);
        job.status = "paused";
        await this.save(job);
        return { job, panels: [] };
      }
      // Claim only the authorized prefix. Later unknown units must not become
      // running (or consume an attempt) before their own pricing confirmation.
      if (unpriced > 0) pending = pending.slice(0, unpriced);
      if (!pending.length) {
        if (job.panels.every((panel) => panel.status === "completed")) {
          job.status = "ready";
          await this.save(job);
        }
        return { job, panels: [] };
      }
      const claimId = `claim-${randomUUID()}`;
      for (const panel of pending) {
        panel.status = "running";
        panel.claimId = claimId;
        if (!panel.generationReceipt) { panel.attempts += 1; panel.generationStarted = false; }
        delete panel.blocked;
      }
      job.status = "running";
      await this.save(job);
      return { job, claimId, panels: pending };
    });
  }

  private async sanitizePanelSource(jobId: string, panelNumber: number, sourcePath: string, expectedResolution?: { width: number; height: number }): Promise<ComicPanel["asset"]> {
    if (!path.isAbsolute(sourcePath)) throw new Error("panel sourcePath 必须是绝对路径");
    const resolved = await fs.realpath(sourcePath).catch(() => { throw new Error("panel sourcePath 不存在"); });
    const roots = await Promise.all(this.config.allowedImageRoots.map(async (root) => fs.realpath(root).catch(() => root)));
    if (!roots.some((root) => isWithin(root, resolved))) {
      throw new Error("panel sourcePath 不在 Harbour 浏览器受控输出目录");
    }
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size < 16 || stat.size > MAX_SOURCE_IMAGE_BYTES) throw new Error("panel sourcePath 文件大小无效");
    const input = await fs.readFile(resolved);
    const pipeline = sharp(input, { animated: false, failOn: "error", limitInputPixels: 50_000_000 });
    const metadata = await pipeline.metadata();
    if (!metadata.width || !metadata.height || !metadata.format || !["png", "jpeg", "webp"].includes(metadata.format)) {
      throw new Error("panel sourcePath 不是可解码的 PNG/JPEG/WebP");
    }
    if (expectedResolution && (metadata.width !== expectedResolution.width || metadata.height !== expectedResolution.height)) {
      throw new Error(`原图分辨率不符：预期 ${expectedResolution.width}x${expectedResolution.height}，实际 ${metadata.width}x${metadata.height}；保留原回执，不重新 Generate。`);
    }
    // This is the delivered panel, not a page thumbnail. Strip source metadata
    // without adding lossy compression or shrinking the verified resolution.
    // Page layout may resize its own copy later; existing stored panels stay put.
    const bytes = await pipeline.rotate().webp({ lossless: true, effort: 4 }).toBuffer();
    const outputDir = path.join(this.config.uploadDir, "comics", safeId(jobId), "panels");
    await fs.mkdir(outputDir, { recursive: true });
    const fileName = `panel-${String(panelNumber).padStart(3, "0")}.webp`;
    const output = path.join(outputDir, fileName);
    const temp = path.join(outputDir, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
    await fs.writeFile(temp, bytes, { flag: "wx" });
    try {
      await fs.rename(temp, output);
    } finally {
      await fs.unlink(temp).catch(() => undefined);
    }
    const clean = await sharp(bytes).metadata();
    return {
      path: output,
      url: `/uploads/comics/${jobId}/panels/${fileName}`,
      mime: "image/webp",
      width: clean.width!,
      height: clean.height!,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  async markPanelGenerationStarted(owner: ComicOwner, input: {
    jobId: string; panelNumber: number; claimId: string; maxCostAnlas: number;
  }): Promise<void> {
    await this.withLock(safeId(input.jobId), async () => {
      const job = await this.readUnchecked(input.jobId);
      this.assertOwner(job, owner);
      const panel = job.panels[input.panelNumber - 1];
      if (!panel || panel.status !== "running" || panel.claimId !== input.claimId) throw new Error("panel claim 无效或已过期");
      panel.generationStarted = { maxCostAnlas: finiteNumber(input.maxCostAnlas, "maxCostAnlas", 0, 1_000_000) };
      await this.save(job);
    });
  }

  private releaseInterrupted(job: ComicJob, panel: ComicPanel): void {
    if (panel.generationStarted !== false && !panel.generationReceipt) {
      panel.status = "blocked";
      panel.blocked = { stage: "interrupted-before-receipt",
        evidence: "缺少持久成品回执或明确的未提交标记；提交/扣费未知，不能自动重新生成。", retrySafety: "uncertain" };
      const reserve = panel.generationStarted?.maxCostAnlas
        ?? Math.max(0, job.budget.maxTotalAnlas - job.budget.visibleSpentAnlas - (job.budget.uncertainReservedAnlas ?? 0));
      job.budget.uncertainReservedAnlas = (job.budget.uncertainReservedAnlas ?? 0) + reserve;
    } else panel.status = "pending";
    delete panel.claimId;
  }

  async markPanelRendered(owner: ComicOwner, input: {
    jobId: string; panelNumber: number; claimId: string;
    receipt: import("../workflows/novelAiGenerationUnit").NovelAiRenderedReceipt;
  }): Promise<ComicJob> {
    return this.withLock(safeId(input.jobId), async () => {
      const job = await this.readUnchecked(input.jobId);
      this.assertOwner(job, owner);
      const panel = job.panels[input.panelNumber - 1];
      if (!panel || panel.status !== "running" || panel.claimId !== input.claimId) throw new Error("panel claim 无效或已过期");
      if (panel.generationReceipt) return job;
      if (input.receipt.rawArtifacts.length !== 1) throw new Error("漫画单格必须恰有一个原图回执");
      const cost = finiteNumber(input.receipt.visibleCostAnlas, "visibleCostAnlas", 0, 1_000_000);
      const reserved = finiteNumber(input.receipt.uncertainReservedAnlas, "uncertainReservedAnlas", 0, 1_000_000);
      panel.generationReceipt = structuredClone(input.receipt);
      panel.visibleCostAnlas = (panel.visibleCostAnlas ?? 0) + cost;
      job.budget.visibleSpentAnlas += cost;
      job.budget.uncertainReservedAnlas = (job.budget.uncertainReservedAnlas ?? 0) + reserved;
      await this.save(job);
      return job;
    });
  }

  async recordPanel(owner: ComicOwner, input: {
    jobId: string;
    panelNumber: number;
    claimId: string;
    sourcePath: string;
    expectedResolution?: { width: number; height: number };
    visibleCostAnlas?: number;
    novelAiRequest?: Record<string, unknown>;
  }): Promise<ComicJob> {
    const jobId = safeId(input.jobId);
    return this.withLock(jobId, async () => {
      const job = await this.readUnchecked(jobId);
      this.assertOwner(job, owner);
      const panel = job.panels[input.panelNumber - 1];
      if (!panel || panel.number !== input.panelNumber) throw new Error("panelNumber 不存在");
      if (panel.status === "completed" && panel.asset) return job;
      if (panel.status !== "running" || panel.claimId !== input.claimId) throw new Error("panel claim 无效或已过期");
      // A charged generation can be blocked only because human/pixel selection is still
      // pending. blockPanel already books that spend. record_panel therefore adds only
      // newly reported cost and preserves the prior frozen request when selecting an
      // existing candidate later.
      const bookedVisibleCost = finiteNumber(panel.visibleCostAnlas ?? 0, "panel.visibleCostAnlas", 0, 1_000_000);
      const additionalVisibleCost = finiteNumber(input.visibleCostAnlas ?? 0, "visibleCostAnlas", 0, 1_000_000);
      const visibleCost = bookedVisibleCost + additionalVisibleCost;
      if (job.budget.visibleSpentAnlas + additionalVisibleCost > job.budget.maxTotalAnlas) {
        throw new Error("记录本格后将超过 comic job 的 Anlas 总预算");
      }
      const novelAiRequest = input.novelAiRequest === undefined
        ? panel.novelAiRequest
        : normalizeNovelAiRequest(input.novelAiRequest);
      if (visibleCost > 0 && !novelAiRequest) {
        throw new Error("付费生成的 Panel 必须保存完整 novelAiRequest（bundleId + browserForm + model/mode/resolution）");
      }
      const asset = await this.sanitizePanelSource(jobId, input.panelNumber, input.sourcePath, input.expectedResolution);
      panel.asset = asset;
      panel.visibleCostAnlas = visibleCost;
      panel.novelAiRequest = novelAiRequest;
      panel.status = "completed";
      delete panel.claimId;
      delete panel.blocked;
      job.budget.visibleSpentAnlas += additionalVisibleCost;
      const running = job.panels.some((item) => item.status === "running");
      const pending = job.panels.some((item) => item.status === "pending");
      if (job.status !== "aborted") job.status = running || pending ? "running" : "ready";
      await this.save(job);
      return job;
    });
  }

  async blockPanel(owner: ComicOwner, input: {
    jobId: string;
    panelNumber: number;
    claimId: string;
    stage: string;
    evidence: string;
    retrySafety: "safe" | "uncertain";
    visibleCostAnlas?: number;
    uncertainReservedAnlas?: number;
    novelAiRequest?: Record<string, unknown>;
    promptBudgetOverflow?: import("../novelAiPromptBudget").NovelAiPromptBudgetOverflowReport;
  }): Promise<ComicJob> {
    const jobId = safeId(input.jobId);
    return this.withLock(jobId, async () => {
      const job = await this.readUnchecked(jobId);
      this.assertOwner(job, owner);
      const panel = job.panels[input.panelNumber - 1];
      if (!panel || panel.status !== "running" || panel.claimId !== input.claimId) throw new Error("panel claim 无效或已过期");
      const incurredVisibleCost = finiteNumber(input.visibleCostAnlas ?? 0, "visibleCostAnlas", 0, 1_000_000);
      const novelAiRequest = input.novelAiRequest === undefined
        ? panel.novelAiRequest
        : normalizeNovelAiRequest(input.novelAiRequest);
      if (incurredVisibleCost > 0 && !novelAiRequest) {
        throw new Error("已发生付费的 blocked Panel 必须保存完整 novelAiRequest");
      }
      if (job.budget.visibleSpentAnlas + incurredVisibleCost > job.budget.maxTotalAnlas) {
        throw new Error("记录 blocked Panel 已发生费用后将超过 comic job 的 Anlas 总预算");
      }
      panel.visibleCostAnlas = finiteNumber(panel.visibleCostAnlas ?? 0, "panel.visibleCostAnlas", 0, 1_000_000) + incurredVisibleCost;
      panel.novelAiRequest = novelAiRequest;
      job.budget.visibleSpentAnlas += incurredVisibleCost;
      if (input.uncertainReservedAnlas) job.budget.uncertainReservedAnlas = (job.budget.uncertainReservedAnlas ?? 0)
        + finiteNumber(input.uncertainReservedAnlas, "uncertainReservedAnlas", 0, 1_000_000);
      panel.status = "blocked";
      panel.blocked = {
        stage: text(input.stage, "stage", 120),
        evidence: text(input.evidence, "evidence", 2_000),
        retrySafety: enumValue(input.retrySafety, "retrySafety", ["safe", "uncertain"] as const),
        ...(input.promptBudgetOverflow ? { promptBudgetOverflow: structuredClone(input.promptBudgetOverflow) } : {}),
      };
      delete panel.claimId;
      for (const sibling of job.panels) {
        if (sibling.status === "running" && sibling.claimId === input.claimId) {
          sibling.status = "pending";
          delete sibling.claimId;
        }
      }
      if (job.status !== "aborted") job.status = "blocked";
      await this.save(job);
      return job;
    });
  }

  async resume(
    owner: ComicOwner,
    id: string,
    forceUncertainRetry = false,
    expectedRevision?: number,
    policy: { approve?: boolean; maxTotalAnlas?: number; maxUnitAnlas?: number } = {}
  ): Promise<ComicJob> {
    return this.withLock(safeId(id), async () => {
      const job = await this.readUnchecked(id);
      this.assertOwner(job, owner);
      if (expectedRevision !== undefined && job.revision !== expectedRevision) {
        throw new WorkflowInputValidationError(`comic job revision 已变化：expected=${expectedRevision}, current=${job.revision}；先读取 status 再恢复`, "revision_conflict");
      }
      if (job.status === "aborted" || job.status === "completed") throw new WorkflowInputValidationError(`comic job 已是终态：${job.status}`, "terminal_job");
      const invalidPrompt = job.panels.find(panel => panel.status === "blocked" && panel.blocked?.stage === "prompt-budget");
      if (invalidPrompt) throw new WorkflowInputValidationError(
        `第 ${invalidPrompt.number} 格冻结 Prompt 已经网页实测超限；先用 revise_panel 修改提示词，再 resume。原文重跑、仅改尺寸或 forceUncertainRetry 不能解决内容超限，未启动 Browser。`,
        "prompt_change_required");
      const pricing = !job.waitingFor && nextComicPricingWait(job);
      if (pricing) {
        job.waitingFor = pricing;
        if (policy.maxUnitAnlas === undefined) {
          job.status = "paused";
          await this.save(job);
          return job;
        }
      }
      approveWaiting(job.waitingFor, { approve: policy.approve, expectedRevision }, job.revision);
      updateBudgetCeiling(job.budget, policy.maxTotalAnlas);
      authorizeNovelAiUnitBudget(job.budget.plan,
        job.panels.flatMap((panel, index) => panel.status !== "completed" && !panel.generationReceipt ? [index] : []),
        job.waitingFor, policy.maxUnitAnlas);
      if (job.waitingFor?.kind === "pricing" && policy.maxUnitAnlas === undefined) throw new WorkflowInputValidationError("未知估价需显式 maxUnitAnlas，不能仅 approve 后猜价执行", "pricing_required");
      const shortfall = reviewBudgetShortfall(job.waitingFor, job.budget,
        job.panels.flatMap((panel, index) => panel.status !== "completed" && !panel.generationReceipt ? [index] : []));
      if (shortfall) {
        job.waitingFor = shortfall; job.status = "paused";
        await this.save(job);
        return job;
      }
      for (const panel of job.panels) {
        if (panel.status === "running") {
          this.releaseInterrupted(job, panel);
          if (panel.blocked) { job.status = "blocked"; await this.save(job); }
        }
        if (panel.status === "blocked") {
          if (panel.blocked?.retrySafety === "uncertain" && !forceUncertainRetry) {
            throw new Error(`第 ${panel.number} 格 Generate 结果不确定；需要 用户 明确授权 forceUncertainRetry 才能重试`);
          }
          panel.status = "pending";
          delete panel.blocked;
        }
      }
      job.status = job.panels.every((panel) => panel.status === "completed") ? "ready" : "planned";
      delete job.waitingFor;
      await this.save(job);
      return job;
    });
  }

  async pause(owner: ComicOwner, id: string): Promise<ComicJob> {
    return this.withLock(safeId(id), async () => {
      const job = await this.readUnchecked(id);
      this.assertOwner(job, owner);
      if (job.status === "completed" || job.status === "aborted") return job;
      for (const panel of job.panels) {
        if (panel.status === "running") this.releaseInterrupted(job, panel);
      }
      job.status = job.panels.some(panel => panel.status === "blocked") ? "blocked" : "paused";
      await this.save(job);
      return job;
    });
  }

  /**
   * 导演只修订一个 Panel；Workflow 重新冻结该格并把它放回 pending。
   * 已经生成过的格必须显式 forceRegenerate，既有花费不回滚，也不会静默覆盖账本。
   */
  async revisePanel(
    owner: ComicOwner,
    id: string,
    panelNumber: number,
    rawPanel: unknown,
    forceRegenerate = false,
    expectedRevision?: number,
    pauseForReview = false,
  ): Promise<ComicJob> {
    return this.withLock(safeId(id), async () => {
      const job = await this.readUnchecked(id);
      this.assertOwner(job, owner);
      if (expectedRevision !== undefined && job.revision !== expectedRevision) throw new WorkflowInputValidationError(`Job revision 已变化：current=${job.revision}；先 status`, "revision_conflict");
      if (job.status === "aborted") throw new WorkflowInputValidationError("已终止的漫画不能通过修订重新启动", "terminal_job");
      const current = job.panels[panelNumber - 1];
      if (!current || current.number !== panelNumber) throw new WorkflowInputValidationError("panelNumber 不存在");
      if (job.panels.some(panel => panel.status === "running")) throw new WorkflowInputValidationError("该漫画正在执行，不能同时修订；先暂停再改稿", "workflow_busy");
      if (current.blocked?.retrySafety === "uncertain" || (job.budget.uncertainReservedAnlas ?? 0) > 0) throw new WorkflowInputValidationError("仍有未核对的提交/扣费；修订或 forceRegenerate 不能绕过核对，也不能清空原图与账本。", "revision_requires_reconciliation");
      if ((current.status === "completed" || current.generationReceipt) && !forceRegenerate) {
        throw new WorkflowInputValidationError("该 Panel 已生成；重新付费生成前必须显式 forceRegenerate=true", "regeneration_requires_confirmation");
      }
      const replacement = normalizeComicPanel(rawPanel, panelNumber, job.bible);
      if (current.blocked?.stage === "prompt-budget") {
        const previousKey = novelAiPromptContentKey(current.novelAiRequest);
        const replacementKey = novelAiPromptContentKey(replacement.novelAiRequest);
        if (previousKey && replacementKey && previousKey === replacementKey) throw new WorkflowInputValidationError(
          "冻结 Prompt 已经实测超限；revise_panel 必须修改提示词，不能仅改尺寸、说明文字或重新保存相同内容。原超限记录和账本保持不变。", "prompt_change_required");
        if (!previousKey || !replacementKey) throw new WorkflowInputValidationError(
          "无法核验超限稿件的完整冻结模型和提示词；先补齐可核验的改稿，不能用缺失字段清除超限记录。", "prompt_change_required");
      }
      if (replacement.novelAiRequest) await refreshNovelAiBudgetUnit(job.budget.plan, panelNumber - 1, replacement.novelAiRequest);
      job.panels[panelNumber - 1] = {
        ...replacement,
        status: "pending",
        attempts: current.attempts,
        visibleCostAnlas: current.visibleCostAnlas,
      };
      delete job.artifacts;
      const pricingWait = novelAiUnitPricingWait(job.budget.plan, panelNumber - 1);
      if (pricingWait) {
        job.waitingFor = pricingWait;
      } else if (pauseForReview || job.waitingFor) {
        job.waitingFor = { kind: "review", reason: "此格修改已保存并重新估价；原进度和账本未变，核对当前版本后继续。" };
      }
      job.status = job.waitingFor ? "paused" : "planned";
      await this.save(job);
      return job;
    });
  }

  async editPrompt(owner: ComicOwner, id: string, action: string, input: Record<string, unknown>) {
    return this.withLock(safeId(id), async () => {
      const job = await this.readUnchecked(id);
      this.assertOwner(job, owner);
      const unit = frozenPromptUnit(input, job.panels.length);
      const edit = await frozenPrompt(action, input, comicPromptTarget(job, unit));
      if (!edit.request) return { job, result: edit.result };
      const panel = job.panels[unit - 1]!;
      panel.novelAiRequest = edit.request;
      panel.status = "pending";
      delete panel.blocked;
      // An unsubmitted edit is not a paid attempt; leave all costs, earlier
      // panels and reference selections exactly as recorded.
      panel.generationStarted = false;
      job.status = "paused";
      job.waitingFor ??= { kind: "review", reason: "本格提示词已精简，沿用原预算与进度继续。" };
      await this.save(job);
      const remainingOverflow = job.panels.filter(item => item.status === "blocked")
        .map(item => frozenPromptRecoveryAction(comicPromptTarget(job, item.number))).find(Boolean);
      return { job, result: { ...edit.result, saved: true, expectedRevision: job.revision,
        nextAction: remainingOverflow ?? { name: "novelai-generation", action: "resume", input: { approve: true, expectedRevision: job.revision } } } };
    });
  }

  async abort(owner: ComicOwner, id: string, reason: string): Promise<ComicJob> {
    return this.withLock(safeId(id), async () => {
      const job = await this.readUnchecked(id);
      this.assertOwner(job, owner);
      if (job.status === "completed") throw new Error("已完成的 comic job 不能 abort");
      job.status = "aborted";
      job.abortedReason = text(reason, "reason", 1_000);
      // Keep only active claims so a late paid receipt can settle. The aborted
      // Job cannot be resumed and its final status must never be overwritten.
      for (const panel of job.panels) if (panel.status !== "running") delete panel.claimId;
      await this.save(job);
      return job;
    });
  }

  async setArtifacts(owner: ComicOwner, id: string, artifacts: ComicJobArtifacts): Promise<ComicJob> {
    return this.withLock(safeId(id), async () => {
      const job = await this.readUnchecked(id);
      this.assertOwner(job, owner);
      if (!job.panels.every((panel) => panel.status === "completed" && panel.asset)) {
        throw new Error("仍有未完成 Panel，不能完成漫画排版");
      }
      job.artifacts = artifacts;
      if (job.status !== "aborted") job.status = "completed";
      await this.save(job);
      return job;
    });
  }
}
