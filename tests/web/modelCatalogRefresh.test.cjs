const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const app = fs.readFileSync(path.join(__dirname, "../../web/app.js"), "utf8");
const between = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const selectors = {
  "#chatModel": { innerHTML: "", value: "", disabled: true },
  "#chatEffort": { innerHTML: "", value: "", disabled: true },
};
let response;
let requests = 0;
let timer;
let timers = 0;
const context = vm.createContext({
  window: {},
  state: { chat: {
    model: "codex-app-server/gpt-5.6-sol", reasoningEffort: "high", agent: "main-elaina",
    running: true, readOnlyMirror: false, modelRows: [],
  } },
  $: (selector) => selectors[selector],
  api: async () => { requests++; return response; },
  esc: (text) => String(text),
  formatDate: (text) => text,
  timeHtml: (text) => `<time>${text}</time>`,
  syncChatPermissionDefault: () => {},
  syncChatControlLocks: () => {},
  updateChatContextRing: () => {},
  refreshSessionList: async () => {},
  modelMaker: () => "OpenAI",
  groupModelsByMaker: (names) => [["OpenAI", names]],
  modelFreshness: () => 0,
  setTimeout: (callback) => { timer = callback; return ++timers; },
});
vm.runInContext(between("async function fillChatModels()", "async function setChatModel("), context);
vm.runInContext(between("function modelConnectionCardHtml(", "async function renderModelSlots()"), context);
const model = (name) => ({
  modelRef: `codex-app-server/${name}`, model: name, modelName: name,
  effortOptions: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({ effort })),
});

(async () => {
  response = { models: [model("gpt-5.6-sol"), model("gpt-6-astra")], agents: [
    { name: "main-elaina", effectiveModelRef: "codex-app-server/gpt-5.6-sol", defaultReasoningEffort: "high" },
  ] };
  context.scheduleModelCatalogReload();
  context.scheduleModelCatalogReload();
  assert.equal(timers, 1, "同批刷新通知必须合并");
  await timer();
  assert.equal(requests, 1);
  assert.match(selectors["#chatModel"].innerHTML, /gpt-6-astra/);
  assert.equal(selectors["#chatModel"].value, "codex-app-server/gpt-5.6-sol");
  assert.equal(selectors["#chatEffort"].value, "high");
  assert.equal(selectors["#chatModel"].disabled, true, "不能解锁正在运行的选择器");
  assert.equal(selectors["#chatEffort"].disabled, true);
  assert.match(selectors["#chatEffort"].innerHTML, /ultra/);

  response = { models: [model("gpt-6-astra")], agents: [] };
  await context.fillChatModels();
  assert.equal(context.state.chat.model, "codex-app-server/gpt-5.6-sol", "目录短暂缺项不得切换会话模型");
  assert.equal(context.state.chat.reasoningEffort, "high", "目录短暂缺项不得清空会话 effort");
  assert.match(selectors["#chatModel"].innerHTML, /目录暂不可用/);
  assert.match(selectors["#chatEffort"].innerHTML, /high（目录暂不可用）/);

  const pending = [];
  context.api = () => new Promise((resolve) => pending.push(resolve));
  context.state.chat.sessionId = "A";
  const oldRequest = context.fillChatModels();
  context.state.chat.sessionId = "B";
  const currentRequest = context.fillChatModels();
  pending[1]({ models: [model("gpt-6-astra")], agents: [] });
  await currentRequest;
  pending[0]({ models: [model("gpt-5.6-sol")], agents: [] });
  await oldRequest;
  assert.deepEqual(Array.from(context.state.chat.models), ["codex-app-server/gpt-6-astra"], "late catalog response cannot overwrite a new session's model options");

  const codexCard = context.modelConnectionCardHtml({
    runtimeId: "codex-app-server", ready: true, models: [{ enabled: true, available: true }],
    catalog: { updatedAt: "2026-09-05T00:00:00Z" },
  });
  assert.match(codexCard, /data-codex-catalog-refresh/);
  assert.match(codexCard, /1 个可用模型/);
  assert.match(codexCard, /model-catalog-footer/);
  assert.match(codexCard, /model-catalog-meta/);
  assert.match(codexCard, /更新组件与目录/);
  const failedUpdateCard = context.modelConnectionCardHtml({ runtimeId: "codex-app-server", ready: true,
    component: { status: "failed", version: "0.153.4", message: "组件升级失败" } });
  assert.match(failedUpdateCard, /Codex 0\.153\.4.*升级未完成/);
  assert.match(failedUpdateCard, /model-connection-error/);
  assert.doesNotMatch(failedUpdateCard, /Codex 0\.153\.4 · 已核对最新稳定版/);
  assert.match(context.modelConnectionCardHtml({ runtimeId: "codex-app-server", ready: true,
    component: { status: "updated", version: "0.160.0" } }), /Codex 0\.160\.0 · 已核对最新稳定版/);
  assert.doesNotMatch(context.modelConnectionCardHtml({ runtimeId: "claude-agent" }), /data-codex-catalog-refresh/);
  assert.match(app, /if \(obj\.msg === "models:catalog-updated"\) scheduleModelCatalogReload\(\)/);
  assert.doesNotMatch(between("function scheduleModelCatalogReload()", "/** 当前会话的 Effort"), /await renderModel/,
    "后台刷新不能覆盖设置页未保存的表单");
  console.log("web model catalog hot refresh tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
