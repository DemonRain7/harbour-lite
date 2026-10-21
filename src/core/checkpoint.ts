import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "pino";
import type {
  CheckpointController,
  CheckpointToolDecision,
  CheckpointToolRejection,
  RunExecutionContext,
  ToolContext,
  ToolDef,
} from "../types";
import type { ChatSession, CheckpointToolCall, RunCheckpoint, SessionStore } from "./sessionStore";
import { buildCheckpointContext, checkpointRecoveryFacts } from "./checkpointResume";
import { WorkflowInputValidationError } from "./workflows/registry";

/** 单个工具结果的持久化上限。超过时仍记录步骤，但标成不可回放，恢复时安全重跑。 */
const MAX_REPLAY_RESULT_BYTES = 256 * 1024;
const operationScope = new AsyncLocalStorage<string>();
const nativeToolScope = new AsyncLocalStorage<string>();
/** Native IDs come from the provider protocol, never from model-authored arguments. */
export function withNativeToolCall<T>(id: string, execute: () => Promise<T>): Promise<T> {
  return nativeToolScope.run(id, execute);
}
export function currentCheckpointOperationId(): string | undefined {
  return operationScope.getStore();
}

/** Input snapshots belong to one delegation/device, including when no Cowork target is selected. */
export function workflowInputCheckpointScope(ctx: ToolContext): string {
  return `workflow-input:${JSON.stringify([ctx.execution?.cowork?.deviceId ?? "server", ctx.execution?.subagentDelegationId ?? "main"])}`;
}

export interface CheckpointExecutionOptions {
  /** true = 本轮是从 interrupted checkpoint 恢复，可逐个消费既有 completed 结果。 */
  resume: boolean;
}

/**
 * 给顶层 run 和所有子 agent 创建同一条 checkpoint 控制器。
 * 回放按「agent + tool + canonical args」匹配，并逐条消费，故原运行里重复两次的同一调用
 * 仍会对应两条旧结果，不会错误折叠成一次。
 */
