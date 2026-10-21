// The desktop is a tool worker, never a model host. All authority (mode, permissions and
// run identity) comes from the already-authenticated backend envelope, not tool arguments.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { currentCommandShell, inspectCommandShell, shellLaunch } = require("./command-shell");

const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_EXPORT_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_COMMAND_BYTES = 48 * 1024 * 1024;
const MAX_DURATION_MS = 10 * 60 * 1000;
const LOCAL_TOOLS = ["list_files", "read_file", "write_file", "bash", "export_file"];
const BROWSER_TOOLS = ["opencli_browser", "opencli_adapter"];
const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function commandHash(command) {
  const { operationId: _id, deadline: _deadline, ...semantic } = command;
  return createHash("sha256").update(JSON.stringify(canonical(semantic))).digest("hex");
}

function checkCommandSize(command, serialized) {
  if (Buffer.byteLength(serialized) > MAX_COMMAND_BYTES) throw new Error("Cowork command 超过 48 MB 传输上限");
  const context = command?.context;
  const grants = [context?.attachments, context?.characterReferences].flatMap((value) => Array.isArray(value) ? value : value === undefined ? [] : [value]);
  if (grants.length) {
    if (command.tool !== "opencli_browser" || !["upload_attachment", "upload_character_reference"].includes(command.args?.action) || grants.length > 10) throw new Error("Cowork 图片 grant 只能用于当前图片上传动作");
    let total = 0;
    for (const grant of grants) {
      if (!grant || typeof grant.dataBase64 !== "string" || grant.dataBase64.length > Math.ceil(MAX_EXPORT_BYTES / 3) * 4
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(grant.dataBase64)) throw new Error("Cowork 图片 grant base64 无效或超过 16 MB");
      const bytes = Buffer.byteLength(grant.dataBase64, "base64");
      if (!bytes || bytes > MAX_EXPORT_BYTES) throw new Error("Cowork 图片 grant 必须是 1–16 MB");
      total += bytes;
      if (total > 32 * 1024 * 1024) throw new Error("Cowork 图片 grant 总计超过 32 MB");
    }
  }
  const slim = { ...command, ...(context ? { context: { ...context,
    ...(context.attachments ? { attachments: context.attachments.map?.((grant) => ({ ...grant, dataBase64: "" })) ?? context.attachments } : {}),
    ...(context.characterReferences ? { characterReferences: context.characterReferences.map?.((grant) => ({ ...grant, dataBase64: "" })) ?? context.characterReferences } : {}),
  } } : {}) };
  if (Buffer.byteLength(JSON.stringify(slim)) > 2 * 1024 * 1024) throw new Error("Cowork 非图片 command 数据超过 2 MB");
}

function safeEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined
    && !/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION/i.test(key)
    && !/^(?:NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|DISCORD_.*|QQBOT_.*|OWNER_QQ_OPENIDS|WEB_PORT)$/i.test(key)));
}

function boundedFailureEvidence(error) {
  if (!error.toolEvidence && !error.artifacts) return undefined;
  const result = { toolEvidence: error.toolEvidence || [], artifacts: error.artifacts || [] };
  return Buffer.byteLength(JSON.stringify(result)) <= MAX_RESULT_BYTES ? result : undefined;
}

function realPathWithMissing(target) {
  let current = path.resolve(target);
  const suffix = [];
  for (;;) {
    try { return path.resolve(fs.realpathSync.native(current), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      // A dangling symlink is not a missing ordinary directory.
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("权限拒绝：路径包含失效符号链接"); }
      catch (entryError) { if (entryError.code !== "ENOENT") throw entryError; }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function isWithin(target, root) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function killProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // No string-built shell command; taskkill /T kills grandchildren before the shell.
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
    try { child.kill(); } catch { /* already gone */ }
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  }
}

function workerLaunch(backendRoot) {
  if (!backendRoot) return null;
  const compiled = path.join(backendRoot, "dist", "cowork", "workerHost.js");
  const source = path.join(backendRoot, "src", "cowork", "workerHost.ts");
  const tsx = path.join(backendRoot, "node_modules", "tsx", "dist", "cli.mjs");
  // Prefer the source checkout so a stale build cannot silently change the protocol.
  if (fs.existsSync(source) && fs.existsSync(tsx)) return [tsx, source];
  if (fs.existsSync(compiled)) return [compiled];
  return null;
}

async function readBounded(file, maxBytes) {
  const handle = await fs.promises.open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("只能读取普通文件");
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes) + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    return { data: buffer.subarray(0, Math.min(total, maxBytes)), size: info.size, truncated: total > maxBytes || info.size > maxBytes };
  } finally { await handle.close(); }
}

