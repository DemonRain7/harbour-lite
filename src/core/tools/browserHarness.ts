import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import type { Logger } from "pino";
import type { Env } from "../../config/env";
import type { ToolContext, ToolDef } from "../../types";
import { ensureOpenCliUploadGesture } from "./openCliExtensionCompat";
import { ensureOpenCliExtensionRuntime } from "./openCliExtensionRuntime";
import { harbourDataHome } from "../storagePaths";

/**
 * Harbour 浏览器能力的底座：把网页操作全部收进一个 **Harbour 专用隔离 Chrome**，
 * 经 browser-harness（browser-use）走 CDP 操作。
 *
 * 设计要点（对齐主人的隔离要求）：
 *  - 只连自己启动的隔离实例（独立 user-data-dir + 独立调试端口，默认 9333），
 *    绝不 attach 主人日常 Chrome，也绝不用日常 Chrome 的 9222。
 *  - browser-harness 用合成 CDP 事件操作页面（相当于「虚拟指针」）：不抢系统鼠标键盘、可后台跑。
 *  - browser-harness 是 CLI+daemon（heredoc 喂 Python），这里 spawn 它并注入
 *    BU_CDP_URL 指向隔离实例；状态目录 BH_HOME 落主人本地目录、不入库。
 *  - browser-harness/Chrome 不可用 → 抛清晰错误 + 修复建议，**绝不**自动降级去控桌面鼠标。
 *
 * 用工厂 createBrowserHarnessTools(cfg) 以闭包持有配置（在 runtime 装配时按 env 生成）。
 */

export interface BrowserHarnessConfig {
  harnessBin: string;
  chromePath: string; // "" = 自动探测
  profileDir: string;
  extensionDir: string;
  debugPort: number;
  headless: boolean;
  harnessHome: string;
  startTimeoutMs: number;
}

/** All managed browser state stays in Harbour's configured runtime directory. */
function harbourBase(): string {
  return harbourDataHome();
}

function extensionVersion(directory: string): number[] {
  try {
    const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8")) as { version?: unknown };
    return String(manifest.version ?? "0").split(".").map((part) => Number(part) || 0);
  } catch {
    return [0];
  }
}

