import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Attachment, Permissions, ToolContext, ToolDef } from "../../types";
import { AGENT_PERMISSION_MODES } from "../../types";
import { currentCheckpointOperationId } from "../checkpoint";
import { PermissionError } from "../permissions";
import { screenCommand } from "../tools/bash";
import { browserDownloadRoot } from "../novelAiArtifactDelivery";
import { defaultNovelAiCharacterLibraryDir, resolveNovelAiReferenceHandle } from "../novelAiCharacterLibrary";
import { coworkDeviceHub, type CoworkDeviceHub } from "./deviceHub";
import { CoworkDeviceError, type CoworkCommand } from "./protocol";

const ROUTED_TOOLS = new Set(["read_file", "list_files", "bash", "opencli_adapter", "opencli_browser"]);
const ADDED_TOOLS = new Set(["write_file", "export_file"]);
const BROWSER_TOOLS = new Set(["opencli_adapter", "opencli_browser"]);
const MAX_GRANT_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACTS = 32;
const MAX_DURATION = 600_000;
const WRAPPED = Symbol("cowork-routed-tool");
const EVIDENCE_KEY = "_coworkEvidence";
const PATH_FIELDS = new Set(["path", "filePath", "downloadPath", "downloadedPath"]);
const PATH_ARRAYS = new Set(["paths", "files", "artifacts"]);

