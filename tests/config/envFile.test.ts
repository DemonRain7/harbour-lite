import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

test("settings preserve dotenv values across save, cold load and repeated edits without exposing secrets", async () => {
  const previous = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harbour-env-fixture-"));
  try {
    process.chdir(dir);
    const original = "# untouched comment\r\nUNRELATED='keep # exact'\r\n\r\nTTS_PROFILES_JSON={}\r\n";
    await fs.writeFile(".env", original);
    const { updateEnvValues, readEnvValues } = await import("../../src/core/envFile");
    const patch = {
      TTS_PROFILES_JSON: JSON.stringify({ aemeath: { promptText: "你好，用户。", referenceAudio: "C:\\new folder\\voice.wav" } }),
      TTS_HEADERS: JSON.stringify({ Authorization: "Bearer fixture#only", note: "用户's voice" }),
      WINDOWS_PATH: "C:\\new folder\\recordings\\voice.wav",
      QUOTES: "both 'single' and \"double\" # plus `backticks`",
      PADDED: "  preserve edges  ",
      BACKTICK: "`quoted`",
      MULTILINE: "first\nsecond\r\nthird",
      EMPTY: "",
    };
    // A value containing all three quote forms + # cannot be represented safely;
    // reject before changing anything, without echoing the potentially secret value.
    await assert.rejects(updateEnvValues(patch), (error: Error) => !error.message.includes(patch.QUOTES));
    assert.equal(await fs.readFile(".env", "utf8"), original);
    patch.QUOTES = "both 'single' and \"double\" # characters";
    await updateEnvValues(patch);
    const saved = await fs.readFile(".env", "utf8");
    assert.ok(saved.startsWith("# untouched comment\r\nUNRELATED='keep # exact'\r\n\r\n"));
    assert.deepEqual(dotenv.parse(saved), { UNRELATED: "keep # exact", ...patch });
    assert.deepEqual(await readEnvValues(), dotenv.parse(saved));
    await Promise.all([updateEnvValues({ MULTILINE: "updated\nline" }), updateEnvValues({ EXTRA: "second save" })]);
    assert.deepEqual(dotenv.parse(await fs.readFile(".env", "utf8")), { UNRELATED: "keep # exact", ...patch, MULTILINE: "updated\nline", EXTRA: "second save" });
    assert.doesNotMatch(await fs.readFile(".env", "utf8"), /\r?\nsecond\r?\n/);
  } finally {
    process.chdir(previous);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