function mimeFor(file) {
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".webm": "video/webm" })[path.extname(file).toLowerCase()] || "application/octet-stream";
}

class CoworkExecutor {
  constructor({ dataDir, deviceId, label, backendRoot, cwd, baseUrl, token = "", send, fetch: fetchImpl = globalThis.fetch, logger = console }) {
    if (!dataDir || !deviceId) throw new Error("Cowork 需要持久 dataDir 和 deviceId");
    this.deviceId = deviceId;
    this.label = String(label || os.hostname()).slice(0, 120);
    this.backendRoot = backendRoot ? path.resolve(backendRoot) : null;
    this.cwd = fs.realpathSync.native(path.resolve(cwd || this.backendRoot || os.homedir()));
    this.baseUrl = baseUrl;
    this.token = token;
    this.send = send || (() => false);
    this.fetch = fetchImpl;
    this.logger = logger;
    this.journalDir = path.join(dataDir, "cowork-operations");
    this.operations = new Map();
    this.inflight = new Map();
    this.hostPending = new Map();
    this.host = null;
    this.closed = false;
    fs.mkdirSync(this.journalDir, { recursive: true, mode: 0o700 });
    this.loadJournal();
    // At most one bounded version probe per executable. Never blocks tool dispatch.
    void inspectCommandShell().then(() => { if (!this.closed) this.send(this.hello()); }).catch(() => {});
  }

