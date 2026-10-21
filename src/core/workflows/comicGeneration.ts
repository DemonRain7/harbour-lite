import { createHash } from "node:crypto";
import type { ToolContext } from "../../types";
import { buildComicDeliveryScenes, composeComicJob, comicDeliveryMarkdown } from "../comics/comicComposer";
import { ComicJobStore, normalizeComicBible, normalizeComicJobCreateInput, nextComicPricingWait, comicPromptTarget, type ComicOwner } from "../comics/comicJobStore";
import type { ComicJob, ComicVisualBible } from "../comics/comicTypes";
import { withComicVisualDefaults } from "../comics/comicCanvas";
import { comicCameraIssues } from "../comics/comicCamera";
import type { NovelAiComposeInput } from "../novelAiPromptComposer";
import { comicOwnerFromContext, rememberCompletedComicJob } from "../tools/comic";
import { publishWorkflowJobSnapshot } from "../tools/runWorkflow";
import type { NovelAiBrowserRunner } from "./novelAiBrowserExecution";
import { compileNovelAiGeneration, novelAiGenerationDimensions, resizeFrozenNovelAiGeneration, runNovelAiGenerationUnit } from "./novelAiGenerationUnit";
import { WorkflowInputValidationError, type WorkflowExecutor, type WorkflowInvocation } from "./registry";
import { readWorkflowGraphSettings } from "./workflowGraph";
import { planNovelAiBudget, unitBudget, novelAiReviewMarkdown, anlasLimit, targetedNovelAiPricingWait } from "./novelAiBudget";
import type { NovelAiAccountReservations } from "./novelAiAccountReservations";
import { ComicGenerationInputError, preflightComicGenerationPanel, preflightComicGenerationStart } from "./comicGenerationInput";
import { assertFrozenPromptAuthor, frozenPromptRecoveryAction, promptRecoverySummary } from "./novelAiFrozenPrompt";

