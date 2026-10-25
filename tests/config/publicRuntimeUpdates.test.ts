import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import type { ActorIdentity, Attachment } from "../../src/types";
import { SessionStore } from "../../src/core/sessionStore";
import { normalizeSessionImages, sessionImageIndex, sessionImageReferences } from "../../src/core/sessionImages";
import { isNativeAnthropicEndpoint } from "../../src/core/anthropicModels";
import { ClaudeAgentSdkBackend } from "../../src/core/backends/claudeAgentSdk";
import { claudeSdkEffortOptions } from "../../src/core/backends/claudeSdkEffort";
import { EFFORT_BUDGET } from "../../src/core/modelConfigStore";
import { refreshModelCatalogForSlot } from "../../src/core/modelCatalog";
import type { ModelSlot } from "../../src/core/modelSlots";

const logger = pino({ enabled: false });
const owner: ActorIdentity = { role: "owner", platform: "web", id: "fixture-owner" };
const uploadedAt = "2026-01-01T12:00:00.000Z";
const attachment: Attachment = { kind: "image", name: "example.png", mime: "image/png",
  url: `/uploads/inbound/${"a".repeat(64)}.png`, image: { sha256: "a".repeat(64), width: 64, height: 64 } };

async function fixture() {
  const base = path.resolve(".local", "public-runtime-tests");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, "run-"));
  return { dir, async cleanup() {
    assert.equal(path.dirname(dir), base);
    assert.match(path.basename(dir), /^run-/);
    await rm(dir, { recursive: true, force: true });
  } };
}

test("historical image locators retain verified owner provenance, not pixels or upload grants", () => {
  const row = { attachment, actor: owner, receivedAt: uploadedAt };
  assert.equal(normalizeSessionImages([row, row]).length, 1);
  assert.equal(normalizeSessionImages([
    { ...row, actor: { ...owner, role: "other" } },
    { ...row, attachment: { ...attachment, url: "https://example.test/image.png" } },
    { ...row, attachment: { ...attachment, image: { ...attachment.image, sha256: "unverified" } } },
    { ...row, receivedAt: "invalid" }, null,
  ]).length, 0);
  // No store mutation/persistence is needed for this metadata-only fixture.
  const session = { id: "fixture", key: "fixture", channel: "web", agentName: "main-assistant", title: "Fixture",
    summary: "", compactions: 0, createdAt: uploadedAt, updatedAt: uploadedAt,
    messages: [{ role: "user" as const, content: "Look at this", attachments: [attachment], actor: owner }], times: [uploadedAt] };
  assert.equal(sessionImageReferences(session).length, 1);
  assert.match(sessionImageIndex(session, owner), /example\.png/);
  assert.match(sessionImageIndex(session, owner), /不授予上传权限/);
  for (const actor of [undefined, { ...owner, id: "someone-else" }, { ...owner, platform: "qq" },
    { ...owner, role: "other" as const }]) assert.equal(sessionImageIndex(session, actor), "");
});

test("compaction preserves image locators across reload, without resetting attachment retention", async () => {
  const f = await fixture();
  try {
    const store = new SessionStore(logger, path.join(f.dir, "sessions"), "main-assistant");
    await store.init();
    const session = store.create("fixture", { channel: "web", agentName: "main-assistant" });
    session.messages = [{ role: "user", content: "Look", attachments: [attachment], actor: owner },
      { role: "assistant", content: "Noted" }, { role: "user", content: "Continue", actor: owner }];
    session.times = [uploadedAt, uploadedAt, "2026-01-20T12:00:00.000Z"];
    (store as any).applyCompaction(session, "fixture summary", 2);
    await store.flush();
    assert.equal(session.messages.length, 1);
    assert.equal(session.compactedImages?.[0]?.receivedAt, uploadedAt);
    const reloaded = new SessionStore(logger, path.join(f.dir, "sessions"), "main-assistant");
    await reloaded.init();
    const saved = reloaded.get(session.id)!;
    assert.match(sessionImageIndex(saved, owner), /example\.png/);
    await reloaded.cleanupExpiredAttachments(path.join(f.dir, "uploads"), 30, Date.parse("2026-02-02T12:00:00Z"));
    assert.equal(sessionImageIndex(saved, owner), "");
  } finally { await f.cleanup(); }
});

