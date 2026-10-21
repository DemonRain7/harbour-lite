// Real Electron-as-Node → tsx workerHost → OpenCLI in-memory matcher. Never launches Chrome.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { CoworkExecutor } = require("../companion/cowork-executor");

async function main() {
  const root = path.resolve(__dirname, "../..");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "harbour-cowork-host-smoke-"));
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = temp;
  const executor = new CoworkExecutor({ dataDir: temp, backendRoot: root, deviceId: "smoke-host", send() {} });
  try {
    const command = { operationId: randomUUID(), runId: `smoke-${randomUUID()}`, agent: "browser_controller",
      tool: "opencli_adapter", args: { action: "match", target: "https://example.com", task: "read" },
      mode: "plan", deadline: Date.now() + 20_000,
      context: { source: { channel: "web", actor: { role: "owner", platform: "web", id: "smoke-owner" } } } };
    assert.ok(executor.hello().tools.includes("opencli_adapter"));
    const response = await executor.execute(command);
    assert.equal(response.status, "completed", JSON.stringify(response));
    assert.equal(response.result.result.target, "https://example.com");
    assert.deepEqual(response.result.artifacts, []);
    const duplicate = await executor.execute(command);
    assert.deepEqual(duplicate, response);
    await executor.cleanup(command.runId);
    console.log("Cowork real worker host smoke passed (in-memory adapter.match only; no Chrome, no LLM)");
  } finally {
    executor.stop();
    if (previousLocalAppData == null) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