type Hub = Pick<CoworkDeviceHub, "execute" | "cleanup"> & Partial<Pick<CoworkDeviceHub, "get">>;
type WrappedTool = ToolDef & { [WRAPPED]?: true };
interface Evidence { key: string; value: unknown }
interface Artifact { remotePath: string; name: string; mime: string; size: number; sha256: string }
interface HostResult { result: unknown; toolEvidence: Evidence[]; artifacts: Artifact[] }
interface ImportedArtifact extends Artifact { path: string; url: string }
export interface CoworkRoutingOptions {
  /** Test seams and explicit deployment configuration; never read from model arguments. */
  uploadDir?: string;
  downloadRoot?: string;
  characterLibraryDir?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function checkRemoteAuthority(tool: ToolDef, ctx: ToolContext): void {
  const channel = ctx.source?.channel;
  if (ctx.source?.actor?.role !== "owner" || !channel || !["web", "qq", "discord"].some((name) => channel === name || (name === "discord" && channel.startsWith("discord"))) || ctx.taskType === "heartbeat") {
    throw new PermissionError("Cowork 只允许入口已验证主人的 Web/QQ/Discord 交互运行；自动任务和未知来源不可派发本地工具");
  }
  const required = ADDED_TOOLS.has(tool.name) ? "bash" : tool.name;
  if (!ctx.agent.tools.includes(required)) throw new PermissionError(`Cowork：Agent 未挂载 ${required}，不能执行 ${tool.name}`);
  const permissions = ctx.agent.governance?.permissions;
  if (permissions?.tools !== undefined && !permissions.tools.includes(tool.name)) throw new PermissionError(`Cowork：工具 ${tool.name} 不在 governance.permissions.tools 白名单`);
  const mode = ctx.permissionMode ?? ctx.agent.permissionMode;
  if (!AGENT_PERMISSION_MODES.includes(mode)) throw new PermissionError("Cowork：未知运行权限模式，已拒绝派发");
  // Browser has read-only actions behind its own deterministic host allowlist. Do not mark
  // the whole ToolDef readOnly: write actions still must be denied on the execution device.
  if ((mode === "plan" || permissions?.readOnly === true) && tool.readOnly !== true && !BROWSER_TOOLS.has(tool.name)) throw new PermissionError(`Cowork：plan/readOnly 不能执行 ${tool.name}`);
  if (tool.name === "bash" && (permissions?.readPaths !== undefined || permissions?.writePaths !== undefined)) throw new PermissionError("Cowork：bash 无 OS 文件沙箱，不能绕过已声明的路径限制");
}

function timeoutFor(tool: ToolDef, args: Record<string, unknown>): number {
  const requested = tool.name === "bash" ? Number(args.timeout_ms) || 120_000 : tool.timeoutMs ?? 120_000;
  return Math.max(1000, Math.min(MAX_DURATION, requested));
}

function transportContext(ctx: ToolContext, runId: string): Record<string, unknown> {
  const actor = ctx.source!.actor!;
  return {
    source: { channel: ctx.source!.channel, ...(ctx.source!.key ? { key: ctx.source!.key } : {}), runId,
      actor: { role: actor.role, platform: actor.platform, id: actor.id } },
    ...(ctx.taskType ? { taskType: ctx.taskType } : {}),
    ...(ctx.execution?.novelAiSubmission ? { novelAiSubmission: ctx.execution.novelAiSubmission } : {}),
    ...(ctx.execution?.subagentDelegationId ? { subagentDelegationId: ctx.execution.subagentDelegationId } : {}),
  };
}

async function confirmShell(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown | undefined> {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) throw new Error("bash: command 不能为空");
  const screened = screenCommand(command);
  if (!screened.hit) return undefined;
  if (screened.action === "block") return { refused: true, reason: `Cowork bash 命中危险模式（${screened.why}），没有派发或执行。` };
  if (!ctx.askUser) return { refused: true, needsConfirmation: true, reason: `Cowork bash 需要即时确认（${screened.why}）；当前无法安全确认，没有执行。` };
  const answer = await ctx.askUser({ kind: "confirm", question: `允许在所选 Cowork 设备执行这条命令吗？命中：${screened.why}`, detail: command,
    options: [{ value: "approve", label: "执行", hint: "确认当前设备与这条具体命令" }, { value: "deny", label: "取消", hint: "默认不执行" }] });
  if (answer !== "approve") return { refused: true, reason: "Cowork bash 未获得明确批准，没有执行。" };
  return undefined;
}

function selectAttachment(attachments: Attachment[], selector: unknown): Attachment {
  let selected: Attachment | undefined;
  if (selector === undefined || selector === null || selector === "") {
    if (attachments.length !== 1) throw new Error("Cowork upload_attachment 需要指定本轮唯一附件的索引或精确文件名");
    selected = attachments[0];
  } else if (typeof selector === "number" && Number.isInteger(selector) && selector >= 0) selected = attachments[selector];
  else if (typeof selector === "string") {
    const matches = attachments.filter((attachment) => attachment.name === selector);
    if (matches.length === 1) selected = matches[0];
  }
  if (!selected || selected.kind !== "image") throw new Error("Cowork upload_attachment 只能选择当前轮真实图片 grant，不能传任意路径或历史附件");
  return selected;
}

async function readBounded(file: string): Promise<Buffer> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_GRANT_BYTES) throw new Error("Cowork 文件必须是 1–16 MB 的普通文件");
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const next = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!next.bytesRead) break;
      offset += next.bytesRead;
    }
    if (offset > stat.size) throw new Error("Cowork 文件在读取时变大，请重新发起操作");
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

async function checkedImageGrant(file: string, name: string, expectedHash?: string): Promise<Record<string, unknown>> {
  const bytes = await readBounded(file);
  const digest = hash(bytes);
  if (expectedHash && expectedHash !== digest) throw new Error("Cowork 图片内容与当前授权哈希不一致");
  const png = bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!png && !jpeg && !webp) throw new Error("Cowork 图片 grant 必须验签为 PNG/JPEG/WebP");
  const sharp = (await import("sharp")).default;
  const metadata = await sharp(bytes, { animated: false, limitInputPixels: 50_000_000 }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Cowork 图片 grant 无法解码");
  return { name, mime: png ? "image/png" : jpeg ? "image/jpeg" : "image/webp", sha256: digest, dataBase64: bytes.toString("base64") };
}

