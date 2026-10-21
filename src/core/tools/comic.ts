import path from "node:path";
import type { ExecutionReasonCode, ToolContext, ToolDef } from "../../types";
import { comicDeliveryMarkdown, composeComicJob } from "../comics/comicComposer";
import { ComicJobStore, type ComicOwner } from "../comics/comicJobStore";
import { COMIC_ANGLES, COMIC_CONTENT_RATINGS, COMIC_SHOTS, COMIC_TRANSITIONS, type ComicJob } from "../comics/comicTypes";

export interface ComicToolsConfig {
  store: ComicJobStore;
  uploadDir: string;
}

const AUTHORITATIVE_COMIC_DELIVERY_KEY = "comic:authoritative-delivery";
const LATEST_COMIC_OUTCOME_KEY = "comic:latest-outcome";

interface ComicOutcomeRecord {
  agent: "comic_generator";
  status: string;
  terminal: boolean;
  authoritative?: boolean;
  /** Presentation facts restored from an earlier checkpoint attempt, not a new stop. */
  restoredFromCheckpoint?: boolean;
  jobId?: string;
  completed?: number;
  total?: number;
  visibleSpentAnlas?: number;
  maxTotalAnlas?: number;
  uncertainReservedAnlas?: number;
  retrySafety?: string;
  partialDeliveryMarkdown?: string;
  partialDeliveryUrls?: string[];
  reviewMarkdown?: string;
  reason?: string;
  reasonCode?: ExecutionReasonCode;
  delegateInvoked?: boolean;
  nextAction?: { reason?: string };
  result: string;
}

export interface ComicDeliveryRecord {
  jobId: string;
  title: string;
  total: number;
  visibleSpentAnlas: number;
  markdown: string;
  urls: string[];
  canonical: string;
}

/** 从合法完成回执中提取逐幕交付；Panel URL 不能把损坏 JSON 升格成完成证据。 */
export function parseComicSubagentDelivery(result: string): ComicDeliveryRecord | undefined {
  const marker = result.match(/^COMIC_COMPLETE\s+(\{[^\r\n]*\})\s*$/m);
  if (!marker?.[1]) return undefined;
  let meta: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(marker[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    meta = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const images = [...result.matchAll(/!\[[^\]]*\]\((\/uploads\/comics\/[^)\s]+\/panels\/[^)\s]+)\)/g)]
    .map((match) => match[1]!)
    .filter((url, index, all) => all.indexOf(url) === index);
  if (!images.length) return undefined;
  const body = result.slice((marker.index ?? 0) + marker[0].length).trim();
  const titleMatch = body.match(/^###\s+第\s*1\s*幕\s*·\s*(.+)$/m);
  return {
    jobId: String(meta.jobId ?? ""),
    title: String(meta.title ?? titleMatch?.[1]?.trim() ?? "漫画"),
    total: Number(meta.total ?? images.length),
    visibleSpentAnlas: Number(meta.visibleSpentAnlas ?? 0),
    markdown: body.replace(/\n\n本次页面可见成本：[\s\S]*$/u, "").trim(),
    urls: images,
    canonical: result,
  };
}

/** 同一 Main run 内完成态只读复用，防止模型为“再确认”重复派导演。 */
export function rememberedComicDelivery(runState?: Map<string, unknown>): ComicDeliveryRecord | undefined {
  const raw = runState?.get(AUTHORITATIVE_COMIC_DELIVERY_KEY);
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as ComicDeliveryRecord;
  return record.jobId && record.urls?.length && record.markdown ? record : undefined;
}

function completionRecord(job: ComicJob): ComicDeliveryRecord {
  if (!job.artifacts?.scenes?.length) throw new Error("漫画已完成但缺少逐幕交付索引");
  const markdown = comicDeliveryMarkdown(job.artifacts.scenes);
  const marker = `COMIC_COMPLETE ${JSON.stringify({
    jobId: job.id,
    title: job.title,
    completed: job.panels.length,
    total: job.panels.length,
    visibleSpentAnlas: job.budget.visibleSpentAnlas,
    visualReview: "not_performed",
  })}`;
  const cost = `本次页面可见成本：${job.budget.visibleSpentAnlas} Anlas。归档文件保存在漫画项目中，不进入聊天交付。`;
  return {
    jobId: job.id,
    title: job.title,
    total: job.panels.length,
    visibleSpentAnlas: job.budget.visibleSpentAnlas,
    markdown,
    urls: job.artifacts.scenes.map((scene) => scene.image.url),
    canonical: `${marker}\n\n${markdown}\n\n${cost}`,
  };
}

