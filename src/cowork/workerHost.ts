import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Console } from "node:console";
import type { Readable, Writable } from "node:stream";
import pino, { type Logger } from "pino";
import type { Attachment, RunSource, ToolContext, ToolDef } from "../types";
import type { CoworkCommand } from "../core/cowork/protocol";
import { validateNovelAiRequiredReferences } from "../core/novelAiReferences";

const BROWSER_TOOLS = new Set(["opencli_adapter", "opencli_browser"]);
const READ_ACTIONS = new Set(["open", "goto", "state", "snapshot", "extract", "get", "find", "inspect_novelai", "tabs", "wait"]);
const FILE_ACTIONS = new Set(["screenshot", "download", "save_data_image", "collect_novelai_result", "execute_novelai"]);
const MODES = new Set(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]);
const MAX_GRANT_BYTES = 16 * 1024 * 1024;
const MAX_LINE_BYTES = 48 * 1024 * 1024;

export interface CoworkImageGrant {
  name: string;
  mime: string;
  sha256: string;
  dataBase64: string;
  /** Present only for a centrally resolved NovelAI character-library reference. */
  handle?: string;
}

export interface CoworkWorkerPaths {
  root: string;
  downloads: string;
  screenshots: string;
  attachments: string;
  characters: string;
}

export interface CoworkWorkerResult {
  result: unknown;
  toolEvidence: Array<{ key: string; value: unknown }>;
  /** Only verified files inside this run's controlled output directories appear here. */
  artifacts: Array<{ remotePath: string; name: string; mime: string; size: number; sha256: string }>;
}

export interface CoworkWorkerFailure extends Error {
  unknown?: boolean;
  toolEvidence?: CoworkWorkerResult["toolEvidence"];
  artifacts?: CoworkWorkerResult["artifacts"];
}

export interface CoworkWorkerHostOptions {
  cwd?: string;
  stateDir?: string;
  logger?: Logger;
  tools?: ToolDef[];
  createTools?: (paths: CoworkWorkerPaths) => ToolDef[] | Promise<ToolDef[]>;
  idleTimeoutMs?: number;
}

interface WorkerRun {
  key: string;
  runId: string;
  identity: string;
  paths: CoworkWorkerPaths;
  context: ToolContext;
  tools: Promise<Map<string, ToolDef>>;
  cleanups: Map<string, () => Promise<void> | void>;
  grants: Map<string, string>;
  grantBytes: number;
  tail: Promise<unknown>;
  closing?: boolean;
  idleTimer?: NodeJS.Timeout;
}