async function addCurrentGrants(command: CoworkCommand, ctx: ToolContext, options: CoworkRoutingOptions): Promise<void> {
  if (command.tool !== "opencli_browser") return;
  if (command.args.action === "upload_attachment") {
    const attachment = selectAttachment(ctx.attachments ?? [], command.args.attachment);
    const root = await fs.realpath(path.resolve(options.uploadDir ?? process.env.UPLOAD_DIR ?? "assets/uploads"));
    let requested: string;
    if (attachment.url.startsWith("/uploads/")) requested = path.resolve(root, decodeURIComponent(attachment.url.slice("/uploads/".length)));
    else if (attachment.path) requested = path.resolve(attachment.path);
    else throw new Error("Cowork 当前图片必须先由入站层收进 Harbour uploads，不能直接转发网络 URL");
    const file = await fs.realpath(requested);
    if (!inside(file, root)) throw new PermissionError("Cowork 图片 grant 越出受控 uploads 目录");
    command.context!.attachments = [await checkedImageGrant(file, attachment.name, attachment.image?.sha256)];
  } else if (command.args.action === "upload_character_reference") {
    const handle = command.args.asset;
    if (typeof handle !== "string") throw new Error("Cowork 角色图必须使用 novelai_character 返回的内容寻址句柄");
    const reference = await resolveNovelAiReferenceHandle(options.characterLibraryDir ?? defaultNovelAiCharacterLibraryDir(), handle, MAX_GRANT_BYTES);
    command.context!.characterReferences = [{ ...await checkedImageGrant(reference.filePath, reference.name, reference.sha256), handle }];
  }
}

function hostEnvelope(value: unknown): HostResult | undefined {
  if (!record(value) || !Object.hasOwn(value, "result") || !Array.isArray(value.toolEvidence) || !Array.isArray(value.artifacts)) return undefined;
  const toolEvidence = value.toolEvidence.filter((entry): entry is Evidence => record(entry) && typeof entry.key === "string" && entry.key.startsWith("opencli_browser:novelai:") && Object.hasOwn(entry, "value"));
  const artifacts = value.artifacts;
  if (artifacts.length > MAX_ARTIFACTS || !artifacts.every((entry) => record(entry) && typeof entry.remotePath === "string" && entry.remotePath.length > 0
    && entry.remotePath.length <= 4096 && typeof entry.name === "string" && typeof entry.mime === "string"
    && Number.isSafeInteger(entry.size) && Number(entry.size) > 0 && Number(entry.size) <= MAX_GRANT_BYTES
    && typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256))) throw new Error("Cowork Browser artifact manifest 无效");
  return { result: value.result, toolEvidence, artifacts: artifacts as unknown as Artifact[] };
}

/** Replace exact, attested artifact paths in path-bearing fields only, never arbitrary text. */
export function mapCoworkArtifactPaths(value: unknown, imported: ReadonlyMap<string, ImportedArtifact>, field = ""): unknown {
  if (typeof value === "string") return (PATH_FIELDS.has(field) || PATH_ARRAYS.has(field)) ? imported.get(value)?.path ?? value : value;
  if (Array.isArray(value)) return value.map((item) => mapCoworkArtifactPaths(item, imported, field));
  if (!record(value)) return value;
  const output = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "remotePath" ? item : mapCoworkArtifactPaths(item, imported, key)]));
  const artifact = [...PATH_FIELDS].map((key) => typeof value[key] === "string" ? imported.get(value[key] as string) : undefined).find(Boolean)
    ?? (typeof value.remotePath === "string" ? imported.get(value.remotePath) : undefined);
  if (artifact) { output.path ??= artifact.path; output.remotePath = artifact.remotePath; output.url = artifact.url; }
  return output;
}

/** Checkpoint replay uses this hook too: Browser evidence cannot rely on re-running a tool. */
export function restoreCoworkEvidence(result: unknown, ctx: ToolContext): unknown {
  if (!record(result) || !record(result[EVIDENCE_KEY]) || !ctx.execution) return result;
  const marker = result[EVIDENCE_KEY];
  if (marker.deviceId !== ctx.execution.cowork?.deviceId || !Array.isArray(marker.entries)) return result;
  ctx.execution.toolEvidence ??= new Map();
  for (const entry of marker.entries) {
    if (record(entry) && typeof entry.key === "string" && entry.key.startsWith("opencli_browser:novelai:") && Object.hasOwn(entry, "value")) ctx.execution.toolEvidence.set(entry.key, entry.value);
  }
  return result;
}

