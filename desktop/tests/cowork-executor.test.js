const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { WebSocketServer } = require("ws");
const { RemoteCompanionBridge } = require("../companion/remote-bridge");
const { CoworkExecutor, commandHash, safeEnvironment, MAX_READ_BYTES, MAX_OUTPUT_BYTES } = require("../companion/cowork-executor");

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-cowork-test-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(workspace);
  const events = [];
  const executor = new CoworkExecutor({ dataDir, cwd: workspace, deviceId: "test-device", send: (event) => events.push(event), ...options });
  t.after(async () => {
    executor.stop();
    await Promise.allSettled([...executor.inflight.values()].map((state) => state.promise));
    // Only this test's freshly-created, verified temporary tree is removed.
    assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, workspace, dataDir, executor, events };
}

function command(tool, args, overrides = {}) {
  return { operationId: randomUUID(), runId: "test-run", agent: "test-owner", tool, args, mode: "dontAsk", deadline: Date.now() + 15_000, ...overrides };
}

function nodeCommand(script) {
  if (process.platform === "win32") return `& '${process.execPath.replace(/'/g, "''")}' -e '${script.replace(/'/g, "''")}'`;
  const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
  return `${quote(process.execPath)} -e ${quote(script)}`;
}

async function waitFor(check, timeout = 8000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("test wait timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("real files, bounded reads/listing and durable duplicate protection", async (t) => {
  const { executor, workspace, dataDir, events } = fixture(t);
  const write = command("write_file", { path: "nested/note.txt", content: "一次写入\n", append: true });
  const [first, duplicate] = await Promise.all([executor.execute(write), executor.execute(write)]);
  assert.equal(first.status, "completed");
  assert.deepEqual(duplicate, first);
  assert.equal(fs.readFileSync(path.join(workspace, "nested/note.txt"), "utf8"), "一次写入\n");
  assert.equal(events.filter((event) => event.__harbour === "cowork:progress").length, 1);
  assert.equal((await executor.execute({ ...write, args: { ...write.args, content: "different" } })).status, "failed");
  const restarted = new CoworkExecutor({ dataDir, cwd: workspace, deviceId: "test-device" });
  t.after(() => restarted.stop());
  assert.deepEqual(await restarted.execute(write), first);
  assert.equal(fs.readFileSync(path.join(workspace, "nested/note.txt"), "utf8"), "一次写入\n");
  const read = await executor.execute(command("read_file", { path: "nested/note.txt" }));
  assert.equal(read.result.content, "一次写入\n");
  fs.writeFileSync(path.join(workspace, "large.txt"), Buffer.alloc(MAX_READ_BYTES + 50, 120));
  const large = await executor.execute(command("read_file", { path: "large.txt" }));
  assert.equal(large.result.content.length, MAX_READ_BYTES);
  assert.equal(large.result.truncated, true);
  const listed = await executor.execute(command("list_files", { path: ".", limit: 1 }));
  assert.equal(listed.result.entries.length, 1);
  assert.equal(listed.result.truncated, true);
});

test("a running journal from a previous process becomes unknown and never replays", async (t) => {
  const { executor, workspace, dataDir } = fixture(t);
  const task = command("write_file", { path: "must-not-exist.txt", content: "not executed" });
  executor.persist({ version: 1, operationId: task.operationId, runId: task.runId, commandHash: commandHash(task), status: "running" });
  const restarted = new CoworkExecutor({ dataDir, cwd: workspace, deviceId: "test-device" });
  t.after(() => restarted.stop());
  assert.equal(restarted.query(task.operationId).status, "unknown");
  assert.equal((await restarted.execute(task)).status, "unknown");
  assert.equal(fs.existsSync(path.join(workspace, "must-not-exist.txt")), false);
  assert.equal(JSON.parse(fs.readFileSync(restarted.journalPath(task.operationId), "utf8")).status, "unknown");
  assert.equal(restarted.query("missing").status, "not_found");
});

