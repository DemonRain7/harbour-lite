import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { harbourBrowserHome } from "../storagePaths";
import { deliverBrowserImage } from "../browserArtifacts";
import type { Logger } from "pino";
import type { Env } from "../../config/env";
import type { Attachment, NovelAiSubmissionLimit, ToolContext, ToolDef } from "../../types";
import { validateNovelAiBatchPrompt } from "../novelAiPromptComposer";
import { validateNovelAiRequiredReferences } from "../novelAiReferences";
import { supportsNovelAiPreciseReferences } from "../novelAiModelCapabilities";
import { assessNovelAiPromptBudget, novelAiPromptBudgetOverflowReport, parseNovelAiPromptTokenCounter } from "../novelAiPromptBudget";
import { novelAiPromptBudgetFailureKey } from "../novelAiPromptBudgetEvidence";
import { novelAiAuthenticationFailureKey, novelAiAuthenticationIssue } from "../novelAiAuthentication";
import { novelAiPromptAuditScript, novelAiPromptBudgetProofScript, novelAiPromptCounterClearScript, novelAiPromptCounterReadScript, novelAiPromptCounterTargetScript } from "./novelAiPromptBudgetPage";
import { assertNovelAiModelSelectionUsable, markNovelAiModelSelectionFailed, novelAiModelSelectionScript } from "./novelAiModelSelectionPage";
import { assertNovelAiAvailableBalance } from "../workflows/novelAiAccountReservations";
import {
  defaultNovelAiCharacterLibraryDir,
  resolveNovelAiReferenceHandle,
} from "../novelAiCharacterLibrary";
import {
  closeManagedPageTarget,
  ensureManagedChrome,
  resolveBrowserHarnessConfig,
  type BrowserHarnessConfig,
} from "./browserHarness";
import { resolveOpenCliConfig, type OpenCliConfig } from "./openCli";
import { probeOpenCliDaemonStatus } from "./openCliDaemonStatus";
import { OpenCliCommandTimeoutError, spawnOpenCli } from "./openCliProcess";
import { ManagedPageFocusCleanupError, withManagedPageFocus } from "./managedPageFocus";
import { runNovelAiPromptCounterBatch } from "./novelAiPromptCounterBatch";
import { assertNovelAiPreparationUsable, markNovelAiPreparationInterrupted, observeNovelAiPreparation, preparationCommand, preparationStage, NovelAiPreparationBatchReceiptError } from "./novelAiPreparationProgress";
import { assertNovelAiExecutionActionAllowed, recordNovelAiExecutionAction, markNovelAiPaidActivation } from "../novelAiExecutionStage";
import { awaitOpenCliStartup } from "./openCliStartup";
import { assertNovelAiSfwSamplingReadback, configureNovelAiSfwSampling, novelAiSfwSamplingScript } from "./novelAiSfwSamplingPage";
import { assertNovelAiSfwVibeEmpty, novelAiSfwVibeScript } from "./novelAiSfwVibePage";
import type { NovelAiSfwSampling } from "../workflows/novelAiSfwSampling";
import { novelAiModelCheckScript, novelAiPreciseReferenceInputScript,
  novelAiPreciseReferenceSnapshotScript, novelAiClearPreciseReferenceScript, novelAiPreciseReferenceModelCheckScript } from "./novelAiReferencePage";

// OpenCLI 的结构化 state 很容易把整页可访问树塞回模型，并在每个 SDK turn 被重复携带。
// 子进程可多抓一点用于保留首尾证据，但真正回灌给模型的默认上限保持紧凑。
const MAX_OUTPUT_CHARS = 18_000;
const MAX_CAPTURE_CHARS = 60_000;
const MAX_DATA_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_DATA_IMAGE_OUTPUT_CHARS = 60 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 90_000;
// 单个 OpenCLI 子命令仍受 90s 限制；只有 prepare_novelai_form 这类由多个已验证
// 子动作组成的复合调用需要更长外层窗口，避免两角色/多角色表单被半途截断。
const COMPOSITE_TOOL_TIMEOUT_MS = 180_000;
const SESSION_KEY = "opencli-browser:session";
const OPENED_TABS_KEY = "opencli-browser:opened-tabs";
const CLEANUP_REGISTERED_KEY = "opencli-browser:cleanup-registered";
const HANDED_OFF_KEY = "opencli-browser:handed-off";
const ACTIVATION_ONCE_KEYS = "opencli-browser:activation-once-keys";
const MATERIALIZED_ATTACHMENTS_KEY = "opencli-browser:materialized-attachments";
const EXPORTED_DATA_IMAGES_KEY = "opencli-browser:exported-data-images";
const NOVELAI_GENERATIONS_KEY = "opencli-browser:novelai-generations";
const NOVELAI_PREPARED_KEY = "opencli-browser:novelai-prepared:";
const NOVELAI_PROMPT_BUDGET_KEY = "opencli-browser:novelai-prompt-budget:";
const NOVELAI_REFERENCES_KEY = "opencli-browser:novelai-references:";
const NOVELAI_REFERENCE_RESET_KEY = "opencli-browser:novelai-reference-reset:";
const BRIDGE_READY_KEY = "opencli-browser:bridge-ready";
const BRIDGE_START_TIMEOUT_MS = 15_000;
const bridgeReadyInFlight = new Map<string, Promise<void>>();
const daemonReadyInFlight = new Map<string, Promise<void>>();

export function normalizeNovelAiCollectTimeout(value: unknown): number {
  const requested = value === undefined ? DEFAULT_TIMEOUT_MS : Number(value);
  return Number.isFinite(requested)
    ? Math.min(DEFAULT_TIMEOUT_MS, Math.max(100, Math.floor(requested)))
    : DEFAULT_TIMEOUT_MS;
}

export interface OpenCliBrowserConfig {
  browser: BrowserHarnessConfig;
  opencli: OpenCliConfig;
  screenshotDir: string;
  downloadDir: string;
  attachmentRoots: string[];
  attachmentStagingDir: string;
  characterLibraryDir: string;
  maxAttachmentBytes: number;
  idleTimeoutSeconds: number;
}

export function resolveOpenCliBrowserConfig(env: Env): OpenCliBrowserConfig {
  const browserHome = harbourBrowserHome(env);
  return {
    browser: resolveBrowserHarnessConfig(env),
    opencli: resolveOpenCliConfig(env),
    screenshotDir: path.join(browserHome, "screenshots"),
    downloadDir: path.join(browserHome, "downloads"),
    attachmentRoots: [path.resolve(process.cwd(), env.UPLOAD_DIR)],
    attachmentStagingDir: path.join(browserHome, "attachments"),
    characterLibraryDir: defaultNovelAiCharacterLibraryDir(),
    maxAttachmentBytes: Math.floor(env.MAX_UPLOAD_MB * 1024 * 1024),
    idleTimeoutSeconds: env.OPENCLI_BROWSER_IDLE_TIMEOUT,
  };
}

interface OpenCliCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * 运行一个短生命周期的 OpenCLI 管理命令。
 *
 * Browser Bridge daemon 是 OpenCLI 自己的本地 sidecar；过去 Harbour 先等扩展连接，
 * 却没有先把 daemon 拉起来，导致「隔离 Chrome 已经正常运行，但 profile 永远连不上」的
 * 循环等待。这里集中处理 timeout/abort，避免各入口各写一套不一致的 lifecycle。
 */
async function runOpenCliManagementCommand(
  cfg: OpenCliBrowserConfig,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = 7_000
): Promise<OpenCliCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawnOpenCli(cfg.opencli.entryPath, args, {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      fn();
    };
    const abort = () => {
      child.kill();
      finish(() => reject(new Error("OpenCLI daemon 启动检查已停止")));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`OpenCLI ${args.join(" ")} 超时`)));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk, 20_000); });
    child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk, 20_000); });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => resolve({ code, stdout, stderr })));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function daemonIsHealthy(output: string): boolean {
  return /^Daemon:\s+running\b/im.test(output) && !/^Daemon:\s+stale\b/im.test(output);
}

async function openCliDaemonStatus(cfg: OpenCliBrowserConfig, signal?: AbortSignal): Promise<OpenCliCommandResult> {
  const status = await probeOpenCliDaemonStatus(cfg.opencli.entryPath, signal);
  if (!status) return runOpenCliManagementCommand(cfg, ["daemon", "status"], signal, 4_000);
  return {
    code: 0,
    stdout: `Daemon: ${status.state === "not-running" ? "not running" : status.state}\n${status.detail}`,
    stderr: "",
  };
}

/** daemon 不在或版本陈旧时自动恢复；并发 browser run 共享同一个启动 Promise。 */
async function ensureOpenCliDaemon(
  cfg: OpenCliBrowserConfig,
  logger: Logger,
  signal?: AbortSignal
): Promise<void> {
  const key = cfg.opencli.entryPath;
  await awaitOpenCliStartup(daemonReadyInFlight, key, async () => {
    const before = await openCliDaemonStatus(cfg);
    if (before.code === 0 && daemonIsHealthy(before.stdout)) return;

    logger.info(
      { status: (before.stdout.trim() || before.stderr.trim() || `exit ${before.code}`).slice(0, 500) },
      "opencli: Browser Bridge daemon 未就绪，自动启动"
    );
    const restarted = await runOpenCliManagementCommand(cfg, ["daemon", "restart"], undefined, 10_000);
    if (restarted.code !== 0) {
      throw new Error(
        `OpenCLI daemon 自动启动失败：${(restarted.stderr.trim() || restarted.stdout.trim() || `exit ${restarted.code}`).slice(0, 1_000)}`
      );
    }
    const after = await openCliDaemonStatus(cfg);
    if (after.code !== 0 || !daemonIsHealthy(after.stdout)) {
      throw new Error(
        `OpenCLI daemon 启动后仍未就绪：${(after.stderr.trim() || after.stdout.trim() || `exit ${after.code}`).slice(0, 1_000)}`
      );
    }
    logger.info("opencli: Browser Bridge daemon 已就绪");
  }, signal);
}

async function openCliProfileList(cfg: OpenCliBrowserConfig, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnOpenCli(cfg.opencli.entryPath, ["profile", "list"], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      fn();
    };
    const abort = () => {
      child.kill();
      finish(() => reject(new Error("OpenCLI Browser Bridge 启动检查已停止")));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("OpenCLI Browser Bridge 状态检查超时")));
    }, 3_000);
    child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk, 20_000); });
    child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk, 20_000); });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || stdout.trim() || `exit ${code}`));
    }));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function profileIsConnected(output: string, profile: string): boolean {
  return output.split(/\r?\n/u).some((line) =>
    line.toLowerCase().includes(profile.toLowerCase()) &&
    /\bconnected\b/iu.test(line) &&
    !/\bnot\s+connected\b/iu.test(line)
  );
}

function connectedProfileIds(output: string): Set<string> {
  const ids = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^\s*([a-z0-9]{4,})\b.*\bconnected\b(?!.*\bnot\s+connected\b)/iu);
    if (match?.[1]) ids.add(match[1]);
  }
  return ids;
}

async function renameOpenCliProfile(
  cfg: OpenCliBrowserConfig,
  contextId: string,
  alias: string,
  signal?: AbortSignal
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnOpenCli(cfg.opencli.entryPath, ["profile", "rename", contextId, alias], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("OpenCLI Browser Bridge profile 自动命名超时"));
    }, 3_000);
    const abort = () => {
      child.kill();
      clearTimeout(timer);
      reject(new Error("OpenCLI Browser Bridge profile 自动命名已停止"));
    };
    child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk, 5_000); });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `OpenCLI profile rename exit ${code}`));
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function waitForOpenCliProfile(
  cfg: OpenCliBrowserConfig,
  ctx: ToolContext,
  connectedBeforeLaunch: Set<string>
): Promise<void> {
  if (ctx.runState?.get(BRIDGE_READY_KEY) === cfg.opencli.profile) return;
  const key = `${cfg.opencli.entryPath}\u0000${cfg.opencli.profile}`;
  await awaitOpenCliStartup(bridgeReadyInFlight, key, async () => {
    const deadline = Date.now() + BRIDGE_START_TIMEOUT_MS;
    let lastOutput = "";
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        lastOutput = await openCliProfileList(cfg);
        if (profileIsConnected(lastOutput, cfg.opencli.profile)) return;
        // 新装的 unpacked 扩展会生成新的 contextId。只在本次启动后恰好新增一个
        // profile 时把它命名为 harbour；绝不从已有连接里猜一个，避免误绑日常 Chrome。
        const added = [...connectedProfileIds(lastOutput)].filter((id) => !connectedBeforeLaunch.has(id));
        if (added.length === 1) {
          await renameOpenCliProfile(cfg, added[0]!, cfg.opencli.profile);
          ctx.logger.info({ contextId: added[0], alias: cfg.opencli.profile }, "opencli: 自动绑定专属 Browser profile");
          connectedBeforeLaunch.add(added[0]!);
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const summary = lastOutput.split(/\r?\n/u)
      .filter((line) => line.trim())
      .slice(-8)
      .join(" | ");
    throw new Error(
      `OpenCLI Browser Bridge profile「${cfg.opencli.profile}」在 ${BRIDGE_START_TIMEOUT_MS / 1_000} 秒内未连接。` +
      `请确认 Harbour 专属 Chrome 中 OpenCLI 扩展已启用。${lastError ? ` ${lastError}` : ""}${summary ? ` 状态：${summary}` : ""}`
    );
  }, ctx.signal);
  ctx.runState?.set(BRIDGE_READY_KEY, cfg.opencli.profile);
}

/**
 * 确保 OpenCLI 的三段链路完整：daemon → Harbour 隔离 Chrome → 指定 Bridge profile。
 * 可由工具懒调用，也可在桌面端随本机后端启动时后台预热。
 */
export async function ensureOpenCliBrowserBridge(
  cfg: OpenCliBrowserConfig,
  logger: Logger,
  signal?: AbortSignal,
  runState?: Map<string, unknown>
): Promise<void> {
  await ensureOpenCliDaemon(cfg, logger, signal);
  let connectedBeforeLaunch = new Set<string>();
  try {
    connectedBeforeLaunch = connectedProfileIds(await openCliProfileList(cfg, signal));
  } catch {
    // daemon 已确认就绪；profile list 的瞬时失败仍交给下方有界 readiness 给出最终诊断。
  }
  if (signal?.aborted) throw new Error("OpenCLI 启动等待已停止");
  await ensureManagedChrome(cfg.browser, logger);
  await waitForOpenCliProfile(
    cfg,
    { logger, signal, runState } as ToolContext,
    connectedBeforeLaunch
  );
}

function appendBounded(current: string, chunk: Buffer | string, maxChars = MAX_OUTPUT_CHARS): string {
  if (current.length >= maxChars) return current;
  return (current + chunk.toString()).slice(0, maxChars);
}

function parseOutput(raw: string, maxChars = MAX_OUTPUT_CHARS): unknown {
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    const serialized = JSON.stringify(parsed);
    if (serialized.length <= maxChars) return parsed;
    const edge = Math.max(500, Math.floor((maxChars - 500) / 2));
    return {
      truncated: true,
      originalChars: serialized.length,
      preview: `${serialized.slice(0, edge)}\n…（中间省略 ${serialized.length - edge * 2} 字符）…\n${serialized.slice(-edge)}`,
      guidance: "不要重复获取整页 state；改用 find/get、分块 extract，NovelAI 使用 inspect_novelai。",
    };
  } catch {
    return text.slice(0, maxChars);
  }
}

function recoverContentEditableFill(error: unknown, expected: string): unknown | undefined {
  if (!(error instanceof Error)) return undefined;
  const marker = "OpenCLI Browser 执行失败：";
  const start = error.message.indexOf(marker);
  if (start < 0) return undefined;
  try {
    const parsed = JSON.parse(error.message.slice(start + marker.length)) as Record<string, unknown>;
    if (parsed.filled !== true || parsed.verified !== false || parsed.mode !== "contenteditable") return undefined;
    const actual = typeof parsed.actual === "string" ? parsed.actual : "";
    // ProseMirror 常把多个 <p> 的换行在 innerText/value 回读时折叠掉；只在所有
    // 非空白字符逐字一致时接纳，绝不放宽到模糊包含或相似度判断。
    if (!actual || actual.replace(/\s+/g, "") !== expected.replace(/\s+/g, "")) return undefined;
    return {
      ...parsed,
      verified: true,
      verification: "contenteditable-non-whitespace-equivalent",
    };
  } catch {
    return undefined;
  }
}

class OpenCliNotDispatchedError extends Error {}

class OpenCliCommandError extends Error {
  constructor(message: string, readonly stdout: string, readonly stderr: string, readonly exitCode: number | null) { super(message); }
}

// Audited against pinned OpenCLI 1.8.7: these upload errors occur before
// setFileInputFiles. Transport/daemon/verification errors are deliberately absent.
const UPLOAD_PRE_EXECUTION_CODES = new Set([
  "usage_error", "file_not_found", "not_a_file", "not_file_input",
  "semantic_ambiguous", "semantic_not_found", "not_found", "stale_ref",
  "invalid_selector", "selector_not_found", "selector_nth_out_of_range", "selector_ambiguous",
]);

function uploadWasNotExecuted(error: unknown): boolean {
  if (error instanceof OpenCliNotDispatchedError) return true;
  if (!(error instanceof OpenCliCommandError) || error.exitCode === null) return false;
  try {
    const envelope = JSON.parse(error.stdout);
    if (!envelope || typeof envelope !== "object" || Object.keys(envelope).length !== 1 ||
        !envelope.error || !UPLOAD_PRE_EXECUTION_CODES.has(envelope.error.code) ||
        typeof envelope.error.message !== "string") return false;
    if (!error.stderr.trim()) return true;
    // TargetError prints the same structured rejection on stdout and this exact
    // diagnostic on stderr. Additional transport warnings remain uncertain.
    const rejection = envelope.error;
    const expected = `✖  [${rejection.code}] ${rejection.message}` +
      (typeof rejection.hint === "string" && rejection.hint ? `\n✖  Hint: ${rejection.hint}` : "");
    return error.stderr.replace(/\r\n/g, "\n").trim() === expected;
  } catch { return false; }
}

async function runOpenCliBrowser(
  cfg: OpenCliBrowserConfig,
  session: string,
  args: string[],
  ctx: ToolContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputChars = MAX_OUTPUT_CHARS,
  beforeDispatch?: () => void
): Promise<unknown> {
  return preparationCommand(ctx, () => dispatchOpenCliBrowser(cfg, session, args, ctx, timeoutMs, maxOutputChars, beforeDispatch));
}

