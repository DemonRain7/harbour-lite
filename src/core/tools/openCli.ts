import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Env } from "../../config/env";
import type { ToolContext, ToolDef } from "../../types";
import { ASK_MAX_WAIT_MS } from "../askUser";
import { spawnOpenCli } from "./openCliProcess";
import { assertNovelAiExecutionActionAllowed, recordNovelAiExecutionAction } from "../novelAiExecutionStage";
import { assertNovelAiModelSelectionUsable } from "./novelAiModelSelectionPage";

const MAX_OUTPUT_CHARS = 60_000;
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_SEARCH_RESULTS = 20;
const MAX_ARGUMENTS = 24;
const MAX_MATCH_RESULTS = 12;

interface OpenCliArg {
  name: string;
  type?: string;
  required?: boolean;
  positional?: boolean;
  default?: unknown;
  choices?: unknown[];
  help?: string;
}

interface OpenCliManifestEntry {
  site: string;
  name: string;
  description?: string;
  access?: string;
  domain?: string;
  strategy?: string;
  browser?: boolean;
  args?: OpenCliArg[];
  columns?: string[];
  example?: string;
}

type OpenCliAccess = "read" | "write";

export interface OpenCliConfig {
  entryPath: string;
  manifestPath: string;
  profile: string;
}

/**
 * OpenCLI 作为项目锁定依赖运行，不依赖某台机器的全局 PATH。全局安装仍方便主人在终端
 * 调试；Harbour 运行时始终使用 package-lock 固定下来的版本。
 */
export function resolveOpenCliConfig(env: Env): OpenCliConfig {
  const entryPath = require.resolve("@jackwener/opencli");
  const packageRoot = path.resolve(path.dirname(entryPath), "..", "..");
  const manifestPath = path.join(packageRoot, "cli-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`OpenCLI manifest 不存在：${manifestPath}`);
  }
  return {
    entryPath,
    manifestPath,
    // 固定使用 Harbour 的 Browser Bridge profile alias，避免以后误连日常 Chrome。
    profile: env.OPENCLI_PROFILE,
  };
}

function commandOf(entry: OpenCliManifestEntry): string {
  return `${entry.site}/${entry.name}`;
}

function normalizedSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/gu, "");
}

