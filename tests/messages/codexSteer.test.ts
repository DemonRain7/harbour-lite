import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import pino from "pino";
import { CodexAppServerBackend } from "../../src/core/backends/codexAppServer";
import { RunInputLease } from "../../src/core/runInputs";
import type { Agent, CompletionRequest } from "../../src/types";

test("actual App Server transport uses expected turn ID and user input, no new turn", async () => {
  const logger = pino({ level: "silent" }), states: string[] = [], accepted: string[] = [];
  const lease = new RunInputLease("root", "scope", async message => { accepted.push(message.content); }, () => {});
  lease.offer({ id: "follow-up", text: "USER_SUPPLEMENT_SENTINEL", record: async state => { states.push(state); } });
  const agent: Agent = { name: "input-fixture", systemPrompt: "test", taskType: "test", tools: [], permissionMode: "dontAsk", contextBudget: 16000 };
  const backend = new CodexAppServerBackend({ logger, uploadDir: path.resolve("assets/uploads"), startupTimeoutMs: 3000,
    launch: { command: process.execPath, args: [path.resolve("tests/codex-harness/fakeAppServer.mjs"), "user-steer"] } });
  const req: CompletionRequest = { modelRef: "codex-app-server/fake-model", model: "fake-model",
    messages: [{ role: "system", content: "test" }, { role: "user", content: "ORIGINAL_SENTINEL" }], tools: [],
    toolContext: { agent, logger, runState: new Map(), source: { channel: "web", key: "web:test", actor: { platform: "web", role: "owner", id: "fixture" } },
      execution: { runId: "root", runInputs: lease, inputBoundary: lease } } };
  const result = await backend.complete(req); await lease.finish();
  const params = JSON.parse(result.message.content);
  assert.equal(params.expectedTurnId, "fake-turn"); assert.equal(params.threadId, "fake-thread");
  const conversation = JSON.parse(params.input[0].text.slice(params.input[0].text.indexOf('{"format":')));
  assert.deepEqual(conversation.messages, [{ role: "user", content: "USER_SUPPLEMENT_SENTINEL" }]);
  assert.deepEqual(states, ["sending", "accepted"]); assert.deepEqual(accepted, ["USER_SUPPLEMENT_SENTINEL"]);
  assert.equal(req.messages.at(-1)!.content, "USER_SUPPLEMENT_SENTINEL");
});