function compareVersionDesc(left: string, right: string): number {
  const a = extensionVersion(left);
  const b = extensionVersion(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (b[index] ?? 0) - (a[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** 支持直接 unpacked 目录，也支持 setup 脚本留下的 v1.0.x 版本子目录。 */
function resolveExtensionDir(configured: string): string {
  if (existsSync(path.join(configured, "manifest.json"))) return configured;
  try {
    const candidates = readdirSync(configured, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(configured, entry.name))
      .filter((directory) => existsSync(path.join(directory, "manifest.json")))
      .sort(compareVersionDesc);
    return candidates[0] ?? configured;
  } catch {
    return configured;
  }
}

export function resolveBrowserHarnessConfig(env: Env): BrowserHarnessConfig {
  const base = harbourDataHome(env);
  const extensionRoot = env.HARBOUR_CHROME_EXTENSION_DIR || path.join(base, "opencli-extension");
  return {
    harnessBin: env.BROWSER_HARNESS_BIN,
    chromePath: env.HARBOUR_CHROME_PATH,
    profileDir: env.HARBOUR_CHROME_PROFILE_DIR || path.join(base, "chrome-profile"),
    extensionDir: resolveExtensionDir(extensionRoot),
    debugPort: env.HARBOUR_CHROME_DEBUG_PORT,
    headless: env.HARBOUR_CHROME_HEADLESS,
    harnessHome: env.HARBOUR_BROWSER_HARNESS_HOME || path.join(base, "browser-harness"),
    startTimeoutMs: env.HARBOUR_CHROME_START_TIMEOUT_MS,
  };
}

/** 探测本机 Chrome 可执行文件（配了 HARBOUR_CHROME_PATH 则不走这里）。 */
function detectChrome(): string {
  const base = harbourBase();
  const chromeForTestingRoot = path.join(base, "chrome-for-testing");
  let managedChrome = "";
  try {
    managedChrome = readdirSync(chromeForTestingRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))
      .map((entry) => path.join(chromeForTestingRoot, entry.name,
        process.platform === "win32" ? "chrome-win64/chrome.exe" :
          process.platform === "darwin" ? "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" :
            "chrome-linux64/chrome"))
      .find((candidate) => existsSync(candidate)) ?? "";
  } catch {
    /* 未安装专属 Chrome for Testing 时再回退系统浏览器。 */
  }
  const cands =
    process.platform === "win32"
      ? [
          managedChrome,
          path.join(process.env["ProgramFiles"] || "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
          path.join(
            process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
            "Google\\Chrome\\Application\\chrome.exe"
          ),
          path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
        ]
      : process.platform === "darwin"
        ? [
            managedChrome,
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : [
            managedChrome,
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
          ];
  return cands.find((p) => p && existsSync(p)) || "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 模块级单例：我们托管的那个隔离 Chrome 子进程（若是「复用已在运行的实例」则为 null）。
let chromeProc: ChildProcess | null = null;
// 本次进程内是否用过隔离浏览器（launch 或 reuse 都算）；供优雅退出时判断要不要收尾。
let usedChrome = false;
let ensureChromeInFlight: Promise<void> | null = null;
const verifiedExtensionRuntimes = new Set<string>();

async function verifyExtensionRuntime(cfg: BrowserHarnessConfig, logger: Logger, allowReload: boolean, requireVerified = false): Promise<boolean> {
  const owner = readOwnership(cfg);
  if (!owner) throw new Error("Harbour browser: 缺少专属浏览器归属记录，不能核验扩展");
  let diskStamp = "missing";
  try {
    diskStamp = ["manifest.json", "dist/background.js"].map(relative => {
      const file = realpathSync(path.join(cfg.extensionDir, relative));
      const stat = statSync(file);
      return `${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    }).join("|");
  } catch { /* Unknown/custom extensions are classified by the runtime verifier. */ }
  const key = `${owner.pid}:${cfg.debugPort}:${path.resolve(cfg.extensionDir)}:${diskStamp}`;
  if (!requireVerified && verifiedExtensionRuntimes.has(key)) return false;
  const result = await ensureOpenCliExtensionRuntime({
    extensionDir: cfg.extensionDir, profileDir: cfg.profileDir, debugPort: cfg.debugPort, allowReload,
  });
  if (requireVerified && result.status !== "verified") throw new Error("Harbour browser: 扩展升级后的实际源码未通过核验，停止派发网页操作");
  if (result.status === "restart-required") return true;
  if (result.status !== "skipped") {
    if (verifiedExtensionRuntimes.size >= 32) verifiedExtensionRuntimes.clear();
    verifiedExtensionRuntimes.add(key);
    logger.info({ status: result.status, extensionId: result.extensionId, sha256: result.sha256 },
      "browser: 已核验运行中扩展脚本与磁盘一致");
  }
  return false;
}

/** Only for the fresh process still held behind the cold-start gate. Never a
 * reused browser or a running tool; no page-level commands or forced kill. */
async function closeFreshChromeForExtensionUpgrade(cfg: BrowserHarnessConfig, proc: ChildProcess): Promise<void> {
  const isFreshOwner = () => chromeProc === proc && proc.pid !== undefined &&
    proc.exitCode === null && proc.signalCode === null && readOwnership(cfg)?.pid === proc.pid;
  if (!isFreshOwner() || !isOwnedChrome(cfg)) throw new Error("Harbour browser: 扩展升级不能关闭非本次启动的浏览器");
  const response = await fetch(`http://127.0.0.1:${cfg.debugPort}/json/version`, { signal: AbortSignal.timeout(2_500), redirect: "error" });
  const metadata = await response.json() as { webSocketDebuggerUrl?: string };
  const url = new URL(metadata.webSocketDebuggerUrl ?? "");
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.port !== String(cfg.debugPort) || url.username || url.password || url.search || url.hash ||
      !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(url.pathname)) throw new Error("Harbour browser: 非法升级关闭目标");
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { handshakeTimeout: 2_500 });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Harbour browser: 升级关闭未确认")), 3_000);
    socket.once("open", () => {
      if (!isFreshOwner()) { finish(new Error("Harbour browser: 升级关闭前浏览器归属发生变化")); return; }
      socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    });
    socket.once("error", error => finish(error));
    socket.once("close", () => finish());
    socket.on("message", raw => {
      try {
        const message = JSON.parse(String(raw));
        if (message.id === 1) finish(message.error ? new Error("Harbour browser: 浏览器拒绝升级关闭") : undefined);
      } catch { finish(new Error("Harbour browser: 非法升级关闭回执")); }
    });
  });
  const deadline = Date.now() + 5_000;
  while ((proc.exitCode === null && proc.signalCode === null) || await portAlive(cfg.debugPort, 300)) {
    if (Date.now() >= deadline) throw new Error("Harbour browser: 升级关闭后进程或端口仍占用，停止再次启动");
    await sleep(100);
  }
  removeOwnership(cfg, proc.pid);
  if (chromeProc === proc) chromeProc = null;
  verifiedExtensionRuntimes.clear();
}

interface ChromeOwnership {
  pid: number;
  port: number;
  profileDir: string;
}

function ownershipFile(cfg: BrowserHarnessConfig): string {
  return path.join(cfg.profileDir, "HarbourCdpOwner.json");
}

function readOwnership(cfg: BrowserHarnessConfig): ChromeOwnership | null {
  try {
    const value = JSON.parse(readFileSync(ownershipFile(cfg), "utf8")) as Partial<ChromeOwnership>;
    if (!Number.isInteger(value.pid) || !Number.isInteger(value.port) || typeof value.profileDir !== "string") return null;
    return value as ChromeOwnership;
  } catch {
    return null;
  }
}

function processCommandLine(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    } catch {
      return "";
    }
  }
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 4_000 }
    );
    return result.status === 0 ? result.stdout.trim() : "";
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 4_000,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

export function isOwnedChrome(cfg: BrowserHarnessConfig): boolean {
  const owner = readOwnership(cfg);
  if (!owner || owner.port !== cfg.debugPort || path.resolve(owner.profileDir) !== path.resolve(cfg.profileDir)) return false;
  const command = processCommandLine(owner.pid);
  if (!command) return false;
  const normalizedCommand = command.replace(/\\/g, "/").toLowerCase();
  const normalizedProfile = path.resolve(cfg.profileDir).replace(/\\/g, "/").toLowerCase();
  return normalizedCommand.includes(`--remote-debugging-port=${cfg.debugPort}`) &&
    normalizedCommand.includes(`--user-data-dir=${normalizedProfile}`);
}

function removeOwnership(cfg: BrowserHarnessConfig, pid?: number): void {
  const owner = readOwnership(cfg);
  if (pid !== undefined && owner?.pid !== pid) return;
  try {
    rmSync(ownershipFile(cfg), { force: true });
  } catch {
    /* noop */
  }
}

/** 探 CDP 端点是否就绪（/json/version 能连上即为活）。 */
async function portAlive(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

/** 确保隔离 Chrome 就绪：已在跑就复用，否则用独立 profile+端口启动并等待就绪。 */
async function ensureManagedChromeOnce(cfg: BrowserHarnessConfig, logger: Logger, allowExtensionRestart = true): Promise<void> {
  if (cfg.debugPort === 9222) {
    throw new Error(
      "Harbour browser: 拒绝使用端口 9222（日常 Chrome 默认调试端口）。请把 HARBOUR_CHROME_DEBUG_PORT 设成别的（默认 9333），Harbour 只操作自己的隔离实例。"
    );
  }
  if (await portAlive(cfg.debugPort)) {
    // 显式 remote-debugging-port 的新版 Chrome 不一定生成 DevToolsActivePort，不能靠文件
    // 存不存在判断。Harbour 启动时写 owner(pid+port+profile)，复用时再核对该 PID 的真实
    // 命令行同时包含专用 profile 与端口；旧 marker、PID 复用或未知监听者都会 fail closed。
    if (!isOwnedChrome(cfg)) {
      throw new Error(
        `Harbour browser: 端口 ${cfg.debugPort} 上有 CDP 监听，但无法验证它同时使用 Harbour 隔离 profile` +
          `（${cfg.profileDir}）与 Harbour owner marker。` +
          `拒绝接管未知浏览器：请换 HARBOUR_CHROME_DEBUG_PORT，或关掉占用该端口的浏览器再试。`
      );
    }
    usedChrome = true;
    // A backend restart can reuse a browser with cached old extension code.
    // Inspect once, but never reload a reused browser that may hold a live lease.
    await verifyExtensionRuntime(cfg, logger, false, !allowExtensionRestart);
    logger.info({ port: cfg.debugPort }, "browser: 复用已在运行的 Harbour 隔离 Chrome");
    return;
  }
  const chrome = cfg.chromePath || detectChrome();
  if (!chrome || !existsSync(chrome)) {
    throw new Error(
      `Harbour browser: 找不到 Chrome 可执行文件（探测的常见路径均不存在）。请在 .env 设 HARBOUR_CHROME_PATH 指向 chrome 可执行文件。`
    );
  }
  mkdirSync(cfg.profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${cfg.debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${cfg.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  const extensionManifest = path.join(cfg.extensionDir, "manifest.json");
  if (existsSync(extensionManifest)) {
    // Only a cold start can load extension changes. Never restart a browser or
    // change a running task here; the helper only recognizes one audited build.
    try {
      if (ensureOpenCliUploadGesture(cfg.extensionDir)) {
        logger.info("browser: 已兼容 OpenCLI 1.0.23 原生文件选择器与目标核验（原文件已备份）");
      }
    } catch (error) {
      // A read-only/custom extension must not prevent ordinary browsing/login.
      logger.warn({ error: String(error) }, "browser: 文件上传兼容补丁未应用；上传可能需修复扩展，普通浏览继续");
    }
    args.push(`--disable-extensions-except=${cfg.extensionDir}`, `--load-extension=${cfg.extensionDir}`);
  } else {
    logger.warn(
      { extensionDir: cfg.extensionDir },
      "browser: OpenCLI 扩展目录不存在；Chrome 会启动，但 Browser Bridge 检查将明确失败"
    );
  }
  // 后台自动化不应抢主人当前窗口焦点；需要手动登录时仍可从任务栏恢复该专属窗口。
  if (!cfg.headless) args.push("--start-minimized");
  if (cfg.headless) args.push("--headless=new");
  args.push("about:blank");
  logger.info(
    {
      chrome,
      port: cfg.debugPort,
      profileDir: cfg.profileDir,
      extensionDir: existsSync(extensionManifest) ? cfg.extensionDir : undefined,
      headless: cfg.headless,
    },
    "browser: 启动 Harbour 隔离 Chrome"
  );
  const proc = spawn(chrome, args, { detached: false, stdio: "ignore" });
  chromeProc = proc;
  if (!proc.pid) throw new Error("Harbour browser: Chrome 已启动但没有返回 PID");
  writeFileSync(
    ownershipFile(cfg),
    JSON.stringify({ pid: proc.pid, port: cfg.debugPort, profileDir: path.resolve(cfg.profileDir) }),
    "utf8"
  );
  proc.on("exit", (code) => {
    logger.info({ code }, "browser: Harbour 隔离 Chrome 退出");
    removeOwnership(cfg, proc.pid);
    if (chromeProc === proc) chromeProc = null;
  });
  const deadline = Date.now() + cfg.startTimeoutMs;
  while (Date.now() < deadline) {
    if (await portAlive(cfg.debugPort)) {
      usedChrome = true;
      // Only this fresh-start critical section may refresh a stale extension.
      // A file patch + process restart alone does not invalidate worker caches.
      if (await verifyExtensionRuntime(cfg, logger, allowExtensionRestart, !allowExtensionRestart)) {
        if (!allowExtensionRestart) throw new Error("Harbour browser: 扩展升级后仍需重启，拒绝循环启动");
        await closeFreshChromeForExtensionUpgrade(cfg, proc);
        logger.info("browser: 扩展更新需要一次专属浏览器冷启动；尚未派发网页操作");
        return ensureManagedChromeOnce(cfg, logger, false);
      }
      logger.info({ port: cfg.debugPort }, "browser: 隔离 Chrome CDP 就绪");
      return;
    }
    await sleep(300);
  }
  throw new Error(
    `Harbour browser: 隔离 Chrome 在 ${cfg.startTimeoutMs}ms 内未就绪（端口 ${cfg.debugPort}）。可调大 HARBOUR_CHROME_START_TIMEOUT_MS，或检查 Chrome 是否被安全软件拦截。`
  );
}

async function pageTargetExists(port: number, targetId: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1_500);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ctrl.signal });
    if (!response.ok) throw new Error(`CDP /json/list 返回 HTTP ${response.status}`);
    const targets = await response.json() as Array<{ id?: unknown; type?: unknown }>;
    return targets.some((target) => target.type === "page" && target.id === targetId);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 通过 Chrome 自己的 CDP HTTP 端点关闭一个精确 page target。
 *
 * OpenCLI 的 session close 只释放 lease；Bridge session 已经先行释放时，`tab close`
 * 也可能报「not part of current session」并留下真实页面。调用方必须只传本轮 `open`
 * 返回并记录的 target id；这里再验证端口确属 Harbour 隔离 Chrome，绝不碰日常浏览器。
 */
export async function closeManagedPageTarget(
  cfg: BrowserHarnessConfig,
  targetId: string,
  logger?: Logger
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(targetId)) {
    throw new Error("Harbour browser: page target id 无效");
  }
  if (!await portAlive(cfg.debugPort, 500)) return;
  if (!isOwnedChrome(cfg)) {
    throw new Error(`Harbour browser: 拒绝关闭未验证归属的 CDP target（端口 ${cfg.debugPort}）`);
  }
  if (!await pageTargetExists(cfg.debugPort, targetId)) return;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1_500);
  try {
    const response = await fetch(
      `http://127.0.0.1:${cfg.debugPort}/json/close/${encodeURIComponent(targetId)}`,
      { signal: ctrl.signal }
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`CDP /json/close 返回 HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!await pageTargetExists(cfg.debugPort, targetId)) {
      logger?.debug({ targetId }, "browser: 已回收本轮临时 page");
      return;
    }
    await sleep(50);
  }
  throw new Error(`Harbour browser: CDP target ${targetId} 在关闭后仍然存在`);
}

export async function ensureManagedChrome(cfg: BrowserHarnessConfig, logger: Logger): Promise<void> {
  if (ensureChromeInFlight) return ensureChromeInFlight;
  const attempt = ensureManagedChromeOnce(cfg, logger);
  ensureChromeInFlight = attempt;
  try {
    await attempt;
  } finally {
    if (ensureChromeInFlight === attempt) ensureChromeInFlight = null;
  }
}

function harnessMissingMsg(cfg: BrowserHarnessConfig, e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  const why = err?.code === "ENOENT" ? `找不到 '${cfg.harnessBin}' 命令` : String(err?.message || e);
  return (
    `Harbour browser: 无法运行 browser-harness（${why}）。` +
    `请先安装：装 uv → 'uv tool install --python 3.12 --upgrade --force browser-harness'，` +
    `确保其 bin 在 PATH（或用 BROWSER_HARNESS_BIN 指定全路径）。**不会**自动降级去控制桌面鼠标。`
  );
}

/** spawn browser-harness，注入 BU_CDP_URL/BH_HOME，把 Python 片段喂给 stdin，取 stdout。 */
function runHarness(cfg: BrowserHarnessConfig, snippet: string, logger: Logger): Promise<string> {
  return new Promise((resolve, reject) => {
    mkdirSync(cfg.harnessHome, { recursive: true });
    const env = {
      ...process.env,
      BU_CDP_URL: `http://127.0.0.1:${cfg.debugPort}`,
      BH_HOME: cfg.harnessHome,
      BROWSER_HARNESS_HOME: cfg.harnessHome,
      BH_DOMAIN_SKILLS: "0",
    };
    let child: ChildProcess;
    try {
      child = spawn(cfg.harnessBin, [], { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      reject(new Error(harnessMissingMsg(cfg, e)));
      return;
    }
    let out = "";
    let err = "";
    child.on("error", (e) => reject(new Error(harnessMissingMsg(cfg, e))));
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`browser-harness 执行失败（exit ${code}）：${(err.trim() || out.trim()).slice(0, 2000)}`));
    });
    child.stdin?.write(snippet);
    child.stdin?.end();
  });
}