function targetHostname(value: string): string {
  const match = value.match(/https?:\/\/[^\s<>'"]+/iu);
  if (!match) return "";
  try {
    return new URL(match[0]).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function loadManifest(cfg: OpenCliConfig): OpenCliManifestEntry[] {
  const parsed = JSON.parse(readFileSync(cfg.manifestPath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("OpenCLI manifest 格式无效：根节点不是数组");
  return parsed.filter((value): value is OpenCliManifestEntry => {
    if (!value || typeof value !== "object") return false;
    const row = value as Partial<OpenCliManifestEntry>;
    return typeof row.site === "string" && typeof row.name === "string";
  });
}

function hostnameFromDomain(domain: string | undefined): string {
  if (!domain) return "";
  const raw = domain.trim().replace(/^\*\./, "");
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isPublicHostname(hostname: string): boolean {
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return false;
  }
  if (hostname === "0.0.0.0" || hostname === "::1" || hostname.startsWith("127.") || hostname.startsWith("169.254.")) {
    return false;
  }
  const octets = hostname.split(".").map(Number);
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    if (octets[0] === 10 || octets[0] === 127) return false;
    if (octets[0] === 192 && octets[1] === 168) return false;
    if (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) return false;
  }
  return hostname.includes(".");
}

function domainMatches(target: string, domain: string | undefined): boolean {
  const adapter = hostnameFromDomain(domain).replace(/^www\./, "");
  return !!adapter && (target === adapter || target.endsWith(`.${adapter}`) || adapter.endsWith(`.${target}`));
}

const LOCAL_WRITE_COMMAND = /(?:^|[-_])(download|export|screenshot|attachment-download|preview)(?:$|[-_])/i;
const SENSITIVE_OR_LOCAL_ARG = /^(?:include-sensitive|token|api-?key|secret|password|passwd|cookie|credential|auth|authorization|output|out|file|filename|directory|dir|path|image|images|video|pdf|cover|media|attachment|attachments|download-images|manifestPath|storage|max-bytes)$/i;

function accessOf(entry: OpenCliManifestEntry): OpenCliAccess | undefined {
  return entry.access === "read" || entry.access === "write" ? entry.access : undefined;
}

function eligibility(entry: OpenCliManifestEntry): { eligible: true; access: OpenCliAccess } | { eligible: false; reason: string } {
  const access = accessOf(entry);
  if (!access) return { eligible: false, reason: `access=${entry.access || "unknown"}，Harbour 无法判断副作用` };
  if (entry.strategy === "local") return { eligible: false, reason: "本机/桌面适配器不属于 Harbour 网页工具范围" };
  if (!isPublicHostname(hostnameFromDomain(entry.domain))) {
    return { eligible: false, reason: "未声明可验证的公网站点域名" };
  }
  if (LOCAL_WRITE_COMMAND.test(entry.name)) {
    return { eligible: false, reason: "命令会下载、导出、截图或写入本地文件" };
  }
  const requiredUnsafe = (entry.args ?? []).find((arg) => arg.required && SENSITIVE_OR_LOCAL_ARG.test(arg.name));
  if (requiredUnsafe) return { eligible: false, reason: `必填参数 ${requiredUnsafe.name} 会读取敏感数据或写本地文件` };
  return { eligible: true, access };
}

function publicMetadata(entry: OpenCliManifestEntry): Record<string, unknown> {
  const status = eligibility(entry);
  return {
    command: commandOf(entry),
    description: entry.description ?? "",
    access: entry.access ?? "unknown",
    strategy: entry.strategy ?? "unknown",
    browser: entry.browser === true,
    domain: entry.domain ?? "",
    eligible: status.eligible,
    requiresConfirmation: status.eligible && status.access === "write",
    ...(status.eligible ? {} : { blockedReason: status.reason }),
    arguments: (entry.args ?? []).map((arg) => ({
      name: arg.name,
      type: arg.type ?? "string",
      required: arg.required === true,
      positional: arg.positional === true,
      choices: Array.isArray(arg.choices) ? arg.choices : [],
      default: arg.default,
      help: arg.help ?? "",
      allowedByHarbour: !SENSITIVE_OR_LOCAL_ARG.test(arg.name),
    })),
    columns: entry.columns ?? [],
  };
}

function matchManifest(
  manifest: OpenCliManifestEntry[],
  target: string,
  task: string
): { matched: boolean; basis: "domain" | "site" | "none"; candidates: Record<string, unknown>[] } {
  const hostname = targetHostname(target);
  const compactTarget = normalizedSearchText(`${target} ${task}`);
  const taskTerms = `${target} ${task}`
    .toLowerCase()
    .split(/[^a-z0-9\u3400-\u9fff]+/u)
    .filter((term) => term.length >= 2);

  const ranked = manifest
    .map((entry) => {
      const status = eligibility(entry);
      if (!status.eligible) return null;
      const domainHit = !!hostname && domainMatches(hostname, entry.domain);
      const site = normalizedSearchText(entry.site);
      const domain = normalizedSearchText(hostnameFromDomain(entry.domain));
      const siteHit = !hostname && !!site && (compactTarget.includes(site) || (!!domain && compactTarget.includes(domain)));
      if (!domainHit && !siteHit) return null;
      const haystack = `${entry.site} ${entry.name} ${entry.description ?? ""}`.toLowerCase();
      const taskScore = taskTerms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
      return { entry, domainHit, taskScore };
    })
    .filter((value): value is { entry: OpenCliManifestEntry; domainHit: boolean; taskScore: number } => value !== null)
    .sort((a, b) => Number(b.domainHit) - Number(a.domainHit) || b.taskScore - a.taskScore || commandOf(a.entry).localeCompare(commandOf(b.entry)))
    .slice(0, MAX_MATCH_RESULTS);

  return {
    matched: ranked.length > 0,
    basis: ranked.length === 0 ? "none" : ranked[0]!.domainHit ? "domain" : "site",
    candidates: ranked.map(({ entry }) => publicMetadata(entry)),
  };
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`opencli_adapter: 缺少 ${field}`);
  if (value.length > max) throw new Error(`opencli_adapter: ${field} 过长（最多 ${max} 字符）`);
  return value.trim();
}

function entryByCommand(manifest: OpenCliManifestEntry[], value: unknown): OpenCliManifestEntry {
  const command = requiredString(value, "command", 200).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/i.test(command)) {
    throw new Error("opencli_adapter: command 必须是 site/command");
  }
  const entry = manifest.find((candidate) => commandOf(candidate).toLowerCase() === command);
  if (!entry) throw new Error(`opencli_adapter: OpenCLI 没有适配器 ${command}`);
  return entry;
}

function scalar(value: unknown, arg: OpenCliArg): string {
  if (typeof value === "string") {
    if (value.length > 4_000) throw new Error(`opencli_adapter: 参数 ${arg.name} 过长`);
    if (arg.positional && value.startsWith("-")) throw new Error(`opencli_adapter: 位置参数 ${arg.name} 不得以 - 开头`);
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new Error(`opencli_adapter: 参数 ${arg.name} 必须是字符串或数字`);
}

function buildCommandArgs(entry: OpenCliManifestEntry, supplied: unknown): string[] {
  const values = supplied === undefined ? {} : supplied;
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("opencli_adapter: arguments 必须是按 manifest 参数名给值的对象");
  }
  const record = values as Record<string, unknown>;
  if (Object.keys(record).length > MAX_ARGUMENTS) throw new Error(`opencli_adapter: 参数最多 ${MAX_ARGUMENTS} 个`);
  const definitions = entry.args ?? [];
  const known = new Map(definitions.map((arg) => [arg.name, arg]));
  for (const name of Object.keys(record)) {
    if (!known.has(name)) throw new Error(`opencli_adapter: ${commandOf(entry)} 没有参数 ${name}`);
    if (SENSITIVE_OR_LOCAL_ARG.test(name)) {
      throw new Error(`opencli_adapter: Harbour 禁止参数 ${name}（敏感数据或本地文件能力）`);
    }
  }

  const flags: string[] = ["-f", "json"];
  const positionals: string[] = [];
  for (const arg of definitions) {
    const value = record[arg.name];
    const absent = value === undefined || value === null || value === "";
    if (absent) {
      if (arg.required) throw new Error(`opencli_adapter: 缺少必填参数 ${arg.name}`);
      continue;
    }
    if (arg.type === "boolean" || arg.type === "bool") {
      if (typeof value !== "boolean") throw new Error(`opencli_adapter: 参数 ${arg.name} 必须是 boolean`);
      if (value) flags.push(`--${arg.name}`);
      continue;
    }
    if (["int", "number", "float"].includes(arg.type ?? "")) {
      const numeric = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(numeric) || (arg.type === "int" && !Number.isInteger(numeric))) {
        throw new Error(`opencli_adapter: 参数 ${arg.name} 必须是${arg.type === "int" ? "整数" : "数字"}`);
      }
    }
    const rendered = scalar(value, arg);
    if (Array.isArray(arg.choices) && arg.choices.length && !arg.choices.map(String).includes(rendered)) {
      throw new Error(`opencli_adapter: 参数 ${arg.name} 只能是 ${arg.choices.map(String).join("/")}`);
    }
    if (arg.positional) positionals.push(rendered);
    else flags.push(`--${arg.name}`, rendered);
  }
  return [entry.site, entry.name, ...flags, ...positionals];
}

function appendBounded(current: string, chunk: Buffer | string): string {
  if (current.length >= MAX_OUTPUT_CHARS) return current;
  return (current + chunk.toString()).slice(0, MAX_OUTPUT_CHARS);
}

function parseOutput(raw: string): unknown {
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, MAX_OUTPUT_CHARS);
  }
}

