import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import type { Runtime } from "../../src/runtime";
import type { GoogleCalendarService } from "../../src/calendar/service";
import { createCalendarTools } from "../../src/core/tools/calendar";
import type { CompletionResult, SessionRef } from "../../src/types";

async function main() {
  const original = process.cwd(), root = await fs.mkdtemp(path.join(os.tmpdir(), "harbour-calendar-runtime-"));
  let runtime: Runtime | undefined;
  const logger = pino({ enabled: false });
  try {
    process.chdir(root);
    const { createRuntime } = await import("../../src/runtime");
    const { loadEnv } = await import("../../src/config/env");
    const agentsDir = path.join(root, "agents"); await fs.mkdir(agentsDir);
    await fs.writeFile(path.join(agentsDir, "main-calendar-fixture.md"), ["---", "name: main-calendar-fixture", "description: Calendar fixture", "model: mock/fixture", "taskType: test", "tools: [calendar_read, calendar_write]", "permissionMode: dontAsk", "maxSteps: 8", "---", "Calendar fixture"].join("\n"));
    const env = loadEnv(); Object.assign(env, { AGENTS_DIR: agentsDir, SESSION_DIR: path.join(root, "data", "sessions"),
      DEFAULT_AGENT: "main-calendar-fixture", MOCK_LLM: true, ENABLE_CODEX_HARNESS: false, SESSIONS_ENABLED: true });
    runtime = await createRuntime(env, logger, { forceMock: true });
    const event = { id: "fixtureevent", calendarId: "primary", summary: "复习", start: { date: "2026-09-21" }, end: { date: "2026-09-22" } };
    let creates = 0;
    const api = { events: async () => ({ events: [event] }), create: async () => { creates++; return { event }; } } as unknown as GoogleCalendarService;
    for (const tool of createCalendarTools(api)) runtime.registry.register(tool);
    let phase = 0;
    runtime.router.complete = async req => {
      assert.ok(req.messages.every(message => message.calendarCards === undefined), "UI metadata is never added to model history");
      assert.ok(req.toolContext?.execution?.calendarCards instanceof Map);
      phase++;
      const action = phase === 1 ? { name: "calendar_read", arguments: { action: "events", timeMin: "2026-09-20T00:00:00Z", timeMax: "2026-09-23T00:00:00Z" } }
        : phase === 2 ? { name: "calendar_write", arguments: { action: "create", requestId: "fixture", event } } : null;
      return action ? { message: { role: "assistant", content: "", toolCalls: [{ ...action, id: `fixture-${phase}` }] } } as CompletionResult
        : { message: { role: "assistant", content: "已安排复习。" } };
    };
    const ref: SessionRef = { key: "web:calendar-fixture", channel: "web", runId: "fixture-run", actor: { role: "owner", platform: "web", id: "owner" } };
    await runtime.runAgent("main-calendar-fixture", "请帮我安排复习", undefined, undefined, ref);
    const session = runtime.sessions!.resolveActive(ref.key, { channel: "web", agentName: "main-calendar-fixture" });
    assert.equal(creates, 1);
    assert.deepEqual(session.messages.at(-1)!.calendarCards!.map(card => card.action), ["listed", "created"]);
    await runtime.runAgent("main-calendar-fixture", "谢谢", undefined, undefined, { ...ref, runId: "fixture-run-2" });
    assert.equal(session.messages.at(-1)!.calendarCards, undefined, "new turn does not leak previous cards");
    let interruptedStep = 0;
    runtime.router.complete = async () => {
      if (interruptedStep++ === 0) return { message: { role: "assistant", content: "", toolCalls: [{
        name: "calendar_write", arguments: { action: "create", requestId: "second-event", event }, id: "interrupt-write",
      }] } };
      throw new Error("fixture interruption after calendar receipt");
    };
    await assert.rejects(runtime.runAgent("main-calendar-fixture", "另安排一个日程", undefined, undefined,
      { ...ref, runId: "fixture-run-3" }), /fixture interruption/);
    assert.equal(creates, 2);
    assert.equal(session.messages.at(-1)!.runRecord?.status, "interrupted");
    assert.equal(session.messages.at(-1)!.calendarCards![0]!.action, "created", "successful receipt survives later model failure");
    console.log("Calendar runtime: actual tool loop, per-turn/interrupted cards, model-history exclusion passed");
  } finally {
    await runtime?.sessions?.flush();
    runtime?.goals?.stop();
    await runtime?.metrics.close();
    process.chdir(original);
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("harbour-calendar-runtime-"));
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
