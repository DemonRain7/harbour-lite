import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import pino from "pino";
import { RunInputLease } from "../../src/core/runInputs";
import { ComicJobStore } from "../../src/core/comics/comicJobStore";
import { createRunWorkflowTool, workflowExecutionEvidenceKey, type WorkflowExecutionEvidence } from "../../src/core/tools/runWorkflow";
import { createComicGenerationWorkflowExecutor } from "../../src/core/workflows/comicGeneration";
import { createNovelAiGenerationWorkflowExecutor } from "../../src/core/workflows/novelAiGeneration";
import { createNovelAiImageSetWorkflowExecutor } from "../../src/core/workflows/novelAiImageSet";
import { WorkflowRegistry } from "../../src/core/workflows/registry";
import type { BrowserControllerResult } from "../../src/core/tools/spawnSubagent";
import type { ToolContext } from "../../src/types";

const mounted = [{ name: "novelai-generation", executor: "novelai-generation", version: 4 }];
const generation = { characters: [{ name: "Fixture Person", type: "female", extraAnchors: ["short brown hair", "brown eyes", "adult woman"],
  action: "reading a book", position: "center", expression: "calm", outfit: ["blue coat"] }], interaction: "reading quietly",
  setting: "sunny library", camera: "medium shot", lighting: "daylight", style: "watercolor", orientation: "square", numberOfImages: 1 };
const panel = (number: number) => ({ number, title: `Page ${number}`, beat: "Reading", transition: "moment-to-moment", shot: "medium", angle: "eye-level",
  focalPoint: "book", action: "reading", emotion: "calm", visualDescription: "A reader in a library", dialogue: [], characters: ["Fixture Person"],
  continuity: { location: "library", time: "day", axis: "desk", screenDirection: "center", characterStates: { "Fixture Person": "blue coat" }, props: ["book"] },
  generation: { ...generation, setting: `library room ${number}` } });

function plan(kind: "comic" | "image") {
  return kind === "comic" ? { job: { title: "Reading", premise: "Two moments reading a book", contentRating: "sfw", nsfwAuthorized: 0,
    readingDirection: "ltr", language: "en", batchSize: 2, layout: { columns: 2, panelsPerPage: 2 }, budget: { maxTotalAnlas: 100 },
    bible: { style: "watercolor", palette: "blue", lighting: "daylight", aspectRatio: "square",
      characters: [{ name: "Fixture Person", role: "reader", appearance: "short brown hair", initialWardrobe: "blue coat" }],
      locations: [{ name: "library", visualAnchors: "shelves" }] }, panels: [panel(1), panel(2)] } }
    : { set: { title: "Two moments", mode: "independent", contentRating: "sfw", nsfwAuthorized: 0,
      budget: { maxTotalAnlas: 100, source: "explicit" },
      items: [1, 2].map(number => ({ title: `Moment ${number}`, generation: { ...generation, setting: `library room ${number}` } })) } };
}

function context(lease: RunInputLease, kind: string): ToolContext {
  return { agent: { name: "main-fixture", taskType: "test", systemPrompt: "Offline SFW fixture", tools: ["run_workflow"], workflows: mounted },
    logger: pino({ level: "silent" }), runState: new Map(),
    source: { key: `web:native-boundary-${kind}`, channel: "web", sessionId: `session-${kind}`, actor: { platform: "web", role: "owner", id: "fixture-owner" } },
    execution: { runId: `native-boundary-${kind}`, runInputs: lease, inputBoundary: lease, toolEvidence: new Map() } };
}

async function readSaved(directory: string): Promise<any> {
  const files = (await readdir(directory)).filter(file => file.endsWith(".json"));
  assert.equal(files.length, 1, "one durable Job, not a second plan or replay");
  return JSON.parse(await readFile(path.join(directory, files[0]!), "utf8"));
}

