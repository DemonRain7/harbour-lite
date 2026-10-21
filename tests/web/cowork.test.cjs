const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const app = fs.readFileSync(path.join(root, "web/app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "web/cowork.css"), "utf8");

function source(name) {
  const match = app.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^}`, "m"));
  assert.ok(match, `${name} must remain testable without booting the dashboard`);
  return match[0];
}
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const helpers = ["sessionKeyFor", "chatSessionsForMode", "coworkBindingForSession", "coworkControlsLocked", "coworkDeviceOptions", "coworkDeviceOptionsHtml", "chatRunContext", "isCoworkTraceEvent", "normalizeTraceEvent", "appendRoutedTrace", "traceRowsHtml", "sessionChatMessages"];
function context(extra = {}) {
  const ctx = vm.createContext({ DEFAULT_PERSONA: "main-elaina", esc: escapeHtml, window: {}, updateSessionUnreadIndicators() {},
    renderChatInspectionBar() {}, pinChatWindow() {}, chatDraftBusy: () => false, saveChatDraft() {}, restoreChatDraft() {}, syncChatControlLocks() {}, syncChatRunPicker() {}, ...extra });
  vm.runInContext(helpers.map(source).join("\n"), ctx);
  return ctx;
}
const plain = (value) => JSON.parse(JSON.stringify(value));

async function main() {
  const ctx = context();
  assert.equal(ctx.sessionKeyFor("main-elaina"), "web:default:main-elaina");
  assert.equal(ctx.sessionKeyFor("main-elaina", "cowork"), "web:cowork:main-elaina");
  assert.notEqual(ctx.sessionKeyFor("main-aemeath", "cowork"), ctx.sessionKeyFor("main-elaina", "cowork"));
  const sessions = [
    { id: "main", key: "web:default:main-elaina", channel: "web" },
    { id: "work", key: "web:cowork:main-elaina", channel: "web" },
    { id: "other", key: "web:cowork:main-aemeath", channel: "web" },
    { id: "qq", key: "qq:bot:channel", channel: "qq", readOnlyMirror: true },
  ];
  assert.deepEqual(plain(ctx.chatSessionsForMode(sessions, "main", "main-elaina")).map((s) => s.id), ["main", "qq"]);
  assert.deepEqual(plain(ctx.chatSessionsForMode(sessions, "cowork", "main-elaina")).map((s) => s.id), ["work"]);

  const saved = { channel: "web", cowork: { deviceId: "laptop", cwd: "D:\\Projects", originDeviceId: "old-phone" } };
  assert.deepEqual(plain(ctx.coworkBindingForSession(saved)), { deviceId: "laptop", cwd: "D:\\Projects" });
  assert.equal(ctx.coworkBindingForSession({ channel: "qq", cowork: saved.cowork }), null);
  assert.equal(ctx.coworkBindingForSession({ channel: "web", readOnlyMirror: true, cowork: saved.cowork }), null);
  assert.deepEqual(plain(ctx.coworkBindingForSession({ channel: "web" })), { deviceId: "server" });
  for (const locked of ["running", "intakeRunning", "readOnlyMirror", "modelSaving", "coworkSaving", "switchingMode"]) {
    assert.equal(ctx.coworkControlsLocked({ [locked]: true }), true, `${locked} must lock Cowork controls`);
  }
  assert.equal(ctx.coworkControlsLocked({}), false);

  const online = [{ id: "server", label: "Harbour", online: true }];
  const options = plain(ctx.coworkDeviceOptions(online, "offline-laptop"));
  assert.equal(options.find((d) => d.id === "offline-laptop").online, false);
  assert.equal(online.length, 1, "options must not mutate the registry snapshot");
  assert.match(ctx.coworkDeviceOptionsHtml(online, "offline-laptop"), /value="offline-laptop" selected/);
  const malicious = ctx.coworkDeviceOptionsHtml([{ id: '"><svg>', label: '<img src=x onerror="alert(1)">', online: true }], '"><svg>');
  assert.doesNotMatch(malicious, /<img|<svg|value="">/);
  assert.match(malicious, /&lt;img/);
  assert.match(malicious, /&quot;&gt;&lt;svg&gt;/);

  const chat = { agent: "main-elaina", mode: "cowork", sessionId: "chosen-session", sessionKey: "web:cowork:main-elaina", cowork: { deviceId: "offline-laptop", cwd: " /workspace " } };
  const payload = ctx.chatRunContext(chat, "source-phone");
  assert.deepEqual(plain(payload), { session: { key: chat.sessionKey, channel: "web", id: "chosen-session" }, cowork: { deviceId: "offline-laptop", cwd: "/workspace", originDeviceId: "source-phone" } });
  chat.cowork.deviceId = "server";
  chat.sessionId = "later-selection";
  assert.equal(payload.session.id, "chosen-session", "payload is an immutable submission snapshot");
  assert.equal(payload.cowork.deviceId, "offline-laptop", "offline target cannot fall back to online server");
  assert.deepEqual(plain(ctx.chatRunContext({ ...chat, mode: "main", selectedSessionKey: "web:legacy" })), { session: { key: "web:legacy", channel: "web", id: "later-selection" } });
  assert.throws(() => ctx.chatRunContext({ ...chat, sessionId: null }), /明确的会话/);
  assert.throws(() => ctx.chatRunContext({ ...chat, readOnlyMirror: true }), /只读/);
  assert.equal(ctx.chatRunContext({ ...chat, cowork: { deviceId: "server" } }).cowork.originDeviceId, undefined, "a plain browser must not invent device identity");
  assert.deepEqual(plain(ctx.chatRunContext({ mode: "main", sessionsEnabled: false })), {}, "explicit stateless Main remains supported");
  assert.throws(() => ctx.chatRunContext({ mode: "cowork", sessionsEnabled: false }), /开启会话记忆/);

  for (const phase of ["start", "progress", "complete", "failed", "reconnecting"]) {
    const events = [];
    const event = { msg: `cowork:tool:${phase}`, runId: "run-1", deviceId: "laptop", deviceLabel: "用户 <Laptop>", op: "read_file" };
    ctx.appendRoutedTrace(events, {}, event, "main-elaina");
    assert.equal(events.length, 1, "device events without agent still route through their run");
    assert.equal(events[0].deviceId, "laptop");
    assert.match(events[0].text, /用户 <Laptop> · read_file/);
    assert.doesNotMatch(ctx.traceRowsHtml(events), /<Laptop>/);
  }
  const liveState = { chat: { channelRuns: {}, activeRunId: "run-current", running: true, subagents: {}, trace: [], messages: [{ pending: true }] }, runningAgent: "main-elaina" };
  const live = context({ state: liveState, updatePendingActivity() {}, updatePendingTrace() {} });
  vm.runInContext(source("pushTraceEvent"), live);
  live.pushTraceEvent({ msg: "cowork:tool:start", runId: "other-run", deviceId: "other" });
  live.pushTraceEvent({ msg: "cowork:tool:start", deviceId: "unknown" });
  assert.equal(liveState.chat.trace.length, 0);
  live.pushTraceEvent({ msg: "cowork:tool:start", runId: "run-current", deviceId: "chosen", op: "stat" });
  assert.equal(liveState.chat.trace.length, 1);
  assert.equal(liveState.chat.trace[0].deviceId, "chosen");

  await testRestoreAndLocks();
  await testDesktopOrigin();
  await testSessionRaces();
  await testPolling();
  testEnvironmentCards();
  await testSubmit("main", "selected-session");
  await testSubmit("cowork", "selected-session");
  await testSubmit("cowork", null);
  assert.match(app, /data-chat-mode="main"/);
  assert.match(app, /data-chat-mode="cowork"/);
  assert.match(app, /state\.chat\.cowork = coworkBindingForSession\(session\)/);
  assert.match(app, /if \(state\.chat\.mode !== "cowork" \|\| coworkControlsLocked\(state\.chat\)\)/);
  assert.match(app, /settingsNavItem\("devices"/);
  assert.match(html, /href="\/cowork\.css"/);
  assert.match(css, /\.cowork-bar\[hidden\] \{ display: none; \}/);
  assert.match(css, /var\(--accent\)/);
  console.log("web Cowork tests passed (mode isolation, exact session, restore/locks, offline retention, trace routing, polling and XSS)");
}

function testEnvironmentCards() {
  const ctx = context({ state: { chat: {} } });
  vm.runInContext(["executionPlatformLabel", "executionShellLabel", "executionDeviceSummary", "executionDeviceCard"].map(source).join("\n"), ctx);
  assert.equal(ctx.executionPlatformLabel("win32"), "Windows");
  assert.equal(ctx.executionPlatformLabel("linux"), "Linux");
  assert.equal(ctx.executionPlatformLabel("darwin"), "macOS");
  assert.equal(ctx.executionPlatformLabel("__proto__"), "__proto__");
  const unknown = ctx.executionDeviceCard({ id: "offline", label: "Old client", online: false }, "offline");
  assert.match(unknown, /Shell 未上报/);
  assert.match(unknown, /当前会话/);
  assert.match(unknown, /尚未连接/);
  assert.doesNotMatch(unknown, /PowerShell|Bash/);
  const hostile = ctx.executionDeviceCard({ id: 'bad"', label: '<img onerror="x">', platform: "win32", tools: ["read_file", "bash"],
    environment: { shell: { name: "PowerShell 7", version: "7.4.6", executable: '<svg onload="x">', available: true } } }, "server");
  assert.doesNotMatch(hostile, /<img|<svg/);
  assert.match(hostile, /&lt;svg/);
  assert.match(hostile, /PowerShell 7 · 7.4.6/);
  assert.match(hostile, /浏览器 · 未配置/);
  assert.match(hostile, /命令 · 已注册/);
  assert.match(app, /settingsNavItem\("devices", "⌘", "设备与执行环境"\)/);
  assert.match(app, /id="chatExecutionEnvironment"/);
  assert.match(app, /await saveCoworkBinding\(\{ deviceId: event\.target\.value \}\)/, "device switch does not copy a path from another machine");
}

async function testRestoreAndLocks() {
  const controls = Object.fromEntries(["chatAgent", "chatSkill", "chatModel", "chatEffort", "chatPermMode", "coworkTarget", "coworkCwd", "coworkRename", "chatGoal", "chatSend", "chatRunLock"].map((id) => [id, {}]));
  controls.chatModel.options = [{ value: "chosen-model" }];
  const state = { chat: { models: ["chosen-model"], mode: "cowork" } };
  let writes = 0;
  const ctx = context({ state, openHarbourSelect: null, $: (id) => controls[id.slice(1)],
    document: { getElementById: (id) => controls[id], querySelector: () => null, querySelectorAll: () => [] },
    CHAT_RUN_LOCK_CONTROLS: ["chatAgent", "chatSkill", "chatModel", "chatEffort", "chatPermMode", "coworkTarget", "coworkCwd", "coworkRename"],
    api: async () => { writes++; },
    ...Object.fromEntries(["fillChatEfforts", "syncChatSourceMode", "overlaySelectedChannelRuns", "renderChatMessages", "renderChatPlan", "renderChatCheckpoint", "renderChatGoal", "enrichNewsReports", "renderCoworkBar", "updateChatContextRing"].map((name) => [name, () => {}])),
  });
  vm.runInContext(["applySessionDetail", "syncChatControlLocks", "saveCoworkBinding"].map(source).join("\n"), ctx);
  ctx.applySessionDetail({ id: "resume-session", channel: "web", messages: [], modelRef: "chosen-model", reasoningEffort: "high", permissionMode: "plan", goal: { status: "active" }, cowork: { deviceId: "offline-machine", cwd: "/exact-folder" } });
  assert.deepEqual(plain(state.chat.cowork), { deviceId: "offline-machine", cwd: "/exact-folder" });
  assert.equal(state.chat.model, "chosen-model");
  assert.equal(state.chat.permissionMode, "plan");
  assert.equal(state.chat.goal.status, "active");
  state.chat.running = true;
  ctx.syncChatControlLocks();
  assert.equal(controls.chatAgent.disabled, true);
  assert.equal(controls.coworkTarget.disabled, true);
  assert.equal(controls.coworkCwd.disabled, true);
  await ctx.saveCoworkBinding({ deviceId: "server" });
  assert.equal(writes, 0);
  state.chat.running = false;
  state.chat.readOnlyMirror = true;
  ctx.syncChatControlLocks();
  assert.equal(controls.chatAgent.disabled, false, "the user may leave an external mirror via Agent");
  assert.equal(controls.coworkTarget.disabled, true);
  await ctx.saveCoworkBinding({ deviceId: "server" });
  assert.equal(writes, 0, "Cowork controls must never write external mirror defaults");
  state.chat.readOnlyMirror = false;
  ctx.syncChatControlLocks();
  assert.equal(controls.coworkTarget.disabled, false);
  assert.equal(controls.coworkCwd.disabled, false);
}

async function testDesktopOrigin() {
  const state = { cowork: {} };
  const window = { harbourDesktop: { getCoworkDevice: async () => ({ deviceId: "desktop-1", label: "My laptop", hostname: "host-1" }) } };
  const ctx = context({ state, window, renderCoworkBar() {} });
  vm.runInContext(source("loadCoworkOrigin"), ctx);
  await ctx.loadCoworkOrigin();
  assert.deepEqual(plain(state.cowork.origin), { id: "desktop-1", label: "My laptop", hostname: "host-1" });
  window.harbourDesktop = undefined;
  await ctx.loadCoworkOrigin();
  assert.equal(state.cowork.origin, null);
}

async function testSessionRaces() {
  let resolveRequest;
  const state = { chat: { agent: "main-elaina", mode: "main", sessionKey: "web:default:main-elaina", sessionId: "old-session", detailRequestSeq: 0 } };
  const ctx = context({ state, currentSessionKey: () => state.chat.sessionKey, toast() {},
    api: () => new Promise((resolve) => { resolveRequest = resolve; }),
  });
  vm.runInContext(source("newChatSession"), ctx);
  const pendingNew = ctx.newChatSession();
  state.chat.mode = "cowork";
  state.chat.sessionKey = "web:cowork:main-elaina";
  state.chat.sessionId = "cowork-selected";
  state.chat.detailRequestSeq++;
  resolveRequest({ session: { id: "late-main-session", key: "web:default:main-elaina", channel: "web" } });
  await pendingNew;
  assert.equal(state.chat.sessionId, "cowork-selected", "a late create response cannot override a new mode/session");

  const runningState = { chat: { agent: "main-elaina", mode: "cowork", sessionKey: "web:cowork:main-elaina", sessionId: "submitted", running: true, sessionListRequestSeq: 0, goal: { id: "local-goal" }, cowork: { deviceId: "target" } } };
  const running = context({ state: runningState, $: () => ({}), currentSessionKey: () => runningState.chat.sessionKey, renderChatSourceTabs() {}, renderSessionList() {},
    api: async () => ({ enabled: true, sessions: [{ id: "other-active", channel: "web", key: runningState.chat.sessionKey, active: true }] }),
  });
  vm.runInContext(["loadChatSessions", "refreshSessionList"].map(source).join("\n"), running);
  await running.loadChatSessions();
  assert.equal(runningState.chat.sessionId, "submitted");
  assert.equal(runningState.chat.goal.id, "local-goal");
  assert.equal(runningState.chat.cowork.deviceId, "target");

  for (const [fn, field, value] of [["setChatModel", "model", "stale-model"], ["setChatReasoningEffort", "reasoningEffort", "low"], ["setChatPermissionMode", "permissionMode", "default"]]) {
    let resolvePatch;
    const modelState = { chat: { sessionId: "before", model: "before-model", reasoningEffort: "medium", permissionMode: "plan" } };
    const modelContext = context({ state: modelState, $: () => null, fillChatEfforts() {}, updateChatContextRing() {}, refreshSessionList: async () => {},
      api: () => new Promise((resolve) => { resolvePatch = resolve; }),
    });
    vm.runInContext(source("setChatRunOverride") + "\n" + source(fn), modelContext);
    const pendingPatch = modelContext[fn](value);
    modelState.chat.sessionId = "after";
    modelState.chat[field] = "after-selection";
    resolvePatch({ session: { modelRef: "stale-model", reasoningEffort: "low", permissionMode: "default" } });
    await pendingPatch;
    assert.equal(modelState.chat[field], "after-selection", `${fn} must ignore a stale PATCH after switching sessions`);
  }
}

async function testPolling() {
  let loaded = 0;
  let nextTimer = 1;
  const timers = new Map();
  const state = { chat: { mode: "cowork" }, cowork: { timer: null } };
  const document = { hidden: false, body: { dataset: { panel: "chat" } } };
  const ctx = context({ state, document, $: () => ({}), loadCoworkDevices: async () => { loaded++; },
    setTimeout(fn, ms) { assert.equal(ms, 15000); const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(["stopCoworkPolling", "coworkIsVisible", "syncCoworkPolling"].map(source).join("\n"), ctx);
  ctx.syncCoworkPolling();
  await new Promise(setImmediate);
  assert.equal(loaded, 1);
  assert.equal(timers.size, 1);
  ctx.syncCoworkPolling();
  await new Promise(setImmediate);
  assert.equal(timers.size, 1, "re-entering cannot leak timers");
  document.hidden = true;
  ctx.syncCoworkPolling();
  assert.equal(timers.size, 0);
  const previousLoads = loaded;
  document.hidden = false;
  state.chat.mode = "main";
  ctx.syncCoworkPolling();
  assert.equal(loaded, previousLoads, "Main Chat must not poll devices");
  state.chat.mode = "cowork";
  document.body.dataset.panel = "settings";
  ctx.syncCoworkPolling();
  assert.equal(loaded, previousLoads, "leaving Cowork must stop polling");
}

async function testSubmit(mode, selectedSessionId) {
  const requests = [];
  const key = `web:${mode === "cowork" ? "cowork" : "default"}:main-elaina`;
  const state = { chat: { mode, agent: "main-elaina", sessionId: selectedSessionId, sessionKey: key, selectedSessionKey: selectedSessionId ? key : "", cowork: { deviceId: "offline-target", cwd: "/work" }, messages: [], attachments: [], pendingUploads: 0, trace: [], model: "model-1", permissionMode: "plan", reasoningEffort: "high", goalArmed: false }, cowork: { origin: { id: "source-client" } } };
  const controls = { "#chatAgent": { value: "main-elaina" }, "#chatSkill": { value: "test-skill" }, "#chatInput": { value: "@OtherDevice inspect only" } };
  const ctx = context({ state, AbortController, $: (id) => controls[id], currentSessionKey: () => key, isOpenChatGoal: () => false,
    createClientRunId: () => "run-submission", toast(message) { throw new Error(`Unexpected toast: ${message}`); },
    setInterval: () => 1, clearInterval() {}, visualPoll: () => 1, stopVisualTimer() {},
    api: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      if (url === "/api/conversations/new") return { session: { id: "new-exact-session", key, channel: "web" } };
      if (url === "/api/run") return { answer: "done", session: { messageCount: 2 } };
      return { session: { id: "new-exact-session", key, channel: "web", cowork: state.chat.cowork } };
    },
    ...Object.fromEntries(["syncChatControlLocks", "renderChatCheckpoint", "renderChatGoal", "renderChatAttachments", "renderChatMessages", "updateRunningIndicator", "setChatSendMode", "enrichNewsReports", "persistChatAnnotations", "refreshSessionList", "updatePendingDuration"].map((name) => [name, () => {}])),
  });
  vm.runInContext(source("submitRecoverableChatRun") + "\n" + source("executeChat"), ctx);
  await ctx.executeChat();
  const run = requests.find((request) => request.url === "/api/run").body;
  assert.equal(run.session.id, selectedSessionId || "new-exact-session");
  assert.equal(run.session.key, key);
  assert.equal(run.reasoningEffort, "high");
  assert.equal(run.permissionMode, "plan");
  assert.equal(run.model, "model-1");
  assert.equal(run.input, "[skill:test-skill]\n@OtherDevice inspect only", "@device routing remains a backend decision");
  if (mode === "cowork") {
    assert.deepEqual(run.cowork, { deviceId: "offline-target", cwd: "/work", originDeviceId: "source-client" });
    assert.equal(state.chat.cowork.deviceId, "offline-target", "per-turn @device must not alter the default");
  } else assert.equal(run.cowork, undefined);
  if (!selectedSessionId) assert.deepEqual(requests.map((request) => request.url), ["/api/conversations/new", "/api/conversations/new-exact-session", "/api/run"]);
  assert.equal(state.chat.running, false);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
