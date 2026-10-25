import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { runNovelAiPromptCounterBatch, type NovelAiCounterBatchInput } from "../../src/core/tools/novelAiPromptCounterBatch";
import { NovelAiPreparationBatchReceiptError } from "../../src/core/tools/novelAiPreparationProgress";
import { OpenCliCommandTimeoutError } from "../../src/core/tools/openCliProcess";

// Spawn the real fixed helper against a disposable fake installed OpenCLI tree.
// No daemon, Chrome, account, live page, model or generation is involved.
async function fixture(mode = "ok") {
  const root = await mkdtemp(path.join(os.tmpdir(), "harbour-counter-batch-"));
  const browser = path.join(root, "browser"), log = path.join(root, "calls.jsonl");
  await mkdir(browser);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(root, "main.js"), "throw Error('CLI entry must not run');");
  const common = `import {appendFileSync} from 'node:fs';const mode=${JSON.stringify(mode)};const log=(type,value)=>appendFileSync(${JSON.stringify(log)},JSON.stringify({type,value})+'\\n');`;
  await writeFile(path.join(browser, "profile.js"), common + `
export function resolveProfileSelection(profile){log('profile',profile);return mode==='preferred'?{source:'preferred',contextId:'other'}:{source:'explicit',contextId:'resolved-'+profile}}
`);
  await writeFile(path.join(browser, "page.js"), common + `
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
setInterval(()=>{},5000); // The helper must exit after flushing, not wait for a pool/timer.
export class Page {
 constructor(...args){log('constructor',args);log('process',{argv:process.argv,secretPresent:!!process.env.HARBOUR_TEST_API_KEY});}
 async tabs(){log('tabs');if(mode==='tabs-fail')throw Error('tabs fixture failed');if(mode==='wrong-tab')return [{page:'FOREIGN'}];if(mode==='duplicate-tab')return [{page:'SFW_TAB'},{page:'SFW_TAB'}];return [{page:'SFW_TAB'}]}
 setActivePage(tab){log('bind',tab)}
 async evaluate(source){
  const stage=source.startsWith('prepare-private-sfw')?'prepare':source==='clear-sfw'?'clear':source==='read-sfw'?'read':'other';
  log(stage,source);
  if(mode==='private-error')throw Error('private-sfw-prompt-content:'+source);
  if(mode===stage+'-fail')throw Error(stage+' fixture rejected');
  if(mode===stage+'-delay'){await delay(1200);log('late-'+stage)}
  if(stage==='prepare'&&mode==='missing-meter')return {prepared:false,failure:{step:'token-meter',reason:'token-meter-missing'}};
  if(stage==='prepare'&&mode==='untrusted-diagnostic')return {prepared:false,failure:{step:'token-meter',reason:'private-sfw-prompt-content'}};
  if(stage==='prepare')return mode==='malformed-prepare'?{prepared:true,verification:{verified:false}}:{prepared:true,verification:{verified:true},targeted:{matches:1},...(mode==='unicode'?{unicode:source}:{})};
  if(stage==='read')return mode==='malformed-counter'?{value:90}:mode==='empty-counter'?{text:''}:mode==='whitespace-counter'?{text:'   '}:{text:'90 / 512',source:'actual-page-counter'};
  if(stage==='clear'&&mode==='malformed-clear')return {cleared:false};
  if(stage==='clear'&&mode==='missing-clear')return {};
  if(stage==='clear'&&mode==='stdout-noise')process.stdout.write('invalid receipt prefix');
  return {cleared:true};
 }
 async hover(selector){
  log('hover',selector);
  if(mode==='hover-fail')throw Error('hover fixture failed');
  if(mode==='hover-delay'){await delay(1200);log('late-hover')}
  if(mode==='synthetic')return this.evaluate("el.dispatchEvent(new PointerEvent('pointerover'))");
  await this.tryNativeMouseMove(mode==='bad-coordinate'?NaN:10,20);
  return {matches_n:1};
 }
 async cdp(method,params){log('cdp',{method,params});if(mode==='native-fail')throw Error('native input failed');return {}}
}
`);
  const input: NovelAiCounterBatchInput = { entryPath: path.join(root, "main.js"), profile: "sfw-profile", session: "sfw-session",
    tab: "SFW_TAB", marker: "sfw-marker", idleTimeoutSeconds: 600,
    prepareScript: "prepare-private-sfw-text", clearScript: "clear-sfw", readScript: "read-sfw", timeoutMs: 4000 };
  const calls = async () => {
    try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  const cleanup = async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("harbour-counter-batch-"));
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  };
  return { input, calls, cleanup };
}