/** Workflow 完成后写入同一条确定性交付通道，避免导演或 Main 漏掉某一幕。 */
export function rememberCompletedComicJob(job: ComicJob, runState?: Map<string, unknown>): string {
  const delivery = completionRecord(job);
  runState?.set(AUTHORITATIVE_COMIC_DELIVERY_KEY, delivery);
  return delivery.canonical;
}

export function rememberedComicOutcome(runState?: Map<string, unknown>): ComicOutcomeRecord | undefined {
  return runState?.get(LATEST_COMIC_OUTCOME_KEY) as ComicOutcomeRecord | undefined;
}

/** 新回执可以更新同一 job；无 job 的追问不能抹掉执行器已确认的持久化事实。 */
export function rememberComicSubagentOutcome(
  result: unknown,
  runState?: Map<string, unknown>,
  options?: { fromCheckpointReplay?: boolean },
): void {
  if (!runState || !result || typeof result !== "object") return;
  const record = result as Partial<ComicOutcomeRecord>;
  if (record.agent !== "comic_generator" || typeof record.status !== "string" || typeof record.result !== "string") return;
  const previous = rememberedComicOutcome(runState);
  if (previous?.authoritative && previous.jobId && !record.jobId) return;
  if (options?.fromCheckpointReplay && previous?.authoritative && !previous.restoredFromCheckpoint && previous.jobId === record.jobId) return;
  runState.set(LATEST_COMIC_OUTCOME_KEY, { ...record, restoredFromCheckpoint: options?.fromCheckpointReplay === true });
  if (record.status === "completed") rememberComicSubagentDelivery(record.result, runState);
}

function preserveComicOutcome(answer: string, ctx: { agent: { name: string }; runState?: Map<string, unknown> }): string {
  if (!ctx.agent.name.startsWith("main-")) return answer;
  const outcome = rememberedComicOutcome(ctx.runState);
  if (!outcome?.terminal || (outcome.status !== "needs_input" && outcome.status !== "blocked" &&
      !(outcome.authoritative && (outcome.status === "aborted" || outcome.status === "unknown")))) return answer;
  const reason = typeof outcome.reason === "string" && outcome.reason.trim()
    ? outcome.reason.trim()
    : typeof outcome.nextAction?.reason === "string" ? outcome.nextAction.reason.trim()
      : outcome.status === "aborted" ? "任务已终止，不会自动重放。"
        : outcome.status === "unknown" ? "执行状态未知，不会自动重放。" : "";
  if (!reason) return answer;
  // 只保证转述，不执行 nextAction、不推断未扣费，也不把内容拒绝改成重试建议。
  const lines = [`${outcome.status === "needs_input" ? "漫画需要补充输入" : outcome.status === "aborted" ? "漫画任务已终止" : "漫画任务已停住"}：\n\n${reason}`];
  if (outcome.authoritative && outcome.jobId) {
    if (outcome.reviewMarkdown?.trim()) lines.unshift(outcome.reviewMarkdown.trim());
    lines.push(`任务：${outcome.jobId}。`);
    if (outcome.completed !== undefined && outcome.total !== undefined) lines.push(`已完成 ${outcome.completed}/${outcome.total} 格；其余未完成。`);
    if (outcome.visibleSpentAnlas !== undefined) lines.push(`已确认页面消费：${outcome.visibleSpentAnlas} Anlas${outcome.maxTotalAnlas !== undefined ? `；总授权上限 ${outcome.maxTotalAnlas} Anlas` : ""}。`);
    if (outcome.retrySafety === "uncertain") lines.push("未完成操作的提交/扣费状态未知；上述消费不是最终总额，不会自动重试或重新生成。");
    if (outcome.uncertainReservedAnlas !== undefined) lines.push(`未知扣费预留：${outcome.uncertainReservedAnlas} Anlas。`);
    if (outcome.partialDeliveryMarkdown?.trim()) {
      return `${outcome.partialDeliveryMarkdown.trim()}\n\n以上为已保存的部分成图（不是完整漫画）。\n\n${lines.join("\n\n")}`;
    }
  }
  return lines.join("\n\n");
}

