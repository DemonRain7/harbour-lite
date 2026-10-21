import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolContext } from "../../types";
import {
  discardPublishedNovelAiSources,
  publishNovelAiArtifacts,
  type NovelAiDeliveryResult,
  type PublishedNovelAiArtifact,
} from "../novelAiArtifactDelivery";
import {
  isMultiPanelComicRequest,
  MULTI_PANEL_COMIC_ROUTE_REASON,
} from "../novelAiComicRouting";
import type { NovelAiComposeInput } from "../novelAiPromptComposer";
import { novelAiPromptContentKey } from "../novelAiPromptBudgetEvidence";
import type { BrowserControllerResult } from "../tools/spawnSubagent";
import { publishWorkflowJobSnapshot } from "../tools/runWorkflow";
import type { NovelAiBrowserRunner } from "./novelAiBrowserExecution";
import { compileNovelAiGeneration, novelAiGenerationDimensions, resizeFrozenNovelAiGeneration, runNovelAiGenerationUnit } from "./novelAiGenerationUnit";
import { WorkflowInputValidationError, type WorkflowExecutor, type WorkflowInvocation } from "./registry";
import { planNovelAiBudget, unitBudget, approveWaiting, updateBudgetCeiling, anlasLimit, novelAiReviewMarkdown, reviewBudgetShortfall,
  refreshNovelAiBudgetUnit, novelAiUnitPricingWait, authorizeNovelAiUnitBudget, targetedNovelAiPricingWait,
  type NovelAiBudgetPlan, type NovelAiWaiting } from "./novelAiBudget";
import type { NovelAiAccountReservations } from "./novelAiAccountReservations";
import { assertFrozenPromptAuthor, frozenPrompt, frozenPromptRecoveryAction, frozenPromptUnit, promptRecoverySummary, type FrozenPromptTarget } from "./novelAiFrozenPrompt";

const MAX_JOB_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 12;
const DELIVERY_STATE_KEY = "novelai-image-set:authoritative-delivery";

/** Forward only executor-owned receipts from an internal creator/checkpoint to Main. */
export function rememberNovelAiImageSetResult(value: unknown, ctx: Pick<ToolContext, "runState">): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const result = value as Record<string, unknown>;
  if (typeof result.jobId !== "string" || !result.jobId.startsWith("nai-set-") || !result.status) return;
  ctx.runState?.set(DELIVERY_STATE_KEY, { ...result, totalImages: result.total,
    urls: result.deliveryUrls ?? [],
  });
}

type ImageSetMode = "single" | "variants" | "independent";
type ImageSetStatus = "planned" | "running" | "paused" | "blocked" | "completed" | "aborted";
type ImageSetGroupStatus = "pending" | "running" | "rendered" | "blocked" | "completed";
type BudgetSource = "auto" | "explicit" | "owner-standing-1-to-2";
type ArtifactPublisher = (input: string, artifacts: string[]) => Promise<NovelAiDeliveryResult>;

interface ImageSetOwner {
  ownerKey: string;
  channel: string;
  key: string;
  actorId: string;
  sessionId?: string;
}

interface ImageSetGroup {
  index: number;
  itemIndex: number;
  batchIndex: number;
  title: string;
  caption?: string;
  expectedImages: number;
  novelAiRequest: Record<string, unknown>;
  status: ImageSetGroupStatus;
  attempts: number;
  visibleCostAnlas: number;
  /** 当前一次 Generate 可用的总上限；丢失回执时按此保守预留，不冒充实际扣费。 */
  reservationAnlas?: number;
  chargeState?: BrowserControllerResult["chargeState"];
  rawArtifacts?: string[];
  artifacts?: PublishedNovelAiArtifact[];
  blocked?: {
    stage: string;
    reason: string;
    retrySafety: "safe" | "uncertain";
    rawArtifacts?: string[];
    partialArtifacts?: PublishedNovelAiArtifact[];
    promptBudgetOverflow?: import("../novelAiPromptBudget").NovelAiPromptBudgetOverflowReport;
  };
}

interface ImageSetJob {
  schemaVersion: 1;
  id: string;
  workflowKey: string;
  planHash: string;
  ownerKey: string;
  source: { channel: string; key: string; actorId: string; sessionId?: string };
  title: string;
  mode: ImageSetMode;
  contentRating: "sfw" | "nsfw";
  nsfwAuthorized: 0 | 1;
  status: ImageSetStatus;
  totalImages: number;
  budget: {
    source: BudgetSource;
    maxTotalAnlas: number;
    visibleSpentAnlas: number;
    uncertainReservedAnlas: number;
    plan?: NovelAiBudgetPlan;
  };
  waitingFor?: NovelAiWaiting;
  groups: ImageSetGroup[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  abortedReason?: string;
}

interface CompiledImageSetPlan {
  title: string;
  mode: ImageSetMode;
  contentRating: "sfw" | "nsfw";
  nsfwAuthorized: 0 | 1;
  totalImages: number;
  budget: { source: BudgetSource; maxTotalAnlas: number; plan?: NovelAiBudgetPlan };
  waitingFor?: NovelAiWaiting;
  groups: Array<Omit<ImageSetGroup, "status" | "attempts" | "visibleCostAnlas">>;
}

function imagePromptTarget(job: ImageSetJob, unit: number): FrozenPromptTarget {
  const group = job.groups[unit - 1];
  // This store has no separate not-started marker. Only an untouched pending
  // group (zero claims) proves it has never reached Browser.
  const pending = group?.status === "pending" && group.attempts === 0 && !group.blocked &&
    (group.chargeState === undefined || group.chargeState === "not_charged");
  const overflow = group?.status === "blocked" && group.blocked?.stage === "prompt-budget" &&
    group.blocked.retrySafety === "safe" && group.chargeState === "not_charged";
  return { kind: "image", jobId: job.id, revision: job.revision, unit, request: group?.novelAiRequest,
    pageCounts: group?.blocked?.promptBudgetOverflow,
    recoverable: ["planned", "blocked", "paused"].includes(job.status) && (!job.waitingFor || job.waitingFor.kind === "review") &&
      !job.groups.some(item => item.status === "running" || item.blocked?.retrySafety === "uncertain" || item.chargeState === "unknown") &&
      job.budget.uncertainReservedAnlas === 0 && !!group && (pending || overflow) && group.visibleCostAnlas === 0 &&
      !group.rawArtifacts?.length && !group.artifacts?.length && !group.blocked?.rawArtifacts?.length && !group.blocked?.partialArtifacts?.length };
}

function pendingImageGenerationIndices(job: ImageSetJob): number[] {
  return job.groups.flatMap((group, index) => group.status !== "completed" && !group.rawArtifacts?.length ? [index] : []);
}

/** Derived for legacy status reads too; uncertain submissions must keep their
 * reconciliation state instead of being relabelled as a safe pricing pause. */
function nextImagePricingWait(job: ImageSetJob): NovelAiWaiting | undefined {
  if (["completed", "aborted"].includes(job.status)) return;
  const index = job.groups.findIndex(group => group.status !== "completed");
  const group = job.groups[index];
  if (!group || group.rawArtifacts?.length || (group.status !== "pending" &&
    !(group.status === "blocked" && group.blocked?.retrySafety === "safe" && group.chargeState === "not_charged" &&
      ["browser-result", "budget-preflight"].includes(group.blocked.stage)))) return;
  return novelAiUnitPricingWait(job.budget.plan, index);
}

export interface NovelAiImageSetWorkflowConfig {
  jobDir: string;
  runBrowser?: NovelAiBrowserRunner;
  publishArtifacts?: ArtifactPublisher;
  now?: () => Date;
  graphRoot?: string;
  accountReservations?: NovelAiAccountReservations;
}

interface ImageSetDeliveryRecord {
  status: ImageSetStatus | "needs_input";
  jobId: string;
  title: string;
  visibleSpentAnlas: number;
  maxTotalAnlas?: number;
  uncertainReservedAnlas: number;
  totalImages: number;
  deliveryMarkdown?: string;
  urls?: string[];
  reason?: string;
  retrySafety?: "safe" | "uncertain";
  reviewMarkdown?: string;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = 2_000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 必须是非空字符串`);
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${field} 最多 ${max} 字符`);
  return normalized;
}