test("spawned batch uses exact route, fixed native sequence, stdin scripts and immediate exit", async () => {
  const f = await fixture(), oldSecret = process.env.HARBOUR_TEST_API_KEY;
  process.env.HARBOUR_TEST_API_KEY = "fixture-only-secret";
  try {
    const diagnostics: unknown[] = [], start = Date.now();
    const result = await runNovelAiPromptCounterBatch({ ...f.input, onDiagnostics: timing => diagnostics.push(timing) });
    assert.ok(Date.now() - start < 2500, "helper must not wait for fixture keepalive timer");
    assert.equal(result.prepared.verification && (result.prepared.verification as any).verified, true);
    assert.equal(result.counter.text, "90 / 512"); assert.equal(diagnostics.length, 1);
    assert.deepEqual(Object.keys(result.timings), ["tabs", "prepare", "leave", "clear", "hover", "read"]);
    const calls = await f.calls();
    assert.deepEqual(calls.map(item => item.type), ["profile", "constructor", "process", "tabs", "bind", "prepare", "hover", "cdp", "clear", "hover", "cdp", "read"]);
    assert.deepEqual(calls.find(item => item.type === "constructor").value, ["sfw-session", 600, "resolved-sfw-profile", "foreground", "browser"]);
    assert.equal(calls.find(item => item.type === "profile").value, "sfw-profile");
    assert.equal(calls.find(item => item.type === "bind").value, "SFW_TAB");
    assert.deepEqual(calls.filter(item => item.type === "hover").map(item => item.value),
      ['[data-harbour-richtext-target="sfw-marker"]', '[data-harbour-token-target="sfw-marker"]']);
    assert.ok(calls.filter(item => item.type === "cdp").every(item => item.value.method === "Input.dispatchMouseEvent" && item.value.params.type === "mouseMoved"));
    const child = calls.find(item => item.type === "process").value;
    assert.equal(child.secretPresent, false); assert.ok(!JSON.stringify(child.argv).includes(f.input.prepareScript));
  } finally {
    if (oldSecret === undefined) delete process.env.HARBOUR_TEST_API_KEY; else process.env.HARBOUR_TEST_API_KEY = oldSecret;
    await f.cleanup();
  }
});

test("window mode matches CLI foreground default and explicit background; invalid mode fails before routing", async t => {
  for (const mode of [undefined, "background", "invalid"]) await t.test(String(mode), async () => {
    const f = await fixture(), previous = process.env.OPENCLI_WINDOW;
    if (mode === undefined) delete process.env.OPENCLI_WINDOW; else process.env.OPENCLI_WINDOW = mode;
    try {
      if (mode === "invalid") {
        await assert.rejects(runNovelAiPromptCounterBatch(f.input), NovelAiPreparationBatchReceiptError);
        assert.deepEqual(await f.calls(), []);
      } else {
        await runNovelAiPromptCounterBatch(f.input);
        assert.equal((await f.calls()).find(item => item.type === "constructor").value[3], mode ?? "foreground");
      }
    } finally { if (previous === undefined) delete process.env.OPENCLI_WINDOW; else process.env.OPENCLI_WINDOW = previous; await f.cleanup(); }
  });
});

test("invalid host arguments are rejected before spawning", async t => {
  const variants: Array<Partial<NovelAiCounterBatchInput>> = [
    { entryPath: "relative.js" }, { profile: "" }, { session: "bad session" }, { tab: "../foreign" }, { marker: 'x"]' },
    { idleTimeoutSeconds: 0 }, { prepareScript: "" }, { readScript: "" }, { clearScript: "" },
    { prepareScript: "x".repeat(300_001) }, { timeoutMs: 0 }, { timeoutMs: 180_001 },
  ];
  for (let i = 0; i < variants.length; i++) await t.test(`argument ${i}`, async () => {
    const f = await fixture();
    try { await assert.rejects(runNovelAiPromptCounterBatch({ ...f.input, ...variants[i] }), /invalid/); assert.deepEqual(await f.calls(), []); }
    finally { await f.cleanup(); }
  });
});

test("route and intermediate failures never replay the batch or continue later operations", async t => {
  const variants = [
    ["preferred", "constructor"], ["tabs-fail", "bind"], ["wrong-tab", "bind"], ["duplicate-tab", "bind"],
    ["prepare-fail", "hover"], ["malformed-prepare", "hover"], ["hover-fail", "clear"],
    ["native-fail", "clear"], ["bad-coordinate", "cdp"], ["synthetic", "other"],
    ["clear-fail", "read"], ["malformed-clear", "read"], ["missing-clear", "read"], ["read-fail", "late-read"],
    ["malformed-counter", "late-read"], ["empty-counter", "late-read"], ["whitespace-counter", "late-read"], ["stdout-noise", "late-read"],
  ];
  for (const [mode, forbidden] of variants) await t.test(mode, async () => {
    const f = await fixture(mode);
    try {
      await assert.rejects(runNovelAiPromptCounterBatch(f.input), NovelAiPreparationBatchReceiptError);
      const calls = await f.calls();
      assert.ok(!calls.some(item => item.type === forbidden));
      assert.ok(calls.filter(item => item.type === "prepare").length <= 1);
      assert.ok(calls.filter(item => item.type === "constructor").length <= 1);
      if (mode === "malformed-clear" || mode === "missing-clear") assert.equal(calls.filter(item => item.type === "hover").length, 1);
    } finally { await f.cleanup(); }
  });
});