export function createCheckpointExecution(
  store: SessionStore,
  session: ChatSession,
  checkpoint: RunCheckpoint,
  logger: Logger,
  options: CheckpointExecutionOptions
): RunExecutionContext {
  const usedReplayIds = new Set<string>();
  const externalIds = new Map<string, string>();

  const active = () => session.checkpoint?.id === checkpoint.id;
  const persist = () => { if (active()) store.touchCheckpoint(session); };
  const findCall = (id: string) => checkpoint.tools.find((c) => c.id === id);

  const controller: CheckpointController = {
    id: checkpoint.id,
    async flush() { if (active()) await store.flushSessionDurably(session); },
    assertExternalSafe(agent, tool, args) {
      const fingerprint = toolFingerprint(agent, tool, args);
      const unknown = checkpoint.tools.find((call) => call.agent === agent && call.fingerprint === fingerprint &&
        call.kind === "external-mcp" && call.status !== "completed");
      if (unknown) throw Object.assign(new Error("此外部 MCP 操作在中断前没有确认结果；先核对原操作状态，禁止直接重新执行。"), { code: "NATIVE_TOOL_OUTCOME_UNKNOWN" });
    },

    recordRecovery(operationId, workflow, snapshot): void {
      if (!active() || !operationId.startsWith(`${checkpoint.id}:`)) return;
      const call = findCall(operationId.slice(checkpoint.id.length + 1));
      if (!call || call.kind !== "harbour" || call.tool !== "run_workflow" || call.args.name !== workflow || call.status === "completed") return;
      const facts = checkpointRecoveryFacts(snapshot);
      if (typeof facts.jobId !== "string") return;
      // 同一 job 的迟到快照不能倒退 revision；无 job 的错误不能擦掉已有引用。
      if (call.recovery?.jobId === facts.jobId && typeof call.recovery.revision === "number"
        && typeof facts.revision === "number" && facts.revision < call.recovery.revision) return;
      if (JSON.stringify(call.recovery) === JSON.stringify(facts)) return;
      call.recovery = facts;
      delete call.rejection;
      persist();
    },

    lookupWorkflowInputPreparation(query) {
      if (!active() || !/^wfi-[a-f0-9]{64}$/.test(query.inputRef)) return;
      // Bound recovery work even if a persisted or in-memory ledger is unexpectedly large.
      if (checkpoint.tools.length > 10_000) throw new Error("Workflow input checkpoint ledger exceeds recovery limit");
      const call = checkpoint.tools.find((candidate) => candidate.kind === "harbour"
        && candidate.status === "completed" && candidate.replayable
        && candidate.agent === query.agent && candidate.tool === "run_workflow" && candidate.scope === query.scope
        && candidate.args?.name === query.workflow && candidate.args?.action === "prepare_input"
        && candidate.result && typeof candidate.result === "object"
        && (candidate.result as Record<string, unknown>).inputRef === query.inputRef);
      if (!call) return;
      const result = call.result as Record<string, unknown>;
      const input = call.args.input;
      if (!input || typeof input !== "object" || Array.isArray(input)
        || result.status !== "input_prepared" || result.executed !== false
        || typeof result.byteLength !== "number" || !Number.isSafeInteger(result.byteLength)
        || result.byteLength < 2 || result.byteLength > 128 * 1024) return;
      const serialized = JSON.stringify(input);
      if (Buffer.byteLength(serialized, "utf8") > 8 * 1024) return;
      if (call.fingerprint !== toolFingerprint(`${query.agent}\0${query.scope}`, call.tool, call.args)) return;
      return { input: JSON.parse(serialized) as Record<string, unknown>, result: {
        status: "input_prepared", inputRef: query.inputRef, byteLength: result.byteLength, executed: false,
      } };
    },

    beforeTool(agent, tool, args, context): CheckpointToolDecision {
      const fingerprint = toolFingerprint(context?.scope ? `${agent}\0${context.scope}` : agent, tool, args);
      // Cowork's durable broker queries an existing operation ID instead of sending it
      // again. Native safety must preserve that reconciliation path, but never create
      // a new call ID, cross devices, or exempt an unrelated uncertain local write.
      const sameRemoteOperation = (call: CheckpointToolCall): boolean => !!context?.coworkDeviceId
        && call.kind === "harbour" && call.agent === agent && call.status !== "completed"
        && call.fingerprint === fingerprint && call.remote?.deviceId === context.coworkDeviceId
        && call.remote.operationId === `${checkpoint.id}:${call.id}`;
      let pendingRemote = checkpoint.tools.find(sameRemoteOperation);
      // A native transcript already contains consumed tool results. Only the SAME
      // provider call ID may replay one; equal arguments can be an intentional new read/write.
      if (context?.nativeCallId) {
        const exact = checkpoint.tools.find((call) => call.nativeCallId === context.nativeCallId && call.agent === agent);
        if (exact) {
          if (exact.fingerprint !== fingerprint) throw new Error("原生工具调用 ID 与已保存参数不一致");
          if (exact.status === "completed" && exact.replayable) {
            return { action: "replay", callId: exact.id, result: cloneForRuntime(exact.result) };
          }
          if (isRejectedBeforeExecution(exact)) {
            return { action: "replay-rejection", callId: exact.id, rejection: cloneForRuntime(exact.rejection) as CheckpointToolRejection };
          }
          if (sameRemoteOperation(exact)) pendingRemote = exact;
          else if (context.mutating) throw Object.assign(new Error("该原生写操作已有未确认执行边界；请核对原操作结果，不能重复执行。"), { code: "NATIVE_TOOL_OUTCOME_UNKNOWN" });
        }
      }
      if (context?.native && context.mutating) {
        const unsettled = checkpoint.tools.find((call) => call.agent === agent && call.fingerprint === fingerprint &&
          ["running", "interrupted", "failed"].includes(call.status) && call.mutating !== false &&
          !isRejectedBeforeExecution(call) && !sameRemoteOperation(call));
        if (unsettled) throw Object.assign(new Error("中断前存在同参数的未确认写操作；先读取文件或查询原 Workflow/operation 状态，不能重新提交。"), { code: "NATIVE_TOOL_OUTCOME_UNKNOWN" });
      }
      // 不确定的远端写操作只允许查询原 operation；模型不能同轮换参数获得一个新 ID。
      const uncertain = checkpoint.tools.find((call) => call.status !== "completed" && call.remote?.deviceId === context?.coworkDeviceId && call.remote?.status === "unknown");
      if (uncertain && context?.coworkDeviceId && context.mutating && uncertain.fingerprint !== fingerprint) {
        throw Object.assign(new Error("该设备存在结果未知的操作，只能查询原操作；禁止换参数重做副作用。"),
          { code: "COWORK_OUTCOME_UNKNOWN", status: "unknown", operationId: uncertain.remote!.operationId });
      }
      if ((!context?.native && options.resume) || pendingRemote) {
        // 同一参数的未完成步骤优先：它就是断点本身。复用原 callId，完成后 pending 计数会归零，
        // 也避免每次恢复都叠一条“旧 interrupted + 新 completed”的重复账本。
        const pending = pendingRemote ?? checkpoint.tools.find(
          (call) =>
            call.kind === "harbour" &&
            call.status !== "completed" &&
            !isRejectedBeforeExecution(call) &&
            call.fingerprint === fingerprint
        );
        if (pending) {
          pending.status = "running";
          pending.replayable = true;
          pending.startedAt = new Date().toISOString();
          delete pending.completedAt;
          delete pending.error;
          persist();
          logger.info(
            { checkpointId: checkpoint.id, callId: pending.id, agent, tool, sequence: pending.sequence },
            "checkpoint:tool-resume"
          );
          return { action: "execute", callId: pending.id };
        }
        const prior = checkpoint.tools.find(
          (call) =>
            call.kind === "harbour" &&
            call.status === "completed" &&
            context?.replayCompleted !== false &&
            call.replayable &&
            call.fingerprint === fingerprint &&
            !usedReplayIds.has(call.id)
        );
        if (prior) {
          usedReplayIds.add(prior.id);
          prior.replayCount = (prior.replayCount ?? 0) + 1;
          prior.replayedAt = new Date().toISOString();
          persist();
          logger.info(
            { checkpointId: checkpoint.id, callId: prior.id, agent, tool, sequence: prior.sequence },
            "checkpoint:replay"
          );
          return { action: "replay", callId: prior.id, result: cloneForRuntime(prior.result) };
        }
      }

      const call = newCall(checkpoint, agent, tool, args, "harbour", true);
      call.fingerprint = fingerprint;
      if (context?.nativeCallId) call.nativeCallId = context.nativeCallId;
      if (context?.mutating !== undefined) call.mutating = context.mutating;
      if (context?.scope) call.scope = context.scope;
      checkpoint.tools.push(call);
      persist();
      logger.info(
        { checkpointId: checkpoint.id, callId: call.id, agent, tool, sequence: call.sequence },
        "checkpoint:tool-start"
      );
      return { action: "execute", callId: call.id };
    },

    completeTool(callId, result): void {
      const call = findCall(callId);
      if (!call || call.status === "completed") return;
      const stored = storableResult(result);
      call.status = "completed";
      call.completedAt = new Date().toISOString();
      call.replayable = call.replayable && stored.replayable;
      call.result = stored.value;
      delete call.remote;
      delete call.error;
      delete call.rejection;
      persist();
      logger.info(
        { checkpointId: checkpoint.id, callId, agent: call.agent, tool: call.tool, replayable: call.replayable },
        "checkpoint:tool-complete"
      );
    },

    failTool(callId, error, interrupted = false, remote, rejection): void {
      const call = findCall(callId);
      if (!call || call.status === "completed") return;
      call.status = interrupted ? "interrupted" : "failed";
      call.error = error;
      if (remote) call.remote = { ...remote };
      call.completedAt = new Date().toISOString();
      call.replayable = false;
      // A typed rejection proves only this invocation did not execute. Never let
      // it erase a durable Job/remote boundary or turn arbitrary errors into proof.
      delete call.rejection;
      if (rejection && call.kind === "harbour" && call.tool === "run_workflow" && !call.remote && !call.recovery) {
        const stored = storableResult(rejection);
        if (stored.replayable) {
          call.rejection = stored.value as CheckpointToolRejection;
          call.status = "failed";
        }
      }
      persist();
    },

    startExternal(agent, tool, args, toolUseId, source = "external-mcp"): void {
      // Harbour 自有 MCP server 已由 executeCheckpointedTool 记录，Hook 再记会重复。
      // Codex 原生 apply_patch 不经过 executeCheckpointedTool，必须作为独立观察边界落账。
      if (source === "external-mcp" && isHarbourToolName(tool)) return;
      if (source === "codex-native" && checkpoint.tools.some((call) => call.externalUseId === toolUseId)) return;
      const call = newCall(checkpoint, agent, tool, args, source, false);
      call.externalUseId = toolUseId;
      checkpoint.tools.push(call);
      externalIds.set(toolUseId, call.id);
      persist();
      logger.info(
        { checkpointId: checkpoint.id, callId: call.id, agent, tool, replayable: false },
        "checkpoint:external-start"
      );
    },

    completeExternal(toolUseId, result): void {
      const callId = externalIds.get(toolUseId) ?? checkpoint.tools.find((c) => c.externalUseId === toolUseId)?.id;
      const call = callId ? findCall(callId) : undefined;
      if (!call) return;
      const stored = storableResult(result);
      call.status = "completed";
      call.completedAt = new Date().toISOString();
      call.result = stored.value;
      call.replayable = false; // SDK Hook 能观察结果，但不能把它作为一次假的成功调用注入回来。
      persist();
    },

    failExternal(toolUseId, error, interrupted = false): void {
      const callId = externalIds.get(toolUseId) ?? checkpoint.tools.find((c) => c.externalUseId === toolUseId)?.id;
      const call = callId ? findCall(callId) : undefined;
      if (!call) return;
      call.status = interrupted ? "interrupted" : "failed";
      call.error = error;
      call.completedAt = new Date().toISOString();
      call.replayable = false;
      persist();
    },
  };

  return { checkpoint: controller };
}