function optionalText(value: unknown, field: string, max = 2_000): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, field, max);
}

function integer(value: unknown, field: string, min: number, max: number): number {
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new WorkflowInputValidationError(`${field} 必须是 ${min}–${max} 的整数`);
  }
  return parsed;
}

function enumValue<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${field} 必须是 ${allowed.join(" | ")}`);
  }
  return value as T;
}

function safeJobId(value: string): string {
  if (!/^nai-set-[a-f0-9]{32}$/.test(value)) throw new Error("NovelAI image-set jobId 无效");
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function ownerFromContext(ctx: ToolContext): ImageSetOwner {
  const actor = ctx.source?.actor;
  const key = String(ctx.source?.key ?? "").trim();
  const channel = String(ctx.source?.channel ?? "").trim();
  if (!ctx.agent.name.startsWith("main-") && ctx.agent.name !== "novelai_artist") {
    throw new Error("novelai-image-set 只允许已授权 Main 或 Workflow 插画节点执行");
  }
  if (!actor || actor.role !== "owner" || !key || !channel) {
    throw new Error("novelai-image-set 只接受带可信 owner 身份与会话来源的交互任务");
  }
  return {
    ownerKey: `${actor.platform}:${actor.id}:${key}`,
    channel,
    key,
    actorId: actor.id,
    ...(ctx.source?.sessionId ? { sessionId: ctx.source.sessionId } : {}),
  };
}

function workflowKey(rawSet: Record<string, unknown>, ctx: ToolContext): string {
  const explicit = typeof rawSet.workflowKey === "string" ? rawSet.workflowKey.trim() : "";
  if (explicit) return text(explicit, "set.workflowKey", 240);
  if (ctx.execution?.runId) return `run:${ctx.execution.runId}`;
  return `plan:${hash(rawSet)}`;
}

export async function compileImageSet(raw: unknown, ctx: ToolContext, options: { promptOnly?: boolean; graphRoot?: string; expectedCostAnlas?: number; reviewBeforeGenerate?: boolean } = {}): Promise<CompiledImageSetPlan> {
  try { return await compileImageSetPlan(raw, ctx, options); }
  catch (error) {
    if (error instanceof WorkflowInputValidationError && error.code.startsWith("novelai_reference_")) throw error;
    // Nothing has been persisted/submitted yet. Let the author correct a field,
    // rather than reporting an unknown paid execution and losing its draft.
    throw new WorkflowInputValidationError(error instanceof Error ? error.message : String(error));
  }
}

async function compileImageItem(generation: NovelAiComposeInput, count: number, ctx: ToolContext, key: string, index: number) {
  try { return await compileNovelAiGeneration(generation, count, ctx, key); }
  catch (error) {
    if (error instanceof WorkflowInputValidationError && error.code.startsWith("novelai_reference_")) {
      throw new WorkflowInputValidationError(`/set/items/${index}/generation: ${error.message}`, error.code,
        error.nextActions, error.jobId, error.details);
    }
    throw error;
  }
}

async function compileImageSetPlan(raw: unknown, ctx: ToolContext, options: { promptOnly?: boolean; graphRoot?: string; expectedCostAnlas?: number; reviewBeforeGenerate?: boolean } = {}): Promise<CompiledImageSetPlan> {
  const set = object(raw, "input.set");
  if (isMultiPanelComicRequest(JSON.stringify(set))) throw new Error(MULTI_PANEL_COMIC_ROUTE_REASON);

  const mode = enumValue(set.mode, "set.mode", ["single", "variants", "independent"] as const);
  const title = text(set.title, "set.title", 200);
  const contentRating = set.contentRating === undefined
    ? "sfw"
    : enumValue(set.contentRating, "set.contentRating", ["sfw", "nsfw"] as const);
  const nsfwAuthorized = Number(set.nsfwAuthorized ?? 0) === 1 ? 1 as const : 0 as const;
  if (contentRating === "nsfw" && (!nsfwAuthorized || ctx.source?.actor?.role !== "owner")) {
    throw new Error("novelai-image-set: nsfw 任务缺少可信 owner 的 nsfwAuthorized=1");
  }

  const budget = object(set.budget ?? {}, "set.budget");
  const budgetSource = enumValue(
    budget.source ?? (budget.maxTotalAnlas === undefined ? "auto" : "explicit"),
    "set.budget.source",
    ["auto", "explicit", "owner-standing-1-to-2"] as const,
  );
  if (!Array.isArray(set.items)) throw new Error("set.items 必须是数组");

  const groups: CompiledImageSetPlan["groups"] = [];
  let totalImages = 0;
  if (mode === "variants" || mode === "single") {
    if (set.items.length !== 1) throw new Error("variants 模式必须且只能提供 1 个冻结构图");
    const count = mode === "single" ? integer(set.count ?? 1, "set.count", 1, 1) : integer(set.count, "set.count", 2, MAX_IMAGES);
    const item = object(set.items[0], "set.items[0]");
    const itemTitle = text(item.title, "set.items[0].title", 200);
    const caption = optionalText(item.caption, "set.items[0].caption");
    const generation = object(item.generation, "set.items[0].generation") as unknown as NovelAiComposeInput;
    if (generation.numberOfImages !== undefined && generation.numberOfImages !== 1 && generation.numberOfImages !== count) {
      throw new Error("variants 模式的 generation.numberOfImages 必须省略、为 1，或与 set.count 一致");
    }
    let remaining = count;
    let batchIndex = 1;
    while (remaining > 0) {
      const batchSize = Math.min(4, remaining);
      const request = await compileImageItem(generation, batchSize, ctx, workflowKey(set, ctx), 0);
      groups.push({
        index: groups.length + 1,
        itemIndex: 1,
        batchIndex,
        title: itemTitle,
        ...(caption ? { caption } : {}),
        expectedImages: batchSize,
        novelAiRequest: request,
      });
      remaining -= batchSize;
      batchIndex += 1;
    }
    totalImages = count;
  } else {
    if (set.items.length < 2 || set.items.length > MAX_IMAGES) {
      throw new Error(`independent 模式必须提供 2–${MAX_IMAGES} 个不同冻结构图`);
    }
    if (set.count !== undefined && integer(set.count, "set.count", 2, MAX_IMAGES) !== set.items.length) {
      throw new Error("independent 模式的 count 必须与 items 数量一致");
    }
    for (let index = 0; index < set.items.length; index += 1) {
      const item = object(set.items[index], `set.items[${index}]`);
      const generation = object(item.generation, `set.items[${index}].generation`) as unknown as NovelAiComposeInput;
      if (generation.numberOfImages !== undefined && generation.numberOfImages !== 1) {
        throw new Error(`set.items[${index}].generation.numberOfImages 必须为 1；不同构图由不同 item 表示`);
      }
      const request = await compileImageItem(generation, 1, ctx, workflowKey(set, ctx), index);
      const caption = optionalText(item.caption, `set.items[${index}].caption`);
      groups.push({
        index: index + 1,
        itemIndex: index + 1,
        batchIndex: 1,
        title: text(item.title, `set.items[${index}].title`, 200),
        ...(caption ? { caption } : {}),
        expectedImages: 1,
        novelAiRequest: request,
      });
    }
    const ids = groups.map((group) => String(group.novelAiRequest.bundleId));
    if (new Set(ids).size !== ids.length) {
      throw new Error("independent 模式含重复冻结构图；同构图随机采样应改用 variants 模式");
    }
    totalImages = groups.length;
  }

  const policy = await planNovelAiBudget(groups.map(group => ({ request: group.novelAiRequest, count: group.expectedImages })),
    options.promptOnly ? 0 : ctx.execution?.novelAiPolicy?.maxTotalAnlas ?? budget.maxTotalAnlas,
    { ...options, reviewBeforeGenerate: !options.promptOnly && (ctx.execution?.novelAiPolicy?.reviewBeforeGenerate ?? options.reviewBeforeGenerate) });
  return {
    title,
    mode,
    contentRating,
    nsfwAuthorized,
    totalImages,
    budget: { source: budgetSource === "owner-standing-1-to-2" ? budgetSource : policy.plan.source, maxTotalAnlas: policy.maxTotalAnlas, plan: policy.plan },
    ...(!options.promptOnly && policy.waiting ? { waitingFor: policy.waiting } : {}),
    groups,
  };
}

async function atomicWrite(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_JOB_BYTES) throw new Error("NovelAI image-set job 超过 4MB 状态上限");
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temp, body, { flag: "wx" });
  try {
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}

class ImageSetJobStore {
  private readonly jobDir: string;
  private readonly now: () => Date;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(config: NovelAiImageSetWorkflowConfig) {
    this.jobDir = path.resolve(config.jobDir);
    this.now = config.now ?? (() => new Date());
  }

  private file(id: string): string {
    return path.join(this.jobDir, `${safeJobId(id)}.json`);
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

  id(owner: ImageSetOwner, key: string): string {
    const scope = owner.sessionId ? `${owner.ownerKey}\0session:${owner.sessionId}` : owner.ownerKey;
    return `nai-set-${createHash("sha256").update(`${scope}\0${key}`).digest("hex").slice(0, 32)}`;
  }

  private async readUnchecked(id: string): Promise<ImageSetJob> {
    const raw = await fs.readFile(this.file(id), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error(`未知 NovelAI image-set job：${id}`);
      throw error;
    });
    const parsed = JSON.parse(raw) as ImageSetJob;
    if (parsed.schemaVersion !== 1 || parsed.id !== id || !Array.isArray(parsed.groups)) {
      throw new Error(`NovelAI image-set job「${id}」结构无效`);
    }
    return parsed;
  }

  private assertOwner(job: ImageSetJob, owner: ImageSetOwner): void {
    if (job.ownerKey !== owner.ownerKey || (job.source.sessionId && job.source.sessionId !== owner.sessionId)) {
      throw new Error("NovelAI image-set job 不属于当前可信会话/主人；请回到原会话继续");
    }
  }

  private async save(job: ImageSetJob): Promise<void> {
    job.revision += 1;
    job.updatedAt = this.now().toISOString();
    await atomicWrite(this.file(job.id), job);
  }

  async create(owner: ImageSetOwner, key: string, plan: CompiledImageSetPlan): Promise<ImageSetJob> {
    const id = this.id(owner, key);
    const planHash = hash(plan);
    return this.withLock(id, async () => {
      const existing = await this.readUnchecked(id).catch((error: Error) => {
        if (/^未知 NovelAI image-set job：/.test(error.message)) return undefined;
        throw error;
      });
      if (existing) {
        this.assertOwner(existing, owner);
        if (existing.planHash !== planHash) {
          throw new WorkflowInputValidationError(`同一 workflowKey 已绑定不同图片集计划；原 Job=${existing.id}。先 status 核对；resume 续原稿，revise_group 修改未提交画面，不能重新 start 绕过账本。`,
            "plan_conflict", [{ name: "novelai-generation", action: "status", input: { jobId: existing.id } }], existing.id);
        }
        return existing;
      }
      const now = this.now().toISOString();
      const job: ImageSetJob = {
        schemaVersion: 1,
        id,
        workflowKey: key,
        planHash,
        ownerKey: owner.ownerKey,
        source: { channel: owner.channel, key: owner.key, actorId: owner.actorId,
          ...(owner.sessionId ? { sessionId: owner.sessionId } : {}) },
        title: plan.title,
        mode: plan.mode,
        contentRating: plan.contentRating,
        nsfwAuthorized: plan.nsfwAuthorized,
        status: plan.waitingFor ? "paused" : "planned",
        ...(plan.waitingFor ? { waitingFor: plan.waitingFor } : {}),
        totalImages: plan.totalImages,
        budget: { ...plan.budget, visibleSpentAnlas: 0, uncertainReservedAnlas: 0 },
        groups: plan.groups.map((group) => ({
          ...group,
          status: "pending",
          attempts: 0,
          visibleCostAnlas: 0,
        })),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      await atomicWrite(this.file(id), job);
      return job;
    });
  }

  async get(owner: ImageSetOwner, id: string): Promise<ImageSetJob> {
    const job = await this.readUnchecked(safeJobId(id));
    this.assertOwner(job, owner);
    return job;
  }

  async recoverInterrupted(owner: ImageSetOwner, id: string): Promise<ImageSetJob> {
    return this.withLock(safeJobId(id), async () => {
      const job = await this.readUnchecked(id);
      this.assertOwner(job, owner);
      if (job.status === "completed" || job.status === "aborted") return job;
      const group = job.groups.find((candidate) => candidate.status === "running");
      if (!group) return job;
      group.status = "blocked";
      group.blocked = {
        stage: "interrupted",
        reason: "上次进程在 Browser 回执落盘前中断，无法证明 Generate 是否提交。",
        retrySafety: "uncertain",
      };
      job.budget.uncertainReservedAnlas += group.reservationAnlas ?? remainingBudget(job);
      job.status = "blocked";
      await this.save(job);
      return job;
    });
  }

  async claim(owner: ImageSetOwner, id: string): Promise<ImageSetGroup | undefined> {
    return this.withLock(safeJobId(id), async () => {
      const job = await this.readUnchecked(id);
      this.assertOwner(job, owner);
      if (["paused", "blocked", "completed", "aborted"].includes(job.status)) return undefined;
      if (job.groups.some((group) => group.status === "running")) {
        throw new Error("NovelAI image-set 有未恢复的运行组；先执行 resume/status");
      }
      const group = job.groups.find((candidate) => candidate.status === "pending" || candidate.status === "rendered");
      if (!group) {
        if (job.groups.every((candidate) => candidate.status === "completed")) {
          job.status = "completed";
          await this.save(job);
        }
        return undefined;
      }
      if (group.status === "pending") {
        const pricing = novelAiUnitPricingWait(job.budget.plan, group.index - 1);
        if (pricing) {
          job.waitingFor = pricing;
          job.status = "paused";
          await this.save(job);
          return undefined;
        }
        group.status = "running";
        group.attempts += 1;
        group.reservationAnlas = unitBudget(job.budget.plan, group.index - 1, remainingBudget(job), 26, group.expectedImages).maxCostAnlas;
        delete group.blocked;
      }
      job.status = "running";
      await this.save(job);
      return structuredClone(group);
    });
  }

  async rendered(owner: ImageSetOwner, id: string, groupIndex: number, attempt: number, input: {
    rawArtifacts: string[];
    visibleCostAnlas: number;
    uncertainReservedAnlas: number;
    chargeState: BrowserControllerResult["chargeState"];
  }): Promise<ImageSetJob> {
    return this.withLock(safeJobId(id), async () => {
      const job = await this.readUnchecked(id);
      this.assertOwner(job, owner);
      const group = job.groups[groupIndex - 1];
      if (!group || group.status !== "running" || group.attempts !== attempt) {
        throw new Error("NovelAI image-set group claim 无效或已过期");
      }
      if (input.rawArtifacts.length !== group.expectedImages) {
        throw new Error(`第 ${groupIndex} 组应回收 ${group.expectedImages} 张，实际 ${input.rawArtifacts.length} 张`);
      }
      group.status = "rendered";
      group.rawArtifacts = input.rawArtifacts;
      group.visibleCostAnlas += input.visibleCostAnlas;
      group.chargeState = input.chargeState;
      delete group.blocked;
      job.budget.visibleSpentAnlas += input.visibleCostAnlas;
      job.budget.uncertainReservedAnlas += input.uncertainReservedAnlas;
      await this.save(job);
      return job;
    });
  }

  async complete(owner: ImageSetOwner, id: string, groupIndex: number, attempt: number,
    artifacts: PublishedNovelAiArtifact[]): Promise<ImageSetJob> {
    return this.withLock(safeJobId(id), async () => {
      const job = await this.readUnchecked(id);
      this.assertOwner(job, owner);
      const group = job.groups[groupIndex - 1];
      if (!group || group.status !== "rendered" || group.attempts !== attempt) {
        throw new Error("NovelAI image-set 尚无持久化的原图回执，不能标记完成");
      }
      if (artifacts.length !== group.expectedImages) {
        throw new Error(`第 ${groupIndex} 组应交付 ${group.expectedImages} 张，实际 ${artifacts.length} 张`);
      }
      group.status = "completed";
      group.artifacts = artifacts;
      delete group.blocked;
      if (job.status !== "aborted") {
        job.status = job.groups.every((candidate) => candidate.status === "completed") ? "completed" : "running";
      }
      await this.save(job);
      return job;
    });
  }

  async block(owner: ImageSetOwner, id: string, groupIndex: number, attempt: number, input: {
    stage: string;
    reason: string;
    retrySafety: "safe" | "uncertain";
    visibleCostAnlas?: number;
    uncertainReservedAnlas?: number;
    chargeState?: BrowserControllerResult["chargeState"];
    rawArtifacts?: string[];
    partialArtifacts?: PublishedNovelAiArtifact[];
    promptBudgetOverflow?: import("../novelAiPromptBudget").NovelAiPromptBudgetOverflowReport;
  }): Promise<ImageSetJob> {
    return this.withLock(safeJobId(id), async () => {
      const job = await this.readUnchecked(id);
      this.assertOwner(job, owner);
      const group = job.groups[groupIndex - 1];
      if (!group || !["running", "rendered"].includes(group.status) || group.attempts !== attempt) {
        throw new Error("NovelAI image-set group claim 无效或已过期");
      }
      const visibleCost = input.visibleCostAnlas ?? 0;
      group.status = "blocked";
      group.visibleCostAnlas += visibleCost;
      if (input.chargeState) group.chargeState = input.chargeState;
      group.blocked = {
        stage: text(input.stage, "blocked.stage", 120),
        reason: text(input.reason, "blocked.reason", 4_000),
        retrySafety: input.retrySafety,
        ...(input.rawArtifacts?.length ? { rawArtifacts: input.rawArtifacts } : {}),
        ...(input.partialArtifacts?.length ? { partialArtifacts: input.partialArtifacts } : {}),
        ...(input.promptBudgetOverflow ? { promptBudgetOverflow: structuredClone(input.promptBudgetOverflow) } : {}),
      };
      job.budget.visibleSpentAnlas += visibleCost;
      job.budget.uncertainReservedAnlas += input.uncertainReservedAnlas ?? 0;
      if (job.status !== "aborted") job.status = "blocked";
      await this.save(job);
      return job;
    });
  }

  async resume(owner: ImageSetOwner, id: string, input: {
    forceUncertainRetry: boolean;
    maxTotalAnlas?: number;
    approve?: boolean;
    expectedRevision?: number;
    maxUnitAnlas?: number;
  }): Promise<ImageSetJob> {
    return this.withLock(safeJobId(id), async () => {
      const job = await this.readUnchecked(id);
      this.assertOwner(job, owner);
      if (job.status === "completed" || job.status === "aborted") return job;
      if (input.expectedRevision !== undefined && input.expectedRevision !== job.revision) throw new WorkflowInputValidationError(`Job revision 已变化：current=${job.revision}；先 status`, "revision_conflict");
      const invalidPrompt = job.groups.find(group => group.status === "blocked" && group.blocked?.stage === "prompt-budget");
      if (invalidPrompt) throw new WorkflowInputValidationError(
        `第 ${invalidPrompt.index} 组冻结 Prompt 已经网页实测超限；先用 revise_group 修改提示词，再 resume。原文重跑、仅改尺寸或 forceUncertainRetry 不能解决内容超限，未启动 Browser。`,
        "prompt_change_required");
      const pricing = !job.waitingFor && nextImagePricingWait(job);
      if (pricing) {
        job.waitingFor = pricing;
        if (input.maxUnitAnlas === undefined) {
          job.status = "paused";
          await this.save(job);
          return job;
        }
      }
      approveWaiting(job.waitingFor, input, job.revision);
      updateBudgetCeiling(job.budget, input.maxTotalAnlas);
      if (input.maxTotalAnlas !== undefined) job.budget.source = "explicit";
      authorizeNovelAiUnitBudget(job.budget.plan, pendingImageGenerationIndices(job), job.waitingFor, input.maxUnitAnlas);
      if (job.waitingFor?.kind === "pricing" && input.maxUnitAnlas === undefined) throw new WorkflowInputValidationError("未知估价需显式 maxUnitAnlas", "pricing_required");
      const shortfall = reviewBudgetShortfall(job.waitingFor, job.budget,
        job.groups.flatMap((group, index) => group.status !== "completed" && !group.rawArtifacts?.length ? [index] : []));
      if (shortfall) {
        job.waitingFor = shortfall; job.status = "paused";
        await this.save(job);
        return job;
      }
      const group = job.groups.find((candidate) => candidate.status === "blocked");
      // 组间停止、或已持久化原图但导入前进程退出：没有新的付费副作用，可以直接续跑。
      if (!group?.blocked && !job.groups.some((candidate) => candidate.status === "running")) {
        job.status = "planned";
        delete job.waitingFor;
        await this.save(job);
        return job;
      }
      if (!group?.blocked) throw new Error("NovelAI image-set 有未恢复的 Browser 运行组");
      const importOnly = group.blocked.stage === "artifact-delivery" && !!group.rawArtifacts?.length;
      if (!importOnly && group.blocked.retrySafety === "uncertain" && !input.forceUncertainRetry) {
        throw new Error("上次提交/扣费状态不确定；只有显式 forceUncertainRetry=true 才能再次 Generate");
      }
      if (!importOnly && group.blocked.partialArtifacts?.length) {
        throw new Error("已有部分成品成功导入；为避免重复生成整批，不能自动重放，请先人工处理该 blocked job");
      }
      group.status = importOnly ? "rendered" : "pending";
      delete group.blocked;
      job.status = "planned";
      delete job.waitingFor;
      await this.save(job);
      return job;
    });
  }

  async pause(owner: ImageSetOwner, id: string): Promise<ImageSetJob> {
    return this.withLock(safeJobId(id), async () => {
      const job = await this.readUnchecked(id);
      this.assertOwner(job, owner);
      if (["completed", "aborted", "blocked"].includes(job.status)) return job;
      if (job.groups.some(group => group.status === "running")) throw new Error("运行中需先等待原子步骤回执再暂停");
      job.status = "paused";
      await this.save(job);
      return job;
    });
  }

  async reviseGroup(owner: ImageSetOwner, id: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ImageSetJob> {
    const allowed = new Set(["jobId", "group", "expectedRevision", "generation", "resolution"]);
    if (Object.keys(input).some(key => !allowed.has(key)) || (input.generation !== undefined) === (input.resolution !== undefined)) throw new WorkflowInputValidationError("revise_group 接受 jobId/group/expectedRevision，以及 generation 或仅改尺寸的 resolution（二选一）；保存后单独 resume，不隐式生成。");
    const groupIndex = integer(input.group, "group", 1, MAX_IMAGES);
    const revision = integer(input.expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER);
    return this.withLock(safeJobId(id), async () => {
      const job = await this.readUnchecked(id);
      this.assertOwner(job, owner);
      if (job.revision !== revision) throw new WorkflowInputValidationError(`Job revision 已变化：current=${job.revision}；先 status`, "revision_conflict");
      if (["completed", "aborted", "running"].includes(job.status) || job.groups.some(group => group.status === "running")) throw new WorkflowInputValidationError("先暂停正在执行的 Job；完成/终止任务不能改稿。", "revision_not_available");
      const group = job.groups[groupIndex - 1];
      if (!group || ["completed", "rendered", "running"].includes(group.status) || group.rawArtifacts?.length || group.artifacts?.length ||
        (group.attempts > 0 && (group.blocked?.retrySafety !== "safe" || group.chargeState !== "not_charged" || group.visibleCostAnlas !== 0)) || job.budget.uncertainReservedAnlas > 0) {
        throw new WorkflowInputValidationError("只能修订未提交或已证实未扣费的画面；已有成品/原图/未知提交先核对，不覆盖或重画。", "revision_requires_reconciliation");
      }
      let request: Record<string, unknown>;
      try {
        if (input.resolution !== undefined) request = resizeFrozenNovelAiGeneration(group.novelAiRequest, input.resolution);
        else {
        const generation = object(input.generation, "generation") as unknown as NovelAiComposeInput;
        if (generation.numberOfImages !== undefined && generation.numberOfImages !== group.expectedImages) throw new Error("修订不能改变本组张数");
        request = await compileNovelAiGeneration(generation, group.expectedImages, ctx, job.workflowKey);
        }
      } catch (error) {
        if (error instanceof WorkflowInputValidationError && error.code.startsWith("novelai_reference_")) {
          throw new WorkflowInputValidationError(`group ${groupIndex}: ${error.message}`, error.code,
            error.nextActions, error.jobId, error.details);
        }
        throw new WorkflowInputValidationError((error as Error).message);
      }
      if (group.blocked?.stage === "prompt-budget") {
        const previousKey = novelAiPromptContentKey(group.novelAiRequest);
        const replacementKey = novelAiPromptContentKey(request);
        if (input.resolution !== undefined || previousKey && replacementKey && previousKey === replacementKey) {
          throw new WorkflowInputValidationError("冻结 Prompt 已经实测超限；revise_group 必须修改提示词，不能仅改尺寸或重新保存相同内容。原超限记录和账本保持不变。", "prompt_change_required");
        }
        if (!previousKey || !replacementKey) throw new WorkflowInputValidationError(
          "无法核验超限稿件的完整冻结模型和提示词；先补齐可核验的改稿，不能用缺失字段清除超限记录。", "prompt_change_required");
      }
      await refreshNovelAiBudgetUnit(job.budget.plan, group.index - 1, request, group.expectedImages);
      group.novelAiRequest = request;
      group.status = "pending";
      delete group.blocked;
      job.status = "paused";
      job.waitingFor = novelAiUnitPricingWait(job.budget.plan, group.index - 1)
        ?? { kind: "review", reason: "此组画面已修订并重新估价；已完成画面与总账本未变，核对后 resume。" };
      await this.save(job);
      return job;
    });
  }

  async editPrompt(owner: ImageSetOwner, id: string, action: string, input: Record<string, unknown>) {
    return this.withLock(safeJobId(id), async () => {
      const job = await this.readUnchecked(id);
      this.assertOwner(job, owner);
      const unit = frozenPromptUnit(input, job.groups.length);
      const edit = await frozenPrompt(action, input, imagePromptTarget(job, unit));
      if (!edit.request) return { job, result: edit.result };
      // Text alone changes: preserve reference bytes, price authorizations,
      // completed siblings, attempt history and every recorded charge.
      const group = job.groups[unit - 1]!;
      group.novelAiRequest = edit.request;
      group.status = "pending";
      delete group.blocked;
      job.status = "paused";
      job.waitingFor ??= { kind: "review", reason: "本张提示词已精简，沿用原预算与进度继续。" };
      await this.save(job);
      const remainingOverflow = job.groups.filter(item => item.status === "blocked")
        .map(item => frozenPromptRecoveryAction(imagePromptTarget(job, item.index))).find(Boolean);
      return { job, result: { ...edit.result, saved: true, expectedRevision: job.revision,
        nextAction: remainingOverflow ?? { name: "novelai-generation", action: "resume", input: { approve: true, expectedRevision: job.revision } } } };
    });
  }

  async abort(owner: ImageSetOwner, id: string, reason: string): Promise<ImageSetJob> {
    return this.withLock(safeJobId(id), async () => {
      const job = await this.readUnchecked(id);
      this.assertOwner(job, owner);
      if (job.status === "completed") return job;
      job.status = "aborted";
      job.abortedReason = text(reason, "input.reason", 1_000);
      await this.save(job);
      return job;
    });
  }
}

function browserTask(job: ImageSetJob, group: ImageSetGroup, remainingBudgetAnlas: number): string {
  const onceKey = `nai-set:${job.id}:group:${group.index}:attempt:${group.attempts}`;
  const dimensions = novelAiGenerationDimensions(group.novelAiRequest);
  const form = object(group.novelAiRequest.browserForm, "novelAiRequest.browserForm");
  const characterNames = Array.isArray(form.characterNames) ? form.characterNames.map(String) : [];
  const payload = {
    kind: "novelai-image-set",
    jobId: job.id,
    mode: job.mode,
    group: group.index,
    item: group.itemIndex,
    batch: group.batchIndex,
    onceKey,
    nsfwAuthorized: job.nsfwAuthorized,
    remainingBudgetAnlas,
    expectedImages: group.expectedImages,
    title: group.title,
    novelAiRequest: group.novelAiRequest,
  };
  return [
    "在 NovelAI 完成且只完成这一组非漫画插画。输入已由 novelai-image-set Workflow 冻结，不得改写构图、角色卡或张数。",
    "先核对页面显示的整组真实成本；若超过 remainingBudgetAnlas，在 Generate 前返回 blocked/not_charged。",
    "Generate 只允许按 onceKey 提交一次；必须收齐目标分辨率原图，预览缩略图不算成品。",
    `resolution: ${group.novelAiRequest.resolution} ${dimensions.width}x${dimensions.height}`,
    `NOVELAI_IMAGE_SET ${JSON.stringify(payload)}`,
    `onceKey: ${onceKey}`,
    ...characterNames.map((name, index) => `Character ${index + 1} — ${name.replace(/[\r\n]/g, " ")}`),
  ].join("\n");
}

function remainingBudget(job: ImageSetJob): number {
  return Math.max(0, job.budget.maxTotalAnlas - job.budget.visibleSpentAnlas - job.budget.uncertainReservedAnlas);
}


function deliveryMarkdown(job: ImageSetJob): string {
  const lines: string[] = [];
  let imageNumber = 0;
  for (const group of job.groups) {
    for (const artifact of group.artifacts ?? []) {
      imageNumber += 1;
      const suffix = job.totalImages > 1 ? ` · ${imageNumber}/${job.totalImages}` : "";
      const title = markdownText(group.title.replace(/[\r\n]+/g, " "));
      lines.push(`### ${title}${suffix}`);
      if (group.caption) lines.push(markdownText(group.caption));
      lines.push(`![第 ${imageNumber} 张](${artifact.url})`, "");
    }
  }
  return lines.join("\n").trim();
}