function rememberProvisionalEvidence(raw: unknown, deviceId: string, ctx: ToolContext): Evidence[] {
  if (!record(raw) || !Array.isArray(raw.toolEvidence)) return [];
  const entries = raw.toolEvidence.filter((entry): entry is Evidence => record(entry) && typeof entry.key === "string" && entry.key.startsWith("opencli_browser:novelai:") && Object.hasOwn(entry, "value"));
  const provisional = entries.map((entry) => ({ ...entry, value: record(entry.value) ? { ...entry.value, completed: false, artifacts: [],
    reason: "Cowork Browser 的提交证据已保留，但产物尚未在中央完整验收；禁止重新生成。" } : entry.value }));
  restoreCoworkEvidence({ [EVIDENCE_KEY]: { deviceId, entries: provisional } }, ctx);
  return provisional;
}

function assertAttestedArtifacts(value: unknown, imported: ReadonlyMap<string, ImportedArtifact>): void {
  if (!record(value)) return;
  const artifacts = value.artifacts;
  if (value.completed === true && value.submitted === true && (!Array.isArray(artifacts) || !artifacts.length)) throw new Error("已提交成图的完成证据缺少可验收产物");
  if (!Array.isArray(artifacts)) return;
  for (const artifact of artifacts) {
    const paths = typeof artifact === "string" ? [artifact] : record(artifact)
      ? [...PATH_FIELDS, "remotePath"].flatMap((key) => typeof artifact[key] === "string" ? [artifact[key] as string] : []) : [];
    if (!paths.length || paths.some((file) => !imported.has(file))) throw new Error("Browser 证据引用了未在 manifest 验签并完整导入的产物");
  }
}

async function importArtifact(artifact: Artifact, command: CoworkCommand, deviceId: string, hub: Hub, ctx: ToolContext, options: CoworkRoutingOptions): Promise<ImportedArtifact> {
  const operationId = `cowork-artifact-${hash(`${command.operationId}\0${artifact.remotePath}\0${artifact.sha256}`).slice(0, 48)}`;
  // This is transport of an attested tool artifact, not a model-visible export capability.
  // The worker receives permission for this exact file only, never an unconstrained reader.
  const exported = await hub.execute(deviceId, { operationId, runId: command.runId, ...(command.sessionId ? { sessionId: command.sessionId } : {}), agent: command.agent,
    tool: "export_file", args: { path: artifact.remotePath }, mode: command.mode, ...(command.cwd ? { cwd: command.cwd } : {}),
    permissions: { tools: ["export_file"], readPaths: [artifact.remotePath], writePaths: [] }, context: command.context,
    deadline: Date.now() + MAX_DURATION }, { signal: ctx.signal });
  if (!record(exported) || typeof exported.url !== "string" || !exported.url.startsWith("/uploads/") || exported.remotePath !== artifact.remotePath) throw new Error("Cowork export_file 缺少真实中央附件引用");
  const uploadRoot = await fs.realpath(path.resolve(options.uploadDir ?? process.env.UPLOAD_DIR ?? "assets/uploads"));
  const source = await fs.realpath(path.resolve(uploadRoot, decodeURIComponent(exported.url.slice("/uploads/".length))));
  if (!inside(source, uploadRoot)) throw new PermissionError("Cowork 导出的附件越出中央 uploads 根目录");
  const bytes = await readBounded(source);
  if (bytes.length !== artifact.size || hash(bytes) !== artifact.sha256) throw new Error("Cowork 导出产物与 Browser 验签 manifest 的大小/哈希不一致");
  const downloadRoot = path.resolve(options.downloadRoot ?? browserDownloadRoot());
  const directory = path.join(downloadRoot, "cowork", hash(deviceId).slice(0, 24));
  await fs.mkdir(directory, { recursive: true });
  const [realRoot, realDirectory] = await Promise.all([fs.realpath(downloadRoot), fs.realpath(directory)]);
  if (!inside(realDirectory, realRoot)) throw new PermissionError("Cowork 中央导入路径越出 Browser 受控下载根");
  const extension = /^[.][a-zA-Z0-9]{1,10}$/.test(path.extname(artifact.name)) ? path.extname(artifact.name).toLowerCase() : ".bin";
  const target = path.join(realDirectory, `${artifact.sha256}${extension}`);
  try { await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fs.realpath(target);
    if (!inside(existing, realDirectory) || hash(await readBounded(existing)) !== artifact.sha256) throw new Error("Cowork 内容寻址导入目标冲突");
  }
  return { ...artifact, path: target, url: exported.url };
}