export interface ComicGenerationWorkflowConfig {
  store: ComicJobStore;
  uploadDir: string;
  runBrowser?: NovelAiBrowserRunner;
  /** 测试/嵌入式部署的受信配置根，不接受工具输入覆盖。 */
  graphRoot?: string;
  accountReservations?: NovelAiAccountReservations;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 必须是非空字符串`);
  return value.trim();
}

function integer(value: unknown, field: string, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new WorkflowInputValidationError(`${field} 必须是 ${min}–${max} 的整数`);
  }
  return parsed;
}

function summary(job: ComicJob): Record<string, unknown> {
  const completedPanels = job.panels.filter((panel) => panel.status === "completed" && panel.asset);
  const completed = completedPanels.length;
  const blocked = job.panels.find((panel) => panel.status === "blocked");
  const promptRecovery = blocked && frozenPromptRecoveryAction(comicPromptTarget(job, blocked.number));
  // Persist detailed meter evidence for recovery, but do not repeat it on every
  // status response. inspect_prompt projects only the two useful totals.
  const blockedInfo = blocked?.blocked && Object.hasOwn(blocked.blocked, "promptBudgetOverflow")
    ? (({ promptBudgetOverflow: _counts, ...rest }) => rest)(blocked.blocked) : blocked?.blocked;
  const waitingFor = targetedNovelAiPricingWait(job.budget.plan,
    job.panels.flatMap((panel, index) => panel.status !== "completed" && !panel.generationReceipt ? [index] : []),
    job.waitingFor) ?? nextComicPricingWait(job);
  return {
    jobId: job.id,
    status: job.status,
    completed,
    ...(completed ? { visualReview: "not_performed" } : {}),
    total: job.panels.length,
    revision: job.revision,
    visibleSpentAnlas: job.budget.visibleSpentAnlas,
    maxTotalAnlas: job.budget.maxTotalAnlas,
    ...(job.budget.uncertainReservedAnlas ? { uncertainReservedAnlas: job.budget.uncertainReservedAnlas } : {}),
    ...(blocked?.blocked ? { retrySafety: blocked.blocked.retrySafety, reason: blocked.blocked.evidence,
      ...(blocked.blocked.stage === "prompt-budget" ? { requiredAction: "revise_panel" } : {}),
      ...(promptRecovery ? { promptRecovery } : {}) }
      : job.status === "paused" ? { retrySafety: "safe" } : {}),
    ...(completedPanels.length && job.status !== "completed" ? {
      // 部分交付同样绑定本格标题/正文和图片；不能让渠道把进度占位 alt 当成漫画正文。
      partialDeliveryMarkdown: comicDeliveryMarkdown(buildComicDeliveryScenes({ ...job, panels: completedPanels })),
      partialDeliveryUrls: completedPanels.map((panel) => panel.asset!.url),
    } : {}),
    ...(blocked ? { panel: blocked.number, blocked: blockedInfo } : {}),
    ...(job.budget.plan ? { budgetEstimate: { source: job.budget.plan.source, estimatedTotalAnlas: job.budget.plan.estimatedTotalAnlas,
      tolerancePercent: job.budget.plan.tolerancePercent } } : {}),
    ...(waitingFor ? { status: "needs_input", reasonCode: `${waitingFor.kind}_required`,
      reason: waitingFor.reason, retrySafety: "safe", waitingFor: waitingFor.kind,
      ...(waitingFor.kind === "pricing" ? { pricingUnit: waitingFor.unit,
        remainingBudgetAnlas: Math.max(0, job.budget.maxTotalAnlas - job.budget.visibleSpentAnlas - (job.budget.uncertainReservedAnlas ?? 0)),
        unitBudgetLimitAnlas: waitingFor.unit === undefined ? undefined : job.budget.plan?.units[waitingFor.unit - 1]?.maxCostAnlas,
        maxUnitAnlasRequired: true } : {}),
      nextAction: { name: "novelai-generation", action: "resume", input: { kind: "comic", jobId: job.id, approve: true, expectedRevision: job.revision } },
      planPreview: { title: job.title, premise: job.premise, panels: job.panels.map(panel => ({ number: panel.number, title: panel.caption, beat: panel.beat, narration: panel.narration, dialogue: panel.dialogue })) },
      reviewMarkdown: novelAiReviewMarkdown(job.title, job.premise, job.panels.map(panel => ({ title: panel.caption || panel.beat,
        text: [panel.visualDescription, panel.narration, ...panel.dialogue.map(line => `${line.speaker}：${line.text}`)].filter(Boolean).join("\n") }))),
    } : {}),
  };
}

function workflowKey(rawJob: Record<string, unknown>, ctx: ToolContext): string {
  const explicit = typeof rawJob.workflowKey === "string" ? rawJob.workflowKey.trim() : "";
  if (explicit) return explicit;
  if (ctx.execution?.runId) return `run:${ctx.execution.runId}`;
  // 无顶层 runId 的测试/旧调用仍需可重放。相同 owner + 完全相同冻结稿得到同一 job。
  return `plan:${createHash("sha256").update(JSON.stringify(rawJob)).digest("hex")}`;
}

function panelBible(job: ComicJob, panelNumber: number): ComicJob["bible"] {
  const panel = job.panels[panelNumber - 1]!;
  const characterNames = new Set(panel.characters.map((name) => name.toLocaleLowerCase("en-US")));
  const location = panel.continuity.location.toLocaleLowerCase("en-US");
  return {
    ...job.bible,
    characters: job.bible.characters.filter((character) =>
      characterNames.has(character.name.toLocaleLowerCase("en-US"))),
    locations: job.bible.locations.filter((candidate) =>
      candidate.name.toLocaleLowerCase("en-US") === location),
  };
}

async function compilePanel(raw: unknown, index: number, ctx: ToolContext, referenceSelectionKey: string | undefined, bible: ComicVisualBible): Promise<Record<string, unknown>> {
  const panel = object(raw, `job.panels[${index}]`);
  if (panel.novelAiRequest) return panel;
  const generation = object(panel.generation, `job.panels[${index}].generation`) as unknown as NovelAiComposeInput;
  const cameraIssues = comicCameraIssues(panel.angle, generation.camera);
  if (cameraIssues.length) throw new Error(`camera: ${cameraIssues.join("；")}`);
  if (generation.numberOfImages !== undefined && generation.numberOfImages !== 1) {
    throw new Error(`job.panels[${index}].generation.numberOfImages 必须为 1；不同画面是不同 Panel，不是同 batch 变体`);
  }
  const request = await compileNovelAiGeneration(withComicVisualDefaults(generation, bible), 1, ctx, referenceSelectionKey);
  const declaredCharacters = Array.isArray(panel.characters)
    ? panel.characters.map((value) => String(value).trim().toLocaleLowerCase("en-US"))
    : [];
  const formCharacters = (request.browserForm as { characterNames: string[] }).characterNames.map((value) => value.trim().toLocaleLowerCase("en-US"));
  if (declaredCharacters.length !== formCharacters.length ||
      declaredCharacters.some((name) => !formCharacters.includes(name))) {
    throw new Error(`characters: 角色卡必须与 input.job.panels[${index}].characters 一一对应`);
  }
  const { generation: _generation, ...draft } = panel;
  return {
    ...draft,
    novelAiRequest: request,
  };
}

export async function compileJob(raw: unknown, ctx: ToolContext, key: string): Promise<Record<string, unknown>> {
  const job = object(raw, "input.job");
  const contentRating = String(job.contentRating ?? "sfw");
  const authorized = Number(job.nsfwAuthorized ?? 0) === 1;
  if (contentRating === "nsfw" && (!authorized || ctx.source?.actor?.role !== "owner")) {
    throw new Error("comic-generation: nsfw 任务缺少可信 owner 的 nsfwAuthorized=1");
  }
  if (!Array.isArray(job.panels)) throw new Error("input.job.panels 必须是数组");
  const bible = normalizeComicBible(job.bible);
  const panels = [];
  const issues: string[] = [];
  const referencePromptBudgets: Record<string, unknown>[] = [];
  for (let index = 0; index < job.panels.length; index += 1) {
    try {
      panels.push(await compilePanel(job.panels[index], index, ctx, key, bible));
    } catch (error) {
      issues.push(`input.job.panels[${index}].generation.${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof WorkflowInputValidationError && error.details?.referencePromptBudget) {
        referencePromptBudgets.push({ path: `/job/panels/${index}/generation`,
          ...error.details.referencePromptBudget as Record<string, unknown> });
      }
    }
  }
  if (issues.length) throw new ComicGenerationInputError(issues,
    referencePromptBudgets.length ? { referencePromptBudgets } : undefined);
  const compiled = {
    ...job,
    workflowKey: key,
    nsfwAuthorized: authorized ? 1 : 0,
    panels,
  };
  // 最终冻结表单同样经过既有 Store 校验；此处尚未写入任何 Job。
  normalizeComicJobCreateInput(compiled);
  return compiled;
}