/** 子 Agent 的最终自然语言不再决定漫画能否完整交付。 */
export function preserveComicDelivery(
  answer: string,
  ctx: { agent: { name: string }; runState?: Map<string, unknown> }
): string {
  const raw = ctx.runState?.get(AUTHORITATIVE_COMIC_DELIVERY_KEY);
  if (!raw || typeof raw !== "object") return preserveComicOutcome(answer, ctx);
  const record = raw as ComicDeliveryRecord;
  if (!record.urls?.length || !record.markdown) return preserveComicOutcome(answer, ctx);

  if (ctx.agent.name === "comic_generator") return record.canonical;
  if (!ctx.agent.name.startsWith("main-")) return answer;
  // 完成态直接采用确定性幕序；即使 Main 自己也提到了全部 URL，也不能允许它把
  // 六段文字和六张图重新分组，或再次退化成只发合成长页。
  // 渠道将每张图之前的文字绑定到该图；完成总结只能放在全部幕之后。
  return `${record.markdown}\n\n漫画已完成，共 ${record.total} 幕。本次页面可见成本：${record.visibleSpentAnlas} Anlas。`;
}

/** 把 comic_generator 的确定性交付继续带回 Main 的 runState，防止 Main 漏发部分 Panel。 */
export function rememberComicSubagentDelivery(result: string, runState?: Map<string, unknown>): void {
  if (!runState) return;
  const record = parseComicSubagentDelivery(result);
  if (record) runState.set(AUTHORITATIVE_COMIC_DELIVERY_KEY, record);
}

