import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import type { CodexHarnessProbe } from "./backends/codexAppServer";

export type CodexLaunch = { command: string; args: string[] };
export interface CodexRuntimeUpdate {
  status: "unchecked" | "current" | "updated" | "skipped" | "failed";
  version: string;
  latestVersion?: string;
  previousVersion?: string;
  checkedAt?: string;
  message?: string;
}

type Release = { version: string; launch: CodexLaunch };
interface RuntimeOptions {
  directory?: string;
  autoUpdate?: boolean;
  customBin?: string;
  verify(launch: CodexLaunch): Promise<CodexHarnessProbe>;
  // Deterministic test seams; production registry/package/paths are not user input.
  bundled?: Release;
  latest?: () => Promise<string>;
  install?: (directory: string, version: string) => Promise<void>;
}

const REGISTRY = "https://registry.npmjs.org";
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_DIR = /^\d+\.\d+\.\d+-[a-f0-9-]{36}$/;
const packagePath = (directory: string) => path.join(directory, "node_modules", "@openai", "codex");

export function newerCodexVersion(a: string, b: string): boolean {
  if (!STABLE.test(a) || !STABLE.test(b)) return false;
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! > right[i]!;
  return false;
}

export function bundledCodex(): Release {
  const entry = require.resolve("@openai/codex/bin/codex.js");
  const pkg = JSON.parse(readFileSync(path.resolve(entry, "../../package.json"), "utf8"));
  return { version: String(pkg.version), launch: { command: process.execPath, args: [entry, "app-server"] } };
}

async function latestStable(): Promise<string> {
  const response = await fetch(`${REGISTRY}/@openai%2Fcodex/latest`, {
    signal: AbortSignal.timeout(15_000), redirect: "error", headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("registry unavailable");
  const body = await response.text();
  if (body.length > 128_000) throw new Error("registry response too large");
  const pkg = JSON.parse(body);
  if (pkg.name !== "@openai/codex" || !STABLE.test(pkg.version)) throw new Error("invalid stable release");
  return pkg.version;
}

/** No provider keys, npm tokens, lifecycle hooks or arbitrary NODE_OPTIONS. */
export function codexInstallerEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE)$/i;
  return { ...Object.fromEntries(Object.entries(source).filter(([key]) => allowed.test(key))),
    ELECTRON_RUN_AS_NODE: "1", NO_COLOR: "1" };
}

async function npmCli(): Promise<string> {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")];
  for (const directory of (process.env.PATH || process.env.Path || "").split(path.delimiter)) {
    candidates.push(path.join(directory, "node_modules/npm/bin/npm-cli.js"), path.resolve(directory, "../lib/node_modules/npm/bin/npm-cli.js"));
  }
  for (const candidate of candidates) {
    if (!candidate || path.basename(candidate) !== "npm-cli.js") continue;
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch { /* next known layout */ }
  }
  throw new Error("npm CLI unavailable");
}

async function installRelease(directory: string, version: string): Promise<void> {
  const cli = await npmCli();
  const userConfig = path.join(directory, "user.npmrc"), globalConfig = path.join(directory, "global.npmrc");
  await fs.writeFile(userConfig, "", { flag: "wx" });
  await fs.writeFile(globalConfig, "", { flag: "wx" });
  await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ private: true }), { flag: "wx" });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "install", `@openai/codex@${version}`,
      "--prefix", directory, "--registry", REGISTRY, "--userconfig", userConfig, "--globalconfig", globalConfig,
      "--cache", path.join(directory, ".npm-cache"), "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact",
      "--include=optional", "--fetch-retries=0", "--fetch-timeout=60000"], {
      cwd: directory, windowsHide: true, shell: false, stdio: "ignore", env: codexInstallerEnv(process.env),
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error("install timed out")); }, 180_000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("npm launch failed")); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("npm install failed")); });
  });
}

/** Side-by-side, last-known-good runtime. Never overwrite a running executable,
 * mutate the repository lockfile from Cron, or stop an existing App Server. */
export class CodexRuntimeManager {
  private readonly directory: string;
  private readonly bundled: Release;
  private active: Release;
  private pending?: Promise<CodexRuntimeUpdate>;
  private initialized?: Promise<void>;
  state: CodexRuntimeUpdate;

  constructor(private readonly options: RuntimeOptions) {
    this.directory = path.resolve(options.directory ?? "data/codexRuntime");
    this.bundled = options.bundled ?? bundledCodex();
    this.active = options.customBin
      ? { version: "custom", launch: { command: options.customBin, args: ["app-server"] } } : this.bundled;
    this.state = { status: "unchecked", version: this.active.version };
  }

  launch = (): CodexLaunch => ({ ...this.active.launch, args: [...this.active.launch.args] });

  initialize(): Promise<void> {
    return this.initialized ??= this.loadActive();
  }

