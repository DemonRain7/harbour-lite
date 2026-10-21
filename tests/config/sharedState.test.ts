import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { applySharedSettingsDefaults, readSharedSettings, selectSharedSettings, writeSharedSettings } from "../../src/core/sharedSettings";
import { CronController } from "../../src/scheduler/cron";
import { cronRuntimePath, persistCronState, restoreCronRuntime, splitCronState } from "../../src/scheduler/cronPersistence";
import type { Task } from "../../src/types";

test("portable preferences reject secrets, provider URLs, paths and arbitrary future settings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harbour-shared-"));
  try {
    const mixed = { DEFAULT_AGENT: "main-elaina", SESSION_COMPACT_TOKENS: "0", TTS_HEADERS: "SECRET",
      WEB_AUTH_TOKEN: "SECRET", HARBOUR_CHROME_PATH: "C:\\chrome.exe", STT_URL: "https://secret@host",
      UNKNOWN_NEW_SETTING: "SECRET", ENABLE_DESKTOP_CONTROL: "true" };
    assert.deepEqual(Object.keys(selectSharedSettings(mixed)), ["DEFAULT_AGENT", "SESSION_COMPACT_TOKENS"]);
    await writeSharedSettings(mixed, root);
    await writeSharedSettings({ STT_LANGUAGE: "auto", WEB_AUTH_TOKEN: "SECRET" }, root);
    const shared = readSharedSettings(root);
    const target = { DEFAULT_AGENT: "main-aemeath" };
    applySharedSettingsDefaults(target, shared);
    assert.equal(target.DEFAULT_AGENT, "main-aemeath");
    assert.ok(!(await fs.readFile(path.join(root, "data/sharedSettings.json"), "utf8")).includes("SECRET"));
    assert.equal(shared.STT_LANGUAGE, "auto");
    assert.equal(readSharedSettings(path.join(root, "fresh-mac")).DEFAULT_AGENT, undefined);
    await fs.writeFile(path.join(root, "data/sharedSettings.json"), JSON.stringify({ version: 1, values: { TTS_HEADERS: "SECRET" } }));
    assert.throws(() => readSharedSettings(root), /白名单/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("legacy Cron history migrates locally; another device sees only the same task definition", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harbour-cron-local-"));
  const file = path.join(root, "win/cron.json");
  const job = { id: "fixture", name: "shared", agent: "main-elaina", input: "scheduled request", enabled: false,
    schedule: "0 8 * * *", timeZone: "America/New_York", lastTick: "2026-09-01", lastResult: "PRIVATE_RESULT", nextTick: "future" };
  const controllers: CronController[] = [];
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify([job]));
    const queued: Task[] = [];
    const make = (storePath: string) => {
      const controller = new CronController({ logger: pino({ enabled: false }), enqueue: (task) => queued.push(task), storePath });
      controllers.push(controller); return controller;
    };
    const win = make(file);
    await win.init();
    assert.equal(win.list()[0]!.lastResult, "PRIVATE_RESULT");
    const definitions = await fs.readFile(file, "utf8");
    assert.ok(!definitions.includes("lastResult") && !definitions.includes("PRIVATE_RESULT"));
    assert.ok((await fs.readFile(cronRuntimePath(file), "utf8")).includes("PRIVATE_RESULT"));
    const macFile = path.join(root, "mac/cron.json");
    await fs.mkdir(path.dirname(macFile));
    await fs.copyFile(file, macFile);
    const mac = make(macFile); await mac.init();
    assert.equal(mac.list()[0]!.lastResult, undefined);
    assert.equal(mac.list()[0]!.input, job.input);
    win.runOnce(job.id); await win.flush(); await queued[0]!.reply!("NEW_PRIVATE_RESULT"); queued[0]!.onSettled?.(); await win.flush();
    assert.equal(await fs.readFile(file, "utf8"), definitions, "runs never dirty shared definitions");
    const restarted = make(file); await restarted.init();
    assert.equal(restarted.list()[0]!.lastResult, "NEW_PRIVATE_RESULT");
    await win.remove(job.id);
    assert.deepEqual(JSON.parse(await fs.readFile(cronRuntimePath(file), "utf8")).jobs, {});
    assert.equal(splitCronState([job]).runtime.jobs.fixture!.lastRun, job.lastTick);
    await persistCronState(macFile, [{ id: "__proto__", lastResult: "own" }]);
    assert.equal((await restoreCronRuntime(macFile, [{ id: "__proto__" }]))[0]!.id, "__proto__");
    await fs.writeFile(cronRuntimePath(macFile), "broken");
    await assert.rejects(restoreCronRuntime(macFile, [{ id: job.id }]));
  } finally { controllers.forEach((controller) => controller.close()); await fs.rm(root, { recursive: true, force: true }); }
});