async function consumeBrowserResult(raw: unknown, command: CoworkCommand, deviceId: string, hub: Hub, ctx: ToolContext, options: CoworkRoutingOptions): Promise<unknown> {
  // Saving paid-submission evidence cannot depend on later upload/hash/transport success.
  // Provisional evidence carries no central file path and is upgraded only atomically.
  rememberProvisionalEvidence(raw, deviceId, ctx);
  const envelope = hostEnvelope(raw);
  if (!envelope) return raw;
  const imported = new Map<string, ImportedArtifact>();
  for (const artifact of envelope.artifacts) {
    const existing = imported.get(artifact.remotePath);
    if (existing && existing.sha256 !== artifact.sha256) throw new Error("Cowork 同一路径的产物哈希冲突");
    if (!existing) imported.set(artifact.remotePath, await importArtifact(artifact, command, deviceId, hub, ctx, options));
  }
  for (const entry of envelope.toolEvidence) assertAttestedArtifacts(entry.value, imported);
  if (record(envelope.result) && (envelope.result.submitted === true || command.args.action === "collect_novelai_result")) assertAttestedArtifacts(envelope.result, imported);
  if (record(envelope.result) && envelope.result.saved === true) {
    assertAttestedArtifacts({ artifacts: [envelope.result] }, imported);
  }
  const entries = envelope.toolEvidence.map((entry) => ({ ...entry, value: mapCoworkArtifactPaths(entry.value, imported) }));
  const mapped = mapCoworkArtifactPaths(envelope.result, imported);
  // The marker is transport-owned, never something a page/adapter result may fabricate.
  if (record(mapped)) delete mapped[EVIDENCE_KEY];
  if (!entries.length && !imported.size) return mapped;
  const result = { ...(record(mapped) ? mapped : { result: mapped }),
    ...(imported.size ? { coworkArtifacts: [...imported.values()] } : {}),
    [EVIDENCE_KEY]: { deviceId, operationId: command.operationId, entries } };
  restoreCoworkEvidence(result, ctx);
  return result;
}

const cleanupRegistrations = new WeakMap<object, Set<string>>();
function registerCleanup(ctx: ToolContext, deviceId: string, runId: string, hub: Hub): void {
  // Only the top-level runtime owns whole-run cleanup; a subagent finishing must not close
  // a sibling's browser. The runtime callback coalesces registrations across all children.
  // A keyed registration is idempotent even if a ToolDef is called directly by an SDK.
  if (!ctx.execution?.deferCoworkCleanup && !ctx.deferCleanup) return;
  const owner = ctx.execution?.deferCoworkCleanup ?? ctx.execution ?? ctx;
  let registered = cleanupRegistrations.get(owner);
  if (!registered) { registered = new Set(); cleanupRegistrations.set(owner, registered); }
  const key = `cowork:${deviceId}:${runId}`;
  if (registered.has(key)) return;
  registered.add(key);
  if (ctx.execution?.deferCoworkCleanup) { ctx.execution.deferCoworkCleanup(deviceId, runId); return; }
  ctx.deferCleanup!(key, () => { registered!.delete(key); hub.cleanup(deviceId, runId); });
}

function serverCwdArguments(tool: ToolDef, args: Record<string, unknown>, selectedCwd: string | undefined): Record<string, unknown> {
  if (!selectedCwd) return args;
  const cwd = path.resolve(selectedCwd);
  if (tool.name === "read_file") return { ...args, path: path.resolve(cwd, String(args.path ?? "")) };
  if (tool.name === "list_files") return { ...args, dir: path.resolve(cwd, String(args.dir ?? "")) };
  if (tool.name === "bash") return { ...args, cwd: args.cwd ? path.resolve(cwd, String(args.cwd)) : cwd };
  // Browser keeps its server-owned profile/download roots. Never process.chdir() here:
  // one session's directory selection must not alter other sessions or tool configuration.
  return args;
}

