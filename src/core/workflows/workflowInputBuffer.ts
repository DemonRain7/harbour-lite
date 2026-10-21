import { createHash } from "node:crypto";
import type { ToolContext } from "../../types";
import { workflowInputCheckpointScope } from "../checkpoint";
import { taskPersistence } from "../delegationTasks";

export const WORKFLOW_INPUT_MAX_CHUNK_BYTES = 8 * 1024;
export const WORKFLOW_INPUT_MAX_BYTES = 128 * 1024;
export const WORKFLOW_INPUT_MAX_PARTS = 64;
const REF = /^wfi-[a-f0-9]{64}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CACHE_KEY = "workflow-input-buffer:v1";
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
interface Snapshot { value: JsonObject; byteLength: number; parts: number }
interface Scope { key: string; snapshots: Map<string, Snapshot> }
export interface WorkflowInputPrepared {
  status: "input_prepared";
  inputRef: string;
  byteLength: number;
  executed: false;
}

function fail(message: string): never { throw new Error(`Workflow input: ${message}`); }
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Clone strict JSON without invoking getters/toJSON or accepting non-JSON object instances. */
function jsonClone(value: unknown, depth = 0, ancestors = new Set<object>()): JsonValue {
  if (depth > 64) fail("JSON nesting exceeds 64 levels");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("numbers must be finite JSON numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") fail("value must contain only JSON values");
  if (ancestors.has(value)) fail("cyclic JSON is not supported");
  if (Object.getOwnPropertySymbols(value).length) fail("symbol keys are not JSON");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) fail("non-JSON object instance");
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).filter((key) => !(Array.isArray(value) && key === "length"));
    if (keys.length > 32768) fail("too many JSON members");
    if (Array.isArray(value) && (value.length > 32768 || keys.length !== value.length)) fail("sparse or oversized array");
    const result: JsonValue[] | JsonObject = Array.isArray(value) ? [] : {};
    for (const key of keys.sort()) {
      if (FORBIDDEN_KEYS.has(key)) fail("prototype-related keys are forbidden");
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !("value" in descriptor)) fail("getters and hidden properties are not JSON");
      if (Array.isArray(result)) {
        if (!/^(0|[1-9][0-9]*)$/.test(key) || !Array.isArray(value) || Number(key) >= value.length) fail("non-index array property");
        result[Number(key)] = jsonClone(descriptor.value, depth + 1, ancestors);
      } else result[key] = jsonClone(descriptor.value, depth + 1, ancestors);
    }
    return result;
  } finally { ancestors.delete(value); }
}

function scopeFor(workflow: string, ctx: ToolContext): Scope {
  ctx.signal?.throwIfAborted();
  if (!ctx.agent.workflows?.some((entry) => entry.name === workflow)) fail("Workflow is not mounted for this agent");
  if (ctx.source?.actor?.role === "other") fail("external users cannot prepare Workflow inputs");
  if (!ctx.runState) fail("runState is required; prepared inputs are scoped to the current run");
  const durable = taskPersistence(ctx);
  const key = durable ? JSON.stringify([durable.scope, durable.taskRef, ctx.agent.name, workflow, ctx.execution?.cowork?.deviceId ?? "server"])
    : JSON.stringify([ctx.agent.name, workflow, workflowInputCheckpointScope(ctx),
    ctx.execution?.checkpoint ? `checkpoint:${ctx.execution.checkpoint.id}` : ctx.execution?.runId ? `run:${ctx.execution.runId}` : "run-state"]);
  let scopes = ctx.runState.get(CACHE_KEY) as Map<string, Map<string, Snapshot>> | undefined;
  if (!scopes) { scopes = new Map(); ctx.runState.set(CACHE_KEY, scopes); }
  let snapshots = scopes.get(key);
  if (!snapshots) { snapshots = new Map(); scopes.set(key, snapshots); }
  return { key, snapshots };
}

function parsePreparation(raw: Record<string, unknown>): { baseRef?: string; path: string; value: JsonValue } {
  const input = jsonClone(raw);
  if (!isObject(input) || !Object.hasOwn(input, "value")) fail("prepare_input requires input.value");
  if (Object.keys(input).some((key) => !["baseRef", "path", "value"].includes(key))) fail("unknown preparation field");
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > WORKFLOW_INPUT_MAX_CHUNK_BYTES) fail("preparation chunk exceeds 8 KiB");
  const baseRef = input.baseRef;
  if (baseRef !== undefined && (typeof baseRef !== "string" || !REF.test(baseRef))) fail("invalid baseRef");
  const pointer = Object.hasOwn(input, "path") ? input.path : "";
  if (typeof pointer !== "string" || pointer.length > 1024) fail("path must be a JSON pointer up to 1024 characters");
  if (!baseRef && pointer !== "") fail("initial input must use the root path");
  if (pointer === "" && !isObject(input.value)) fail("root value must be an object");
  return { ...(typeof baseRef === "string" ? { baseRef } : {}), path: pointer, value: input.value as JsonValue };
}