  loadJournal() {
    for (const name of fs.readdirSync(this.journalDir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = path.join(this.journalDir, name);
      // A damaged journal must never be treated as permission to replay side effects.
      if (fs.statSync(file).size > MAX_RESULT_BYTES + 64 * 1024) throw new Error("Cowork operation journal 超出上限，需人工检查");
      let record;
      try { record = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch { throw new Error("Cowork operation journal 损坏，已停止执行以避免重复操作"); }
      if (!record?.operationId || this.journalPath(record.operationId) !== file
        || !["running", "completed", "failed", "cancelled", "unknown"].includes(record.status)) throw new Error("Cowork operation journal 无效，已停止执行");
      if (record.status === "running") {
        record = { ...record, status: "unknown", error: "桌面进程在操作完成前退出；执行结果未知，禁止自动重跑", updatedAt: Date.now() };
        this.persist(record);
      }
      this.operations.set(record.operationId, record);
    }
  }

  journalPath(operationId) {
    return path.join(this.journalDir, `${createHash("sha256").update(String(operationId)).digest("hex")}.json`);
  }

  persist(record) {
    const target = this.journalPath(record.operationId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(handle, JSON.stringify(record)); fs.fsyncSync(handle); }
    finally { fs.closeSync(handle); }
    fs.renameSync(temporary, target);
    this.operations.set(record.operationId, record);
  }

  hello() {
    return { __harbour: "cowork:hello", deviceId: this.deviceId, label: this.label, platform: process.platform, arch: process.arch,
      hostname: os.hostname(), tools: [...LOCAL_TOOLS, ...(workerLaunch(this.backendRoot) ? BROWSER_TOOLS : [])], cwd: this.cwd,
      environment: { osRelease: os.release(), nodeVersion: process.versions.node, shell: currentCommandShell() } };
  }

  response(record) {
    return { __harbour: "cowork:result", operationId: record.operationId, status: record.status,
      ...(record.result !== undefined ? { result: record.result } : {}), ...(record.error ? { error: record.error } : {}) };
  }

  query(operationId) {
    return this.response(this.operations.get(operationId) || { operationId, status: "not_found" });
  }

  progress(operationId, message) {
    this.send({ __harbour: "cowork:progress", operationId, message: String(message).slice(0, 2000) });
  }

  async handleEnvelope(event) {
    if (!event || typeof event.__harbour !== "string" || !event.__harbour.startsWith("cowork:")) return false;
    try {
      if (event.__harbour === "cowork:execute") this.send(await this.execute(event.command));
      else if (event.__harbour === "cowork:query") this.send(this.query(String(event.operationId || "")));
      else if (event.__harbour === "cowork:cancel") this.send(await this.cancel(String(event.operationId || "")));
      else if (event.__harbour === "cowork:cleanup") await this.cleanup(String(event.runId || ""));
    } catch (error) {
      this.logger.warn?.(`[harbour-desktop] Cowork: ${error.message}`);
      this.send(this.response({ operationId: String(event.command?.operationId || event.operationId || ""), status: "failed", error: error.message }));
    }
    return true;
  }

  execute(input) {
    let command;
    try {
      const serialized = JSON.stringify(input);
      if (!serialized || Buffer.byteLength(serialized) > MAX_COMMAND_BYTES) throw new Error("Cowork command 过大或缺失");
      command = JSON.parse(serialized);
      checkCommandSize(command, serialized);
      if (!command || typeof command.operationId !== "string" || !command.operationId || command.operationId.length > 200
        || typeof command.runId !== "string" || !command.runId || command.runId.length > 200
        || typeof command.agent !== "string" || !command.agent || !PERMISSION_MODES.includes(command.mode)
        || !Number.isFinite(command.deadline) || !command.args || typeof command.args !== "object" || Array.isArray(command.args)) throw new Error("无效 Cowork command");
      if (this.closed) throw new Error("Cowork executor 已停止");
    } catch (error) { return Promise.resolve(this.response({ operationId: String(input?.operationId || ""), status: "failed", error: error.message })); }

    const hash = commandHash(command);
    const previous = this.operations.get(command.operationId);
    if (previous) {
      if (previous.commandHash && previous.commandHash !== hash) return Promise.resolve(this.response({ operationId: command.operationId, status: "failed", error: "operationId 已绑定不同参数，禁止重用" }));
      return this.inflight.get(command.operationId)?.promise || Promise.resolve(this.response(previous));
    }
    const record = { version: 1, operationId: command.operationId, runId: command.runId, commandHash: hash, status: "running", updatedAt: Date.now() };
    // Durable reservation precedes *every* side effect. Failure to save means no execution.
    try { this.persist(record); }
    catch (error) { return Promise.resolve(this.response({ ...record, status: "failed", error: `无法记录操作：${error.message}` })); }
    const state = { controller: new AbortController(), command, promise: null, timedOut: false };
    this.inflight.set(command.operationId, state);
    const timeout = Math.max(0, Math.min(MAX_DURATION_MS, command.deadline - Date.now()));
    const timer = setTimeout(() => { state.timedOut = true; state.controller.abort(); }, timeout);
    state.promise = Promise.resolve().then(async () => {
      if (timeout <= 0) { state.timedOut = true; throw new Error("Cowork 操作已超过 deadline"); }
      this.progress(command.operationId, `开始执行 ${command.tool}`);
      this.assertTool(command);
      this.throwIfAborted(state);
      return this.runTool(command, state);
    }).then((result) => {
      // A local write that completed while cancel arrived is recorded as completed, never
      // as safely retryable. Cancellable tools themselves throw before reporting success.
      const size = Buffer.byteLength(JSON.stringify(result ?? null));
      if (size > MAX_RESULT_BYTES) throw Object.assign(new Error("工具已执行，但结果超过 journal 上限；禁止自动重跑"), { unknown: true });
      return { ...record, status: "completed", result, updatedAt: Date.now() };
    }).catch((error) => {
      const evidence = boundedFailureEvidence(error);
      return { ...record, status: error.unknown ? "unknown" : state.timedOut ? "failed" : state.controller.signal.aborted ? "cancelled" : "failed",
        ...(evidence ? { result: evidence } : {}),
        error: state.timedOut && !error.unknown ? "Cowork 操作超时，已取消子进程" : String(error.message || error).slice(0, 4000), updatedAt: Date.now() };
    })
      .then((completed) => {
        try { this.persist(completed); }
        catch {
          completed = { ...record, status: "unknown", error: "工具可能已执行，但无法保存完成状态；禁止自动重跑", updatedAt: Date.now() };
          this.operations.set(command.operationId, completed);
        }
        return this.response(completed);
      }).finally(() => { clearTimeout(timer); this.inflight.delete(command.operationId); });
    return state.promise;
  }

  assertTool(command) {
    if (![...LOCAL_TOOLS, ...BROWSER_TOOLS].includes(command.tool)) throw new Error(`不支持的 Cowork 工具：${command.tool}`);
    const permissions = command.permissions;
    if (permissions !== undefined && (!permissions || typeof permissions !== "object" || Array.isArray(permissions))) throw new Error("无效 permissions");
    if (permissions?.readOnly !== undefined && typeof permissions.readOnly !== "boolean") throw new Error("无效 readOnly permission");
    if (permissions?.tools !== undefined && (!Array.isArray(permissions.tools) || !permissions.tools.includes(command.tool))) throw new Error(`权限拒绝：不能执行 ${command.tool}`);
    const readOnly = command.mode === "plan" || permissions?.readOnly === true;
    if (readOnly && !["read_file", "list_files", ...BROWSER_TOOLS].includes(command.tool)) throw new Error(`权限拒绝：plan/readOnly 不能执行 ${command.tool}`);
    if (command.tool === "bash" && (permissions?.readPaths !== undefined || permissions?.writePaths !== undefined)) throw new Error("权限拒绝：bash 没有 OS 路径沙箱，不能在声明路径限制时执行");
  }

  checkedPath(command, kind, requested) {
    if (typeof requested !== "string" || !requested || requested.includes("\0")) throw new Error("需要有效的文件路径");
    const cwd = path.resolve(this.cwd, command.cwd || ".");
    const target = realPathWithMissing(path.resolve(cwd, requested));
    const allow = command.permissions?.[kind === "read" ? "readPaths" : "writePaths"];
    if (allow === undefined) return target;
    if (!Array.isArray(allow) || !allow.every((root) => typeof root === "string" && root.length > 0)) throw new Error("权限路径列表无效");
    // command.cwd is the server-validated session selection. Model args.cwd never changes
    // this permissions base, and may only select a target inside the already-granted roots.
    const roots = allow.map((root) => realPathWithMissing(path.resolve(cwd, root.replace(/[\\/]+\*{1,2}$/, ""))));
    if (!roots.some((root) => isWithin(target, root))) throw new Error(`权限拒绝：不能${kind === "read" ? "读取" : "写入"} ${requested}`);
    return target;
  }

  throwIfAborted(state) {
    if (state.controller.signal.aborted) throw new Error(state.timedOut ? "Cowork 操作超时" : "Cowork 操作已取消");
  }

  async runTool(command, state) {
    const args = command.args;
    if (BROWSER_TOOLS.includes(command.tool)) return this.runBrowser(command, state);
    if (command.tool === "bash") return this.runShell(command, state);
    if (command.tool === "list_files") {
      const directory = this.checkedPath(command, "read", args.path || args.dir || ".");
      const entries = [];
      const limit = Math.max(1, Math.min(500, Number(args.limit) || 200));
      const handle = await fs.promises.opendir(directory);
      let truncated = false;
      try {
        for await (const entry of handle) {
          this.throwIfAborted(state);
          if (entries.length >= limit) { truncated = true; break; }
          entries.push({ name: entry.name, type: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file" });
        }
      } finally { await handle.close().catch(() => {}); }
      return { path: directory, entries, truncated };
    }
    if (command.tool === "write_file") {
      const file = this.checkedPath(command, "write", args.path);
      if (typeof args.content !== "string" || Buffer.byteLength(args.content) > MAX_WRITE_BYTES) throw new Error("write_file content 必须是最多 1 MB 的字符串");
      this.throwIfAborted(state);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      // Recheck newly-created parents before opening; never blindly follow a changed link.
      if (this.checkedPath(command, "write", args.path) !== file) throw new Error("写入路径在执行期间发生变化");
      this.throwIfAborted(state);
      await fs.promises.writeFile(file, args.content, { encoding: "utf8", flag: args.append === true ? "a" : "w" });
      return { path: file, bytes: Buffer.byteLength(args.content), appended: args.append === true };
    }
    const file = this.checkedPath(command, "read", args.path);
    if (command.tool === "read_file") {
      const maxBytes = Math.max(1, Math.min(MAX_READ_BYTES, Number(args.maxBytes || args.max_bytes) || MAX_READ_BYTES));
      const read = await readBounded(file, maxBytes);
      this.throwIfAborted(state);
      return { path: file, content: read.data.toString("utf8"), size: read.size, truncated: read.truncated };
    }
    const read = await readBounded(file, MAX_EXPORT_BYTES);
    if (read.truncated) throw new Error("export_file 文件超过 16 MB 上限");
    this.throwIfAborted(state);
    if (!this.baseUrl || typeof this.fetch !== "function") throw new Error("export_file 没有可用的后端上传连接");
    const mime = mimeFor(file);
    const kind = /^(image|video|audio)\//.exec(mime)?.[1] || "file";
    const base = new URL(this.baseUrl);
    base.pathname = `${base.pathname.replace(/\/+$/, "")}/api/upload`;
    base.search = "";
    base.hash = "";
    let response;
    try {
      response = await this.fetch(base.toString(), { method: "POST", redirect: "error", signal: state.controller.signal,
        headers: { "Content-Type": "application/json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify({ name: path.basename(file), mime, kind, dataBase64: read.data.toString("base64") }) });
    } catch {
      // A network abort after POST cannot establish that the backend did not store it.
      throw Object.assign(new Error("上传连接中断，文件是否已上传未知；禁止自动重跑"), { unknown: true });
    }
    if (!response.ok) throw new Error(`export_file 上传失败（HTTP ${response.status}）`);
    let payload;
    try { payload = await response.json(); }
    catch { throw Object.assign(new Error("上传返回无效响应，执行结果未知；禁止自动重跑"), { unknown: true }); }
    const attachment = payload?.attachment;
    if (!attachment || typeof attachment.url !== "string" || !attachment.url.startsWith("/uploads/")) throw Object.assign(new Error("上传可能成功但缺少有效附件引用，请勿自动重试"), { unknown: true });
    // Only the upload API can supply a central path. A desktop path is never fabricated
    // into a server attachment path or a URL that cannot be opened from another machine.
    return { ...attachment, remotePath: file, url: attachment.url };
  }

  runShell(command, state) {
    const text = command.args.command;
    if (typeof text !== "string" || !text.trim() || text.length > 64 * 1024) throw new Error("bash command 必须是有界非空字符串");
    const cwd = this.checkedPath(command, "read", command.args.cwd || ".");
    if (!fs.statSync(cwd).isDirectory()) throw new Error("bash cwd 不是目录");
    const launch = shellLaunch(text);
    return new Promise((resolve, reject) => {
      this.throwIfAborted(state);
      const child = spawn(launch.executable, launch.args, { cwd, env: safeEnvironment(), windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      state.child = child;
      let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), outputTruncated = false;
      let settled = false;
      const collect = (existing, chunk) => {
        const remaining = Math.max(0, MAX_OUTPUT_BYTES - existing.length);
        if (chunk.length > remaining) outputTruncated = true;
        return remaining ? Buffer.concat([existing, chunk.subarray(0, remaining)]) : existing;
      };
      child.stdout.on("data", (chunk) => { stdout = collect(stdout, chunk); });
      child.stderr.on("data", (chunk) => { stderr = collect(stderr, chunk); });
      const abort = () => killProcessTree(child);
      state.controller.signal.addEventListener("abort", abort, { once: true });
      const requestedTimeout = Number(command.args.timeout_ms || command.args.timeoutMs) || 120_000;
      const timer = setTimeout(() => { state.timedOut = true; state.controller.abort(); }, Math.max(1, Math.min(MAX_DURATION_MS, requestedTimeout)));
      const finish = (error, code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state.controller.signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else if (state.controller.signal.aborted) reject(new Error("bash 已停止并清理进程树"));
        else resolve({ cwd, shell: launch.flavor, exitCode: code, ...(signal ? { signal } : {}), stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), outputTruncated });
      };
      child.once("error", (error) => finish(error));
      child.once("close", (code, signal) => finish(null, code, signal));
    });
  }

  ensureHost() {
    if (this.host) return this.host;
    const launch = workerLaunch(this.backendRoot);
    if (!launch) throw new Error("此桌面没有本地 Harbour Browser tool host；请配置 backendRoot 并安装依赖，不会回退到服务端浏览器");
    const host = spawn(process.execPath, launch, { cwd: this.backendRoot, env: { ...safeEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    this.host = host;
    let buffer = "";
    const failed = (message) => {
      if (this.host !== host) return;
      this.host = null;
      killProcessTree(host);
      for (const pending of this.hostPending.values()) pending.reject(Object.assign(new Error(message), { unknown: true }));
      this.hostPending.clear();
    };
    host.stdout.setEncoding("utf8");
    host.stdout.on("data", (data) => {
      buffer += data;
      if (Buffer.byteLength(buffer) > MAX_RESULT_BYTES * 2) return failed("Browser tool host 输出过大，结果未知，禁止重跑");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { return failed("Browser tool host JSONL 协议损坏，结果未知"); }
        const pending = this.hostPending.get(message.id);
        if (!pending) continue;
        if (message.progress !== undefined) { this.progress(message.id, message.progress); continue; }
        this.hostPending.delete(message.id);
        if (message.error) pending.reject(Object.assign(new Error(typeof message.error === "string" ? message.error : String(message.error.message || "Browser tool host 执行失败")), {
          ...(message.error.unknown === true ? { unknown: true } : {}),
          ...(Array.isArray(message.error.toolEvidence) ? { toolEvidence: message.error.toolEvidence } : {}),
          ...(Array.isArray(message.error.artifacts) ? { artifacts: message.error.artifacts } : {}),
        }));
        else pending.resolve(message.result);
      }
    });
    host.stderr.on("data", () => {}); // Drain boundedly; tool diagnostics must not leak environment credentials.
    host.stdin.on("error", () => failed("Browser tool host 输入流中断，结果未知"));
    host.once("error", (error) => failed(`Browser tool host 无法启动：${error.message}`));
    host.once("exit", () => failed("Browser tool host 意外退出，结果未知，禁止自动重跑"));
    return host;
  }

  runBrowser(command, state) {
    const host = this.ensureHost();
    return new Promise((resolve, reject) => {
      let cancellationTimer;
      const abort = () => {
        try { host.stdin.write(`${JSON.stringify({ cancel: command.operationId })}\n`); } catch { /* fallback below */ }
        // Give the governed tool its cleanup window. If it cannot acknowledge cancellation,
        // kill the host tree and retain unknown, rather than claim an operation did not run.
        cancellationTimer = setTimeout(() => {
          killProcessTree(host);
          this.hostPending.delete(command.operationId);
          reject(Object.assign(new Error("Browser 取消未获确认，执行结果未知"), { unknown: true }));
        }, 3000);
      };
      const done = (callback, value) => { clearTimeout(cancellationTimer); state.controller.signal.removeEventListener("abort", abort); callback(value); };
      this.hostPending.set(command.operationId, { resolve: (value) => done(resolve, value), reject: (error) => done(reject, error) });
      state.controller.signal.addEventListener("abort", abort, { once: true });
      host.stdin.write(`${JSON.stringify({ id: command.operationId, command })}\n`);
      if (state.controller.signal.aborted) abort();
    });
  }

  async cancel(operationId) {
    const current = this.inflight.get(operationId);
    if (current) { current.controller.abort(); return current.promise; }
    if (this.operations.has(operationId)) return this.query(operationId);
    if (!operationId || operationId.length > 200) return this.response({ operationId, status: "not_found" });
    // A late execute after a cancel must remain cancelled, even across reconnect/restart.
    const record = { version: 1, operationId, status: "cancelled", commandHash: null, updatedAt: Date.now(), error: "操作在执行前已取消" };
    this.persist(record);
    return this.response(record);
  }

  async cleanup(runId) {
    if (!runId) return;
    const pending = [...this.inflight.values()].filter((state) => state.command.runId === runId);
    pending.forEach((state) => state.controller.abort());
    await Promise.allSettled(pending.map((state) => state.promise));
    if (this.host) this.host.stdin.write(`${JSON.stringify({ cleanup: runId })}\n`);
  }

  stop() {
    this.closed = true;
    for (const state of this.inflight.values()) state.controller.abort();
    if (this.host) killProcessTree(this.host);
    // Running journal entries intentionally survive abrupt application exit as unknown.
  }
}

module.exports = { CoworkExecutor, commandHash, safeEnvironment, workerLaunch, realPathWithMissing, MAX_READ_BYTES, MAX_OUTPUT_BYTES };