function markdownText(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+!|])/g, "\\$1")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\//g, "&#47;");
}

function summary(job: ImageSetJob): Record<string, unknown> {
  const completed = job.groups.reduce((count, group) => count + (group.artifacts?.length ?? 0), 0);
  const blocked = job.groups.find((group) => group.status === "blocked");
  const promptRecovery = blocked && frozenPromptRecoveryAction(imagePromptTarget(job, blocked.index));
  const waitingFor = targetedNovelAiPricingWait(job.budget.plan, pendingImageGenerationIndices(job), job.waitingFor) ?? nextImagePricingWait(job);
  return {
    jobId: job.id,
    planHash: job.planHash,
    title: job.title,
    mode: job.mode,
    status: job.status,
    completed,
    ...(completed > 0 ? { visualReview: "not_performed" } : {}),
    total: job.totalImages,
    revision: job.revision,
    visibleSpentAnlas: job.budget.visibleSpentAnlas,
    uncertainReservedAnlas: job.budget.uncertainReservedAnlas,
    maxTotalAnlas: job.budget.maxTotalAnlas,
    ...(job.budget.plan ? { budgetEstimate: { source: job.budget.plan.source, estimatedTotalAnlas: job.budget.plan.estimatedTotalAnlas,
      tolerancePercent: job.budget.plan.tolerancePercent } } : {}),
    ...(waitingFor ? { status: "needs_input", reason: waitingFor.reason, waitingFor: waitingFor.kind, retrySafety: "safe",
      ...(waitingFor.kind === "pricing" ? { reasonCode: "pricing_required", pricingUnit: waitingFor.unit,
        remainingBudgetAnlas: remainingBudget(job), unitBudgetLimitAnlas: waitingFor.unit === undefined ? undefined : job.budget.plan?.units[waitingFor.unit - 1]?.maxCostAnlas,
        maxUnitAnlasRequired: true } : {}),
      nextAction: { name: "novelai-generation", action: "resume", input: { kind: "image", jobId: job.id, approve: true, expectedRevision: job.revision } },
      planPreview: job.groups.map(group => ({ title: group.title, caption: group.caption, count: group.expectedImages })),
      reviewMarkdown: novelAiReviewMarkdown(job.title, undefined, job.groups.map(group => ({ title: group.title, text: group.caption || `本组 ${group.expectedImages} 张` }))),
    } : {}),
    ...(!waitingFor && blocked?.blocked ? {
      group: blocked.index,
      stage: blocked.blocked.stage,
      reason: blocked.blocked.reason,
      retrySafety: blocked.blocked.retrySafety,
      ...(blocked.blocked.stage === "prompt-budget" ? { requiredAction: "revise_group" } : {}),
      ...(promptRecovery ? { promptRecovery } : {}),
    } : {}),
  };
}