async function dispatchOpenCliBrowser(
  cfg: OpenCliBrowserConfig, session: string, args: string[], ctx: ToolContext,
  timeoutMs: number, maxOutputChars: number, beforeDispatch?: () => void
): Promise<unknown> {
  if (ctx.signal?.aborted) throw new Error("OpenCLI Browser 操作已停止");
  await ensureOpenCliBrowserBridge(cfg, ctx.logger, ctx.signal, ctx.runState);
  if (ctx.signal?.aborted) throw new Error("OpenCLI Browser 操作已停止");
  const captureChars = maxOutputChars > MAX_OUTPUT_CHARS
    ? maxOutputChars
    : Math.max(maxOutputChars, MAX_CAPTURE_CHARS);

  // Infrastructure readiness is not an attempted page mutation. Reserve only
  // after readiness and cancellation checks, synchronously before spawning.
  beforeDispatch?.();
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnOpenCli(
        cfg.opencli.entryPath,
        ["--profile", cfg.opencli.profile, "browser", session, ...args],
        {
          cwd: process.cwd(),
          env: {
            OPENCLI_BROWSER_IDLE_TIMEOUT: String(cfg.idleTimeoutSeconds),
          },
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
    } catch (error) {
      reject(new OpenCliNotDispatchedError(`OpenCLI Browser 启动失败：${(error as Error).message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", abort);
      fn();
    };
    const abort = () => {
      child.kill();
      finish(() => reject(new Error("OpenCLI Browser 操作已停止")));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new OpenCliCommandTimeoutError(timeoutMs)));
    }, timeoutMs);

      child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk, captureChars); });
      child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk, captureChars); });
    child.on("error", (error) => finish(() => reject(
      child.pid === undefined
        ? new OpenCliNotDispatchedError(`OpenCLI Browser 启动失败：${error.message}`)
        : new Error(`OpenCLI Browser 执行异常：${error.message}`)
    )));
    child.on("close", (code) => finish(() => {
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `exit ${code}`;
        reject(new OpenCliCommandError(`OpenCLI Browser 执行失败：${detail.slice(0, 2_000)}`, stdout, stderr, code));
        return;
      }
      resolve(parseOutput(stdout, maxOutputChars));
    }));

    if (ctx.signal?.aborted) abort();
    else ctx.signal?.addEventListener("abort", abort, { once: true });
  });
}

function requiredString(value: unknown, field: string, max = 10_000, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`opencli_browser: 缺少 ${field}`);
  if (value.length > max) throw new Error(`opencli_browser: ${field} 过长（最多 ${max} 字符）`);
  return value;
}

function safeUrl(value: unknown): string {
  const raw = requiredString(value, "url", 4_000);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("opencli_browser: URL 必须包含 http:// 或 https://");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("opencli_browser: 只允许 http/https URL");
  }
  return url.toString();
}

function optionalTab(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const tab = String(value);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(tab)) {
    throw new Error("opencli_browser: tab 必须来自 open/tabs 返回的页面 ID");
  }
  return tab;
}

function optionalTarget(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const target = String(value).trim();
  if (!target) return undefined;
  if (target.length > 1_000) throw new Error("opencli_browser: ref/selector 过长");
  if (/^@\d+$/.test(target)) return target.slice(1);
  return target;
}

function sessionFor(ctx: ToolContext): string {
  ctx.runState ??= new Map<string, unknown>();
  const existing = ctx.runState.get(SESSION_KEY);
  if (typeof existing === "string") return existing;
  const session = `harbour-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  ctx.runState.set(SESSION_KEY, session);
  return session;
}

function openedTabs(ctx: ToolContext): Set<string> {
  ctx.runState ??= new Map<string, unknown>();
  const existing = ctx.runState.get(OPENED_TABS_KEY);
  if (existing instanceof Set) return existing as Set<string>;
  const tabs = new Set<string>();
  ctx.runState.set(OPENED_TABS_KEY, tabs);
  return tabs;
}

function activationOnceKeys(ctx: ToolContext): Set<string> {
  ctx.runState ??= new Map<string, unknown>();
  const existing = ctx.runState.get(ACTIVATION_ONCE_KEYS);
  if (existing instanceof Set) return existing as Set<string>;
  const keys = new Set<string>();
  ctx.runState.set(ACTIVATION_ONCE_KEYS, keys);
  return keys;
}

function exportedDataImages(ctx: ToolContext): Map<string, string> {
  ctx.runState ??= new Map<string, unknown>();
  const existing = ctx.runState.get(EXPORTED_DATA_IMAGES_KEY);
  if (existing instanceof Map) return existing as Map<string, string>;
  const images = new Map<string, string>();
  ctx.runState.set(EXPORTED_DATA_IMAGES_KEY, images);
  return images;
}

interface NovelAiGenerationBaseline {
  sourceFingerprints: string[];
  balanceBefore?: number;
  costAnlas: number;
  numberOfImages: number;
  expectedWidth: number;
  expectedHeight: number;
  onceKey?: string;
  referenceVerification?: NovelAiReferenceVerification;
}

interface NovelAiReferenceVerification {
  evidence: "loaded-reference-preview";
  references: Array<{ identity: string; fingerprint: string }>;
}

export interface NovelAiExecutionEvidence {
  session?: string;
  tab?: string;
  completed: boolean;
  submitted: true;
  visibleCostAnlas: number;
  balanceBefore: number | null;
  balanceAfter?: number | null;
  expectedResolution: { width: number; height: number };
  artifacts?: Array<Record<string, unknown>>;
  chargeState?: "charged" | "not_charged" | "unknown";
  reason?: string;
  observedPreviewDimensions?: string[];
  observedFingerprints?: number;
  warnings?: unknown;
  inspection?: unknown;
  onceKey?: string;
  /** Local upload + applied-preview evidence, not the remote API payload. */
  referenceVerification?: NovelAiReferenceVerification;
}

/** 子 Browser Agent 的最终自然语言不可信；以 onceKey 把工具验签结果带回父 Workflow。 */
export function novelAiExecutionEvidenceKey(onceKey: string): string {
  return `opencli_browser:novelai:${onceKey}`;
}

function rememberNovelAiExecutionEvidence(
  ctx: ToolContext,
  baseline: NovelAiGenerationBaseline,
  evidence: NovelAiExecutionEvidence,
): void {
  if (!baseline.onceKey || !ctx.execution) return;
  ctx.execution.toolEvidence ??= new Map<string, unknown>();
  ctx.execution.toolEvidence.set(novelAiExecutionEvidenceKey(baseline.onceKey), {
    ...evidence,
    ...(baseline.referenceVerification ? { referenceVerification: baseline.referenceVerification } : {}),
  });
}

interface RenderedImageInventoryItem {
  fingerprint: string;
  width: number;
  height: number;
}

export interface NovelAiRenderedImageSelection {
  freshFingerprints: string[];
  fullResolutionFingerprints: string[];
  previewDimensions: string[];
}

/**
 * Generate 后页面会先短暂挂出 1/2 尺寸 JPEG 预览，随后才替换成真正的 PNG。
 * 只看“出现了新 fingerprint”会把 416x608 当成 832x1216 成品。这里把选择规则
 * 固定在核心层：同源 DOM 副本去重，并且只有解码尺寸与表单目标完全一致才可收取。
 */
export function selectNovelAiRenderedImages(
  inventory: unknown,
  baselineFingerprints: string[],
  expectedWidth: number,
  expectedHeight: number
): NovelAiRenderedImageSelection {
  const row = inventory && typeof inventory === "object" ? inventory as Record<string, unknown> : {};
  const items = Array.isArray(row.items) ? row.items : [];
  const baseline = new Set(baselineFingerprints);
  const freshByFingerprint = new Map<string, RenderedImageInventoryItem>();
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const fingerprint = typeof item.fingerprint === "string" ? item.fingerprint : "";
    const width = Number(item.width);
    const height = Number(item.height);
    if (!fingerprint || baseline.has(fingerprint) || !Number.isInteger(width) || !Number.isInteger(height) ||
        width <= 0 || height <= 0) continue;
    const previous = freshByFingerprint.get(fingerprint);
    if (!previous || width * height > previous.width * previous.height) {
      freshByFingerprint.set(fingerprint, { fingerprint, width, height });
    }
  }
  const fresh = [...freshByFingerprint.values()];
  return {
    freshFingerprints: fresh.map((item) => item.fingerprint),
    fullResolutionFingerprints: fresh
      .filter((item) => item.width === expectedWidth && item.height === expectedHeight)
      .map((item) => item.fingerprint),
    previewDimensions: [...new Set(fresh
      .filter((item) => item.width !== expectedWidth || item.height !== expectedHeight)
      .map((item) => `${item.width}x${item.height}`))],
  };
}

function novelAiGenerations(ctx: ToolContext): Map<string, NovelAiGenerationBaseline> {
  ctx.runState ??= new Map<string, unknown>();
  const existing = ctx.runState.get(NOVELAI_GENERATIONS_KEY);
  if (existing instanceof Map) return existing as Map<string, NovelAiGenerationBaseline>;
  const generations = new Map<string, NovelAiGenerationBaseline>();
  ctx.runState.set(NOVELAI_GENERATIONS_KEY, generations);
  return generations;
}

function frozenFormSignature(limit: NovelAiSubmissionLimit): string {
  return createHash("sha256").update(JSON.stringify([limit.onceKey, limit.form, limit.requiredReferences,
    ...(limit.expectedModel ? [limit.expectedModel] : [])])).digest("hex");
}

type RequiredNovelAiReference = NonNullable<NovelAiSubmissionLimit["requiredReferences"]>[number];
interface NovelAiReferenceProof {
  signature: string;
  uploads: Array<{ identity: string; fingerprint: string }>;
}
interface NovelAiPendingReferenceReset {
  signature: string;
  identities: string[];
}
function referenceIdentity(reference: RequiredNovelAiReference): string {
  return reference.kind === "character" ? `character:${reference.handle}` : `attachment:${reference.index}:${reference.sha256}`;
}
function clearNovelAiPreparation(ctx: ToolContext, tab?: string): void {
  // Clearing active page proof must not forget which uploads were confirmed.
  // Keep those keys locked but recoverable across a failed prepare/navigation;
  // only a later verified empty reset may release them. Unknown uploads have no proof.
  const limit = ctx.execution?.novelAiSubmission;
  const proof = referenceProof(ctx, tab);
  if (limit && proof?.signature === frozenFormSignature(limit)) {
    const key = NOVELAI_REFERENCE_RESET_KEY + (tab ?? "default");
    const pending = ctx.runState?.get(key) as NovelAiPendingReferenceReset | undefined;
    const identities = new Set(pending?.signature === proof.signature ? pending.identities : []);
    for (const upload of proof.uploads) identities.add(upload.identity);
    ctx.runState?.set(key, { signature: proof.signature, identities: [...identities] });
  }
  ctx.runState?.delete(NOVELAI_PREPARED_KEY + (tab ?? "default"));
  ctx.runState?.delete(NOVELAI_PROMPT_BUDGET_KEY + (tab ?? "default"));
  ctx.runState?.delete(NOVELAI_REFERENCES_KEY + (tab ?? "default"));
}
function referenceProof(ctx: ToolContext, tab?: string): NovelAiReferenceProof | undefined {
  return ctx.runState?.get(NOVELAI_REFERENCES_KEY + (tab ?? "default")) as NovelAiReferenceProof | undefined;
}
/** Authorization and actual page evidence are both scoped to this prepared tab. */
function authorizeNovelAiReference(ctx: ToolContext, tab: string | undefined, reference: RequiredNovelAiReference): string | undefined {
  const limit = ctx.execution?.novelAiSubmission;
  if (!limit?.form) return undefined; // Legacy non-Workflow uploads retain their grant boundary.
  validateNovelAiRequiredReferences(limit.requiredReferences ?? []);
  const signature = frozenFormSignature(limit);
  if (ctx.runState?.get(NOVELAI_PREPARED_KEY + (tab ?? "default")) !== signature) {
    throw new Error("参考图上传前须先完成冻结表单 prepare_novelai_form；未执行上传。");
  }
  if (novelAiGenerations(ctx).has(tab ?? "default") || activationOnceKeys(ctx).has(limit.onceKey)) {
    throw new Error("Generate 已尝试，不能修改参考图；仅可核对原结果。");
  }
  const identity = referenceIdentity(reference);
  if (!(limit.requiredReferences ?? []).some(item => referenceIdentity(item) === identity)) {
    throw new Error("参考图不在此冻结提交的 requiredReferences 授权清单中；未执行上传。");
  }
  const proof = referenceProof(ctx, tab);
  if (proof?.signature === signature && proof.uploads.some(item => item.identity === identity)) {
    throw new Error("此冻结提交已确认该参考图，禁止重复上传。");
  }
  return identity;
}

/** Loaded local previews inside known reference containers only: a file input alone
 * is not proof that NovelAI applied the reference. Unsupported layouts fail closed.
 * Source strings stay in the page; compact fingerprints are accidental-change
 * detectors, not cryptographic attestations of the remote service's request. */
export function novelAiReferenceSnapshotScript(): string {
  return novelAiPreciseReferenceSnapshotScript();
}
function referenceFingerprints(value: unknown): string[] {
  if (!value || typeof value !== "object" || (value as Record<string, unknown>).referenceSnapshot !== true ||
    !Array.isArray((value as Record<string, unknown>).fingerprints)) throw new Error("无法核对参考图页面证据；未提交 Generate。");
  const state = value as Record<string, unknown>;
  if (Number(state.pending ?? 0) || Number(state.invalidModes ?? 0) || Number(state.invalidPreviews ?? 0) ||
      Number(state.disabledReferences ?? 0) || Number(state.panelCount ?? 0) > 1) {
    throw new Error("参考图尚未解码、已禁用、模式不含 Character 或面板不唯一；未提交 Generate。");
  }
  const fingerprints = (value as { fingerprints: unknown[] }).fingerprints;
  if (fingerprints.length > 8 || fingerprints.some(item => typeof item !== "string" || !/^\d+:[a-f0-9]+:[a-f0-9]+:\d+x\d+$/.test(item))) {
    throw new Error("参考图页面证据无效；未提交 Generate。");
  }
  return [...fingerprints as string[]].sort();
}
async function inspectNovelAiReferences(cfg: OpenCliBrowserConfig, session: string, tab: string | undefined, ctx: ToolContext): Promise<string[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await runOpenCliBrowser(cfg, session, withTab(["eval", novelAiReferenceSnapshotScript()], tab), ctx);
    if (Number((result as Record<string, unknown>)?.pending) && attempt < 4) { await waitBriefly(250, ctx.signal); continue; }
    return referenceFingerprints(result);
  }
  throw new Error("参考图解码未完成；未提交 Generate。");
}

async function assertNovelAiPageModel(cfg: OpenCliBrowserConfig, session: string, tab: string | undefined, ctx: ToolContext): Promise<string | undefined> {
  const expected = ctx.execution?.novelAiSubmission?.expectedModel;
  if (!expected && !ctx.execution?.novelAiSubmission?.form) return;
  const result = await runOpenCliBrowser(cfg, session, withTab(["eval", novelAiModelCheckScript(expected ?? "V4.5 Full")], tab), ctx) as Record<string, unknown>;
  if (result?.modelCheck !== true || typeof result.model !== "string" || (expected && result.modelMatches !== true)) {
    throw new Error(`NovelAI 页面模型 ${result?.model ?? "未知"} 与冻结模型 ${expected} 不符；未执行上传或 Generate，不自动更换模型。`);
  }
  return result.model;
}

async function preciseReferenceTarget(cfg: OpenCliBrowserConfig, session: string, tab: string | undefined, ctx: ToolContext): Promise<{ target: string; flags: string[] }> {
  const result = await runOpenCliBrowser(cfg, session, withTab(["eval", novelAiPreciseReferenceInputScript(ctx.execution?.novelAiSubmission?.expectedModel)], tab), ctx) as Record<string, unknown>;
  if (result?.referenceInput !== true || result.status !== "ready" || typeof result.selector !== "string") {
    throw new Error(`NovelAI 参考图上传前检查失败（${result?.status ?? "unknown"}，当前模型 ${result?.model ?? "未知"}）：${result?.reason ?? "无法确认 Precise Reference 控件"}。未执行上传，未消耗 onceKey；不得改用 Image2Image 或反复重传。`);
  }
  return { target: result.selector, flags: [] };
}
async function beforeNovelAiReference(cfg: OpenCliBrowserConfig, session: string, tab: string | undefined,
  ctx: ToolContext, identity: string | undefined): Promise<string[] | undefined> {
  if (!identity) return undefined;
  const before = await inspectNovelAiReferences(cfg, session, tab, ctx);
  assertSameReferences(before, referenceProof(ctx, tab)?.uploads.map(item => item.fingerprint) ?? []);
  return before;
}
function novelAiReferenceOnceKey(ctx: ToolContext, identity: string): string {
  return `frozen-reference:${createHash("sha256").update(JSON.stringify([ctx.execution!.novelAiSubmission!.onceKey, identity])).digest("hex").slice(0, 40)}`;
}

/** Prevent accidental use of known submission UI outside the governed executor.
 * This is not a security sandbox for arbitrary or malicious page code. */
export function novelAiSubmissionGuardScript(): string {
  return `(() => {
    const key = '__harbourNovelAiSubmissionGuard';
    let state = globalThis[key];
    if (!state || state.document !== document) {
      state = { document, blocked: 0, allowedClick: null, allowSubmit: false };
      globalThis[key] = state;
      const generate = el => !!el && [el.getAttribute?.('aria-label'), el.getAttribute?.('title'), el.innerText, el.textContent, el.value]
        .some(value => /^generate(?:\\s|$)/i.test(String(value || '').replace(/\\s+/g, ' ').trim()));
      const block = event => { state.blocked++; event.preventDefault(); event.stopImmediatePropagation(); };
      document.addEventListener('click', event => {
        const target = event.target?.closest?.('button,[role="button"]');
        if (!generate(target)) return;
        if (state.allowedClick === target) { state.allowedClick = null; state.allowSubmit = true; return; }
        block(event);
      }, true);
      document.addEventListener('submit', event => {
        const generatorForm = generate(event.submitter) || Array.from(event.target?.querySelectorAll?.('button,[role="button"],input[type="submit"]') || []).some(generate);
        if (generatorForm && !state.allowSubmit) block(event);
      }, true);
      document.addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) block(event);
      }, true);
    }
    return { submissionGuardInstalled: true, blocked: state.blocked };
  })()`;
}
async function guardedNovelAiMutation(cfg: OpenCliBrowserConfig, session: string, tab: string | undefined,
  ctx: ToolContext, mutate: () => Promise<unknown>): Promise<unknown> {
  if (!ctx.execution?.novelAiSubmission?.form) return mutate();
  const before = await runOpenCliBrowser(cfg, session, withTab(["eval", novelAiSubmissionGuardScript()], tab), ctx) as Record<string, unknown>;
  if (before?.submissionGuardInstalled !== true || !Number.isSafeInteger(before.blocked)) throw new Error("无法安装 Workflow Generate 误操作护栏；未执行页面操作。");
  const result = await mutate();
  const after = await runOpenCliBrowser(cfg, session, withTab(["eval", novelAiSubmissionGuardScript()], tab), ctx) as Record<string, unknown>;
  if (after?.submissionGuardInstalled !== true || !Number.isSafeInteger(after.blocked)) throw new Error("页面操作后无法核对 Workflow 提交护栏，请先核对页面状态。");
  if (Number(after.blocked) > Number(before.blocked)) throw new Error("Workflow 已阻止绕过执行器的 Generate 点击/提交/快捷键；请先完成参考图核验，再使用 execute_novelai。未由该入口提交 Generate。");
  return result;
}
function assertSameReferences(actual: string[], expected: string[]): void {
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error("参考图页面状态已改变、仍在处理或布局不受支持；无法确认已应用冻结参考图，未提交 Generate。");
  }
}
async function recordNovelAiReference(cfg: OpenCliBrowserConfig, session: string, tab: string | undefined,
  ctx: ToolContext, identity: string | undefined, before: string[] | undefined): Promise<{ verified: true; identity: string; fingerprint: string; evidence: "loaded-reference-preview" } | undefined> {
  if (!identity || !before) return;
  let after: string[] = [];
  // Waiting for a preview is read-only; never repeat the upload.
  for (let attempt = 0; attempt < 5; attempt++) {
    after = await inspectNovelAiReferences(cfg, session, tab, ctx);
    const added = [...after];
    for (const previous of before) { const index = added.indexOf(previous); if (index < 0) break; added.splice(index, 1); }
    if (after.length === before.length + 1 && added.length === 1) {
      const limit = ctx.execution!.novelAiSubmission!;
      const signature = frozenFormSignature(limit);
      if (ctx.runState?.get(NOVELAI_PREPARED_KEY + (tab ?? "default")) !== signature) throw new Error("上传期间冻结表单已改变，参考图未确认。");
      const proof = referenceProof(ctx, tab);
      const uploads = proof?.signature === signature ? proof.uploads : [];
      ctx.runState!.set(NOVELAI_REFERENCES_KEY + (tab ?? "default"), { signature, uploads: [...uploads, { identity, fingerprint: added[0]! }] });
      return { verified: true, identity, fingerprint: added[0]!, evidence: "loaded-reference-preview" };
    }
    if (attempt < 4) await waitBriefly(250, ctx.signal);
  }
  throw new Error("上传已尝试，但未确认新增且已加载的参考图预览；布局可能不受支持。禁止自动重传或 Generate。");
}

function optionalOnceKey(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const key = String(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,99}$/.test(key)) {
    throw new Error("opencli_browser: onceKey 只允许字母、数字、冒号、下划线和短横线（最多 100 字符）");
  }
  return key;
}

function reserveOnceKey(ctx: ToolContext, value: unknown): string | undefined {
  const key = optionalOnceKey(value);
  if (!key) return undefined;
  const keys = activationOnceKeys(ctx);
  if (keys.has(key)) {
    throw new Error(`opencli_browser: onceKey「${key}」本轮已经尝试过；结果不确定时也禁止自动重试`);
  }
  // 在动作前占位：命令断流时无法证明页面没有收到点击，必须保持 uncertain 并拒绝重试。
  keys.add(key);
  return key;
}