interface Operation {
  command: CoworkCommand;
  fingerprint: string;
  controller: AbortController;
  promise: Promise<CoworkWorkerResult>;
  progress?: (message: string) => void;
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function text(value: unknown, max = 200): value is string { return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0"); }
function within(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function aborted(signal: AbortSignal): void { if (signal.aborted) throw new Error("Cowork Browser operation cancelled."); }

async function realPathWithMissing(target: string): Promise<string> {
  try { return await fs.realpath(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { if ((await fs.lstat(target)).isSymbolicLink()) throw new Error("Cowork path has a dangling symbolic link."); }
    catch (entryError) { if ((entryError as NodeJS.ErrnoException).code !== "ENOENT") throw entryError; }
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(await realPathWithMissing(parent), path.basename(target));
  }
}

/** No dotenv, runtime, models, channels, or server initialization belongs in this helper. */
async function defaultTools(paths: CoworkWorkerPaths): Promise<ToolDef[]> {
  const [{ createOpenCliTools }, { createOpenCliBrowserTools, ensureOpenCliBrowserBridge, resolveOpenCliBrowserConfig }] = await Promise.all([
    import("../core/tools/openCli"), import("../core/tools/openCliBrowser"),
  ]);
  // Only non-secret local browser settings cross into the configuration factory.
  const env = {
    OPENCLI_PROFILE: process.env.OPENCLI_PROFILE || "harbour",
    OPENCLI_BROWSER_IDLE_TIMEOUT: 3_600,
    UPLOAD_DIR: paths.attachments, MAX_UPLOAD_MB: 16,
    BROWSER_HARNESS_BIN: process.env.BROWSER_HARNESS_BIN || "browser-harness",
    HARBOUR_CHROME_PATH: process.env.HARBOUR_CHROME_PATH || "",
    HARBOUR_CHROME_PROFILE_DIR: process.env.HARBOUR_CHROME_PROFILE_DIR || "",
    HARBOUR_CHROME_EXTENSION_DIR: process.env.HARBOUR_CHROME_EXTENSION_DIR || "",
    HARBOUR_BROWSER_HARNESS_HOME: process.env.HARBOUR_BROWSER_HARNESS_HOME || "",
    HARBOUR_CHROME_DEBUG_PORT: Number(process.env.HARBOUR_CHROME_DEBUG_PORT) || 9333,
    HARBOUR_CHROME_HEADLESS: process.env.HARBOUR_CHROME_HEADLESS === "true",
    HARBOUR_CHROME_START_TIMEOUT_MS: 20_000,
  } as import("../config/env").Env;
  const config = resolveOpenCliBrowserConfig(env);
  config.downloadDir = paths.downloads;
  config.screenshotDir = paths.screenshots;
  config.attachmentRoots = [paths.attachments];
  config.attachmentStagingDir = paths.attachments;
  config.characterLibraryDir = paths.characters;
  return [
    ...createOpenCliTools(config.opencli, (ctx) => ensureOpenCliBrowserBridge(config, ctx.logger, ctx.signal, ctx.runState)),
    ...createOpenCliBrowserTools(config),
  ];
}

/** A persistent, tool-only process. The Electron durable ledger owns operation replay. */
export class CoworkWorkerHost {
  private readonly options: CoworkWorkerHostOptions;
  private readonly cwd: string;
  private readonly stateDir: string;
  private readonly logger: Logger;
  private readonly runs = new Map<string, WorkerRun>();
  private readonly operations = new Map<string, Operation>();
  private readonly completed = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly cleanupPromises = new Map<string, Promise<void>>();
  private closed = false;

  constructor(options: CoworkWorkerHostOptions = {}) {
    this.options = options;
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.stateDir = path.resolve(options.stateDir ?? path.join(process.env.HARBOUR_DATA_HOME || path.join(this.cwd, "data", "runtime"), "cowork-host"));
    this.logger = options.logger ?? pino({ level: "warn" }, process.stderr);
  }

  execute(input: CoworkCommand, onProgress?: (message: string) => void): Promise<CoworkWorkerResult> {
    try {
      const command = JSON.parse(JSON.stringify(input)) as CoworkCommand;
      this.validate(command);
      if (this.closed || this.cleanupPromises.has(command.runId)) throw new Error("Cowork Browser run is closed or currently cleaning up.");
      const { deadline: _deadline, ...semantic } = command;
      const fingerprint = hash(canonical(semantic));
      const active = this.operations.get(command.operationId);
      if (active) {
        if (active.fingerprint !== fingerprint) throw new Error("Cowork operationId conflicts with an in-flight command.");
        return active.promise;
      }
      if (this.completed.has(command.operationId)) throw new Error("Cowork operation already executed; query the Electron durable ledger instead of replaying it.");
      if (this.cancelled.has(command.operationId) || command.deadline <= Date.now()) throw new Error("Cowork command was cancelled or its deadline expired before execution.");
      const run = this.run(command);
      const controller = new AbortController();
      const operation: Operation = { command, fingerprint, controller, progress: onProgress, promise: undefined! };
      this.operations.set(command.operationId, operation);
      const timeout = setTimeout(() => controller.abort(), Math.min(2_147_483_647, command.deadline - Date.now()));
      let enteredTool = false;
      let mayWrite = false;
      let evidenceBefore = new Map<string, string>();
      let operationResult: unknown;
      // Serial calls in one logical run share the very same ToolContext and Browser session.
      operation.promise = run.tail.catch(() => undefined).then(async () => {
        aborted(controller.signal);
        if (run.closing) throw new Error("Cowork Browser run is closing.");
        const tools = await run.tools;
        const tool = tools.get(command.tool);
        if (!tool || !BROWSER_TOOLS.has(tool.name)) throw new Error("Cowork Browser tool is not installed on this device.");
        const context = run.context;
        context.signal = controller.signal;
        context.logger = this.logger.child({ operationId: command.operationId, runId: command.runId, agent: command.agent });
        mayWrite = await this.authorize(command, tool, run);
        aborted(controller.signal);
        await this.grants(command, run);
        context.askUser = async () => {
          const confirmation = command.context?.confirmation;
          return record(confirmation) && confirmation.operationId === command.operationId && confirmation.approved === true ? "approve" : "deny";
        };
        operation.progress?.(`Executing ${command.tool}/${String(command.args.action || "")}`);
        evidenceBefore = new Map([...(context.execution?.toolEvidence ?? [])].map(([key, value]) => [key, canonical(value)]));
        enteredTool = true;
        const result = await tool.execute(command.args, context);
        operationResult = result;
        const evidence = this.evidenceDelta(run, evidenceBefore);
        return { result, toolEvidence: evidence, artifacts: await this.artifacts(run, result, evidence) };
      }).catch(async (error: unknown) => {
        const failure = (error instanceof Error ? error : new Error(String(error))) as CoworkWorkerFailure;
        if (enteredTool) {
          if (mayWrite) failure.unknown = true;
          failure.toolEvidence = this.evidenceDelta(run, evidenceBefore);
          failure.artifacts = await this.artifacts(run, operationResult, failure.toolEvidence).catch(() => []);
        }
        throw failure;
      }).finally(() => {
        clearTimeout(timeout);
        this.operations.delete(command.operationId);
        this.completed.add(command.operationId);
        this.touch(run);
      });
      run.tail = operation.promise;
      this.touch(run);
      return operation.promise;
    } catch (error) { return Promise.reject(error); }
  }

  cancel(operationId: string): void {
    this.cancelled.add(operationId);
    this.operations.get(operationId)?.controller.abort();
  }

  cleanup(runId: string): Promise<void> {
    const existing = this.cleanupPromises.get(runId);
    if (existing) return existing;
    // A checkpoint resume can create fresh contexts under the same logical runId after
    // resource cleanup. Completed/cancelled operation IDs remain non-replayable below.
    const promise = this.cleanupRun(runId).finally(() => { this.cleanupPromises.delete(runId); });
    this.cleanupPromises.set(runId, promise);
    return promise;
  }

  private async cleanupRun(runId: string): Promise<void> {
    const runs = [...this.runs.values()].filter((run) => run.runId === runId);
    for (const run of runs) { run.closing = true; if (run.idleTimer) clearTimeout(run.idleTimer); }
    for (const operation of this.operations.values()) if (operation.command.runId === runId) operation.controller.abort();
    await Promise.allSettled(runs.map((run) => run.tail));
    for (const run of runs) {
      for (const cleanup of [...run.cleanups.values()].reverse()) {
        try { await cleanup(); } catch (error) { this.logger.warn({ err: String(error) }, "Cowork run cleanup failed"); }
      }
      run.cleanups.clear();
      run.context.runState?.clear();
      run.context.execution?.toolEvidence?.clear();
      this.runs.delete(run.key);
      // Only temporary transfer grants are removed. Artifacts remain available for import.
      for (const directory of [run.paths.attachments, run.paths.characters]) {
        if (within(directory, run.paths.root) && directory !== run.paths.root) {
          await fs.rm(directory, { recursive: true, force: true }).catch((error) => this.logger.warn({ err: String(error) }, "Cowork grant cleanup failed"));
        }
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...new Set([...this.runs.values()].map((run) => run.runId))].map((runId) => this.cleanup(runId)));
  }

  private validate(command: CoworkCommand): void {
    if (!record(command) || !text(command.operationId) || !text(command.runId) || !text(command.agent)
      || !BROWSER_TOOLS.has(command.tool) || !record(command.args) || !MODES.has(command.mode) || !Number.isSafeInteger(command.deadline)) throw new Error("Invalid Cowork Browser command.");
    const source = command.context?.source;
    if (!record(source) || !["web", "discord", "qq"].includes(String(source.channel)) || !record(source.actor)
      || source.actor.role !== "owner" || !text(source.actor.id) || !text(source.actor.platform)) throw new Error("Cowork Browser requires a trusted interactive owner identity from the central server.");
    const permissions = command.permissions;
    if (permissions !== undefined && !record(permissions)) throw new Error("Invalid Cowork permissions.");
    for (const key of ["readPaths", "writePaths", "tools", "mcp"] as const) {
      const values = permissions?.[key];
      if (values !== undefined && (!Array.isArray(values) || !values.every((value) => text(value, 4_096)))) throw new Error(`Invalid Cowork ${key} permission.`);
    }
    if (permissions?.readOnly !== undefined && typeof permissions.readOnly !== "boolean") throw new Error("Invalid Cowork readOnly permission.");
    if (permissions?.tools && !(permissions.tools as string[]).includes(command.tool)) throw new Error("Cowork tool is outside the delegated permission list.");
    if (command.cwd !== undefined && !text(command.cwd, 4_096)) throw new Error("Invalid Cowork cwd.");
    // Browser input never becomes a local path, arbitrary script or native CLI entry point.
    if (Object.keys(command.args).some((key) => /^(?:path|file|filePath|filename|output|directory|cwd|script|eval)$/i.test(key))) throw new Error("Cowork Browser does not accept arbitrary local paths or scripts.");
    if (typeof command.args.url === "string" && !/^https?:\/\//i.test(command.args.url)) throw new Error("Cowork Browser permits only HTTP(S) navigation.");
  }

  private run(command: CoworkCommand): WorkerRun {
    const key = JSON.stringify([command.runId, command.agent, command.context?.subagentDelegationId ?? null]);
    const source = command.context!.source as unknown as RunSource;
    const identity = canonical({ cwd: path.resolve(this.cwd, command.cwd ?? "."), mode: command.mode, permissions: command.permissions ?? null, source });
    const existing = this.runs.get(key);
    if (existing) {
      if (identity !== existing.identity) throw new Error("Cowork run identity/mode/permissions changed; start a new logical run.");
      return existing;
    }
    const root = path.join(this.stateDir, `${hash(key).slice(0, 24)}-${randomUUID()}`);
    const paths = { root, downloads: path.join(root, "downloads"), screenshots: path.join(root, "screenshots"), attachments: path.join(root, "attachments"), characters: path.join(root, "characters") };
    const cleanups = new Map<string, () => Promise<void> | void>();
    const context: ToolContext = {
      agent: { name: command.agent, systemPrompt: "", taskType: "cowork", tools: [...BROWSER_TOOLS], contextBudget: 0, permissionMode: command.mode, governance: { permissions: command.permissions } },
      logger: this.logger, source, taskType: "cowork", runState: new Map(), attachments: [],
      execution: { runId: command.runId, toolEvidence: new Map() },
      deferCleanup: (name, cleanup) => {
        cleanups.set(name, cleanup);
        return () => { if (cleanups.get(name) === cleanup) cleanups.delete(name); };
      },
    };
    const tools = Promise.resolve().then(() => this.options.tools ?? (this.options.createTools ?? defaultTools)(paths)).then((items) => new Map(items.map((tool) => [tool.name, tool])));
    const run: WorkerRun = { key, runId: command.runId, identity, paths, context, tools, cleanups, grants: new Map(), grantBytes: 0, tail: Promise.resolve() };
    this.runs.set(key, run);
    return run;
  }

  private touch(run: WorkerRun): void {
    if (run.idleTimer) clearTimeout(run.idleTimer);
    if (run.closing) return;
    run.idleTimer = setTimeout(() => { void this.cleanup(run.runId).catch(() => undefined); }, this.options.idleTimeoutMs ?? 3_600_000);
    run.idleTimer.unref();
  }

  private async authorize(command: CoworkCommand, tool: ToolDef, run: WorkerRun): Promise<boolean> {
    const action = command.args.action;
    if (typeof action !== "string") throw new Error("Cowork Browser action is required.");
    const readOnly = command.mode === "plan" || command.permissions?.readOnly === true;
    if (command.tool === "opencli_adapter") {
      if (["match", "search", "info"].includes(action)) return false;
      if (action !== "run") throw new Error("Unknown OpenCLI adapter action.");
      // Read access is proved by the same locked manifest that will execute the command.
      const metadata = await tool.execute({ action: "info", command: command.args.command }, run.context);
      if (!record(metadata) || metadata.eligible !== true || !["read", "write"].includes(String(metadata.access))) throw new Error("OpenCLI adapter access could not be verified.");
      if (readOnly && metadata.access !== "read") throw new Error("Cowork plan/readOnly refuses website writes.");
      if (metadata.access === "write") {
        const confirmation = command.context?.confirmation;
        if (!record(confirmation) || confirmation.operationId !== command.operationId || confirmation.approved !== true) throw new Error("Cowork website write requires confirmation for this exact operationId.");
      }
      return metadata.access === "write";
    }
    if (readOnly && !READ_ACTIONS.has(action)) throw new Error(`Cowork plan/readOnly refuses Browser action ${action}.`);
    if (FILE_ACTIONS.has(action)) {
      if (action === "download" && command.permissions?.writePaths !== undefined) throw new Error("Native browser download has no verifiable destination under delegated writePaths; use a controlled image export.");
      await this.checkPath(command, "write", action === "screenshot" ? run.paths.screenshots : run.paths.downloads);
    }
    if (action === "upload_attachment" || action === "upload_character_reference") {
      await this.checkPath(command, "read", action === "upload_attachment" ? run.paths.attachments : run.paths.characters);
    }
    return !READ_ACTIONS.has(action);
  }

  private async checkPath(command: CoworkCommand, kind: "read" | "write", target: string): Promise<void> {
    const roots = command.permissions?.[kind === "read" ? "readPaths" : "writePaths"];
    if (roots === undefined) return;
    const resolved = await realPathWithMissing(path.resolve(target));
    const workingRoot = path.resolve(this.cwd, command.cwd ?? ".");
    const allowed = await Promise.all(roots.map((root) => realPathWithMissing(path.resolve(workingRoot, root.replace(/[\\/]+\*{1,2}$/, "")))));
    if (!allowed.some((root) => within(resolved, root))) throw new Error(`Cowork ${kind} path is outside the delegated roots.`);
  }

  private async grants(command: CoworkCommand, run: WorkerRun): Promise<void> {
    const context = command.context!;
    if (record(context.novelAiSubmission)) {
      const limit = context.novelAiSubmission;
      if (limit.requiredReferences !== undefined) validateNovelAiRequiredReferences(limit.requiredReferences);
      if (!text(limit.onceKey, 240) || typeof limit.maxCostAnlas !== "number" || !Number.isFinite(limit.maxCostAnlas) || limit.maxCostAnlas < 0
        || !Number.isInteger(limit.numberOfImages) || Number(limit.numberOfImages) < 1 || Number(limit.numberOfImages) > 4) throw new Error("Invalid delegated NovelAI submission limit.");
      if (limit.otherReservedAnlas !== undefined && (!Number.isSafeInteger(limit.otherReservedAnlas) || Number(limit.otherReservedAnlas) < 0)) throw new Error("Invalid delegated NovelAI account reservation.");
      if (limit.form !== undefined && (!record(limit.form) ||
        ![limit.form.width, limit.form.height].every(value => Number.isInteger(value) && Number(value) >= 64 && Number(value) <= 4096 && Number(value) % 64 === 0) ||
        limit.form.numberOfImages !== limit.numberOfImages)) throw new Error("Invalid delegated NovelAI frozen form dimensions/count.");
      const previous = run.context.execution!.novelAiSubmission;
      if (previous && canonical(previous) !== canonical(limit)) throw new Error("NovelAI submission grant changed within a logical Browser run.");
      run.context.execution!.novelAiSubmission = limit as unknown as NonNullable<ToolContext["execution"]>["novelAiSubmission"];
    }
    if (text(context.subagentDelegationId)) run.context.execution!.subagentDelegationId = context.subagentDelegationId;
    for (const field of ["attachments", "characterReferences"] as const) {
      const list = context[field];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.length > 12) throw new Error("Cowork image grants must be a bounded list.");
      const attachments = run.context.attachments ??= [];
      const selectedIndexes: number[] = [];
      const aliases: Record<string, string> = Object.fromEntries([...run.grants.keys()].filter((key) => key.startsWith("character:")).map((key) => [key.slice(10).replace(/-/g, ""), key.slice(10)]));
      for (const [index, raw] of list.entries()) {
        if (!record(raw) || !text(raw.name, 240) || !/^(?:image\/png|image\/jpeg|image\/webp)$/.test(String(raw.mime))
          || !/^[a-f0-9]{64}$/.test(String(raw.sha256)) || !text(raw.dataBase64, Math.ceil(MAX_GRANT_BYTES * 4 / 3) + 4)
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.dataBase64)) throw new Error("Cowork image grant requires image bytes and a SHA-256 hash, never a path or URL.");
        if (raw.path !== undefined || raw.url !== undefined) throw new Error("Cowork image grants do not accept local paths or remote URLs.");
        const bytes = Buffer.from(raw.dataBase64, "base64");
        if (bytes.length > MAX_GRANT_BYTES || hash(bytes) !== raw.sha256) throw new Error("Cowork image grant hash/size verification failed.");
        const attachmentKey = `attachment:${raw.sha256}:${raw.name}`;
        if (field === "attachments" && run.grants.has(attachmentKey)) { selectedIndexes.push(Number(run.grants.get(attachmentKey))); continue; }
        const handle = field === "characterReferences" && typeof raw.handle === "string" ? raw.handle.match(/^novelai-character:([a-z0-9][a-z0-9-]{0,79}):([a-f0-9]{64})$/) : null;
        if (field === "characterReferences") {
          if (!handle?.[1] || handle[2] !== raw.sha256) throw new Error("Cowork character grant requires a matching content-addressed handle.");
          const previous = run.grants.get(`character:${handle[1]}`);
          if (previous && previous !== raw.sha256) throw new Error("A character reference cannot change within a logical Browser run.");
          if (previous) continue;
        }
        if (run.grantBytes + bytes.length > 32 * 1024 * 1024) throw new Error("Cowork current-run image grants exceed the total byte limit.");
        const sharp = (await import("sharp")).default;
        const metadata = await sharp(bytes, { limitInputPixels: 50_000_000, animated: false }).metadata();
        const expected = raw.mime === "image/png" ? "png" : raw.mime === "image/jpeg" ? "jpeg" : "webp";
        if (metadata.format !== expected || !metadata.width || !metadata.height) throw new Error("Cowork image bytes do not match the image grant MIME.");
        const ext = expected === "jpeg" ? "jpg" : expected;
        if (field === "attachments") {
          await fs.mkdir(run.paths.attachments, { recursive: true });
          const localIndex = attachments.length;
          const file = path.join(run.paths.attachments, `${localIndex}-${raw.sha256}.${ext}`);
          await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
          attachments.push({ kind: "image", url: "", path: file, mime: String(raw.mime), name: raw.name, size: bytes.length, image: { width: metadata.width, height: metadata.height, sha256: String(raw.sha256) } });
          selectedIndexes.push(localIndex);
          run.grants.set(attachmentKey, String(localIndex));
        } else {
          const id = handle![1]!;
          aliases[id.replace(/-/g, "")] = id;
          const directory = path.join(run.paths.characters, id);
          await fs.mkdir(directory, { recursive: true });
          await fs.writeFile(path.join(directory, `reference.${ext}`), bytes, { flag: "wx", mode: 0o600 });
          await fs.writeFile(path.join(directory, "profile.json"), JSON.stringify({ schemaVersion: 1, id, displayName: id, source: "central-current-run-grant", aliases: [id], referencePolicy: "required", novelai: { tag: id, positiveAnchors: [], negativeAnchors: [] }, reference: { file: `reference.${ext}` } }), { flag: "wx", mode: 0o600 });
          run.grants.set(`character:${id}`, String(raw.sha256));
        }
        run.grantBytes += bytes.length;
      }
      if (field === "attachments" && command.args.action === "upload_attachment") {
        // The transport may send just the centrally selected image, not all current attachments.
        const selected = list.length === 1 ? 0 : typeof command.args.attachment === "number" ? command.args.attachment : list.findIndex((item) => record(item) && item.name === command.args.attachment);
        if (!Number.isInteger(selected) || selected < 0 || selectedIndexes[selected] === undefined) throw new Error("Cowork attachment selection does not match the current image grants.");
        command.args.attachment = selectedIndexes[selected];
      } else if (field === "characterReferences") {
        await fs.mkdir(run.paths.characters, { recursive: true });
        await fs.writeFile(path.join(run.paths.characters, "index.json"), JSON.stringify({ schemaVersion: 1, aliases }), { mode: 0o600 });
      }
    }
    if (command.args.action === "upload_character_reference") {
      const list = context.characterReferences;
      if (!Array.isArray(list) || !list.some((entry) => record(entry) && entry.handle === command.args.asset)) throw new Error("The requested character handle is not a current-run grant.");
    }
  }

  private evidenceDelta(run: WorkerRun, previous: Map<string, string>): CoworkWorkerResult["toolEvidence"] {
    return [...(run.context.execution?.toolEvidence ?? [])].filter(([key, value]) => previous.get(key) !== canonical(value)).map(([key, value]) => ({ key, value }));
  }

  private async artifacts(run: WorkerRun, ...values: unknown[]): Promise<CoworkWorkerResult["artifacts"]> {
    const candidates = new Set<string>();
    const scan = (value: unknown, depth = 0, pathList = false): void => {
      if (depth > 16) return;
      if (pathList && typeof value === "string" && path.isAbsolute(value)) { candidates.add(path.resolve(value)); return; }
      if (Array.isArray(value)) { for (const child of value.slice(0, 200)) scan(child, depth + 1, pathList); }
      else if (record(value)) for (const [key, child] of Object.entries(value)) {
        if (["path", "filePath", "remotePath", "downloadPath", "downloadedPath"].includes(key) && typeof child === "string" && path.isAbsolute(child)) candidates.add(path.resolve(child));
        else scan(child, depth + 1, ["paths", "files", "artifacts"].includes(key));
      }
    };
    for (const value of values) scan(value);
    const results: CoworkWorkerResult["artifacts"] = [];
    for (const candidate of [...candidates].slice(0, 32)) {
      if (![run.paths.downloads, run.paths.screenshots].some((root) => within(candidate, root))) continue;
      const file = await fs.realpath(candidate);
      const realState = await fs.realpath(this.stateDir);
      const realRun = await fs.realpath(run.paths.root);
      const roots = await Promise.all([run.paths.downloads, run.paths.screenshots].map((root) => realPathWithMissing(root)));
      if (!within(realRun, realState) || !roots.every((root) => within(root, realRun)) || !roots.some((root) => within(file, root))) throw new Error("Cowork artifact escaped its controlled directory through a symbolic link.");
      const info = await fs.stat(file);
      if (!info.isFile() || info.size > MAX_GRANT_BYTES) throw new Error("Cowork artifact is not a bounded regular file.");
      const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".pdf": "application/pdf" } as Record<string, string>)[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      results.push({ remotePath: file, name: path.basename(file), mime, size: info.size, sha256: hash(await fs.readFile(file)) });
    }
    return results;
  }
}

/** Injectable JSONL transport; commands run concurrently across isolated run contexts. */
export function serveCoworkWorkerHost(input: Readable, output: Writable, host = new CoworkWorkerHost()): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const tasks = new Set<Promise<void>>();
    const send = (message: unknown): void => { output.write(`${JSON.stringify(message)}\n`); };
    const dispatch = (line: string): void => {
      let message: unknown;
      try { message = JSON.parse(line); } catch { send({ id: "", error: "Invalid Cowork JSONL message." }); return; }
      if (!record(message)) return;
      if (text(message.cancel)) { host.cancel(message.cancel); return; }
      if (text(message.cleanup)) { const task = host.cleanup(message.cleanup).catch(() => undefined); tasks.add(task); void task.finally(() => tasks.delete(task)); return; }
      if (!text(message.id) || !record(message.command) || message.command.operationId !== message.id) { send({ id: message.id ?? "", error: "Cowork message ID must match command.operationId." }); return; }
      const id = message.id;
      const task = host.execute(message.command as unknown as CoworkCommand, (progress) => send({ id, progress }))
        .then((result) => send({ id, result }), (error: unknown) => {
          const failure = error as CoworkWorkerFailure;
          send({ id, error: { message: error instanceof Error ? error.message : String(error), ...(failure?.unknown ? { unknown: true } : {}), ...(failure?.toolEvidence ? { toolEvidence: failure.toolEvidence } : {}), ...(failure?.artifacts ? { artifacts: failure.artifacts } : {}) } });
        });
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    };
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) { input.destroy(new Error("Cowork JSONL input exceeds its byte limit.")); return; }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) dispatch(line);
      }
    });
    input.once("error", (error) => { void host.close().finally(() => reject(error)); });
    input.once("end", () => { void (async () => { if (buffer.trim()) dispatch(buffer); await host.close(); await Promise.allSettled(tasks); resolve(); })().catch(reject); });
  });
}

if (require.main === module) {
  // Keep stdout exclusively JSONL, including diagnostics from lazily imported dependencies.
  const diagnostics = new Console(process.stderr);
  console.log = diagnostics.log.bind(diagnostics);
  console.info = diagnostics.info.bind(diagnostics);
  console.debug = diagnostics.debug.bind(diagnostics);
  void serveCoworkWorkerHost(process.stdin, process.stdout).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