function remember(job: ImageSetJob, ctx: ToolContext, reason?: string): void {
  if (!ctx.runState) return;
  const markdown = deliveryMarkdown(job);
  const blocked = job.groups.find((group) => group.status === "blocked")?.blocked;
  const waitingFor = targetedNovelAiPricingWait(job.budget.plan, pendingImageGenerationIndices(job), job.waitingFor) ?? nextImagePricingWait(job);
  ctx.runState.set(DELIVERY_STATE_KEY, {
    status: waitingFor ? "needs_input" : job.status,
    jobId: job.id,
    title: job.title,
    visibleSpentAnlas: job.budget.visibleSpentAnlas,
    maxTotalAnlas: job.budget.maxTotalAnlas,
    uncertainReservedAnlas: job.budget.uncertainReservedAnlas,
    totalImages: job.totalImages,
    ...(markdown ? { deliveryMarkdown: markdown } : {}),
    urls: job.groups.flatMap((group) => group.artifacts?.map((artifact) => artifact.url) ?? []),
    ...((reason || waitingFor?.reason || blocked?.reason) ? { reason: reason || waitingFor?.reason || blocked?.reason } : {}),
    ...(waitingFor ? { retrySafety: "safe" } : blocked ? { retrySafety: blocked.retrySafety } : {}),
    ...(waitingFor ? { reviewMarkdown: String(summary(job).reviewMarkdown) } : {}),
  } satisfies ImageSetDeliveryRecord);
}

