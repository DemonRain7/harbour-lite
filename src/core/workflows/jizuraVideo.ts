import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ToolContext, ToolDef, RunAgent } from "../../types";
import { createSpawnSubagentTool } from "../tools/spawnSubagent";
import { viewedImageHash } from "../tools/viewImage";
import { PermissionError, resolveRead } from "../permissions";
import { terminateProcessTree } from "../processTree";
import { harbourDataHome } from "../storagePaths";
import { WorkflowInputValidationError, type WorkflowExecutor } from "./registry";

export const JIZURA_WORKFLOW = "jizura-video";
export const JIZURA_DESIGNER = "jizura_designer";
export const JIZURA_MODEL = "codex-app-server/gpt-6-astra";
type Json = Record<string, any>;
type Operation = (command: "catalog" | "render" | "verify" | "recover", input: Json, out: string, signal?: AbortSignal) => Promise<Json>;
const taskPattern = /^dgt-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const revisionPattern = /^r-[a-f0-9]{24}$/;
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const readJson = async (file: string): Promise<Json> => JSON.parse(await fs.readFile(file, "utf8"));
const exists = (file: string) => fs.access(file).then(() => true, () => false);
const invalid = (message: string): never => { throw new WorkflowInputValidationError(message); };
function fields(value: Json, allowed: string[]) {
  if (Object.keys(value).some(k => !allowed.includes(k))) invalid(`不支持的字段；允许 ${allowed.join(", ")}，不接收模型/脚本/输出路径。`);
}
function jsonData(value: unknown) {
  const text = JSON.stringify(value);
  if (!text || Buffer.byteLength(text) > 120 * 1024) invalid("JSON 超过 120KiB；使用精简原生项目/镜头表");
  const scan = (v: any, depth = 0) => {
    if (depth > 40) invalid("JSON 嵌套过深");
    if (!v || typeof v !== "object") return;
    for (const [k, child] of Object.entries(v)) {
      if (["__proto__", "prototype", "constructor"].includes(k)) invalid("不安全 JSON 字段");
      scan(child, depth + 1);
    }
  };
  scan(value);
  return text;
}
async function contained(root: string, file: string) {
  const realRoot = await fs.realpath(root), real = await fs.realpath(file);
  const rel = path.relative(realRoot, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new PermissionError("JIZURA 文件越出受控目录");
  return real;
}

/** One renderer process at a time; fixed script, arguments and output root, never a shell. */
let renderTail: Promise<void> = Promise.resolve();
export const runJizuraOperation: Operation = async (command, input, out, signal) => {
  signal?.throwIfAborted();
  const previous = renderTail;
  let release!: () => void;
  const slot = new Promise<void>(resolve => { release = resolve; });
  renderTail = previous.then(() => slot);
  const base = path.join(harbourDataHome(), "jizura", "operations");
  try {
    // Cancel a queued operation without allowing following jobs to overtake the active encoder.
    await new Promise<void>((resolve, reject) => {
      const abort = () => { signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("cancelled")); };
      signal?.addEventListener("abort", abort, { once: true });
      previous.then(() => { signal?.removeEventListener("abort", abort); resolve(); });
      if (signal?.aborted) abort();
    });
    signal?.throwIfAborted();
    await fs.mkdir(base, { recursive: true });
    const work = await fs.mkdtemp(path.join(base, "op-"));
    const inputFile = path.join(work, "input.json"), resultFile = path.join(work, "result.json");
    await fs.writeFile(inputFile, JSON.stringify(input), { flag: "wx" });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve("skills/jizura/scripts/workflow.mjs"), command, inputFile, out, resultFile],
        { cwd: process.cwd(), windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"] });
      let errorText = "", stopping: Promise<unknown> | undefined, stopReason: Error | undefined;
      const stop = (reason: Error) => { stopReason = reason; stopping ??= terminateProcessTree(child); };
      const abort = () => stop(new Error("JIZURA 已取消；保留原产物，未自动重试"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(() => stop(new Error("JIZURA 本地操作超过 12 分钟；保留原产物")), 12 * 60_000);
      child.stderr?.on("data", b => { errorText = (errorText + b.toString()).slice(-3000); });
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      child.once("error", error => { cleanup(); reject(error); });
      child.once("close", async code => { cleanup(); await stopping; stopReason ? reject(stopReason) : code === 0 ? resolve() : reject(new Error(errorText || `JIZURA exit=${code}`)); });
    });
    return await readJson(resultFile);
  } finally { release(); }
};

