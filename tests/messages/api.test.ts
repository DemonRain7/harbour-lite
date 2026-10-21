import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { ActiveRunInputs } from "../../src/core/runInputs";
import { MessageIntake } from "../../src/core/messageIntake";
import { SessionStore } from "../../src/core/sessionStore";
import { TaskQueue } from "../../src/scheduler/queue";
import { startServer, type ServerDeps } from "../../src/server/api";
import { LogBroadcaster } from "../../src/server/logBroadcaster";

test("HTTP inbox: auth, pinned session, stable IDs, receipt cache and zero permission overrides", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harbour-input-api-"));
  const logger = pino({ level: "silent" }), inputs = new ActiveRunInputs();
  const intake = new MessageIntake(path.join(root, "inbox"), inputs, path.join(root, "settings.json"));
  const sessions = new SessionStore(logger, path.join(root, "sessions"), "main-test"); await sessions.init();
  const session = sessions.create("web:fixture", { channel: "web", agentName: "main-test" });
  const mirror = sessions.create("qq:fixture", { channel: "qq", agentName: "main-test" });
  const release = inputs.reserve(session.id); let executions = 0;
  const queue = new TaskQueue(2, async task => { executions++; intake.executed(task.meta?.intakeId, "saved"); await task.reply!("saved"); }, logger);
  const socket = createServer(); await new Promise<void>(r => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as { port: number }).port; await new Promise<void>(r => socket.close(() => r()));
  const runtime = { sessions, inputs, intake, asks: { onChange() {} }, stopGoalRun() {} };
  const server = startServer({ port, host: "127.0.0.1", logger, runtime, queue, broadcaster: new LogBroadcaster(),
    env: { WEB_AUTH_TOKEN: "fixture", WEB_CORS: false, UPLOAD_DIR: root, MAX_UPLOAD_MB: 4 }, channels: [], heartbeat: {}, cron: {} } as unknown as ServerDeps);
  const base = `http://127.0.0.1:${port}`, route = `/api/conversations/${session.id}/inputs`;
  const call = async (url: string, method = "GET", body?: unknown) => {
    const res = await fetch(base + url, { method, headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { code: res.status, body: await res.json() as any };
  };
  try {
    assert.equal((await fetch(base + route)).status, 401);
    const first = await call(route, "POST", { input: "FIRST_SENTINEL", clientMessageId: "stable-first" });
    assert.equal(first.code, 202);
    const same = await call(route, "POST", { input: "FIRST_SENTINEL", clientMessageId: "stable-first" });
    assert.equal(same.body.id, first.body.id);
    assert.equal((await call(route, "POST", { input: "changed", clientMessageId: "stable-first" })).code, 400);
    assert.equal((await call(route, "POST", { input: "bad", clientMessageId: "stable-bad", permissionMode: "bypassPermissions" })).code, 400);
    assert.equal((await call(`/api/conversations/${mirror.id}/inputs`, "POST", { input: "bad", clientMessageId: "stable-bad" })).code, 403);
    assert.equal((await call(route, "PATCH", { action: "unknown" })).code, 400);
    const snapshot = await call(route); assert.equal(snapshot.body.busy, true); assert.equal(snapshot.body.records.length, 1);
    const cached = await call(`${route}?revision=${snapshot.body.revision}`);
    assert.equal(cached.body.unchanged, true); assert.equal(cached.body.records, undefined);
    await call(route, "PATCH", { action: "stop" }); release(); await intake.pump(); assert.equal(executions, 0);
    assert.equal((await call(route)).body.records[0].state, "paused");
    await call(route, "PATCH", { action: "resume" }); await intake.pump();
    await new Promise(r => setTimeout(r, 30)); assert.equal(executions, 1);
    assert.equal((await call(route)).body.records.length, 0);
    assert.equal((await call('/api/message-intake/settings', 'PATCH', { textDelayMs: 60001 })).code, 400);
    // Hold to inspect one-shot admission without any model call, including a native image.
    await call(route, "POST", { input: "/collect", clientMessageId: "stable-collect" });
    const bareQueue = await call(route, "POST", { input: "/queue", clientMessageId: "stable-mode" });
    assert.equal(bareQueue.code, 200); assert.match(bareQueue.body.reply, /本会话：排队/);
    const single = await call(route, "POST", { input: "/steer\n问题一  保留空格\n问题二", mode: "queue", clientMessageId: "stable-one-shot" });
    assert.equal(single.code, 202); assert.equal(single.body.mode, "steer"); assert.equal(single.body.isolated, true);
    assert.equal((await call(route)).body.mode, "queue", "text command overrides only this input, not the menu default");
    const retry = await call(route, "POST", { input: "/steer\n问题一  保留空格\n问题二", mode: "queue", clientMessageId: "stable-one-shot" });
    assert.equal(retry.body.id, single.body.id);
    assert.equal((await call(route, "POST", { input: "/queue\n问题一  保留空格\n问题二", clientMessageId: "stable-one-shot" })).code, 400);
    await writeFile(path.join(root, "single.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+c7X8AAAAASUVORK5CYII=", "base64"));
    const image = await call(route, "POST", { input: "/queue", attachments: [{ kind: "image", url: "/uploads/single.png", name: "single.png" }], clientMessageId: "stable-image" });
    assert.equal(image.code, 202); assert.equal(image.body.isolated, true);
    await call(route, "POST", { input: "next ordinary input", clientMessageId: "stable-next" });
    const current = (await call(route)).body;
    assert.equal(current.mode, "queue");
    assert.equal(current.records.find((r: any) => r.id === single.body.id).messages[0].input, "问题一  保留空格\n问题二");
    assert.equal(current.records.find((r: any) => r.id === image.body.id).messages[0].attachments.length, 1);
    assert.equal(current.records.at(-1).mode, "queue");
    assert.equal(executions, 1, "command admission does not create extra model calls");
    const editable = current.records.find((r: any) => r.id === image.body.id);
    assert.equal(editable.canWithdraw, true); assert.equal(editable.canSteer, false, "held collect is not implicitly released");
    assert.equal(editable.messages[0].attachments[0].path, undefined);
    const change = { action: "withdraw", id: editable.id, revision: editable.revision };
    assert.equal((await fetch(base + route, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) })).status, 401);
    assert.equal((await call(route, "PATCH", { ...change, revision: undefined })).code, 400);
    assert.equal((await call(route, "PATCH", { ...change, mode: "steer" })).code, 400);
    assert.equal((await call(`/api/conversations/${mirror.id}/inputs`, "PATCH", change)).code, 403);
    const other = sessions.create("web:another", { channel: "web", agentName: "main-test" });
    assert.equal((await call(`/api/conversations/${other.id}/inputs`, "PATCH", change)).code, 409);
    assert.equal((await call(route, "PATCH", { ...change, revision: change.revision + 1 })).code, 409);
    const withdrawal = await call(route, "PATCH", change);
    assert.equal(withdrawal.code, 200); assert.equal(withdrawal.body.state, "withdrawn");
    assert.equal(withdrawal.body.messages[0].attachments[0].name, "single.png");
    assert.deepEqual((await call(route, "PATCH", change)).body, withdrawal.body, "response-lost retry returns the same saved content");
    assert.equal((await call(route)).body.records.some((r: any) => r.id === editable.id), false);
    const cancelledRetry = await call(route, "POST", { input: "/queue", attachments: [{ kind: "image", url: "/uploads/single.png", name: "single.png" }], clientMessageId: "stable-image" });
    assert.equal(cancelledRetry.body.state, "withdrawn");
    const edited = await call(route, "POST", { input: "/queue now make it square", attachments: withdrawal.body.messages[0].attachments, clientMessageId: "edited-new-id" });
    assert.equal(edited.code, 202); assert.notEqual(edited.body.id, editable.id);
    const releaseEdit = inputs.reserve(session.id);
    try {
      await call(route, "POST", { input: "/send", clientMessageId: "release-collection" });
      const promote = (await call(route)).body.records.find((r: any) => r.id === edited.body.id);
      assert.equal(promote.canSteer, true);
      const steer = await call(route, "PATCH", { action: "steer", id: promote.id, revision: promote.revision });
      assert.equal(steer.code, 200); assert.equal(steer.body.mode, "steer");
      assert.equal((await call(route)).body.mode, "queue");
      await call(route, "PATCH", { action: "stop" });
    } finally { releaseEdit(); }
  } finally {
    release(); intake.close(); await server.close(); await sessions.flush();
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith("harbour-input-api-"));
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
});