function waitBriefly(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("OpenCLI Browser 操作已停止"));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error("OpenCLI Browser 操作已停止"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function pageIdFrom(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const page = (value as Record<string, unknown>).page;
  return typeof page === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(page) ? page : undefined;
}

function withTab(args: string[], tab: string | undefined): string[] {
  return tab ? [...args, "--tab", tab] : args;
}

function semanticFlags(input: Record<string, unknown>): string[] {
  const flags: string[] = [];
  const pairs: Array<[string, unknown, number]> = [
    ["role", input.role, 100],
    ["name", input.name, 500],
    ["label", input.label, 500],
    ["text", input.queryText, 1_000],
    ["testid", input.testId, 500],
  ];
  for (const [flag, raw, max] of pairs) {
    if (raw === undefined || raw === null || raw === "") continue;
    flags.push(`--${flag}`, requiredString(raw, flag, max));
  }
  if (input.nth !== undefined) {
    const nth = Number(input.nth);
    if (!Number.isInteger(nth) || nth < 0 || nth > 10_000) throw new Error("opencli_browser: nth 必须是非负整数");
    flags.push("--nth", String(nth));
  }
  return flags;
}

function targetAndFlags(input: Record<string, unknown>): { target?: string; flags: string[] } {
  const target = optionalTarget(input.ref ?? input.selector);
  const flags = semanticFlags(input);
  if (!target && !flags.some(flag => ["--role", "--name", "--label", "--text", "--testid"].includes(flag))) {
    throw new Error("opencli_browser: 需要 snapshot ref、CSS selector 或 role/name/label/queryText/testId 定位条件；nth 不能单独定位。未执行页面操作，也未占用 onceKey。");
  }
  return { target, flags };
}

function uploadTargetAndFlags(input: Record<string, unknown>): { target?: string; flags: string[] } {
  const located = targetAndFlags(input);
  const hasSemantic = located.flags.some(flag => ["--role", "--name", "--label", "--text", "--testid"].includes(flag));
  if (located.target && hasSemantic) {
    throw new Error("opencli_browser: 上传定位不能混用 ref/selector 与 role/name/label/queryText/testId；选择一种定位方式，nth 仅用于消歧。未上传，也未占用 onceKey。");
  }
  return located;
}

async function runVerifiedUpload(
  cfg: OpenCliBrowserConfig, session: string, tab: string | undefined, ctx: ToolContext,
  located: { target?: string; flags: string[] }, filePath: string, key: unknown, verifyConsumedInputOnPage = false,
): Promise<{ result: unknown; onceKey: string | undefined }> {
  const args = ["upload", ...(located.target ? [located.target] : []), filePath, ...located.flags];
  // Validate before startup as well as reserving atomically at dispatch.
  const requestedKey = optionalOnceKey(key);
  if (requestedKey && activationOnceKeys(ctx).has(requestedKey)) reserveOnceKey(ctx, requestedKey);
  let onceKey: string | undefined;
  try {
    const result = await runOpenCliBrowser(cfg, session, withTab(args, tab), ctx,
      DEFAULT_TIMEOUT_MS, MAX_OUTPUT_CHARS, () => { onceKey = reserveOnceKey(ctx, requestedKey); });
    const receipt = result && typeof result === "object" ? result as Record<string, unknown> : undefined;
    // React may consume and clear the file input before OpenCLI reads FileList.
    // Only the Workflow path can accept that weak receipt, and only provisionally:
    // its caller must confirm a newly loaded reference preview before returning.
    const matchedName = Array.isArray(receipt?.file_names) && (receipt.file_names.length === 1 && receipt.file_names[0] === path.basename(filePath) ||
      verifyConsumedInputOnPage && receipt.file_names.length === 0);
    if (receipt?.uploaded !== true || receipt.files !== 1 || !Array.isArray(receipt.file_names) ||
      !matchedName) {
      throw new Error(`opencli_browser: OpenCLI 未确认参考图已经附加；结果未知，禁止自动重试：${JSON.stringify(result).slice(0, 1_000)}`);
    }
    return { result, onceKey };
  } catch (error) {
    if (onceKey && uploadWasNotExecuted(error)) {
      activationOnceKeys(ctx).delete(onceKey);
      throw new Error(`opencli_browser: 上传未执行，onceKey 已释放；修正定位或文件问题后可用原 onceKey 重试。${(error as Error).message}`);
    }
    if (error instanceof OpenCliCommandError && /Page\.fileChooserOpened[^\n]*within 5s/.test(error.stderr)) {
      // Diagnostic only: do NOT reclassify a dispatched picker timeout as a
      // selector rejection or retry it through another attachment entry point.
      throw new Error("opencli_browser: 文件选择器事件超时（不是定位歧义）；上传结果未确认，onceKey 保留。" +
        "附件和角色库上传共用此底层，不能靠换入口或换键重传。需检查浏览器扩展上传链路。" + error.message);
    }
    throw error;
  }
}

function domActivationScript(target: string, nth: number): string {
  const selector = /^\d+$/.test(target) ? `[data-opencli-ref="${target}"]` : target;
  return `(() => {
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const el = nodes[${nth}];
    if (!el) throw new Error("DOM activate target not found");
    const disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true";
    if (disabled) throw new Error("DOM activate target is disabled");
    el.scrollIntoView({ behavior: "instant", block: "center" });
    if (typeof el.click !== "function") throw new Error("DOM activate target is not clickable");
    el.click();
    return {
      activated: true,
      matches_n: nodes.length,
      nth: ${nth},
      tag: String(el.tagName || "").toLowerCase(),
      text: String(el.innerText || el.textContent || "").trim().slice(0, 240)
    };
  })()`;
}

function downloadTargetInspectionScript(target: string, nth: number): string {
  const selector = /^\d+$/.test(target) ? `[data-opencli-ref="${target}"]` : target;
  return `(() => {
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const el = nodes[${nth}];
    if (!el) throw new Error("download target not found");
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      found: true,
      visible: style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 1 && rect.height > 1,
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
      tag: String(el.tagName || "").toLowerCase(),
      text: String(el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 240),
      ariaLabel: String(el.getAttribute("aria-label") || "").slice(0, 240),
      title: String(el.getAttribute("title") || "").slice(0, 240),
      href: String(el.getAttribute("href") || "").slice(0, 1_000),
      hasDownloadAttribute: el.hasAttribute("download"),
      matches_n: nodes.length,
      nth: ${nth}
    };
  })()`;
}

/**
 * 只返回当前页面大尺寸本地渲染图的轻量 source 指纹。Generate 前后用它做差集，
 * 不把旧图、预览图或整段 base64 灌给模型。
 */
export function renderedImageFingerprintsScript(): string {
  return `(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" &&
        rect.width > 1 && rect.height > 1;
    };
    const localSource = (value) => {
      const src = String(value || "");
      return src.startsWith("data:image/") || src.startsWith("blob:") ? src : "";
    };
    const fingerprint = (src) => {
      let hash = 2166136261;
      for (let index = 0; index < src.length; index += 1) {
        hash ^= src.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return src.length + ":" + (hash >>> 0).toString(16);
    };
    const rows = Array.from(document.querySelectorAll("img")).filter((img) => {
      const src = localSource(img.currentSrc || img.src);
      return src && visible(img) && Number(img.naturalWidth || img.width || 0) >= 256 &&
        Number(img.naturalHeight || img.height || 0) >= 256;
    }).map((img) => {
      const src = localSource(img.currentSrc || img.src);
      return {
        fingerprint: fingerprint(src),
        width: Number(img.naturalWidth || img.width || 0),
        height: Number(img.naturalHeight || img.height || 0)
      };
    });
    return {
      fingerprints: [...new Set(rows.map((row) => row.fingerprint))],
      images: rows.length,
      items: rows
    };
  })()`;
}

export function dataImageExportScript(
  selector: string | undefined,
  nth: number,
  excludedSourceFingerprints: string[] = [],
  expectedWidth?: number,
  expectedHeight?: number,
  allowedSourceFingerprints?: string[]
): string {
  return `(async () => {
    // Candidate decoding must not let an unrelated, unfinished image hold collection
    // indefinitely. The shared deadline also bounds a page with many bad candidates.
    const deadline = Date.now() + 20_000;
    const bounded = async (work, timeoutMs, label, cancel) => {
      const remaining = Math.min(timeoutMs, deadline - Date.now());
      if (remaining <= 0) { cancel?.(); throw new Error('rendered image export deadline exceeded'); }
      let timer;
      try {
        return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
          timer = setTimeout(() => { cancel?.(); reject(new Error('rendered image ' + label + ' timed out')); }, remaining);
        })]);
      } finally { clearTimeout(timer); }
    };
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" &&
        rect.width > 1 && rect.height > 1;
    };
    const localSource = (value) => {
      const src = String(value || "");
      return src.startsWith("data:image/") || src.startsWith("blob:") ? src : "";
    };
    const fingerprint = (src) => {
      let hash = 2166136261;
      for (let index = 0; index < src.length; index += 1) {
        hash ^= src.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return src.length + ":" + (hash >>> 0).toString(16);
    };
    const excluded = new Set(${JSON.stringify(excludedSourceFingerprints)});
    const allowed = ${allowedSourceFingerprints === undefined ? "null" : `new Set(${JSON.stringify(allowedSourceFingerprints)})`};
    const backgroundSource = (el) => {
      const raw = String(getComputedStyle(el).backgroundImage || "");
      const start = raw.indexOf("url(");
      if (start < 0) return "";
      const end = raw.indexOf(")", start + 4);
      if (end < 0) return "";
      let src = raw.slice(start + 4, end).trim();
      if ((src.startsWith('"') && src.endsWith('"')) || (src.startsWith("'") && src.endsWith("'"))) {
        src = src.slice(1, -1);
      }
      return localSource(src);
    };
    const roots = ${selector
      ? `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`
      : `[document.documentElement]`};
    const nodes = [];
    for (const root of roots) {
      nodes.push(root);
      if (!(root instanceof HTMLImageElement) && !(root instanceof HTMLCanvasElement)) {
        nodes.push(...Array.from(root.querySelectorAll(allowed ? "img" : "img,canvas,*")));
      }
    }
    const seen = new Set();
    const candidates = [];
    for (const el of nodes) {
      // NovelAI collection already identified fresh full-resolution <img> sources.
      // Do not broaden that evidence back to unrelated backgrounds or canvases.
      if (allowed && !(el instanceof HTMLImageElement)) continue;
      if (seen.has(el) || !visible(el)) continue;
      seen.add(el);
      const rect = el.getBoundingClientRect();
      if (el instanceof HTMLCanvasElement && el.width > 0 && el.height > 0) {
        candidates.push({ el, kind: "canvas", src: "", area: rect.width * rect.height });
        continue;
      }
      const imageSrc = el instanceof HTMLImageElement ? localSource(el.currentSrc || el.src) : "";
      if (allowed && !allowed.has(fingerprint(imageSrc))) continue;
      const background = allowed ? "" : backgroundSource(el);
      const src = imageSrc || background;
      if (src && !excluded.has(fingerprint(src))) {
        candidates.push({ el, kind: imageSrc ? "image" : "background", src, area: rect.width * rect.height });
      }
    }
    const describe = async (candidate) => {
      let image = candidate.el;
      let naturalWidth = 0;
      let naturalHeight = 0;
      if (candidate.kind === "canvas") {
        naturalWidth = Number(candidate.el.width || 0);
        naturalHeight = Number(candidate.el.height || 0);
      } else {
        if (candidate.el instanceof HTMLImageElement) {
          try { if (!candidate.el.complete) await bounded(() => candidate.el.decode(), 2_000, 'decode'); }
          catch { return null; }
          if (localSource(candidate.el.currentSrc || candidate.el.src) !== candidate.src) return null;
          naturalWidth = Number(candidate.el.naturalWidth || 0);
          naturalHeight = Number(candidate.el.naturalHeight || 0);
        } else {
          image = new Image();
          image.src = candidate.src;
          try { await bounded(() => image.decode(), 2_000, 'background decode', () => { image.src = ''; }); }
          catch { return null; }
          naturalWidth = Number(image.naturalWidth || 0);
          naturalHeight = Number(image.naturalHeight || 0);
        }
      }
      if (!naturalWidth || !naturalHeight) return null;
      let visualHash = "";
      try {
        const sample = document.createElement("canvas");
        sample.width = 9;
        sample.height = 8;
        const context = sample.getContext("2d", { willReadFrequently: true });
        if (context) {
          context.drawImage(image, 0, 0, 9, 8);
          const pixels = context.getImageData(0, 0, 9, 8).data;
          for (let y = 0; y < 8; y += 1) {
            for (let x = 0; x < 8; x += 1) {
              const left = (y * 9 + x) * 4;
              const right = left + 4;
              const leftY = pixels[left] * 299 + pixels[left + 1] * 587 + pixels[left + 2] * 114;
              const rightY = pixels[right] * 299 + pixels[right + 1] * 587 + pixels[right + 2] * 114;
              visualHash += leftY > rightY ? "1" : "0";
            }
          }
        }
      } catch {}
      return { ...candidate, naturalWidth, naturalHeight, visualHash };
    };
    const resolved = [];
    for (const candidate of candidates) {
      if (Date.now() >= deadline) throw new Error('rendered image export deadline exceeded');
      const result = await describe(candidate);
      if (result) resolved.push(result);
    }
    resolved.sort((a, b) =>
      (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight) ||
      b.area - a.area || b.src.length - a.src.length
    );
    const unique = [];
    const visualHashes = new Set();
    for (const candidate of resolved) {
      if (candidate.visualHash && visualHashes.has(candidate.visualHash)) continue;
      if (candidate.visualHash) visualHashes.add(candidate.visualHash);
      unique.push(candidate);
    }
    const expectedWidth = ${expectedWidth === undefined ? "null" : JSON.stringify(expectedWidth)};
    const expectedHeight = ${expectedHeight === undefined ? "null" : JSON.stringify(expectedHeight)};
    const eligible = expectedWidth === null || expectedHeight === null
      ? unique
      : unique.filter((candidate) => candidate.naturalWidth === expectedWidth && candidate.naturalHeight === expectedHeight);
    const candidate = eligible[${nth}];
    if (!candidate) {
      const observed = unique.map((item) => item.naturalWidth + "x" + item.naturalHeight);
      throw new Error(expectedWidth === null || expectedHeight === null
        ? "visible data/blob/canvas image not found"
        : "full-resolution rendered image not found; expected=" + expectedWidth + "x" + expectedHeight +
          ", observed=" + observed.join(","));
    }

    let src = candidate.src;
    let naturalWidth = candidate.naturalWidth;
    let naturalHeight = candidate.naturalHeight;
    if (candidate.kind === "canvas") {
      src = candidate.el.toDataURL("image/png");
    } else {
      if (!naturalWidth || !naturalHeight) {
        const probe = new Image();
        probe.src = src;
        await bounded(() => probe.decode(), 2_000, 'decode', () => { probe.src = ''; });
        naturalWidth = Number(probe.naturalWidth || 0);
        naturalHeight = Number(probe.naturalHeight || 0);
      }
      if (src.startsWith("blob:")) {
        const controller = new AbortController();
        try {
          const cancel = () => controller.abort();
          const response = await bounded(() => fetch(src, { signal: controller.signal }), 5_000, 'blob fetch', cancel);
          if (!response.ok) throw new Error("rendered blob image fetch failed");
          const blob = await bounded(() => response.blob(), 5_000, 'blob body', cancel);
          const mime = String(blob.type || "").toLowerCase();
          if (!/^image\\/(png|jpeg|jpg|webp)$/.test(mime)) throw new Error("rendered blob image type is unsupported");
          const bytes = new Uint8Array(await bounded(() => blob.arrayBuffer(), 5_000, 'blob bytes', cancel));
          let binary = "";
          for (let index = 0; index < bytes.length; index += 32768) {
            binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
          }
          src = "data:" + mime.replace("image/jpg", "image/jpeg") + ";base64," + btoa(binary);
        } finally {
          controller.abort();
        }
      }
    }
    if (!src.startsWith("data:image/")) throw new Error("rendered image could not be converted to a data URL");
    return {
      src,
      naturalWidth,
      naturalHeight,
      matches_n: eligible.length,
      raw_matches_n: candidates.length,
      variantsCollapsed: candidates.length - unique.length,
      rejectedPreviewDimensions: expectedWidth === null || expectedHeight === null
        ? []
        : unique.filter((item) => item.naturalWidth !== expectedWidth || item.naturalHeight !== expectedHeight)
          .map((item) => item.naturalWidth + "x" + item.naturalHeight),
      nth: ${nth},
      renderKind: candidate.kind,
      sourceFingerprint: candidate.src ? fingerprint(candidate.src) : ""
    };
  })()`;
}

/**
 * ProseMirror/Slate 一类编辑器经常同时渲染桌面与窄屏副本；snapshot ref 会在一次
 * React 重渲染后漂移。这里不向模型开放任意 eval，而是用固定脚本从【当前可见】
 * contenteditable 中选出目标，并临时打上随机属性。
 *
 * NovelAI 的整张表单祖先会同时包含 Base Prompt 与所有 Character N 文案；只按
 * ancestor.innerText 打分会把 Character Prompt 误写进全局编辑器。已知范围因此先用
 * 精确锚点（Base Prompt 页签 / Character N placeholder）找到包含目标页签和编辑器的
 * 最小局部根；只有其它通用页面才回退到祖先语义评分。
 * 随后的 OpenCLI fill 仍负责派发真实键盘/input 事件与自身校验。
 */
function scopedRichTextScopePrelude(scopeText: string, tabText: string): string {
  return `
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
    const wanted = String(${JSON.stringify(scopeText)} || "").split("|").map(normalize).filter(Boolean);
    let wantedTab = normalize(${JSON.stringify(tabText)});
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" &&
        rect.width > 1 && rect.height > 1;
    };
    const exactLabel = (el) => normalize(
      el.getAttribute?.("placeholder") || el.getAttribute?.("aria-label") ||
      el.innerText || el.textContent || ("value" in el ? String(el.value || "") : "")
    );
    const strictCharacter = wanted.length === 1 && /^character\\s+\\d+$/.test(wanted[0]);
    const strictBase = wanted.length === 1 && wanted[0] === "base prompt";
    const anchorPool = strictCharacter
      ? Array.from(document.querySelectorAll('input[placeholder^="Character "]')).filter(visible)
      : Array.from(document.querySelectorAll('button,[role="tab"],[aria-label],[placeholder],h1,h2,h3,label')).filter(visible);
    // The real zero-character UI calls its global field "Prompt", not
    // "Base Prompt". Accept that alias only with the observed global root and
    // no visible character cards; never alias another character's Prompt.
    const globalPromptRoots = strictBase
      ? Array.from(document.querySelectorAll('.prompt-input-box-prompt,.prompt-input-box-undesired-content'))
        .filter(visible).filter(el => !el.closest('.character-prompt-input'))
      : [];
    const simpleBase = strictBase && !anchorPool.some(el => exactLabel(el) === "base prompt") &&
      !Array.from(document.querySelectorAll('.character-prompt-input input[placeholder^="Character "]')).some(visible) &&
      globalPromptRoots.length === 1;
    const simpleBaseRoot = simpleBase ? globalPromptRoots[0] : null;
    if (simpleBase && wantedTab === "base prompt") wantedTab = "prompt";
    const scopeAnchor = (strictCharacter || strictBase)
      ? anchorPool.find((el) => exactLabel(el) === (simpleBase ? "prompt" : wanted[0]))
      : null;
    const scopeRoot = (() => {
      if (!strictCharacter && !strictBase) return null;
      if (!scopeAnchor) return null;
      let node = scopeAnchor.parentElement;
      for (let depth = 0; node && depth <= 16; depth += 1, node = node.parentElement) {
        // A same-named Prompt elsewhere must not stand in for the observed global field.
        if (simpleBaseRoot && !node.contains(simpleBaseRoot)) continue;
        const editors = Array.from(node.querySelectorAll('[contenteditable="true"]')).filter(visible)
          .filter((el) => !strictBase || !el.closest('.character-prompt-input'));
        const tabs = Array.from(node.querySelectorAll('button,[role="tab"]')).filter((el) =>
          visible(el) && (!wantedTab || normalize(el.innerText || el.textContent || "") === wantedTab)
        );
        if (!editors.length || (wantedTab && !tabs.length)) continue;
        if (strictCharacter) {
          const characterInputs = Array.from(node.querySelectorAll('input[placeholder^="Character "]')).filter(visible);
          if (characterInputs.length !== 1 || characterInputs[0] !== scopeAnchor) continue;
        }
        return node;
      }
      return null;
    })();
    if ((strictCharacter || strictBase) && !scopeRoot) {
      throw new Error("exact rich-text scope root not found: " + ${JSON.stringify(scopeText + " / " + tabText)});
    }
    const scopeAllows = (el) => (!scopeRoot || scopeRoot.contains(el)) &&
      (!strictBase || !el.closest('.character-prompt-input'));
    const scopedTabs = (label) => Array.from(document.querySelectorAll('button,[role="tab"]'))
      .filter((el) => visible(el) && scopeAllows(el) && normalize(el.innerText || el.textContent || "") === label);
    const selectedState = (el) => {
      const states = [el?.getAttribute("aria-selected"), el?.getAttribute("aria-pressed")]
        .filter((value) => value === "true" || value === "false");
      return states.includes("false") ? false : states.includes("true") ? true : null;
    };
    const selectionNotContradicted = (tab) => selectedState(tab) !== false &&
      ["prompt", "base prompt", "undesired content"].flatMap(scopedTabs)
        .every((other) => other === tab || selectedState(other) !== true);
    const scopedEditors = () => Array.from(document.querySelectorAll('[contenteditable="true"]'))
      .filter(visible).filter(scopeAllows);
  `;
}

/**
 * NovelAI 的多角色卡是手风琴：名称输入框始终可见，但一次只有一张卡的 Prompt
 * 编辑器展开。prepare_novelai_form 按 Character 1..N 顺序写入时，目标卡可能正处于
 * 折叠态；此前会让精确 scope 误以为 DOM 不存在，模型再退回语义填充后甚至串写到
 * Base Prompt。这里在任何写入前只按 placeholder 身份展开目标卡，不靠 prompt 文本猜。
 */
function expandNovelAiCharacterScopeScript(scopeText: string): string {
  return `(() => {
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
    const wanted = normalize(${JSON.stringify(scopeText)});
    if (!/^character\\s+\\d+$/.test(wanted)) return { applicable: false };
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" &&
        rect.width > 1 && rect.height > 1;
    };
    const anchors = Array.from(document.querySelectorAll('.character-prompt-input input[placeholder^="Character "]'))
      .filter(visible)
      .filter((el) => normalize(el.getAttribute("placeholder")) === wanted);
    if (anchors.length !== 1) throw new Error("exact character card anchor is not unique");
    const card = anchors[0].closest('.character-prompt-input');
    if (!card) throw new Error("exact character card root not found");
    const isExpanded = () =>
      Array.from(card.querySelectorAll('[contenteditable="true"]')).some(visible) &&
      Array.from(card.querySelectorAll('button,[role="tab"]')).some((el) =>
        visible(el) && normalize(el.innerText || el.textContent || "") === "prompt"
      );
    if (isExpanded()) return { applicable: true, expanded: true, clicked: false };
    const candidates = Array.from(card.querySelectorAll('button')).filter(visible)
      .map((el) => ({
        el,
        text: String(el.innerText || el.textContent || "").trim(),
        area: el.getBoundingClientRect().width * el.getBoundingClientRect().height,
      }))
      .filter((row) => row.text && !["prompt", "undesired content"].includes(normalize(row.text)))
      .sort((a, b) => b.area - a.area || b.text.length - a.text.length);
    const toggle = candidates[0]?.el;
    if (!toggle || typeof toggle.click !== "function") throw new Error("collapsed character card toggle not found");
    toggle.scrollIntoView({ behavior: "instant", block: "center" });
    toggle.click();
    return { applicable: true, expanded: false, clicked: true };
  })()`;
}

function scopedRichTextActivateScript(scopeText: string, tabText: string, marker: string): string {
  return `(async () => {
    ${scopedRichTextScopePrelude(scopeText, tabText)}
    const semanticText = (node) => normalize([
      node.innerText || "",
      ...Array.from(node.querySelectorAll('[placeholder],[aria-label]')).filter(visible).flatMap((el) => [
        el.getAttribute("placeholder") || "",
        el.getAttribute("aria-label") || "",
        "value" in el ? String(el.value || "") : ""
      ])
    ].join(" "));
    const score = (el) => {
      let node = el;
      for (let depth = 0; node && depth <= 12; depth += 1, node = node.parentElement) {
        const text = semanticText(node);
        if (wanted.every((term) => text.includes(term))) return { depth, length: text.length };
      }
      return null;
    };
    const candidates = Array.from(document.querySelectorAll('button,[role="tab"]'))
      .filter((el) => visible(el) && scopeAllows(el) && normalize(el.innerText || el.textContent || "") === wantedTab)
      .map((el, order) => ({ el, order, match: scopeRoot ? { depth: 0, length: 0 } : score(el) }))
      .filter((row) => row.match !== null)
      .sort((a, b) => a.match.depth - b.match.depth || a.match.length - b.match.length || a.order - b.order);
    const row = candidates[0];
    if (!row) throw new Error("visible scoped rich-text tab not found");
    if (candidates.length !== 1) throw new Error("scoped rich-text tab is not unique");
    const el = row.el;
    const clickTab = async (tab) => {
      if (tab.disabled === true || tab.getAttribute("aria-disabled") === "true") throw new Error("scoped rich-text tab is disabled");
      if (typeof tab.click !== "function") throw new Error("scoped rich-text tab is not clickable");
      tab.scrollIntoView({ behavior: "instant", block: "center" });
      tab.click();
      await new Promise((resolve) => setTimeout(resolve, 250));
    };
    const onlyEditor = () => {
      const editors = scopedEditors();
      if (editors.length !== 1) throw new Error("scoped rich-text editor is not unique");
      return editors[0];
    };
    let selectionProof = "aria";
    if (selectedState(el) !== null) {
      await clickTab(el);
      if (selectedState(el) !== true || !selectionNotContradicted(el)) throw new Error("requested rich-text tab is not selected");
    } else {
      // NovelAI's observed no-ARIA cards use two persistent editors with visibility toggles.
      // Prove that exact opposite/target clicks switch between them; a no-op click,
      // a shared editor without a selection signal, or a transition overlap is unsafe.
      const otherLabel = wantedTab === "undesired content"
        ? (strictCharacter || simpleBase ? "prompt" : strictBase ? "base prompt" : "")
        : (wantedTab === "prompt" || wantedTab === "base prompt") ? "undesired content" : "";
      const otherTabs = otherLabel ? scopedTabs(otherLabel) : [];
      if (otherTabs.length !== 1 || !scopeRoot) throw new Error("rich-text tab selection cannot be established");
      await clickTab(otherTabs[0]);
      const otherEditor = onlyEditor();
      await clickTab(el);
      const targetEditor = onlyEditor();
      if (targetEditor === otherEditor || !scopeRoot.contains(otherEditor) || visible(otherEditor)) {
        throw new Error("rich-text tab did not switch to a distinct editor");
      }
      selectionProof = "editor-switch";
    }
    const editor = onlyEditor();
    editor.setAttribute("data-harbour-richtext-tab-proof", ${JSON.stringify(marker)} + ":" + selectionProof);
    return {
      activated: true,
      selectionProof,
      scopeText: ${JSON.stringify(scopeText)},
      tabText: ${JSON.stringify(tabText)},
      scopeMode: scopeRoot ? "exact-anchor" : "semantic-fallback",
      scopedMatches: candidates.length,
      tag: String(el.tagName || "").toLowerCase(),
      text: String(el.innerText || el.textContent || "").trim().slice(0, 240)
    };
  })()`;
}

function scopedRichTextTargetScript(scopeText: string, tabText: string, nth: number, marker: string): string {
  return `(() => {
    ${scopedRichTextScopePrelude(scopeText, tabText)}
    const semanticText = (node) => normalize([
      node.innerText || "",
      ...Array.from(node.querySelectorAll('[placeholder],[aria-label]')).filter(visible).flatMap((el) => [
        el.getAttribute("placeholder") || "",
        el.getAttribute("aria-label") || "",
        "value" in el ? String(el.value || "") : ""
      ])
    ].join(" "));
    const score = (el) => {
      if (!wanted.length) return { depth: 0, length: 0 };
      let node = el;
      for (let depth = 0; node && depth <= 10; depth += 1, node = node.parentElement) {
        const text = semanticText(node);
        if (wanted.every((term) => text.includes(term))) return { depth, length: text.length };
      }
      return null;
    };
    const visibleEditors = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(visible);
    const candidates = visibleEditors.filter(scopeAllows)
      .map((el, order) => ({ el, order, match: scopeRoot ? { depth: 0, length: 0 } : score(el) }))
      .filter((row) => row.match !== null)
      .sort((a, b) => a.match.depth - b.match.depth || a.match.length - b.match.length || a.order - b.order);
    const proof = candidates[0]?.el.getAttribute("data-harbour-richtext-tab-proof");
    if (wantedTab && (candidates.length !== 1 || ${nth} !== 0 ||
        ![${JSON.stringify(marker + ":aria")}, ${JSON.stringify(marker + ":editor-switch")}].includes(proof))) {
      throw new Error("selected rich-text editor identity is not unique or verified");
    }
    const row = candidates[${nth}];
    if (!row) throw new Error("visible scoped contenteditable not found");
    document.querySelectorAll('[data-harbour-richtext-target]').forEach((el) => el.removeAttribute('data-harbour-richtext-target'));
    row.el.setAttribute('data-harbour-richtext-target', ${JSON.stringify(marker)});
    row.el.scrollIntoView({ behavior: "instant", block: "center" });
    row.el.focus();
    return {
      targeted: true,
      scopeText: ${JSON.stringify(scopeText)},
      scopeMode: scopeRoot ? "exact-anchor" : "semantic-fallback",
      nth: ${nth},
      visibleEditors: visibleEditors.length,
      scopedMatches: candidates.length,
      tag: String(row.el.tagName || "").toLowerCase(),
      role: row.el.getAttribute("role") || "",
      currentLength: String(row.el.innerText || row.el.textContent || "").length
    };
  })()`;
}

export function scopedRichTextPrepareScript(scopeText: string, tabText: string, nth: number, marker: string): string {
  const expansion = expandNovelAiCharacterScopeScript(scopeText);
  const activation = tabText ? scopedRichTextActivateScript(scopeText, tabText, marker) : "null";
  const target = scopedRichTextTargetScript(scopeText, tabText, nth, marker);
  return `(async () => {
    const characterExpansion = ${expansion};
    if (characterExpansion?.clicked) await new Promise((resolve) => setTimeout(resolve, 350));
    const activation = await ${activation};
    const targeted = ${target};
    return { prepared: true, characterExpansion, activation, targeted };
  })()`;
}

export function scopedRichTextVerifyScript(scopeText: string, tabText: string, nth: number, marker: string, expected: string, retainTarget = false): string {
  return `(() => {
    ${scopedRichTextScopePrelude(scopeText, tabText)}
    const compact = (value) => String(value || "").replace(/\\s+/g, "").trim();
    const semanticText = (node) => [
      node.innerText || "",
      ...Array.from(node.querySelectorAll('[placeholder],[aria-label]')).filter(visible).flatMap((el) => [
        el.getAttribute("placeholder") || "",
        el.getAttribute("aria-label") || "",
        "value" in el ? String(el.value || "") : ""
      ])
    ].join(" ").replace(/\\s+/g, " ").trim().toLowerCase();
    const score = (el) => {
      if (!wanted.length) return { depth: 0, length: 0 };
      let node = el;
      for (let depth = 0; node && depth <= 10; depth += 1, node = node.parentElement) {
        const text = semanticText(node);
        if (wanted.every((term) => text.includes(term))) return { depth, length: text.length };
      }
      return null;
    };
    const marked = document.querySelector('[data-harbour-richtext-target="' + ${JSON.stringify(marker)} + '"]');
    const candidates = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(visible).filter(scopeAllows)
      .map((el, order) => ({ el, order, match: scopeRoot ? { depth: 0, length: 0 } : score(el) }))
      .filter((row) => row.match !== null)
      .sort((a, b) => a.match.depth - b.match.depth || a.match.length - b.match.length || a.order - b.order);
    const el = marked && visible(marked) && scopeAllows(marked) ? marked : wantedTab ? null : candidates[${nth}]?.el;
    const tabs = wantedTab ? scopedTabs(wantedTab) : [];
    const proof = el?.getAttribute("data-harbour-richtext-tab-proof");
    const fieldVerified = !wantedTab || (candidates.length === 1 && tabs.length === 1 &&
      selectionNotContradicted(tabs[0]) && (proof === ${JSON.stringify(marker + ":aria")}
        ? selectedState(tabs[0]) === true : proof === ${JSON.stringify(marker + ":editor-switch")}));
    const actual = String(el?.innerText || el?.textContent || "");
    ${retainTarget ? "" : "document.querySelectorAll('[data-harbour-richtext-target]').forEach((node) => node.removeAttribute('data-harbour-richtext-target'));"}
    document.querySelectorAll('[data-harbour-richtext-tab-proof]').forEach((node) => node.removeAttribute('data-harbour-richtext-tab-proof'));
    return {
      verified: !!el && fieldVerified && compact(actual) === compact(${JSON.stringify(expected)}),
      fieldVerified,
      expectedLength: ${expected.length},
      actualLength: actual.length,
      scopeText: ${JSON.stringify(scopeText)},
      scopeMode: scopeRoot ? "exact-anchor" : "semantic-fallback",
      nth: ${nth},
      scopedMatches: candidates.length
    };
  })()`;
}

async function fillScopedRichText(
  cfg: OpenCliBrowserConfig,
  session: string,
  tab: string | undefined,
  ctx: ToolContext,
  options: { scopeText: string; tabText?: string; text: string; nth?: number; readTokens?: boolean; verifyOnly?: boolean; batchCounter?: boolean }
): Promise<Record<string, unknown>> {
  const { scopeText, tabText, text } = options;
  const nth = options.nth ?? 0;
  const marker = randomUUID();
  const currentSfwCounterLayout = ctx.execution?.novelAiContentRating === "sfw";
  const auditPrepare = `(async () => {
    const prepared = await ${scopedRichTextPrepareScript(scopeText, tabText ?? "", nth, marker)};
    const verification = ${scopedRichTextVerifyScript(scopeText, tabText ?? "", nth, marker, text, true)};
    if (!verification.verified) throw new Error('Frozen prompt changed before token audit; not submitted');
    ${novelAiPromptCounterTargetScript(marker, currentSfwCounterLayout)};
    return {...prepared, verification};
  })()`;
  if (options.batchCounter && options.verifyOnly && options.readTokens && tab) {
    await ensureOpenCliBrowserBridge(cfg, ctx.logger, ctx.signal, ctx.runState);
    const { prepared, counter } = await preparationCommand(ctx, () => runNovelAiPromptCounterBatch({
      entryPath: cfg.opencli.entryPath, profile: cfg.opencli.profile, session, tab,
      idleTimeoutSeconds: cfg.idleTimeoutSeconds, marker, prepareScript: auditPrepare,
      clearScript: novelAiPromptCounterClearScript(), readScript: novelAiPromptCounterReadScript(marker), signal: ctx.signal,
      onDiagnostics(timings) { try { ctx.logger?.info({ timings }, "novelai:counter-diagnostics"); } catch { /* diagnostics only */ } },
    }));
    return { filled: true, verified: true, mode: "scoped-contenteditable", scopeText, nth,
      characterExpansion: prepared.characterExpansion, targeted: prepared.targeted,
      ...(tabText ? { tabText, activation: prepared.activation } : {}),
      fill: { readOnly: true }, verification: prepared.verification,
      tokens: parseNovelAiPromptTokenCounter(counter.text) };
  }
  // 展开角色卡、切换正/反页签、标记唯一编辑器在同一次 browser eval 内完成。
  // 旧实现每个字段启动 3 个 OpenCLI 子进程；两角色 6 个字段会白耗约 40 秒并撞外层超时。
  const prepared = await runOpenCliBrowser(
    cfg,
    session,
    withTab(["eval", options.verifyOnly ? auditPrepare : scopedRichTextPrepareScript(scopeText, tabText ?? "", nth, marker)], tab),
    ctx
  );
  if (!prepared || typeof prepared !== "object" || (prepared as Record<string, unknown>).prepared !== true) {
    throw new Error(`opencli_browser: 无法准备精确 rich-text 目标：${JSON.stringify(prepared).slice(0, 1_000)}`);
  }
  const preparedRow = prepared as Record<string, unknown>;
  const characterExpansion = preparedRow.characterExpansion;
  const activation = preparedRow.activation;
  const targeted = preparedRow.targeted;
  const selector = `[data-harbour-richtext-target="${marker}"]`;
  let filled: unknown;
  let fillError: unknown;
  try {
    filled = options.verifyOnly ? { readOnly: true } : await runOpenCliBrowser(cfg, session, withTab(["fill", selector, text], tab), ctx);
  } catch (error) {
    fillError = error;
    filled = recoverContentEditableFill(error, text);
  }
  const verification = options.verifyOnly ? preparedRow.verification : await runOpenCliBrowser(
    cfg,
    session,
    withTab(["eval", scopedRichTextVerifyScript(scopeText, tabText ?? "", nth, marker, text, options.readTokens)], tab),
    ctx
  );
  const row = verification && typeof verification === "object"
    ? verification as Record<string, unknown>
    : undefined;
  if (row?.verified !== true) {
    const detail = fillError instanceof Error ? fillError.message : JSON.stringify(filled);
    throw new Error(
      `opencli_browser: fill_richtext 未通过精确回读；${detail.slice(0, 1_000)}；verification=${JSON.stringify(verification).slice(0, 2_000)}`
    );
  }
  let tokens: ReturnType<typeof parseNovelAiPromptTokenCounter> | undefined;
  if (options.readTokens) {
    if (!options.verifyOnly) await runOpenCliBrowser(cfg, session, withTab(["eval", novelAiPromptCounterTargetScript(marker, currentSfwCounterLayout)], tab), ctx);
    // First leave the previous meter, then hover this field's unique meter.
    await runOpenCliBrowser(cfg, session, withTab(["hover", selector], tab), ctx);
    await runOpenCliBrowser(cfg, session, withTab(["eval", novelAiPromptCounterClearScript()], tab), ctx);
    await runOpenCliBrowser(cfg, session, withTab(["hover", `[data-harbour-token-target="${marker}"]`], tab), ctx);
    const counter = await runOpenCliBrowser(cfg, session, withTab(["eval", novelAiPromptCounterReadScript(marker)], tab), ctx);
    tokens = parseNovelAiPromptTokenCounter(String((counter as Record<string, unknown>)?.text ?? ""));
  }
  return {
    filled: true,
    verified: true,
    mode: "scoped-contenteditable",
    scopeText,
    ...(characterExpansion ? { characterExpansion } : {}),
    ...(tabText ? { tabText, activation } : {}),
    nth,
    targeted,
    fill: filled,
    verification,
    ...(tokens ? { tokens } : {}),
  };
}

function characterPromptInventoryScript(): string {
  return `(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" &&
        rect.width > 1 && rect.height > 1;
    };
    const inputs = Array.from(document.querySelectorAll('.character-prompt-input input[placeholder^="Character "]'))
      .filter(visible);
    return {
      count: inputs.length,
      characters: inputs.map((input) => ({
        placeholder: String(input.getAttribute("placeholder") || ""),
        value: "value" in input ? String(input.value || "") : ""
      }))
    };
  })()`;
}

/** Malformed batch output is never permission to replay its mutating steps. */
export function requireNovelAiPreparationBatchReceipt(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || fields.some(field => {
    const part = (value as Record<string, unknown>)[field];
    return !part || typeof part !== "object" || Array.isArray(part);
  })) throw new NovelAiPreparationBatchReceiptError();
  return value as Record<string, unknown>;
}

