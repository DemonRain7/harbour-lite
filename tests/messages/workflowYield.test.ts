import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import pino from "pino";
import { createComicGenerationWorkflowExecutor } from "../../src/core/workflows/comicGeneration";
import { ComicJobStore } from "../../src/core/comics/comicJobStore";
import { createNovelAiImageSetWorkflowExecutor } from "../../src/core/workflows/novelAiImageSet";
import type { BrowserControllerResult } from "../../src/core/tools/spawnSubagent";
import type { ToolContext } from "../../src/types";

const generation = { characters: [{ name: "Fixture Person", type: "female", extraAnchors: ["short brown hair", "brown eyes", "adult woman"], action: "reading a book", position: "center", expression: "calm", outfit: ["blue coat"] }],
  interaction: "reading quietly", setting: "sunny library", camera: "medium shot", lighting: "daylight", style: "watercolor", orientation: "square", numberOfImages: 1 };
const panel = (number: number) => ({ number, title: `Page ${number}`, beat: "Reading", transition: "moment-to-moment", shot: "medium", angle: "eye-level",
  focalPoint: "book", action: "reading", emotion: "calm", visualDescription: "A reader in a library", dialogue: [], characters: ["Fixture Person"],
  continuity: { location: "library", time: "day", axis: "desk", screenDirection: "center", characterStates: { "Fixture Person": "blue coat" }, props: ["book"] }, generation });

test("comic and image-set yield after persisted first unit; resume keeps Job, ledger and frozen plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harbour-input-workflow-"));
  try {
    for (const kind of ["comic", "images"] as const) {
      const boundary = { revision: 0, hasPending: false }; let calls = 0;
      const artifact = path.join(root, `${kind}.png`);
      await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#5b9dcf" } }).png().toFile(artifact);
      const runBrowser = async (): Promise<BrowserControllerResult> => {
        calls++; if (calls === 1) { boundary.revision++; boundary.hasPending = true; }
        return { agent: "browser_controller", status: "completed", terminal: true, controllerInvoked: true, artifactVerified: true,
          chargeState: "charged", costAnlas: 1, artifacts: [artifact], instruction: "synthetic", result: "synthetic" };
      };
      const ctx: ToolContext = { agent: { name: kind === "comic" ? "comic_generator" : "main-elaina", taskType: "test", systemPrompt: "fixture", tools: [] }, logger: pino({ level: "silent" }), runState: new Map(),
        source: { key: `web:${kind}`, channel: "web", sessionId: `session-${kind}`, actor: { platform: "web", role: "owner", id: "owner" } },
        execution: { runId: kind, inputBoundary: boundary, toolEvidence: new Map() } };
      const executor = kind === "comic" ? createComicGenerationWorkflowExecutor({
        store: new ComicJobStore({ jobDir: path.join(root, kind), uploadDir: path.join(root, "uploads"), allowedImageRoots: [root] }), uploadDir: path.join(root, "uploads"), runBrowser,
      }) : createNovelAiImageSetWorkflowExecutor({ jobDir: path.join(root, kind), runBrowser,
        publishArtifacts: async (_input, artifacts) => ({ attempted: true, artifacts: artifacts.map(source => ({ path: source, name: path.basename(source), url: `/uploads/${path.basename(source)}`, collection: "fixture", characters: [], size: 1 })) }) });
      const budget = { maxTotalAnlas: 2, source: "explicit" };
      const input = kind === "comic" ? { expectedCostAnlas: 1, job: { title: "Reading", premise: "Two moments reading a book", contentRating: "sfw", nsfwAuthorized: 0,
        readingDirection: "ltr", language: "en", batchSize: 2, layout: { columns: 2, panelsPerPage: 2 }, budget: { maxTotalAnlas: 2 },
        bible: { style: "watercolor", palette: "blue", lighting: "daylight", aspectRatio: "square", characters: [{ name: "Fixture Person", role: "reader", appearance: "short brown hair", initialWardrobe: "blue coat" }], locations: [{ name: "library", visualAnchors: "shelves" }] }, panels: [panel(1), panel(2)] } }
        : { expectedCostAnlas: 1, set: { title: "Two moments", mode: "independent", contentRating: "sfw", nsfwAuthorized: 0, budget,
          items: [1, 2].map(n => ({ title: `Moment ${n}`, generation: { ...generation, setting: `library room ${n}` } })) } };
      const paused = await executor.execute({ action: "start", input }, ctx) as any;
      assert.equal(paused.nextAction, "handle_pending_input"); assert.equal(paused.status, "paused");
      assert.equal(paused.completed, 1); assert.equal(paused.visibleSpentAnlas, 1); assert.equal(calls, 1);
      const frozen = JSON.parse(await readFile(path.join(root, kind, `${paused.jobId}.json`), "utf8"));
      boundary.hasPending = false;
      const result = await executor.execute({ action: "resume", input: { jobId: paused.jobId, expectedCostAnlas: 1 } }, ctx) as any;
      assert.equal(result.status, "completed"); assert.equal(result.jobId, paused.jobId); assert.equal(result.completed, 2);
      assert.equal(result.visibleSpentAnlas, 2); assert.equal(calls, 2, "does not regenerate finished unit");
      const final = JSON.parse(await readFile(path.join(root, kind, `${paused.jobId}.json`), "utf8"));
      const unit = kind === "comic" ? "panels" : "groups";
      assert.deepEqual(final[unit][0].novelAiRequest, frozen[unit][0].novelAiRequest);
    }
  } finally {
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith("harbour-input-workflow-"));
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
});