test("plan and readOnly use envelope authority, with fail-closed empty permissions", async (t) => {
  const { executor, workspace } = fixture(t);
  fs.writeFileSync(path.join(workspace, "sample.txt"), "readable");
  for (const tool of ["write_file", "bash", "export_file"]) {
    const result = await executor.execute(command(tool, { path: "sample.txt", content: "changed", command: "echo safe", mode: "dontAsk", permissions: {} }, { mode: "plan" }));
    assert.equal(result.status, "failed");
    assert.match(result.error, /plan\/readOnly/);
  }
  assert.equal((await executor.execute(command("read_file", { path: "sample.txt" }, { mode: "plan" }))).status, "completed");
  assert.equal((await executor.execute(command("write_file", { path: "sample.txt", content: "no" }, { mode: "unrecognized" }))).status, "failed");
  assert.equal((await executor.execute(command("write_file", { path: "sample.txt", content: "no" }, { permissions: { readOnly: true } }))).status, "failed");
  for (const permissions of [{ tools: [] }, { readPaths: [] }, { tools: ["write_file"] }]) {
    assert.equal((await executor.execute(command("read_file", { path: "sample.txt" }, { permissions }))).status, "failed");
  }
  const restrictedShell = await executor.execute(command("bash", { command: "echo safe" }, { permissions: { readPaths: ["."] } }));
  assert.match(restrictedShell.error, /路径沙箱/);
  assert.equal(fs.readFileSync(path.join(workspace, "sample.txt"), "utf8"), "readable");
});

test("path restrictions reject traversal and symlink escape, allow scoped files", async (t) => {
  const { executor, root, workspace } = fixture(t);
  const allowed = path.join(workspace, "allowed");
  const outside = path.join(root, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "private.txt"), "outside fixture");
  fs.symlinkSync(outside, path.join(allowed, "escape"), process.platform === "win32" ? "junction" : "dir");
  const permissions = { readPaths: ["allowed/**"], writePaths: ["allowed/**"] };
  assert.equal((await executor.execute(command("write_file", { path: "allowed/ok.txt", content: "ok" }, { permissions }))).status, "completed");
  for (const file of ["../outside/private.txt", "allowed/escape/private.txt"]) {
    assert.equal((await executor.execute(command("read_file", { path: file }, { permissions }))).status, "failed");
    assert.equal((await executor.execute(command("write_file", { path: file, content: "no" }, { permissions }))).status, "failed");
  }
  assert.equal((await executor.execute(command("write_file", { path: "allowed/escape/new/file.txt", content: "no" }, { permissions }))).status, "failed");
  assert.equal(fs.existsSync(path.join(outside, "new")), false);
  assert.equal(fs.readFileSync(path.join(outside, "private.txt"), "utf8"), "outside fixture");
});

test("relative permission roots follow trusted session cwd, never model args.cwd", async (t) => {
  const { executor, root, workspace } = fixture(t);
  const selected = path.join(root, "selected-workspace");
  fs.mkdirSync(path.join(selected, "allowed"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "allowed"));
  fs.writeFileSync(path.join(selected, "allowed", "note.txt"), "selected root");
  fs.writeFileSync(path.join(workspace, "allowed", "note.txt"), "old root");
  const permissions = { readPaths: ["allowed/**"] };
  const accepted = await executor.execute(command("read_file", { path: "allowed/note.txt", cwd: workspace }, { cwd: selected, permissions }));
  assert.equal(accepted.status, "completed");
  assert.equal(accepted.result.content, "selected root");
  const denied = await executor.execute(command("read_file", { path: path.join(workspace, "allowed", "note.txt") }, { cwd: selected, permissions }));
  assert.equal(denied.status, "failed", "the old startup root must not remain implicitly authorized");
});

test("safe real shell has bounded output and strips credential environment", async (t) => {
  const { executor } = fixture(t);
  assert.deepEqual(safeEnvironment({ PATH: "path", HOME: "home", API_KEY: "redacted", tokenValue: "redacted", PASSWORD: "redacted", NODE_OPTIONS: "redacted" }), { PATH: "path", HOME: "home" });
  const prior = process.env.COWORK_TEST_SECRET;
  process.env.COWORK_TEST_SECRET = "do-not-inherit";
  t.after(() => { if (prior === undefined) delete process.env.COWORK_TEST_SECRET; else process.env.COWORK_TEST_SECRET = prior; });
  const result = await executor.execute(command("bash", { command: nodeCommand("process.stdout.write(String(process.env.COWORK_TEST_SECRET)); process.stdout.write('x'.repeat(100000));") }));
  assert.equal(result.status, "completed", result.error);
  assert.equal(result.result.exitCode, 0);
  assert.ok(result.result.stdout.startsWith("undefined"));
  assert.equal(Buffer.byteLength(result.result.stdout), MAX_OUTPUT_BYTES);
  assert.equal(result.result.outputTruncated, true);
});