async function completedResult(job: ImageSetJob, ctx: ToolContext, publish = true): Promise<Record<string, unknown>> {
  remember(job, ctx);
  const result = {
    ...summary(job),
    status: "completed",
    terminal: true,
    deliveryMarkdown: deliveryMarkdown(job),
    deliveryUrls: job.groups.flatMap((group) => group.artifacts?.map((artifact) => artifact.url) ?? []),
  };
  if (publish) await publishWorkflowJobSnapshot(ctx, "novelai-image-set", result);
  return result;
}

async function terminalResult(job: ImageSetJob, ctx: ToolContext, reason?: string, publish = true): Promise<Record<string, unknown>> {
  if (job.status === "completed") return completedResult(job, ctx, publish);
  const receipt = promptRecoverySummary(summary(job), ctx);
  if (publish) await publishWorkflowJobSnapshot(ctx, "novelai-image-set", receipt);
  if ((job.status === "planned" || job.status === "running") && !job.waitingFor && !nextImagePricingWait(job)) return { ...receipt, terminal: false };
  remember(job, ctx, reason);
  const markdown = deliveryMarkdown(job);
  return {
    ...receipt, terminal: receipt.requiredAction !== "inspect_prompt", ...(reason ? { reason } : {}),
    ...(markdown ? { deliveryMarkdown: markdown, deliveryUrls: job.groups.flatMap(group => group.artifacts?.map(artifact => artifact.url) ?? []) } : {}),
  };
}