async function traceCoworkTool(tool: ToolDef, ctx: ToolContext, hub: Hub, operationId: string,
  execute: (onProgress: (message: string) => void) => Promise<unknown>): Promise<unknown> {
  const deviceId = ctx.execution!.cowork!.deviceId;
  const metadata = { agent: ctx.agent.name, deviceId, deviceLabel: hub.get?.(deviceId)?.label ?? (deviceId === "server" ? "Harbour Server" : deviceId),
    operationId, tool: tool.name, op: tool.name, runId: ctx.execution!.runId };
  // Keep display-run identity separate from the stable logical run in the wire command.
  // Trace transport metadata only: never serialize arguments, tool results or evidence.
  ctx.logger.info(metadata, "cowork:tool:start");
  const onProgress = (message: string) => ctx.logger.info({ ...metadata, message },
    /reconnect|重新连接|重连/i.test(message) ? "cowork:tool:reconnecting" : "cowork:tool:progress");
  try {
    const result = await execute(onProgress);
    const refused = record(result) && result.refused === true;
    ctx.logger.info({ ...metadata, status: refused ? "refused" : "completed", ...(refused ? { message: "Cowork 操作未获得授权，没有执行。" } : {}) },
      refused ? "cowork:tool:failed" : "cowork:tool:complete");
    return result;
  } catch (error) {
    const status = error instanceof CoworkDeviceError ? error.status : "failed";
    ctx.logger.info({ ...metadata, status, ...(error instanceof CoworkDeviceError ? { errorCode: error.code } : {}),
      message: status === "unknown" ? "Cowork 结果未知，请查询原操作状态；不要重新执行。"
        : status === "cancelled" ? "Cowork 操作已取消。" : "Cowork 工具执行失败；请查看该工具的错误结果。" }, "cowork:tool:failed");
    throw error;
  }
}

