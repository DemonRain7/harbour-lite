import type { ToolContext } from "../../types";

export interface WorkflowInvocation {
  action: string;
  input: Record<string, unknown>;
}

/** Optional diagnostics are JSON data, never execution proof or arbitrary state.
 * Bound both fresh errors and persisted replay records before copying them. */
export function normalizeWorkflowValidationDetails(details: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  let copy: Record<string, unknown>;
  try {
    const encoded = JSON.stringify(details);
    if (Buffer.byteLength(encoded, "utf8") > 32 * 1024) return undefined;
    copy = JSON.parse(encoded);
    if (!copy || typeof copy !== "object" || Array.isArray(copy)) return undefined;
  } catch { return undefined; }
  const pending: object[] = [copy];
  while (pending.length) {
    const value = pending.pop()!;
    for (const nested of Object.values(value)) if (nested && typeof nested === "object") pending.push(nested);
    Object.freeze(value);
  }
  return copy;
}

/** Only deterministic pre-execution validators may use this; text is never evidence. */
export class WorkflowInputValidationError extends Error {
  readonly executionStarted = false;
  readonly details?: Readonly<Record<string, unknown>>;
  constructor(message: string, readonly code = "invalid_input", readonly nextActions: unknown[] = [], readonly jobId?: string,
    details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "WorkflowInputValidationError";
    if (details !== undefined) this.details = normalizeWorkflowValidationDetails(details);
  }

  toResult(): Record<string, unknown> {
    return { status: "input_invalid", terminal: true, executionStarted: false, retrySafety: "safe",
      reason: this.message, error: { code: this.code, message: this.message }, nextActions: this.nextActions,
      ...(this.jobId ? { jobId: this.jobId } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}) };
  }
}

/** Preserve structured repair hints across every model backend's error wrapper.
 * Keep the legacy top-level error string; only our typed pre-execution errors
 * may publish executionStarted:false / safe. Never infer this from error text. */
export function workflowFailureFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof WorkflowInputValidationError)) return {};
  const { error: _descriptor, ...fields } = error.toResult();
  return { ...fields, code: error.code };
}

export interface WorkflowExecutor {
  /** 必须与 WORKFLOW.md frontmatter.executor 一致。 */
  id: string;
  execute(invocation: WorkflowInvocation, ctx: ToolContext): Promise<unknown>;
  /** Restore delivery-only memory from a completed checkpoint; never execute nodes or writes. */
  onReplay?(result: unknown, ctx: ToolContext): void | Promise<void>;
  /**
   * Cron / HTTP 管理入口等可信系统调用可走这一条，不伪造 Agent/ToolContext。
   * 没有显式实现的 Workflow 只能由挂载它的 Agent 调用，保持 fail closed。
   */
  executeSystem?(invocation: WorkflowInvocation): Promise<unknown>;
}

/**
 * Workflow 运行时注册表。
 *
 * 文档/挂载决定“某个 Agent 能否看见并调用”；本表只负责把稳定 executor ID
 * 解析为确定性实现。模型不能注册、替换或通过路径直接执行任意脚本。
 */
export class WorkflowRegistry {
  private readonly executors = new Map<string, WorkflowExecutor>();

  register(executor: WorkflowExecutor): void {
    if (this.executors.has(executor.id)) throw new Error(`Workflow executor 重复注册：${executor.id}`);
    this.executors.set(executor.id, executor);
  }

  get(id: string): WorkflowExecutor | undefined {
    return this.executors.get(id);
  }

  async executeSystem(id: string, invocation: WorkflowInvocation): Promise<unknown> {
    const executor = this.executors.get(id);
    if (!executor) throw new Error(`Workflow executor 未注册：${id}`);
    if (!executor.executeSystem) throw new Error(`Workflow executor「${id}」不允许系统直接调用`);
    return executor.executeSystem(invocation);
  }

  list(): string[] {
    return [...this.executors.keys()].sort();
  }
}