async function runRemaining(
  store: ImageSetJobStore,
  config: NovelAiImageSetWorkflowConfig,
  owner: ImageSetOwner,
  jobId: string,
  expectedCostAnlas: number,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const inputRevision = ctx.execution?.inputBoundary?.revision;
  while (true) {
    if (ctx.execution?.inputBoundary?.hasPending || ctx.execution?.inputBoundary?.revision !== inputRevision) {
      return { ...await terminalResult(await store.pause(owner, jobId), ctx, "已在图片组持久化边界让出，等待主对话处理补充；沿用原 Job 和账本。"), nextAction: "handle_pending_input" };
    }
    let job = await store.get(owner, jobId);
    await publishWorkflowJobSnapshot(ctx, "novelai-image-set", summary(job));
    if (["completed", "paused", "blocked", "aborted"].includes(job.status)) return terminalResult(job, ctx);
    if (ctx.signal?.aborted) return terminalResult(await store.pause(owner, jobId), ctx, "运行已取消，已在图片组边界暂停");
    const group = await store.claim(owner, jobId);
    if (!group) return terminalResult(await store.get(owner, jobId), ctx);
    job = await store.get(owner, jobId);
    await publishWorkflowJobSnapshot(ctx, "novelai-image-set", summary(job));
    const quote = unitBudget(job.budget.plan, group.index - 1, remainingBudget(job), expectedCostAnlas, group.expectedImages);
    const task = browserTask(job, group, quote.maxCostAnlas);
    const result = await runNovelAiGenerationUnit({
      request: group.novelAiRequest,
      accountReservations: config.accountReservations,
      task, expectedCostAnlas: job.budget.maxTotalAnlas === 0 ? 0 : quote.estimatedAnlas / group.expectedImages, runBrowser: config.runBrowser,
      submission: { onceKey: `nai-set:${job.id}:group:${group.index}:attempt:${group.attempts}`,
        maxCostAnlas: quote.maxCostAnlas, numberOfImages: group.expectedImages },
      ...(group.status === "rendered" ? { rendered: {
        rawArtifacts: group.rawArtifacts ?? [], visibleCostAnlas: group.visibleCostAnlas,
        uncertainReservedAnlas: job.budget.uncertainReservedAnlas, chargeState: group.chargeState ?? "unknown",
      } } : {}),
      saveRendered: async receipt => {
        job = await store.rendered(owner, jobId, group.index, group.attempts, receipt);
        await publishWorkflowJobSnapshot(ctx, "novelai-image-set", summary(job));
      },
      importArtifacts: paths => config.publishArtifacts ? config.publishArtifacts(task, paths)
        : publishNovelAiArtifacts(task, paths, { preserveSources: true, idempotencyKey: `${job.id}:${group.index}:${group.attempts}` }),
    }, ctx);
    if (result.status === "blocked") {
      const receipt = result.receipt;
      const blocked = await store.block(owner, jobId, group.index, group.attempts, {
        stage: result.stage, reason: result.reason, retrySafety: result.retrySafety,
        ...(result.promptBudgetOverflow ? { promptBudgetOverflow: result.promptBudgetOverflow } : {}),
        ...(receipt ? { rawArtifacts: receipt.rawArtifacts } : {}),
        ...(result.partialArtifacts?.length ? { partialArtifacts: result.partialArtifacts } : {}),
        ...(!result.rendered && receipt ? {
          visibleCostAnlas: receipt.visibleCostAnlas, uncertainReservedAnlas: receipt.uncertainReservedAnlas,
          chargeState: receipt.chargeState,
        } : {}),
      });
      if (receipt && !result.rendered) await config.accountReservations?.settle(
        `nai-set:${job.id}:group:${group.index}:attempt:${group.attempts}`, receipt.chargeState,
        receipt.uncertainReservedAnlas ? undefined : receipt.visibleCostAnlas);
      return terminalResult(blocked, ctx, result.reason);
    }
    job = await store.complete(owner, jobId, group.index, group.attempts, result.artifacts);
    await publishWorkflowJobSnapshot(ctx, "novelai-image-set", summary(job));
    if (!config.publishArtifacts) await discardPublishedNovelAiSources(result.receipt.rawArtifacts);
  }
}