function browserTask(job: ComicJob, panelNumber: number, remainingBudgetAnlas: number): string {
  const panel = job.panels[panelNumber - 1]!;
  const payload = {
    kind: "comic-panel",
    jobId: job.id,
    panel: panel.number,
    onceKey: `comic:${job.id}:panel:${panel.number}:attempt:${panel.attempts}`,
    nsfwAuthorized: job.nsfwAuthorized ?? 0,
    remainingBudgetAnlas,
    title: job.title,
    // Browser 只需要本格人物与场景；全书 Bible 仍在 Job/manifest 中，不反复灌入每格上下文。
    visualBible: panelBible(job, panelNumber),
    storyboard: {
      beat: panel.beat,
      shot: panel.shot,
      angle: panel.angle,
      focalPoint: panel.focalPoint,
      action: panel.action,
      emotion: panel.emotion,
      continuity: panel.continuity,
    },
    novelAiRequest: panel.novelAiRequest,
  };
  return [
    "在 NovelAI 完成且只完成这一格漫画。输入已由 comic-generation Workflow 冻结：不得改写角色卡、构图或张数。",
    "先读取页面真实单张成本；若会超过 remainingBudgetAnlas，在点击 Generate 前返回 blocked/not_charged。",
    "Generate 只允许使用 onceKey 提交一次。下载目标分辨率原图并返回单行 BROWSER_RESULT；预览缩略图不算成品。",
    `COMIC_PANEL ${JSON.stringify(payload)}`,
  ].join("\n");
}

/** 从已持久化成品构造完整回执；status 与生成结束共享，不能把完成态降成 partial 正文。 */
function completedResult(job: ComicJob, ctx: ToolContext) {
  const canonical = rememberCompletedComicJob(job, ctx.runState);
  return {
    ...summary(job),
    title: job.title,
    status: "completed",
    terminal: true,
    marker: canonical.split(/\r?\n/, 1)[0],
    deliveryMarkdown: comicDeliveryMarkdown(job.artifacts!.scenes),
    archive: {
      pageCount: job.artifacts!.pages.length,
      manifestCreated: true,
      exposedToChat: false,
    },
  };
}