/** 两条工具执行路径（外层 loop / Claude SDK MCP bridge）共用的结果级 checkpoint 包装。 */
export async function executeCheckpointedTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  ctx: ToolContext,
  execute: () => Promise<unknown>
): Promise<unknown> {
  const checkpoint = ctx.execution?.checkpoint;
  // SDK bridge 直接调用本包装，不能只依赖 Registry 跳过生命周期等仅本轮有效的工具。
  // 旧 checkpoint 即使已有相同调用，也必须重新执行当前逻辑、重建本轮 runState。
  if (!checkpoint || tool.checkpoint === false) return execute();

  const target = ctx.execution?.cowork;
  const remoteTool = target && target.deviceId !== "server" && ["read_file", "list_files", "write_file", "export_file", "bash", "opencli_browser", "opencli_adapter"].includes(tool.name);
  const preparation = tool.name === "run_workflow" && ["prepare_input", "save_draft", "begin_draft", "save_book", "save_panel", "stage_panel", "discard_panel"].includes(String(args.action));
  // status 的用途是核对当前持久状态；不能回放中断前的旧查询回执。仍记录新的工具边界。
  const liveWorkflowStatus = tool.name === "run_workflow" && ["status", "list_inputs", "inspect_input", "inspect_draft"].includes(String(args.action));
  const liveCronQuery = tool.name === "cron_manage" && ["list", "get", "targets"].includes(String(args.action));
  const liveCalendarQuery = tool.name === "calendar_read";
  // 恢复后由当前读取缓存判断是否需要正文；旧的 alreadyLoaded 不能代替重新读取。
  // 原生同 callId 的精确回执仍由 beforeTool 保持，不把协议重传当成新读取。
  const liveResourceRead = tool.name === "read_workflow" || tool.name === "read_skill";
  const native = ctx.execution?.nativeSession?.active === true;
  const decision = checkpoint.beforeTool(ctx.agent.name, tool.name, args, {
    ...(preparation ? { scope: workflowInputCheckpointScope(ctx) }
      : target ? { scope: `${target.deviceId}:${ctx.execution?.subagentDelegationId ?? "main"}` } : {}),
    ...((liveWorkflowStatus || liveCronQuery || liveCalendarQuery || liveResourceRead || native) ? { replayCompleted: false } : {}),
    mutating: !liveWorkflowStatus && !liveCronQuery && !preparation && tool.readOnly !== true,
    ...(native ? { native: true, nativeCallId: nativeToolScope.getStore() } : {}),
    ...(remoteTool ? { coworkDeviceId: target.deviceId, mutating: tool.readOnly !== true } : {}),
  });
  if (decision.action === "replay-rejection") {
    const rejection = decision.rejection;
    throw new WorkflowInputValidationError(rejection.message, rejection.code, rejection.nextActions, rejection.jobId, rejection.details);
  }
  if (decision.action === "replay") {
    if (ctx.execution?.cowork) {
      const { restoreCoworkEvidence } = await import("./cowork/toolRouting");
      restoreCoworkEvidence(decision.result, ctx);
    }
    try {
      await tool.onReplay?.(decision.result, args, ctx);
    } catch (error) {
      // 回放结果仍须交付；内存恢复失败不能把已完成步骤变成需要重新执行的动作。
      ctx.logger.warn({ tool: tool.name, err: error instanceof Error ? error.message : String(error) }, "checkpoint:replay-restore-failed");
    }
    return decision.result;
  }

  try {
    await checkpoint.flush?.();
    const result = await operationScope.run(`${checkpoint.id}:${decision.callId}`, execute);
    checkpoint.completeTool(decision.callId, result);
    await checkpoint.flush?.();
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = error as { status?: string; code?: string; operationId?: string };
    const rejection: CheckpointToolRejection | undefined = tool.name === "run_workflow" && error instanceof WorkflowInputValidationError
      ? { outcome: "not_started", source: "workflow_input_validation", code: error.code, message: error.message,
        nextActions: error.nextActions, ...(error.jobId !== undefined ? { jobId: error.jobId } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}) }
      : undefined;
    checkpoint.failTool(decision.callId, message, ctx.signal?.aborted === true,
      remoteTool && failure.status && failure.operationId ? { deviceId: target.deviceId, operationId: failure.operationId, status: failure.status, code: failure.code } : undefined,
      rejection);
    await checkpoint.flush?.();
    throw error;
  }
}

