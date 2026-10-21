const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const app = fs.readFileSync(path.join(__dirname, "../../web/app.js"), "utf8");
function source(name) {
  const match = app.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^}`, "m"));
  assert.ok(match, name); return match[0];
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture() {
  const session = { id: "A", modelRef: "provider/big", contextModelRef: "provider/big", contextWindow: 1_000_000, contextLimit: 230_000,
    contextBudgetMode: "manual", configuredContextBudget: 230_000, reservedOutputTokens: 50_000, compactSource: "window-ratio", compactRequestedTokens: 184_000, compactClamped: false,
    compactAtTokens: 184_000, contextTokens: 40_000, systemTokens: 4_000, bodyTokens: 34_000, toolTokens: 2_000, contextWindowSource: "catalog" };
  const chat = { sessionId: "A", agent: "main-test", sessions: [session], model: "provider/big", reasoningEffort: "high", sessionListRequestSeq: 0 };
  const controls = { "#chatCtx": {}, "#chatModel": {} };
  const calls = [], notices = [];
  const ctx = vm.createContext({ state: { chat }, window: {}, pinChatWindow() {}, updateSessionUnreadIndicators() {}, $: (key) => controls[key], esc: String,
    api: (...args) => { const gate = deferred(); calls.push({ args, gate }); return gate.promise; },
    toast: (msg) => notices.push(msg), fillChatEfforts() {}, syncChatControlLocks() {}, refreshSessionList: async () => {},
  });
  vm.runInContext(["fmtK", "ctxRingHtml", "viewedChatSessionId", "updateChatContextRing", "setChatModel"].map(source).join("\n"), ctx);
  return { ctx, chat, session, controls, calls, notices };
}
(async () => {
  const f = fixture(); f.ctx.updateChatContextRing();
  assert.match(f.controls["#chatCtx"].innerHTML, /40K \/ 230K/);
  assert.match(f.controls["#chatCtx"].innerHTML, /≈40K/);
  assert.match(f.controls["#chatCtx"].innerHTML, /手动限额/);
  assert.match(f.controls["#chatCtx"].innerHTML, /压缩 184K · 预算 80%/);
  assert.match(f.controls["#chatCtx"].innerHTML, /模型 1000K/);
  const pending = f.ctx.setChatModel("provider/small");
  assert.match(f.controls["#chatCtx"].innerHTML, /模型切换中/);
  await f.ctx.setChatModel("provider/other");
  assert.equal(f.calls.length, 1, "a config-save transaction serializes rapid changes");
  f.calls[0].gate.resolve({ session: { ...f.session, modelRef: "provider/small", contextModelRef: "provider/small", contextWindow: 32_000, contextLimit: 30_400, reservedOutputTokens: 1_600, compactRequestedTokens: 25_600, compactAtTokens: 25_600 } });
  await pending;
  assert.match(f.controls["#chatCtx"].innerHTML, /40K \/ 30.4K/);
  assert.match(f.controls["#chatCtx"].innerHTML, /下次发送先压缩 · 模型 32K/);
  assert.match(f.controls["#chatCtx"].title, /132%/);
  assert.equal(f.chat.modelSaving, null);
  assert.equal(f.chat.model, "provider/small");
  const failing = f.ctx.setChatModel("provider/unavailable"); f.calls[1].gate.reject(new Error("offline")); await failing;
  assert.equal(f.chat.model, "provider/small");
  assert.match(f.controls["#chatCtx"].innerHTML, /模型 32K/);
  const stale = f.ctx.setChatModel("provider/big");
  f.chat.sessionId = "B"; f.chat.model = "provider/B";
  f.chat.sessions.push({ ...f.session, id: "B", contextWindow: 64_000, contextLimit: 60_800 });
  f.calls[2].gate.resolve({ session: { ...f.session, modelRef: "provider/big", contextWindow: 1_000_000 } }); await stale;
  assert.equal(f.chat.model, "provider/B");
  assert.match(f.controls["#chatCtx"].innerHTML, /模型 64K/);
  f.chat.running = true; await f.ctx.setChatModel("provider/big"); assert.equal(f.calls.length, 3);
  f.chat.inspection = { id: "A" }; f.ctx.updateChatContextRing();
  assert.match(f.controls["#chatCtx"].innerHTML, /模型 32K/, "preview uses the viewed session's window");
  assert.match(source("executeChat"), /state\.chat\.modelSaving/);
  const restored = fixture();
  restored.controls['#chatModel'].options = [];
  restored.controls['#chatModel'].insertAdjacentHTML = (_position, html) => { restored.controls['#chatModel'].innerHTML = html; };
  Object.assign(restored.ctx, { sessionChatMessages: () => [], coworkBindingForSession: () => null,
    ...Object.fromEntries(['syncChatSourceMode', 'overlaySelectedChannelRuns', 'renderChatMessages', 'renderChatPlan', 'renderChatCheckpoint', 'renderChatGoal', 'enrichNewsReports'].map(name => [name, () => {}])) });
  vm.runInContext(source('applySessionDetail'), restored.ctx);
  restored.ctx.applySessionDetail({ ...restored.session, channel: 'web', modelRef: 'provider/missing-from-catalog', contextWindow: 64000, contextLimit: 60800 });
  assert.equal(restored.chat.model, 'provider/missing-from-catalog', 'restoring a session must preserve its exact model even before the catalog arrives');
  assert.match(restored.controls['#chatModel'].innerHTML, /目录暂不可用/);
  assert.match(restored.controls['#chatCtx'].innerHTML, /模型 64K/);
  const late = fixture();
  late.chat.detailRequestSeq = 0;
  let detailApplied = false;
  late.ctx.applySessionDetail = () => { detailApplied = true; };
  vm.runInContext(source('loadConversationMessages'), late.ctx);
  const oldDetail = late.ctx.loadConversationMessages('A');
  const switching = late.ctx.setChatModel('provider/small');
  late.calls[0].gate.resolve({ session: late.session }); await oldDetail;
  assert.equal(detailApplied, false, 'a history response fetched before the model save cannot restore old model/context');
  late.calls[1].gate.resolve({ session: { ...late.session, modelRef: 'provider/small', messages: [{ content: 'do not duplicate in sidebar' }] } });
  await switching;
  assert.equal(late.session.messages, undefined);
  // Automatic Main budget follows the actual model; no client-side 230K cap or guessed threshold.
  const automatic = fixture();
  Object.assign(automatic.session, { contextBudgetMode: "auto", configuredContextBudget: null, contextLimit: 950_000,
    compactAtTokens: 800_000, compactRequestedTokens: 800_000 });
  automatic.ctx.updateChatContextRing();
  assert.match(automatic.controls['#chatCtx'].innerHTML, /≈40K \/ 950K/);
  assert.match(automatic.controls['#chatCtx'].innerHTML, /自动限额 · 模型 1000K/);
  assert.match(automatic.controls['#chatCtx'].innerHTML, /压缩 800K · 窗口 80%/);
  assert.match(automatic.controls['#chatCtx'].title, /输出预留：50,000 tok/);
  assert.match(automatic.controls['#chatCtx'].title, /工具 schema 估算：2,000 tok/);
  assert.match(automatic.controls['#chatCtx'].title, /不是本轮工具循环的实时精确计数/);
  assert.doesNotMatch(automatic.controls['#chatCtx'].innerHTML, /230K/);
  Object.assign(automatic.session, { compactSource: "environment", compactAtTokens: 600_000, compactRequestedTokens: 600_000 });
  automatic.ctx.updateChatContextRing();
  assert.match(automatic.controls['#chatCtx'].innerHTML, /压缩 600K · 环境覆盖/);
  Object.assign(automatic.session, { compactSource: "model", compactAtTokens: 949_999, compactRequestedTokens: 2_000_000, compactClamped: true });
  automatic.ctx.updateChatContextRing();
  assert.match(automatic.controls['#chatCtx'].innerHTML, /模型覆盖（已限幅）/);
  assert.match(automatic.controls['#chatCtx'].title, /请求值 2,000,000 tok 已限制到有效输入安全线/);
  assert.match(automatic.controls['#chatCtx'].title, /压缩触发线：949,999 tok/);
  Object.assign(automatic.session, { contextBudgetMode: "manual", configuredContextBudget: 8_000, contextLimit: 8_000,
    compactSource: "window-ratio", compactAtTokens: 6_400, compactRequestedTokens: 6_400, compactClamped: false, contextTokens: 1_000 });
  automatic.ctx.updateChatContextRing();
  assert.match(automatic.controls['#chatCtx'].innerHTML, /≈1K \/ 8K/);
  assert.match(automatic.controls['#chatCtx'].title, /手动 · Agent 指定 8,000 tok/);
  assert.match(automatic.controls['#chatCtx'].innerHTML, /压缩 6.4K · 预算 80%/);
  // Older saved/UI data does not falsely claim automatic/manual provenance.
  delete automatic.session.contextBudgetMode; delete automatic.session.compactSource;
  automatic.ctx.updateChatContextRing();
  assert.match(automatic.controls['#chatCtx'].innerHTML, /输入上限/);
  assert.match(automatic.controls['#chatCtx'].title, /后端未提供自动\/手动标记/);

  vm.runInContext(['agentContextBudgetHtml', 'readAgentContextBudget'].map(source).join('\n'), automatic.ctx);
  assert.equal(automatic.ctx.readAgentContextBudget('auto', '230000'), 'auto');
  assert.equal(automatic.ctx.readAgentContextBudget('manual', '230000'), 230000, 'explicit prior numeric budgets survive unchanged');
  assert.equal(automatic.ctx.readAgentContextBudget('manual', '8000'), 8000);
  for (const raw of ['', '0', '-1', '1.5', 'not-a-number', 'Infinity', '9007199254740992']) assert.throws(() => automatic.ctx.readAgentContextBudget('manual', raw));
  const autoForm = automatic.ctx.agentContextBudgetHtml({ contextBudget: 'auto' }, true);
  assert.match(autoForm, /value="auto" selected/);
  assert.match(autoForm, /id="f-budget"[^>]*disabled/);
  assert.doesNotMatch(autoForm, /value="auto"[^>]*type="number"|value="NaN"/);
  const manualForm = automatic.ctx.agentContextBudgetHtml({ contextBudget: 230000 }, true);
  assert.match(manualForm, /value="manual" selected/); assert.match(manualForm, /value="230000"/);
  assert.match(automatic.ctx.agentContextBudgetHtml({ contextBudget: 'auto' }), /运行配置.*直接修改/);

  // Exercise the actual save handler, rather than only inspecting the form's markup.
  const saveEvents = {}, posted = [], notices = [];
  const controls = Object.fromEntries(Object.entries({
    '#f-name': 'main-fixture', '#f-desc': '', '#f-model': '', '#f-mode': 'dontAsk', '#f-tt': 'research',
    '#f-budget-mode': 'auto', '#f-budget': '', '#f-steps': '8', '#f-prompt': 'fixture', '#saveAgent': '',
  }).map(([id, value]) => [id, { value, addEventListener: (type, fn) => { saveEvents[id + ':' + type] = fn; } }]));
  const editor = fixture();
  Object.assign(editor.ctx, { $: (id) => controls[id], api: async (url, options) => {
    if (url === '/api/tools') return { tools: [] };
    posted.push(JSON.parse(options.body)); return {};
  }, agentsView: {}, PANELS: { agents: { render() {} } }, route: async () => {}, editorText: value => String(value ?? '').replace(/\r\n?/g, '\n'), editorLeave: { register() {} }, toast: (message) => notices.push(message),
    groupedModelOptionsHtml: () => '', permissionModeManifestOptionsHtml: () => '', agentRuntimeDefaultsHtml: () => '', wireAgentRuntimeDefaults() {} });
  vm.runInContext(['agentContextBudgetHtml', 'readAgentContextBudget', 'renderFlatAgentForm'].map(source).join('\n'), editor.ctx);
  const box = { isConnected: true, innerHTML: '', querySelector: id => controls[id], querySelectorAll: () => [] };
  await editor.ctx.renderFlatAgentForm(box, { name: 'main-fixture', contextBudget: 'auto', tools: [], taskType: 'research' });
  await saveEvents['#saveAgent:click']();
  assert.equal(posted[0].contextBudget, 'auto', 'auto survives the form-to-API boundary as a string');
  controls['#f-budget-mode'].value = 'manual'; controls['#f-budget'].value = '230000';
  await saveEvents['#saveAgent:click'](); assert.equal(posted[1].contextBudget, 230000);
  controls['#f-budget'].value = ''; await saveEvents['#saveAgent:click']();
  assert.equal(posted.length, 2); assert.match(notices.at(-1), /正整数/);
  await editor.ctx.renderFlatAgentForm(box, null);
  assert.match(box.innerHTML, /value="auto" selected/, 'new specialist defaults to the actual model capacity');
  assert.match(source('renderModelConfigs'), /压缩覆盖.*留空跟随/);
  assert.match(source('renderModelConfigs'), /el\.value === "" \? null : Number\(el\.value\)/, 'clearing a model override sends null, not zero');
  console.log("PASS context ring policy/source/reserve/estimate, auto/manual editor payloads, model-save lock, rollback, stale response and read-only preview");
})().catch((error) => { console.error(error); process.exitCode = 1; });