function removeLastCharacterPromptScript(): string {
  return `(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" &&
        rect.width > 1 && rect.height > 1;
    };
    const cards = Array.from(document.querySelectorAll('.character-prompt-input')).filter(visible);
    const card = cards[cards.length - 1];
    if (!card) return { removed: false, before: 0 };
    const input = card.querySelector('input[placeholder^="Character "]');
    const header = input?.parentElement?.parentElement;
    if (!header || !card.contains(header)) throw new Error("character prompt header not found");
    // NovelAI 当前角色卡头部固定依次为：上移、下移、复制、删除、角色类型。
    // 多卡时上/下移会从 disabled 变成 enabled，因此不能按“第几个可用按钮”猜；
    // 无障碍 snapshot 又会漏掉删除键，只能在已锁定角色卡头部内取第 4 个 icon-only
    // 按钮，并在点击后由工具层验证卡片数确实减少。
    const iconButtons = Array.from(header.querySelectorAll('button')).filter((button) =>
      visible(button) && !String(button.innerText || button.textContent || "").trim()
    );
    const deleteButton = iconButtons[3];
    if (!deleteButton) throw new Error("character prompt delete control not found");
    const placeholder = String(input?.getAttribute("placeholder") || "");
    deleteButton.scrollIntoView({ behavior: "instant", block: "center" });
    deleteButton.click();
    return { removed: true, before: cards.length, placeholder, iconButtons: iconButtons.length };
  })()`;
}

function openCharacterPromptMenuScript(): string {
  return `(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" &&
        rect.width > 1 && rect.height > 1;
    };
    const panels = Array.from(document.querySelectorAll('.image-gen-character-prompts')).filter(visible);
    const panel = panels[0];
    const header = panel?.querySelector('.image-gen-character-prompts-header');
    const addButton = Array.from(header?.querySelectorAll('button') || [])
      .find((button) => visible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true");
    if (!addButton) throw new Error("character prompt add control not found");
    addButton.scrollIntoView({ behavior: "instant", block: "center" });
    addButton.click();
    return { opened: true };
  })()`;
}

function selectCharacterPromptGenderScript(gender: "female" | "male" | "other"): string {
  const label = gender === "female" ? "Female" : gender === "male" ? "Male" : "Other";
  return `(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" &&
        rect.width > 1 && rect.height > 1;
    };
    const wanted = ${JSON.stringify(label)};
    const buttons = Array.from(document.querySelectorAll('button')).filter((button) =>
      visible(button) && String(button.innerText || button.textContent || "").replace(/\\s+/g, " ").trim() === wanted
    );
    const button = buttons[0];
    if (!button) throw new Error("character gender option not found");
    button.click();
    return { selected: true, gender: ${JSON.stringify(gender)}, matches_n: buttons.length };
  })()`;
}

function configureNovelAiStableFieldsScript(options: {
  characterNames?: string[];
  orientation?: "landscape" | "portrait" | "square";
  width?: number;
  height?: number;
  numberOfImages?: number;
}): string {
  const requested = JSON.stringify(options);
  return [
    "(() => {",
    "const requested = " + requested + ";",
    "const visible = (el) => { const style = getComputedStyle(el); const rect = el.getBoundingClientRect(); return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 1 && rect.height > 1; };",
    "const textOf = (el) => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();",
    "const setInputValue = (input, value) => {",
    "  const next = String(value);",
    "  if (String(input.value || '') === next) return false;",
    "  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;",
    "  if (!setter) throw new Error('native input value setter unavailable');",
    "  input.focus(); setter.call(input, next);",
    "  input.dispatchEvent(new Event('input', { bubbles: true }));",
    "  input.dispatchEvent(new Event('change', { bubbles: true }));",
    "  input.blur(); return true;",
    "};",
    "const characterInputs = Array.from(document.querySelectorAll('.character-prompt-input input[placeholder^=\"Character \"]')).filter(visible);",
    "if (requested.characterNames) {",
    "  if (characterInputs.length !== requested.characterNames.length) throw new Error('character name count mismatch');",
    "  characterInputs.forEach((input, index) => setInputValue(input, requested.characterNames[index]));",
    "}",
    "const numericInputs = Array.from(document.querySelectorAll('input[type=\"number\"],input[inputmode=\"numeric\"]')).filter(visible);",
    "const labelOf = (input) => String(input.getAttribute('aria-label') || input.getAttribute('name') || input.labels?.[0]?.textContent || '').replace(/\\s+/g, ' ').trim();",
    "const widthInput = numericInputs.find((input) => /^(?:width|w|宽)$/i.test(labelOf(input)));",
    "const heightInput = numericInputs.find((input) => /^(?:height|h|高)$/i.test(labelOf(input)));",
    "const currentWidth = Number(widthInput?.value); const currentHeight = Number(heightInput?.value);",
    "let wantedWidth = requested.width; let wantedHeight = requested.height;",
    "if (wantedWidth === undefined && wantedHeight === undefined && widthInput && heightInput && Number.isFinite(currentWidth) && Number.isFinite(currentHeight)) {",
    "  if (requested.orientation === 'portrait' && currentWidth > currentHeight) { wantedWidth = currentHeight; wantedHeight = currentWidth; }",
    "  else if (requested.orientation === 'landscape' && currentWidth < currentHeight) { wantedWidth = currentHeight; wantedHeight = currentWidth; }",
    "  else if (requested.orientation === 'square' && currentWidth !== currentHeight) { wantedWidth = Math.min(currentWidth, currentHeight); wantedHeight = wantedWidth; }",
    "}",
    "if (wantedWidth !== undefined) { if (!widthInput) throw new Error('NovelAI width input not found'); setInputValue(widthInput, wantedWidth); }",
    "if (wantedHeight !== undefined) { if (!heightInput) throw new Error('NovelAI height input not found'); setInputValue(heightInput, wantedHeight); }",
    "let imageCountChanged = false;",
    "if (requested.numberOfImages !== undefined) {",
    "  const generateText = Array.from(document.querySelectorAll('button,[role=\"button\"]')).filter(visible).map(textOf).find((text) => /^Generate(?:\\s|$)/i.test(text)) || '';",
    "  const currentCount = Number(/Generate\\s+(\\d+)\\s+Images?/i.exec(generateText)?.[1]);",
    "  if (currentCount !== requested.numberOfImages) {",
    "    const candidates = Array.from(document.querySelectorAll('button,[role=\"button\"]')).filter((button) => visible(button) && textOf(button) === String(requested.numberOfImages));",
    "    const inNumberRegion = (button) => { let cursor = button.parentElement; for (let depth = 0; cursor && depth < 6; depth += 1, cursor = cursor.parentElement) { if (/Number of Images/i.test(textOf(cursor))) return true; } return false; };",
    "    const button = candidates.find(inNumberRegion); if (!button) throw new Error('NovelAI Number of Images control not found');",
    "    button.click(); imageCountChanged = true;",
    "  }",
    "}",
    "return { configured: true, requested, before: { width: currentWidth, height: currentHeight }, intended: { width: wantedWidth ?? currentWidth, height: wantedHeight ?? currentHeight }, characterNames: requested.characterNames || [], imageCountChanged };",
    "})()",
  ].join("\n");
}

function novelAiReferenceInventoryScript(sfw = false): string {
  return `(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" &&
        rect.width > 1 && rect.height > 1;
    };
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
    const precisePreviews = new Set(Array.from(document.querySelectorAll('.image-gen-character-references')).filter(visible)
      .flatMap(root => Array.from(root.querySelectorAll('img,[style*="background-image"]')).filter(visible))
      .map(el => el.tagName === 'IMG' ? el.currentSrc || el.src : getComputedStyle(el).backgroundImage).filter(Boolean));
    const referenceRoot = (el) => el.closest?.(
      '.image-gen-input-image,#reference-images,[data-reference-images]'
    ) || null;
    const resetLabels = new Set([
      "deselect image",
      "deselect reference image",
      "remove reference image",
      "clear reference image"
    ]);
    const controls = Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible)
      .map((el) => ({
        el,
        label: normalize(el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent)
      }))
      .filter((row) => resetLabels.has(row.label) && !!referenceRoot(row.el));
    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'))
      .filter((input) => {
        const accept = normalize(input.getAttribute("accept"));
        const hasImageContract = !accept || accept.includes("image") || accept.includes("png") ||
          accept.includes("jpeg") || accept.includes("jpg") || accept.includes("webp");
        return hasImageContract && ((input.files?.length || 0) > 0 || !!input.value);
      });
    const vibe = ${sfw ? novelAiSfwVibeScript() : 'null'};
    return {
      active: controls.length + fileInputs.length + precisePreviews.size + (vibe?.active || 0),
      ...(vibe ? {vibeReferences:vibe.active} : {}),
      preciseReferences: precisePreviews.size,
      deselectControls: controls.map((row) => row.label),
      activeFileInputs: fileInputs.map((input) => ({
        files: input.files?.length || 0,
        name: input.files?.[0]?.name || "",
        accept: input.getAttribute("accept") || ""
      }))
    };
  })()`;
}

function clearOneNovelAiReferenceScript(sfw = false): string {
  return `(() => {
    const precise = ${novelAiClearPreciseReferenceScript()};
    if (precise.clicked) return { cleared: true, mode: "precise-reference-delete" };
    const vibe = ${sfw ? novelAiSfwVibeScript(true) : 'null'};
    if(vibe?.clicked)return {cleared:true,mode:"sfw-vibe-reference-delete"};
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" &&
        rect.width > 1 && rect.height > 1;
    };
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
    const referenceRoot = (el) => el.closest?.(
      '.image-gen-input-image,#reference-images,[data-reference-images]'
    ) || null;
    const resetLabels = new Set([
      "deselect image",
      "deselect reference image",
      "remove reference image",
      "clear reference image"
    ]);
    const control = Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible)
      .map((el) => ({
        el,
        label: normalize(el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent)
      }))
      .find((row) => resetLabels.has(row.label) && !!referenceRoot(row.el));
    if (control) {
      control.el.scrollIntoView({ behavior: "instant", block: "center" });
      control.el.click();
      return { cleared: true, mode: "deselect-control", label: control.label };
    }
    const input = Array.from(document.querySelectorAll('input[type="file"]')).find((candidate) => {
      const accept = normalize(candidate.getAttribute("accept"));
      const hasImageContract = !accept || accept.includes("image") || accept.includes("png") ||
        accept.includes("jpeg") || accept.includes("jpg") || accept.includes("webp");
      return hasImageContract && ((candidate.files?.length || 0) > 0 || !!candidate.value);
    });
    if (input) {
      const previous = input.files?.[0]?.name || input.value || "selected image";
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { cleared: true, mode: "file-input", previous };
    }
    return { cleared: false, mode: "none" };
  })()`;
}

/**
 * NovelAI 高频只读状态的固定检查。它只返回生成所需的小型事实集，不把整页 DOM、账号
 * Cookie 或无关文本交给模型；成本核对、旧表单判断与结果判断因此无需反复 state。
 */