/** Main 不需重新编排结果；统一输出确定性逐图交付，避免漏图、重图或反序。 */
export function preserveNovelAiImageSetDelivery(
  answer: string,
  ctx: { agent: { name: string }; runState?: Map<string, unknown> },
): string {
  if (!ctx.agent.name.startsWith("main-")) return answer;
  const raw = ctx.runState?.get(DELIVERY_STATE_KEY);
  if (!raw || typeof raw !== "object") return answer;
  const record = raw as ImageSetDeliveryRecord;
  const cost = `页面可见成本：${record.visibleSpentAnlas} Anlas。`
    + (record.maxTotalAnlas !== undefined ? `总预算上限：${record.maxTotalAnlas} Anlas。` : "")
    + (record.uncertainReservedAnlas ? `另有 ${record.uncertainReservedAnlas} Anlas 待核对预留（非确认扣费）。` : "");
  if (record.status === "completed" && record.deliveryMarkdown && record.urls?.length) {
    return `${markdownText(record.title)} 已完成，共 ${record.totalImages} 张。${cost}\n\n${record.deliveryMarkdown}`;
  }
  if (["blocked", "needs_input", "paused"].includes(record.status) && (record.reason || record.status === "paused")) {
    return `图片集 Workflow 已在 job ${record.jobId} 停住：${markdownText(record.reason || "任务已暂停，继续时沿用已保存进度。") }\n${cost}`
      + (record.reviewMarkdown ? `\n\n${record.reviewMarkdown}` : "")
      + (record.deliveryMarkdown ? `\n\n以下为已完成部分（${record.urls?.length ?? 0}/${record.totalImages}）：\n\n${record.deliveryMarkdown}` : "");
  }
  return answer;
}