/** 浏览器型 adapter 执行前快速探测 Bridge，避免扩展未连接时白等 OpenCLI 的长超时。 */
async function browserBridgeReady(cfg: OpenCliConfig, ctx: ToolContext): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnOpenCli(cfg.entryPath, ["daemon", "status"], {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(false);
      return;
    }
    let stdout = "";
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", abort);
      resolve(ready);
    };
    const abort = () => {
      child.kill();
      finish(false);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 5_000);
    child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.on("error", () => finish(false));
    child.on("close", (code) => {
      const connected = /Extension:\s*connected\b/i.test(stdout) && !/Extension:\s*disconnected\b/i.test(stdout);
      finish(code === 0 && connected);
    });
    if (ctx.signal?.aborted) abort();
    else ctx.signal?.addEventListener("abort", abort, { once: true });
  });
}

const EXIT_REASON: Record<number, string> = {
  66: "适配器没有返回结果",
  69: "Browser Bridge 未连接或暂不可用",
  75: "页面或网络暂时超时",
  77: "站点需要登录/认证",
  78: "OpenCLI 或适配器配置无效",
};

async function runOpenCli(
  cfg: OpenCliConfig,
  args: string[],
  ctx: ToolContext,
  options: { retrySafe: boolean }
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnOpenCli(cfg.entryPath, ["--profile", cfg.profile, ...args], {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new Error(`OpenCLI 启动失败：${(error as Error).message}`));
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
      finish(() => reject(new Error("OpenCLI 操作已停止")));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => resolve({
        ok: false,
        reason: "OpenCLI 执行超时",
        fallbackRecommended: options.retrySafe,
        retrySafe: options.retrySafe,
        ...(!options.retrySafe ? { sideEffectUncertain: true } : {}),
      }));
    }, DEFAULT_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.on("error", (error) => finish(() => reject(new Error(`OpenCLI 启动失败：${error.message}`))));
    child.on("close", (code) => finish(() => {
      const parsed = parseOutput(stdout);
      if (code !== 0) {
        const detail = (stderr.trim() || stdout.trim()).slice(0, 2_000);
        resolve({
          ok: false,
          exitCode: code,
          reason: EXIT_REASON[code ?? -1] ?? (detail || `OpenCLI exit ${code}`),
          detail,
          fallbackRecommended: options.retrySafe,
          retrySafe: options.retrySafe,
          ...(!options.retrySafe ? { sideEffectUncertain: true } : {}),
        });
        return;
      }
      const empty = parsed === null || (Array.isArray(parsed) && parsed.length === 0);
      if (empty) {
        resolve({
          ok: false,
          reason: "OpenCLI 返回空结果",
          fallbackRecommended: options.retrySafe,
          retrySafe: options.retrySafe,
        });
        return;
      }
      resolve({ ok: true, data: parsed });
    }));

    if (ctx.signal?.aborted) abort();
    else ctx.signal?.addEventListener("abort", abort, { once: true });
  });
}