function inspectNovelAiScript(): string {
  return `(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" &&
        rect.width > 1 && rect.height > 1;
    };
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const lower = (value) => normalize(value).toLowerCase();
    const textOf = (el) => normalize(el?.getAttribute?.("aria-label") || el?.getAttribute?.("title") ||
      el?.innerText || el?.textContent || ("value" in (el || {}) ? String(el.value || "") : ""));
    const bodyText = normalize(document.body?.innerText || "");
    const unique = (items) => [...new Set(items.filter(Boolean))];
    const visibleControls = Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible);
    const generate = visibleControls.find((el) => /^generate(?:\\s|$)/i.test(textOf(el))) || null;
    const generateText = textOf(generate);
    const costMatch = /(?:generate[^0-9]{0,40})?(\\d[\\d,]*)\\s*anlas/i.exec(generateText);
    const issueTexts = unique(Array.from(document.querySelectorAll(
      '[role="alert"],[class*="banner"],[class*="warning"],[class*="notification"]'
    )).filter(visible).map(textOf).filter((text) => /backend|connect|issue|warning|error/i.test(text))).slice(0, 6);
    const dialogs = unique(Array.from(document.querySelectorAll(
      '[role="dialog"],[aria-modal="true"],[class*="modal"],[class*="chargebee"]'
    )).filter(visible).map(textOf).filter(Boolean)).slice(0, 4);
    const characterInputs = Array.from(document.querySelectorAll(
      '.character-prompt-input input[placeholder^="Character "]'
    )).filter(visible);
    const referenceRoot = (el) => el.closest?.(
      '.image-gen-input-image,#reference-images,[data-reference-images]'
    ) || null;
    const referenceControls = visibleControls.filter((el) =>
      /^(deselect|remove|clear).*(image|reference)/i.test(textOf(el)) && !!referenceRoot(el)
    );
    const referenceFiles = Array.from(document.querySelectorAll('input[type="file"]')).filter((input) =>
      (input.files?.length || 0) > 0 || !!input.value
    );
    const selectedModelRaw = Array.from(document.querySelectorAll(
      '[aria-selected="true"],[aria-pressed="true"],option:checked'
    )).filter(visible).map(textOf).find((text) => /diffusion|nai|v5|v4|anime/i.test(text)) ||
      Array.from(document.querySelectorAll('[id*="aria-selection"],[id*="live-region"]'))
        .map(textOf).find((text) => /nai-diffusion-\\d|v5 full|v4/i.test(text)) ||
      Array.from(document.querySelectorAll('input[aria-label="Select the Model"]'))
        .map((input) => textOf(input.closest('[class*="-control"]'))).find((text) => /v5 full|v4|diffusion/i.test(text)) ||
      (/NAI\\s+Diffusion\\s+V?\\d[^|]{0,40}/i.exec(bodyText)?.[0] || "") ||
      (/\\bV5\\s+Full\\b/i.test(bodyText) ? "V5 Full" : "");
    const selectedModel = /nai-diffusion-5-full|v5\\s+full/i.test(selectedModelRaw)
      ? "NAI Diffusion V5 Full"
      : selectedModelRaw;
    const numericInputs = Array.from(document.querySelectorAll('input[type="number"],input[inputmode="numeric"]'))
      .filter(visible).map((input) => ({
        label: textOf(input.labels?.[0]) || normalize(input.getAttribute("aria-label") || input.getAttribute("name")),
        value: String(input.value || "")
      }));
    const findNumeric = (pattern) => numericInputs.find((row) => pattern.test(row.label))?.value || null;
    const historyAnchors = Array.from(document.querySelectorAll('h1,h2,h3,h4,[role="heading"],button'))
      .filter(visible).filter((el) => /^history$/i.test(textOf(el)));
    const historyRoot = historyAnchors[0]?.closest('section,aside,div') || null;
    const historyImages = historyRoot ? Array.from(historyRoot.querySelectorAll('img')).filter(visible) : [];
    const resultImages = Array.from(document.querySelectorAll('img')).filter((img) =>
      visible(img) && Number(img.naturalWidth || img.width || 0) >= 256 && Number(img.naturalHeight || img.height || 0) >= 256
    );
    const promptEditors = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(visible);
    const loginFormVisible = Array.from(document.querySelectorAll('input[type="password"]')).some(visible);
    const loginActionVisible = visibleControls.some((el) => /^(?:log\\s?in|sign\\s?in|login|signin|登录)$/i.test(textOf(el)));
    const challengeVisible = Array.from(document.querySelectorAll(
      'iframe[src*="captcha"],iframe[src*="challenge"],[data-sitekey],[class*="captcha"]'
    )).some(visible);
    const expiredNoticeVisible = [...issueTexts, ...dialogs].some((value) =>
      /session expired|please (?:log|sign) in|authentication required|登录失效|会话已过期/i.test(value));
    const allAnlas = unique([
      ...[...bodyText.matchAll(/(\\d[\\d,]*)\\s*Anlas/gi)].map((match) => match[1]),
      ...[...bodyText.matchAll(/Anlas\\s*:?\\s*(\\d[\\d,]*)/gi)].map((match) => match[1])
    ]).slice(0, 8);
    const balanceMatch = /Anlas\\s*:?\\s*(\\d[\\d,]*)/i.exec(bodyText);
    const balanceAnlas = balanceMatch
      ? Number(balanceMatch[1].replace(/,/g, ""))
      : Math.max(0, ...allAnlas.map((value) => Number(value.replace(/,/g, ""))).filter(Number.isFinite));
    const precise = ${novelAiReferenceSnapshotScript()};
    return {
      inspected: true,
      page: { title: String(document.title || "").slice(0, 160), url: String(location.href || "").slice(0, 500) },
      auth: { loginFormVisible, loginActionVisible, challengeVisible, expiredNoticeVisible },
      account: { balanceAnlas, anlasValues: allAnlas },
      warnings: issueTexts,
      overlay: { active: dialogs.length > 0, dialogs },
      form: {
        model: selectedModel,
        characters: characterInputs.map((input) => ({
          placeholder: String(input.getAttribute("placeholder") || ""),
          value: String(input.value || "").slice(0, 120),
          gender: String(input.closest('.character-prompt-input')?.getAttribute('data-gender') || "")
        })),
        references: {
          active: referenceControls.length + referenceFiles.length + precise.fingerprints.length,
          precise: { verifiedPreviews: precise.fingerprints.length, pending: precise.pending,
            invalidModes: precise.invalidModes, disabled: precise.disabledReferences, panels: precise.panelCount },
          controls: referenceControls.map(textOf),
          files: referenceFiles.map((input) => input.files?.[0]?.name || "selected")
        },
        resolution: {
          width: findNumeric(/^(?:width|w|宽)$/i),
          height: findNumeric(/^(?:height|h|高)$/i),
          numberOfImages: findNumeric(/number.*image|images|数量/i)
        },
        visiblePromptEditors: promptEditors.length,
        promptLengths: promptEditors.map((editor) => normalize(editor.innerText || editor.textContent).length).slice(0, 16)
      },
      generation: {
        button: generate ? {
          text: generateText.slice(0, 240),
          disabled: generate.disabled === true || generate.getAttribute("aria-disabled") === "true",
          costAnlas: costMatch ? Number(costMatch[1].replace(/,/g, "")) : null
        } : null,
        numberOfImages: /generate\\s+(\\d+)\\s+images?/i.test(generateText)
          ? Number(/generate\\s+(\\d+)\\s+images?/i.exec(generateText)?.[1])
          : null,
        busy: !!generate && /generating|cancel|stop|queue/i.test(generateText),
        historyImages: historyImages.length,
        visibleResultImages: resultImages.length
      }
    };
  })()`;
}

function observeNovelAiAuthentication(ctx: ToolContext, inspection: unknown) {
  const issue = novelAiAuthenticationIssue(inspection);
  const key = novelAiAuthenticationFailureKey(ctx.execution?.novelAiSubmission);
  if (issue && key && ctx.execution) {
    ctx.execution.toolEvidence ??= new Map();
    ctx.execution.toolEvidence.set(key, issue);
  }
  return issue;
}

async function assertNovelAiAuthentication(cfg: OpenCliBrowserConfig, session: string,
  tab: string | undefined, ctx: ToolContext): Promise<void> {
  const inspection = await runOpenCliBrowser(cfg, session, withTab(["eval", inspectNovelAiScript()], tab), ctx);
  if (!inspection || typeof inspection !== "object" || (inspection as Record<string, unknown>).inspected !== true) {
    throw new Error("opencli_browser: NovelAI 登录预检无法读取页面；未提交 Generate。");
  }
  const issue = observeNovelAiAuthentication(ctx, inspection);
  if (issue) throw new Error(issue.reason);
}

/**
 * NovelAI 的 Generate 是高价值、不可重放的固定动作。让模型先 state/find 再拼 selector
 * 容易遇到 React 重渲染后的旧 ref，也会诱发 click/activate 双试。这个脚本在同一次 DOM
 * 执行里重新核对按钮、张数与页面真实成本，然后只点击一次。
 */
export function boundedNovelAiSubmission(
  input: Record<string, unknown>, limit?: NovelAiSubmissionLimit,
): { maxCostAnlas: number; expectedImages?: number; otherReservedAnlas?: number } {
  const cost = input.maxCostAnlas;
  const maxCostAnlas = typeof cost === "number" || (typeof cost === "string" && cost.trim()) ? Number(cost) : NaN;
  if (!Number.isInteger(maxCostAnlas) || maxCostAnlas < 0 || maxCostAnlas > 1_000_000) {
    throw new Error("opencli_browser: generate_novelai 需要有效的 maxCostAnlas");
  }
  const expectedImages = input.numberOfImages === undefined ? undefined : Number(input.numberOfImages);
  if (expectedImages !== undefined && (!Number.isInteger(expectedImages) || expectedImages < 1 || expectedImages > 4)) {
    throw new Error("opencli_browser: generate_novelai 的 numberOfImages 必须为 1–4");
  }
  if (!limit) return { maxCostAnlas, expectedImages };
  if (!Number.isInteger(limit.maxCostAnlas) || limit.maxCostAnlas < 0 ||
      !Number.isInteger(limit.numberOfImages) || limit.numberOfImages < 1 || limit.numberOfImages > 4) {
    throw new Error("opencli_browser: Workflow 下授的生成边界无效");
  }
  if (input.onceKey !== limit.onceKey) throw new Error("opencli_browser: onceKey 与 Workflow 当前组不一致");
  if (limit.otherReservedAnlas !== undefined && (!Number.isSafeInteger(limit.otherReservedAnlas) || limit.otherReservedAnlas < 0)) throw new Error("Workflow 余额预留无效");
  if (expectedImages !== undefined && expectedImages !== limit.numberOfImages) {
    throw new Error("opencli_browser: 张数与 Workflow 当前组不一致");
  }
  return { maxCostAnlas: Math.min(maxCostAnlas, limit.maxCostAnlas), expectedImages: limit.numberOfImages,
    ...(limit.otherReservedAnlas ? { otherReservedAnlas: limit.otherReservedAnlas } : {}) };
}

export function novelAiGenerateScript(maxCostAnlas: number, expectedImages?: number, otherReservedAnlas = 0,
  expectedResolution?: { width: number; height: number }, expectedReferences?: string[], expectedModel?: string, promptBudgetNonce?: string): string {
  return `(() => {
    ${promptBudgetNonce ? `${novelAiPromptBudgetProofScript(promptBudgetNonce)};` : ""}
    ${expectedModel ? `if (!${novelAiModelCheckScript(expectedModel)}.modelMatches) throw new Error("NovelAI model changed before submit; not submitted");` : ""}
    ${expectedReferences?.length ? `if (!${novelAiPreciseReferenceModelCheckScript()}.modelMatches) throw new Error("NovelAI model does not support frozen references; not submitted");` : ""}
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" &&
        rect.width > 1 && rect.height > 1;
    };
    const textOf = (el) => String(el?.getAttribute?.("aria-label") || el?.getAttribute?.("title") ||
      el?.innerText || el?.textContent || "").replace(/\\s+/g, " ").trim();
    ${expectedReferences === undefined ? "" : `${novelAiSubmissionGuardScript()};`}
    ${expectedReferences === undefined ? "" : `const currentReferences = ${novelAiReferenceSnapshotScript()};
    if (currentReferences.pending || currentReferences.invalidModes || currentReferences.invalidPreviews || currentReferences.disabledReferences || currentReferences.panelCount > 1 || JSON.stringify(currentReferences.fingerprints) !== ${JSON.stringify(JSON.stringify([...expectedReferences].sort()))}) throw new Error("NovelAI reference state changed before submit; not submitted");`}
    ${expectedResolution ? `const expectedResolution = ${JSON.stringify(expectedResolution)};
    const numericInputs = Array.from(document.querySelectorAll('input[type="number"],input[inputmode="numeric"]')).filter(visible);
    const labelOf = (el) => String(el.getAttribute('aria-label') || el.getAttribute('name') || el.labels?.[0]?.textContent || '').trim();
    const widthInput = numericInputs.find(el => /^(?:width|w|宽)$/i.test(labelOf(el)));
    const heightInput = numericInputs.find(el => /^(?:height|h|高)$/i.test(labelOf(el)));
    if (!widthInput || !heightInput || Number(widthInput.value) !== expectedResolution.width || Number(heightInput.value) !== expectedResolution.height) throw new Error("NovelAI resolution changed before submit; not submitted");` : ""}
    const button = Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible)
      .find((el) => /^generate(?:\\s|$)/i.test(textOf(el)));
    if (!button) throw new Error("NovelAI Generate button not found");
    const text = textOf(button);
    if (button.disabled === true || button.getAttribute("aria-disabled") === "true") {
      throw new Error("NovelAI Generate button is disabled");
    }
    if (/generating|cancel|stop|queue/i.test(text)) throw new Error("NovelAI generation is already busy");
    const costMatch = /(\\d[\\d,]*)\\s*anlas/i.exec(text);
    if (!costMatch) throw new Error("NovelAI displayed Anlas cost is unknown");
    const costAnlas = Number(costMatch[1].replace(/,/g, ""));
    if (!Number.isFinite(costAnlas) || costAnlas < 0) throw new Error("NovelAI displayed Anlas cost is invalid");
    if (costAnlas > ${JSON.stringify(maxCostAnlas)}) {
      throw new Error("NovelAI displayed cost exceeds authorized maximum");
    }
    if (${JSON.stringify(otherReservedAnlas)} > 0 && costAnlas > 0) {
      const balanceMatch = /Anlas\\s*:?\\s*(\\d[\\d,]*)/i.exec(String(document.body?.innerText || ""));
      const balance = balanceMatch ? Number(balanceMatch[1].replace(/,/g, "")) : NaN;
      if (!Number.isFinite(balance) || balance < costAnlas + ${JSON.stringify(otherReservedAnlas)}) throw new Error("NovelAI balance cannot cover other outstanding reservations; not submitted");
    }
    const countMatch = /generate\\s+(\\d+)\\s+images?/i.exec(text);
    const numberOfImages = countMatch ? Number(countMatch[1]) : 1;
    ${expectedImages === undefined ? "" : `if (numberOfImages !== ${JSON.stringify(expectedImages)}) throw new Error("NovelAI image count changed before submit");`}
    button.scrollIntoView({ behavior: "instant", block: "center" });
    ${expectedReferences === undefined ? "button.click();" : `const submissionGuard = globalThis.__harbourNovelAiSubmissionGuard;
    submissionGuard.allowedClick = button;
    try { button.click(); }
    finally { submissionGuard.allowedClick = null; submissionGuard.allowSubmit = false; }`}
    return {
      activated: true,
      text: text.slice(0, 240),
      costAnlas,
      numberOfImages,
      maxCostAnlas: ${JSON.stringify(maxCostAnlas)}
    };
  })()`;
}

/** Book the price observed by the atomic click, never an earlier page inspection. */
export function confirmedNovelAiSubmission(result: unknown, maxCostAnlas: number, expectedImages?: number): { costAnlas: number; numberOfImages: number } {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const cost = record.costAnlas, count = record.numberOfImages;
  if (record.activated !== true || typeof cost !== "number" || !Number.isSafeInteger(cost) || cost < 0 || cost > maxCostAnlas ||
    typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > 4 || (expectedImages !== undefined && expectedImages !== count)) {
    throw new Error("NovelAI 原子提交回执不完整；是否提交/扣费未知，不可用旧报价记账或再次 Generate");
  }
  return { costAnlas: cost, numberOfImages: count };
}

function imageKind(bytes: Buffer): "png" | "jpeg" | "webp" | null {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

interface MaterializedAttachment {
  index: number;
  attachment: Attachment;
  filePath: string;
  kind: "png" | "jpeg" | "webp";
  size: number;
  source: "local-upload" | "channel-cdn" | "character-library";
}

function materializedAttachments(ctx: ToolContext): Map<number, MaterializedAttachment> {
  ctx.runState ??= new Map<string, unknown>();
  const existing = ctx.runState.get(MATERIALIZED_ATTACHMENTS_KEY);
  if (existing instanceof Map) return existing as Map<number, MaterializedAttachment>;
  const cache = new Map<number, MaterializedAttachment>();
  ctx.runState.set(MATERIALIZED_ATTACHMENTS_KEY, cache);
  return cache;
}

function grantedAttachment(ctx: ToolContext, raw: unknown): { index: number; attachment: Attachment } {
  const attachments = ctx.attachments ?? [];
  if (!attachments.length) {
    throw new Error("opencli_browser: 本轮没有可上传的用户图片附件");
  }
  if (raw === undefined || raw === null || raw === "") {
    if (attachments.length !== 1) {
      throw new Error("opencli_browser: 本轮有多个附件，upload_attachment 必须指定 attachment 索引或精确文件名");
    }
    return { index: 0, attachment: attachments[0]! };
  }
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0 || raw >= attachments.length) {
      throw new Error(`opencli_browser: attachment 索引超出范围（本轮共 ${attachments.length} 个）`);
    }
    return { index: raw, attachment: attachments[raw]! };
  }
  if (typeof raw !== "string" || raw.length > 500) {
    throw new Error("opencli_browser: attachment 只接受非负索引或本轮附件的精确文件名");
  }
  const matches = attachments
    .map((attachment, index) => ({ attachment, index }))
    .filter((entry) => entry.attachment.name === raw);
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? "opencli_browser: 同名附件不唯一，请改用 attachment 数字索引"
      : `opencli_browser: 本轮不存在名为「${raw}」的附件`);
  }
  return matches[0]!;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function verifiedLocalAttachment(
  cfg: OpenCliBrowserConfig,
  index: number,
  attachment: Attachment,
  candidate: string
): Promise<MaterializedAttachment> {
  const absolute = path.resolve(candidate);
  const resolved = await realpath(absolute).catch(() => {
    throw new Error(`opencli_browser: 附件文件不存在：${attachment.name}`);
  });
  const roots = await Promise.all(cfg.attachmentRoots.map(async (root) => {
    const absoluteRoot = path.resolve(root);
    return realpath(absoluteRoot).catch(() => absoluteRoot);
  }));
  if (!roots.some((root) => isInside(resolved, root))) {
    throw new Error("opencli_browser: 只允许上传 Harbour 当前附件目录中的文件，不能读取任意本地路径");
  }
  const info = await stat(resolved);
  if (!info.isFile() || info.size <= 0 || info.size > cfg.maxAttachmentBytes) {
    throw new Error(`opencli_browser: 参考图必须是 1–${Math.floor(cfg.maxAttachmentBytes / 1024 / 1024)}MB 的普通文件`);
  }
  const bytes = await readFile(resolved);
  const kind = imageKind(bytes);
  if (!kind) throw new Error("opencli_browser: 参考图文件签名不是受支持的 PNG/JPEG/WebP");
  return { index, attachment, filePath: resolved, kind, size: info.size, source: "local-upload" };
}

function hostnameMatches(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function channelCdnAllowed(channel: string | undefined, url: URL): boolean {
  if (url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (channel === "discord") {
    return ["discordapp.com", "discordapp.net", "discord.com"].some((suffix) => hostnameMatches(hostname, suffix));
  }
  if (channel === "qq") {
    return ["qq.com", "qq.com.cn", "qpic.cn", "gtimg.cn", "qcloud.com"].some((suffix) => hostnameMatches(hostname, suffix));
  }
  return false;
}

async function fetchGrantedChannelImage(
  cfg: OpenCliBrowserConfig,
  ctx: ToolContext,
  index: number,
  attachment: Attachment
): Promise<MaterializedAttachment> {
  let current: URL;
  try {
    current = new URL(attachment.url);
  } catch {
    throw new Error("opencli_browser: 渠道附件 URL 无效，无法暂存参考图");
  }
  const channel = ctx.source?.channel;
  const controller = new AbortController();
  const abort = () => controller.abort(ctx.signal?.reason);
  if (ctx.signal?.aborted) abort();
  else ctx.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("attachment download timeout")), 30_000);
  try {
    let response: Response | undefined;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      if (!channelCdnAllowed(channel, current)) {
        throw new Error(`opencli_browser: ${channel || "unknown"} 渠道不允许从该主机暂存附件`);
      }
      response = await fetch(current, { redirect: "manual", signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location || redirect === 3) throw new Error("opencli_browser: 渠道附件重定向无效或过多");
        current = new URL(location, current);
        continue;
      }
      break;
    }
    if (!response?.ok || !response.body) {
      throw new Error(`opencli_browser: 下载渠道参考图失败（HTTP ${response?.status ?? "unknown"}）`);
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > cfg.maxAttachmentBytes) {
      throw new Error("opencli_browser: 渠道参考图超过 Harbour 上传大小上限");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > cfg.maxAttachmentBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("opencli_browser: 渠道参考图超过 Harbour 上传大小上限");
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, size);
    const kind = imageKind(bytes);
    if (!kind || !bytes.length) throw new Error("opencli_browser: 渠道参考图文件签名不是受支持的 PNG/JPEG/WebP");
    mkdirSync(cfg.attachmentStagingDir, { recursive: true });
    const extension = kind === "jpeg" ? ".jpg" : `.${kind}`;
    const output = path.join(cfg.attachmentStagingDir, `${Date.now()}-${randomUUID().slice(0, 8)}${extension}`);
    await writeFile(output, bytes, { flag: "wx" });
    ctx.deferCleanup?.(`opencli-browser:attachment:${index}`, () => unlink(output).catch(() => undefined));
    return { index, attachment, filePath: output, kind, size, source: "channel-cdn" };
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", abort);
  }
}

async function materializeGrantedAttachment(
  cfg: OpenCliBrowserConfig,
  ctx: ToolContext,
  raw: unknown
): Promise<MaterializedAttachment> {
  const selected = grantedAttachment(ctx, raw);
  if (selected.attachment.kind !== "image") {
    throw new Error("opencli_browser: upload_attachment 当前只允许本轮图片附件");
  }
  const cached = materializedAttachments(ctx).get(selected.index);
  if (cached) return cached;
  let result: MaterializedAttachment;
  if (selected.attachment.path) {
    result = await verifiedLocalAttachment(cfg, selected.index, selected.attachment, selected.attachment.path);
  } else if (selected.attachment.url.startsWith("/uploads/")) {
    const relative = decodeURIComponent(selected.attachment.url.slice("/uploads/".length));
    result = await verifiedLocalAttachment(
      cfg,
      selected.index,
      selected.attachment,
      path.resolve(cfg.attachmentRoots[0]!, relative)
    );
  } else {
    result = await fetchGrantedChannelImage(cfg, ctx, selected.index, selected.attachment);
  }
  materializedAttachments(ctx).set(selected.index, result);
  return result;
}

async function materializeCharacterReference(
  cfg: OpenCliBrowserConfig,
  rawHandle: unknown
): Promise<MaterializedAttachment & { characterId: string; sha256: string }> {
  const handle = requiredString(rawHandle, "asset", 180);
  const reference = await resolveNovelAiReferenceHandle(
    cfg.characterLibraryDir,
    handle,
    cfg.maxAttachmentBytes
  ).catch((error) => {
    throw new Error(`opencli_browser: 角色库参考图授权无效：${error instanceof Error ? error.message : String(error)}`);
  });
  return {
    index: -1,
    attachment: {
      kind: "image",
      url: "",
      mime: reference.mime,
      name: reference.name,
      size: reference.size,
    },
    filePath: reference.filePath,
    kind: reference.kind,
    size: reference.size,
    source: "character-library",
    characterId: reference.id,
    sha256: reference.sha256,
  };
}