/** Workflow 复用此领域 schema；不再为导演维护第二份 Panel/Bible 契约。 */
export const comicJobCreateSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    workflowKey: { type: "string", minLength: 0, maxLength: 240 },
    premise: { type: "string", minLength: 1, maxLength: 2_000 },
    contentRating: { type: "string", enum: [...COMIC_CONTENT_RATINGS] },
    nsfwAuthorized: { type: "integer", minimum: 0, maximum: 1 },
    readingDirection: { type: "string", enum: ["ltr", "rtl"] },
    // Store 会把空白语言归一化为 zh-CN；schema 不应在 handler 之前拒绝它。
    language: { type: "string", minLength: 0, maxLength: 80 },
    batchSize: { type: "integer", minimum: 1, maximum: 3 },
    layout: {
      type: "object",
      additionalProperties: false,
      properties: {
        columns: { type: "integer", minimum: 1, maximum: 3 },
        panelsPerPage: { type: "integer", minimum: 1, maximum: 6 },
      },
    },
    budget: {
      type: "object",
      additionalProperties: false,
      properties: { maxTotalAnlas: { type: "number", minimum: 0, maximum: 1_000_000 } },
      required: ["maxTotalAnlas"],
    },
    bible: {
      type: "object",
      additionalProperties: false,
      properties: {
        style: { type: "string", minLength: 1, maxLength: 1_000 },
        renderStyle: { type: "string", minLength: 1, maxLength: 500,
          description: "Optional English prompt-ready shared art style. Inherited only when a new panel omits generation.style; an explicit panel style replaces it. Do not copy template module wording here. Existing frozen requests are never changed." },
        palette: { type: "string", minLength: 1, maxLength: 500 },
        lighting: { type: "string", minLength: 1, maxLength: 500 },
        aspectRatio: { type: "string", enum: ["portrait", "landscape", "square"],
          description: "Use square by default, just like ordinary images. Only an explicit user size/aspect request selects portrait or landscape; dialogue and page layout do not determine image shape." },
        characters: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string", minLength: 1, maxLength: 120 },
              role: { type: "string", minLength: 1, maxLength: 160 },
              appearance: { type: "string", minLength: 1, maxLength: 1_000 },
              initialWardrobe: { type: "string", minLength: 1, maxLength: 1_000 },
              // 可选文本允许模型用空串表达“没有”，Store 会省略该字段。
              referenceQuery: { type: "string", minLength: 0, maxLength: 160 },
            },
            required: ["name", "role", "appearance", "initialWardrobe"],
          },
        },
        locations: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string", minLength: 1, maxLength: 160 },
              visualAnchors: { type: "string", minLength: 1, maxLength: 1_000 },
            },
            required: ["name", "visualAnchors"],
          },
        },
      },
      required: ["style", "palette", "lighting", "aspectRatio", "characters", "locations"],
    },
    panels: {
      type: "array",
      minItems: 2,
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          number: { type: "integer", minimum: 1, maximum: 24 },
          beat: { type: "string", minLength: 1, maxLength: 500 },
          transition: { type: "string", enum: [...COMIC_TRANSITIONS] },
          shot: { type: "string", enum: [...COMIC_SHOTS] },
          angle: { type: "string", enum: [...COMIC_ANGLES] },
          focalPoint: { type: "string", minLength: 1, maxLength: 500 },
          action: { type: "string", minLength: 1, maxLength: 1_000 },
          emotion: { type: "string", minLength: 1, maxLength: 500 },
          visualDescription: { type: "string", minLength: 1, maxLength: 2_000 },
          // 两项都不是 required。模型常用空串表达“本格没有该字段”，而 Store
          // 本来也会把空串归一化为 undefined；schema 应与真实领域契约一致。
          caption: { type: "string", minLength: 0, maxLength: 240 },
          narration: { type: "string", minLength: 0, maxLength: 500 },
          title: { type: "string", minLength: 0, maxLength: 240, description: "caption 的兼容别名；两者冲突则拒绝" },
          text: { type: "string", minLength: 0, maxLength: 500, description: "narration 的兼容别名；两者冲突则拒绝" },
          dialogue: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                // 一整条全空占位会由 Store 丢弃；半空对白仍会被 Store 拒绝。
                speaker: { type: "string", minLength: 0, maxLength: 80 },
                text: { type: "string", minLength: 0, maxLength: 300 },
              },
              required: ["speaker", "text"],
            },
          },
          characters: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 120 } },
          continuity: {
            type: "object",
            additionalProperties: false,
            properties: {
              location: { type: "string", minLength: 1, maxLength: 200 },
              time: { type: "string", minLength: 1, maxLength: 120 },
              axis: { type: "string", minLength: 1, maxLength: 300 },
              screenDirection: { type: "string", minLength: 1, maxLength: 120 },
              characterStates: {
                type: "object",
                additionalProperties: { type: "string", minLength: 1, maxLength: 800 },
              },
              props: { type: "array", maxItems: 24, items: { type: "string", minLength: 1, maxLength: 200 } },
              intentionalAxisBreak: { type: "string", minLength: 0, maxLength: 500 },
            },
            required: ["location", "time", "axis", "screenDirection", "characterStates", "props"],
          },
          emphasis: { type: "integer", minimum: 1, maximum: 3 },
        },
        required: [
          "number", "beat", "transition", "shot", "angle", "focalPoint", "action", "emotion",
          "visualDescription", "dialogue", "characters", "continuity", "emphasis",
        ],
      },
    },
  },
  required: [
    "title", "premise", "contentRating", "readingDirection", "language", "batchSize",
    "layout", "budget", "bible", "panels",
  ],
} as const;

export function comicOwnerFromContext(ctx: ToolContext): ComicOwner {
  const actor = ctx.source?.actor;
  const key = String(ctx.source?.key ?? "").trim();
  const channel = String(ctx.source?.channel ?? "").trim();
  const generationWorkflow = ctx.agent.workflows?.some(workflow =>
    workflow.name === "novelai-generation" && workflow.executor === "novelai-generation");
  // The registered generation Workflow owns the same source-isolated jobs when
  // Main calls status/resume directly. This does not mount comic tools on Main.
  if (ctx.agent.name !== "comic_generator" && !generationWorkflow) {
    throw new Error("comic 操作只允许固定 comic_generator 或已挂载 novelai-generation 的 Agent 使用");
  }
  if (!actor || actor.role !== "owner" || !key || !channel) {
    throw new Error("comic 工具只接受带可信 owner 身份与会话来源的交互任务");
  }
  return {
    ownerKey: `${actor.platform}:${actor.id}:${key}`,
    channel,
    key,
    actorId: actor.id,
    ...(ctx.source?.sessionId ? { sessionId: ctx.source.sessionId } : {}),
  };
}