async function confirmWrite(
  entry: OpenCliManifestEntry,
  supplied: unknown,
  ctx: ToolContext
): Promise<{ approved: true } | { approved: false; result: Record<string, unknown> }> {
  const command = commandOf(entry);
  if (!ctx.askUser) {
    return {
      approved: false,
      result: {
        ok: false,
        refused: true,
        needsConfirmation: true,
        command,
        reason:
          "这是 OpenCLI 网站写操作。当前渠道没有即时安全确认能力，因此没有执行；" +
          "请在 Harbour Web 主聊天发起同一请求并在确认卡片中批准。",
        fallbackRecommended: false,
      },
    };
  }
  const answer = await ctx.askUser({
    kind: "confirm",
    question: `允许 OpenCLI 执行网站写操作 ${command} 吗？`,
    detail: JSON.stringify({ command, arguments: supplied ?? {} }, null, 2).slice(0, 8_000),
    options: [
      { value: "approve", label: "执行", hint: "确认这次具体的网站变更" },
      { value: "deny", label: "取消", hint: "不执行（默认）" },
    ],
  });
  if (answer !== "approve") {
    return {
      approved: false,
      result: {
        ok: false,
        refused: true,
        command,
        reason: "OpenCLI 网站写操作未获批准，没有执行。",
        fallbackRecommended: false,
      },
    };
  }
  return { approved: true };
}

