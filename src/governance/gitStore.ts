import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * gitStore —— assets/Memory 的 git 版本治理。
 * 每次 governance 提案 apply（memory 目标）落盘后提交一版；历史/回滚走 git，无冗余快照文件。
 * Memory 现在是主仓的普通 tracked 路径（assets/Memory/**），版本治理直接走主仓 git，
 * 不再在 assets/Memory 里建嵌套独立仓。
 */

const execFile = promisify(execFileCb);
const REPO_ROOT = process.cwd();
const MEMORY_ROOT = path.resolve(REPO_ROOT, "assets", "Memory");

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd: REPO_ROOT,
    maxBuffer: 1024 * 1024 * 32,
  });
  return stdout;
}

/** 主仓是否存在 .git（给「只读查看历史」用）。 */
export async function hasMemoryRepo(): Promise<boolean> {
  try {
    await fs.access(path.join(REPO_ROOT, ".git"));
    return true;
  } catch {
    return false;
  }
}

let ensured = false;
/** 确保 assets/Memory 目录存在（幂等）；不再 init 嵌套仓。 */
export async function ensureMemoryRepo(): Promise<void> {
  if (ensured) return;
  await fs.mkdir(MEMORY_ROOT, { recursive: true });
  ensured = true;
}

/** 在主仓提交 assets/Memory 下当前改动；无改动返回 null，否则返回短 sha。 */
export async function commitMemory(message: string): Promise<string | null> {
  await ensureMemoryRepo();
  try {
    await git(["add", "assets/Memory"]);
    await git(["commit", "-m", message, "--", "assets/Memory"]);
  } catch {
    return null; // nothing to commit or git unavailable
  }
  return (await git(["rev-parse", "--short", "HEAD"])).trim();
}

/**
 * 为【单个受治理文件】提交一版。只 add/commit 这个路径本身——
 * 不用 `git add <整个根>`，那会把别人未提交的半成品与未跟踪文件一起裹进来。
 * 无改动返回 null（幂等：重复 apply 同样内容不会产生空提交）。
 */
export async function commitGovernedFile(rel: string, message: string): Promise<string | null> {
  const scoped = relWithin(rel);
  try {
    await git(["add", "--", scoped]);
    await git(["commit", "-m", message, "--", scoped]);
  } catch {
    return null; // 没东西可提交 / git 不可用
  }
  return (await git(["rev-parse", "--short", "HEAD"])).trim();
}

export interface MemoryCommit {
  hash: string;
  date: string;
  message: string;
  /** 该版本是否是【当前生效的内容】（恢复到旧版后，就是那个旧版本被标 current）。 */
  current?: boolean;
}

const SEP = "\t";

/** 某文件（或整库）的提交历史。rel 相对仓库根，如 "assets/Memory/x.md" 或 "x.md"。 */
export async function memoryLog(rel?: string, limit = 30): Promise<MemoryCommit[]> {
  await ensureMemoryRepo();
  // %x09 = tab 分隔；message 可能含 tab，故 slice(2).join。
  const args = ["log", `-n${limit}`, "--format=%h%x09%ad%x09%s", "--date=iso"];
  if (rel) args.push("--", relWithin(rel));
  let stdout = "";
  try {
    stdout = await git(args);
  } catch {
    return [];
  }
  const raw = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(SEP);
      return { hash: parts[0] ?? "", date: parts[1] ?? "", message: parts.slice(2).join(SEP) };
    });
  return collapseRollbacks(raw);
}

/**
 * 折叠「恢复」产生的记录：只留【真实的内容版本】。
 *
 * 为什么要折叠：git 只增不改，恢复到旧版会追加一条内容等于旧版的新提交。用来做代码历史没问题，
 * 但这里是【文件版本切换】——用户在 v1 和 v2 之间来回切，期望看到的永远只有 v1、v2 两条；
 * 每切一次就多一条 rollback 记录，切几次列表就废了（用户 2026-07-25 明确指出）。
 *
 * 做法：rollback 提交（message 形如 `rollback <path> -> <src>`）不单独成条，
 * 而是把它指向的源版本标成 current —— 于是「当前在哪一版」清清楚楚，列表长度恒等于真实版本数。
 * 注意 rollback 提交【内容与源版本逐字节相同】（已验证），所以折叠不丢任何信息。
 */
function collapseRollbacks(commits: MemoryCommit[]): MemoryCommit[] {
  if (commits.length === 0) return commits;
  // 最新一条决定「当前内容」是哪一版：是 rollback 就顺着它指向的源版本走（可能连着套娃）。
  let currentHash = commits[0]!.hash;
  const srcOf = (m: string): string | null => (/^rollback\s/.test(m) ? (m.match(/->\s*(\S+)/)?.[1] ?? null) : null);
  const byPrefix = (h: string) => commits.find((c) => c.hash.startsWith(h) || h.startsWith(c.hash));
  for (let i = 0; i < commits.length; i++) {
    const cur = byPrefix(currentHash);
    const src = cur && srcOf(cur.message);
    if (!src) break;                 // 不是 rollback → 就是它了
    const next = byPrefix(src);
    if (!next) break;                // 源版本已不在窗口内 → 停在这
    currentHash = next.hash;
  }
  return commits
    .filter((c) => !/^rollback\s/.test(c.message))         // 丢掉所有 rollback 噪音条目
    .map((c) => ({ ...c, current: c.hash === currentHash })); // 标出当前生效的那一版
}