test("official Claude uses native effort; compatible providers keep budgets and never inherit subscription credentials", async () => {
  const f = await fixture();
  const keys = ["HARBOUR_DATA_HOME", "CLAUDE_CODE_OAUTH_TOKEN", "MAX_THINKING_TOKENS"];
  const previous = keys.map(key => process.env[key]);
  try {
    process.env.HARBOUR_DATA_HOME = f.dir;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "fixture-inherited-not-a-real-token";
    process.env.MAX_THINKING_TOKENS = "999999";
    const envFor = (baseURL: string, effort: number) => {
      const backend = new ClaudeAgentSdkBackend({ apiKey: "fixture-api-key", authToken: "", baseURL,
        defaultModel: "fixture-model", fallbackModel: "", uploadDir: path.join(f.dir, "uploads"), logger });
      return (backend as any).buildEnv(effort) as Record<string, string | undefined>;
    };
    for (const endpoint of ["", "https://api.anthropic.com", "https://api.anthropic.com/v1"]) {
      assert.ok(isNativeAnthropicEndpoint(endpoint));
      for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
        const env = envFor(endpoint, EFFORT_BUDGET[effort]);
        assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, effort);
        assert.equal(env.MAX_THINKING_TOKENS, undefined);
        assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
        assert.equal(env.ANTHROPIC_API_KEY, "fixture-api-key");
        assert.ok(env.CLAUDE_CONFIG_DIR?.startsWith(f.dir));
      }
    }
    assert.equal(isNativeAnthropicEndpoint("https://api.anthropic.com.example.test"), false);
    assert.equal(isNativeAnthropicEndpoint("http://api.anthropic.com"), false);
    const compatible = envFor("https://provider.example.test/anthropic", EFFORT_BUDGET.high);
    assert.equal(compatible.MAX_THINKING_TOKENS, String(EFFORT_BUDGET.high));
    assert.equal(compatible.CLAUDE_CODE_EFFORT_LEVEL, undefined);
    assert.equal(compatible.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.ok(!claudeSdkEffortOptions("https://provider.example.test/anthropic").some(row => row.effort === "max"));
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    await f.cleanup();
  }
});

test("official model discovery uses API headers, retains user choices and preserves models on failure", async () => {
  const slot: ModelSlot = { id: "fixture", label: "API", keyEnv: "FIXTURE_API_KEY", keyKind: "api", baseURL: "https://api.anthropic.com",
    model: "claude-fixture", models: [{ id: "claude-fixture", label: "My label", enabled: false, available: true, source: "configured" }] };
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://api.anthropic.com/v1/models?limit=1000");
      assert.deepEqual(init?.headers, { "x-api-key": "fixture-api-key", "anthropic-version": "2023-06-01" });
      return Response.json({ data: [
        { id: "claude-fixture", display_name: "Provider label", max_input_tokens: 200000 },
        { id: "claude-fixture-new", display_name: "New model", max_input_tokens: 400000 },
      ] });
    };
    const result = await refreshModelCatalogForSlot(slot, "fixture-api-key", logger);
    assert.equal(result.ok, true); assert.equal(result.added, 1);
    assert.equal(result.slot.models[0]?.label, "My label");
    assert.equal(result.slot.models[0]?.enabled, false);
    assert.equal(result.slot.models[1]?.label, "New model");
    assert.equal(result.slot.models[1]?.contextWindow, 400000);
    globalThis.fetch = async () => { throw new Error("insecure endpoint must not receive the API key"); };
    assert.equal((await refreshModelCatalogForSlot({ ...slot, baseURL: "http://api.anthropic.com" }, "fixture-api-key")).skipped, true);
    globalThis.fetch = async () => new Response(null, { status: 503 });
    const failed = await refreshModelCatalogForSlot(slot, "fixture-api-key", logger);
    assert.equal(failed.ok, false); assert.deepEqual(failed.slot.models, slot.models);
  } finally { globalThis.fetch = originalFetch; }
});
