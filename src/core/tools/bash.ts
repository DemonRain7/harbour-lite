import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import type { ToolContext, ToolDef } from "../../types";
import { ASK_TIMEOUT, ASK_MAX_WAIT_MS } from "../askUser";
import { currentCommandShell } from "../commandShell";
import { terminateProcessTree, type ProcessTreeCleanup } from "../processTree";

/**
 * bash —— 让 agent 直接跑 shell 命令。
 *
 * 【范围】不做目录沙箱（用户 明确选择「全盘可用」，2026-07-20）。她能碰的东西 = 跑
 * Harbour 这个进程的用户能碰的东西。这是有意的：要当通用助手就得能装依赖、
 * 跑别的项目、改系统文件。
 *
 * 【发放】按 agent 白名单发，只在 main-elaina / main-aemeath 的 tools/index.md 里。
 * 千万别与 ai_news / stock_news 或浏览器工具一起授予临时 worker——网页里藏一段冲着
 * agent 写的指令就可能变成本机命令执行。「吃外网的」和「有 bash 的」
 * 必须是不同的 agent，这是本工具唯一的硬性部署约束。
 *
 * 【密钥】子进程环境里剔掉所有常见 KEY/TOKEN/SECRET：不是防她（她 cat .env 一样看得到），
 * 是防「随手一句 env 就把 token 印进 assets/sessions 的 trace 文件里」——那玩意会落盘。
 *
 * 【确认通道的诚实边界】(2026-07-21 对抗复查 H1/H2)
 * ask 档命令要经人点头才执行，确认走 web 面板弹窗 / Discord 按钮。已做的加固：
 *   · /api/asks* 脱离 CORS、只收同源请求 —— 堵死「你浏览器里随便一个网页替你点同意」。
 *   · Discord 按钮只认【用户 ID】白名单（频道 ID 不算）且校验点击者 == 发起人。
 *   · 子进程 env 剔掉 WEB_AUTH_TOKEN / DISCORD_* / WEB_PORT。
 * 【但要说清楚】bash 是全盘可读的，只要凭据落在 .env 里，被注入的 agent 就能
 * `cat .env` 拿到再自己批准自己 —— 这道门就形同虚设。要真正关死这个洞，
 * WEB_AUTH_TOKEN 必须【只存在于启动环境变量里、不写进 .env】：那样它既不在磁盘上，
 * 又被上面这段代码从子进程环境里剔掉，agent 无从获取。在那之前，
 * 「人工确认」挡的是照抄 payload 的注入，不是一个已经拿到 bash 的定向攻击者。
 *
 * 【两道防线：对付 prompt injection】
 * 威胁：她能派 browser 抓网页，网页里可能藏「写给 AI 的指令」，抓回的摘要
 * 进她 context，而她有 bash + dontAsk（不弹确认）。于是一句注入 = 本机命令执行。
 *   ① 来源闸（airtight）：bash 只在入口已验证 actor.role=owner 的 web/discord/qq 运行执行。
 *      non-owner / heartbeat / cron / 子 agent / 无来源一律拒绝。
 *   ② 危险命令筛（减速带 + 审计，非安全边界）：拦住注入最爱用的高爆炸半径 payload。
 *      对抗审查（2026-07-21）证明正则拦不住有意的注入；它只挡照抄的 payload + 留痕。
 *      真正兜住 live 场景注入的是「人工确认」，尚未接线（见文末 TODO）。
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** 输出上限：超了截断。命令吐几 MB 日志时，全塞进 context 既烧钱又挤掉真正有用的东西。 */
const MAX_OUTPUT_CHARS = 30_000;

/** 只有入口已验证的主人交互运行才允许 bash；“来自某聊天渠道”本身不再等于 用户。 */
function isInteractiveOwner(ctx: ToolContext): boolean {
  const ch = ctx.source?.channel ?? "";
  if (ctx.taskType === "heartbeat") return false;   // 探活自动触发
  if (ch === "cron") return false;                  // 定时作业
  return ctx.source?.actor?.role === "owner" && (ch === "web" || ch === "qq" || ch.startsWith("discord"));
}

/**
 * 危险命令模式 —— 【减速带 + 审计信号，不是安全边界】。命中即拒 + warn 落日志。
 * 收紧到刚好覆盖常见 payload、不追求穷尽（追不到，还徒增误伤）。已按对抗审查修过误伤 +
 * 补过高价值缺口，但不声称完备。
 *
 * ⚠️ 历史教训（2026-07-21，血的）：这里任何一条 rm 相关正则若写挂了（漏拦），配合
 * 「拿真实路径当测试输入 + 直接 execute」就会真的删盘。本文件的测试【只准】用
 * `正则.test(字符串)` 纯匹配验证，绝不 execute 危险命令、绝不拿真路径当 payload。
 */
