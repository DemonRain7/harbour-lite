import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { loadEnv } from "../../src/config/env";
import { createRuntime, type Runtime } from "../../src/runtime";
import type { SessionRef } from "../../src/types";

test("real runtime boundary combines final delivery, durable original input, and isolates children", async () => {
  const project = process.cwd(), root = await fs.mkdtemp(path.join(os.tmpdir(), "harbour-input-runtime-"));
  let runtime: Runtime | undefined;
  try {
    await fs.mkdir(path.join(root, "agents"));
    await fs.writeFile(path.join(root, "agents", "main-fixture.md"), "---\nname: main-fixture\nmodel: mock/fixture\ntaskType: test\ntools: []\ncontextBudget: 32000\nmaxSteps: 8\npermissionMode: dontAsk\n---\nSynthetic test only.");
    process.chdir(root);
    const env = loadEnv(); env.AGENTS_DIR = path.join(root, "agents"); env.SESSION_DIR = path.join(root, "sessions");
    env.SESSIONS_ENABLED = true; env.MOCK_LLM = true; env.ENABLE_CODEX_HARNESS = false; env.DEFAULT_AGENT = "main-fixture";
    runtime = await createRuntime(env, pino({ level: "silent" }), { forceMock: true });
    const session = runtime.sessions!.create("web:input-runtime", { channel: "web", agentName: "main-fixture" });
    const ref: SessionRef = { id: session.id, key: session.key, channel: "web", actor: { platform: "web", role: "owner", id: "web-owner" }, runId: "fixture-root" };
    let calls = 0; let followId = "";
    runtime.router.complete = async req => {
      if (req.agentName?.startsWith("worker:")) {
        assert.equal(req.toolContext?.execution?.runInputs, undefined, "child cannot consume parent's inbox");
        assert.ok(req.toolContext?.execution?.inputBoundary, "child can observe a safe yield request");
        return { message: { role: "assistant", content: "child done" } };
      }
      calls++;
      if (calls === 1) {
        const ctx = req.toolContext!;
        await ctx.runEphemeralSubagent!(ctx.agent, "Read synthetic fixture", [], req.signal, ctx.execution);
        followId = runtime!.intake.enqueue({ id: "follow", agentName: "main-fixture", input: "KEEP_BLUE_SENTINEL", sessionRef: ref }, "web", { immediate: true }).id;
        await runtime!.intake.pump();
        return { message: { role: "assistant", content: "intermediate, not final delivery" } };
      }
      assert.equal(calls, 2);
      assert.match(req.messages.at(-1)!.content, /KEEP_BLUE_SENTINEL/);
      const disk = JSON.parse(await fs.readFile(path.join(env.SESSION_DIR, `${session.id}.json`), "utf8"));
      assert.match(disk.checkpoint.originalInput, /ORIGINAL_SENTINEL[\s\S]*KEEP_BLUE_SENTINEL/);
      return { message: { role: "assistant", content: "ORIGINAL_SENTINEL + KEEP_BLUE_SENTINEL delivered" } };
    };
    const result = await runtime.runAgent("main-fixture", "ORIGINAL_SENTINEL", undefined, undefined, ref);
    assert.match(result, /KEEP_BLUE_SENTINEL delivered/);
    assert.equal(session.messages.filter(m => m.role === "assistant").length, 1);
    assert.equal(session.messages.filter(m => m.role === "user").length, 1);
    assert.equal(session.messages[0]!.content.split("KEEP_BLUE_SENTINEL").length, 2);
    assert.equal(runtime.intake.list(session.id).find(r => r.id === followId)!.state, "completed");
    assert.equal(runtime.inputs.isBusy(session.id), false);
  } finally {
    runtime?.intake.close(); runtime?.goals.stop(); await runtime?.sessions?.flush(); await runtime?.metrics.close(); process.chdir(project);
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith("harbour-input-runtime-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
});