function summary(job: ComicJob): Record<string, unknown> {
  const completed = job.panels.filter((panel) => panel.status === "completed").length;
  const blocked = job.panels.find((panel) => panel.status === "blocked");
  return {
    jobId: job.id,
    title: job.title,
    status: job.status,
    completed,
    total: job.panels.length,
    remaining: job.panels.length - completed,
    visibleSpentAnlas: job.budget.visibleSpentAnlas,
    maxTotalAnlas: job.budget.maxTotalAnlas,
    revision: job.revision,
    ...(blocked ? { blockedPanel: blocked.number, blocked: blocked.blocked } : {}),
    ...(job.artifacts ? {
      artifacts: {
        archivedPageCount: job.artifacts.pages.length,
        manifestCreated: true,
        exposedToChat: false,
        sceneCount: job.artifacts.scenes?.length ?? 0,
      },
    } : {}),
  };
}

export function createComicTools(config: ComicToolsConfig): ToolDef[] {
  const comicJob: ToolDef = {
    name: "comic_job",
    description:
      "管理 comic_generator 的持久化漫画任务。create 保存完整分镜；next_batch 只领取最多 3 格；record_panel 从 Harbour 浏览器受控输出目录导入成功图片；block_panel 记录失败；resume/pause/abort/status 提供恢复与终止。禁止把任意本地路径当图片导入。",
    timeoutMs: 180_000,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "status", "next_batch", "record_panel", "block_panel", "resume", "pause", "abort"],
        },
        job: {
          ...comicJobCreateSchema,
          description: "create 使用的完整视觉圣经、连续编号 Panels、排版与总 Anlas 预算",
        },
        jobId: { type: "string" },
        expectedRevision: {
          type: "integer",
          minimum: 1,
          description: "从上一条 comic_job/COMIC_* 回执原样带回；防止 checkpoint 恢复时误领旧批次",
        },
        panelNumber: { type: "integer" },
        claimId: { type: "string" },
        sourcePath: { type: "string", description: "browser_controller 返回的受控绝对图片路径；不能自己猜路径" },
        visibleCostAnlas: {
          type: "number",
          minimum: 0,
          description: "本次工具边界新发生的页面可见成本。blocked 后选择既有候选时 record_panel 传 0，避免重复记账。",
        },
        novelAiRequest: {
          type: "object",
          description: "本格完整冻结参数；付费 Panel 必填，不能只存长度/数量摘要",
          properties: {
            bundleId: { type: "string", pattern: "^[a-f0-9]{20}$" },
            model: { type: "string", minLength: 1 },
            mode: { type: "string", minLength: 1 },
            resolution: { type: "string", minLength: 1 },
            browserForm: {
              type: "object",
              properties: {
                characters: { type: "array", minItems: 1, maxItems: 6, items: { type: "string", enum: ["female", "male", "other"] } },
                characterNames: { type: "array", minItems: 1, maxItems: 6, items: { type: "string", minLength: 1 } },
                orientation: { type: "string", enum: ["landscape", "portrait", "square"] },
                numberOfImages: { type: "integer", minimum: 1, maximum: 4 },
                basePrompt: { type: "string", minLength: 1 },
                undesiredPrompt: { type: "string", minLength: 1 },
                characterPrompts: { type: "array", minItems: 1, maxItems: 6, items: { type: "string", minLength: 1 } },
                characterUndesiredPrompts: { type: "array", minItems: 1, maxItems: 6, items: { type: "string", minLength: 1 } },
              },
              required: ["characters", "characterNames", "orientation", "numberOfImages", "basePrompt", "undesiredPrompt", "characterPrompts", "characterUndesiredPrompts"],
            },
          },
          required: ["bundleId", "model", "mode", "resolution", "browserForm"],
        },
        stage: { type: "string" },
        evidence: { type: "string" },
        retrySafety: { type: "string", enum: ["safe", "uncertain"] },
        forceUncertainRetry: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["action"],
    },
    async execute(args, ctx) {
      const owner = comicOwnerFromContext(ctx);
      const action = String(args.action ?? "");
      if (action === "create") {
        const job = await config.store.create(owner, args.job);
        return { ...summary(job), next: `comic_job next_batch ${job.id}` };
      }
      const jobId = String(args.jobId ?? "").trim();
      if (!jobId) throw new Error(`comic_job ${action} 缺少 jobId`);
      if (action === "status") {
        const job = await config.store.get(owner, jobId);
        const expectedRevision = args.expectedRevision === undefined ? undefined : Number(args.expectedRevision);
        return {
          ...summary(job),
          ...(expectedRevision !== undefined && expectedRevision !== job.revision
            ? { expectationMismatch: { expectedRevision, currentRevision: job.revision } }
            : {}),
        };
      }
      if (action === "next_batch") {
        const expectedRevision = args.expectedRevision === undefined ? undefined : Number(args.expectedRevision);
        const claimed = await config.store.claimNextBatch(owner, jobId, expectedRevision);
        return {
          ...summary(claimed.job),
          claimId: claimed.claimId,
          bible: claimed.job.bible,
          readingDirection: claimed.job.readingDirection,
          contentRating: claimed.job.contentRating,
          remainingBudgetAnlas: claimed.job.budget.maxTotalAnlas - claimed.job.budget.visibleSpentAnlas,
          panels: claimed.panels,
        };
      }
      if (action === "record_panel") {
        const novelAiRequest = args.novelAiRequest && typeof args.novelAiRequest === "object" && !Array.isArray(args.novelAiRequest)
          ? args.novelAiRequest as Record<string, unknown>
          : undefined;
        const job = await config.store.recordPanel(owner, {
          jobId,
          panelNumber: Number(args.panelNumber),
          claimId: String(args.claimId ?? ""),
          sourcePath: String(args.sourcePath ?? ""),
          visibleCostAnlas: Number(args.visibleCostAnlas ?? 0),
          ...(novelAiRequest ? { novelAiRequest } : {}),
        });
        return summary(job);
      }
      if (action === "block_panel") {
        const retrySafety = args.retrySafety === "safe" ? "safe" : "uncertain";
        const novelAiRequest = args.novelAiRequest && typeof args.novelAiRequest === "object" && !Array.isArray(args.novelAiRequest)
          ? args.novelAiRequest as Record<string, unknown>
          : undefined;
        const job = await config.store.blockPanel(owner, {
          jobId,
          panelNumber: Number(args.panelNumber),
          claimId: String(args.claimId ?? ""),
          stage: String(args.stage ?? "unknown"),
          evidence: String(args.evidence ?? "unknown failure"),
          retrySafety,
          visibleCostAnlas: Number(args.visibleCostAnlas ?? 0),
          ...(novelAiRequest ? { novelAiRequest } : {}),
        });
        return summary(job);
      }
      if (action === "resume") {
        const expectedRevision = args.expectedRevision === undefined ? undefined : Number(args.expectedRevision);
        return summary(await config.store.resume(owner, jobId, args.forceUncertainRetry === true, expectedRevision));
      }
      if (action === "pause") return summary(await config.store.pause(owner, jobId));
      if (action === "abort") return summary(await config.store.abort(owner, jobId, String(args.reason ?? "用户 aborted this comic job")));
      throw new Error(`comic_job action 不受支持：${action}`);
    },
  };

  const comicCompose: ToolDef = {
    name: "comic_compose",
    description:
      "在所有 Panel 已成功后，用本地 Sharp 生成归档分页和 manifest，并确定性返回按顺序绑定标题/对白/单格原图的聊天交付 Markdown。它只处理既有图片，不调用生成模型、不消耗 Anlas。",
    timeoutMs: 5 * 60_000,
    parameters: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
    },
    async execute(args, ctx) {
      const owner = comicOwnerFromContext(ctx);
      const jobId = String(args.jobId ?? "").trim();
      if (!jobId) throw new Error("comic_compose 缺少 jobId");
      const artifacts = await composeComicJob(config.store, owner, jobId, { uploadDir: path.resolve(config.uploadDir) });
      const job = await config.store.get(owner, jobId);
      const delivery = completionRecord(job);
      ctx.runState?.set(AUTHORITATIVE_COMIC_DELIVERY_KEY, delivery);
      return {
        jobId,
        status: "completed",
        completed: job.panels.length,
        total: job.panels.length,
        visibleSpentAnlas: job.budget.visibleSpentAnlas,
        sceneCount: artifacts.scenes.length,
        deliveryMarkdown: delivery.markdown,
        archive: {
          pageCount: artifacts.pages.length,
          manifestCreated: true,
          exposedToChat: false,
        },
      };
    },
  };

  return [comicJob, comicCompose];
}