export function createOpenCliTools(
  cfg: OpenCliConfig,
  ensureBrowserBridge?: (ctx: ToolContext) => Promise<void>
): ToolDef[] {
  const manifest = loadManifest(cfg);
  const tool: ToolDef = {
    name: "opencli_adapter",
    description:
      "通过 OpenCLI 的结构化网站适配器完成网页任务。match 在内存目录中按 URL/站点匹配，search 查命令，info 看访问类型，run 执行；" +
      "只读失败且 fallbackRecommended=true 时再改用 opencli_browser。网站写操作会弹出确认且失败后禁止自动重试/切浏览器。",
    timeoutMs: ASK_MAX_WAIT_MS + DEFAULT_TIMEOUT_MS + 30_000,
    readOnly: false,
    onReplay(_result, _args, ctx) {
      // Never reconstruct a no-payment proof from a prior adapter result.
      recordNovelAiExecutionAction(ctx.execution, "checkpoint:replay");
    },
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["match", "search", "info", "run"] },
        target: { type: "string", description: "match 的 URL、域名或站点名称" },
        task: { type: "string", description: "match 的具体网页目标，用于候选排序" },
        query: { type: "string", description: "search 的站点、命令或描述关键词" },
        command: { type: "string", description: "info/run 使用的 site/command" },
        arguments: {
          type: "object",
          description: "run 的参数对象；键必须与 info 返回的 arguments.name 完全一致",
          additionalProperties: { type: ["string", "number", "boolean"] },
        },
      },
      required: ["action"],
    },
    async execute(input, ctx) {
      const action = requiredString(input.action, "action", 20);
      assertNovelAiModelSelectionUsable(ctx, `adapter:${action}`);
      assertNovelAiExecutionActionAllowed(ctx.execution, `adapter:${action}`);
      recordNovelAiExecutionAction(ctx.execution, `adapter:${action}`);
      if (ctx.execution?.novelAiIntent === "prompt") throw new Error("只要 Prompt，不执行网页操作");
      if (action === "match") {
        const target = requiredString(input.target, "target", 4_000);
        const task = typeof input.task === "string" ? input.task.slice(0, 1_000) : "";
        return { target, ...matchManifest(manifest, target, task) };
      }
      if (action === "search") {
        const query = requiredString(input.query, "query", 200).toLowerCase();
        const matches = manifest
          .filter((entry) => {
            const haystack = `${commandOf(entry)} ${entry.description ?? ""} ${entry.domain ?? ""}`.toLowerCase();
            return haystack.includes(query);
          })
          .map((entry) => ({ entry, status: eligibility(entry) }))
          .sort((a, b) => Number(b.status.eligible) - Number(a.status.eligible))
          .slice(0, MAX_SEARCH_RESULTS)
          .map(({ entry }) => publicMetadata(entry));
        return { query, count: matches.length, matches };
      }

      const entry = entryByCommand(manifest, input.command);
      if (action === "info") return publicMetadata(entry);
      if (action !== "run") throw new Error(`opencli_adapter: 未知 action ${action}`);
      const status = eligibility(entry);
      if (!status.eligible) throw new Error(`opencli_adapter: 拒绝运行 ${commandOf(entry)}：${status.reason}`);
      if (ctx.execution?.novelAiIntent === "readiness" && status.access !== "read") throw new Error("readiness 只允许只读适配器");
      const args = buildCommandArgs(entry, input.arguments);
      let bridgeReady = true;
      if (entry.browser) {
        bridgeReady = ensureBrowserBridge
          ? await ensureBrowserBridge(ctx).then(() => true, () => false)
          : await browserBridgeReady(cfg, ctx);
      }
      if (!bridgeReady) {
        return {
          ok: false,
          reason: "OpenCLI Browser Bridge 未连接到 Harbour 隔离 Chrome",
          fallbackRecommended: status.access === "read",
          retrySafe: status.access === "read",
        };
      }
      if (status.access === "write") {
        const writeKey = `opencli-write:${commandOf(entry)}:${JSON.stringify(args)}`;
        if (ctx.runState?.has(writeKey)) {
          return {
            ok: false,
            refused: true,
            reason: "同一轮已尝试过完全相同的 OpenCLI 网站写操作；为避免重复副作用，不会自动重试。",
            fallbackRecommended: false,
          };
        }
        const confirmation = await confirmWrite(entry, input.arguments, ctx);
        if (!confirmation.approved) return confirmation.result;
        ctx.runState?.set(writeKey, true);
      }
      ctx.logger.info(
        { command: commandOf(entry), access: status.access, profile: cfg.profile },
        "opencli: run manifest-gated adapter"
      );
      return runOpenCli(cfg, args, ctx, { retrySafe: status.access === "read" });
    },
  };
  return [tool];
}