function registerCleanup(cfg: OpenCliBrowserConfig, ctx: ToolContext, session: string): void {
  if (!ctx.deferCleanup || ctx.runState?.get(CLEANUP_REGISTERED_KEY)) return;
  ctx.runState?.set(CLEANUP_REGISTERED_KEY, true);
  ctx.deferCleanup(`opencli-browser:${session}`, async () => {
    const cleanupCtx: ToolContext = { ...ctx, signal: undefined, execution: undefined };
    for (const tab of [...openedTabs(ctx)]) {
      try {
        await runOpenCliBrowser(cfg, session, ["tab", "close", tab], cleanupCtx, 10_000);
      } catch (error) {
        ctx.logger.warn(
          { session, tab, err: error instanceof Error ? error.message : String(error) },
          "opencli: tab close 未确认，改由 Harbour CDP 精确回收"
        );
      }
      // OpenCLI close 的语义是释放 session lease，不保证真实 page 一定消失；始终用
      // Harbour 自有 CDP 做一次幂等验收/兜底，避免下一轮残留旧 NovelAI 页。
      await closeManagedPageTarget(cfg.browser, tab, ctx.logger).catch((error) => {
        ctx.logger.warn(
          { session, tab, err: error instanceof Error ? error.message : String(error) },
          "opencli: 本轮临时 page 回收失败"
        );
      });
    }
    // handoff 页必须继续持有 OpenCLI lease；对该随机 session 执行 close/unbind 都会让扩展
    // 回收 automation tab。Daemon 的 idle GC 或用户手动关页负责最终回收，后续 run 不复用它。
    if (!ctx.runState?.get(HANDED_OFF_KEY)) {
      await runOpenCliBrowser(cfg, session, ["close"], cleanupCtx, 10_000).catch(() => undefined);
    }
    openedTabs(ctx).clear();
  });
}

async function persistRenderedImage(
  cfg: OpenCliBrowserConfig,
  session: string,
  tab: string | undefined,
  ctx: ToolContext,
  result: unknown,
  expectedResolution?: { width: number; height: number }
): Promise<Record<string, unknown>> {
  if (!result || typeof result !== "object") throw new Error("opencli_browser: data image 导出没有返回对象");
  const row = result as Record<string, unknown>;
  const src = typeof row.src === "string" ? row.src : "";
  const match = src.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match?.[2]) throw new Error("opencli_browser: 页面图片不是受支持的 base64 data:image");
  if (match[2].length > Math.ceil(MAX_DATA_IMAGE_BYTES * 4 / 3) + 8) {
    throw new Error(`opencli_browser: data image 超过 ${MAX_DATA_IMAGE_BYTES / 1024 / 1024} MB`);
  }
  const bytes = Buffer.from(match[2], "base64");
  const kind = imageKind(bytes);
  if (!kind || bytes.length <= 0 || bytes.length > MAX_DATA_IMAGE_BYTES) {
    throw new Error("opencli_browser: data image 文件签名无效或超限");
  }
  const sharp = (await import("sharp")).default;
  const metadata = await sharp(bytes, { animated: false, limitInputPixels: 50_000_000 }).metadata();
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("opencli_browser: 页面图片无法解码出有效像素尺寸");
  }
  if (expectedResolution && (width !== expectedResolution.width || height !== expectedResolution.height)) {
    throw new Error(
      `opencli_browser: 图片尺寸不匹配，不能作为目标成品；expected=${expectedResolution.width}x${expectedResolution.height}, actual=${width}x${height}。仅凭尺寸不能确定是预览图还是生成配置错误。`
    );
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const previousPath = exportedDataImages(ctx).get(sha256);
  if (previousPath) {
    return {
      session,
      tab,
      saved: false,
      duplicate: true,
      path: previousPath,
      sha256,
      kind,
      size: bytes.length,
      width,
      height,
      reason: "本轮已经导出过字节完全相同的页面图片；未创建重复文件，也不能把它计作新的生成结果。",
    };
  }
  mkdirSync(cfg.downloadDir, { recursive: true });
  const ext = kind === "jpeg" ? ".jpg" : `.${kind}`;
  const output = path.join(cfg.downloadDir, `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`);
  await writeFile(output, bytes, { flag: "wx" });
  exportedDataImages(ctx).set(sha256, output);
  return {
    session,
    tab,
    saved: true,
    path: output,
    sha256,
    kind,
    size: bytes.length,
    width,
    height,
    source: `rendered-${String(row.renderKind || "local")}-image`,
  };
}

