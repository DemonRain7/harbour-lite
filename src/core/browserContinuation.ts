import { createHash } from "node:crypto";
import type { CompletionResult, ToolContext } from "../types";

const MAX_SEGMENTS = 3;
const OBSERVATIONS = new Set(["state", "snapshot", "extract", "get"]);
const TERMINAL_ACTIONS = new Set(["handoff", "close", "download", "upload_attachment", "upload_character_reference"]);
const VOLATILE_KEYS = /^(?:ref|refs|timestamp|time|elapsed|duration|durationMs|capturedAt|snapshotId)$/i;

function stableObservation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableObservation);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !VOLATILE_KEYS.test(key)).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, stableObservation(item)]));
  // Snapshot locator IDs are not page progress. Keep actual text, including game metrics.
  return typeof value === "string" ? value.replace(/\bref=[\w-]+\b|@\d+\b/g, "<ref>") : value;
}

function failedReceipt(value: unknown, depth = 0): boolean {
  if (depth > 6 || !value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return row.ok === false || row.success === false || row.isError === true || row.timedOut === true || row.refused === true ||
    (row.error !== undefined && row.error !== null && row.error !== "") ||
    ["failed", "error", "unknown", "blocked", "needs_input", "interrupted"].includes(String(row.status)) ||
    failedReceipt(row.result, depth + 1);
}

/** A run-local capability, not a model argument, retry token or durable browser lease.
 * It only extends the CURRENT native loop at a settled boundary. No new run/tab,
 * tool replay, refreshed token budget or new timeout is permitted.
 */
export class BrowserStepContinuation {
  private claimed = false;
  private blocked = false;
  private pending = 0;
  private toolIndex = 0;
  private progressIndex = 0;
  private observationIndex = 0;
  private newObservations = 0;
  private seen = new Set<string>();
  private session?: string;
  private tabs = new Set<string>();
  private segments = 1;
  private incomplete?: CompletionResult["incomplete"];

  claim(): BrowserStepContinuation | undefined {
    if (this.claimed) return undefined;
    this.claimed = true;
    return this;
  }
  get used(): boolean { return this.claimed; }
  start(tool: string, args: Record<string, unknown>): void {
    this.pending++;
    this.toolIndex++;
    if (tool === "opencli_browser" && (args.onceKey !== undefined || TERMINAL_ACTIONS.has(String(args.action)) || /novelai|character_prompt/i.test(String(args.action)) ||
        /(?:^|\.)novelai\.net$/i.test(this.hostname(args.url)))) this.blocked = true;
    if (!["opencli_browser", "opencli_adapter"].includes(tool)) this.blocked = true;
    if (tool === "opencli_adapter" && args.action === "run") this.blocked = true;
  }
  finish(tool: string, args: Record<string, unknown>, result: unknown): void {
    this.pending = Math.max(0, this.pending - 1);
    if (failedReceipt(result)) { this.blocked = true; return; }
    if (tool !== "opencli_browser" || !result || typeof result !== "object") return;
    const row = result as Record<string, unknown>;
    if (typeof row.session !== "string") return;
    if (this.session && this.session !== row.session) { this.blocked = true; return; }
    this.session = row.session;
    if (typeof row.tab === "string" && ["open", "goto"].includes(String(args.action))) this.tabs.add(row.tab);
    // OpenCLI permits omitting tab in a single-tab session. Never guess across tabs.
    const tab = typeof row.tab === "string" ? row.tab : this.tabs.size === 1 ? [...this.tabs][0] : undefined;
    if (!tab || !this.tabs.has(tab) || !OBSERVATIONS.has(String(args.action)) || row.result == null) return;
    this.observationIndex = this.toolIndex;
    const text = JSON.stringify(stableObservation(row.result));
    if (!text || text === '""' || text === "{}" || text === "[]") return;
    const digest = createHash("sha256").update(tab).update(text).digest("hex");
    if (this.seen.has(digest)) return;
    // Bounded memory; saturation is not a reason to forget old states and keep looping.
    if (this.seen.size >= 1024) { this.blocked = true; return; }
    this.seen.add(digest);
    this.newObservations++;
    this.progressIndex = this.toolIndex;
  }
  fail(): void { this.pending = Math.max(0, this.pending - 1); this.blocked = true; }
  extend(converging: boolean, signal?: AbortSignal): boolean {
    if (signal?.aborted || converging || this.blocked || this.pending || !this.session || !this.tabs.size ||
        this.segments >= MAX_SEGMENTS || this.newObservations < 2 ||
        this.toolIndex - this.progressIndex > 8 || this.toolIndex - this.observationIndex > 4) return false;
    this.segments++;
    this.newObservations = 0;
    return true;
  }
  stopped(reason: CompletionResult["incomplete"]): void { this.incomplete = reason; }
  snapshot() { return { segments: this.segments, maxSegments: MAX_SEGMENTS, ...(this.incomplete ? { incomplete: this.incomplete } : {}) }; }
  private hostname(value: unknown): string { try { return new URL(String(value)).hostname; } catch { return ""; } }
}

/** Only a trusted Main's ordinary interactive Browser delegation gets this capability. */
export function browserStepContinuation(ctx: ToolContext): BrowserStepContinuation | undefined {
  if (!ctx.agent.name.startsWith("main-") || ctx.source?.actor?.role !== "owner" ||
      !["web", "qq", "discord"].includes(ctx.source.channel ?? "") || ctx.execution?.novelAiSubmission) return;
  return new BrowserStepContinuation();
}
