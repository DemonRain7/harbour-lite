import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { runAgentLoop } from "../../src/core/agentLoop";
import { ContextManager } from "../../src/core/contextManager";
import { ToolRegistry } from "../../src/core/tools/registry";
import { rememberComicSubagentDelivery, rememberComicSubagentOutcome } from "../../src/core/tools/comic";
import { rememberNovelAiImageSetResult } from "../../src/core/workflows/novelAiImageSet";
import { appendCanonicalDelivery, incompleteDelivery } from "../../src/core/runDelivery";
import type { Router } from "../../src/core/router";
import type { CompletionResult } from "../../src/types";

const one = "/uploads/comics/fixture/panels/one.png", two = "/uploads/comics/fixture/panels/two.png";
const single = "/uploads/illustration/fixture.png";
const comic = `COMIC_COMPLETE {"jobId":"comic-fixture","title":"测试漫画","total":2,"visibleSpentAnlas":52}\n\n### 第 1 幕 · 开始\n\n![第一幕](${one})\n\n### 第 2 幕 · 结束\n\n![第二幕](${two})`;
const prose = "问题一：两项配置均已检查，A 无需修改，B 仍待重启验证。\n\n补充问题：原任务保持暂停，不会重新生成已完成图片。";

async function fixture(t: any, name: string, reply: string, seed: (state: Map<string, unknown>) => void, incomplete?: CompletionResult["incomplete"]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "harbour-final-delivery-"));
  t.after(async () => { assert.ok(path.basename(root).startsWith("harbour-final-delivery-")); await rm(root, { recursive: true, force: true }); });
  const logger = pino({ level: "silent" }), registry = new ToolRegistry(), state = new Map<string, unknown>();
  let calls = 0, tools = 0;
  registry.register({ name: "receipt", description: "Read-only test fixture", readOnly: true, parameters: { type: "object" },
    execute: async () => { tools++; seed(state); return { status: "observed", note: "TOOL_RESULT_SENTINEL" }; } });
  const router = { pick: () => "mock/fixture", complete: async () => {
    calls++;
    return calls === 1 ? { message: { role: "assistant", content: "PROGRESS_SENTINEL: 正在检查", toolCalls: [{ id: "read", name: "receipt", arguments: {} }] } }
      : { message: { role: "assistant", content: reply }, ...(incomplete ? { incomplete } : {}) };
  } } as unknown as Router;
  const answer = await runAgentLoop({ agent: { name, tools: ["receipt"], systemPrompt: "Fixture", contextBudget: 32000, maxSteps: 4 },
    input: "检查两项配置，给图，并说明恢复情况。", logger, router, registry, contextManager: new ContextManager(logger), runState: state, traceDirectory: root });
  assert.equal(calls, 2, "no additional repair-model loop"); assert.equal(tools, 1, "no repeated work");
  assert.doesNotMatch(answer, /PROGRESS_SENTINEL|TOOL_RESULT_SENTINEL/);
  const trace = (await readFile(path.join(root, (await readdir(root))[0]!), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.ok(trace.some(event => event.answer === answer || event.data?.answer === answer), "exact final body is audited");
  return { answer, state };
}

for (const name of ["main-elaina", "main-aemeath"]) {
  test(`${name} ordinary chat retains both answers and both kinds of canonical images`, async t => {
    const { answer } = await fixture(t, name, `${prose}\n\n![reverse](${two})\n![duplicate](${one})\n![duplicate](${single})`, state => {
      rememberComicSubagentDelivery(comic, state);
      rememberNovelAiImageSetResult({ jobId: "nai-set-fixture", title: "独立插画", total: 1, status: "completed", visibleSpentAnlas: 26,
        deliveryUrls: [single], deliveryMarkdown: `![插画](${single})` }, { runState: state });
    });
    assert.ok(answer.includes(prose));
    for (const url of [one, two, single]) assert.equal(answer.split(url).length, 2, "each image delivered exactly once");
    assert.ok(answer.indexOf(one) < answer.indexOf(two)); assert.ok(answer.indexOf(two) < answer.indexOf(single));
    assert.match(answer, /52 Anlas/); assert.match(answer, /26 Anlas/);
  });
}
test("blocked receipts preserve independent explanations without erasing unknown cost or partial images", async t => {
  const { answer } = await fixture(t, "main-fixture", prose, state => {
    rememberComicSubagentOutcome({ agent: "comic_generator", status: "blocked", terminal: true, authoritative: true, jobId: "comic-fixture",
      reason: "等待核对提交状态", retrySafety: "uncertain", completed: 1, total: 2, visibleSpentAnlas: 26, maxTotalAnlas: 63, uncertainReservedAnlas: 32,
      partialDeliveryMarkdown: `![partial](${one})`, result: "blocked" }, state);
  });
  assert.ok(answer.includes(prose)); assert.match(answer, /等待核对提交状态/); assert.match(answer, /未知扣费预留：32/); assert.match(answer, /不会自动重试/);
  assert.equal(answer.split(one).length, 2);
});
test("empty replies cannot become completed merely because a Workflow has an artifact", async t => {
  const { answer, state } = await fixture(t, "main-fixture", "", state => rememberComicSubagentDelivery(comic, state), "empty_reply");
  assert.ok(answer.includes(one)); assert.equal(incompleteDelivery(state), "empty_reply");
});
test("exact canonical text does not get repeated when the model also answers another question", () => {
  const canonical = `第一幕\n\n![one](${one})`;
  assert.equal(appendCanonicalDelivery(`${prose}\n\n${canonical}`, canonical), `${prose}\n\n${canonical}`);
});