  private async release(directory: string, version: string): Promise<Release> {
    const root = await fs.realpath(this.directory), real = await fs.realpath(directory);
    const relative = path.relative(root, real);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("invalid runtime path");
    const pkg = path.join(packagePath(real), "package.json"), entry = path.join(packagePath(real), "bin/codex.js");
    for (const file of [pkg, entry]) {
      const resolved = await fs.realpath(file), rel = path.relative(real, resolved);
      if (rel.startsWith("..") || path.isAbsolute(rel) || !(await fs.stat(file)).isFile()) throw new Error("invalid runtime file");
    }
    const metadata = JSON.parse(await fs.readFile(pkg, "utf8"));
    if (metadata.name !== "@openai/codex" || metadata.version !== version) throw new Error("runtime version mismatch");
    return { version, launch: { command: process.execPath, args: [entry, "app-server"] } };
  }

  private async loadActive(): Promise<void> {
    if (this.options.customBin) return;
    let hasPointer = false;
    try {
      const content = await fs.readFile(path.join(this.directory, "active.json"), "utf8");
      hasPointer = true;
      const saved = JSON.parse(content);
      if (!STABLE.test(saved.version) || !RELEASE_DIR.test(saved.directory)) throw new Error("invalid runtime pointer");
      if (newerCodexVersion(saved.version, this.active.version)) {
        this.active = await this.release(path.join(this.directory, saved.directory), saved.version);
        this.state = { status: "unchecked", version: this.active.version };
      }
    } catch (error) {
      if (hasPointer || (error as NodeJS.ErrnoException).code !== "ENOENT") this.state = {
        status: "failed", version: this.active.version, message: "本机 Codex 更新记录无效，已使用项目自带版本；请重新更新。",
      };
    }
  }

  ensureLatest(): Promise<CodexRuntimeUpdate> {
    return this.pending ??= this.update().finally(() => { this.pending = undefined; });
  }

  private async update(): Promise<CodexRuntimeUpdate> {
    await this.initialize();
    const checkedAt = new Date().toISOString(), previousVersion = this.active.version;
    if (this.options.customBin || this.options.autoUpdate === false) return this.state = {
      status: "skipped", version: previousVersion, checkedAt,
      message: this.options.customBin ? "使用自定义 Codex 路径，请自行升级该组件；仅刷新模型目录。" : "Codex 自动升级已关闭；仅刷新模型目录。",
    };
    let latestVersion: string | undefined, lock = false;
    let failure = "无法查询 Codex 最新稳定版，继续使用原组件；本次未确认最新版本。";
    try {
      latestVersion = await (this.options.latest ?? latestStable)();
      if (!STABLE.test(latestVersion)) throw new Error("not stable");
      if (!newerCodexVersion(latestVersion, previousVersion)) return this.state = {
        status: "current", version: previousVersion, latestVersion, checkedAt,
      };
      failure = "Codex 更新锁不可用，可能另有更新正在运行；继续使用原组件。";
      await fs.mkdir(this.directory, { recursive: true });
      await fs.mkdir(path.join(this.directory, "update.lock")); lock = true;
      // Another process may have completed a newer update after our lookup.
      await this.loadActive();
      if (!newerCodexVersion(latestVersion, this.active.version)) return this.state = {
        status: "current", version: this.active.version, latestVersion, checkedAt,
      };
      const name = `${latestVersion}-${randomUUID()}`, staging = path.join(this.directory, name);
      await fs.mkdir(staging);
      failure = "Codex 新版下载或安装失败，继续使用原组件；未切换到最新版本。";
      await (this.options.install ?? installRelease)(staging, latestVersion);
      const candidate = await this.release(staging, latestVersion);
      failure = "Codex 新版未通过受限 App Server/OAuth/模型目录检查，继续使用原组件。";
      const verified = await this.options.verify(candidate.launch);
      if (!verified.ready || !verified.models.some(row => row.model && !row.hidden)) throw new Error("candidate probe failed");
      failure = "Codex 新版激活记录保存失败，继续使用原组件。";
      const temp = path.join(this.directory, `active-${randomUUID()}.tmp`);
      await fs.writeFile(temp, JSON.stringify({ version: latestVersion, directory: name, activatedAt: checkedAt }), { flag: "wx" });
      await fs.rename(temp, path.join(this.directory, "active.json"));
      this.active = candidate;
      return this.state = { status: "updated", version: latestVersion, latestVersion, previousVersion, checkedAt };
    } catch {
      return this.state = { status: "failed", version: this.active.version, latestVersion, checkedAt, message: failure };
    } finally {
      // Only our empty lock directory. Installed versions are retained, including
      // those still serving a turn; no recursive deletion or executable swapping.
      if (lock) await fs.rmdir(path.join(this.directory, "update.lock")).catch(() => {});
    }
  }
}