test("helper errors never echo submitted scripts or arbitrary third-party error prose", async () => {
  const f = await fixture("private-error");
  try {
    await assert.rejects(runNovelAiPromptCounterBatch(f.input), error => {
      assert.ok(error instanceof NovelAiPreparationBatchReceiptError);
      assert.ok(error.message.includes("phase=prepare"));
      assert.ok(!error.message.includes("private-sfw-prompt-content"));
      assert.ok(!error.message.includes(f.input.prepareScript));
      return true;
    });
    assert.equal((await f.calls()).filter(item => item.type === "prepare").length, 1);
    assert.ok(!(await f.calls()).some(item => item.type === "hover"));
  } finally { await f.cleanup(); }
});

test("failed preparation reports only allowlisted substeps/reasons and never continues to hover", async () => {
  for (const mode of ["missing-meter", "untrusted-diagnostic"]) {
    const f = await fixture(mode);
    try {
      await assert.rejects(runNovelAiPromptCounterBatch(f.input), (error: any) => {
        assert.ok(error instanceof NovelAiPreparationBatchReceiptError);
        assert.match(error.message, /phase=prepare/);
        if (mode === "missing-meter") assert.match(error.message, /step=token-meter, reason=token-meter-missing/);
        else assert.ok(!error.message.includes("reason="));
        assert.ok(!error.message.includes("private-sfw-prompt-content"));
        return true;
      });
      assert.equal((await f.calls()).filter(item => item.type === "prepare").length, 1);
      assert.ok(!(await f.calls()).some(item => item.type === "hover" || item.type === "read"));
    } finally { await f.cleanup(); }
  }
});

test("large multibyte scripts and receipts survive stdin/stdout chunk boundaries exactly", async () => {
  const f = await fixture("unicode");
  const script = "prepare-private-sfw:" + "参考图😀\n".repeat(12_000);
  try {
    const result = await runNovelAiPromptCounterBatch({ ...f.input, prepareScript: script });
    assert.equal(result.prepared.unicode, script);
    assert.equal((await f.calls()).find(item => item.type === "prepare").value, script);
    assert.ok(!JSON.stringify((await f.calls()).find(item => item.type === "process").value.argv).includes("参考图"));
  } finally { await f.cleanup(); }
});

test("pre-cancelled batch starts no helper", async () => {
  const f = await fixture(), controller = new AbortController(), reason = new Error("fixture stopped"); controller.abort(reason);
  try { await assert.rejects(runNovelAiPromptCounterBatch({ ...f.input, signal: controller.signal }), error => error === reason); assert.deepEqual(await f.calls(), []); }
  finally { await f.cleanup(); }
});

test("mid-operation cancellation kills child before any subsequent step", async t => {
  for (const stage of ["prepare", "hover"]) await t.test(stage, async () => {
    const f = await fixture(`${stage}-delay`), controller = new AbortController(), reason = new Error("fixture interrupted");
    try {
      const pending = runNovelAiPromptCounterBatch({ ...f.input, signal: controller.signal });
      const rejection = assert.rejects(pending, error => error === reason);
      const until = Date.now() + 3000;
      while (!(await f.calls()).some(item => item.type === stage)) { assert.ok(Date.now() < until); await delay(5); }
      controller.abort(reason); await rejection; await delay(1250);
      const calls = await f.calls();
      assert.ok(!calls.some(item => item.type === `late-${stage}` || item.type === "clear" || item.type === "read"));
    } finally { await f.cleanup(); }
  });
});

test("deadline kills child and does not replay or change parent signal", async () => {
  const f = await fixture("prepare-delay"), parent = new AbortController();
  try {
    await assert.rejects(runNovelAiPromptCounterBatch({ ...f.input, signal: parent.signal, timeoutMs: 400 }), OpenCliCommandTimeoutError);
    await delay(1250); assert.equal(parent.signal.aborted, false);
    const calls = await f.calls(); assert.ok(!calls.some(item => item.type === "late-prepare" || item.type === "hover"));
    assert.ok(calls.filter(item => item.type === "prepare").length <= 1);
  } finally { await f.cleanup(); }
});

test("diagnostic callback failure cannot discard successful exact receipt", async () => {
  const f = await fixture();
  try { assert.equal((await runNovelAiPromptCounterBatch({ ...f.input, onDiagnostics: () => { throw Error("diagnostic fixture"); } })).counter.text, "90 / 512"); }
  finally { await f.cleanup(); }
});
