import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { harbourBrowserHome, harbourDataHome } from "../../src/core/storagePaths";
import { copyLegacyDirectory } from "../../src/core/storageMigration";

test("runtime and browser defaults stay in checkout, overrides preserve browser base semantics", () => {
  assert.equal(harbourDataHome({}), path.resolve("data/runtime"));
  assert.equal(harbourBrowserHome({}), path.resolve("data/runtime/opencli-browser"));
  const root = path.resolve("data/fixture-custom");
  assert.equal(harbourBrowserHome({ HARBOUR_DATA_HOME: root }), path.join(root, "opencli-browser"));
  assert.equal(harbourBrowserHome({ HARBOUR_DATA_HOME: root, HARBOUR_OPENCLI_BROWSER_HOME: path.resolve("data") }), path.resolve("data/opencli-browser"));
});

test("legacy migration preserves login/history bytes and never overwrites current state", async t => {
  const fixtures = path.resolve("data/runtime/test-fixtures");
  await fs.mkdir(fixtures, { recursive: true });
  const base = await fs.mkdtemp(path.join(fixtures, "storage-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, "old"), destination = path.join(base, "new");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "history.json"), "history fixture");
  await fs.writeFile(path.join(source, "HarbourCdpOwner.json"), '{"pid":1}');
  assert.equal(await copyLegacyDirectory(source, destination), true);
  assert.equal(await fs.readFile(path.join(destination, "history.json"), "utf8"), "history fixture");
  await assert.rejects(fs.access(path.join(destination, "HarbourCdpOwner.json")));
  assert.equal(await fs.readFile(path.join(source, "history.json"), "utf8"), "history fixture");
  await fs.writeFile(path.join(source, "history.json"), "old changed");
  assert.equal(await copyLegacyDirectory(source, destination), false);
  assert.equal(await fs.readFile(path.join(destination, "history.json"), "utf8"), "history fixture");
  await assert.rejects(copyLegacyDirectory(source, path.join(source, "nested")), /inside/);
});