function pointerParts(pointer: string): string[] {
  if (!pointer) return [];
  if (!pointer.startsWith("/")) fail("path must begin with / (JSON pointer)");
  return pointer.slice(1).split("/").map((part) => {
    if (/~(?:[^01]|$)/.test(part)) fail("invalid JSON pointer escape");
    const decoded = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (FORBIDDEN_KEYS.has(decoded)) fail("prototype-related pointer segments are forbidden");
    return decoded;
  });
}

function setSubtree(root: JsonObject, pointer: string, value: JsonValue): JsonObject {
  const parts = pointerParts(pointer);
  if (!parts.length) return jsonClone(value) as JsonObject;
  const copy = jsonClone(root) as JsonObject;
  let parent: JsonValue = copy;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (!parent || typeof parent !== "object") fail("pointer parent must be an existing object or array");
    const last = index === parts.length - 1;
    if (Array.isArray(parent)) {
      if (!/^(0|[1-9][0-9]*)$/.test(part)) fail("array pointer needs a canonical non-negative index");
      const offset = Number(part);
      if (!Number.isSafeInteger(offset) || offset > parent.length || (!last && offset === parent.length)) fail("array pointer cannot create sparse entries");
      if (last) parent[offset] = value;
      else parent = parent[offset]!;
    } else {
      if (last) parent[part] = value;
      else {
        if (!Object.hasOwn(parent, part)) fail("pointer parent does not exist; prepare its container first");
        parent = parent[part]!;
      }
    }
  }
  return jsonClone(copy) as JsonObject;
}

function makeSnapshot(scope: Scope, value: JsonObject, parts: number): { ref: string; snapshot: Snapshot } {
  const json = JSON.stringify(value);
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > WORKFLOW_INPUT_MAX_BYTES) fail("assembled input exceeds 128 KiB");
  if (parts > WORKFLOW_INPUT_MAX_PARTS) fail("preparation exceeds 64 parts");
  const ref = `wfi-${createHash("sha256").update(scope.key).update("\0").update(json).digest("hex")}`;
  return { ref, snapshot: { value, byteLength, parts } };
}

function remember(scope: Scope, ref: string, snapshot: Snapshot): void {
  if (!scope.snapshots.has(ref) && scope.snapshots.size >= WORKFLOW_INPUT_MAX_PARTS) fail("run scope already contains 64 input snapshots");
  if (!scope.snapshots.has(ref)) scope.snapshots.set(ref, snapshot);
}

function recover(workflow: string, inputRef: string, ctx: ToolContext, scope: Scope, visiting = new Set<string>()): Snapshot {
  ctx.signal?.throwIfAborted();
  if (!REF.test(inputRef)) fail("invalid inputRef");
  const cached = scope.snapshots.get(inputRef);
  if (cached) return cached;
  if (visiting.has(inputRef) || visiting.size >= WORKFLOW_INPUT_MAX_PARTS) fail("invalid or oversized preparation reference chain");
  const saved = ctx.execution?.checkpoint?.lookupWorkflowInputPreparation?.({
    agent: ctx.agent.name, workflow, scope: workflowInputCheckpointScope(ctx), inputRef,
  });
  if (!saved) fail("inputRef is missing, stale, or belongs to another run/agent/Workflow/delegation");
  visiting.add(inputRef);
  try {
    const preparation = parsePreparation(saved.input);
    const base = preparation.baseRef ? recover(workflow, preparation.baseRef, ctx, scope, visiting) : undefined;
    const value = base ? setSubtree(base.value, preparation.path, preparation.value) : preparation.value as JsonObject;
    const built = makeSnapshot(scope, value, (base?.parts ?? 0) + 1);
    if (built.ref !== inputRef || built.snapshot.byteLength !== saved.result.byteLength) fail("checkpoint input preparation integrity mismatch");
    ctx.signal?.throwIfAborted();
    remember(scope, inputRef, built.snapshot);
    return built.snapshot;
  } finally { visiting.delete(inputRef); }
}

/** Pure input assembly: no executor, file write, model call, or domain-specific default. */
export function prepareWorkflowInput(workflow: string, input: Record<string, unknown>, ctx: ToolContext): WorkflowInputPrepared {
  const scope = scopeFor(workflow, ctx);
  const preparation = parsePreparation(input);
  const base = preparation.baseRef ? recover(workflow, preparation.baseRef, ctx, scope) : undefined;
  const value = base ? setSubtree(base.value, preparation.path, preparation.value) : preparation.value as JsonObject;
  const built = makeSnapshot(scope, value, (base?.parts ?? 0) + 1);
  ctx.signal?.throwIfAborted();
  remember(scope, built.ref, built.snapshot);
  return { status: "input_prepared", inputRef: built.ref, byteLength: built.snapshot.byteLength, executed: false };
}

