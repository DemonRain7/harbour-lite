const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const app = fs.readFileSync(path.join(root, "web/app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web/styles.css"), "utf8");
const source = (name) => {
  const match = app.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^}`, "m"));
  assert.ok(match, name); return match[0];
};
const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const escapeHtml = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function element() {
  const children = new Map();
  return { innerHTML: "", attributes: {}, listeners: {}, value: "", disabled: false,
    classList: { toggle() {} }, setAttribute(key, value) { this.attributes[key] = value; }, focus() {},
    querySelector(key) { if (!children.has(key)) children.set(key, element()); return children.get(key); }, querySelectorAll() { return []; },
    addEventListener(key, listener) { this.listeners[key] = listener; },
  };
}
function goal(id = "g-A", revision = 3, status = "active") {
  return { version: 2, id, revision, status, objective: `${id} 的独立目标`, createdAt: "2026-09-06T00:00:00Z",
    acceptance: ["保留中文、引号与换行", "检查确定性测试结果"], autoContinue: true,
    nextStep: { action: "verify", reason: "运行本地测试并检查结果" },
    usage: { roundsStarted: 2, roundsCompleted: 1, totalTokens: 12345 }, budget: { maxRounds: 20, maxTokens: 50000 },
    verification: { requirement: "recorded" } };
}
function fixture() {
  const controls = Object.fromEntries(["chatGoalBar", "chatGoal", "chatInput"].map((id) => [id, element()]));
  const chat = { sessionId: "A", agent: "fixture-agent", detailRequestSeq: 0, goal: goal(), goalArmed: false, running: false,
    sessions: [{ id: "A", goal: goal() }, { id: "B", goal: goal("g-B") }] };
  const calls = [], confirmations = [], notices = [], reloads = [], inspections = [];
  let executions = 0;
  const ctx = vm.createContext({ state: { chat }, console, $: (id) => controls[id.slice(1)], esc: escapeHtml,
    document: { getElementById: (id) => controls[id], querySelector: () => element() },
    currentSessionKey: () => "web:fixture", api: (url, options) => { const gate = deferred(); calls.push({ url, options, gate }); return gate.promise; },
    harbourConfirm: (...args) => { const gate = deferred(); confirmations.push({ args, gate }); return gate.promise; },
    toast: (...args) => notices.push(args), renderSessionList() {}, executeChat: async () => { executions++; },
    inspectChatSession: (id, refresh) => inspections.push({ id, refresh }), loadConversationMessages: (id) => reloads.push(id),
  });
  const functions = ["chatDraftKey", "isOpenChatGoal", "chatGoalDraft", "readChatGoalConfig", "acceptChatGoalSnapshot", "chatGoalVerificationLabel",
    "chatGoalDetailText", "renderChatGoalConfig", "startChatGoal", "editChatGoalBudget", "renderChatGoal", "toggleChatGoal", "changeChatGoal", "handleChatGoalEvent"];
  vm.runInContext(functions.map(source).join("\n"), ctx);
  return { ctx, chat, controls, calls, confirmations, notices, reloads, inspections, executions: () => executions };
}

(async () => {
  assert.match(app, /goal:\s*startingGoal/);
  assert.match(source("executeChat"), /readChatGoalConfig\(\)/);
  assert.match(source("executeChat"), /startingGoal\?\.objective/);
  assert.match(source("executeChat"), /goalReloadSessionId === submittedChat\.sessionId/);
  assert.match(app, /obj\?\.type === "goal:updated"/);
  assert.match(app, /obj\?\.type === "goal:error"/);
  assert.match(css, /\.goal-config/); assert.match(css, /data-theme-cat="anime".*\.goal-config/);
  assert.doesNotMatch(app, /\bWORK\s*\/\s*CHAT\b/i);

  const config = fixture(); config.chat.goal = null; config.controls.chatInput.value = "完成一项明确交付";
  const draft = config.ctx.chatGoalDraft();
  assert.deepEqual(plain(config.ctx.readChatGoalConfig()), { objective: "完成一项明确交付", acceptance: [], autoContinue: true,
    budget: { maxRounds: 20, maxTokens: null }, verificationRequirement: "delivery" });
  draft.acceptanceText = ' 中文“引号”\n\n保留 C:\\fixture\\file.txt \r\n'; draft.maxTokens = "50000";
  assert.deepEqual(plain(config.ctx.readChatGoalConfig()).acceptance, ['中文“引号”', "保留 C:\\fixture\\file.txt"]);
  for (const value of ["0", "-1", "1.5", "2e3", "9007199254740992", ""]) assert.throws(() => config.ctx.readChatGoalConfig({ ...draft, maxRounds: value }), /正整数/);
  for (const value of ["0", "-1", "3.5"]) assert.throws(() => config.ctx.readChatGoalConfig({ ...draft, maxTokens: value }), /正整数/);
  assert.throws(() => config.ctx.readChatGoalConfig({ ...draft, objective: " " }), /明确目标/);
  assert.throws(() => config.ctx.readChatGoalConfig({ ...draft, objective: "x".repeat(4001) }), /4000/);
  assert.throws(() => config.ctx.readChatGoalConfig({ ...draft, verificationRequirement: "invented" }), /验收方式/);
  assert.throws(() => config.ctx.readChatGoalConfig({ ...draft, maxRounds: "1001" }), /最多 1000/);
  assert.throws(() => config.ctx.readChatGoalConfig({ ...draft, acceptanceText: Array(25).fill("条件").join("\n") }), /最多 24/);
  assert.throws(() => config.ctx.readChatGoalConfig({ ...draft, acceptanceText: "x".repeat(1001) }), /1000 字符/);
  config.chat.sessionId = "B"; config.controls.chatInput.value = "B 独立草稿";
  assert.equal(config.ctx.chatGoalDraft().objective, "B 独立草稿");
  config.chat.sessionId = "A"; assert.equal(config.ctx.chatGoalDraft(), draft);
  draft.objective = '<img src=x onerror="bad">'; config.chat.goalArmed = true; config.ctx.renderChatGoal();
  assert.match(config.controls.chatGoalBar.innerHTML, /&lt;img/); assert.doesNotMatch(config.controls.chatGoalBar.innerHTML, /<img/);
  assert.match(config.controls.chatGoalBar.innerHTML, /总轮数 <small>含首次/);
  const form = config.controls.chatGoalBar.querySelector("form");
  form.listeners.input({ target: { name: "maxRounds", value: "7", type: "number" } });
  form.listeners.change({ target: { name: "autoContinue", checked: false, type: "checkbox" } });
  assert.equal(draft.maxRounds, "7"); assert.equal(draft.autoContinue, false);
  await config.ctx.startChatGoal(); assert.equal(config.executions(), 1);

  const snapshots = fixture(); snapshots.ctx.renderChatGoal();
  snapshots.ctx.acceptChatGoalSnapshot("A", goal("g-A", 2, "completed")); assert.equal(snapshots.chat.goal.revision, 3);
  snapshots.ctx.acceptChatGoalSnapshot("B", goal("g-B", 8)); assert.equal(snapshots.chat.goal.id, "g-A");
  snapshots.ctx.acceptChatGoalSnapshot("A", { ...goal("g-new", 1), createdAt: "2026-09-07T00:00:00Z" });
  snapshots.ctx.acceptChatGoalSnapshot("A", goal("g-A", 999)); assert.equal(snapshots.chat.goal.id, "g-new");
  snapshots.ctx.acceptChatGoalSnapshot("A", null); assert.equal(snapshots.chat.goal.id, "g-new");

  const render = fixture(); render.ctx.renderChatGoal();
  assert.match(render.controls.chatGoalBar.innerHTML, /2 \/ 20 轮 · 累计 12,345 \/ 50,000 tok/);
  assert.match(render.controls.chatGoalBar.innerHTML, /下一步：运行本地测试并检查结果/);
  assert.match(render.controls.chatGoalBar.innerHTML, /工具记录不等于测试通过/);
  render.chat.readOnlyMirror = true; render.ctx.renderChatGoal();
  assert.match(render.controls.chatGoalBar.innerHTML, /只读/); assert.doesNotMatch(render.controls.chatGoalBar.innerHTML, /data-goal-action/);
  await render.ctx.changeChatGoal("pause"); assert.equal(render.confirmations.length, 0);

  const duringConfirm = fixture(); const abandoned = duringConfirm.ctx.changeChatGoal("pause");
  duringConfirm.chat.sessionId = "B"; duringConfirm.chat.goal = goal("g-B"); duringConfirm.chat.detailRequestSeq++;
  duringConfirm.confirmations[0].gate.resolve(true); await abandoned;
  assert.equal(duringConfirm.calls.length, 0, "confirmation cannot move its mutation from A to B");
  const roundTrip = fixture(); const oldIntent = roundTrip.ctx.changeChatGoal("cancel");
  roundTrip.chat.detailRequestSeq += 2; // A -> B -> A is still a different view generation.
  roundTrip.confirmations[0].gate.resolve(true); await oldIntent; assert.equal(roundTrip.calls.length, 0);
  const changedRevision = fixture(); const outdated = changedRevision.ctx.changeChatGoal("complete");
  changedRevision.ctx.handleChatGoalEvent({ type: "goal:updated", sessionId: "A", goal: goal("g-A", 4) });
  changedRevision.confirmations[0].gate.resolve(true); await outdated; assert.equal(changedRevision.calls.length, 0);

  const pause = fixture(); pause.chat.running = true;
  const pausing = pause.ctx.changeChatGoal("pause"); pause.confirmations[0].gate.resolve(true); await new Promise(setImmediate);
  assert.equal(pause.calls[0].url, "/api/conversations/A/goal");
  assert.deepEqual(JSON.parse(pause.calls[0].options.body), { action: "pause", goalId: "g-A", expectedRevision: 3 });
  pause.calls[0].gate.resolve({ session: { id: "A", goal: goal("g-A", 4, "paused") } }); await pausing;
  assert.equal(pause.chat.goal.status, "paused"); assert.equal(pause.executions(), 0);
  pause.chat.running = false;
  const resuming = pause.ctx.changeChatGoal("resume"); assert.equal(pause.confirmations.length, 1);
  assert.deepEqual(JSON.parse(pause.calls[1].options.body), { action: "resume", goalId: "g-A", expectedRevision: 4 });
  pause.calls[1].gate.resolve({ session: { id: "A", goal: goal("g-A", 5) } }); await resuming;
  assert.equal(pause.executions(), 0, "resume only calls the control plane, never sends a duplicate user turn");

  const settings = fixture(); settings.chat.goal.status = "paused"; settings.ctx.editChatGoalBudget();
  assert.match(settings.controls.chatGoalBar.innerHTML, /保持既定要求/);
  assert.match(settings.controls.chatGoalBar.innerHTML, /保存不会自动恢复执行/);
  settings.ctx.chatGoalDraft().maxRounds = "40";
  const saving = settings.ctx.startChatGoal();
  assert.deepEqual(JSON.parse(settings.calls[0].options.body), { action: "configure", goalId: "g-A", expectedRevision: 3, budget: { maxRounds: 40, maxTokens: 50000 }, autoContinue: true });
  settings.calls[0].gate.resolve({ session: { id: "A", goal: { ...goal("g-A", 4, "paused"), budget: { maxRounds: 40, maxTokens: 50000 } } } }); await saving;
  assert.equal(settings.chat.goal.status, "paused"); assert.equal(settings.chat.goalArmed, false); assert.equal(settings.executions(), 0);
  assert.equal(settings.calls.length, 1, "saving a budget does not implicitly resume execution");

  const late = fixture(); late.chat.goal.status = "paused";
  const oldReply = late.ctx.changeChatGoal("resume");
  late.chat.sessionId = "B"; late.chat.goal = goal("g-B", 12); late.chat.detailRequestSeq++;
  late.calls[0].gate.resolve({ session: { id: "A", goal: goal("g-A", 4) } }); await oldReply;
  assert.equal(late.chat.goal.id, "g-B"); assert.equal(late.notices.length, 0);
  const racing = fixture(); racing.chat.goal.status = "paused";
  const racingReply = racing.ctx.changeChatGoal("resume");
  racing.ctx.handleChatGoalEvent({ type: "goal:updated", sessionId: "A", goal: goal("g-A", 6, "blocked") });
  racing.calls[0].gate.resolve({ session: { id: "A", goal: goal("g-A", 4) } }); await racingReply;
  assert.equal(racing.chat.goal.revision, 6, "late control response cannot roll back a newer goal event");

  const events = fixture(); events.ctx.handleChatGoalEvent({ type: "goal:turn", sessionId: "B", runId: "other" });
  assert.deepEqual(events.reloads, []);
  events.ctx.handleChatGoalEvent({ type: "goal:turn", sessionId: "A", runId: "background" }); assert.deepEqual(events.reloads, ["A"]);
  events.ctx.handleChatGoalEvent({ type: "goal:error", sessionId: "A", runId: "failed-background" }); assert.deepEqual(events.reloads, ["A", "A"]);
  events.ctx.handleChatGoalEvent({ type: "goal:error", sessionId: "B", runId: "other-failed" }); assert.deepEqual(events.reloads, ["A", "A"]);
  events.chat.running = true; events.ctx.handleChatGoalEvent({ type: "goal:turn", sessionId: "A" }); assert.equal(events.chat.goalReloadSessionId, "A");
  events.chat.inspection = { id: "B" }; events.ctx.handleChatGoalEvent({ type: "goal:turn", sessionId: "B" });
  assert.deepEqual(events.inspections, [{ id: "B", refresh: true }]); assert.equal(events.calls.length, 0);
  console.log("web GOAL tests passed: configuration, scoped drafts/revisions, control-plane actions, stale replies and background events");
})().catch((error) => { console.error(error); process.exitCode = 1; });