// Real public Workflow, governed author boundary, compiler, durable stores and per-unit
// loop. Only model output, Browser and image-set publication are local SFW fixtures.
for (const kind of ["comic", "image"] as const) {
  test(`${kind}: native steer waits for image receipt, import, Job and author return; resume preserves the first image`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harbour-native-workflow-"));
    const events: string[] = [], records: string[] = [], accepted: string[] = [];
    const lease = new RunInputLease(`native-boundary-${kind}`, kind, async (_, id) => { accepted.push(id); }, () => {});
    try {
      const jobDir = path.join(root, "jobs"), uploadDir = path.join(root, "uploads");
      const artifacts = [path.join(root, "first.png"), path.join(root, "second.png")];
      for (const [index, artifact] of artifacts.entries()) {
        await sharp({ create: { width: 1024, height: 1024, channels: 4, background: index ? "#bd7948" : "#5b9dcf" } }).png().toFile(artifact);
      }
      const unitKey = kind === "comic" ? "panels" : "groups";
      let sends = 0, browserCalls = 0, authorCalls = 0;
      let firstFrozenRequest: unknown, nativeSnapshot: any, childReceipt: any;
      lease.bindNative(async () => {
        sends++; events.push("native:send");
        nativeSnapshot = await readSaved(jobDir);
        return "accepted";
      }, { nativeOnly: true });
      const verifyBeforeImport = async () => {
        const saved = await readSaved(jobDir);
        assert.equal(sends, 0, "native input cannot arrive before the first import and completion record");
        assert.equal(saved.budget.visibleSpentAnlas, 1, "the raw receipt has already persisted the charge");
        const first = saved[unitKey][0];
        assert.ok(kind === "comic" ? first.generationReceipt?.rawArtifacts.length === 1 : first.status === "rendered" && first.rawArtifacts.length === 1);
        assert.notEqual(first.status, "completed");
        assert.equal(lease.hasPending, true);
        events.push("raw:durable", "import:begin");
      };
      const runBrowser = async (_task: string, browserContext: ToolContext): Promise<BrowserControllerResult> => {
        browserCalls++;
        if (browserCalls === 1) {
          assert.equal(browserContext.execution?.runInputs, undefined, "the child must not own the root mailbox");
          assert.equal(browserContext.execution?.inputBoundary, lease);
          events.push("browser:running");
          assert.equal(lease.offer({ id: "supplement", text: "Please pause after the current image.",
            record: async state => { records.push(state); } }), true);
          await lease.settleNative();
          assert.equal(sends, 0, "do not send native input while Generate is in progress");
          assert.equal(lease.hasPending, true, "the executor still needs to observe the queued supplement");
          const saved = await readSaved(jobDir);
          assert.equal(saved[unitKey][0].status, "running");
          assert.equal(saved.budget.visibleSpentAnlas, 0);
          assert.equal(saved[unitKey][0].generationReceipt, undefined);
          firstFrozenRequest = saved[unitKey][0].novelAiRequest;
          events.push("browser:done");
        }
        return { agent: "browser_controller", status: "completed", terminal: true, controllerInvoked: true, artifactVerified: true,
          chargeState: "charged", costAnlas: 1, artifacts: [artifacts[browserCalls - 1]!], instruction: "local synthetic fixture", result: "local synthetic fixture" };
      };
      const store = new ComicJobStore({ jobDir, uploadDir, allowedImageRoots: [root] });
      const recordPanel = store.recordPanel.bind(store);
      store.recordPanel = async (owner, input) => {
        if (input.panelNumber === 1) await verifyBeforeImport();
        const saved = await recordPanel(owner, input);
        if (input.panelNumber === 1) {
          assert.equal(sends, 0);
          assert.equal((await readSaved(jobDir)).panels[0].status, "completed");
          events.push("unit:durable");
        }
        return saved;
      };
      const comic = createComicGenerationWorkflowExecutor({ store, uploadDir, runBrowser });
      const images = createNovelAiImageSetWorkflowExecutor({ jobDir, runBrowser,
        publishArtifacts: async (_task, files) => {
          if (browserCalls === 1) await verifyBeforeImport();
          await mkdir(uploadDir, { recursive: true });
          const published = [];
          for (const source of files) {
            const destination = path.join(uploadDir, path.basename(source));
            await copyFile(source, destination);
            published.push({ path: destination, name: path.basename(source), url: `/uploads/${path.basename(source)}`,
              collection: "fixture", characters: [], size: (await stat(destination)).size });
          }
          if (browserCalls === 1) { assert.equal(sends, 0); events.push("import:done"); }
          return { attempted: true, artifacts: published };
        } });
      const registry = new WorkflowRegistry();
      registry.register(comic); registry.register(images);
      registry.register(createNovelAiGenerationWorkflowExecutor({ comic, images }));
      const tool = createRunWorkflowTool(registry), ctx = context(lease, kind);
      ctx.runAgent = async (name, _input, _type, _attachments, _session, _model, _mode, signal, execution, delegation) => {
        authorCalls++;
        assert.equal(name, kind === "comic" ? "comic_generator" : "novelai_artist");
        // Match runtime.bindCoworkExecution: descendants inherit only the read-only
        // boundary view, not the root's native transport lease.
        const child: ToolContext = { ...ctx, agent: { ...ctx.agent, name }, runState: new Map(), signal,
          execution: { ...execution, runInputs: undefined }, source: delegation?.source };
        childReceipt = await tool.execute({ name: "novelai-generation", action: "execute", input: { kind, ...plan(kind) } }, child);
        const saved = await readSaved(jobDir);
        assert.equal(saved.status, "paused");
        assert.equal(saved[unitKey][0].status, "completed");
        assert.notEqual(saved[unitKey][1].status, "completed");
        assert.equal(sends, 0, "child tool completion must not release the root Workflow hold");
        assert.equal(lease.hasPending, true);
        events.push("job:paused", "author:return");
        return "Fixture author returned; use authoritative Workflow evidence.";
      };
      const result = await tool.execute({ name: "novelai-generation", action: "start",
        input: { kind, request: "Create two separate SFW illustrations of an adult reading. Total budget 100 Anlas." } }, ctx) as any;
      events.push("root:return");
      await lease.settleNative();
      assert.equal(childReceipt.nextAction, "handle_pending_input");
      assert.equal(childReceipt.status, "paused");
      assert.equal(result.jobId, childReceipt.jobId);
      assert.equal(result.completed, 1);
      assert.equal(browserCalls, 1, "new input prevents a second Generate");
      assert.equal(sends, 1);
      assert.deepEqual(accepted, ["supplement"]);
      assert.deepEqual(records, ["sending", "accepted"]);
      assert.equal(nativeSnapshot.status, "paused", "the sender observes the persisted safe boundary");
      assert.equal(nativeSnapshot[unitKey][0].status, "completed");
      assert.equal(nativeSnapshot.budget.visibleSpentAnlas, 1);
      assert.ok(events.indexOf("native:send") > events.indexOf("author:return"), events.join(" > "));
      assert.ok(events.indexOf("native:send") > events.indexOf("root:return"), events.join(" > "));
      const frozen = await readSaved(jobDir);
      const resumed = await tool.execute({ name: "novelai-generation", action: "resume",
        input: { kind, jobId: result.jobId } }, ctx) as any;
      assert.equal(resumed.status, "completed");
      assert.equal(resumed.jobId, result.jobId);
      assert.equal(resumed.completed, 2);
      assert.equal(resumed.visibleSpentAnlas, 2);
      assert.equal(authorCalls, 1, "existing Job resume does not re-launch its author");
      assert.equal(browserCalls, 2, "resume generates only the second image");
      const final = await readSaved(jobDir);
      assert.deepEqual(final[unitKey][0].novelAiRequest, firstFrozenRequest);
      assert.equal(final[unitKey][0].attempts, frozen[unitKey][0].attempts);
      assert.deepEqual(kind === "comic" ? final.panels[0].asset : final.groups[0].artifacts,
        kind === "comic" ? frozen.panels[0].asset : frozen.groups[0].artifacts);
    } finally {
      await lease.finish();
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith("harbour-native-workflow-"));
      await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    }
  });
}