export const DANGER_PATTERNS: Array<{ re: RegExp; why: string; action: "ask" | "block" }> = [
  // ① 联网抓取 → 直接喂进解释器执行（含绝对路径 / 中间夹 busybox·sudo 等一两个词）
  {
    re: /\b(curl|wget|fetch|iwr|invoke-webrequest)\b[^\n]*\|\s*(\S+\s+){0,2}(\S*\/)?(sh|bash|zsh|dash|python3?|node|perl|ruby|php|pwsh|powershell)\b/i,
    why: "把联网下载的内容管道进解释器执行（下载即运行）", action: "block",
  },
  {
    // 进程替换 bash <(curl…) / source . <(curl…) / 命令替换 sh -c "$(curl…)"
    re: /(^|[\s;&|])(sh|bash|zsh|dash|source|eval|\.)\s+(-c\s+)?["']?[<$]\(?\s*(curl|wget|fetch)\b/i,
    why: "用进程替换/命令替换把联网内容当脚本执行", action: "block",
  },
  // ② 反弹 shell（不拦裸 `bash -i` 免误伤；补 mkfifo / pty.spawn；nc 补长选项 --exec）
  {
    re: /\/dev\/tcp\/|\bn(?:et)?c(?:at)?\b[^\n]*\s(-e\b|--exec\b)|\bsocat\b[^\n]*\bexec|\bmkfifo\b[^\n]*\bn(?:et)?c(?:at)?\b|pty\.spawn/i,
    why: "反弹 shell / 把 shell 暴露到网络", action: "block",
  },
  // ③ 抹盘 / 毁灭性删除。lookahead 认递归标志（短旗标 -rf / 长选项 --recursive），
  //    再要求目标是根级/家目录/系统目录。注意：flag 前【不能】加 \b——空格与 `-` 之间
  //    没有词边界，加了会让 `-rf` 整个漏掉（这正是 2026-07-21 删盘事故的直接原因）。
  //    目标前允许一个可选引号 `["']?`；~ 覆盖 ~/、~/*、~/x（对抗复查发现 rm -rf ~/ 曾漏）；
  //    $HOME 覆盖 ${HOME}；各目标尾部允许接引号，堵 rm -rf "/Users/x" 这类加引号绕过。
  {
    re: /\brm\b(?=[^\n]*\s(-{1,2}[a-z]*r[a-z]*|--recursive)\b)[^\n]*\s["']?(\/(\s|\*|$|["'])|~(\/|\s|$|["'])|\$\{?HOME\}?|\/(Users|System|etc|var|usr|opt|Library|Applications|private|bin|sbin)(\/|\s|$|["']))/i,
    why: "对根级/家目录/系统目录做递归删除", action: "ask",
  },
  // ③b 递归删除【裸目标】：rm -rf * / . / .. / ?* / .[a-z]* / $(echo ~)。
  //     这些没写死绝对路径，杀伤力却完全取决于当时的工作目录——而 cwd 是工具参数，
  //     注入内容可以随手指到家目录。上一版只看绝对路径，这类整个漏过（对抗复查 2026-07-21）。
  //     只在这些是【完整目标】时才问：`rm -rf .` / `..` / `./` / `../` / `*` 会问，
//     而 `rm -rf ./dist` / `rm -rf node_modules` 这类有明确子路径的照常放行，不制造噪音。
  {
    re: /\brm\b(?=[^\n]*\s(-{1,2}[a-z]*r[a-z]*|--recursive)\b)[^\n]*\s["']?(\*(\s|$|["'])|\.\.?\/?(\s|$|["'])|\?\*|\.\[|\$\(|`)/i,
    why: "递归删除通配/相对目标（实际删哪取决于工作目录）", action: "ask",
  },
  // ③c 其它「大范围抹除」手法：find -delete / mv 走家目录 / rsync --delete。
  //     它们不带 rm 字样，却一样能清空目录树。
  {
    re: /\bfind\b[^\n]*\s(-delete\b|-exec\s+rm\b)|\bmv\b[^\n]*\s(~\/|\$\{?HOME\}?|\/(Users|System|etc|var|usr|Library|Applications))|\brsync\b[^\n]*--delete/i,
    why: "大范围删除/移动（find -delete、mv 家目录、rsync --delete）", action: "ask",
  },
  { re: /\bdd\b[^\n]*\bof=\/dev\/|\bmkfs(\.\w+)?\s+\/dev\/|>\s*\/dev\/(disk|sd|rdisk|nvme)/i, why: "直接写裸磁盘设备 / 格式化磁盘", action: "ask" },
  // ④ 持久化 / 凭据篡改（补 zsh 的 .zshenv/.zprofile/.zlogin、fish、LaunchAgents；crontab 放行 -l/-e）
  {
    re: /\.ssh\/authorized_keys|\bcrontab\s+(?!-[le]\b)\S|launchctl\s+(load|bootstrap)|Library\/LaunchAgents|\.config\/fish\/|>>?\s*~?\/?\.(zshrc|zshenv|zprofile|zlogin|bashrc|bash_profile|profile)\b/i,
    why: "写开机自启 / SSH 授权 / shell 启动脚本（植入持久化）", action: "ask",
  },
  // ⑤ 外泄密钥：敏感路径 + 网络工具同现（去掉 .env 免误伤 health-check；网络工具补 python/node/ssh/rsync/openssl）
  //    路径认整个 .ssh 目录而非仅 .ssh/id_——`tar cz ~/.ssh | curl -T -` 打包整目录外发，只认 id_ 就漏了。
  {
    re: /(\.ssh\b|\.aws\/credentials|\.config\/gcloud|\/\.claude\b)[^\n]*\b(curl|wget|nc|ncat|scp|rsync|ssh|ftp|openssl|nslookup|dig|python3?|node)\b|\b(curl|wget|nc|ncat|scp|rsync|ftp|openssl)\b[^\n]*(\.ssh\b|\.aws\/credentials|\/\.claude\b)/i,
    why: "把密钥/凭据文件外发到网络", action: "ask",
  },
  // ⑥ fork 炸弹
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: "fork 炸弹", action: "block" },
];

export function screenCommand(
  command: string
): { hit: false } | { hit: true; why: string; action: "ask" | "block" } {
  for (const p of DANGER_PATTERNS) {
    if (p.re.test(command)) return { hit: true, why: p.why, action: p.action };
  }
  return { hit: false };
}

function clip(s: string): { text: string; truncated: boolean } {
  if (s.length <= MAX_OUTPUT_CHARS) return { text: s, truncated: false };
  const half = Math.floor(MAX_OUTPUT_CHARS / 2);
  return {
    text: `${s.slice(0, half)}\n\n…（中间省略 ${s.length - MAX_OUTPUT_CHARS} 字符）…\n\n${s.slice(-half)}`,
    truncated: true,
  };
}

export const bashTool: ToolDef = {
  name: "bash",
  description:
    "在本机执行一条 shell 命令，返回 stdout / stderr / 退出码。Windows 使用 PowerShell（优先 7），不是 POSIX Bash：" +
    "请用 PowerShell cmdlet、`;`、`$null`，不要使用 find/head、/dev/null 等 Linux 语法。上述语法要求仅适用于 Windows；Linux/macOS 使用 Bash。可指定工作目录与超时。" +
    "用于装依赖、跑脚本、查系统状态、操作文件等。不可逆的动作（删除、覆盖、对外发送）先跟 用户 确认。",
  // shell 命令天生慢（npm install / 构建 / 下载），默认 30s 会误杀；这里放宽。
  // 外层保险丝要比内层 kill 宽，让内层先超时并带出部分输出。
  // 包含确认等待、命令时限与有界进程树清理。外层取消同样传到本次命令，
  // 不重启整个任务；超时保留部分输出，停止不代表副作用可以安全重放。
  timeoutMs: ASK_MAX_WAIT_MS + MAX_TIMEOUT_MS + 30_000,
  readOnly: false,
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "要执行的命令。Windows=PowerShell（优先 7；用 cmdlet/`;`/`$null`，勿写 POSIX find/head、/dev/null）；Linux/macOS=Bash。",
      },
      cwd: { type: "string", description: "工作目录（绝对路径）。缺省 = Harbour 进程的当前目录" },
      timeout_ms: {
        type: "number",
        description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}。超时会 kill 掉进程并返回已产生的输出`,
      },
    },
    required: ["command"],
  },
  async execute(args, ctx) {
    if (ctx.signal?.aborted) throw new Error("run aborted（bash 尚未启动）");
    const command = String(args.command ?? "").trim();
    if (!command) throw new Error("bash: command 不能为空");

    // 防线①：来源闸。只有人在场的交互渠道能跑 bash；自动触发一律拒绝。
    if (!isInteractiveOwner(ctx)) {
      ctx.logger.warn(
        { agent: ctx.agent?.name, channel: ctx.source?.channel ?? null, taskType: ctx.taskType ?? null, command: command.slice(0, 200) },
        "bash:refused:autonomous"
      );
      return {
        refused: true,
        reason:
          "bash 只在 Harbour 已验证为 用户 本人的 web/discord/qq 交互中可用。当前来源不是已验证主人" +
          "（可能是外部用户、定时/探活或子 agent），已拒绝执行。",
      };
    }

    // 防线②：危险命令筛。分两档——
    //   block：注入 payload 标配（下载即执行 / 反弹 shell / fork 炸弹），没有正当交互用途 → 直接拒。
    //   ask  ：删除、抹盘、持久化、密钥外泄——这些【可能是正常需求】（删 build 目录、刷 SD 卡），
    //          一律拒会挡住真活，一律放行又危险，所以【停下来问 用户】。
    const screen = screenCommand(command);
    if (screen.hit && screen.action === "block") {
      ctx.logger.warn(
        { agent: ctx.agent?.name, why: screen.why, command: command.slice(0, 300) },
        "bash:refused:danger"
      );
      return {
        refused: true,
        reason:
          `这条命令命中危险模式（${screen.why}），已拒绝。这类操作常见于「网页里藏的注入指令」，` +
          `不会自动执行。如果确实是你（用户）本意，请在终端里自己跑。`,
      };
    }
    if (screen.hit && screen.action === "ask") {
      if (!ctx.askUser) {
        // 【降级：把命令打出来让人自己回】按 用户 的要求，做不到弹窗就正常 print。
        //
        // 说明（2026-07-21 对抗复查 L10）：当前这段其实【走不到】——闸① 放行的渠道
        // （web / discord）与 runtime 注入 askUser 的条件完全同源，能过闸①的必有 askUser。
        // 保留它是防将来放宽闸① 时漏掉这条路径（那时它就是唯一的安全网）。
        // 文案刻意【不写】「回一句确认执行就跑」——那会再次落回这里形成死循环；
        // 只给能真正解决问题的出口：去 web 面板。
        ctx.logger.warn(
          { agent: ctx.agent?.name, why: screen.why, channel: ctx.source?.channel ?? null },
          "bash:ask-unavailable"
        );
        return {
          refused: true,
          needsConfirmation: true,
          reason:
            `这条命令需要人确认（${screen.why}），但当前渠道弹不出确认框，所以【没有执行】。\n` +
            `待确认的命令原文：\n${command}\n` +
            `要跑的话去 web 面板发起同一条命令，那边会弹确认框。`,
        };
      }
      const answer = await ctx.askUser({
        kind: "confirm",
        question: `要执行这条命令吗？命中：${screen.why}`,
        detail: command,
        options: [
          { value: "approve", label: "执行", hint: "我确认这是我要的操作" },
          { value: "deny", label: "取消", hint: "不要执行（默认）" },
        ],
      });
      // 只认明确的 approve。超时（ASK_TIMEOUT）、取消、或自由文本一律当【不同意】——
      // 没得到明确同意 ≠ 同意，这是唯一安全的默认值。
      if (answer !== "approve") {
        const timedOut = answer === ASK_TIMEOUT;
        ctx.logger.warn({ agent: ctx.agent?.name, answer, why: screen.why }, "bash:ask-denied");
        return {
          refused: true,
          reason: timedOut
            ? `等你确认超时了，没有执行（命中：${screen.why}）。需要的话再让我跑一次。`
            : `你没有批准这条命令（回复：${answer}），没有执行。`,
          ...(timedOut ? {} : { yourAnswer: answer }),
        };
      }
      ctx.logger.info({ agent: ctx.agent?.name, why: screen.why }, "bash:ask-approved");
    }

    const cwd = args.cwd ? String(args.cwd) : process.cwd();
    const timeoutMs = Math.min(
      Math.max(Number(args.timeout_ms) || DEFAULT_TIMEOUT_MS, 1_000),
      MAX_TIMEOUT_MS
    );

    // 见文件头「密钥」。剔两类：
    //   *_KEY / *_TOKEN / *_SECRET —— 防任意模型槽或第三方凭据被 env/printenv 印进 trace 落盘。
    //   WEB_AUTH_TOKEN / DISCORD_* / WEB_PORT —— 这些是【确认通道的凭据】。
    //     子进程拿到它们就能自己 POST /api/asks/:id/answer 把自己的确认点掉
    //     （对抗复查 2026-07-21 的 H2）。见文件头「确认通道」一节。
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (/(?:^|_)(?:KEY|TOKEN|SECRET)$/.test(k)) continue;
      if (k.startsWith("DISCORD_") || k.startsWith("QQBOT_") || k === "OWNER_QQ_OPENIDS" || k === "WEB_PORT") continue;
      if (v !== undefined) env[k] = v;
    }

    // 先验 cwd。不验的话 spawn 会报 "spawn /bin/bash ENOENT"，指向 shell 找不到，
    // 完全误导——真正的原因是工作目录不存在。
    if (!fs.existsSync(cwd)) throw new Error(`bash: 工作目录不存在：${cwd}`);

    const isWin = os.platform() === "win32";
    const selectedShell = currentCommandShell();
    const shell = selectedShell.executable;
    const shellFlavor = selectedShell.name;
    const pwsh = shellFlavor === "PowerShell 7";
    // Windows PowerShell 5 默认会把无 BOM UTF-8 文件当系统 ANSI（中文 trace 因此变成乱码）。
    // 优先 pwsh 7；仅在机器没装时回退，并给旧版显式设 UTF-8 默认编码。
    const legacyUtf8Prefix =
      "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; " +
      "$OutputEncoding = [Console]::OutputEncoding; $PSDefaultParameterValues['*:Encoding'] = 'utf8'; ";
    const shellArgs = isWin
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", pwsh ? command : legacyUtf8Prefix + command]
      : ["-lc", command];

    ctx.logger.info({ agent: ctx.agent?.name, cwd, timeoutMs, command: command.slice(0, 200) }, "bash:exec");

    return await new Promise((resolve, reject) => {
      let child;
      try {
        // detached：让 shell 成为进程组组长，超时时才能连它的子孙一起杀（见下方 timer）。
        child = spawn(shell, shellArgs, { cwd, env, windowsHide: true, detached: !isWin });
      } catch (e) {
        return reject(new Error(`bash: 无法启动（${e instanceof Error ? e.message : String(e)}）`));
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      let stopping: "timeout" | "abort" | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      child.stdout?.on("data", (d) => { stdout += d.toString(); });
      child.stderr?.on("data", (d) => { stderr += d.toString(); });

      const detach = () => {
        if (timer) clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
      };
      const result = (code: number | null, signal?: NodeJS.Signals | null, cleanup?: ProcessTreeCleanup) => {
        const o = clip(stdout), e = clip(stderr);
        return {
          command, cwd, shell: shellFlavor, exitCode: code,
          ...(signal ? { signal } : {}),
          ...(stopping === "timeout" ? { timedOut: true, retrySafety: "needs_review",
            cleanup: cleanup?.confirmed ? "confirmed" : "unconfirmed",
            note: `命令超过 ${timeoutMs}ms；${cleanup?.confirmed ? "已终止本次命令的进程树" : "未确认进程树已清理，不得直接重跑"}。以下为部分输出；先核对已产生的文件和结果。` } : {}),
          stdout: o.text, stderr: e.text,
          ...(o.truncated || e.truncated ? { outputTruncated: true } : {}),
        };
      };
      const stop = async (kind: "timeout" | "abort") => {
        if (settled || stopping) return;
        stopping = kind;
        if (timer) clearTimeout(timer);
        const cleanup = await terminateProcessTree(child).catch((): ProcessTreeCleanup => ({
          confirmed: false, reason: "tree-termination-failed",
        }));
        ctx.logger[cleanup.confirmed ? "info" : "warn"]({ agent: ctx.agent?.name, pid: child.pid,
          kind, cleanup: cleanup.confirmed ? "confirmed" : "unconfirmed", reason: cleanup.reason }, "bash:process-tree-stop");
        // A descendant may keep inherited pipes open even after its parent exited.
        // Never await 'close' indefinitely, and never claim uncertain cleanup worked.
        child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy();
        child.unref();
        if (settled) return;
        settled = true;
        detach();
        if (kind === "abort" || ctx.signal?.aborted) {
          reject(new Error(`run aborted（${cleanup.confirmed ? "本次命令进程树已清理" : "进程树清理未确认；禁止直接重跑"}）`));
        } else resolve(result(child.exitCode, child.signalCode, cleanup));
      };
      const onAbort = () => { void stop("abort"); };

      child.on("error", (e) => {
        if (settled || stopping) return;
        settled = true;
        detach();
        reject(new Error(`bash: 执行失败（${e.message}）`));
      });

      child.on("close", (code, signal) => {
        if (settled || stopping) return;
        settled = true;
        detach();
        resolve(result(code, signal));
      });
      timer = setTimeout(() => { void stop("timeout"); }, timeoutMs);
      if (ctx.signal?.aborted) onAbort();
      else ctx.signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};