test("cancel stops a real short-lived process tree; late execute remains cancelled", async (t) => {
  const { executor, workspace } = fixture(t);
  const marker = path.join(workspace, "started.json");
  const task = command("bash", { command: nodeCommand(`const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { windowsHide: true, stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ parent: process.pid, child: c.pid })); setTimeout(()=>{},30000);`) });
  const pending = executor.execute(task);
  await waitFor(() => fs.existsSync(marker));
  assert.equal(executor.query(task.operationId).status, "running");
  const pids = JSON.parse(fs.readFileSync(marker, "utf8"));
  const cancelled = await executor.cancel(task.operationId);
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(await pending, cancelled);
  for (const pid of Object.values(pids)) {
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  }
  const late = command("write_file", { path: "late.txt", content: "no" });
  assert.equal((await executor.cancel(late.operationId)).status, "cancelled");
  assert.equal((await executor.execute(late)).status, "cancelled");
  assert.equal(fs.existsSync(path.join(workspace, "late.txt")), false);
});

test("deadline and per-shell timeout terminate execution without replay", async (t) => {
  const { executor } = fixture(t);
  const expired = command("bash", { command: "echo safe" }, { deadline: Date.now() - 1 });
  assert.equal((await executor.execute(expired)).status, "failed");
  const result = await executor.execute(command("bash", { command: nodeCommand("setTimeout(()=>{},30000)"), timeout_ms: 100 }));
  assert.equal(result.status, "failed");
  assert.match(result.error, /超时/);
});

test("export uses existing backend authentication and returns genuine central attachment", async (t) => {
  let received;
  const { executor, workspace } = fixture(t, { baseUrl: "https://harbour.example/prefix", token: "test-secret", fetch: async (url, options) => {
    received = { url, options };
    return { ok: true, json: async () => ({ attachment: { name: "report.txt", mime: "text/plain", kind: "file", size: 7, path: "assets/uploads/inbound/server.txt", url: "/uploads/inbound/server.txt" } }) };
  } });
  fs.writeFileSync(path.join(workspace, "report.txt"), "content");
  const exported = await executor.execute(command("export_file", { path: "report.txt", token: "model-cannot-override", url: "https://untrusted.example" }));
  assert.equal(exported.status, "completed");
  assert.equal(received.url, "https://harbour.example/prefix/api/upload");
  assert.equal(received.options.headers.Authorization, "Bearer test-secret");
  assert.equal(received.options.redirect, "error");
  assert.equal(Buffer.from(JSON.parse(received.options.body).dataBase64, "base64").toString(), "content");
  assert.equal(exported.result.remotePath, path.join(workspace, "report.txt"));
  assert.equal(exported.result.path, "assets/uploads/inbound/server.txt");
  assert.equal(exported.result.url, "/uploads/inbound/server.txt");
});

test("browser support is explicit and never falls back when this device lacks a host", async (t) => {
  const { executor } = fixture(t);
  assert.deepEqual(executor.hello().tools, ["list_files", "read_file", "write_file", "bash", "export_file"]);
  const result = await executor.execute(command("opencli_browser", { action: "snapshot" }));
  assert.equal(result.status, "failed");
  assert.match(result.error, /不会回退/);
});

test("ambiguous uploads are journalled unknown and a duplicate never uploads again", async (t) => {
  let attempts = 0;
  const { executor, workspace } = fixture(t, { baseUrl: "https://harbour.example", fetch: async () => { attempts++; throw new Error("connection lost after send"); } });
  fs.writeFileSync(path.join(workspace, "report.txt"), "report");
  const task = command("export_file", { path: "report.txt" });
  assert.equal((await executor.execute(task)).status, "unknown");
  assert.equal((await executor.execute(task)).status, "unknown");
  assert.equal(attempts, 1);
});

test("journal corruption disables execution rather than dropping deduplication history", async (t) => {
  const { executor, dataDir, workspace } = fixture(t);
  fs.writeFileSync(executor.journalPath("broken-operation"), "not json");
  assert.throws(() => new CoworkExecutor({ dataDir, cwd: workspace, deviceId: "test-device" }), /journal 损坏/);
});