test("pending input before comic submission yields authoritative evidence without a contract retry", async () => {
  const events: string[] = [], accepted: string[] = [];
  const lease = new RunInputLease("native-author", "native-author", async (_, id) => { accepted.push(id); }, () => {});
  let sends = 0, authors = 0, executions = 0;
  lease.bindNative(async () => { sends++; events.push("native:send"); return "accepted"; }, { nativeOnly: true });
  const registry = new WorkflowRegistry();
  registry.register(createNovelAiGenerationWorkflowExecutor({
    comic: { id: "comic-generation", async execute() { executions++; assert.fail("pending supplement must prevent plan execution"); } },
  }));
  const tool = createRunWorkflowTool(registry), ctx = context(lease, "author");
  let childResult: any, evidence: WorkflowExecutionEvidence | undefined;
  ctx.runAgent = async (name, _input, _type, _attachments, _session, _model, _mode, signal, execution, delegation) => {
    authors++;
    assert.equal(name, "comic_generator");
    assert.equal(authors, 1, "safe pending-input rejection must not trigger the missing-Workflow contract retry");
    lease.offer({ id: "author-supplement", text: "Pause before drawing; I have a correction.", record: async () => {} });
    await lease.settleNative();
    assert.equal(sends, 0);
    const child: ToolContext = { ...ctx, agent: { ...ctx.agent, name }, runState: new Map(), signal,
      execution: { ...execution, runInputs: undefined }, source: delegation?.source };
    childResult = await tool.execute({ name: "novelai-generation", action: "submit_draft", input: {} }, child);
    assert.equal(childResult.status, "waiting_for_input");
    assert.equal(childResult.executionStarted, false);
    evidence = execution?.toolEvidence?.get(workflowExecutionEvidenceKey(execution.subagentDelegationId!, "novelai-generation")) as WorkflowExecutionEvidence | undefined;
    assert.equal(evidence?.phase, "completed");
    assert.equal(evidence?.result?.status, "waiting_for_input");
    assert.equal(evidence?.result?.executionStarted, false);
    events.push("author:return");
    return "Fixture author yielded to the queued correction.";
  };
  try {
    const result = await tool.execute({ name: "novelai-generation", action: "start",
      input: { kind: "comic", request: "Create a two-panel SFW comic about an adult reading; total budget 2 Anlas." } }, ctx) as any;
    events.push("root:return");
    await lease.settleNative();
    assert.equal(authors, 1);
    assert.equal(executions, 0);
    assert.equal(sends, 1);
    assert.deepEqual(accepted, ["author-supplement"]);
    assert.equal(result.jobId, undefined);
    assert.ok(events.indexOf("native:send") > events.indexOf("author:return"), events.join(" > "));
    assert.ok(events.indexOf("native:send") > events.indexOf("root:return"), events.join(" > "));
    assert.doesNotMatch(JSON.stringify(result), /连续两次未调用|contract retry|没有启动.*Workflow/);
  } finally { await lease.finish(); }
});