/** 用户是否明确要求恢复当前 interrupted checkpoint。刻意不把普通“然后呢”一类弱信号算进去。 */
export function isCheckpointResumeInput(raw: string): boolean {
  const input = raw
    .normalize("NFKC")
    .replace(/^\s*\[skill:[^\]]+\]\s*/i, "")
    .trim()
    .toLowerCase();
  if (!input) return false;
  return /^(?:(?:请|麻烦你?|那就|好的?[，, ]*)\s*)?(?:继续|接着(?:做|执行|完成)?|继续刚才(?:的任务)?|恢复(?:刚才的任务|任务|执行|断点)?|从(?:刚才|断点)继续|continue|resume|go\s+on)(?:[\s，,。.!！:：;；]|$)/iu.test(input);
}

/**
 * 恢复轮给模型的自描述输入。完整工具结果不全灌进 context；模型重发完全相同的调用时，
 * checkpoint 控制器会直接把旧结果作为 tool_result 回放，因此既精确又不把大结果常驻 prompt。
 */
export function buildCheckpointResumeInput(checkpoint: RunCheckpoint, resumeInput: string): string {
  return [
    "[Harbour checkpoint 恢复指令]",
    "这是同一任务在停止或故障后的续跑，不是一个新任务。不要从头重新规划，也不要重复已经完成的副作用。",
    `原始任务：\n${checkpoint.originalInput}`,
    `用户本次续跑指令：${resumeInput.trim() || "继续"}`,
    buildCheckpointContext(checkpoint),
    "恢复协议：核对后从首个未完成步骤继续；未完成不等于未执行。已完成且可回放的 Harbour 步骤，只有完全相同的 agent、scope、tool 和参数才会回放旧结果，不真实重复执行。外部 MCP、超限结果和其它不可回放步骤先核对实际状态，仅确认安全后重跑；codex-native apply_patch 已记录完成时禁止再次执行，失败或中断时先读取文件核对，禁止盲重放补丁。最终回答须向用户交付结果或具体阻塞，不能只写内部交接备忘。",
  ].join("\n\n");
}