async function complete(config: ComicGenerationWorkflowConfig, owner: ComicOwner, job: ComicJob, ctx: ToolContext) {
  await composeComicJob(config.store, owner, job.id, { uploadDir: config.uploadDir });
  const saved = await config.store.get(owner, job.id);
  return saved.status === "aborted" ? { ...summary(saved), terminal: true } : completedResult(saved, ctx);
}

async function runRemaining(
  config: ComicGenerationWorkflowConfig,
  owner: ComicOwner,
  jobId: string,
  expectedCostAnlas: number,
  ctx: ToolContext,
) {
  const inputRevision = ctx.execution?.inputBoundary?.revision;
  const shouldYield = () => ctx.execution?.inputBoundary?.hasPending || ctx.execution?.inputBoundary?.revision !== inputRevision;
  while (true) {
    if (shouldYield()) {
      const paused = await config.store.pause(owner, jobId);
      return { ...summary(paused), terminal: true, reason: "已在单格持久化边界让出，等待主对话处理新补充；沿用原 Job 和账本，不重做已完成格。", nextAction: "handle_pending_input" };
    }
    if (ctx.signal?.aborted) {
      const paused = await config.store.pause(owner, jobId);
      return { ...summary(paused), terminal: true, reason: "运行已取消，已在 Panel 边界暂停；不会自动继续。" };
    }
    let job = await config.store.get(owner, jobId);
    await publishWorkflowJobSnapshot(ctx, "comic-generation", summary(job));
    if (job.status === "completed") return complete(config, owner, job, ctx);
    if (job.status === "ready") return complete(config, owner, job, ctx);
    if (job.status === "blocked" || job.status === "paused" || job.status === "aborted") {
      return promptRecoverySummary({ ...summary(job), terminal: true }, ctx);
    }
    const claimed = await config.store.claimNextBatch(owner, jobId, job.revision);
    if (claimed.job.waitingFor) {
      const result = { ...summary(claimed.job), terminal: true };
      await publishWorkflowJobSnapshot(ctx, "comic-generation", result);
      return result;
    }
    if (!claimed.panels.length) return complete(config, owner, claimed.job, ctx);
    if (!claimed.claimId) throw new Error("comic-generation: 领取批次缺少 claimId");

    for (const panel of claimed.panels) {
      if (shouldYield()) {
        const paused = await config.store.pause(owner, jobId);
        return { ...summary(paused), terminal: true, reason: "已保存进度，等待主对话处理补充。", nextAction: "handle_pending_input" };
      }
      job = await config.store.get(owner, jobId);
      await publishWorkflowJobSnapshot(ctx, "comic-generation", summary(job));
      if (ctx.signal?.aborted) {
        const paused = await config.store.pause(owner, jobId);
        return { ...summary(paused), terminal: true, reason: "运行已取消，已在 Panel 边界暂停；不会自动继续。" };
      }
      const remaining = Math.max(0, job.budget.maxTotalAnlas - job.budget.visibleSpentAnlas - (job.budget.uncertainReservedAnlas ?? 0));
      const quote = unitBudget(job.budget.plan, panel.number - 1, remaining, expectedCostAnlas, 1);
      const result = await runNovelAiGenerationUnit({
        request: panel.novelAiRequest,
        accountReservations: config.accountReservations,
        task: browserTask(job, panel.number, quote.maxCostAnlas), expectedCostAnlas: job.budget.maxTotalAnlas === 0 ? 0 : quote.estimatedAnlas, runBrowser: config.runBrowser,
        submission: {
          onceKey: `comic:${job.id}:panel:${panel.number}:attempt:${panel.attempts}`,
          maxCostAnlas: quote.maxCostAnlas,
          numberOfImages: 1,
        },
        rendered: panel.generationReceipt,
        beforeBrowser: () => config.store.markPanelGenerationStarted(owner, {
          jobId, panelNumber: panel.number, claimId: claimed.claimId!, maxCostAnlas: quote.maxCostAnlas,
        }),
        saveRendered: async receipt => {
          const rendered = await config.store.markPanelRendered(owner, {
            jobId, panelNumber: panel.number, claimId: claimed.claimId!, receipt,
          });
          await publishWorkflowJobSnapshot(ctx, "comic-generation", summary(rendered));
        },
        importArtifacts: async paths => {
          const recorded = await config.store.recordPanel(owner, {
            jobId, panelNumber: panel.number, claimId: claimed.claimId!, sourcePath: paths[0]!,
            novelAiRequest: panel.novelAiRequest,
            expectedResolution: novelAiGenerationDimensions(panel.novelAiRequest!),
          });
          return { artifacts: [recorded.panels[panel.number - 1]!.asset!] };
        },
      }, ctx);
      if (result.status === "completed") continue;
      const blocked = await config.store.blockPanel(owner, {
        jobId, panelNumber: panel.number, claimId: claimed.claimId,
        stage: result.stage, evidence: result.reason, retrySafety: result.retrySafety,
        ...(!result.rendered && result.receipt ? {
          visibleCostAnlas: result.receipt.visibleCostAnlas,
          uncertainReservedAnlas: result.receipt.uncertainReservedAnlas,
        } : {}),
        novelAiRequest: panel.novelAiRequest,
        ...(result.promptBudgetOverflow ? { promptBudgetOverflow: result.promptBudgetOverflow } : {}),
      });
      if (result.receipt && !result.rendered) await config.accountReservations?.settle(
        `comic:${job.id}:panel:${panel.number}:attempt:${panel.attempts}`, result.receipt.chargeState,
        result.receipt.uncertainReservedAnlas ? undefined : result.receipt.visibleCostAnlas);
      return promptRecoverySummary({ ...summary(blocked), terminal: true, reason: result.reason, chargeState: result.receipt?.chargeState }, ctx);
    }
  }
}