export function createOpenCliBrowserTools(cfg: OpenCliBrowserConfig): ToolDef[] {
  const browser: ToolDef = {
    name: "opencli_browser",
    description:
      "通过 OpenCLI Browser 操作 Harbour 专属隔离 Chrome；用于没有合适 OpenCLI 站点适配器的通用网页流程。" +
      "每次 agent run 使用独立 session/tab，可并行执行。只开放观察、导航、语义定位、点击/幂等 DOM activate、原子下载、已渲染 data/blob/canvas 图片导出、填写、等待、截图，以及本轮用户附件或 NovelAI 薄角色库内容寻址句柄的受限图片上传；" +
      "fill_richtext 可绕开响应式隐藏副本和重渲染后的旧 ref，并可用 tabText 原子切换 Prompt/Undesired 后按当前可见区域精确填写 ProseMirror/Slate；" +
      "inspect_novelai 一次返回成本、告警、浮层、模型、角色卡、参考图、分辨率与结果状态，避免反复整页 state；" +
      "prepare_novelai_form 可清除 NovelAI 遗留状态并一次配置完整表单；generate_novelai 原子复核成本/张数/目标像素并只提交一次；collect_novelai_result 确定性等待、排除旧图与半尺寸预览，并且只导出解码尺寸等于表单目标的本次原图；prepare_character_prompts 仅为旧调用兼容；" +
      "Workflow 模式下 prepare_novelai_form 自动选择冻结模型并填表，无需抄 Prompt，禁止通用点击/脚本绕路；角色参考图由代码定位 Precise Reference 输入，不用猜 selector；不支持参考图的模型在上传前返回明确错误，不换模型、不消耗上传键；上传必要参考图后 execute_novelai 串联提交与原图回收；" +
      "handoff 可在最后一步把当前页留给用户检查；不开放任意 bind/eval/network/本地路径 upload 等高权限命令。",
    timeoutMs: COMPOSITE_TOOL_TIMEOUT_MS,
    readOnly: false,
    onReplay(_result, _args, ctx) {
      // A cached receipt is not live pre-submit coverage. In particular a
      // replayed Generate must not disappear behind a later fresh preparation.
      recordNovelAiExecutionAction(ctx.execution, "checkpoint:replay");
    },
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "必须从枚举中选择；键盘动作使用 press（不是 key），等待使用 wait 并给 waitType",
          enum: [
            "open", "goto", "state", "snapshot", "extract", "get", "find", "inspect_novelai", "tabs", "close", "handoff", "back",
            "click", "activate", "download", "save_data_image", "upload_attachment", "upload_character_reference", "prepare_novelai_form", "execute_novelai", "generate_novelai", "collect_novelai_result", "prepare_character_prompts", "hover", "focus", "fill", "fill_richtext", "type", "check", "uncheck", "select", "press", "scroll", "wait", "screenshot",
          ],
        },
        tab: {
          type: "string",
          description: "open/tabs 返回的页面 ID；handoff 时必填，用于把该页面留给用户检查",
        },
        url: { type: "string" },
        ref: { type: ["string", "number"], description: "state 返回的数字 ref；可写 3 或 @3" },
        selector: { type: "string", description: "CSS selector" },
        role: { type: "string" },
        name: { type: "string" },
        label: { type: "string" },
        queryText: { type: "string", description: "语义定位使用的页面可见文本" },
        testId: { type: "string" },
        nth: { type: "integer", minimum: 0, description: "定位匹配中的 0-based 序号，不能代替 ref/selector 或语义定位" },
        onceKey: {
          type: "string",
          description: "一次性副作用的本轮幂等键；动作开始前占位，断流/未知结果禁止重复；上传仅在明确执行前拒绝时释放原键",
        },
        field: { type: "string", enum: ["title", "url", "text", "value", "attributes"] },
        text: { type: "string", description: "fill/type 输入的完整文本" },
        scopeText: {
          type: "string",
          description: "fill_richtext 使用的当前可见区域稳定文案（含可见 placeholder/aria-label/value）；用 | 分隔时要求同一区域同时包含全部片段，如 Base Prompt 或 Character 1",
        },
        tabText: {
          type: "string",
          description: "fill_richtext 可选的同一区域页签精确文本；工具先原子激活并等待 React 提交，再填写当前可见编辑器，如 Base Prompt、Prompt、Undesired Content",
        },
        characters: {
          type: "array",
          minItems: 0,
          maxItems: 6,
          items: { type: "string", enum: ["female", "male", "other"] },
          description: "prepare_novelai_form/prepare_character_prompts 的目标角色卡类型列表；新流程先清空遗留参考图/选中态与角色卡，再按顺序重建，例如 [female] 或 [female,male]",
        },
        characterNames: {
          type: "array",
          minItems: 0,
          maxItems: 6,
          items: { type: "string", minLength: 1, maxLength: 120 },
          description: "prepare_novelai_form 可选；与 characters 等长，一次写入角色卡名称，避免 React 重渲染造成旧 ref 漂移",
        },
        orientation: {
          type: "string",
          enum: ["landscape", "portrait", "square"],
          description: "prepare_novelai_form 可选；当未显式给 width/height 时，按当前预设尺寸确定性调整方向",
        },
        width: { type: "integer", minimum: 64, maximum: 4096, description: "prepare_novelai_form 可选目标宽度" },
        height: { type: "integer", minimum: 64, maximum: 4096, description: "prepare_novelai_form 可选目标高度" },
        numberOfImages: { type: "integer", minimum: 1, maximum: 4, description: "prepare_novelai_form 可选；一次确定生成张数" },
        maxCostAnlas: {
          type: "integer",
          minimum: 0,
          maximum: 1_000_000,
          description: "generate_novelai 必填；用户为本 batch 明确授权的 Anlas 成本上限",
        },
        basePrompt: {
          type: "string",
          minLength: 1,
          maxLength: 10_000,
          description: "prepare_novelai_form 可选完整字段组之一；全局 Base Prompt。提供任一提示词字段时必须提供完整四组",
        },
        undesiredPrompt: {
          type: "string",
          minLength: 0,
          maxLength: 10_000,
          description: "prepare_novelai_form 可选完整字段组之一；全局 Undesired Content，可显式传空字符串清空",
        },
        characterPrompts: {
          type: "array",
          minItems: 0,
          maxItems: 6,
          items: { type: "string", minLength: 1, maxLength: 10_000 },
          description: "prepare_novelai_form 可选完整字段组之一；与 characters 等长的角色 Prompt",
        },
        characterUndesiredPrompts: {
          type: "array",
          minItems: 0,
          maxItems: 6,
          items: { type: "string", minLength: 0, maxLength: 10_000 },
          description: "prepare_novelai_form 可选完整字段组之一；与 characters 等长的角色 Undesired Content，各项可显式传空字符串清空",
        },
        value: {
          type: "string",
          description: "select 的 option 文本或 value；wait time 推荐只传 timeoutMs，兼容旧调用时 value 按秒解析",
        },
        key: { type: "string", description: "按键，如 Enter、Escape、Control+a" },
        direction: { type: "string", enum: ["up", "down"] },
        pixels: { type: "integer", minimum: 1, maximum: 5_000 },
        waitType: { type: "string", enum: ["selector", "text", "time", "xhr", "download"] },
        timeoutMs: {
          type: "integer",
          minimum: 100,
          maximum: 90_000,
          description: "动作超时；wait time 时就是 Harbour 真实等待时长（毫秒）",
        },
        downloadPattern: { type: "string", description: "download 动作等待的可选文件名或 URL 模式" },
        attachment: {
          type: ["integer", "string"],
          description: "upload_attachment 使用的本轮图片附件：0-based 索引或精确原始文件名；不接受本地路径",
        },
        asset: {
          type: "string",
          description: "upload_character_reference 使用的 novelai_character 内容寻址句柄；不接受本地路径或 URL",
        },
        chunkSize: { type: "integer", minimum: 500, maximum: 40_000 },
        start: { type: "integer", minimum: 0 },
        fullPage: { type: "boolean" },
        annotate: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["action"],
    },
    async execute(rawInput, ctx) {
      let input = rawInput as Record<string, unknown>;
      const action = requiredString(input.action, "action", 30);
      assertNovelAiModelSelectionUsable(ctx, action);
      assertNovelAiExecutionActionAllowed(ctx.execution, action);
      recordNovelAiExecutionAction(ctx.execution, action);
      assertNovelAiPreparationUsable(ctx, action, optionalTab(input.tab) ?? "default");
      const authenticationKey = novelAiAuthenticationFailureKey(ctx.execution?.novelAiSubmission);
      const previousAuthentication = authenticationKey && ctx.execution?.toolEvidence?.get(authenticationKey);
      if (previousAuthentication && ["prepare_novelai_form", "upload_attachment", "upload_character_reference",
        "generate_novelai", "execute_novelai"].includes(action)) {
        throw new Error("NovelAI 本轮已检测到登录失效或验证页；停止准备及 Generate，请先登录后从原 Job 恢复。");
      }
      if (action === "prepare_novelai_form" && ctx.execution?.novelAiSubmission?.form) {
        input = { ...input, ...ctx.execution.novelAiSubmission.form, action, tab: input.tab };
      }
      if (ctx.execution?.novelAiIntent === "prompt") throw new Error("只要 Prompt，本次不打开 Browser");
      if (ctx.execution?.novelAiIntent === "readiness" &&
        !["open", "goto", "state", "snapshot", "extract", "get", "find", "inspect_novelai", "tabs", "close", "handoff", "back", "wait", "screenshot"].includes(action)) {
        throw new Error("本次是只读 readiness 检查，不允许填写、上传、点击或 Generate");
      }
      if (action === "prepare_novelai_form") {
        const key = novelAiPromptBudgetFailureKey(ctx.execution?.novelAiSubmission);
        const previous = key && ctx.execution?.toolEvidence?.get(key);
        if (novelAiPromptBudgetOverflowReport(previous)) throw previous;
      }
      const session = sessionFor(ctx);
      registerCleanup(cfg, ctx, session);
      const tab = optionalTab(input.tab);

      if (ctx.runState?.get(HANDED_OFF_KEY)) {
        throw new Error("opencli_browser: 页面已 handoff 给用户；handoff 必须是本轮最后一个浏览器动作");
      }

      if (action === "open" || action === "goto") {
        clearNovelAiPreparation(ctx, tab);
        const result = await runOpenCliBrowser(cfg, session, withTab(["open", safeUrl(input.url)], tab), ctx);
        const opened = pageIdFrom(result);
        if (opened) clearNovelAiPreparation(ctx, opened);
        if (opened) openedTabs(ctx).add(opened);
        return { session, tab: opened ?? tab, result };
      }
      if (action === "tabs") {
        return { session, result: await runOpenCliBrowser(cfg, session, ["tab", "list"], ctx) };
      }
      if (action === "close") {
        clearNovelAiPreparation(ctx, tab);
        if (tab) {
          // OpenCLI may reject a foreign lease. Its CDP fallback must not turn
          // that rejection into closing another concurrent run's real page.
          if (!openedTabs(ctx).has(tab)) throw new Error("opencli_browser: 只能关闭本轮打开的 tab；不能关闭其他任务页面");
          let result: unknown;
          try {
            result = await runOpenCliBrowser(cfg, session, ["tab", "close", tab], ctx);
          } catch (error) {
            ctx.logger.warn(
              { session, tab, err: error instanceof Error ? error.message : String(error) },
              "opencli: 显式 tab close 未确认，改由 Harbour CDP 精确回收"
            );
          }
          await closeManagedPageTarget(cfg.browser, tab, ctx.logger);
          openedTabs(ctx).delete(tab);
          return { session, tab, result, closed: true };
        }
        return { session, result: await runOpenCliBrowser(cfg, session, ["close"], ctx) };
      }
      if (action === "handoff") {
        if (!tab) throw new Error("opencli_browser: handoff 必须指定本轮 open 返回的 tab");
        if (!openedTabs(ctx).has(tab)) {
          throw new Error("opencli_browser: 只能 handoff 本轮由 open/goto 打开的 tab");
        }
        // automation tab 只有在 session lease 仍存活时才会保留；把目标 tab 从自动清理集合
        // 移除并标记 handoff，agentLoop finally 只回收本轮其它 tab，不释放该随机 session lease。
        // Daemon idle GC 或用户手动关页负责最终回收，后续 Controller 不复用它。
        openedTabs(ctx).delete(tab);
        ctx.runState?.set(HANDED_OFF_KEY, true);
        return {
          session,
          tab,
          handedOff: true,
          note: "页面已留在 Harbour 隔离 Chrome；当前 Controller 不再操作该 tab，最终由用户或 idle GC 关闭。",
        };
      }
      if (action === "state" || action === "snapshot") {
        return { session, tab, result: await runOpenCliBrowser(cfg, session, withTab(["state"], tab), ctx) };
      }
      if (action === "inspect_novelai") {
        const result = await runOpenCliBrowser(
          cfg,
          session,
          withTab(["eval", inspectNovelAiScript()], tab),
          ctx
        );
        if (!result || typeof result !== "object" || (result as Record<string, unknown>).inspected !== true) {
          throw new Error(`opencli_browser: NovelAI 确定性检查失败：${JSON.stringify(result).slice(0, 1_000)}`);
        }
        observeNovelAiAuthentication(ctx, result);
        return { session, tab, result };
      }
      if (action === "generate_novelai") {
        const { maxCostAnlas, expectedImages, otherReservedAnlas } = boundedNovelAiSubmission(input, ctx.execution?.novelAiSubmission);
        const limit = ctx.execution?.novelAiSubmission;
        if (ctx.execution?.novelAiContentRating === "sfw") {
          assertNovelAiSfwVibeEmpty(await runOpenCliBrowser(cfg, session, withTab(["eval", novelAiSfwVibeScript()], tab), ctx));
        }
        if (limit?.form?.sfwSampling) {
          const sampling = limit.form.sfwSampling as NovelAiSfwSampling;
          assertNovelAiSfwSamplingReadback(await runOpenCliBrowser(cfg, session, withTab(["eval", novelAiSfwSamplingScript(sampling, false)], tab), ctx), sampling);
        }
        const pageModel = await assertNovelAiPageModel(cfg, session, tab, ctx);
        if (limit?.form && ctx.runState?.get(NOVELAI_PREPARED_KEY + (tab ?? "default")) !== frozenFormSignature(limit)) {
          throw new Error("冻结表单尚未完成填写与校验；先 prepare_novelai_form，再上传必要参考图并 execute_novelai，未提交 Generate。");
        }
        let expectedReferences: string[] | undefined;
        let referenceVerification: NovelAiReferenceVerification | undefined;
        if (limit?.form) {
          validateNovelAiRequiredReferences(limit.requiredReferences ?? []);
          const required = (limit.requiredReferences ?? []).map(referenceIdentity);
          const proof = referenceProof(ctx, tab);
          const uploads = proof?.signature === frozenFormSignature(limit) ? proof.uploads : [];
          if (required.length !== uploads.length || required.some(identity => !uploads.some(item => item.identity === identity))) {
            throw new Error("冻结提交的必要参考图尚未全部确认上传；未提交 Generate。不得跳过参考图或重新创作。");
          }
          expectedReferences = uploads.map(item => item.fingerprint).sort();
          assertSameReferences(await inspectNovelAiReferences(cfg, session, tab, ctx), expectedReferences);
          referenceVerification = { evidence: "loaded-reference-preview", references: uploads.map(item => ({ ...item })) };
        }
        const inspected = await runOpenCliBrowser(
          cfg,
          session,
          withTab(["eval", inspectNovelAiScript()], tab),
          ctx
        );
        if (!inspected || typeof inspected !== "object") {
          throw new Error("opencli_browser: generate_novelai 预检失败");
        }
        const authenticationIssue = observeNovelAiAuthentication(ctx, inspected);
        if (authenticationIssue) throw new Error(authenticationIssue.reason);
        const form = ((inspected as Record<string, unknown>).form ?? {}) as Record<string, unknown>;
        const resolution = (form.resolution ?? {}) as Record<string, unknown>;
        const expectedWidth = Number(resolution.width);
        const expectedHeight = Number(resolution.height);
        const frozen = ctx.execution?.novelAiSubmission?.form;
        let promptBudgetNonce: string | undefined;
        if (frozen && limit && pageModel && supportsNovelAiPreciseReferences(pageModel)) {
          const proof = ctx.runState?.get(NOVELAI_PROMPT_BUDGET_KEY + (tab ?? "default")) as { signature: string; nonce: string } | undefined;
          if (!proof || proof.signature !== frozenFormSignature(limit)) {
            throw new Error("V4.5 提示词 token 上限尚未验证；先 prepare_novelai_form，未提交 Generate。");
          }
          promptBudgetNonce = proof.nonce;
          await runOpenCliBrowser(cfg, session, withTab(["eval", novelAiPromptBudgetProofScript(proof.nonce)], tab), ctx);
        }
        if (frozen && (expectedWidth !== frozen.width || expectedHeight !== frozen.height)) {
          throw new Error(`opencli_browser: 页面尺寸 ${expectedWidth}x${expectedHeight} 与冻结要求 ${frozen.width}x${frozen.height} 不符，未提交 Generate；先 prepare_novelai_form 修正。`);
        }
        if (!Number.isInteger(expectedWidth) || !Number.isInteger(expectedHeight) ||
            expectedWidth < 64 || expectedHeight < 64 || expectedWidth > 4096 || expectedHeight > 4096) {
          throw new Error("opencli_browser: Generate 前无法确定 NovelAI 的目标像素尺寸，未提交 Generate");
        }
        const generation = ((inspected as Record<string, unknown>).generation ?? {}) as Record<string, unknown>;
        const button = (generation.button ?? {}) as Record<string, unknown>;
        const rawDisplayedCost = Number(button.costAnlas);
        const displayedCost = Number.isFinite(rawDisplayedCost) && rawDisplayedCost >= 0
          ? rawDisplayedCost
          : undefined;
        if (generation.busy === true) throw new Error("opencli_browser: NovelAI 当前已有生成任务");
        if (button.disabled === true) throw new Error("opencli_browser: NovelAI Generate 当前不可用");
        if (displayedCost === undefined) throw new Error("opencli_browser: 页面未显示确定的 Anlas 成本");
        if (displayedCost > maxCostAnlas) {
          throw new Error(`opencli_browser: 页面成本 ${displayedCost} Anlas 超过授权上限 ${maxCostAnlas}`);
        }
        assertNovelAiAvailableBalance(((inspected as Record<string, unknown>).account as Record<string, unknown> | undefined)?.balanceAnlas,
          displayedCost, otherReservedAnlas ?? 0);
        const baseline = await runOpenCliBrowser(
          cfg,
          session,
          withTab(["eval", renderedImageFingerprintsScript()], tab),
          ctx,
          15_000,
          20_000
        );
        if (!baseline || typeof baseline !== "object" || !Array.isArray((baseline as Record<string, unknown>).fingerprints)) {
          throw new Error("opencli_browser: 无法建立生成前图片基线，未提交 Generate");
        }
        const onceKey = reserveOnceKey(ctx, input.onceKey);
        markNovelAiPaidActivation(ctx.execution);
        const result = await runOpenCliBrowser(
          cfg,
          session,
          withTab(["eval", novelAiGenerateScript(maxCostAnlas, expectedImages, otherReservedAnlas, { width: expectedWidth, height: expectedHeight }, expectedReferences, limit?.expectedModel ?? pageModel, promptBudgetNonce)], tab),
          ctx
        );
        const submitted = confirmedNovelAiSubmission(result, maxCostAnlas, expectedImages);
        const rawBalance = Number(((inspected as Record<string, unknown>).account as Record<string, unknown> | undefined)?.balanceAnlas);
        const baselineFingerprints = (baseline as Record<string, unknown>).fingerprints as unknown[];
        const generationBaseline: NovelAiGenerationBaseline = {
          sourceFingerprints: baselineFingerprints.filter((value): value is string => typeof value === "string"),
          ...(Number.isFinite(rawBalance) ? { balanceBefore: rawBalance } : {}),
          costAnlas: submitted.costAnlas,
          numberOfImages: submitted.numberOfImages,
          expectedWidth,
          expectedHeight,
          ...(onceKey ? { onceKey } : {}),
          ...(referenceVerification ? { referenceVerification } : {}),
        };
        novelAiGenerations(ctx).set(tab ?? "default", generationBaseline);
        rememberNovelAiExecutionEvidence(ctx, generationBaseline, {
          completed: false,
          submitted: true,
          visibleCostAnlas: submitted.costAnlas,
          balanceBefore: Number.isFinite(rawBalance) ? rawBalance : null,
          ...(referenceVerification ? { referenceVerification } : {}),
          expectedResolution: { width: expectedWidth, height: expectedHeight },
          reason: "Generate 已唯一提交，尚未取得 collect_novelai_result 的验签成品。",
        });
        return {
          session,
          tab,
          submitted: true,
          activation: "novelai-dom",
          visibleCostAnlas: submitted.costAnlas,
          numberOfImages: submitted.numberOfImages,
          expectedResolution: { width: expectedWidth, height: expectedHeight },
          balanceBefore: Number.isFinite(rawBalance) ? rawBalance : null,
          ...(referenceVerification ? { referenceVerification } : {}),
          ...(onceKey ? { onceKey } : {}),
        };
      }
      if (action === "execute_novelai") {
        const limit = ctx.execution?.novelAiSubmission;
        if (!limit?.form) throw new Error("execute_novelai 需要 Workflow 的冻结表单与提交授权");
        // Once submitted, retries only collect. Never reset the page or click again.
        const baseline = novelAiGenerations(ctx).get(tab ?? "default");
        if (baseline && baseline.onceKey !== limit.onceKey) throw new Error("当前 tab 属于另一提交，不能混用结果");
        if (!baseline) await browser.execute({ action: "generate_novelai", tab, onceKey: limit.onceKey,
          maxCostAnlas: limit.maxCostAnlas, numberOfImages: limit.numberOfImages }, ctx);
        return browser.execute({ action: "collect_novelai_result", tab, timeoutMs: 90_000 }, ctx);
      }
      if (action === "collect_novelai_result") {
        const baseline = novelAiGenerations(ctx).get(tab ?? "default");
        if (!baseline) {
          throw new Error("opencli_browser: 当前 tab 本轮尚未通过 generate_novelai 提交，不能收取结果");
        }
        // Generate 已提交后不能因为模型把等待值写成 120s 就放弃收图；核心把它确定性
        // 夹到工具允许范围，而不是抛错后诱发模型改走 tabs/handoff 或错误重试。
        const timeoutMs = normalizeNovelAiCollectTimeout(input.timeoutMs);
        const deadline = Date.now() + timeoutMs;
        let latestFingerprints: string[] = [];
        let latestPreviewDimensions: string[] = [];
        while (Date.now() < deadline) {
          await waitBriefly(Math.min(2_500, Math.max(100, deadline - Date.now())), ctx.signal);
          const inventory = await runOpenCliBrowser(
            cfg,
            session,
            withTab(["eval", renderedImageFingerprintsScript()], tab),
            ctx,
            15_000,
            20_000
          );
          latestFingerprints = inventory && typeof inventory === "object" && Array.isArray((inventory as Record<string, unknown>).fingerprints)
            ? ((inventory as Record<string, unknown>).fingerprints as unknown[]).filter((value): value is string => typeof value === "string")
            : [];
          const selection = selectNovelAiRenderedImages(
            inventory,
            baseline.sourceFingerprints,
            baseline.expectedWidth,
            baseline.expectedHeight
          );
          latestPreviewDimensions = selection.previewDimensions;
          if (selection.fullResolutionFingerprints.length < baseline.numberOfImages) continue;

          const artifacts: Record<string, unknown>[] = [];
          for (let index = 0; index < baseline.numberOfImages; index += 1) {
            const rendered = await runOpenCliBrowser(
              cfg,
              session,
              withTab(["eval", dataImageExportScript(
                undefined,
                index,
                baseline.sourceFingerprints,
                baseline.expectedWidth,
                baseline.expectedHeight,
                selection.fullResolutionFingerprints
              )], tab),
              ctx,
              DEFAULT_TIMEOUT_MS,
              MAX_DATA_IMAGE_OUTPUT_CHARS
            ).catch((cause: unknown) => {
              throw new Error(
                `opencli_browser: NovelAI 已提交，原图回收失败；不得重新生成。原因：${cause instanceof Error ? cause.message : String(cause)}`,
                { cause }
              );
            });
            const artifact = await persistRenderedImage(cfg, session, tab, ctx, rendered, {
              width: baseline.expectedWidth,
              height: baseline.expectedHeight,
            });
            if (artifact.saved !== true && artifact.duplicate !== true) {
              throw new Error("opencli_browser: 本次 NovelAI 成品未能验签落盘");
            }
            artifacts.push(artifact);
          }
          const inspectedAfter = await runOpenCliBrowser(
            cfg,
            session,
            withTab(["eval", inspectNovelAiScript()], tab),
            ctx,
            15_000,
            20_000
          );
          const balanceAfterRaw = Number(((inspectedAfter as Record<string, unknown> | undefined)?.account as Record<string, unknown> | undefined)?.balanceAnlas);
          const completedEvidence: NovelAiExecutionEvidence = {
            session,
            tab,
            completed: true,
            submitted: true,
            artifacts,
            expectedResolution: { width: baseline.expectedWidth, height: baseline.expectedHeight },
            visibleCostAnlas: baseline.costAnlas,
            balanceBefore: baseline.balanceBefore ?? null,
            balanceAfter: Number.isFinite(balanceAfterRaw) ? balanceAfterRaw : null,
            warnings: Array.isArray((inspectedAfter as Record<string, unknown> | undefined)?.warnings)
              ? (inspectedAfter as Record<string, unknown>).warnings
              : [],
            ...(baseline.onceKey ? { onceKey: baseline.onceKey } : {}),
          };
          rememberNovelAiExecutionEvidence(ctx, baseline, completedEvidence);
          return completedEvidence;
        }
        const inspectedAfter = await runOpenCliBrowser(
          cfg,
          session,
          withTab(["eval", inspectNovelAiScript()], tab),
          ctx,
          15_000,
          20_000
        ).catch(() => null);
        const incompleteEvidence: NovelAiExecutionEvidence = {
          session,
          tab,
          completed: false,
          submitted: true,
          chargeState: "unknown",
          visibleCostAnlas: baseline.costAnlas,
          balanceBefore: baseline.balanceBefore ?? null,
          expectedResolution: { width: baseline.expectedWidth, height: baseline.expectedHeight },
          observedPreviewDimensions: latestPreviewDimensions,
          reason: latestPreviewDimensions.length
            ? `NovelAI 已提交，但期限内仅取得 ${latestPreviewDimensions.join("、")} 尺寸不匹配的图片，未取得 ${baseline.expectedWidth}x${baseline.expectedHeight} 目标成品；可能是预览或页面生成尺寸错误，不能只凭尺寸断言。禁止冒充目标原图交付或自动重试。`
            : "NovelAI 已提交，但在期限内没有出现区别于生成前基线的新成品；禁止自动重试。",
          inspection: inspectedAfter,
          observedFingerprints: latestFingerprints.length,
          ...(baseline.onceKey ? { onceKey: baseline.onceKey } : {}),
        };
        rememberNovelAiExecutionEvidence(ctx, baseline, incompleteEvidence);
        return incompleteEvidence;
      }
      if (action === "extract") {
        const args = ["extract"];
        if (input.selector !== undefined) args.push("--selector", requiredString(input.selector, "selector", 1_000));
        if (input.chunkSize !== undefined) {
          const size = Number(input.chunkSize);
          if (!Number.isInteger(size) || size < 500 || size > 40_000) throw new Error("opencli_browser: chunkSize 必须是 500–40000");
          args.push("--chunk-size", String(size));
        }
        if (input.start !== undefined) {
          const start = Number(input.start);
          if (!Number.isInteger(start) || start < 0) throw new Error("opencli_browser: start 必须是非负整数");
          args.push("--start", String(start));
        }
        return { session, tab, result: await runOpenCliBrowser(cfg, session, withTab(args, tab), ctx) };
      }
      if (action === "get") {
        const field = requiredString(input.field, "field", 20);
        if (!["title", "url", "text", "value", "attributes"].includes(field)) {
          throw new Error("opencli_browser: get field 不受支持");
        }
        const args = ["get", field];
        if (["text", "value", "attributes"].includes(field)) {
          const located = targetAndFlags(input);
          if (located.target) args.push(located.target);
          args.push(...located.flags);
        }
        return { session, tab, result: await runOpenCliBrowser(cfg, session, withTab(args, tab), ctx) };
      }
      if (action === "find") {
        const args = ["find"];
        if (input.selector !== undefined) args.push("--css", requiredString(input.selector, "selector", 1_000));
        args.push(...semanticFlags(input));
        if (input.limit !== undefined) args.push("--limit", String(Number(input.limit)));
        if (args.length === 1) throw new Error("opencli_browser: find 需要 selector 或语义定位条件");
        return { session, tab, result: await runOpenCliBrowser(cfg, session, withTab(args, tab), ctx) };
      }
      if (action === "back") {
        clearNovelAiPreparation(ctx, tab);
        return { session, tab, result: await runOpenCliBrowser(cfg, session, withTab(["back"], tab), ctx) };
      }
      if (["click", "hover", "focus", "check", "uncheck"].includes(action)) {
        const located = targetAndFlags(input);
        const args = [action];
        if (located.target) args.push(located.target);
        args.push(...located.flags);
        const mutate = () => runOpenCliBrowser(cfg, session, withTab(args, tab), ctx);
        return { session, tab, result: await (action === "click" ? guardedNovelAiMutation(cfg, session, tab, ctx, mutate) : mutate()) };
      }
      if (action === "activate") {
        const target = optionalTarget(input.ref ?? input.selector);
        if (!target) throw new Error("opencli_browser: activate 需要当前 state 返回的 ref 或 CSS selector");
        const nth = input.nth === undefined ? 0 : Number(input.nth);
        if (!Number.isInteger(nth) || nth < 0 || nth > 10_000) {
          throw new Error("opencli_browser: nth 必须是非负整数");
        }
        // 不向模型开放任意 eval；这里只用 JSON 转义后的 selector 生成固定 el.click() 程序。
        // 用于普通 button/link 的确定性 DOM 激活，规避部分 Bridge/CDP 组合会返回 clicked
        // 但没有真正触发页面事件的问题。不可在一次不确定的 native click 后补调用，避免双写。
        const onceKey = reserveOnceKey(ctx, input.onceKey);
        const result = await guardedNovelAiMutation(cfg, session, tab, ctx, () => runOpenCliBrowser(
          cfg,
          session,
          withTab(["eval", domActivationScript(target, nth)], tab),
          ctx
        ));
        return { session, tab, result, activation: "dom", ...(onceKey ? { onceKey } : {}) };
      }
      if (action === "download") {
        const target = optionalTarget(input.ref ?? input.selector);
        if (!target) throw new Error("opencli_browser: download 需要当前 state 返回的 ref 或 CSS selector");
        const nth = input.nth === undefined ? 0 : Number(input.nth);
        if (!Number.isInteger(nth) || nth < 0 || nth > 10_000) {
          throw new Error("opencli_browser: nth 必须是非负整数");
        }
        const timeoutMs = input.timeoutMs === undefined ? 60_000 : Number(input.timeoutMs);
        if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 90_000) {
          throw new Error("opencli_browser: timeoutMs 必须是 100–90000 的整数");
        }
        const pattern = input.downloadPattern === undefined
          ? undefined
          : requiredString(input.downloadPattern, "downloadPattern", 1_000);
        // 下载监听最长会等一分钟。先用固定脚本验证目标确实像下载控件，避免把 NovelAI
        // History 里的无标签按钮/旧 ref 点下去后白等 60 秒，也避免无意激活别的写操作。
        const inspected = await runOpenCliBrowser(
          cfg,
          session,
          withTab(["eval", downloadTargetInspectionScript(target, nth)], tab),
          ctx
        );
        const inspection = inspected && typeof inspected === "object"
          ? inspected as Record<string, unknown>
          : undefined;
        const downloadLabel = [inspection?.text, inspection?.ariaLabel, inspection?.title]
          .map((value) => String(value || ""))
          .join(" ");
        const href = String(inspection?.href || "");
        const looksLikeDownload = inspection?.hasDownloadAttribute === true ||
          /download|save|export|下载|保存|导出/i.test(downloadLabel) ||
          /^(?:blob:|data:)|\.(?:zip|png|jpe?g|webp|gif|pdf)(?:[?#]|$)/i.test(href);
        if (inspection?.visible !== true || inspection.disabled === true || !looksLikeDownload) {
          throw new Error(
            `opencli_browser: download 目标未通过预检（必须是可见且有 download/save/export 语义的控件）：${JSON.stringify(inspection).slice(0, 1_000)}`
          );
        }
        const onceKey = reserveOnceKey(ctx, input.onceKey);
        const waitArgs = ["wait", "download"];
        if (pattern) waitArgs.push(pattern);
        waitArgs.push("--timeout", String(timeoutMs));

        // 先在同一 session/tab 上监听下载事件，再激活目标；不会错过快速 blob 下载。
        const waitAbort = new AbortController();
        const outerAbort = () => waitAbort.abort();
        ctx.signal?.addEventListener("abort", outerAbort, { once: true });
        const waitCtx: ToolContext = { ...ctx, signal: waitAbort.signal };
        const waiting = runOpenCliBrowser(
          cfg,
          session,
          withTab(waitArgs, tab),
          waitCtx,
          Math.min(100_000, timeoutMs + 10_000)
        );
        try {
          await waitBriefly(500, ctx.signal);
          const activation = await runOpenCliBrowser(
            cfg,
            session,
            withTab(["eval", domActivationScript(target, nth)], tab),
            ctx
          );
          const download = await waiting;
          return { session, tab, preflight: inspection, activation, download, ...(onceKey ? { onceKey } : {}) };
        } catch (error) {
          waitAbort.abort();
          await waiting.catch(() => undefined);
          throw error;
        } finally {
          ctx.signal?.removeEventListener("abort", outerAbort);
        }
      }
      if (action === "upload_attachment") {
        if (ctx.execution?.novelAiSubmission?.form) await assertNovelAiAuthentication(cfg, session, tab, ctx);
        let located = ctx.execution?.novelAiSubmission?.form ? undefined : uploadTargetAndFlags(input);
        const selected = grantedAttachment(ctx, input.attachment);
        const materialized = await materializeGrantedAttachment(cfg, ctx, input.attachment);
        // The index is only a transport address: bind the current file's bytes,
        // never mutable attachment metadata, to the frozen Job's image identity.
        const sha256 = createHash("sha256").update(await readFile(materialized.filePath)).digest("hex");
        const identity = authorizeNovelAiReference(ctx, tab, { kind: "attachment", index: selected.index, sha256 });
        located ??= await preciseReferenceTarget(cfg, session, tab, ctx);
        const before = await beforeNovelAiReference(cfg, session, tab, ctx, identity);
        // 默认按“本轮附件索引”占位，避免模型因验证延迟把同一参考图重复加入页面。
        const { result, onceKey } = await runVerifiedUpload(cfg, session, tab, ctx, located, materialized.filePath,
          identity ? novelAiReferenceOnceKey(ctx, identity) : input.onceKey ?? `attachment-upload:${materialized.index}`, !!identity);
        const referenceVerification = await recordNovelAiReference(cfg, session, tab, ctx, identity, before);
        return {
          session,
          tab,
          result,
          onceKey,
          ...(referenceVerification ? { referenceVerification } : {}),
          attachment: {
            index: materialized.index,
            name: materialized.attachment.name,
            kind: materialized.kind,
            size: materialized.size,
            source: materialized.source,
            sha256,
          },
        };
      }
      if (action === "upload_character_reference") {
        if (ctx.execution?.novelAiSubmission?.form) await assertNovelAiAuthentication(cfg, session, tab, ctx);
        const identity = authorizeNovelAiReference(ctx, tab, { kind: "character", handle: requiredString(input.asset, "asset", 180) });
        const located = await preciseReferenceTarget(cfg, session, tab, ctx);
        const materialized = await materializeCharacterReference(cfg, input.asset);
        const before = await beforeNovelAiReference(cfg, session, tab, ctx, identity);
        const { result, onceKey } = await runVerifiedUpload(cfg, session, tab, ctx, located, materialized.filePath,
          identity ? novelAiReferenceOnceKey(ctx, identity) : input.onceKey ?? `character-reference:${materialized.characterId.slice(0, 40)}:${materialized.sha256.slice(0, 12)}`, !!identity);
        const referenceVerification = await recordNovelAiReference(cfg, session, tab, ctx, identity, before);
        return {
          session,
          tab,
          result,
          onceKey,
          ...(referenceVerification ? { referenceVerification } : {}),
          asset: {
            id: materialized.characterId,
            name: materialized.attachment.name,
            kind: materialized.kind,
            size: materialized.size,
            source: materialized.source,
            sha256: materialized.sha256,
          },
        };
      }
      if (action === "prepare_novelai_form" || action === "prepare_character_prompts") {
        preparationStage(ctx, "model");
        const submission = ctx.execution?.novelAiSubmission;
        if (novelAiGenerations(ctx).has(tab ?? "default") || (submission && activationOnceKeys(ctx).has(submission.onceKey))) {
          throw new Error("此提交已经尝试；不能重置表单或参考图。仅 collect_novelai_result 核对原结果，不重新 Generate。");
        }
        let preparedModel: string | undefined;
        try {
          if (action === "prepare_novelai_form" && submission?.form) {
            await assertNovelAiAuthentication(cfg, session, tab, ctx);
          }
          if (action === "prepare_novelai_form" && submission?.expectedModel && submission.form) {
            // One bounded selector owns open -> menu-ready -> exact option ->
            // selected-model readback. Both models share UI compatibility only;
            // frozen prompts, reference routing and token limits stay unchanged.
            const selection = await runOpenCliBrowser(cfg, session,
              withTab(["eval", novelAiModelSelectionScript(submission.expectedModel)], tab), ctx) as Record<string, unknown>;
            if (selection?.modelSelection !== true || selection.verified !== true ||
                selection.model !== `NAI Diffusion ${submission.expectedModel.replace(/^NAI Diffusion /, "")}`) {
              throw new Error("NovelAI 固定模型选择回执不完整，未确认模型切换完成。");
            }
          }
          preparedModel = await assertNovelAiPageModel(cfg, session, tab, ctx);
        } catch (error) {
          // A preparation-only failure must not start minutes of speculative
          // generic actions, which would erase trustworthy pre-submit evidence.
          markNovelAiModelSelectionFailed(ctx);
          throw error;
        }
        // Reference-only setup batches the same bounded DOM steps/readbacks in
        // one command. No-reference V5 keeps its existing execution sequence.
        const batchReferenceSetup = !!submission?.form && !!submission.requiredReferences?.length &&
          !!preparedModel && supportsNovelAiPreciseReferences(preparedModel);
        if (submission?.requiredReferences?.length) await preciseReferenceTarget(cfg, session, tab, ctx);
        clearNovelAiPreparation(ctx, tab);
        const pendingResetKey = NOVELAI_REFERENCE_RESET_KEY + (tab ?? "default");
        const pendingReset = ctx.runState?.get(pendingResetKey) as NovelAiPendingReferenceReset | undefined;
        const confirmedBeforeReset = submission && pendingReset?.signature === frozenFormSignature(submission)
          ? pendingReset.identities : [];
        if (!Array.isArray(input.characters)) {
          throw new Error(`opencli_browser: ${action} 需要 characters 数组`);
        }
        const characters = input.characters.map((value) => String(value).toLowerCase());
        if (characters.length > 6 || characters.some((value) => !["female", "male", "other"].includes(value))) {
          throw new Error("opencli_browser: characters 只能包含最多 6 个 female/male/other");
        }
        const characterNames = input.characterNames === undefined
          ? undefined
          : Array.isArray(input.characterNames)
            ? input.characterNames.map((value) => String(value).trim())
            : null;
        if (characterNames === null || characterNames?.some((value) => !value || value.length > 120) ||
            (characterNames && characterNames.length !== characters.length)) {
          throw new Error("opencli_browser: characterNames 必须与 characters 等长，且每项为 1–120 字符");
        }
        const orientation = input.orientation === undefined ? undefined : String(input.orientation);
        if (orientation !== undefined && !["landscape", "portrait", "square"].includes(orientation)) {
          throw new Error("opencli_browser: orientation 只能是 landscape/portrait/square");
        }
        const optionalInteger = (value: unknown, field: string, min: number, max: number): number | undefined => {
          if (value === undefined) return undefined;
          const parsed = Number(value);
          if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
            throw new Error(`opencli_browser: ${field} 必须是 ${min}–${max} 的整数`);
          }
          return parsed;
        };
        const width = optionalInteger(input.width, "width", 64, 4096);
        const height = optionalInteger(input.height, "height", 64, 4096);
        if ((width === undefined) !== (height === undefined)) {
          throw new Error("opencli_browser: width 与 height 必须同时提供");
        }
        const numberOfImages = optionalInteger(input.numberOfImages, "numberOfImages", 1, 4);
        const optionalPrompt = (value: unknown, field: string, allowEmpty = false): string | undefined => {
          if (value === undefined) return undefined;
          return requiredString(value, field, 10_000, allowEmpty);
        };
        const promptArray = (value: unknown, field: string, allowEmpty = false): string[] | undefined => {
          if (value === undefined) return undefined;
          if (!Array.isArray(value) || value.length > 6) {
            throw new Error(`opencli_browser: ${field} 必须是最多 6 项的字符串数组`);
          }
          return Array.from(value, (item, index) => requiredString(item, `${field}[${index}]`, 10_000, allowEmpty));
        };
        const basePrompt = optionalPrompt(input.basePrompt, "basePrompt");
        // Explicit empty negatives clear the field; undefined still means a missing bundle field.
        const undesiredPrompt = optionalPrompt(input.undesiredPrompt, "undesiredPrompt", true);
        const characterPrompts = promptArray(input.characterPrompts, "characterPrompts");
        const characterUndesiredPrompts = promptArray(
          input.characterUndesiredPrompts,
          "characterUndesiredPrompts",
          true
        );
        const hasPromptBundle = [
          basePrompt,
          undesiredPrompt,
          characterPrompts,
          characterUndesiredPrompts,
        ].some((value) => value !== undefined);
        if (action !== "prepare_novelai_form" && hasPromptBundle) {
          throw new Error("opencli_browser: 提示词字段只适用于 prepare_novelai_form");
        }
        if (hasPromptBundle && (
          !basePrompt || undesiredPrompt === undefined || !characterPrompts || !characterUndesiredPrompts ||
          characterPrompts.length !== characters.length ||
          characterUndesiredPrompts.length !== characters.length
        )) {
          throw new Error(
            "opencli_browser: 提供任一提示词字段时，basePrompt/undesiredPrompt/characterPrompts/characterUndesiredPrompts 必须完整，且角色数组与 characters 等长"
          );
        }
        if (hasPromptBundle) {
          validateNovelAiBatchPrompt({
            characters,
            characterNames: characterNames ?? undefined,
            numberOfImages,
            basePrompt: basePrompt!,
            undesiredPrompt: undesiredPrompt!,
            characterPrompts: characterPrompts!,
            characterUndesiredPrompts: characterUndesiredPrompts!,
          });
        }
        let referenceReset: Record<string, unknown> | undefined;
        preparationStage(ctx, "references");
        if (action === "prepare_novelai_form") {
          const referenceInventory = async (): Promise<Record<string, unknown>> => {
            const result = await runOpenCliBrowser(
              cfg,
              session,
              withTab(["eval", novelAiReferenceInventoryScript(ctx.execution?.novelAiContentRating === "sfw")], tab),
              ctx
            );
            if (!result || typeof result !== "object") {
              throw new Error("opencli_browser: 无法读取 NovelAI 参考图状态");
            }
            return result as Record<string, unknown>;
          };
          const activeOf = (row: Record<string, unknown>): number => {
            const active = Number(row.active);
            if (!Number.isInteger(active) || active < 0 || active > 20) {
              throw new Error(`opencli_browser: NovelAI 参考图状态无效：${JSON.stringify(row).slice(0, 500)}`);
            }
            return active;
          };
          const initial = await referenceInventory();
          let currentReference = initial;
          let activeReferences = activeOf(currentReference);
          const cleared: unknown[] = [];
          while (activeReferences > 0) {
            if (cleared.length >= 10) {
              throw new Error("opencli_browser: NovelAI 遗留参考图/选中态超过安全清理上限");
            }
            const result = await runOpenCliBrowser(
              cfg,
              session,
              withTab(["eval", clearOneNovelAiReferenceScript(ctx.execution?.novelAiContentRating === "sfw")], tab),
              ctx
            );
            cleared.push(result);
            await waitBriefly(250, ctx.signal);
            const next = await referenceInventory();
            const nextActive = activeOf(next);
            if (nextActive >= activeReferences) {
              throw new Error(
                `opencli_browser: 清除 NovelAI 遗留参考图/选中态未生效；before=${activeReferences}, after=${nextActive}`
              );
            }
            currentReference = next;
            activeReferences = nextActive;
          }
          referenceReset = {
            prepared: true,
            cleared: cleared.length,
            initial,
            inventory: currentReference,
          };
        }
        preparationStage(ctx, "characters");
        const inventory = async (): Promise<Record<string, unknown>> => {
          const result = await runOpenCliBrowser(
            cfg,
            session,
            withTab(["eval", characterPromptInventoryScript()], tab),
            ctx
          );
          if (!result || typeof result !== "object") {
            throw new Error("opencli_browser: 无法读取 NovelAI Character Prompts 状态");
          }
          return result as Record<string, unknown>;
        };
        const countOf = (row: Record<string, unknown>): number => {
          const count = Number(row.count);
          if (!Number.isInteger(count) || count < 0 || count > 100) {
            throw new Error(`opencli_browser: Character Prompts 数量无效：${JSON.stringify(row).slice(0, 500)}`);
          }
          return count;
        };

        let current = await inventory();
        let currentCount = countOf(current);
        const removed: unknown[] = [];
        while (currentCount > 0) {
          const combined = batchReferenceSetup ? await runOpenCliBrowser(cfg, session,
            withTab(["eval", `(async () => {
              const step = ${removeLastCharacterPromptScript()};
              await new Promise(resolve => setTimeout(resolve, 250));
              return {step, inventory: ${characterPromptInventoryScript()}};
            })()`], tab), ctx) as Record<string, unknown> : undefined;
          if (batchReferenceSetup) requireNovelAiPreparationBatchReceipt(combined, ["step", "inventory"]);
          const result = batchReferenceSetup ? combined!.step : await runOpenCliBrowser(
            cfg,
            session,
            withTab(["eval", removeLastCharacterPromptScript()], tab),
            ctx
          );
          removed.push(result);
          if (!batchReferenceSetup) await waitBriefly(250, ctx.signal);
          const next = batchReferenceSetup ? combined!.inventory as Record<string, unknown> : await inventory();
          const nextCount = countOf(next);
          if (nextCount !== currentCount - 1) {
            throw new Error(
              `opencli_browser: 删除遗留 Character Prompt 未生效；before=${currentCount}, after=${nextCount}`
            );
          }
          current = next;
          currentCount = nextCount;
        }

        const added: unknown[] = [];
        for (const rawGender of characters) {
          const gender = rawGender as "female" | "male" | "other";
          const combined = batchReferenceSetup ? await runOpenCliBrowser(cfg, session,
            withTab(["eval", `(async () => {
              const opened = ${openCharacterPromptMenuScript()};
              await new Promise(resolve => setTimeout(resolve, 150));
              const selected = ${selectCharacterPromptGenderScript(gender)};
              await new Promise(resolve => setTimeout(resolve, 250));
              return {opened, selected, inventory: ${characterPromptInventoryScript()}};
            })()`], tab), ctx) as Record<string, unknown> : undefined;
          if (batchReferenceSetup) requireNovelAiPreparationBatchReceipt(combined, ["opened", "selected", "inventory"]);
          const opened = batchReferenceSetup ? combined!.opened : await runOpenCliBrowser(
            cfg,
            session,
            withTab(["eval", openCharacterPromptMenuScript()], tab),
            ctx
          );
          if (!batchReferenceSetup) await waitBriefly(150, ctx.signal);
          const selected = batchReferenceSetup ? combined!.selected : await runOpenCliBrowser(
            cfg,
            session,
            withTab(["eval", selectCharacterPromptGenderScript(gender)], tab),
            ctx
          );
          if (!batchReferenceSetup) await waitBriefly(250, ctx.signal);
          const next = batchReferenceSetup ? combined!.inventory as Record<string, unknown> : await inventory();
          const nextCount = countOf(next);
          if (nextCount !== currentCount + 1) {
            throw new Error(
              `opencli_browser: 新建 ${gender} Character Prompt 未生效；before=${currentCount}, after=${nextCount}`
            );
          }
          added.push({ gender, opened, selected });
          current = next;
          currentCount = nextCount;
        }
        if (currentCount !== characters.length) {
          throw new Error(
            `opencli_browser: Character Prompts 最终数量不符；expected=${characters.length}, actual=${currentCount}`
          );
        }
        let stableFields: Record<string, unknown> | undefined;
        let promptFields: Record<string, unknown> | undefined;
        if (action === "prepare_novelai_form") {
          preparationStage(ctx, "settings");
          if (submission?.form?.sfwSampling) {
            const sampling = submission.form.sfwSampling as NovelAiSfwSampling;
            await configureNovelAiSfwSampling(sampling, args => runOpenCliBrowser(cfg, session, withTab(args, tab), ctx));
          }
          const configureScript = configureNovelAiStableFieldsScript({
              characterNames: characterNames ?? undefined,
              orientation: orientation as "landscape" | "portrait" | "square" | undefined,
              width,
              height,
              numberOfImages,
            });
          const combined = batchReferenceSetup ? await runOpenCliBrowser(cfg, session,
            withTab(["eval", `(async () => {
              const configured = ${configureScript};
              await new Promise(resolve => setTimeout(resolve, 750));
              return {configured, inspected: ${inspectNovelAiScript()}};
            })()`], tab), ctx) as Record<string, unknown> : undefined;
          if (batchReferenceSetup) requireNovelAiPreparationBatchReceipt(combined, ["configured", "inspected"]);
          const configured = batchReferenceSetup ? combined!.configured : await runOpenCliBrowser(cfg, session, withTab(["eval", configureScript], tab), ctx);
          if (!batchReferenceSetup) await waitBriefly(750, ctx.signal);
          const inspected = batchReferenceSetup ? combined!.inspected : await runOpenCliBrowser(
            cfg,
            session,
            withTab(["eval", inspectNovelAiScript()], tab),
            ctx
          );
          if (!configured || typeof configured !== "object" || !inspected || typeof inspected !== "object") {
            throw new Error("opencli_browser: NovelAI 稳定字段设置后无法验证");
          }
          const intended = ((configured as Record<string, unknown>).intended ?? {}) as Record<string, unknown>;
          const form = ((inspected as Record<string, unknown>).form ?? {}) as Record<string, unknown>;
          const resolution = (form.resolution ?? {}) as Record<string, unknown>;
          const generation = ((inspected as Record<string, unknown>).generation ?? {}) as Record<string, unknown>;
          const actualCharacters = Array.isArray(form.characters)
            ? form.characters as Array<Record<string, unknown>>
            : [];
          if (characterNames && characterNames.some((name, index) => String(actualCharacters[index]?.value ?? "") !== name)) {
            throw new Error(`opencli_browser: Character 名称设置后回读不符：${JSON.stringify(actualCharacters).slice(0, 800)}`);
          }
          const expectedWidth = Number(intended.width);
          const expectedHeight = Number(intended.height);
          if (Number.isFinite(expectedWidth) && Number(resolution.width) !== expectedWidth ||
              Number.isFinite(expectedHeight) && Number(resolution.height) !== expectedHeight) {
            throw new Error(
              `opencli_browser: NovelAI 分辨率设置后回读不符；expected=${expectedWidth}x${expectedHeight}, actual=${resolution.width}x${resolution.height}`
            );
          }
          if (numberOfImages !== undefined && Number(generation.numberOfImages) !== numberOfImages) {
            throw new Error(
              `opencli_browser: Number of Images 设置后回读不符；expected=${numberOfImages}, actual=${generation.numberOfImages}`
            );
          }
          let finalInspection: unknown = inspected;
          if (hasPromptBundle) {
            const readTokens = !!submission?.form && !!preparedModel && supportsNovelAiPreciseReferences(preparedModel);
            const readings: Array<{ field: string; lane: "positive" | "negative"; used: number; max: number }> = [];
            const fields: Array<{ field: string; lane: "positive" | "negative"; options: { scopeText: string; tabText: string; text: string } }> = [];
            const fill = async (field: string, lane: "positive" | "negative", options: { scopeText: string; tabText: string; text: string }) => {
              preparationStage(ctx, "prompt-fill", `${lane}/${field}`);
              await fillScopedRichText(cfg, session, tab, ctx, options);
              fields.push({ field, lane, options });
            };
            await fill("base", "positive", {
              scopeText: "Base Prompt",
              tabText: "Base Prompt",
              text: basePrompt!,
            });
            await fill("base", "negative", {
              scopeText: "Base Prompt",
              tabText: "Undesired Content",
              text: undesiredPrompt!,
            });
            for (let index = 0; index < characters.length; index += 1) {
              await fill(`character:${index + 1}`, "positive", {
                scopeText: `Character ${index + 1}`,
                tabText: "Prompt",
                text: characterPrompts![index]!,
              });
              await fill(`character:${index + 1}`, "negative", {
                scopeText: `Character ${index + 1}`,
                tabText: "Undesired Content",
                text: characterUndesiredPrompts![index]!,
              });
            }
            const auditNonce = randomUUID();
            if (readTokens) {
              preparationStage(ctx, "token-audit");
              await runOpenCliBrowser(cfg, session, withTab(["eval", novelAiPromptAuditScript(auditNonce, true)], tab), ctx);
              // A second, read-only pass checks frozen text and actual counters
              // after every field has been filled. No fills occur during audit.
              for (const { field, lane, options } of fields) {
                preparationStage(ctx, "token-audit", `${lane}/${field}`);
                const result = await fillScopedRichText(cfg, session, tab, ctx, { ...options, readTokens: true, verifyOnly: true,
                  batchCounter: batchReferenceSetup });
                const tokens = result.tokens as ReturnType<typeof parseNovelAiPromptTokenCounter>;
                readings.push({ field, lane, used: tokens.used, max: tokens.max });
              }
            }
            let tokenBudget: ReturnType<typeof assessNovelAiPromptBudget> | undefined;
            try {
              tokenBudget = readTokens ? assessNovelAiPromptBudget(readings, characters.length) : undefined;
            } catch (error) {
              if (novelAiPromptBudgetOverflowReport(error)) {
                // Incomplete/stale readings must never become reusable failure evidence.
                await runOpenCliBrowser(cfg, session, withTab(["eval", novelAiPromptAuditScript(auditNonce, false)], tab), ctx);
                const key = novelAiPromptBudgetFailureKey(submission);
                if (key && ctx.execution) {
                  ctx.execution.toolEvidence ??= new Map();
                  ctx.execution.toolEvidence.set(key, error);
                }
              }
              throw error;
            }
            if (tokenBudget && submission) {
              const nonce = randomUUID();
              await runOpenCliBrowser(cfg, session, withTab(["eval", `(() => { ${novelAiPromptAuditScript(auditNonce, false)}; return ${novelAiPromptBudgetProofScript(nonce, true)}; })()`], tab), ctx);
              ctx.runState?.set(NOVELAI_PROMPT_BUDGET_KEY + (tab ?? "default"), { signature: frozenFormSignature(submission), nonce });
            }
            preparationStage(ctx, "final-verification");
            finalInspection = await runOpenCliBrowser(
              cfg,
              session,
              withTab(["eval", inspectNovelAiScript()], tab),
              ctx
            );
            if (!finalInspection || typeof finalInspection !== "object") {
              throw new Error("opencli_browser: NovelAI 提示词设置后无法读取最终表单状态");
            }
            promptFields = {
              configured: true,
              verified: true,
              basePromptLength: basePrompt!.length,
              undesiredPromptLength: undesiredPrompt!.length,
              characterPromptLengths: characterPrompts!.map((value) => value.length),
              characterUndesiredPromptLengths: characterUndesiredPrompts!.map((value) => value.length),
              ...(tokenBudget ? { tokenBudget } : {}),
            };
          }
          current = await inventory();
          stableFields = { configured, inspected: finalInspection };
        }
        if (action === "prepare_novelai_form" && submission?.form && promptFields?.verified === true) {
          const resetInventory = referenceReset?.inventory as Record<string, unknown> | undefined;
          if (resetInventory?.active !== 0) throw new Error("冻结表单准备后无法确认旧参考图已清空，不能继续上传或 Generate。");
          assertSameReferences(await inspectNovelAiReferences(cfg, session, tab, ctx), []);
          ctx.runState?.set(NOVELAI_PREPARED_KEY + (tab ?? "default"), frozenFormSignature(submission));
          // Only a confirmed upload followed by a confirmed reset is safely
          // repeatable. Unknown uploads never produced a proof and stay locked.
          for (const identity of confirmedBeforeReset) activationOnceKeys(ctx).delete(novelAiReferenceOnceKey(ctx, identity));
          if (pendingReset?.signature === frozenFormSignature(submission)) ctx.runState?.delete(pendingResetKey);
        }
        return {
          session,
          tab,
          result: {
            prepared: true,
            formPrepared: action === "prepare_novelai_form",
            characters,
            ...(referenceReset ? { referenceReset } : {}),
            removed: removed.length,
            added,
            ...(stableFields ? { stableFields } : {}),
            ...(promptFields ? { promptFields } : {}),
            inventory: current,
          },
        };
      }
      if (action === "save_data_image") {
        const selector = input.selector === undefined
          ? undefined
          : requiredString(input.selector, "selector", 1_000);
        const nth = input.nth === undefined ? 0 : Number(input.nth);
        if (!Number.isInteger(nth) || nth < 0 || nth > 10_000) {
          throw new Error("opencli_browser: nth 必须是非负整数");
        }
        const result = await runOpenCliBrowser(
          cfg,
          session,
          withTab(["eval", dataImageExportScript(selector, nth)], tab),
          ctx,
          DEFAULT_TIMEOUT_MS,
          MAX_DATA_IMAGE_OUTPUT_CHARS
        );
        const artifact = await persistRenderedImage(cfg, session, tab, ctx, result);
        const delivery = typeof artifact.path === "string"
          ? await deliverBrowserImage(ctx, artifact.path, cfg.downloadDir, cfg.attachmentRoots[0]!) : {};
        return { ...artifact, ...delivery };
      }
      if (action === "fill" || action === "type") {
        const located = targetAndFlags(input);
        const value = requiredString(input.text, "text", 10_000);
        const args = [action];
        if (located.target) args.push(located.target, value);
        else args.push(value);
        args.push(...located.flags);
        try {
          return { session, tab, result: await runOpenCliBrowser(cfg, session, withTab(args, tab), ctx) };
        } catch (error) {
          const recovered = action === "fill" ? recoverContentEditableFill(error, value) : undefined;
          if (recovered === undefined) throw error;
          return { session, tab, result: recovered };
        }
      }
      if (action === "fill_richtext") {
        const scopeText = requiredString(input.scopeText, "scopeText", 500);
        const tabText = input.tabText === undefined
          ? undefined
          : requiredString(input.tabText, "tabText", 200);
        const value = requiredString(input.text, "text", 10_000);
        const nth = input.nth === undefined ? 0 : Number(input.nth);
        if (!Number.isInteger(nth) || nth < 0 || nth > 100) {
          throw new Error("opencli_browser: fill_richtext nth 必须是 0–100 的整数");
        }
        const result = await fillScopedRichText(cfg, session, tab, ctx, {
          scopeText,
          tabText,
          text: value,
          nth,
        });
        return {
          session,
          tab,
          result,
        };
      }
      if (action === "select") {
        const located = targetAndFlags(input);
        const value = requiredString(input.value, "value", 2_000);
        const args = ["select"];
        if (located.target) args.push(located.target, value);
        else args.push(value);
        args.push(...located.flags);
        return { session, tab, result: await runOpenCliBrowser(cfg, session, withTab(args, tab), ctx) };
      }
      if (action === "press") {
        const args = ["keys", requiredString(input.key, "key", 100)];
        return { session, tab, result: await guardedNovelAiMutation(cfg, session, tab, ctx,
          () => runOpenCliBrowser(cfg, session, withTab(args, tab), ctx)) };
      }
      if (action === "scroll") {
        const direction = requiredString(input.direction, "direction", 10);
        if (direction !== "up" && direction !== "down") throw new Error("opencli_browser: direction 只允许 up/down");
        const args = ["scroll", direction];
        if (input.pixels !== undefined) args.push("--amount", String(Number(input.pixels)));
        return { session, tab, result: await runOpenCliBrowser(cfg, session, withTab(args, tab), ctx) };
      }
      if (action === "wait") {
        // 只给 timeoutMs 是常见且无歧义的“等一段时间”，直接收敛为 time，避免浪费一个模型 turn。
        const kind = input.waitType === undefined && input.timeoutMs !== undefined
          ? "time"
          : requiredString(input.waitType, "waitType", 20);
        if (!["selector", "text", "time", "xhr", "download"].includes(kind)) {
          throw new Error("opencli_browser: waitType 只允许 selector/text/time/xhr/download");
        }
        const value = input.value === undefined ? undefined : requiredString(input.value, "value", 2_000);
        if (kind === "time") {
          // OpenCLI Browser 的 `wait time N` 在部分版本中只回显 `Waited Ns`，并不会
          // 阻塞 N 秒。固定时间等待属于 Harbour 自己就能确定性完成的事情，因此在
          // 进程内执行，并直接绑定 run 的 AbortSignal；不会触碰 Chrome，也不会消耗
          // 额外模型 turn。timeoutMs 是规范入口，value 仅兼容旧的“秒”参数。
          const rawMs = input.timeoutMs !== undefined
            ? Number(input.timeoutMs)
            : value === undefined
              ? 2_000
              : Number(value) * 1_000;
          const durationMs = Math.round(rawMs);
          if (!Number.isFinite(rawMs) || !Number.isInteger(durationMs) || durationMs < 100 || durationMs > 90_000) {
            throw new Error("opencli_browser: wait time 必须是 100–90000ms；请优先传 timeoutMs");
          }
          await waitBriefly(durationMs, ctx.signal);
          return { session, tab, result: { waitedMs: durationMs, source: "harbour-timer" } };
        }
        const args = ["wait", kind];
        if (value) args.push(value);
        if (input.timeoutMs !== undefined) args.push("--timeout", String(Number(input.timeoutMs)));
        return { session, tab, result: await runOpenCliBrowser(cfg, session, withTab(args, tab), ctx, 100_000) };
      }
      if (action === "screenshot") {
        mkdirSync(cfg.screenshotDir, { recursive: true });
        const output = path.join(cfg.screenshotDir, `${Date.now()}-${randomUUID().slice(0, 8)}.png`);
        const args = ["screenshot", output];
        if (input.fullPage === true) args.push("--full-page");
        if (input.annotate === true) args.push("--annotate");
        const result = await runOpenCliBrowser(cfg, session, withTab(args, tab), ctx);
        const delivery = await deliverBrowserImage(ctx, output, cfg.screenshotDir, cfg.attachmentRoots[0]!);
        return { session, tab, path: output, result, ...delivery };
      }
      throw new Error(`opencli_browser: 未知 action ${action}`);
    },
  };

  const executeBrowser = browser.execute;
  browser.execute = (input, ctx) => {
    if (input.action !== "prepare_novelai_form" && input.action !== "prepare_character_prompts") return executeBrowser(input, ctx);
    const prepare = (context: ToolContext) => observeNovelAiPreparation(context, scoped => executeBrowser(input, scoped), optionalTab(input.tab) ?? "default");
    const tab = optionalTab(input.tab);
    const submission = ctx.execution?.novelAiSubmission;
    // A minimized Chrome delays each real hover ACK by ~5s. Keep only this
    // run's exact reference-model page rendering during preparation. The
    // host scope restores emulation even when a CLI child is killed; it never
    // activates an OS window and does not replace any OpenCLI page operation.
    // Unbound/default tabs, headless and no-reference V5 retain their path.
    const focusScope = input.action === "prepare_novelai_form" && submission?.form && submission.requiredReferences?.length &&
      submission.expectedModel && supportsNovelAiPreciseReferences(submission.expectedModel) && tab &&
      openedTabs(ctx).has(tab) && !cfg.browser.headless;
    return focusScope ? withManagedPageFocus(cfg.browser, tab, ctx.signal, signal => {
      try { ctx.logger?.info({ applied: true }, "novelai:background-focus"); } catch { /* diagnostics only */ }
      return prepare({ ...ctx, signal });
    }).catch(error => {
      // Scope cleanup is outside the command observer. A successful form must
      // not remain usable after its outer host operation reports failure.
      if (error instanceof ManagedPageFocusCleanupError) markNovelAiPreparationInterrupted(ctx, tab);
      throw error;
    }) : prepare(ctx);
  };
  return [browser];
}