/** 成功恢复后写入历史的 user 内容：保留原任务，否则下一轮历史里只剩一个孤零零的“继续”。 */
export function checkpointHistoryInput(checkpoint: RunCheckpoint, resumeInput: string): string {
  const extra = resumeInput.trim();
  return extra && extra !== checkpoint.originalInput
    ? `${checkpoint.originalInput}\n\n[中断后续跑指令] ${extra}`
    : checkpoint.originalInput;
}

function isRejectedBeforeExecution(call: CheckpointToolCall): call is CheckpointToolCall & { rejection: CheckpointToolRejection } {
  return call.kind === "harbour" && call.tool === "run_workflow" && call.status === "failed"
    && !call.remote && !call.recovery && call.rejection?.outcome === "not_started"
    && call.rejection.source === "workflow_input_validation";
}

function newCall(
  checkpoint: RunCheckpoint,
  agent: string,
  tool: string,
  args: Record<string, unknown>,
  kind: CheckpointToolCall["kind"],
  replayable: boolean
): CheckpointToolCall {
  return {
    id: `cpt-${randomUUID().slice(0, 10)}`,
    sequence: checkpoint.tools.length + 1,
    agent,
    tool,
    args: cloneArgs(args),
    fingerprint: toolFingerprint(agent, tool, args),
    kind,
    status: "running",
    replayable,
    startedAt: new Date().toISOString(),
  };
}

function toolFingerprint(agent: string, tool: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(`${agent}\0${tool}\0${canonicalJson(args)}`).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(",")}}`;
}

function cloneArgs(args: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
  } catch {
    return { _checkpointUnserializable: true };
  }
}

function storableResult(result: unknown): { value: unknown; replayable: boolean } {
  try {
    const json = JSON.stringify(result);
    if (json === undefined) return { value: null, replayable: false };
    if (Buffer.byteLength(json, "utf8") > MAX_REPLAY_RESULT_BYTES) {
      return {
        value: { _checkpointTruncated: true, preview: json.slice(0, 8_000), bytes: Buffer.byteLength(json, "utf8") },
        replayable: false,
      };
    }
    return { value: JSON.parse(json) as unknown, replayable: true };
  } catch (error) {
    return { value: { _checkpointUnserializable: true, error: error instanceof Error ? error.message : String(error) }, replayable: false };
  }
}

function cloneForRuntime(result: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(result)) as unknown;
  } catch {
    return result;
  }
}

function isHarbourToolName(tool: string): boolean {
  return tool.startsWith("mcp__harbour_tools__") || !tool.startsWith("mcp__");
}