/** comic-generator 负责创作判断；本 executor 只执行冻结稿与副作用状态机。 */
export function createComicGenerationWorkflowExecutor(
  config: ComicGenerationWorkflowConfig
): WorkflowExecutor {
  const activeJobs = new Map<string, AbortController>();
  const withActiveJob = async (owner: ComicOwner, id: string, ctx: ToolContext,
    work: (active: ToolContext) => Promise<unknown>): Promise<unknown> => {
    if (activeJobs.has(id)) return { ...summary(await config.store.get(owner, id)), terminal: false, executionActive: true };
    const controller = new AbortController();
    const abort = () => controller.abort(ctx.signal?.reason);
    if (ctx.signal?.aborted) abort(); else ctx.signal?.addEventListener("abort", abort, { once: true });
    activeJobs.set(id, controller);
    try { return await work({ ...ctx, signal: controller.signal }); }
    finally { ctx.signal?.removeEventListener("abort", abort); activeJobs.delete(id); }
  };
  return {
    id: "comic-generation",
    async execute(invocation: WorkflowInvocation, ctx: ToolContext) {
      const owner = comicOwnerFromContext(ctx);
      const action = invocation.action;
      if (action === "start") {
        const prepared = preflightComicGenerationStart(invocation.input);
        // 画布默认值只填入新任务省略的字段；JobStore 持久化后，resume 不再读画布。
        if (prepared.job.batchSize === undefined) {
          prepared.job.batchSize = (await readWorkflowGraphSettings("novelai-generation", config.graphRoot)).batchSize;
        }
        // 无 runId 的旧调用仍按原始请求计算幂等键；别名归一化不能制造新 Job。
        const compiled = await compileJob(prepared.job, ctx, workflowKey(object(invocation.input.job, "input.job"), ctx));
        const expectedCostAnlas = prepared.expectedCostAnlas;
        const rawBudget = prepared.job.budget as { maxTotalAnlas?: number } | undefined;
        const policy = await planNovelAiBudget((compiled.panels as ComicJob["panels"]).map(panel => ({ request: panel.novelAiRequest!, count: 1 })),
          ctx.execution?.novelAiPolicy?.maxTotalAnlas ?? rawBudget?.maxTotalAnlas, {
            graphRoot: config.graphRoot,
            ...(invocation.input.expectedCostAnlas !== undefined ? { expectedCostAnlas } : {}),
            reviewBeforeGenerate: ctx.execution?.novelAiPolicy?.reviewBeforeGenerate ?? invocation.input.reviewBeforeGenerate === true,
          });
        compiled.budget = { maxTotalAnlas: policy.maxTotalAnlas };
        const job = await config.store.create(owner, compiled, policy);
        await publishWorkflowJobSnapshot(ctx, "comic-generation", summary(job));
        return withActiveJob(owner, job.id, ctx, active => runRemaining(config, owner, job.id, expectedCostAnlas, active));
      }

      const jobId = string(invocation.input.jobId, "input.jobId");
      if (["inspect_prompt", "revise_prompt"].includes(action)) {
        await assertFrozenPromptAuthor(ctx, "comic", jobId);
        if (activeJobs.has(jobId)) throw new WorkflowInputValidationError("任务仍在执行，不能同时改稿。", "workflow_busy");
        const edit = await config.store.editPrompt(owner, jobId, action, invocation.input);
        if (edit.result.saved) await publishWorkflowJobSnapshot(ctx, "comic-generation", summary(edit.job));
        return edit.result;
      }
      if (action === "status") {
        const job = await config.store.get(owner, jobId);
        // 只读重交付也恢复本轮正式交付记忆；不重新排版、写 Job 或调用 Browser。
        return job.status === "completed" ? completedResult(job, ctx) : promptRecoverySummary({ ...summary(job), terminal: true }, ctx);
      }
      if (action === "abort") {
        const reason = typeof invocation.input.reason === "string" && invocation.input.reason.trim()
          ? invocation.input.reason.trim()
          : "用户终止 comic-generation Workflow";
        const aborted = await config.store.abort(owner, jobId, reason);
        activeJobs.get(jobId)?.abort(new Error(reason));
        return { ...summary(aborted), terminal: true };
      }
      if (action === "pause") {
        const current = await config.store.get(owner, jobId);
        activeJobs.get(jobId)?.abort(new Error("用户暂停 Workflow"));
        // The active loop settles its atomic operation before releasing claims.
        if (activeJobs.has(jobId)) return { ...summary(current), terminal: false, pauseRequested: true };
        return { ...summary(await config.store.pause(owner, jobId)), terminal: true };
      }
      if (action === "resume") {
        const expectedCostAnlas = integer(invocation.input.expectedCostAnlas ?? 26, "input.expectedCostAnlas", 0, 10_000);
        const current = await config.store.get(owner, jobId);
        if (current.status === "completed") return complete(config, owner, current, ctx);
        return withActiveJob(owner, jobId, ctx, async active => {
        const resumed = await config.store.resume(
          owner,
          jobId,
          invocation.input.forceUncertainRetry === true,
          invocation.input.expectedRevision === undefined
            ? undefined
            : integer(invocation.input.expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER),
          { approve: invocation.input.approve === true,
            ...(invocation.input.maxTotalAnlas !== undefined ? { maxTotalAnlas: anlasLimit(invocation.input.maxTotalAnlas) } : {}),
            ...(invocation.input.maxUnitAnlas !== undefined ? { maxUnitAnlas: anlasLimit(invocation.input.maxUnitAnlas, "maxUnitAnlas") } : {}) },
        );
        return runRemaining(config, owner, resumed.id, expectedCostAnlas, active);
        });
      }
      if (action === "revise_panel") {
        return withActiveJob(owner, jobId, ctx, async active => {
        const panelNumber = integer(invocation.input.panelNumber, "panelNumber", 1, 24);
        const expectedCostAnlas = integer(invocation.input.expectedCostAnlas ?? 26, "input.expectedCostAnlas", 0, 10_000);
        const resizeOnly = invocation.input.resolution !== undefined;
        let panel: Record<string, unknown>;
        if (resizeOnly) {
          if (invocation.input.panel !== undefined) throw new WorkflowInputValidationError("panel 与 resolution 二选一；仅改尺寸不需要重写分镜");
          integer(invocation.input.expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER);
          const current = (await config.store.get(owner, jobId)).panels[panelNumber - 1];
          if (!current?.novelAiRequest) throw new WorkflowInputValidationError("此格不存在或没有冻结表单，不能猜测画面");
          panel = { ...current, novelAiRequest: resizeFrozenNovelAiGeneration(current.novelAiRequest, invocation.input.resolution) };
        } else {
          const draft = preflightComicGenerationPanel(invocation.input.panel, panelNumber - 1);
          const current = await config.store.get(owner, jobId);
          panel = await compilePanel(draft, panelNumber - 1, ctx, current.workflowKey, current.bible);
        }
        const revised = await config.store.revisePanel(
          owner,
          jobId,
          panelNumber,
          panel,
          invocation.input.forceRegenerate === true,
          invocation.input.expectedRevision === undefined ? undefined : integer(invocation.input.expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER),
          resizeOnly || invocation.input.execute === false,
        );
        if (resizeOnly || invocation.input.execute === false) return { ...summary(revised), terminal: true };
        return runRemaining(config, owner, revised.id, expectedCostAnlas, active);
        });
      }
      throw new Error(`comic-generation 不支持 action=${action}`);
    },
  };
}