/** 非漫画多图的轻量执行器：创作内容来自 novelai-art，代码只管分组与副作用。 */
export function createNovelAiImageSetWorkflowExecutor(
  config: NovelAiImageSetWorkflowConfig,
): WorkflowExecutor {
  const store = new ImageSetJobStore(config);
  const activeJobs = new Map<string, AbortController>();
  async function withActiveJob(
    owner: ImageSetOwner, jobId: string, ctx: ToolContext, work: (activeCtx: ToolContext) => Promise<unknown>,
  ): Promise<unknown> {
    if (activeJobs.has(jobId)) return terminalResult(await store.get(owner, jobId), ctx);
    const controller = new AbortController();
    const abort = () => controller.abort(ctx.signal?.reason);
    if (ctx.signal?.aborted) abort();
    else ctx.signal?.addEventListener("abort", abort, { once: true });
    activeJobs.set(jobId, controller);
    try {
      return await work({ ...ctx, signal: controller.signal });
    } finally {
      ctx.signal?.removeEventListener("abort", abort);
      activeJobs.delete(jobId);
    }
  }
  return {
    id: "novelai-image-set",
    async execute(invocation: WorkflowInvocation, ctx: ToolContext) {
      const owner = ownerFromContext(ctx);
      if (invocation.action === "start") {
        const rawSet = invocation.input.set as Record<string, unknown>;
        const expectedCostAnlas = integer(
          invocation.input.expectedCostAnlas ?? 26,
          "input.expectedCostAnlas",
          0,
          10_000,
        );
        const plan = await compileImageSet(rawSet, ctx, { graphRoot: config.graphRoot,
          ...(invocation.input.expectedCostAnlas !== undefined ? { expectedCostAnlas } : {}),
          reviewBeforeGenerate: invocation.input.reviewBeforeGenerate === true });
        const job = await store.create(owner, workflowKey(rawSet, ctx), plan);
        await publishWorkflowJobSnapshot(ctx, "novelai-image-set", summary(job));
        return withActiveJob(owner, job.id, ctx, async (activeCtx) => {
          const recovered = await store.recoverInterrupted(owner, job.id);
          if (recovered.status === "blocked") return terminalResult(recovered, ctx);
          return runRemaining(store, config, owner, job.id, expectedCostAnlas, activeCtx);
        });
      }

      const jobId = text(invocation.input.jobId, "input.jobId", 80);
      // Observation is not execution. The outer boundary may refresh an already
      // bound task, but merely inspecting another Job never creates that binding.
      if (invocation.action === "status") return terminalResult(await store.get(owner, jobId), ctx, undefined, false);
      if (["inspect_prompt", "revise_prompt"].includes(invocation.action)) {
        await assertFrozenPromptAuthor(ctx, "image", jobId);
        if (activeJobs.has(jobId)) throw new WorkflowInputValidationError("任务仍在执行，不能同时改稿。", "workflow_busy");
        const edit = await store.editPrompt(owner, jobId, invocation.action, invocation.input);
        if (edit.result.saved) await publishWorkflowJobSnapshot(ctx, "novelai-image-set", summary(edit.job));
        return edit.result;
      }
      if (invocation.action === "revise_group") {
        await store.get(owner, jobId); // ownership before reporting activity
        if (activeJobs.has(jobId)) throw new WorkflowInputValidationError("任务仍在执行；先 pause，再 status 确认已暂停后改稿。", "workflow_busy");
        return withActiveJob(owner, jobId, ctx, async () => terminalResult(await store.reviseGroup(owner, jobId, invocation.input, ctx), ctx));
      }
      if (invocation.action === "abort") {
        const reason = optionalText(invocation.input.reason, "input.reason", 1_000)
          ?? "用户终止 novelai-image-set Workflow";
        const aborted = await store.abort(owner, jobId, reason);
        activeJobs.get(jobId)?.abort(new Error(reason));
        return terminalResult(aborted, ctx);
      }
      if (invocation.action === "pause") {
        const current = await store.get(owner, jobId);
        activeJobs.get(jobId)?.abort(new Error("用户暂停 Workflow"));
        if (activeJobs.has(jobId)) return { ...summary(current), pauseRequested: true, terminal: false };
        return terminalResult(await store.pause(owner, jobId), ctx);
      }
      if (invocation.action === "resume") {
        const expectedCostAnlas = integer(
          invocation.input.expectedCostAnlas ?? 26,
          "input.expectedCostAnlas",
          0,
          10_000,
        );
        return withActiveJob(owner, jobId, ctx, async (activeCtx) => {
          const recovered = await store.recoverInterrupted(owner, jobId);
          await publishWorkflowJobSnapshot(ctx, "novelai-image-set", summary(recovered));
          const resumed = await store.resume(owner, jobId, {
            forceUncertainRetry: invocation.input.forceUncertainRetry === true,
            approve: invocation.input.approve === true,
            ...(invocation.input.expectedRevision !== undefined ? { expectedRevision: integer(invocation.input.expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER) } : {}),
            ...(invocation.input.maxUnitAnlas !== undefined ? { maxUnitAnlas: anlasLimit(invocation.input.maxUnitAnlas, "maxUnitAnlas") } : {}),
            ...(invocation.input.maxTotalAnlas === undefined
              ? {}
              : { maxTotalAnlas: anlasLimit(invocation.input.maxTotalAnlas) }),
          });
          if (resumed.status === "completed" || resumed.status === "aborted") return terminalResult(resumed, ctx);
          return runRemaining(store, config, owner, jobId, expectedCostAnlas, activeCtx);
        });
      }
      throw new Error(`novelai-image-set 不支持 action=${invocation.action}`);
    },
  };
}