/** JSON 字符串字面量 ≈ Python 合法字符串字面量（转义兼容），用于把参数安全注入 Python 片段。 */
const pyStr = (s: unknown) => JSON.stringify(String(s ?? ""));

/**
 * 主动关闭我们托管的隔离 Chrome（供优雅退出复用；与 browser_close 工具同源）。
 */
export async function closeManagedChrome(cfg: BrowserHarnessConfig, logger?: Logger): Promise<void> {
  if (ensureChromeInFlight) await ensureChromeInFlight.catch(() => undefined);
  if (!usedChrome) return; // 本次没用过浏览器：无需 spawn harness 收尾
  try {
    await runHarness(cfg, `cdp("Browser.close")`, logger ?? (console as unknown as Logger));
  } catch {
    // 忽略：可能本来就没连上
  }
  if (chromeProc && !chromeProc.killed) {
    try {
      chromeProc.kill();
    } catch {
      /* noop */
    }
  }
  chromeProc = null;
  usedChrome = false;
  verifiedExtensionRuntimes.clear();
  removeOwnership(cfg);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && await portAlive(cfg.debugPort, 300)) await sleep(100);
}

export function createBrowserHarnessTools(cfg: BrowserHarnessConfig): ToolDef[] {
  const run = async (snippet: string, ctx: ToolContext): Promise<string> => {
    await ensureManagedChrome(cfg, ctx.logger);
    return runHarness(cfg, snippet, ctx.logger);
  };

  const browserOpen: ToolDef = {
    name: "browser_open",
    description: "在 Harbour 隔离 Chrome 打开/跳转到一个 URL（首次建标签页，之后同标签页导航）。返回页面信息。",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "要访问的 URL" } },
      required: ["url"],
    },
    async execute(args, ctx) {
      const snippet = [
        `u = ${pyStr(args.url)}`,
        `try:`,
        `    new_tab(u)`,
        `except Exception:`,
        `    goto_url(u)`,
        `try:`,
        `    wait_for_load()`,
        `except Exception:`,
        `    pass`,
        `print(page_info())`,
      ].join("\n");
      const info = await run(snippet, ctx);
      ctx.logger.info({ url: args.url }, "browser_open");
      return { ok: true, info };
    },
  };

  const browserPageInfo: ToolDef = {
    name: "browser_page_info",
    description: "取隔离 Chrome 当前页面信息（URL、标题、DOM/可访问性概要）。observe 主力。无参数。",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      const info = await run(`print(page_info())`, ctx);
      return { ok: true, info };
    },
  };

  const browserScreenshot: ToolDef = {
    name: "browser_screenshot",
    description: "截当前页面图（存 Harbour 本地状态目录），返回保存路径。无参数。",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      const outp = await run(`p = capture_screenshot()\nprint(p)`, ctx);
      ctx.logger.info({ path: outp }, "browser_screenshot");
      return { ok: true, path: outp };
    },
  };

  const browserClick: ToolDef = {
    name: "browser_click",
    description: "按坐标点击 (x, y)（CDP，能穿透 iframe/shadow）。返回点击后的页面信息。",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number", description: "横坐标（像素）" },
        y: { type: "number", description: "纵坐标（像素）" },
      },
      required: ["x", "y"],
    },
    async execute(args, ctx) {
      const x = Number(args.x);
      const y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("browser_click: x/y 非法");
      const snippet = [
        `click_at_xy(${x}, ${y})`,
        `try:`,
        `    wait_for_load()`,
        `except Exception:`,
        `    pass`,
        `print(page_info())`,
      ].join("\n");
      const info = await run(snippet, ctx);
      ctx.logger.info({ x, y }, "browser_click");
      return { ok: true, info };
    },
  };

  const browserType: ToolDef = {
    name: "browser_type",
    description: "向当前聚焦的输入框输入文本（先用 browser_click 点中输入框再输）。返回页面信息。",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "要输入的文本" } },
      required: ["text"],
    },
    async execute(args, ctx) {
      const snippet = [`cdp("Input.insertText", {"text": ${pyStr(args.text)}})`, `print(page_info())`].join("\n");
      const info = await run(snippet, ctx);
      ctx.logger.info({ len: String(args.text ?? "").length }, "browser_type");
      return { ok: true, info };
    },
  };

  const browserJs: ToolDef = {
    name: "browser_js",
    description: "在页面里执行 JS（DOM 检查/提取/滚动等），返回执行结果。",
    parameters: {
      type: "object",
      properties: { code: { type: "string", description: "要在页面上下文执行的 JS 代码" } },
      required: ["code"],
    },
    async execute(args, ctx) {
      const result = await run(`print(js(${pyStr(args.code)}))`, ctx);
      ctx.logger.info({ codeLen: String(args.code ?? "").length }, "browser_js");
      return { ok: true, result };
    },
  };

  const browserClose: ToolDef = {
    name: "browser_close",
    description: "关闭 Harbour 隔离浏览器会话（退出隔离 Chrome）。无参数。",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      await closeManagedChrome(cfg, ctx.logger);
      ctx.logger.info({}, "browser_close");
      return { ok: true, closed: true };
    },
  };

  return [browserOpen, browserPageInfo, browserScreenshot, browserClick, browserType, browserJs, browserClose];
}