/** 取某个历史版本的文件内容（用于 diff/回滚预览）。 */
export async function memoryFileAt(rel: string, commit: string): Promise<string> {
  await ensureMemoryRepo();
  // 校验【必须在 try 之外】：放里面的话，非法 commit / 越界路径抛出的错会被下面的
  // catch 吞成 ""，于是「输入非法」和「该版本没这个文件」返回完全一样——
  // 调用方分不清，攻击尝试也长得像正常响应（对抗审查明确点了这一条）。
  const at = assertCommitish(commit);
  const scoped = relWithin(rel);
  try {
    return await git(["show", `${at}:${scoped}`]);
  } catch {
    return "";   // 到这里只剩「该 commit 下确实没这个文件」这一种情况
  }
}

/** 把某个受治理文件回滚到指定 commit。只提交【该文件本身】，不裹挟别处改动。 */
export async function rollbackGovernedFile(rel: string, commit: string): Promise<string | null> {
  const scoped = relWithin(rel);
  const at = assertCommitish(commit);
  await git(["checkout", at, "--", scoped]);
  try {
    // 【只提交这个文件】。以前是 add/commit 整个根（agents 或 assets/Memory）——
    // 那会把【别人未提交的半成品】和未跟踪文件（如 agents/<name>/inbox/ 里的运行时
    // 消息、.governance 存档）一起打上 "rollback" 的 message 提交进去，
    // 日后按那条 commit 回滚就会回到一个从没人想保存的版本。用文件路径本身即可。
    await git(["add", "--", scoped]);
    await git(["commit", "-m", `rollback ${scoped} -> ${at}`, "--", scoped]);
  } catch {
    return null; // 没东西可提交 / git 不可用
  }
  return (await git(["rev-parse", "--short", "HEAD"])).trim();
}

/**
 * 受版本治理的根目录。版本管理直接用【项目自己的 git 仓库】，不另起嵌套仓——
 * 所以「历史 / 看旧版 / 回滚」本质就是 git log / git show / git checkout。
 */
export const GOVERNED_ROOTS = ["assets/Memory", "agents", "skills", "workflows", "mcp"] as const;

/**
 * 归一化成【仓库相对路径】并校验落在受治理的根内。
 * 裸路径（如 "concepts/index.md"）按历史行为归到 assets/Memory，保持旧调用点不变。
 * 显式挡 `..` / `.`：下面这些路径会直接拼进 git 命令，越界就等于能读写整个仓库。
 */
function relWithin(rel: string): string {
  const normalized = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  // 大小写【不】做宽松匹配：git pathspec 是大小写敏感的，若这里用 toLowerCase 放行
  // `AGENTS/x`，后面 git 拿原样字符串去查会静默返回 0 条（假装「没有历史」）而不是报错，
  // 且与 proposalStore.resolveGovernedPath 的判定不一致。宁可归到 Memory 分支或直接查不到。
  const scoped = GOVERNED_ROOTS.some((r) => normalized === r || normalized.startsWith(r + "/"))
    ? normalized
    : `assets/Memory/${normalized}`;
  if (scoped.split("/").some((seg) => seg === "." || seg === "..")) {
    throw new Error(`governance/git: 非法路径（含 . 或 ..）：${rel}`);
  }
  return scoped;
}

/**
 * 校验 commit-ish。**这一条是安全边界，不是格式洁癖。**
 *
 * 事故形状（2026-07-21 对抗审查实证）：`commit` 未校验就拼进 `git show \`${commit}:${path}\``，
 * git 会把任何 `-` 开头的参数当【选项】解析——`--output=/任意/路径` 直接写文件。
 * 于是一个注释写着「只读」的工具，变成了服务进程权限内的任意文件创建原语，
 * 且经由 GET /api/governance/diff 可被浏览器端触发。
 * 用 execFile 传数组只挡住了 shell 注入，挡不住 git 自己的选项解析。
 */
function assertCommitish(commit: string): string {
  const c = String(commit ?? "").trim();
  if (!c) throw new Error("governance/git: 缺少 commit");
  // 只允许 hash / 分支 / tag / HEAD~2 / rev^{commit} 这类字符，且【绝不能以 - 开头】。
  if (c.startsWith("-") || !/^[A-Za-z0-9._\/^~@{}-]+$/.test(c)) {
    throw new Error(`governance/git: 非法 commit：${commit}`);
  }
  return c;
}