export function createJizuraVideoWorkflowExecutor(config: {
  uploadDir?: string; available?: () => boolean; designer?: ToolDef; operation?: Operation;
} = {}): WorkflowExecutor {
  const uploads = path.resolve(config.uploadDir ?? process.env.UPLOAD_DIR ?? "assets/uploads");
  const root = path.join(uploads, "jizura");
  const operation = config.operation ?? runJizuraOperation;
  const designer = config.designer ?? createSpawnSubagentTool();
  const directory = (ref: string) => { if (!taskPattern.test(ref)) invalid("无效 taskRef"); return path.join(root, ref); };
  const revisionDir = (ref: string, revision: string) => {
    if (!revisionPattern.test(revision)) invalid("使用 render/status 返回的 revision");
    return path.join(directory(ref), revision);
  };
  const url = (file: string) => `/uploads/${path.relative(uploads, file).split(path.sep).map(encodeURIComponent).join("/")}`;
  async function task(ctx: ToolContext, requested?: unknown) {
    const capability = ctx.execution?.delegationTasks;
    const ref = requested ?? capability?.taskRef;
    if (!capability || typeof ref !== "string" || !taskPattern.test(ref)) invalid("需要当前会话内的 taskRef；内部作者省略该字段");
    const saved = await capability!.store.get(capability!.scope, ref as string);
    if (saved.agent !== JIZURA_DESIGNER) invalid("taskRef 不是 JIZURA 任务");
    if (ctx.agent.name === JIZURA_DESIGNER && ref !== capability!.taskRef) invalid("只能处理当前绑定任务");
    return saved;
  }
  async function status(ctx: ToolContext, ref?: unknown): Promise<Json> {
    const saved = await task(ctx, ref), base = directory(saved.ref);
    if (!await exists(base)) return { status: "authoring", taskRef: saved.ref, model: JIZURA_MODEL, revisions: [] };
    await contained(uploads, base);
    const names = (await fs.readdir(base)).filter(n => revisionPattern.test(n)).sort();
    const revisions = await Promise.all(names.map(async revision => {
      const dir = revisionDir(saved.ref, revision); await contained(base, dir);
      const result = await readJson(path.join(dir, "result.json")).catch(() => undefined);
      const spec = await readJson(path.join(dir, "input.json")).catch(() => undefined);
      return { revision, status: result?.status ?? "interrupted", video: spec?.video === true,
        ...(result?.sheet ? { review: url(path.join(dir, "media", "review.png")) } : {}),
        ...(result?.error ? { error: result.error } : {}) };
    }));
    const final = await readJson(path.join(base, "final.json")).catch(() => undefined);
    if (final) {
      const dir = path.join(revisionDir(saved.ref, final.revision), "media");
      await contained(base, dir);
      const bytes = await fs.readFile(path.join(dir, "video.mp4"));
      if (hash(bytes) !== final.videoSha256) return { status: "invalid_artifact", taskRef: saved.ref, reason: "成片已变化，不交付旧验收", revisions };
      return { ...final, revisions };
    }
    return { status: "authoring", taskRef: saved.ref, model: JIZURA_MODEL, revisions,
      nextAction: { name: JIZURA_WORKFLOW, action: "resume", input: { taskRef: saved.ref } } };
  }
  return {
    id: JIZURA_WORKFLOW,
    async execute({ action, input: raw }, ctx) {
      const input: Json = { ...raw };
      if (ctx.source?.actor?.role !== "owner") throw new PermissionError("JIZURA 仅接受可信主人及其委派");
      if (ctx.permissionMode === "plan" || ctx.agent.governance?.permissions?.readOnly) throw new PermissionError("计划/只读模式不执行 JIZURA");
      ctx.signal?.throwIfAborted();
      const internal = ctx.agent.name === JIZURA_DESIGNER;
      if (!internal && input.resumeRef !== undefined) {
        if (input.taskRef !== undefined && input.taskRef !== input.resumeRef) invalid("taskRef 与 resumeRef 冲突");
        input.taskRef = input.resumeRef; delete input.resumeRef;
      }
      if (action === "status") { fields(input, ["taskRef"]); return status(ctx, input.taskRef); }
      if (!internal) {
        if (!["main-aemeath", "main-elaina"].includes(ctx.agent.name) || !["start", "resume"].includes(action)) invalid("Main 只交原始要求：start/resume/status");
        fields(input, ["request", "taskRef"]);
        if (action === "start" && input.taskRef !== undefined) invalid("已有任务用 resume");
        if (action === "resume") {
          const previous = await status(ctx, input.taskRef);
          if (previous.status === "completed" && !input.request) return { ...previous, reused: true };
          if (!input.taskRef) invalid("resume 必须提供 taskRef");
        }
        if (config.available && !config.available()) return { status: "blocked", executionStarted: false, retrySafety: "safe", reason: "Codex Astra 6 未启用/不在目录；未改用其他模型" };
        const request = input.request ?? (action === "resume" ? "继续原任务，先 status 检查已有渲染，不重复导出。" : undefined);
        if (typeof request !== "string" || !request.trim() || request.length > 20000) invalid("需要非空原始 request，最多 20000 字符");
        if (!ctx.runAgent || !ctx.execution?.delegationTasks) invalid("需要可信会话持久子任务能力");
        // Grant only this fixed node; preserve the original spawn boundary's native resume, lock and trace.
        const runAgent: RunAgent = (...args) => {
          if (args[0] !== JIZURA_DESIGNER) throw new PermissionError("JIZURA 不允许派发其它 Agent");
          args[2] = undefined; args[5] = JIZURA_MODEL;
          args[9] = { ...args[9], source: ctx.source };
          return ctx.runAgent!(...args);
        };
        const childCtx = { ...ctx, runAgent, agent: { ...ctx.agent, subagents: [{ name: JIZURA_DESIGNER, description: "JIZURA 固定设计师" }] },
          execution: { ...ctx.execution, delegationTasks: { ...ctx.execution!.delegationTasks!, eligibleAgents: [JIZURA_DESIGNER] } } };
        const result = await designer.execute({ agent: JIZURA_DESIGNER, input: request,
          ...(action === "resume" ? { resumeRef: input.taskRef } : {}) }, childCtx) as Json;
        if (typeof result.taskRef !== "string") return { status: "blocked", reason: "设计师未返回持久任务回执", result };
        const actual = await status(ctx, result.taskRef);
        return { ...actual, authorNote: typeof result.result === "string" ? result.result.slice(0, 2000) : undefined,
          instruction: "以 status 和 artifacts 为准；作者文字不是完成证据，未完成时保留 taskRef 续跑。" };
      }
      if (ctx.modelRef !== JIZURA_MODEL) throw new PermissionError("JIZURA 创作必须显式使用 Codex Astra 6，不接受替代模型");
      const saved = await task(ctx);
      if (ctx.execution?.inputBoundary?.hasPending && ["render", "recover", "finalize"].includes(action)) {
        return { status: "waiting_for_input", taskRef: saved.ref, executionStarted: false, reason: "Main 有新的补充；保留当前稿件，先返回处理，不再按旧要求渲染。" };
      }
      if (action === "catalog") { fields(input, []); return { status: "authoring", taskRef: saved.ref, catalog: await operation("catalog", {}, "", ctx.signal) }; }
      if (!["render", "recover", "finalize"].includes(action)) invalid("内部动作：catalog/render/status/recover/finalize");
      await fs.mkdir(root, { recursive: true });
      await contained(uploads, root);
      await fs.mkdir(directory(saved.ref), { recursive: true });
      await contained(uploads, directory(saved.ref));
      if (action === "recover") {
        fields(input, ["revision"]);
        const dir = revisionDir(saved.ref, String(input.revision)), out = path.join(dir, "media");
        await contained(directory(saved.ref), out);
        const result = await operation("recover", {}, out, ctx.signal);
        const record = { ...result, status: "needs_review", taskRef: saved.ref, revision: input.revision, review: url(path.join(out, "review.png")), recoveredWithoutRender: true };
        await fs.writeFile(path.join(dir, "result.json"), JSON.stringify(record, null, 2));
        return record;
      }
      if (action === "render") {
        fields(input, ["project", "shots", "video", "preset", "maxSeconds", "audio"]); jsonData(input);
        if (!input.project || typeof input.project !== "object" || typeof input.project.lyrics !== "string" || !input.project.lyrics.trim()) invalid("render 需要原生 project.lyrics");
        if (input.video !== undefined && typeof input.video !== "boolean") invalid("video 必须为布尔");
        if (input.project.res !== undefined && ![720, 1080].includes(input.project.res) || input.project.fps !== undefined && ![24, 30].includes(input.project.fps)) invalid("Workflow 当前支持 720/1080p、24/30fps，避免意外高负载");
        if (input.maxSeconds !== undefined && !(Number.isFinite(input.maxSeconds) && input.maxSeconds > 0 && input.maxSeconds <= 60)) invalid("单次短片最长 60 秒，不静默裁切");
        let audio: string | undefined;
        if (input.audio !== undefined) {
          if (typeof input.audio !== "string" || !/^\/uploads\/[\w./% -]+$/.test(input.audio)) invalid("audio 只接受主人已上传的 /uploads/ 音频，不读取任意本机文件或网址");
          const relative = decodeURIComponent(input.audio.slice(9));
          if (relative.split(/[\\/]/).some(p => p === ".." || p === ".") || /[:\\]/.test(relative)) invalid("音频路径无效");
          audio = resolveRead(ctx, await contained(uploads, path.resolve(uploads, relative)));
          const st = await fs.stat(audio);
          if (!st.isFile() || st.size > 40 * 1024 * 1024 || !/\.(wav|mp3|m4a|ogg|flac|webm)$/i.test(audio)) invalid("需要 40MB 内的普通音频文件");
        }
        const spec: Json = { ...input, project: { res: 720, fps: 24, ...input.project }, ...(audio ? { audio } : {}) };
        // Include actual audio bytes in identity: replacing an upload cannot reuse an old soundtrack.
        const revision = `r-${hash(jsonData(canonical(spec)) + (audio ? hash(await fs.readFile(audio)) : "")).slice(0, 24)}`;
        const dir = revisionDir(saved.ref, revision), out = path.join(dir, "media");
        if (await exists(dir)) {
          await contained(directory(saved.ref), dir);
          const old = await readJson(path.join(dir, "result.json")).catch(() => ({ status: "interrupted", reason: "上次操作未结算；原目录保留，不自动重放" }));
          return { ...old, taskRef: saved.ref, revision, reused: true };
        }
        await fs.mkdir(dir); await fs.writeFile(path.join(dir, "input.json"), JSON.stringify(spec), { flag: "wx" });
        // A new edit invalidates only this task's final approval; old artifacts remain intact.
        await fs.rename(path.join(directory(saved.ref), "final.json"), path.join(dir, "previous-final.json")).catch(error => { if (error.code !== "ENOENT") throw error; });
        await ctx.execution!.delegationTasks!.store.update(ctx.execution!.delegationTasks!.scope, saved.ref, { status: "open" });
        try {
          const result = await operation("render", spec, out, ctx.signal);
          const record = { ...result, status: spec.video ? "needs_review" : "preview_ready", taskRef: saved.ref, revision,
            review: url(path.join(out, "review.png")), project: url(path.join(out, "project.jizura.json")),
            instruction: "用 view_image 查看 review；这是稳定帧抽样，不能宣称完整观看。finalize 前须检查本版真实 MP4 帧。" };
          await fs.writeFile(path.join(dir, "result.json"), JSON.stringify(record, null, 2));
          return record;
        } catch (error) {
          const record = { status: "interrupted", taskRef: saved.ref, revision, error: (error as Error).message, retrySafety: "inspect_first",
            instruction: "本版保留，重复相同输入不会重渲染。可检查本版后 finalize；不能完成时说明缺口，不自动换种子再试。" };
          await fs.writeFile(path.join(dir, "result.json"), JSON.stringify(record, null, 2));
          return record;
        }
      }
      fields(input, ["revision", "review"]);
      if (typeof input.revision !== "string" || typeof input.review !== "string" || input.review.trim().length < 10 || input.review.length > 2000) invalid("finalize 需要 revision 和具体文字/裁切/对比/节奏的检查说明");
      const dir = revisionDir(saved.ref, input.revision), out = path.join(dir, "media");
      await contained(directory(saved.ref), out);
      const sheet = await fs.readFile(path.join(out, "review.png"));
      if (viewedImageHash(ctx, await fs.realpath(path.join(out, "review.png"))) !== hash(sheet)) invalid("本轮尚未实际 view_image 查看该版成片抽帧；请先看图");
      const recorded = await readJson(path.join(out, "verification.json"));
      if (recorded.sheet?.source !== "decoded-mp4" || recorded.sheet.sha256 !== hash(sheet)) invalid("不是本版 MP4 抽帧，不能用预览替代成片检查");
      const verified = await operation("verify", {}, out, ctx.signal);
      if (verified.videoSha256 !== recorded.verification?.videoSha256) invalid("MP4 与抽帧时的版本不同，不能沿用旧验收");
      const artifacts = { video: url(path.join(out, "video.mp4")), preview: url(path.join(out, "review.png")),
        project: url(path.join(out, "project.jizura.json")), editor: url(path.join(out, "editor.html")) };
      const final = { status: "completed", taskRef: saved.ref, revision: input.revision, model: JIZURA_MODEL,
        videoSha256: verified.videoSha256, verification: verified, visualReview: { by: JIZURA_MODEL, method: "sampled decoded frames", note: input.review }, artifacts,
        deliveryMarkdown: `![视频](${artifacts.video})\n![分镜预览](${artifacts.preview})\n[可编辑项目](${artifacts.project}) · [编辑器](${artifacts.editor})`,
        note: "自动制作全程离线；手动打开官方编辑器可能加载 Google Fonts。抽帧验收不等于完整观看动态。" };
      const finalFile = path.join(directory(saved.ref), "final.json"), tmp = `${finalFile}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(final, null, 2)); await fs.rename(tmp, finalFile);
      await ctx.execution!.delegationTasks!.store.update(ctx.execution!.delegationTasks!.scope, saved.ref, { status: "completed" });
      return final;
    },
  };
}