/** Validate the model's small payload before any program-owned structure is added. */
export function workflowInputChunk(input: Record<string, unknown>): Record<string, unknown> {
  const value = jsonClone(input) as JsonObject;
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > WORKFLOW_INPUT_MAX_CHUNK_BYTES) fail("preparation chunk exceeds 8 KiB");
  return value;
}

/** Internal assembly only. Callers validate the incoming chunk, then fill fixed
 * slots; the assembled snapshot retains the same total/parts/scope limits. */
export function prepareStructuredWorkflowInput(workflow: string, value: Record<string, unknown>, ctx: ToolContext, baseRef?: string): WorkflowInputPrepared {
  const scope = scopeFor(workflow, ctx);
  const base = baseRef ? recover(workflow, baseRef, ctx, scope) : undefined;
  const built = makeSnapshot(scope, jsonClone(value) as JsonObject, (base?.parts ?? 0) + 1);
  ctx.signal?.throwIfAborted();
  remember(scope, built.ref, built.snapshot);
  return { status: "input_prepared", inputRef: built.ref, byteLength: built.snapshot.byteLength, executed: false };
}

/** Return a fresh JSON copy, so the executor cannot mutate an immutable prepared snapshot. */
export function resolveWorkflowInput(workflow: string, inputRef: string, ctx: ToolContext): Record<string, unknown> {
  if (typeof inputRef !== "string") fail("inputRef must be a string");
  const scope = scopeFor(workflow, ctx);
  return jsonClone(recover(workflow, inputRef, ctx, scope).value) as Record<string, unknown>;
}

/** Hydrate exact immutable snapshots, not old tool results or execution permissions. */
export async function restoreDurableWorkflowInputs(workflow: string, ctx: ToolContext): Promise<void> {
  const durable = taskPersistence(ctx);
  if (!durable) return;
  const scope = scopeFor(workflow, ctx);
  const task = await durable.store.get(durable.scope, durable.taskRef!);
  if (task.agent !== ctx.agent.name) fail("saved task belongs to another agent");
  for (const entry of await durable.store.listInputs(durable.scope, durable.taskRef!, workflow)) {
    if (scope.snapshots.has(entry.inputRef)) continue;
    const saved = await durable.store.getInput(durable.scope, durable.taskRef!, workflow, entry.inputRef);
    const built = makeSnapshot(scope, jsonClone(saved.value) as JsonObject, saved.parts);
    if (built.ref !== entry.inputRef || built.snapshot.byteLength !== saved.byteLength) fail("durable input integrity mismatch");
    remember(scope, built.ref, built.snapshot);
  }
}

export async function persistWorkflowInput(workflow: string, inputRef: string, ctx: ToolContext): Promise<void> {
  const durable = taskPersistence(ctx);
  if (!durable) return;
  const scope = scopeFor(workflow, ctx);
  const saved = recover(workflow, inputRef, ctx, scope);
  await durable.store.saveInput(durable.scope, durable.taskRef!, workflow, inputRef, saved);
}

/** Small legacy/direct calls are also persisted BEFORE domain validation or execution. */
export async function persistDirectWorkflowInput(workflow: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string | undefined> {
  if (!taskPersistence(ctx)) return;
  const scope = scopeFor(workflow, ctx);
  const built = makeSnapshot(scope, jsonClone(input) as JsonObject, 1);
  remember(scope, built.ref, built.snapshot);
  await persistWorkflowInput(workflow, built.ref, ctx);
  return built.ref;
}

export function inspectWorkflowInput(workflow: string, inputRef: string, pointer: string, ctx: ToolContext): unknown {
  let value: unknown = resolveWorkflowInput(workflow, inputRef, ctx);
  for (const part of pointerParts(pointer)) {
    if (!isObject(value) && !Array.isArray(value)) fail("inspection path does not exist");
    if (!Object.hasOwn(value, part)) fail("inspection path does not exist");
    value = (value as Record<string, unknown>)[part];
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > WORKFLOW_INPUT_MAX_CHUNK_BYTES) {
    return { truncated: true, instruction: "此节点超过 8KB，请通过 path 读取所需子字段，不要重新生成草稿。",
      ...(Array.isArray(value) ? { length: value.length } : isObject(value) ? { keys: Object.keys(value) } : {}) };
  }
  return value;
}