/** Registered once, this same ToolDef reaches both Registry and SDK direct-tool execution. */
export function wrapCoworkTool(tool: ToolDef, hub: Hub = coworkDeviceHub, options: CoworkRoutingOptions = {}): ToolDef {
  if ((!ROUTED_TOOLS.has(tool.name) && !ADDED_TOOLS.has(tool.name)) || (tool as WrappedTool)[WRAPPED]) return tool;
  const wrapped: WrappedTool = { ...tool, [WRAPPED]: true, async execute(args, ctx) {
    const target = ctx.execution?.cowork;
    if (!target) return tool.execute(args, ctx);
    const operationId = currentCheckpointOperationId() ?? `cowork-${randomUUID()}`;
    return traceCoworkTool(tool, ctx, hub, operationId, async (onProgress) => {
      if (target.deviceId === "server") return tool.execute(serverCwdArguments(tool, args, target.cwd), ctx);
      if (!target.deviceId || target.deviceId === "current") throw new PermissionError("Cowork 需要已解析的精确设备 ID，不能按最近上线设备猜测");
      checkRemoteAuthority(tool, ctx);
      if (ctx.signal?.aborted) throw new CoworkDeviceError("COWORK_CANCELLED", "cancelled", "Cowork run 已取消，未派发");
      if (tool.name === "bash") { const refused = await confirmShell(args, ctx); if (refused !== undefined) return refused; }
      const execution = ctx.execution!;
      const runId = execution.coworkRunId ?? execution.checkpoint?.id ?? execution.runId;
      if (!runId) throw new Error("Cowork 缺少稳定逻辑 runId，拒绝无法追踪的执行");
      const command: CoworkCommand = {
        operationId, runId,
        ...(execution.coworkSessionId ? { sessionId: execution.coworkSessionId } : {}), agent: ctx.agent.name,
        tool: tool.name, args: { ...args }, mode: ctx.permissionMode ?? ctx.agent.permissionMode,
        ...(target.cwd ? { cwd: target.cwd } : {}),
        ...(ctx.agent.governance?.permissions ? { permissions: structuredClone(ctx.agent.governance.permissions) as Permissions } : {}),
        context: transportContext(ctx, runId), deadline: Date.now() + timeoutFor(tool, args),
      };
      registerCleanup(ctx, target.deviceId, runId, hub);
      await addCurrentGrants(command, ctx, options);
      if (tool.name === "opencli_adapter" && args.action === "run") {
        const info = await hub.execute(target.deviceId, { ...command, operationId: `${command.operationId}:info`, args: { action: "info", command: args.command } }, { signal: ctx.signal, onProgress });
        const metadata = hostEnvelope(info)?.result ?? info;
        if (!record(metadata) || !["read", "write"].includes(String(metadata.access))) throw new Error("Cowork adapter 没有可验证的读写 metadata，拒绝执行");
        if (metadata.access === "write") {
          if (!ctx.askUser) return { refused: true, needsConfirmation: true, reason: "Cowork 网站写操作需要当前渠道即时确认，没有执行。", fallbackRecommended: false };
          const answer = await ctx.askUser({ kind: "confirm", question: `允许在所选 Cowork 设备执行网站写操作 ${String(args.command)} 吗？`,
            detail: JSON.stringify({ deviceId: target.deviceId, command: args.command, arguments: args.arguments ?? {} }).slice(0, 8000),
            options: [{ value: "approve", label: "执行", hint: "确认这一次具体的网站变更" }, { value: "deny", label: "取消", hint: "默认不执行" }] });
          if (answer !== "approve") return { refused: true, reason: "Cowork 网站写操作未获得明确批准，没有执行。", fallbackRecommended: false };
          command.context!.confirmation = { operationId: command.operationId, approved: true };
        }
      }
      command.deadline = Date.now() + timeoutFor(tool, args);
      let result: unknown;
      try {
        result = await hub.execute(target.deviceId, command, { signal: ctx.signal, onProgress });
      } catch (error) {
        // A host can fail after a paid browser submission. Preserve its trusted tool evidence
        // while still propagating the unknown/failed outcome, never call the local tool.
        const payload = (error as { result?: unknown })?.result;
        if (BROWSER_TOOLS.has(tool.name) && record(payload) && Array.isArray(payload.toolEvidence)) {
          rememberProvisionalEvidence(payload, target.deviceId, ctx);
          if (!ctx.signal?.aborted) {
            try { await consumeBrowserResult({ result: null, toolEvidence: payload.toolEvidence, artifacts: Array.isArray(payload.artifacts) ? payload.artifacts : [] }, command, target.deviceId, hub, ctx, options); }
            catch { /* Keep provisional submitted evidence; original operation still fails. */ }
          }
        }
        throw error;
      }
      if (!BROWSER_TOOLS.has(tool.name)) return result;
      try { return await consumeBrowserResult(result, command, target.deviceId, hub, ctx, options); }
      catch (error) {
        const failure = new CoworkDeviceError("COWORK_ARTIFACT_IMPORT_FAILED", "unknown", `Browser 操作已执行，产物转移未完成；禁止重新生成或自动重跑：${error instanceof Error ? error.message : String(error)}`, {
          operationId: command.operationId, deviceId: target.deviceId,
          result: { toolEvidence: rememberProvisionalEvidence(result, target.deviceId, ctx), artifacts: record(result) && Array.isArray(result.artifacts) ? result.artifacts : [] },
        });
        throw failure;
      }
    });
  } };
  return wrapped;
}

/** Runtime grants these only to remote Cowork agents that already own bash. */
export function createCoworkTools(): ToolDef[] {
  const unavailable = async (): Promise<never> => { throw new PermissionError("此工具仅在明确选择远程 Cowork 设备且 Agent 已拥有 bash 时可用"); };
  return [
    { name: "write_file", description: "在当前 Cowork 设备写 UTF-8 文件；仅本地执行，不会创建中央服务器文件。最多 1 MB。", readOnly: false, timeoutMs: 120_000,
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false }, execute: unavailable },
    { name: "export_file", description: "把当前 Cowork 设备现有文件上传到 Harbour，返回跨设备可用的 url 与 remotePath。最多 16 MB。", readOnly: false, timeoutMs: MAX_DURATION,
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, execute: unavailable },
  ];
}