test("persistent JSONL browser host is reused and receives cancellation and run cleanup", async (t) => {
  const { executor, workspace } = fixture(t);
  const hostRoot = path.join(workspace, "fake-host");
  const hostFile = path.join(hostRoot, "dist", "cowork", "workerHost.js");
  fs.mkdirSync(path.dirname(hostFile), { recursive: true });
  fs.writeFileSync(hostFile, `const rl = require('node:readline').createInterface({input:process.stdin}); let count=0; const running=new Set(); rl.on('line', line => { const v=JSON.parse(line); if(v.cancel) { if(running.delete(v.cancel)) process.stdout.write(JSON.stringify({id:v.cancel,error:'cancelled'})+'\\n'); } else if(v.cleanup) require('node:fs').writeFileSync(${JSON.stringify(path.join(hostRoot, "cleaned.txt"))},v.cleanup); else { count++; if(v.command.args.failUnknown) process.stdout.write(JSON.stringify({id:v.id,error:{message:'submission uncertain',unknown:true,toolEvidence:[{key:'opencli_browser:novelai:test',value:{submitted:true}}],artifacts:[]}})+'\\n'); else if(v.command.args.wait) running.add(v.id); else process.stdout.write(JSON.stringify({id:v.id,result:{count,mode:v.command.mode}})+'\\n'); } });`);
  executor.backendRoot = hostRoot;
  assert.ok(executor.hello().tools.includes("opencli_browser"));
  const first = await executor.execute(command("opencli_browser", { action: "snapshot" }, { mode: "plan" }));
  const second = await executor.execute(command("opencli_adapter", { action: "match" }));
  assert.equal(first.result.mode, "plan");
  assert.equal(second.result.count, 2);
  const uncertain = await executor.execute(command("opencli_browser", { failUnknown: true }));
  assert.equal(uncertain.status, "unknown");
  assert.equal(uncertain.result.toolEvidence[0].value.submitted, true);
  const grant = { name: "fixture.png", mime: "image/png", sha256: "0".repeat(64), dataBase64: Buffer.alloc(2 * 1024 * 1024, 1).toString("base64") };
  const largerImage = await executor.execute(command("opencli_browser", { action: "upload_attachment" }, { context: { attachments: [grant] } }));
  assert.equal(largerImage.status, "completed", "bounded current image grants may exceed the normal 2 MB tool limit");
  const smuggled = await executor.execute(command("bash", { command: "echo safe" }, { context: { attachments: [grant] } }));
  assert.equal(smuggled.status, "failed", "large image grants cannot be smuggled into unrelated shell commands");
  const task = command("opencli_browser", { wait: true });
  const pending = executor.execute(task);
  await waitFor(() => executor.hostPending.has(task.operationId));
  assert.equal((await executor.cancel(task.operationId)).status, "cancelled");
  await pending;
  await executor.cleanup("test-run");
  await waitFor(() => fs.existsSync(path.join(hostRoot, "cleaned.txt")));
  assert.equal(fs.readFileSync(path.join(hostRoot, "cleaned.txt"), "utf8"), "test-run");
});

test("one authenticated WS carries companion and cowork hello, execution and reconnect queries", async (t) => {
  const { root, workspace } = fixture(t);
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const messages = [];
  let socket;
  wss.on("connection", (connection, request) => {
    assert.equal(new URL(request.url, "http://localhost").searchParams.get("token"), "existing-token");
    socket = connection;
    connection.on("message", (data) => messages.push(JSON.parse(String(data))));
  });
  const dataDir = path.join(root, "bridge-data");
  const bridge = new RemoteCompanionBridge({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: "existing-token", dataDir });
  const executor = new CoworkExecutor({ dataDir, cwd: workspace, deviceId: bridge.clientId });
  bridge.setCoworkExecutor(executor);
  t.after(async () => {
    bridge.stop();
    executor.stop();
    for (const connection of wss.clients) connection.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  bridge.start();
  await waitFor(() => messages.some((event) => event.__harbour === "cowork:hello"));
  assert.ok(messages.some((event) => event.__harbour === "desktop:hello"));
  assert.equal(messages.find((event) => event.__harbour === "cowork:hello").deviceId, bridge.clientId);
  const task = command("write_file", { path: "via-ws.txt", content: "once", append: true });
  socket.send(JSON.stringify({ __harbour: "cowork:execute", command: task }));
  await waitFor(() => messages.some((event) => event.__harbour === "cowork:result" && event.operationId === task.operationId));
  assert.equal(fs.readFileSync(path.join(workspace, "via-ws.txt"), "utf8"), "once");
  socket.terminate();
  await waitFor(() => messages.filter((event) => event.__harbour === "cowork:hello").length === 2);
  socket.send(JSON.stringify({ __harbour: "cowork:query", operationId: task.operationId }));
  await waitFor(() => messages.filter((event) => event.__harbour === "cowork:result" && event.operationId === task.operationId).length === 2);
  assert.equal(messages.filter((event) => event.__harbour === "cowork:result").at(-1).status, "completed");
  assert.equal(new RemoteCompanionBridge({ baseUrl: "http://localhost", dataDir }).clientId, bridge.clientId);
});
